# Kingu team dashboard (`apps/web`)

SvelteKit app (adapter-node) that shows a team's task board live and the agent run history,
read from the Kingu team server (`apps/server`). Metadata only: no code, diffs or secrets.

- **Login** (`/login`): paste a personal access token (`kgu_…`). A SvelteKit form action checks it
  against `GET /v1/me` and stores it in an `httpOnly`, `SameSite=Strict` cookie (`Secure` over
  HTTPS). It is never put in localStorage and never reaches browser JavaScript.
- **Board** (`/`): columns รอคุณ (needs input / review / failed), กำลังทำ (backlog / running) and
  เสร็จแล้ว (done). Cards show title, status, branch, agent · model, +/- lines, owner and time ago.
  Live updates come from `GET /api/events`, a same-origin proxy of the server's SSE stream
  (`/v1/events`) to which this server adds the bearer token. Changes are announced through an
  `aria-live` region. The reducer is in `src/lib/board.ts` and tested in `src/lib/board.test.ts`.
- **Run history** (`/runs`): the latest agent runs (`GET /v1/runs`).

Styling reuses Kingu's VS Code Dark Modern `--vscode-*` tokens (`src/lib/theme.css`, copied from
`apps/desktop/src/lib/workbench/theme.css`). Labels are Thai-first; the layout works at phone width.

## Run locally

Start the team server first (see `apps/server/README.md`), then:

```sh
# from the repo root
bun install
KINGU_API_URL=http://127.0.0.1:8787 bun run dev:web     # http://localhost:5173
```

| Env var | Default | Notes |
| --- | --- | --- |
| `KINGU_API_URL` | `http://127.0.0.1:8787` | Team server base URL. Only this server process calls it. |

## Production build

```sh
bun --cwd apps/web run build
KINGU_API_URL=https://team.example.com PORT=3000 node apps/web/build
```

Serve it behind TLS. adapter-node assumes `https` for the request origin (used by SvelteKit's
CSRF check on the login form). To test the built app over plain HTTP locally, start it with
`PROTOCOL_HEADER=x-forwarded-proto` and send `X-Forwarded-Proto: http`, or use `bun run dev`.

## Checks

```sh
bun --cwd apps/web run check   # svelte-check
bun --cwd apps/web run test    # bun test (board reducer)
bun --cwd apps/web run build
```
