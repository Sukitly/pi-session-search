import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSessionDatabase,
  listRecentSessionsFromDb,
  searchBM25ForUI,
  searchSessionsBM25,
  syncDatabase,
  tokenizeForFts,
} from "../src/db";
import type { SessionScope } from "../src/types";
import {
  assistantLine,
  header,
  makeTempDir,
  sessionFile,
  type TempDir,
  userLine,
} from "./fixtures";

describe("db", () => {
  let temp: TempDir;
  let scope: SessionScope;

  beforeEach(async () => {
    temp = await makeTempDir();
    scope = {
      cwd: temp.path,
      sessionDir: temp.path,
      filterByCwd: false,
    };
  });

  afterEach(async () => {
    await temp.cleanup();
  });

  describe("tokenizeForFts", () => {
    it("tokenizes English words and removes punctuation", () => {
      const tokens = tokenizeForFts("Hello, World! BM25 search.");
      expect(tokens).toContain("hello");
      expect(tokens).toContain("world");
      expect(tokens).toContain("bm25");
      expect(tokens).toContain("search");
    });

    it("generates CJK bi-grams to prevent false positive substring matches", () => {
      const tokens = tokenizeForFts("我在网吧上网");
      expect(tokens).toContain("网吧");
      expect(tokens).toContain("上网");
    });

    it("filters single Han characters when querying multi-character Chinese", () => {
      const queryTokens = tokenizeForFts("网吧", true);
      expect(queryTokens).toEqual(["网吧"]);
    });
  });

  describe("syncDatabase and search", () => {
    it("indexes session files and performs BM25 search", async () => {
      await temp.write(
        "session-a.jsonl",
        sessionFile([
          header("session-a", temp.path),
          userLine("How do I use React useEffect hooks?"),
          assistantLine(
            "You can use useEffect for side effects in components.",
          ),
        ]),
      );

      await temp.write(
        "session-b.jsonl",
        sessionFile([
          header("session-b", temp.path),
          userLine("在网吧玩游戏"),
          assistantLine("网吧的环境比想象中轻松。"),
        ]),
      );

      const db = getSessionDatabase(scope.sessionDir);
      syncDatabase(db, scope);

      const recent = listRecentSessionsFromDb(db);
      expect(recent.length).toBe(2);

      // Search English
      const uiResult = searchBM25ForUI(db, "useEffect", recent);
      expect(uiResult.matches.length).toBe(1);
      expect(uiResult.matches[0].session.id).toBe("session-a");
      expect(uiResult.matches[0].hitCount).toBeGreaterThan(0);

      // Search Chinese Bi-gram
      const cnResult = searchBM25ForUI(db, "网吧", recent);
      expect(cnResult.matches.length).toBe(1);
      expect(cnResult.matches[0].session.id).toBe("session-b");

      // Search BM25 structured
      const structured = searchSessionsBM25(db, {
        query: "useEffect",
        limit: 5,
        maxMatchesPerSession: 5,
        snippetContext: 50,
        includeFullText: true,
      });

      expect(structured.totalSessions).toBe(1);
      expect(structured.sessions[0].id).toBe("session-a");
      expect(structured.sessions[0].matches.length).toBeGreaterThan(0);
      expect(structured.sessions[0].matches[0].snippets[0].text).toContain(
        "[useEffect]",
      );
    });

    it("incrementally updates when files change or are deleted", async () => {
      const fileA = await temp.write(
        "session-a.jsonl",
        sessionFile([header("session-a", temp.path), userLine("Initial text")]),
      );

      const db = getSessionDatabase(scope.sessionDir);
      syncDatabase(db, scope);
      expect(listRecentSessionsFromDb(db).length).toBe(1);

      // Update file A
      await temp.write(
        "session-a.jsonl",
        sessionFile([
          header("session-a", temp.path),
          userLine("Updated text with new keywords"),
        ]),
      );

      syncDatabase(db, scope);
      const res = searchBM25ForUI(db, "keywords", listRecentSessionsFromDb(db));
      expect(res.matches.length).toBe(1);

      // Delete file A
      await rm(fileA);
      syncDatabase(db, scope);
      expect(listRecentSessionsFromDb(db).length).toBe(0);
    });
  });
});
