import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  getSessionDatabase,
  listRecentSessionsFromDb,
  syncDatabase,
} from "./db";
import { searchSessions } from "./search";
import { defaultSessionDir, listSessions } from "./sessions";
import type { SessionScope } from "./types";
import { SessionSearchView } from "./ui";

/** Short for "resume with search": the same flow as /resume, plus content search. */
export const COMMAND_NAME = "rs";

/** Scope rules match pi's /resume "current folder" listing. */
export function scopeFromContext(ctx: ExtensionCommandContext): SessionScope {
  const cwd = ctx.sessionManager.getCwd();
  const fallback = defaultSessionDir(cwd);
  // In-memory sessions (--no-session) report an empty directory; pi's own
  // listing treats that as the default directory.
  const sessionDir = ctx.sessionManager.getSessionDir() || fallback;
  return {
    cwd,
    sessionDir,
    filterByCwd: sessionDir !== fallback,
  };
}

export function registerResumeSearch(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description:
      "Resume a session found by searching its user and assistant messages",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${COMMAND_NAME} requires interactive mode`, "error");
        return;
      }
      const scope = scopeFromContext(ctx);
      const currentSessionPath = ctx.sessionManager.getSessionFile();

      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
          let db: ReturnType<typeof getSessionDatabase> | undefined;
          try {
            db = getSessionDatabase(scope.sessionDir);
          } catch {
            db = undefined;
          }

          const listing = new AbortController();
          const view = new SessionSearchView({
            theme,
            keybindings,
            search: (query, sessions, signal) =>
              searchSessions(query, { sessions, signal, db }),
            initialQuery: args.trim(),
            currentSessionPath,
            requestRender: () => tui.requestRender(),
            onSelect: (path) => {
              listing.abort();
              done(path);
            },
            onCancel: () => {
              listing.abort();
              done(undefined);
            },
          });

          // 1. Immediately populate from SQLite cache if available (< 1ms)
          let hasCached = false;
          if (db) {
            try {
              const cached = listRecentSessionsFromDb(
                db,
                undefined,
                scope.filterByCwd,
                scope.cwd,
              );
              if (cached.length > 0) {
                view.setSessions(cached);
                hasCached = true;
              }
            } catch {
              // ignore cache read failure
            }
          }

          // 2. Perform sync asynchronously in the background so UI opens with 0ms freeze
          setTimeout(() => {
            if (listing.signal.aborted) return;
            if (db) {
              try {
                syncDatabase(db, scope);
                const fresh = listRecentSessionsFromDb(
                  db,
                  undefined,
                  scope.filterByCwd,
                  scope.cwd,
                );
                view.setSessions(fresh);
              } catch {
                if (!hasCached) {
                  listSessions(scope, { signal: listing.signal })
                    .then((sessions) => view.setSessions(sessions))
                    .catch((error: unknown) => {
                      if (listing.signal.aborted) return;
                      view.setLoadError(error);
                    });
                }
              }
            } else {
              listSessions(scope, { signal: listing.signal })
                .then((sessions) => view.setSessions(sessions))
                .catch((error: unknown) => {
                  if (listing.signal.aborted) return;
                  view.setLoadError(error);
                });
            }
          }, 0);

          return view;
        },
      );

      if (!selected) return;
      if (currentSessionPath && selected === currentSessionPath) {
        ctx.ui.notify("Already in this session", "info");
        return;
      }
      const result = await ctx.switchSession(selected);
      if (result.cancelled) {
        ctx.ui.notify("Session switch was cancelled", "warning");
      }
    },
  });
}
