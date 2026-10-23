import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSnippet } from "./search";
import type {
  DocumentMatch,
  MatchRange,
  SearchRole,
  SessionDocument,
  SessionMatch,
  SessionMatchItem,
  SessionMessageMatch,
  SessionMeta,
  SessionScope,
  SessionSearchResult,
  SnippetItem,
} from "./types";

const seg = new Intl.Segmenter("zh-CN", { granularity: "word" });

export function tokenizeForFts(text: string, isQuery = false): string[] {
  const lower = text.toLowerCase();
  const words = Array.from(seg.segment(lower))
    .map((s) => s.segment.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));

  const tokens = new Set<string>(words);

  // Generate CJK bi-grams (adjacent character pairs) for accurate subphrase matching
  const cjkChars: string[] = [];
  for (const ch of lower) {
    if (/\p{Script=Han}/u.test(ch)) {
      cjkChars.push(ch);
    } else {
      cjkChars.push(" ");
    }
  }

  const bigrams: string[] = [];
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const a = cjkChars[i];
    const b = cjkChars[i + 1];
    if (a !== " " && b !== " ") {
      const bg = a + b;
      tokens.add(bg);
      bigrams.push(bg);
    }
  }

  // If this is for a query and we have multi-character CJK tokens, filter out single CJK characters
  if (isQuery && bigrams.length > 0) {
    const filtered = Array.from(tokens).filter(
      (t) => t.length > 1 || !/\p{Script=Han}/u.test(t),
    );
    if (filtered.length > 0) return filtered;
  }

  return Array.from(tokens);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

interface ParsedFile {
  meta: SessionMeta & { mtimeMs: number };
  messages: Array<{
    entryId: string;
    role: SearchRole;
    text: string;
  }>;
}

function parseSessionFile(
  filePath: string,
  mtimeMs: number,
): ParsedFile | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }

  let id: string | undefined;
  let cwd = "";
  let created: number | undefined;
  let name: string | undefined;
  let title: string | undefined;
  let lastActivity: number | undefined;
  const messages: ParsedFile["messages"] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "session") {
      id = typeof entry.id === "string" ? entry.id : undefined;
      cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      if (typeof entry.timestamp === "string") {
        const t = new Date(entry.timestamp).getTime();
        if (!Number.isNaN(t)) created = t;
      }
    } else if (entry.type === "session_info") {
      if (typeof entry.name === "string") {
        name = entry.name.replace(/[\s\p{Cc}]+/gu, " ").trim();
      }
    } else if (entry.type === "message") {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;

      const text = extractMessageText(msg.content);
      if (!text) continue;

      if (typeof entry.timestamp === "string") {
        const t = new Date(entry.timestamp).getTime();
        if (!Number.isNaN(t)) {
          lastActivity = Math.max(lastActivity ?? 0, t);
        }
      }

      if (title === undefined && role === "user") {
        title = text
          .replace(/[\s\p{Cc}]+/gu, " ")
          .trim()
          .slice(0, 300);
      }

      const entryId = typeof entry.id === "string" ? entry.id : "";
      messages.push({
        entryId,
        role,
        text,
      });
    }
  }

  if (!id) return undefined;

  return {
    meta: {
      path: filePath,
      id,
      cwd,
      name,
      title: title || "(no messages)",
      modified: lastActivity ?? created ?? mtimeMs,
      mtimeMs,
    },
    messages,
  };
}

const dbCache = new Map<string, DatabaseSync>();

export function getSessionDatabase(sessionDir: string): DatabaseSync {
  const dbPath = join(sessionDir, ".session-search.db");
  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS sessions_meta (
      path TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      cwd TEXT,
      name TEXT,
      title TEXT,
      modified INTEGER,
      mtime_ms REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_meta_modified ON sessions_meta(modified DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_meta_id ON sessions_meta(id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      session_path UNINDEXED,
      session_id UNINDEXED,
      entry_id UNINDEXED,
      role UNINDEXED,
      content UNINDEXED,
      tokens,
      tokenize = 'unicode61'
    );
  `);

  dbCache.set(dbPath, db);
  return db;
}

export function syncDatabase(db: DatabaseSync, scope: SessionScope): void {
  let fileNames: string[];
  try {
    fileNames = readdirSync(scope.sessionDir).filter((f) =>
      f.endsWith(".jsonl"),
    );
  } catch {
    return;
  }

  const rows = db
    .prepare("SELECT path, mtime_ms FROM sessions_meta")
    .all() as Array<{
    path: string;
    mtime_ms: number;
  }>;
  const dbMap = new Map<string, number>();
  for (const row of rows) {
    dbMap.set(row.path, row.mtime_ms);
  }

  const diskFiles: Array<{ path: string; mtimeMs: number }> = [];
  const diskPathSet = new Set<string>();

  for (const name of fileNames) {
    const fullPath = join(scope.sessionDir, name);
    try {
      const st = statSync(fullPath);
      if (st.isFile()) {
        diskFiles.push({ path: fullPath, mtimeMs: st.mtimeMs });
        diskPathSet.add(fullPath);
      }
    } catch {
      // Ignore unreadable files
    }
  }

  const toDelete: string[] = [];
  for (const path of dbMap.keys()) {
    if (!diskPathSet.has(path)) {
      toDelete.push(path);
    }
  }

  const toIndex: Array<{ path: string; mtimeMs: number }> = [];
  for (const file of diskFiles) {
    const dbMtime = dbMap.get(file.path);
    if (dbMtime === undefined || Math.abs(dbMtime - file.mtimeMs) > 1) {
      toIndex.push(file);
    }
  }

  if (toDelete.length === 0 && toIndex.length === 0) {
    return;
  }

  const deleteMetaStmt = db.prepare("DELETE FROM sessions_meta WHERE path = ?");
  const deleteFtsStmt = db.prepare(
    "DELETE FROM messages_fts WHERE session_path = ?",
  );
  const insertMetaStmt = db.prepare(`
    INSERT INTO sessions_meta (path, id, cwd, name, title, modified, mtime_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFtsStmt = db.prepare(`
    INSERT INTO messages_fts (session_path, session_id, entry_id, role, content, tokens)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    for (const path of toDelete) {
      deleteMetaStmt.run(path);
      deleteFtsStmt.run(path);
    }

    for (const file of toIndex) {
      deleteMetaStmt.run(file.path);
      deleteFtsStmt.run(file.path);

      const parsed = parseSessionFile(file.path, file.mtimeMs);
      if (!parsed) continue;

      insertMetaStmt.run(
        parsed.meta.path,
        parsed.meta.id,
        parsed.meta.cwd,
        parsed.meta.name ?? null,
        parsed.meta.title,
        parsed.meta.modified,
        parsed.meta.mtimeMs,
      );

      for (const m of parsed.messages) {
        const tokens = tokenizeForFts(m.text, false).join(" ");
        insertFtsStmt.run(
          parsed.meta.path,
          parsed.meta.id,
          m.entryId,
          m.role,
          m.text,
          tokens,
        );
      }
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export function listRecentSessionsFromDb(
  db: DatabaseSync,
  limit?: number,
  filterByCwd = false,
  cwd = "",
): SessionMeta[] {
  let query = "SELECT path, id, cwd, name, title, modified FROM sessions_meta";
  const params: Array<string | number> = [];

  if (filterByCwd && cwd) {
    query += " WHERE cwd = ?";
    params.push(cwd);
  }

  query += " ORDER BY modified DESC";
  if (limit !== undefined) {
    query += " LIMIT ?";
    params.push(limit);
  }

  const rows = db.prepare(query).all(...params) as Array<{
    path: string;
    id: string;
    cwd: string;
    name: string | null;
    title: string;
    modified: number;
  }>;

  return rows.map((r) => ({
    path: r.path,
    id: r.id,
    cwd: r.cwd,
    name: r.name ?? undefined,
    title: r.title,
    modified: r.modified,
  }));
}

export function findTokenRanges(
  text: string,
  tokens: string[],
  maxRanges = 20,
): MatchRange[] {
  const ranges: MatchRange[] = [];
  const lower = text.toLowerCase();

  for (const token of tokens) {
    if (!token) continue;
    let pos = lower.indexOf(token.toLowerCase(), 0);
    while (pos !== -1) {
      ranges.push([pos, pos + token.length]);
      pos = lower.indexOf(token.toLowerCase(), pos + token.length);
      if (ranges.length >= maxRanges * 2) break;
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);

  const merged: MatchRange[] = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push(r);
    } else {
      const prev = merged[merged.length - 1];
      if (r[0] < prev[1]) {
        (prev as [number, number])[1] = Math.max(prev[1], r[1]);
      } else {
        merged.push(r);
      }
    }
  }

  return merged.slice(0, maxRanges);
}

export function buildContextSnippet(
  text: string,
  range: MatchRange,
  contextBefore = 120,
  contextAfter = 120,
): SnippetItem {
  const snip = buildSnippet(text, range, contextBefore, contextAfter);
  const prefix = snip.clippedStart ? "... " : "";
  const suffix = snip.clippedEnd ? " ..." : "";
  return {
    text: `${prefix}${snip.before}[${snip.match}]${snip.after}${suffix}`,
    matchText: snip.match,
  };
}

interface FtsRow {
  session_path: string;
  session_id: string;
  entry_id: string;
  role: SearchRole;
  content: string;
  rank: number;
  title: string;
  modified: number;
  name: string | null;
}

export function searchBM25ForUI(
  db: DatabaseSync,
  queryText: string,
  candidateSessions: readonly SessionMeta[],
): { matches: SessionMatch[]; truncated: number } {
  const queryTokens = tokenizeForFts(queryText, true);
  if (queryTokens.length === 0 || candidateSessions.length === 0) {
    return { matches: [], truncated: 0 };
  }

  const andMatch = queryTokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" AND ");
  const orMatch = queryTokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");

  const sessionPathMap = new Map<string, SessionMeta>();
  for (const s of candidateSessions) {
    sessionPathMap.set(s.path, s);
  }

  const buildQuery = (matchClause: string): FtsRow[] => {
    return db
      .prepare(
        `
        SELECT session_path, session_id, entry_id, role, content,
               bm25(messages_fts) as rank
        FROM messages_fts
        WHERE tokens MATCH ?
        ORDER BY rank ASC
        LIMIT 1000
      `,
      )
      .all(matchClause) as unknown as FtsRow[];
  };

  let rows = buildQuery(andMatch);
  if (rows.length === 0 && queryTokens.length > 1) {
    rows = buildQuery(orMatch);
  }

  const bySession = new Map<
    string,
    { matches: DocumentMatch[]; hitCount: number; bestRank: number }
  >();

  for (const row of rows) {
    if (!sessionPathMap.has(row.session_path)) continue;

    const ranges = findTokenRanges(row.content, queryTokens);
    if (ranges.length === 0) continue;

    const document: SessionDocument = {
      entryId: row.entry_id,
      role: row.role,
      text: row.content,
    };

    const docMatch: DocumentMatch = {
      document,
      ranges,
    };

    const existing = bySession.get(row.session_path);
    if (existing) {
      existing.matches.push(docMatch);
      existing.hitCount += ranges.length;
      if (row.rank < existing.bestRank) existing.bestRank = row.rank;
    } else {
      bySession.set(row.session_path, {
        matches: [docMatch],
        hitCount: ranges.length,
        bestRank: row.rank,
      });
    }
  }

  const sessionMatches: SessionMatch[] = [];
  for (const [path, data] of bySession.entries()) {
    const meta = sessionPathMap.get(path);
    if (!meta) continue;
    sessionMatches.push({
      session: meta,
      matches: data.matches,
      hitCount: data.hitCount,
      capped: false,
    });
  }

  // Sort by BM25 rank (best rank first)
  sessionMatches.sort((a, b) => {
    const rankA = bySession.get(a.session.path)?.bestRank ?? 0;
    const rankB = bySession.get(b.session.path)?.bestRank ?? 0;
    return rankA - rankB;
  });

  return { matches: sessionMatches, truncated: 0 };
}

export interface SearchBm25Options {
  query: string;
  roleFilter?: "all" | SearchRole;
  sessionId?: string;
  limit: number;
  maxMatchesPerSession: number;
  snippetContext: number;
  includeFullText: boolean;
}

export function searchSessionsBM25(
  db: DatabaseSync,
  options: SearchBm25Options,
): SessionSearchResult {
  const queryTokens = tokenizeForFts(options.query, true);
  if (queryTokens.length === 0) {
    return {
      totalSessions: 0,
      totalHits: 0,
      truncated: false,
      sessions: [],
    };
  }

  const andMatch = queryTokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" AND ");
  const orMatch = queryTokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");

  const buildSql = (
    matchClause: string,
  ): { sql: string; params: Array<string | number> } => {
    let sql = `
      SELECT m.session_path, m.session_id, m.entry_id, m.role, m.content,
             bm25(messages_fts) AS rank,
             s.title, s.modified, s.name
      FROM messages_fts m
      JOIN sessions_meta s ON m.session_path = s.path
      WHERE m.tokens MATCH ?
    `;
    const params: Array<string | number> = [matchClause];

    if (options.roleFilter && options.roleFilter !== "all") {
      sql += " AND m.role = ?";
      params.push(options.roleFilter);
    }

    if (options.sessionId) {
      const qId = options.sessionId.trim().toLowerCase();
      sql += " AND (lower(m.session_id) = ? OR lower(m.session_path) LIKE ?)";
      params.push(qId, `%${qId}%`);
    }

    sql += " ORDER BY rank ASC LIMIT ?";
    params.push(options.limit * options.maxMatchesPerSession * 3);

    return { sql, params };
  };

  const { sql, params } = buildSql(andMatch);
  let rows = db.prepare(sql).all(...params) as unknown as FtsRow[];

  if (rows.length === 0 && queryTokens.length > 1) {
    const fallback = buildSql(orMatch);
    rows = db
      .prepare(fallback.sql)
      .all(...fallback.params) as unknown as FtsRow[];
  }

  if (rows.length === 0) {
    return {
      totalSessions: 0,
      totalHits: 0,
      truncated: false,
      sessions: [],
    };
  }

  interface SessionGroup {
    path: string;
    id: string;
    title: string;
    name?: string;
    modified: number;
    bestRank: number;
    totalHits: number;
    matches: SessionMessageMatch[];
  }

  const groups = new Map<string, SessionGroup>();

  for (const row of rows) {
    let group = groups.get(row.session_path);
    if (!group) {
      group = {
        path: row.session_path,
        id: row.session_id,
        title: row.title,
        name: row.name ?? undefined,
        modified: row.modified,
        bestRank: row.rank,
        totalHits: 0,
        matches: [],
      };
      groups.set(row.session_path, group);
    }

    const ranges = findTokenRanges(row.content, queryTokens);
    if (ranges.length === 0) continue;

    group.totalHits += ranges.length;

    if (group.matches.length < options.maxMatchesPerSession) {
      const snippets: SnippetItem[] = ranges
        .slice(0, 3)
        .map((range) =>
          buildContextSnippet(
            row.content,
            range,
            options.snippetContext,
            options.snippetContext,
          ),
        );

      const matchItem: SessionMessageMatch = {
        entryId: row.entry_id,
        role: row.role,
        hitCount: ranges.length,
        snippets,
      };

      if (options.includeFullText) {
        matchItem.fullText = row.content;
      }

      group.matches.push(matchItem);
    }
  }

  const sortedSessions = Array.from(groups.values())
    .sort((a, b) => a.bestRank - b.bestRank)
    .slice(0, options.limit);

  let totalHits = 0;
  const sessionItems: SessionMatchItem[] = sortedSessions.map((s) => {
    totalHits += s.totalHits;
    return {
      id: s.id,
      name: s.name,
      title: s.title,
      path: s.path,
      modifiedAt: new Date(s.modified).toISOString(),
      hitCount: s.totalHits,
      matches: s.matches,
    };
  });

  return {
    totalSessions: sessionItems.length,
    totalHits,
    truncated: false,
    sessions: sessionItems,
  };
}
