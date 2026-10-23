import { spawnSync } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDocument, SessionMeta } from "../src/types";

export const T0 = "2026-01-01T00:00:00.000Z";

export function header(id: string, cwd: string, timestamp = T0): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd });
}

let counter = 0;

function nextId(): string {
  counter++;
  return counter.toString(16).padStart(8, "0");
}

function entry(message: Record<string, unknown>, at: string): string {
  return JSON.stringify({
    type: "message",
    id: nextId(),
    parentId: null,
    timestamp: at,
    message,
  });
}

export function userLine(content: unknown, at = T0): string {
  return entry({ role: "user", content, timestamp: Date.parse(at) }, at);
}

export function assistantLine(
  text: string,
  extraBlocks: unknown[] = [],
  at = T0,
): string {
  return entry(
    {
      role: "assistant",
      content: [...extraBlocks, { type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {},
      stopReason: "stop",
      timestamp: Date.parse(at),
    },
    at,
  );
}

/** Assistant turn whose only mention of anything is hidden from search. */
export function hiddenMentionLine(text: string, at = T0): string {
  return entry(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `thinking about ${text}` },
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { path: text },
        },
      ],
      stopReason: "toolUse",
      timestamp: Date.parse(at),
    },
    at,
  );
}

export function toolCallOnlyLine(argumentsText: string, at = T0): string {
  return entry(
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "bash",
          arguments: { command: argumentsText },
        },
      ],
      stopReason: "toolUse",
      timestamp: Date.parse(at),
    },
    at,
  );
}

export function toolResultLine(text: string, at = T0): string {
  return entry(
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.parse(at),
    },
    at,
  );
}

export function sessionInfoLine(name: string | undefined): string {
  return JSON.stringify({
    type: "session_info",
    id: nextId(),
    parentId: null,
    timestamp: T0,
    name,
  });
}

export function sessionFile(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export interface TempDir {
  path: string;
  write(name: string, content: string, mtimeMs?: number): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), "pi-session-search-"));
  return {
    path,
    async write(name, content, mtimeMs) {
      const file = join(path, name);
      await writeFile(file, content, "utf8");
      if (mtimeMs !== undefined) {
        await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
      }
      return file;
    },
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export function makeDocument(
  role: SessionDocument["role"],
  text: string,
): SessionDocument {
  return { entryId: nextId(), role, text };
}

export function makeSession(
  overrides: Partial<SessionMeta> & { path: string },
): SessionMeta {
  return {
    id: overrides.path,
    cwd: "/project",
    title: "(no messages)",
    modified: Date.parse(T0),
    ...overrides,
  };
}

let ripgrepAvailable: boolean | undefined;

export function hasRipgrep(): boolean {
  if (ripgrepAvailable === undefined) {
    const result = spawnSync("rg", ["--version"], { stdio: "ignore" });
    ripgrepAvailable = !result.error && result.status === 0;
  }
  return ripgrepAvailable;
}
