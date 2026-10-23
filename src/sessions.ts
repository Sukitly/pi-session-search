import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  parseRipgrepLines,
  type RipgrepLine,
  type RipgrepOptions,
  runRipgrepOverFiles,
} from "./ripgrep";
import type {
  SearchRole,
  SessionDocument,
  SessionMeta,
  SessionScope,
} from "./types";

/**
 * Mirrors pi's private getDefaultSessionDirPath(): the per-project session
 * directory under the agent directory. Used to detect a custom --session-dir,
 * which is the only case where pi filters sessions by header cwd.
 */
export function defaultSessionDir(
  cwd: string,
  agentDir: string = getAgentDir(),
): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

/** Mirrors pi's sessionCwdMatches(): an empty header cwd never matches. */
export function sessionCwdMatches(headerCwd: string, cwd: string): boolean {
  return headerCwd !== "" && resolve(headerCwd) === resolve(cwd);
}

export interface SessionFile {
  path: string;
  mtimeMs: number;
}

/** Top-level `.jsonl` files in the session directory, like pi's list(). */
export async function listSessionFiles(
  sessionDir: string,
): Promise<SessionFile[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch (error) {
    // A missing directory means the project has no sessions yet. Permission
    // and I/O errors are real failures and must reach the user.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: SessionFile[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const path = join(sessionDir, name);
        try {
          const info = await stat(path);
          if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs });
        } catch {
          // Deleted or unreadable while listing.
        }
      }),
  );
  return files;
}

/** Longest first-user-message fragment fetched for a title. */
const TITLE_CHARS = 300;

/** JSON string body of up to TITLE_CHARS characters, opening quote included. */
const STRING_PREFIX = `"(?:[^"\\\\]|\\\\.){0,${TITLE_CHARS}}`;

/**
 * Selects three things in one pass: the header line, session_info lines, and
 * for every user or assistant message its entry timestamp plus, for user
 * messages only, a bounded prefix of the first text it carries.
 *
 * Used with `--only-matching --replace`, so ripgrep prints only the capture
 * groups: whole lines for the first alternative, and `<timestamp>\t<body>`
 * for message lines. Leading image blocks are skipped by the pattern and
 * never printed, which matters because pasted screenshots are megabytes of
 * base64.
 */
const METADATA_PATTERN =
  '(^\\{"type":"session(?:_info)?".*)' +
  '|^\\{"type":"message".{0,200}"timestamp":"([^"]*)","message":\\{"role":' +
  '(?:"assistant"' +
  `|"user"(?:,"content":(?:(${STRING_PREFIX})` +
  `|\\[(?:\\{"type":"image",[^}]*\\},?)*\\{"type":"text","text":(${STRING_PREFIX})))?)`;
// ripgrep expands ${N} groups; an unmatched group expands to nothing.
const METADATA_REPLACEMENT = `$\{1}$\{2}\t$\{3}$\{4}`;

const HEADER_PREFIX = '{"type":"session"';
const SESSION_INFO_PREFIX = '{"type":"session_info"';

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Decodes the leading part of a JSON string body that may have been cut mid
 * way. Stops at the first unescaped quote; drops a trailing partial escape.
 */
export function decodeJsonStringPrefix(body: string): string {
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"') {
      end = i;
      break;
    }
  }
  let text = end === -1 ? body : body.slice(0, end);
  if (end === -1) text = text.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

/**
 * Splits a `<timestamp>\t<body>` record emitted by METADATA_PATTERN. The
 * body is a JSON string starting at its opening quote, and is empty for
 * assistant messages and for user messages with no text.
 */
export function parseActivityRecord(
  record: string,
): { timestamp: number; title?: string } | undefined {
  const tab = record.indexOf("\t");
  if (tab === -1) return undefined;
  const timestamp = new Date(record.slice(0, tab)).getTime();
  if (Number.isNaN(timestamp)) return undefined;
  const body = record.slice(tab + 1);
  if (!body.startsWith('"')) return { timestamp };
  return { timestamp, title: decodeJsonStringPrefix(body.slice(1)) };
}

function collapse(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

interface MetaDraft {
  id?: string;
  cwd: string;
  created?: number;
  name?: string;
  title?: string;
  lastActivity?: number;
}

/** Folds metadata records for one file, in line order. */
export function buildSessionMeta(
  file: SessionFile,
  records: readonly RipgrepLine[],
): SessionMeta | undefined {
  const draft: MetaDraft = { cwd: "" };
  for (const record of records) {
    const line = record.text;
    if (record.lineNumber === 1) {
      const entry = parseJson(line);
      if (!isRecord(entry) || entry.type !== "session") return undefined;
      if (typeof entry.id !== "string") return undefined;
      draft.id = entry.id;
      draft.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      const created =
        typeof entry.timestamp === "string"
          ? new Date(entry.timestamp).getTime()
          : Number.NaN;
      if (!Number.isNaN(created)) draft.created = created;
      continue;
    }
    if (line.startsWith(SESSION_INFO_PREFIX)) {
      const entry = parseJson(line);
      if (!isRecord(entry) || entry.type !== "session_info") continue;
      const name = typeof entry.name === "string" ? collapse(entry.name) : "";
      draft.name = name || undefined;
      continue;
    }
    if (line.startsWith(HEADER_PREFIX)) continue;
    const activity = parseActivityRecord(line);
    if (!activity) continue;
    draft.lastActivity = Math.max(draft.lastActivity ?? 0, activity.timestamp);
    if (draft.title === undefined && activity.title !== undefined) {
      draft.title = collapse(activity.title);
    }
  }
  if (draft.id === undefined) return undefined;
  return {
    path: file.path,
    id: draft.id,
    cwd: draft.cwd,
    name: draft.name,
    title: draft.title || "(no messages)",
    modified: draft.lastActivity ?? draft.created ?? file.mtimeMs,
  };
}

/**
 * Lists sessions in scope with one ripgrep pass over the directory. Output is
 * bounded to headers, names, entry timestamps, and title fragments, so no
 * message body is read into memory. Most recent activity first, matching how
 * pi orders /resume.
 */
export async function listSessions(
  scope: SessionScope,
  options: RipgrepOptions = {},
): Promise<SessionMeta[]> {
  const files = await listSessionFiles(scope.sessionDir);
  if (files.length === 0) return [];
  const output = await runRipgrepOverFiles(
    [
      "--with-filename",
      "--line-number",
      "--null",
      "--only-matching",
      "--replace",
      METADATA_REPLACEMENT,
      "-e",
      METADATA_PATTERN,
    ],
    files.map((file) => file.path),
    options,
  );
  const byPath = new Map<string, RipgrepLine[]>();
  for (const record of parseRipgrepLines(output)) {
    const list = byPath.get(record.path);
    if (list) list.push(record);
    else byPath.set(record.path, [record]);
  }
  const sessions: SessionMeta[] = [];
  for (const file of files) {
    const meta = buildSessionMeta(file, byPath.get(file.path) ?? []);
    if (!meta) continue;
    if (scope.filterByCwd && !sessionCwdMatches(meta.cwd, scope.cwd)) continue;
    sessions.push(meta);
  }
  sessions.sort((a, b) => b.modified - a.modified);
  return sessions;
}

export function resolveSessionScope(
  cwd: string,
  configuredSessionDir?: string,
): SessionScope {
  if (configuredSessionDir) {
    const sessionDir = resolve(cwd, configuredSessionDir);
    return {
      cwd,
      sessionDir,
      filterByCwd: false,
    };
  }

  const localPiSessions = join(cwd, ".pi", "sessions");
  if (existsSync(localPiSessions)) {
    return {
      cwd,
      sessionDir: localPiSessions,
      filterByCwd: false,
    };
  }

  const fallback = defaultSessionDir(cwd);
  return {
    cwd,
    sessionDir: fallback,
    filterByCwd: false,
  };
}

export async function readSessionDocuments(
  filePath: string,
  roleFilter: "all" | SearchRole = "all",
  limit = 50,
): Promise<SessionDocument[]> {
  const content = await readFile(filePath, "utf8");
  const lines = content.split("\n");
  const documents: SessionDocument[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isRecord(entry) ||
      entry.type !== "message" ||
      typeof entry.id !== "string"
    ) {
      continue;
    }
    const message = entry.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    if (roleFilter !== "all" && role !== roleFilter) continue;

    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const block of message.content) {
        if (
          isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          parts.push(block.text);
        }
      }
      text = parts.join("\n");
    }

    if (!text) continue;
    documents.push({
      entryId: entry.id,
      role,
      text,
    });
    if (documents.length >= limit) break;
  }

  return documents;
}
