import { type Static, Type } from "typebox";

export type SearchRole = "user" | "assistant";

export interface SessionScope {
  cwd: string;
  sessionDir: string;
  /** True for a custom session directory, where pi filters by header cwd. */
  filterByCwd: boolean;
}

/** Cheap per-file metadata, enough to render a list row and resume. */
export interface SessionMeta {
  path: string;
  id: string;
  cwd: string;
  /** Display name from the latest session_info entry. */
  name?: string;
  /** First user message, bounded; the row title when there is no name. */
  title: string;
  /**
   * Unix milliseconds of the last user or assistant entry, falling back to
   * the header timestamp and then the file mtime, as pi's listing does.
   */
  modified: number;
}

export interface SessionDocument {
  entryId: string;
  role: SearchRole;
  text: string;
}

export type MatchRange = readonly [start: number, end: number];

export interface DocumentMatch {
  document: SessionDocument;
  ranges: MatchRange[];
}

export interface SessionMatch {
  session: SessionMeta;
  matches: DocumentMatch[];
  /** Occurrences across all matched messages. Not capped by range storage. */
  hitCount: number;
  /** True when the scan window filled up, so these results are incomplete. */
  capped: boolean;
}

// Schemas and types for the agent tool

export const SessionSearchParamsSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Search text or regex (prefix with 're:' for regex, e.g. 're:D[0-9]+'). If omitted, lists recent sessions or reads the specified sessionId.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description:
        "Maximum number of sessions to return. Defaults to 10 (max 50).",
      default: 10,
      minimum: 1,
      maximum: 50,
    }),
  ),
  role: Type.Optional(
    Type.Union(
      [Type.Literal("all"), Type.Literal("user"), Type.Literal("assistant")],
      {
        description: "Filter matches by message role. Defaults to 'all'.",
        default: "all",
      },
    ),
  ),
  sessionId: Type.Optional(
    Type.String({
      description:
        "Optional session ID or file path to scope query to a specific session.",
    }),
  ),
  maxMatchesPerSession: Type.Optional(
    Type.Integer({
      description:
        "Maximum matched messages to return per session. Defaults to 5 (max 20).",
      default: 5,
      minimum: 1,
      maximum: 20,
    }),
  ),
  snippetContext: Type.Optional(
    Type.Integer({
      description:
        "Characters of context before and after each match in snippet. Defaults to 120.",
      default: 120,
    }),
  ),
  includeFullText: Type.Optional(
    Type.Boolean({
      description:
        "Include full message text in matched items instead of just snippets. Defaults to false to conserve tokens.",
      default: false,
    }),
  ),
});

export type SessionSearchParams = Static<typeof SessionSearchParamsSchema>;

export const SnippetItemSchema = Type.Object({
  text: Type.String({
    description:
      "Snippet text containing match marked with brackets '[...]' and surrounded by context.",
  }),
  matchText: Type.String({
    description: "The exact matched text.",
  }),
});

export type SnippetItem = Static<typeof SnippetItemSchema>;

export const SessionMessageMatchSchema = Type.Object({
  entryId: Type.String({
    description: "Message entry ID in the JSONL transcript.",
  }),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  hitCount: Type.Integer({
    description: "Number of keyword occurrences in this message.",
  }),
  snippets: Type.Array(SnippetItemSchema, {
    description: "Contextual snippets around matches.",
  }),
  fullText: Type.Optional(
    Type.String({
      description: "Full message content if includeFullText is true.",
    }),
  ),
});

export type SessionMessageMatch = Static<typeof SessionMessageMatchSchema>;

export const SessionMatchItemSchema = Type.Object({
  id: Type.String({
    description: "Session UUID.",
  }),
  name: Type.Optional(
    Type.String({
      description: "Display name from session_info if available.",
    }),
  ),
  title: Type.String({
    description: "First user message title or fallback.",
  }),
  path: Type.String({
    description: "Path to the session JSONL file.",
  }),
  modifiedAt: Type.String({
    description: "ISO 8601 timestamp of last activity.",
  }),
  hitCount: Type.Integer({
    description: "Total hits in this session.",
  }),
  matches: Type.Array(SessionMessageMatchSchema, {
    description: "Matched messages within this session.",
  }),
});

export type SessionMatchItem = Static<typeof SessionMatchItemSchema>;

export const SessionSearchResultSchema = Type.Object({
  totalSessions: Type.Integer({
    description: "Number of matched sessions returned.",
  }),
  totalHits: Type.Integer({
    description: "Total match occurrences across all returned sessions.",
  }),
  truncated: Type.Boolean({
    description: "Whether results were truncated due to scan limits.",
  }),
  sessions: Type.Array(SessionMatchItemSchema),
});

export type SessionSearchResult = Static<typeof SessionSearchResultSchema>;
