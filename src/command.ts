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

      let db: ReturnType<typeof getSessionDatabase> | undefined;
      try {
        db = getSessionDatabase(scope.sessionDir);
        syncDatabase(db, scope);
      } catch {
        // Fallback to purely ripgrep if SQLite fails
        db = undefined;
      }

      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
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

          if (db) {
            try {
              const sessions = listRecentSessionsFromDb(
                db,
                undefined,
                scope.filterByCwd,
                scope.cwd,
              );
              view.setSessions(sessions);
            } catch (_err) {
              listSessions(scope, { signal: listing.signal })
                .then((sessions) => view.setSessions(sessions))
                .catch((error: unknown) => {
                  if (listing.signal.aborted) return;
                  view.setLoadError(error);
                });
            }
          } else {
            listSessions(scope, { signal: listing.signal })
              .then((sessions) => view.setSessions(sessions))
              .catch((error: unknown) => {
                if (listing.signal.aborted) return;
                view.setLoadError(error);
              });
          }
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
