import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionSearchTool } from "../src/tool";
import type { SessionSearchResult } from "../src/types";
import {
  assistantLine,
  header,
  makeTempDir,
  sessionFile,
  type TempDir,
  userLine,
} from "./fixtures";

describe("sessionSearchTool", () => {
  let temp: TempDir;
  let mockCtx: ExtensionContext;

  beforeEach(async () => {
    temp = await makeTempDir();
    mockCtx = {
      cwd: temp.path,
      sessionManager: {
        getSessionDir: () => temp.path,
        getCwd: () => temp.path,
      },
    } as unknown as ExtensionContext;
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  it("lists recent sessions when query is omitted", async () => {
    await temp.write(
      "session-1.jsonl",
      sessionFile([
        header("session-1", temp.path),
        userLine("First user question"),
        assistantLine("First assistant answer"),
      ]),
    );

    const result = await sessionSearchTool.execute(
      "call-1",
      { limit: 5 },
      undefined,
      undefined,
      mockCtx,
    );

    const details = result.details as SessionSearchResult;
    expect(details.totalSessions).toBe(1);
    expect(details.sessions[0].id).toBe("session-1");
  });

  it("searches with BM25 when query is provided", async () => {
    await temp.write(
      "session-1.jsonl",
      sessionFile([
        header("session-1", temp.path),
        userLine("Debugging SQLite FTS5 indexes"),
        assistantLine("FTS5 supports bm25 ranking."),
      ]),
    );

    const result = await sessionSearchTool.execute(
      "call-2",
      { query: "SQLite FTS5", limit: 5 },
      undefined,
      undefined,
      mockCtx,
    );

    const details = result.details as SessionSearchResult;
    expect(details.totalSessions).toBe(1);
    expect(details.sessions[0].id).toBe("session-1");
    expect(details.sessions[0].matches.length).toBeGreaterThan(0);
    const textBlock = result.content[0];
    expect(textBlock.type).toBe("text");
    if (textBlock.type === "text") {
      expect(textBlock.text).toContain("SQLite");
    }
  });

  it("falls back to ripgrep when regex is provided", async () => {
    await temp.write(
      "session-1.jsonl",
      sessionFile([
        header("session-1", temp.path),
        userLine("Error code: D1234 encountered"),
        assistantLine("D1234 indicates timeout."),
      ]),
    );

    const result = await sessionSearchTool.execute(
      "call-3",
      { query: "re:D[0-9]+", limit: 5 },
      undefined,
      undefined,
      mockCtx,
    );

    const details = result.details as SessionSearchResult;
    expect(details.totalSessions).toBe(1);
    expect(details.sessions[0].id).toBe("session-1");
    const textBlock = result.content[0];
    expect(textBlock.type).toBe("text");
    if (textBlock.type === "text") {
      expect(textBlock.text).toContain("[D1234]");
    }
  });
});
