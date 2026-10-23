import { describe, expect, it } from "vitest";
import {
  AbortError,
  escapeRipgrepRegex,
  parseRipgrepJson,
  parseRipgrepLines,
  RipgrepError,
  RipgrepUnavailableError,
  runRipgrep,
} from "../src/ripgrep";
import { hasRipgrep } from "./fixtures";

describe("parseRipgrepLines", () => {
  it("parses path\\0line:text records and skips malformed ones", () => {
    const output = [
      "/dir/odd:name.jsonl\u00001:first:line",
      "garbage",
      "/dir/b.jsonl\u0000x:bad number",
      "/dir/b.jsonl\u00003:third\r",
    ].join("\n");
    expect(parseRipgrepLines(output)).toEqual([
      { path: "/dir/odd:name.jsonl", lineNumber: 1, text: "first:line" },
      { path: "/dir/b.jsonl", lineNumber: 3, text: "third" },
    ]);
  });
});

describe("parseRipgrepJson", () => {
  it("keeps match records with byte submatches", () => {
    const output = [
      '{"type":"begin","data":{"path":{"text":"<stdin>"}}}',
      '{"type":"match","data":{"path":{"text":"<stdin>"},"lines":{"text":"ab\\n"},"line_number":2,"absolute_offset":0,"submatches":[{"match":{"text":"b"},"start":1,"end":2},{"match":{"text":""},"start":2,"end":2}]}}',
      "not json",
      '{"type":"end","data":{}}',
    ].join("\n");
    expect(parseRipgrepJson(output)).toEqual([
      { lineNumber: 2, submatches: [{ start: 1, end: 2 }] },
    ]);
  });
});

describe("escapeRipgrepRegex", () => {
  it("escapes punctuation except the word-boundary characters", () => {
    expect(escapeRipgrepRegex("a.b*c(d)[e]{f}^g$h|i?j+k\\l/m\"n'o#p-q")).toBe(
      "a\\.b\\*c\\(d\\)\\[e\\]\\{f\\}\\^g\\$h\\|i\\?j\\+k\\\\l\\/m\\\"n\\'o\\#p\\-q",
    );
    expect(escapeRipgrepRegex("<tag> 数据库 ok")).toBe("<tag> 数据库 ok");
  });
});

describe.skipIf(!hasRipgrep())("runRipgrep", () => {
  it("searches stdin and resolves with empty output on no match", async () => {
    const output = await runRipgrep(["--json", "-e", "b"], { input: "ab\nc" });
    expect(parseRipgrepJson(output)).toEqual([
      { lineNumber: 1, submatches: [{ start: 1, end: 2 }] },
    ]);
    await expect(runRipgrep(["-e", "zzz"], { input: "ab\nc" })).resolves.toBe(
      "",
    );
  });

  it("reports invalid patterns with rg's error line", async () => {
    await expect(
      runRipgrep(["-e", "(unclosed"], { input: "x" }),
    ).rejects.toMatchObject({
      name: "RipgrepError",
      message: "unclosed group",
    });
  });

  it("escaped literals round-trip through rg", async () => {
    const literal = "a.b*c(d)[e]{f}^g$h|i?j+k\\l/m\"n'o#p-q <t>";
    const output = await runRipgrep(
      ["--json", "-e", escapeRipgrepRegex(literal)],
      { input: `${literal}\nother` },
    );
    expect(parseRipgrepJson(output)).toHaveLength(1);
  });

  it("rejects with AbortError when the signal fires", async () => {
    const controller = new AbortController();
    const pending = runRipgrep(["-e", "x"], {
      input: "x".repeat(1000),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });
});

describe("runRipgrep with a missing executable", () => {
  it("rejects with RipgrepUnavailableError naming the command", async () => {
    await expect(
      runRipgrep(["-e", "x"], {
        input: "x",
        command: "pi-session-search-missing-rg",
      }),
    ).rejects.toBeInstanceOf(RipgrepUnavailableError);
    expect(new RipgrepError(2, "rg: boom\n").message).toBe("boom");
  });

  it("names every candidate when none can be spawned", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/pi-session-search-empty-path";
    try {
      await runRipgrep(["-e", "x"], { input: "x" });
      expect.unreachable("should not find ripgrep");
    } catch (error) {
      expect(error).toBeInstanceOf(RipgrepUnavailableError);
      const message = (error as Error).message;
      expect(message).toContain("Looked for: rg");
      expect(message).toContain("bin/rg");
    } finally {
      process.env.PATH = saved;
    }
  });
});
