import type { DatabaseSync } from "node:sqlite";
import { searchBM25ForUI } from "./db";
import {
  escapeRipgrepRegex,
  parseRipgrepJson,
  parseRipgrepLines,
  type RipgrepOptions,
  runRipgrep,
  runRipgrepOverFiles,
} from "./ripgrep";
import type {
  DocumentMatch,
  MatchRange,
  SessionDocument,
  SessionMatch,
  SessionMatchItem,
  SessionMessageMatch,
  SessionMeta,
  SessionSearchResult,
  SnippetItem,
} from "./types";

export const REGEX_PREFIX = "re:";

export type ParsedQuery =
  | { kind: "empty" }
  | { kind: "literal"; needle: string; caseSensitive: boolean }
  | { kind: "regex"; source: string; caseSensitive: boolean };

const UPPERCASE = /\p{Lu}/u;

/**
 * `re:<pattern>` selects regex mode (ripgrep syntax); anything else is a
 * literal phrase. Smart case: a query without uppercase letters is
 * case-insensitive. Literal queries are trimmed so trailing spaces while
 * typing do not hide results.
 */
export function parseQuery(input: string): ParsedQuery {
  if (input.startsWith(REGEX_PREFIX)) {
    const source = input.slice(REGEX_PREFIX.length);
    if (source.trim() === "") return { kind: "empty" };
    // Ignore escapes such as \S when deciding case sensitivity.
    const caseSensitive = UPPERCASE.test(source.replace(/\\./g, ""));
    return { kind: "regex", source, caseSensitive };
  }
  const needle = input.trim();
  if (needle === "") return { kind: "empty" };
  return { kind: "literal", needle, caseSensitive: UPPERCASE.test(needle) };
}

/** Text as it appears inside a JSON string written by JSON.stringify. */
export function jsonEscapeText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** A user or assistant message entry. pi always writes content after role. */
const MESSAGE_ROLE_PREFIX =
  '^\\{"type":"message".*"message":\\{"role":"(?:user|assistant)"';
/** Body of a JSON string, stopping before its closing quote. */
const IN_JSON_STRING = '(?:[^"\\\\]|\\\\.)*';

/**
 * Pattern for the file pass, which runs over raw JSONL.
 *
 * A literal needle is JSON-escaped so quotes, backslashes, and newlines match
 * how pi stores them, and is anchored inside the message's own text: either
 * a string `content` or a `{"type":"text"}` block. Without that anchor a hit
 * in a thinking block or in tool-call arguments would produce a candidate
 * line that the verification pass discards, wasting the per-file scan window
 * and hiding real matches behind it.
 *
 * A regex cannot be anchored that way, because the user's pattern may carry
 * its own anchors and alternations. Regex queries therefore match anywhere on
 * the line and rely on verification to drop what is not message text.
 */
export function buildLinePattern(
  query: Exclude<ParsedQuery, { kind: "empty" }>,
): string {
  if (query.kind === "regex") {
    return `${MESSAGE_ROLE_PREFIX}.*(?:${query.source})`;
  }
  const needle = escapeRipgrepRegex(jsonEscapeText(query.needle));
  return (
    `${MESSAGE_ROLE_PREFIX},"content":` +
    `(?:"${IN_JSON_STRING}${needle}` +
    `|\\[.*\\{"type":"text","text":"${IN_JSON_STRING}${needle})`
  );
}

/**
 * Matching lines examined per file. Sessions with more are reported as
 * truncated instead of being silently cut short.
 */
export const LINE_SCAN_CAP = 200;
/** Highlighted positions kept per message; hit counts are not capped. */
export const MAX_RANGES_PER_DOCUMENT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Parses a matched JSONL line into a searchable document, or undefined. */
export function documentFromLine(line: string): SessionDocument | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry.type !== "message") return undefined;
  if (typeof entry.id !== "string") return undefined;
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = extractText(message.content);
  if (!text) return undefined;
  return { entryId: entry.id, role, text };
}

/** Converts UTF-8 byte offsets from ripgrep into JS string indices. */
export function byteRangesToCharRanges(
  text: string,
  ranges: readonly { start: number; end: number }[],
): MatchRange[] {
  const bytes = Buffer.from(text, "utf8");
  const result: MatchRange[] = [];
  for (const { start, end } of ranges) {
    if (start < 0 || end > bytes.length || end <= start) continue;
    const charStart = bytes.toString("utf8", 0, start).length;
    const charEnd = charStart + bytes.toString("utf8", start, end).length;
    result.push([charStart, charEnd]);
  }
  return result;
}

export interface SearchOptions {
  /** Sessions in scope, in display order. Files outside it are ignored. */
  sessions: readonly SessionMeta[];
  signal?: AbortSignal;
  /** ripgrep executable override, for tests. */
  ripgrepCommand?: string;
  /** Optional SQLite database for instant BM25 matching. */
  db?: DatabaseSync;
}

export interface SearchResult {
  matches: SessionMatch[];
  /** Sessions whose scan window filled up; their results are incomplete. */
  truncated: number;
}

interface Candidate {
  path: string;
  document: SessionDocument;
}

/** Positions of a match plus the untruncated number of occurrences. */
interface Hits {
  ranges: MatchRange[];
  total: number;
}

function escapeJsRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Counts every occurrence of a literal needle but keeps only the first
 * maxRanges positions. The `u` flag matters: ripgrep folds case per Unicode
 * simple case folding, and a JavaScript regex only does the same with `u`.
 * Without it a line ripgrep matched could yield no positions here and the
 * message would be dropped. An escaped literal cannot backtrack.
 */
export function literalHits(
  text: string,
  needle: string,
  caseSensitive: boolean,
  maxRanges: number,
): Hits {
  const pattern = new RegExp(
    escapeJsRegExp(needle),
    caseSensitive ? "gu" : "giu",
  );
  const ranges: MatchRange[] = [];
  let total = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match[0].length === 0) break;
    total++;
    if (ranges.length < maxRanges) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    match = pattern.exec(text);
  }
  return { ranges, total };
}

/**
 * Finds match positions in decoded texts for a regex query by running it
 * again through ripgrep over stdin, one document per line. Keeps user
 * patterns out of the JavaScript regex engine, which cannot be interrupted.
 */
async function regexHits(
  texts: readonly string[],
  source: string,
  caseSensitive: boolean,
  options: RipgrepOptions,
): Promise<Map<number, Hits>> {
  const input = texts.map((text) => text.replace(/[\r\n]/g, " ")).join("\n");
  const output = await runRipgrep(
    ["--json", ...(caseSensitive ? [] : ["--ignore-case"]), "-e", source],
    { ...options, input },
  );
  const byIndex = new Map<number, Hits>();
  for (const match of parseRipgrepJson(output)) {
    const text = texts[match.lineNumber - 1];
    if (text === undefined) continue;
    const ranges = byteRangesToCharRanges(
      text,
      match.submatches.slice(0, MAX_RANGES_PER_DOCUMENT),
    );
    if (ranges.length === 0) continue;
    byIndex.set(match.lineNumber - 1, {
      ranges,
      total: match.submatches.length,
    });
  }
  return byIndex;
}

/**
 * One ripgrep pass over the session files finds candidate message lines;
 * only those lines are JSON-parsed. Match positions in the decoded text come
 * from JavaScript for literal needles and from a second ripgrep pass for
 * regexes. Candidates whose decoded text does not contain the query, such as
 * a regex that only matched a thinking block, produce no positions and are
 * dropped.
 */
export async function searchSessions(
  query: ParsedQuery,
  options: SearchOptions,
): Promise<SearchResult> {
  const empty: SearchResult = { matches: [], truncated: 0 };
  if (query.kind === "empty" || options.sessions.length === 0) return empty;

  if (options.db && query.kind === "literal") {
    return searchBM25ForUI(options.db, query.needle, options.sessions);
  }

  const rg: RipgrepOptions = {
    signal: options.signal,
    command: options.ripgrepCommand,
  };
  const output = await runRipgrepOverFiles(
    [
      "--with-filename",
      "--line-number",
      "--null",
      // One extra line distinguishes "exactly at the cap" from "more".
      "--max-count",
      String(LINE_SCAN_CAP + 1),
      ...(query.caseSensitive ? [] : ["--ignore-case"]),
      "-e",
      buildLinePattern(query),
    ],
    options.sessions.map((session) => session.path),
    rg,
  );

  const candidates: Candidate[] = [];
  const linesPerFile = new Map<string, number>();
  for (const record of parseRipgrepLines(output)) {
    const seen = (linesPerFile.get(record.path) ?? 0) + 1;
    linesPerFile.set(record.path, seen);
    if (seen > LINE_SCAN_CAP) continue;
    const document = documentFromLine(record.text);
    if (document) candidates.push({ path: record.path, document });
  }
  const truncatedPaths = new Set(
    [...linesPerFile]
      .filter(([, seen]) => seen > LINE_SCAN_CAP)
      .map(([path]) => path),
  );
  if (candidates.length === 0) {
    return { matches: [], truncated: truncatedPaths.size };
  }

  let hitsByIndex: Map<number, Hits>;
  if (query.kind === "literal") {
    hitsByIndex = new Map();
    candidates.forEach((candidate, index) => {
      const hits = literalHits(
        candidate.document.text,
        query.needle,
        query.caseSensitive,
        MAX_RANGES_PER_DOCUMENT,
      );
      if (hits.ranges.length > 0) hitsByIndex.set(index, hits);
    });
  } else {
    hitsByIndex = await regexHits(
      candidates.map((candidate) => candidate.document.text),
      query.source,
      query.caseSensitive,
      rg,
    );
  }

  const byPath = new Map<string, { matches: DocumentMatch[]; hits: number }>();
  for (const [index, hits] of hitsByIndex) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const entry = byPath.get(candidate.path);
    const match = { document: candidate.document, ranges: hits.ranges };
    if (entry) {
      entry.matches.push(match);
      entry.hits += hits.total;
    } else {
      byPath.set(candidate.path, { matches: [match], hits: hits.total });
    }
  }

  const matches: SessionMatch[] = [];
  for (const session of options.sessions) {
    const entry = byPath.get(session.path);
    if (!entry) continue;
    matches.push({
      session,
      matches: entry.matches,
      hitCount: entry.hits,
      capped: truncatedPaths.has(session.path),
    });
  }
  return { matches, truncated: truncatedPaths.size };
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
  clippedStart: boolean;
  clippedEnd: boolean;
}

const WHITESPACE = /[\s\p{Cc}]+/gu;

function flatten(text: string): string {
  return text.replace(WHITESPACE, " ");
}

/** Extracts single-line context around a match for preview rendering. */
export function buildSnippet(
  text: string,
  range: MatchRange,
  contextBefore: number,
  contextAfter: number,
): Snippet {
  const [start, end] = range;
  const windowStart = Math.max(0, start - contextBefore);
  const windowEnd = Math.min(text.length, end + contextAfter);
  return {
    before: flatten(text.slice(windowStart, start)).trimStart(),
    match: flatten(text.slice(start, end)),
    after: flatten(text.slice(end, windowEnd)).trimEnd(),
    clippedStart: windowStart > 0,
    clippedEnd: windowEnd < text.length,
  };
}

export function formatSearchResult(
  rawMatches: SessionMatch[],
  truncated: boolean | number,
  options: {
    limit: number;
    maxMatchesPerSession: number;
    snippetContext: number;
    includeFullText: boolean;
  },
): SessionSearchResult {
  const chosenSessions = rawMatches.slice(0, options.limit);
  let totalHits = 0;

  const sessions: SessionMatchItem[] = chosenSessions.map((item) => {
    totalHits += item.hitCount;
    const chosenDocs = item.matches.slice(0, options.maxMatchesPerSession);

    const matches: SessionMessageMatch[] = chosenDocs.map((dm) => {
      const snippets: SnippetItem[] = dm.ranges.slice(0, 3).map((range) => {
        const snip = buildSnippet(
          dm.document.text,
          range,
          options.snippetContext,
          options.snippetContext,
        );
        const prefix = snip.clippedStart ? "... " : "";
        const suffix = snip.clippedEnd ? " ..." : "";
        return {
          text: `${prefix}${snip.before}[${snip.match}]${snip.after}${suffix}`,
          matchText: snip.match,
        };
      });

      const resMatch: SessionMessageMatch = {
        entryId: dm.document.entryId,
        role: dm.document.role,
        hitCount: dm.ranges.length,
        snippets,
      };

      if (options.includeFullText) {
        resMatch.fullText = dm.document.text;
      }

      return resMatch;
    });

    return {
      id: item.session.id,
      name: item.session.name,
      title: item.session.title,
      path: item.session.path,
      modifiedAt: new Date(item.session.modified).toISOString(),
      hitCount: item.hitCount,
      matches,
    };
  });

  return {
    totalSessions: sessions.length,
    totalHits,
    truncated: Boolean(truncated),
    sessions,
  };
}
