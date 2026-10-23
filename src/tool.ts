import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  getSessionDatabase,
  listRecentSessionsFromDb,
  searchSessionsBM25,
  syncDatabase,
} from "./db";
import { formatSearchResult, parseQuery, searchSessions } from "./search";
import { readSessionDocuments, resolveSessionScope } from "./sessions";
import {
  type SessionMatchItem,
  type SessionMessageMatch,
  SessionSearchParamsSchema,
  type SessionSearchResult,
} from "./types";

function formatMarkdownSummary(result: SessionSearchResult): string {
  if (result.totalSessions === 0) {
    return "No matching sessions found.";
  }

  const lines: string[] = [
    `Found ${result.totalHits} hit(s) across ${result.totalSessions} session(s)${
      result.truncated ? " (truncated by scan cap)" : ""
    }:`,
    "",
  ];

  for (const session of result.sessions) {
    const dateStr = session.modifiedAt.slice(0, 10);
    const namePart = session.name ? ` [${session.name}]` : "";
    lines.push(`### ${session.title}${namePart}`);
    lines.push(
      `- ID: \`${session.id}\` | Date: ${dateStr} | Hits: ${session.hitCount}`,
    );

    if (session.matches.length > 0) {
      for (const m of session.matches) {
        for (const s of m.snippets) {
          lines.push(`  - \`[${m.role}]\` ${s.text}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export const sessionSearchTool: ToolDefinition<
  typeof SessionSearchParamsSchema
> = {
  name: "session_search",
  label: "Search Sessions",
  description:
    "Search historical session transcripts in the current repository (.pi/sessions) with SQLite FTS5 BM25 ranking (or regex with 're:'). If query is omitted, lists recent sessions. Returns structured JSON with session metadata and contextual snippets around matches. Fully typed for codemode scripts.",
  parameters: SessionSearchParamsSchema,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const configuredDir = ctx.sessionManager?.getSessionDir?.();
    const scope = resolveSessionScope(ctx.cwd, configuredDir);

    const db = getSessionDatabase(scope.sessionDir);
    syncDatabase(db, scope);

    const limit = params.limit ?? 10;
    const maxMatches = params.maxMatchesPerSession ?? 5;
    const snippetContext = params.snippetContext ?? 120;
    const includeFullText = params.includeFullText ?? false;
    const parsedQuery = parseQuery(params.query ?? "");

    let result: SessionSearchResult;

    if (parsedQuery.kind === "regex") {
      const allSessions = listRecentSessionsFromDb(
        db,
        1000,
        scope.filterByCwd,
        scope.cwd,
      );
      let targetSessions = allSessions;
      if (params.sessionId) {
        const qId = params.sessionId.trim().toLowerCase();
        targetSessions = allSessions.filter(
          (s) =>
            s.id.toLowerCase() === qId || s.path.toLowerCase().includes(qId),
        );
      }

      const searchOutcome = await searchSessions(parsedQuery, {
        sessions: targetSessions,
        signal,
      });

      result = formatSearchResult(
        searchOutcome.matches,
        searchOutcome.truncated > 0,
        {
          limit,
          maxMatchesPerSession: maxMatches,
          snippetContext,
          includeFullText,
        },
      );
    } else if (parsedQuery.kind === "literal") {
      result = searchSessionsBM25(db, {
        query: parsedQuery.needle,
        roleFilter: params.role ?? "all",
        sessionId: params.sessionId,
        limit,
        maxMatchesPerSession: maxMatches,
        snippetContext,
        includeFullText,
      });
    } else {
      if (params.sessionId) {
        const allSessions = listRecentSessionsFromDb(
          db,
          1000,
          scope.filterByCwd,
          scope.cwd,
        );
        const qId = params.sessionId.trim().toLowerCase();
        const sessionMeta = allSessions.find(
          (s) =>
            s.id.toLowerCase() === qId || s.path.toLowerCase().includes(qId),
        );

        if (sessionMeta) {
          const docs = await readSessionDocuments(
            sessionMeta.path,
            params.role ?? "all",
            maxMatches,
          );

          const matches: SessionMessageMatch[] = docs.map((doc) => {
            const previewText = doc.text.slice(0, snippetContext * 2);
            const resMatch: SessionMessageMatch = {
              entryId: doc.entryId,
              role: doc.role,
              hitCount: 1,
              snippets: [
                {
                  text:
                    previewText.length < doc.text.length
                      ? `${previewText} ...`
                      : previewText,
                  matchText: "",
                },
              ],
            };
            if (includeFullText) {
              resMatch.fullText = doc.text;
            }
            return resMatch;
          });

          const sessionItem: SessionMatchItem = {
            id: sessionMeta.id,
            name: sessionMeta.name,
            title: sessionMeta.title,
            path: sessionMeta.path,
            modifiedAt: new Date(sessionMeta.modified).toISOString(),
            hitCount: matches.length,
            matches,
          };

          result = {
            totalSessions: 1,
            totalHits: matches.length,
            truncated: false,
            sessions: [sessionItem],
          };
        } else {
          result = {
            totalSessions: 0,
            totalHits: 0,
            truncated: false,
            sessions: [],
          };
        }
      } else {
        const chosen = listRecentSessionsFromDb(
          db,
          limit,
          scope.filterByCwd,
          scope.cwd,
        );
        const sessions: SessionMatchItem[] = chosen.map((s) => ({
          id: s.id,
          name: s.name,
          title: s.title,
          path: s.path,
          modifiedAt: new Date(s.modified).toISOString(),
          hitCount: 0,
          matches: [],
        }));

        result = {
          totalSessions: sessions.length,
          totalHits: 0,
          truncated: false,
          sessions,
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: formatMarkdownSummary(result),
        },
      ],
      details: result,
      structuredContent: result,
    };
  },
};

export function registerSessionSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(sessionSearchTool);
}
