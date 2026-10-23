# pi-session-search

Full-text session search and resume for **Pi** and **Agents**, backed by SQLite FTS5 with Okapi BM25 ranking.

Provides both:
1. **`/rs` Command**: An interactive picker for humans to search session transcripts with instant as-you-type response and resume the right session.
2. **`session_search` Tool**: An extension tool for AI agents to search past session transcripts with BM25 relevance ranking and contextual snippets.

---

## Features

- **Okapi BM25 Relevance**: Ranks sessions by term frequency saturation and document length normalization, so the most relevant conversations appear first.
- **Sub-millisecond Search**: Powered by SQLite FTS5 with bi-gram CJK tokenization; typing in the picker responds in `< 2ms` even over hundreds of session files.
- **Zero External Dependencies**: Built entirely on Node 22.5+ standard `node:sqlite`. Zero native C build steps, zero npm runtime dependencies.
- **Self-Healing Derived Cache**: The index (`.session-search.db`) lives inside the session directory, updates incrementally by file `mtime`, and can be deleted at any time without data loss.
- **CJK Bi-Gram Tokenization**: Combines `Intl.Segmenter` with adjacent Han character bi-grams to eliminate false-positive substring matches in Chinese text.
- **Regex Fallback**: Supports `re:<pattern>` with ripgrep syntax for exact pattern matching when needed.

---

## Install

Install directly from Git into Pi:

```sh
pi install git:github.com/Sukitly/pi-session-search
```

Or from a local checkout:

```sh
pi install /path/to/pi-session-search
```

Or add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/Sukitly/pi-session-search"
  ]
}
```

Or try it without installing:

```sh
pi -e /path/to/pi-session-search
```

---

## Usage

### Interactive Command (`/rs`)

```
/rs            open the picker with every session in the current project, newest first
/rs <query>    open it with a query already applied
```

- Type to search. The list and the preview update instantly as you type.
- `re:<pattern>` switches to regex mode (ripgrep syntax).
- `↑` `↓` move between sessions, `Enter` resumes the selected session, `Esc` cancels.
- The preview shows matching messages of the selected session with query terms highlighted.

### Agent Tool (`session_search`)

When installed, AI agents can search historical session transcripts programmatically via the `session_search` tool:

```json
{
  "query": "SQLite FTS5",
  "limit": 5
}
```

Returns structured JSON with hit counts, timestamps, and contextual snippets (`[matchText]`).

---

## What is Searched

- The same sessions `/resume` shows for the current folder: the project's session directory. With a custom `--session-dir`, sessions are filtered by the cwd in their header, as pi does. Rows are ordered by BM25 relevance score when searching, or by last activity when query is empty.
- User and assistant message text only. Thinking blocks, tool calls, tool results, compaction summaries, and extension messages are never matched.
- Every message in the file, including messages left on branches you navigated away from with `/fork` or `/tree`.
- Search is read-only. Session files are never modified and nothing is sent anywhere.

---

## Architecture & Caching

- When you search in a project, a local SQLite FTS5 database (`.session-search.db`) is initialized inside that project's session directory.
- **Incremental Sync**: Before each query, file timestamps (`mtime`) are checked. Only added or modified `.jsonl` files are re-indexed (< 1ms when unchanged).
- **Stateless & Derived**: The database is purely a local build artifact. It is never committed to Git and can be deleted at any time; it will automatically rebuild on the next search.

---

## Requirements

- **Node.js >= 22.5.0** (provides built-in `node:sqlite`).
- Pi in interactive mode.
- ripgrep (`rg`) on `PATH` (optional, only needed for `re:` regex queries).

---

## Performance

Measured on a project with 327 sessions totalling ~210 MB of JSONL:

| Action | Time |
| --- | --- |
| Initial full index build (327 files) | ~1.9 s (one-off) |
| Open picker (list all sessions) | < 2 ms |
| Keyword search (`useEffect`, `网吧`) | 1 ~ 2 ms |
| Incremental sync check (no changes) | < 1 ms |
| Regex fallback query (`re:D[0-9]+`) | ~100 ms |

---

## Development

Requires Bun and Pi.

```sh
bun install --ignore-scripts
bun run lint      # TypeScript and Biome checks
bun run test      # Vitest unit tests
bun run format    # Apply Biome fixes
```

Entry point: `extensions/pi-session-search.ts`. Implementation in `src/`:
- `db.ts`: SQLite FTS5 inverted index, Bi-gram tokenization & BM25 ranking.
- `tool.ts`: Agent `session_search` tool definition.
- `command.ts`: `/rs` command registration and controller.
- `ui.ts`: Interactive TUI picker component.
- `search.ts`: Query parsing and ripgrep fallback.
- `sessions.ts`: Session directory and header resolution.

---

## License

MIT
