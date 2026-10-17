# Kingu

Kingu Studio: an IDE and Agentic Development Environment in one window.

Stack: Tauri v2 (Rust) · Svelte 5 + Tailwind v4 · Go · PostgreSQL · Bun

| Path | What |
| --- | --- |
| `apps/desktop` | Desktop app: SvelteKit (SPA) UI + Tauri shell (`src-tauri/`) |
| `apps/server` | Team server (Go + PostgreSQL): task metadata, tokens, live events |
| `apps/web` | Team dashboard (SvelteKit + adapter-node): live board and run history |

## Develop

Requires Bun, Rust (stable) and Go.

```bash
bun install
bun run dev:desktop   # opens the desktop app
bun run dev:server    # GET http://127.0.0.1:8787/health
bun run dev:web       # team dashboard on http://localhost:5173
bun run check         # svelte-check (desktop + web), cargo check, go vet
```

## Team visibility (server + web, locally)

The team server only ever receives task **metadata** (title, status, branch, agent, model,
+/- line counts, timestamps). Never code, diffs, transcripts or secrets.

1. Start a dev PostgreSQL and the server with `KINGU_DEV=1` (see
   [apps/server/README.md](apps/server/README.md#run-locally)).
2. Mint a token (dev only):
   ```bash
   curl -s -X POST localhost:8787/v1/dev/tokens -H 'Content-Type: application/json' \
     -d '{"org_name":"dev","user_id":"you"}'      # → {"token":"kgu_…", "org_id": …}
   ```
3. Run the dashboard and sign in with the token:
   ```bash
   KINGU_API_URL=http://127.0.0.1:8787 bun run dev:web
   ```
4. Desktop: set `kingu.team.serverUrl` (e.g. `http://localhost:8787`) and `kingu.team.project`
   (a project id from `POST /v1/projects`) in Settings → Team, then run
   **Kingu: Sign in to Team Server**. The token is stored in the macOS Keychain.

See [apps/web/README.md](apps/web/README.md) for the dashboard.
