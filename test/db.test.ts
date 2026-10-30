import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSessionDatabase,
  listRecentSessionsFromDb,
  readSessionMetadata,
  searchBM25ForUI,
  searchSessionsBM25,
  syncDatabase,
  syncFtsBackground,
  syncMetadataQuick,
  tokenizeForFts,
} from "../src/db";
import type { SessionScope } from "../src/types";
import {
  assistantLine,
  header,
  makeTempDir,
  sessionFile,
  sessionInfoLine,
  type TempDir,
  toolCallOnlyLine,
  toolResultLine,
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

    it("syncMetadataQuick streams progressive updates and syncFtsBackground indexes messages", async () => {
      const file1 = await temp.write(
        "2026-09-02T10-00-00-000Z_session-1.jsonl",
        sessionFile([
          header("session-1", temp.path),
          userLine("First session topic"),
          assistantLine("Answer for first session"),
        ]),
      );

      const meta1 = await readSessionMetadata(file1, 12345);
      expect(meta1).toBeDefined();
      expect(meta1?.id).toBe("session-1");
      expect(meta1?.title).toBe("First session topic");

      await temp.write(
        "2026-09-02T11-00-00-000Z_session-2.jsonl",
        sessionFile([
          header("session-2", temp.path),
          userLine("Second session topic with uniqueKeyword"),
          assistantLine("Answer for second session"),
        ]),
      );

      const db = getSessionDatabase(scope.sessionDir);
      const progressCalls: Array<{ loaded: number; count: number }> = [];

      const sessions = await syncMetadataQuick(db, scope, {
        onProgress: (loaded, _total, partial) => {
          progressCalls.push({ loaded, count: partial.length });
        },
      });

      expect(sessions.length).toBe(2);
      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls[0].count).toBeGreaterThanOrEqual(1);

      // Metadata is stored in DB immediately
      const recent = listRecentSessionsFromDb(db);
      expect(recent.length).toBe(2);

      // Before background FTS, keyword search finds 0
      const beforeFts = searchBM25ForUI(db, "uniqueKeyword", recent);
      expect(beforeFts.matches.length).toBe(0);

      // Run background FTS
      let indexedCount = 0;
      await syncFtsBackground(db, scope, {
        onFileIndexed: () => {
          indexedCount++;
        },
      });

      expect(indexedCount).toBe(2);

      // After background FTS, keyword search finds session-2
      const afterFts = searchBM25ForUI(db, "uniqueKeyword", recent);
      expect(afterFts.matches.length).toBe(1);
      expect(afterFts.matches[0].session.id).toBe("session-2");
    });

    it("uses the latest message timestamp and latest session_info name for resumed sessions", async () => {
      const tCreatedOld = "2026-10-22T05:41:16.587Z";
      const tFirstMsgOld = "2026-10-22T05:42:00.000Z";
      const tCreatedNew = "2026-10-28T16:52:33.381Z";
      const tFirstMsgNew = "2026-10-28T16:53:10.000Z";
      const tResumedOld = "2026-10-30T02:27:25.876Z";

      // Older session file that was resumed later on Oct 30 and renamed after the first message
      await temp.write(
        "2026-10-22T05-41-16-587Z_old-resumed.jsonl",
        sessionFile([
          header("old-resumed", temp.path, tCreatedOld),
          userLine("你看看这个设计文档", tFirstMsgOld),
          assistantLine("好的", [], tFirstMsgOld),
          toolResultLine("large tool output", tFirstMsgOld),
          sessionInfoLine("Renamed After First Message"),
          userLine("继续修改", tResumedOld),
          toolCallOnlyLine("ls", tResumedOld),
        ]),
      );

      // Newer created session file that was not touched after Oct 28
      await temp.write(
        "2026-10-28T16-52-33-381Z_new-untouched.jsonl",
        sessionFile([
          header("new-untouched", temp.path, tCreatedNew),
          userLine("当前 pi 的 TUI 怎么设置", tFirstMsgNew),
          assistantLine("默认已开启", [], tFirstMsgNew),
        ]),
      );

      const db = getSessionDatabase(scope.sessionDir);
      const scanned = await syncMetadataQuick(db, scope);

      expect(scanned.map((s) => s.id)).toEqual([
        "old-resumed",
        "new-untouched",
      ]);
      expect(scanned[0]?.modified).toBe(Date.parse(tResumedOld));
      expect(scanned[0]?.name).toBe("Renamed After First Message");
      expect(scanned[1]?.modified).toBe(Date.parse(tFirstMsgNew));

      await syncFtsBackground(db, scope);
      const fromDb = listRecentSessionsFromDb(db);
      expect(fromDb.map((s) => s.id)).toEqual(["old-resumed", "new-untouched"]);
      expect(fromDb[0]?.modified).toBe(Date.parse(tResumedOld));
      expect(fromDb[0]?.name).toBe("Renamed After First Message");
    });

    it("migrates user_version 0 databases by forcing a metadata rescan while preserving indexed_mtime_ms", async () => {
      const tInitial = "2026-10-22T05:42:00.000Z";
      const tLatest = "2026-10-30T02:27:25.876Z";
      const mtimeMs = 1793327245000;

      const filePath = await temp.write(
        "2026-10-22T05-41-16-587Z_migrated.jsonl",
        sessionFile([
          header("migrated", temp.path, tInitial),
          userLine("First prompt", tInitial),
          assistantLine("Later reply", [], tLatest),
        ]),
        mtimeMs,
      );

      // Simulate a pre-fix user_version=0 database with stale modified timestamp
      const rawDb = new DatabaseSync(
        join(scope.sessionDir, ".session-search.db"),
      );
      rawDb.exec(`
        CREATE TABLE sessions_meta (
          path TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          cwd TEXT,
          name TEXT,
          title TEXT,
          modified INTEGER,
          mtime_ms REAL NOT NULL,
          indexed_mtime_ms REAL
        );
        PRAGMA user_version = 0;
      `);
      rawDb
        .prepare("INSERT INTO sessions_meta VALUES (?, ?, ?, NULL, ?, ?, ?, ?)")
        .run(
          filePath,
          "migrated",
          temp.path,
          "First prompt",
          Date.parse(tInitial),
          mtimeMs,
          mtimeMs,
        );
      rawDb.close();

      const db = getSessionDatabase(scope.sessionDir);
      const refreshed = await syncMetadataQuick(db, scope);
      expect(refreshed[0]?.modified).toBe(Date.parse(tLatest));

      // Because indexed_mtime_ms was preserved, syncFtsBackground does not need to re-index
      let reindexed = 0;
      await syncFtsBackground(db, scope, {
        onFileIndexed: () => {
          reindexed++;
        },
      });
      expect(reindexed).toBe(0);
    });
  });
});
