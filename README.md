# Kingu

Kingu Studio: an IDE and Agentic Development Environment in one window.

Stack: Tauri v2 (Rust) · Svelte 5 + Tailwind v4 · Go · PostgreSQL · Bun

| Path | What |
| --- | --- |
| `apps/desktop` | Desktop app: SvelteKit (SPA) UI + Tauri shell (`src-tauri/`) |
| `apps/server` | Team server (Go) |

## Develop

Requires Bun, Rust (stable) and Go.

```bash
bun install
bun run dev:desktop   # opens the desktop app
bun run dev:server    # GET http://127.0.0.1:8787/health
bun run check         # svelte-check, cargo check, go vet
```
