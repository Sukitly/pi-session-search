import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AbortError, RipgrepError } from "../src/ripgrep";
import {
  buildLinePattern,
  buildSnippet,
  byteRangesToCharRanges,
  documentFromLine,
  jsonEscapeText,
  LINE_SCAN_CAP,
  literalHits,
  MAX_RANGES_PER_DOCUMENT,
  parseQuery,
  searchSessions,
} from "../src/search";
import { listSessions } from "../src/sessions";
import type { SessionMeta, SessionScope } from "../src/types";
import {
  assistantLine,
  hasRipgrep,
  header,
  hiddenMentionLine,
  makeTempDir,
  sessionFile,
  T0,
  type TempDir,
  toolCallOnlyLine,
  toolResultLine,
  userLine,
} from "./fixtures";

describe("parseQuery", () => {
  it("treats blank input as empty", () => {
    expect(parseQuery("")).toEqual({ kind: "empty" });
    expect(parseQuery("   ")).toEqual({ kind: "empty" });
    expect(parseQuery("re:")).toEqual({ kind: "empty" });
    expect(parseQuery("re:   ")).toEqual({ kind: "empty" });
  });

  it("makes a literal query case-sensitive only when it has uppercase", () => {
    expect(parseQuery(" foo bar ")).toEqual({
      kind: "literal",
      needle: "foo bar",
      caseSensitive: false,
    });
    expect(parseQuery("Foo")).toMatchObject({ caseSensitive: true });
    expect(parseQuery("数据库")).toMatchObject({ caseSensitive: false });
  });

  it("applies the same rule to regexes, ignoring escapes", () => {
    expect(parseQuery("re:a+b")).toEqual({
      kind: "regex",
      source: "a+b",
      caseSensitive: false,
    });
    expect(parseQuery("re:\\S+")).toMatchObject({ caseSensitive: false });
    expect(parseQuery("re:\\d{2}")).toMatchObject({ caseSensitive: false });
    expect(parseQuery("re:Foo")).toMatchObject({ caseSensitive: true });
  });
});

describe("buildLinePattern", () => {
  it("anchors a literal inside the message's own text", () => {
    expect(jsonEscapeText('say "hi"\\n')).toBe('say \\"hi\\"\\\\n');
    const pattern = buildLinePattern({
      kind: "literal",
      needle: 'a.b "c"',
      caseSensitive: false,
    });
    expect(pattern).toContain('"content":');
    expect(pattern).toContain('{"type":"text","text":"');
    expect(pattern).toContain('a\\.b \\\\\\"c\\\\\\"');
  });

  it("lets a regex match anywhere on a message line", () => {
    const pattern = buildLinePattern({
      kind: "regex",
      source: "a|b",
      caseSensitive: false,
    });
    expect(pattern.endsWith("(?:a|b)")).toBe(true);
    expect(pattern).not.toContain('{"type":"text","text":"');
  });
});

describe("documentFromLine", () => {
  it("extracts text blocks and ignores other roles and blocks", () => {
    expect(documentFromLine(userLine("hi"))).toMatchObject({
      role: "user",
      text: "hi",
    });
    expect(
      documentFromLine(
        assistantLine("visible", [
          { type: "thinking", thinking: "hidden" },
          { type: "toolCall", id: "c", name: "read", arguments: {} },
        ]),
      )?.text,
    ).toBe("visible");
    expect(documentFromLine(toolResultLine("x"))).toBeUndefined();
    expect(documentFromLine(toolCallOnlyLine("x"))).toBeUndefined();
    expect(documentFromLine("{broken")).toBeUndefined();
  });
});

describe("literalHits", () => {
  it("counts every occurrence but keeps only maxRanges positions", () => {
    const hits = literalHits("x ".repeat(50), "x", false, 20);
    expect(hits.total).toBe(50);
    expect(hits.ranges).toHaveLength(20);
  });

  it("folds case the way ripgrep does", () => {
    // U+212A KELVIN SIGN folds to "k" only with the Unicode flag.
    const hits = literalHits("temperature 100\u212A", "k", false, 20);
    expect(hits.total).toBe(1);
  });
});

describe("byteRangesToCharRanges", () => {
  it("maps UTF-8 byte offsets to string indices", () => {
    const text = "héllo 数据库 x";
    const bytes = Buffer.from(text, "utf8");
    const start = bytes.indexOf(Buffer.from("数据库"));
    expect(
      byteRangesToCharRanges(text, [
        { start, end: start + 9 },
        { start: 0, end: 1 },
        { start: 5, end: 3 },
      ]),
    ).toEqual([
      [6, 9],
      [0, 1],
    ]);
  });
});

describe("buildSnippet", () => {
  it("returns single-line context with clipping flags", () => {
    const text = "line one\n\n  line two has the   match here\nline three";
    const start = text.indexOf("match");
    expect(buildSnippet(text, [start, start + 5], 12, 6)).toEqual({
      before: "o has the ",
      match: "match",
      after: " here",
      clippedStart: true,
      clippedEnd: true,
    });
  });
});

describe.skipIf(!hasRipgrep())("searchSessions", () => {
  let dir: TempDir;
  let scope: SessionScope;
  let sessions: SessionMeta[];

  beforeEach(async () => {
    dir = await makeTempDir();
    scope = { cwd: "/project", sessionDir: dir.path, filterByCwd: false };
    await dir.write(
      "recent.jsonl",
      sessionFile([
        header("recent", "/project"),
        userLine(
          'please fix the useEffect loop in "app.tsx"',
          "2026-05-01T00:00:00.000Z",
        ),
        assistantLine(
          "The useEffect dependency array is wrong. USEEFFECT!",
          [{ type: "thinking", thinking: "useEffect thinking only" }],
          "2026-05-01T00:00:01.000Z",
        ),
        toolCallOnlyLine("grep useEffect src", "2026-05-01T00:00:02.000Z"),
        toolResultLine("useEffect appears in tool output"),
        userLine("数据库 迁移 how", "2026-05-01T00:00:03.000Z"),
      ]),
    );
    await dir.write(
      "old.jsonl",
      sessionFile([
        header("old", "/project"),
        userLine("nothing relevant\nline two mentions useeffect", T0),
        assistantLine("a.b literal and axb", [], T0),
      ]),
    );
    sessions = await listSessions(scope);
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it("finds literal matches in user and assistant text only", async () => {
    const { matches, truncated } = await searchSessions(
      { kind: "literal", needle: "useeffect", caseSensitive: false },
      { sessions },
    );
    expect(truncated).toBe(0);
    expect(matches.map((r) => r.session.id)).toEqual(["recent", "old"]);
    const recent = matches[0];
    expect(recent?.hitCount).toBe(3);
    expect(
      recent?.matches.map((m) => [m.document.role, m.ranges.length]),
    ).toEqual([
      ["user", 1],
      ["assistant", 2],
    ]);
    const joined = recent?.matches.map((m) => m.document.text).join("\n");
    expect(joined).not.toContain("thinking only");
    expect(joined).not.toContain("tool output");
    expect(matches[1]?.matches[0]?.ranges).toEqual([[35, 44]]);
  });

  it("honours the caseSensitive flag", async () => {
    const { matches } = await searchSessions(
      { kind: "literal", needle: "USEEFFECT", caseSensitive: true },
      { sessions },
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.hitCount).toBe(1);
  });

  it("treats literal needles literally, including quotes", async () => {
    const dot = await searchSessions(
      { kind: "literal", needle: "a.b", caseSensitive: false },
      { sessions },
    );
    expect(dot.matches).toHaveLength(1);
    expect(dot.matches[0]?.hitCount).toBe(1);
    const quoted = await searchSessions(
      { kind: "literal", needle: '"app.tsx"', caseSensitive: false },
      { sessions },
    );
    expect(quoted.matches).toHaveLength(1);
    expect(quoted.matches[0]?.matches[0]?.ranges).toEqual([[33, 42]]);
  });

  it("returns character ranges for CJK text", async () => {
    const { matches } = await searchSessions(
      { kind: "literal", needle: "迁移", caseSensitive: false },
      { sessions },
    );
    expect(matches[0]?.matches[0]?.ranges).toEqual([[4, 6]]);
  });

  it("supports regex mode and reports invalid patterns", async () => {
    const { matches } = await searchSessions(
      { kind: "regex", source: "use(effect|state)", caseSensitive: false },
      { sessions },
    );
    expect(matches.map((r) => r.session.id)).toEqual(["recent", "old"]);
    await expect(
      searchSessions(
        { kind: "regex", source: "(unclosed", caseSensitive: false },
        { sessions },
      ),
    ).rejects.toBeInstanceOf(RipgrepError);
  });

  it("returns nothing for empty queries or no matches", async () => {
    expect(await searchSessions({ kind: "empty" }, { sessions })).toEqual({
      matches: [],
      truncated: 0,
    });
    expect(
      (
        await searchSessions(
          { kind: "literal", needle: "zzzz", caseSensitive: false },
          { sessions },
        )
      ).matches,
    ).toEqual([]);
  });

  it("can be aborted", async () => {
    const controller = new AbortController();
    const pending = searchSessions(
      { kind: "literal", needle: "use", caseSensitive: false },
      { sessions, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it("reports ripgrep failures through the given command", async () => {
    await expect(
      searchSessions(
        { kind: "literal", needle: "use", caseSensitive: false },
        { sessions, ripgrepCommand: "pi-session-search-missing-rg" },
      ),
    ).rejects.toMatchObject({ name: "RipgrepUnavailableError" });
  });
});

describe.skipIf(!hasRipgrep())("searchSessions scan window", () => {
  let dir: TempDir;
  let scope: SessionScope;

  beforeEach(async () => {
    dir = await makeTempDir();
    scope = { cwd: "/project", sessionDir: dir.path, filterByCwd: false };
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  async function sessionsIn(lines: string[]): Promise<SessionMeta[]> {
    await dir.write("a.jsonl", sessionFile(lines));
    return listSessions(scope);
  }

  it("keeps a real match behind many hidden mentions", async () => {
    const noise = Array.from({ length: LINE_SCAN_CAP + 50 }, () =>
      hiddenMentionLine("src/ui.ts"),
    );
    const sessions = await sessionsIn([
      header("a", "/project"),
      ...noise,
      userLine("please look at src/ui.ts again"),
    ]);
    const { matches, truncated } = await searchSessions(
      { kind: "literal", needle: "src/ui.ts", caseSensitive: false },
      { sessions },
    );
    expect(truncated).toBe(0);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matches).toHaveLength(1);
    expect(matches[0]?.capped).toBe(false);
  });

  it("marks a session whose scan window filled up", async () => {
    const hits = Array.from({ length: LINE_SCAN_CAP + 5 }, (_, i) =>
      userLine(`needle number ${i}`),
    );
    const sessions = await sessionsIn([header("a", "/project"), ...hits]);
    const { matches, truncated } = await searchSessions(
      { kind: "literal", needle: "needle", caseSensitive: false },
      { sessions },
    );
    expect(truncated).toBe(1);
    expect(matches[0]?.capped).toBe(true);
    expect(matches[0]?.matches).toHaveLength(LINE_SCAN_CAP);
  });

  it("does not mark a session that fits exactly", async () => {
    const hits = Array.from({ length: LINE_SCAN_CAP }, (_, i) =>
      userLine(`needle number ${i}`),
    );
    const sessions = await sessionsIn([header("a", "/project"), ...hits]);
    const { matches, truncated } = await searchSessions(
      { kind: "literal", needle: "needle", caseSensitive: false },
      { sessions },
    );
    expect(truncated).toBe(0);
    expect(matches[0]?.capped).toBe(false);
    expect(matches[0]?.matches).toHaveLength(LINE_SCAN_CAP);
  });

  it("counts every occurrence while storing bounded ranges", async () => {
    const sessions = await sessionsIn([
      header("a", "/project"),
      userLine(`${"hit ".repeat(50)}done`),
    ]);
    const { matches } = await searchSessions(
      { kind: "literal", needle: "hit", caseSensitive: false },
      { sessions },
    );
    expect(matches[0]?.hitCount).toBe(50);
    expect(matches[0]?.matches[0]?.ranges).toHaveLength(
      MAX_RANGES_PER_DOCUMENT,
    );
  });

  it("finds messages left on abandoned branches", async () => {
    const sessions = await sessionsIn([
      header("a", "/project"),
      userLine("kept branch text"),
      JSON.stringify({
        type: "message",
        id: "deadbeef",
        parentId: null,
        timestamp: T0,
        message: {
          role: "user",
          content: "abandoned branch text",
          timestamp: Date.parse(T0),
        },
      }),
    ]);
    const { matches } = await searchSessions(
      { kind: "literal", needle: "abandoned", caseSensitive: false },
      { sessions },
    );
    expect(matches).toHaveLength(1);
  });
});
