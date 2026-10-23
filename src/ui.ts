import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  type KeybindingsManager,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { RipgrepError, RipgrepUnavailableError } from "./ripgrep";
import {
  buildSnippet,
  type ParsedQuery,
  parseQuery,
  REGEX_PREFIX,
  type SearchResult,
} from "./search";
import type { DocumentMatch, SessionMatch, SessionMeta } from "./types";

export type SearchFn = (
  query: ParsedQuery,
  sessions: readonly SessionMeta[],
  signal: AbortSignal,
) => Promise<SearchResult>;

/**
 * One list line. An empty query lists every session with no match attached,
 * so `match` is absent rather than an empty SessionMatch.
 */
export interface Row {
  session: SessionMeta;
  match?: SessionMatch;
}

export interface SessionSearchViewOptions {
  theme: Theme;
  keybindings: KeybindingsManager;
  search: SearchFn;
  initialQuery?: string;
  currentSessionPath?: string;
  requestRender: () => void;
  onSelect: (sessionPath: string) => void;
  onCancel: () => void;
  now?: () => number;
  /** Delay between the last keystroke and the ripgrep run. */
  debounceMs?: number;
}

export type ResumeSearchViewOptions = SessionSearchViewOptions;

/** Layout mirrors pi's /resume selector: 10 single-line rows. */
const LIST_ROWS = 10;
/** Snippet lines shown for the selected session; the block has fixed height. */
const PREVIEW_SNIPPETS = 4;
const PREVIEW_LINES = PREVIEW_SNIPPETS + 1;
/** Matches are aligned to this column inside the preview. */
const SNIPPET_BEFORE_COLUMNS = 24;
const SNIPPET_LABEL_WIDTH = 3;
const DEFAULT_DEBOUNCE_MS = 80;

export function formatAge(now: number, then: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function sessionTitle(session: SessionMeta): string {
  return session.name ?? session.title;
}

/** Last `columns` visible columns of text, left-padded to exactly that width. */
function alignRight(text: string, columns: number): string {
  const width = visibleWidth(text);
  const kept =
    width > columns
      ? sliceByColumn(text, width - columns, columns, true)
      : text;
  return " ".repeat(Math.max(0, columns - visibleWidth(kept))) + kept;
}

type Notice = { color: "muted" | "warning" | "error"; text: string };

/**
 * Editor replacement shown by /rs. Layout follows pi's session selector:
 * header, hints, query input, a fixed-height list of sessions, and a preview
 * of the selected session's matching messages. Every query runs ripgrep
 * through the injected search function; an empty query lists every session.
 * Nothing is cached beyond the current rows.
 */
export class SessionSearchView implements Component, Focusable {
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly search: SearchFn;
  private readonly requestRender: () => void;
  private readonly onSelect: (sessionPath: string) => void;
  private readonly onCancel: () => void;
  private readonly currentSessionPath: string | undefined;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly input: Input;
  private readonly border: DynamicBorder;

  private sessions: SessionMeta[] | undefined;
  private loadError: string | undefined;
  private parsed: ParsedQuery = { kind: "empty" };
  private rows: Row[] = [];
  private truncated = 0;
  private selectedIndex = 0;
  private searchError: string | undefined;
  private searching = false;
  private finished = false;

  private scanLoaded = 0;
  private scanTotal = 0;
  private indexingDone = 0;
  private indexingTotal = 0;

  private debounceTimer: NodeJS.Timeout | undefined;
  private inFlight: AbortController | undefined;
  private generation = 0;

  private _focused = false;

  constructor(options: SessionSearchViewOptions) {
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.search = options.search;
    this.requestRender = options.requestRender;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.currentSessionPath = options.currentSessionPath;
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.input = new Input();
    this.input.onSubmit = () => this.confirmSelection();
    this.border = new DynamicBorder((s: string) => this.theme.fg("accent", s));
    if (options.initialQuery) {
      this.input.setValue(options.initialQuery);
      this.parsed = parseQuery(options.initialQuery);
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  setSessions(sessions: SessionMeta[]): void {
    const previousPath = this.getSelectedSessionPath();
    this.sessions = sessions;
    this.loadError = undefined;
    this.runSearch(true);
    if (previousPath) {
      const newIndex = this.rows.findIndex(
        (r) => r.session.path === previousPath,
      );
      if (newIndex !== -1 && newIndex !== this.selectedIndex) {
        this.selectedIndex = newIndex;
        this.requestRender();
      }
    }
  }

  setScanProgress(loaded: number, total: number): void {
    this.scanLoaded = loaded;
    this.scanTotal = total;
    this.requestRender();
  }

  setIndexingProgress(done: number, total: number): void {
    this.indexingDone = done;
    this.indexingTotal = total;
    this.requestRender();
  }

  refreshSearch(): void {
    if (this.parsed.kind !== "empty" && !this.searching) {
      this.runSearch(true);
    }
  }

  setLoadError(error: unknown): void {
    this.loadError = describeError(error);
    this.requestRender();
  }

  getQuery(): string {
    return this.input.getValue();
  }

  getRows(): readonly Row[] {
    return this.rows;
  }

  getSelectedSessionPath(): string | undefined {
    return this.rows[this.selectedIndex]?.session.path;
  }

  invalidate(): void {
    this.border.invalidate();
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.cancel")) {
      this.finish(() => this.onCancel());
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.confirmSelection();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-LIST_ROWS);
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.moveSelection(LIST_ROWS);
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) {
      this.parsed = parseQuery(this.input.getValue());
      this.selectedIndex = 0;
      this.runSearch(false);
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const border = this.border.render(width);
    const lines: string[] = ["", ...border, ""];
    lines.push(...this.renderHeader(width), "");
    lines.push(...this.input.render(width), "");
    lines.push(...this.renderList(width));
    const preview = this.renderPreview(width);
    if (preview.length > 0) lines.push("", ...preview);
    lines.push("", ...border);
    return lines;
  }

  private renderHeader(width: number): string[] {
    const theme = this.theme;
    const title = theme.bold("Resume Session (Search)");
    let right: string;
    if (this.loadError) {
      right = theme.fg("error", "Unavailable");
    } else if (!this.sessions) {
      if (this.scanTotal > 0) {
        right = theme.fg(
          "accent",
          `Loading ${this.scanLoaded}/${this.scanTotal}…`,
        );
      } else {
        right = theme.fg("accent", "Loading…");
      }
    } else if (this.searching) {
      right = theme.fg("accent", "Searching…");
    } else if (this.parsed.kind === "empty") {
      let status = `${this.sessions.length} sessions`;
      if (this.indexingTotal > 0 && this.indexingDone < this.indexingTotal) {
        status += ` · indexing ${this.indexingDone}/${this.indexingTotal}`;
      }
      right = theme.fg("muted", status);
    } else {
      const hits = this.rows.reduce(
        (sum, row) => sum + (row.match?.hitCount ?? 0),
        0,
      );
      const plus = this.rows.some((row) => row.match?.capped) ? "+" : "";
      right = theme.fg(
        "muted",
        `${this.rows.length}/${this.sessions.length} sessions · ${hits}${plus} hits`,
      );
    }
    const rightText = truncateToWidth(right, width, "");
    const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
    const left = truncateToWidth(title, availableLeft, "");
    const spacing = Math.max(
      0,
      width - visibleWidth(left) - visibleWidth(rightText),
    );
    const sep = theme.fg("muted", " · ");
    const hint = (keys: string, text: string) =>
      theme.fg("dim", keys) + theme.fg("muted", ` ${text}`);
    const hint1 =
      hint(`${REGEX_PREFIX}<pattern>`, "regex") +
      sep +
      theme.fg("muted", "case-sensitive when the query has uppercase");
    const hint2 =
      this.truncated > 0
        ? theme.fg(
            "warning",
            `${this.truncated} ${this.truncated === 1 ? "session" : "sessions"} hit the scan limit; refine the query`,
          )
        : hint(this.keyLabel("tui.select.confirm"), "resume") +
          sep +
          hint(this.keyLabel("tui.select.cancel"), "cancel");
    return [
      `${left}${" ".repeat(spacing)}${rightText}`,
      truncateToWidth(hint1, width, "…"),
      truncateToWidth(hint2, width, "…"),
    ];
  }

  private keyLabel(id: "tui.select.confirm" | "tui.select.cancel"): string {
    return this.keybindings.getKeys(id).join("/");
  }

  private renderList(width: number): string[] {
    const theme = this.theme;
    const notice = this.listNotice();
    if (notice) {
      return [
        theme.fg(notice.color, truncateToWidth(`  ${notice.text}`, width, "…")),
      ];
    }
    const lines: string[] = [];
    const count = this.rows.length;
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(LIST_ROWS / 2),
        count - LIST_ROWS,
      ),
    );
    const end = Math.min(start + LIST_ROWS, count);
    for (let i = start; i < end; i++) {
      lines.push(
        this.renderRow(this.rows[i] as Row, i === this.selectedIndex, width),
      );
    }
    if (start > 0 || end < count) {
      const scroll = `  (${this.selectedIndex + 1}/${count})`;
      lines.push(theme.fg("muted", truncateToWidth(scroll, width, "")));
    }
    return lines;
  }

  private listNotice(): Notice | undefined {
    if (this.loadError) return { color: "error", text: this.loadError };
    if (!this.sessions) return { color: "muted", text: "Loading sessions…" };
    if (this.searchError) return { color: "error", text: this.searchError };
    if (this.rows.length > 0) return undefined;
    if (this.searching) return { color: "muted", text: "Searching…" };
    if (this.parsed.kind === "empty") {
      return { color: "muted", text: "No sessions in current folder" };
    }
    return { color: "muted", text: "No matches" };
  }

  private renderRow(row: Row, selected: boolean, width: number): string {
    const theme = this.theme;
    const session = row.session;
    const isCurrent = this.currentSessionPath === session.path;
    const age = formatAge(this.now(), session.modified).padStart(3);
    let right = age;
    if (row.match) {
      const { hitCount, capped } = row.match;
      const hits = `${hitCount}${capped ? "+" : ""}`.padStart(4);
      right = `${hits} ${hitCount === 1 ? "hit " : "hits"}  ${age}`;
    }
    const cursor = selected ? theme.fg("accent", "› ") : "  ";
    const availableForTitle = width - 2 - (visibleWidth(right) + 2);
    let title = truncateToWidth(
      sessionTitle(session),
      Math.max(10, availableForTitle),
      "…",
    );
    if (isCurrent) title = theme.fg("accent", title);
    else if (session.name) title = theme.fg("warning", title);
    if (selected) title = theme.bold(title);
    const left = cursor + title;
    const spacing = Math.max(
      1,
      width - visibleWidth(left) - visibleWidth(right),
    );
    const line = truncateToWidth(
      left + " ".repeat(spacing) + theme.fg("dim", right),
      width,
    );
    return selected ? theme.bg("selectedBg", line) : line;
  }

  private renderPreview(width: number): string[] {
    if (this.listNotice()) return [];
    const selected = this.rows[this.selectedIndex]?.match;
    if (!selected || selected.matches.length === 0) return [];
    const lines = selected.matches
      .slice(0, PREVIEW_SNIPPETS)
      .map((match) => this.renderSnippet(match, width));
    const hidden = selected.matches.length - lines.length;
    if (hidden > 0) {
      const indent = " ".repeat(2 + SNIPPET_LABEL_WIDTH + 2);
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth(`${indent}+${hidden} more`, width, ""),
        ),
      );
    }
    while (lines.length < PREVIEW_LINES) lines.push("");
    return lines;
  }

  private renderSnippet(match: DocumentMatch, width: number): string {
    const theme = this.theme;
    const range = match.ranges[0];
    if (!range) return "";
    const snippet = buildSnippet(
      match.document.text,
      range,
      SNIPPET_BEFORE_COLUMNS * 2,
      Math.max(width, 80),
    );
    const label = (match.document.role === "user" ? "you" : "pi").padStart(
      SNIPPET_LABEL_WIDTH,
    );
    const line =
      `  ${theme.fg("dim", label)}  ` +
      theme.fg("muted", alignRight(snippet.before, SNIPPET_BEFORE_COLUMNS)) +
      theme.bold(theme.fg("accent", snippet.match)) +
      theme.fg("muted", snippet.after);
    return truncateToWidth(line, width, "…");
  }

  private moveSelection(delta: number): void {
    if (this.rows.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.rows.length - 1, this.selectedIndex + delta),
    );
    this.requestRender();
  }

  private confirmSelection(): void {
    const path = this.getSelectedSessionPath();
    if (!path) return;
    this.finish(() => this.onSelect(path));
  }

  private finish(callback: () => void): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    callback();
  }

  /** Cancels pending work and schedules a search for the current query. */
  private runSearch(immediate: boolean): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.inFlight?.abort();
    this.inFlight = undefined;
    this.generation++;
    this.searchError = undefined;
    this.searching = false;
    this.truncated = 0;
    const sessions = this.sessions;
    if (!sessions) {
      this.rows = [];
      this.requestRender();
      return;
    }
    if (this.parsed.kind === "empty") {
      this.rows = sessions.map((session) => ({ session }));
      this.clampSelection();
      this.requestRender();
      return;
    }
    const query = this.parsed;
    const generation = this.generation;
    const start = () => {
      this.debounceTimer = undefined;
      this.startSearch(query, sessions, generation);
    };
    if (immediate) start();
    else this.debounceTimer = setTimeout(start, this.debounceMs);
  }

  private startSearch(
    query: ParsedQuery,
    sessions: SessionMeta[],
    generation: number,
  ): void {
    const controller = new AbortController();
    this.inFlight = controller;
    this.searching = true;
    this.requestRender();
    this.search(query, sessions, controller.signal)
      .then((result) => {
        if (generation !== this.generation) return;
        this.rows = result.matches.map((match) => ({
          session: match.session,
          match,
        }));
        this.truncated = result.truncated;
        this.clampSelection();
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.rows = [];
        this.selectedIndex = 0;
        this.searchError = describeError(error);
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.searching = false;
        this.inFlight = undefined;
        this.requestRender();
      });
  }

  private clampSelection(): void {
    this.selectedIndex = Math.max(
      0,
      Math.min(this.selectedIndex, this.rows.length - 1),
    );
  }
}

/** Shared by the listing and search paths so both report rg the same way. */
export function describeError(error: unknown): string {
  if (error instanceof RipgrepUnavailableError) {
    return "ripgrep (rg) is not installed or not on PATH";
  }
  if (error instanceof RipgrepError) {
    return `Invalid pattern: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Search failed: ${message}`;
}

export type ResumeSearchView = SessionSearchView;
export const ResumeSearchView = SessionSearchView;
