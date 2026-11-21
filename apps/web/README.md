# Kingu team dashboard (`apps/web`)

SvelteKit app (adapter-node) that shows a team's task board live and the agent run history,
read from the Kingu team server (`apps/server`). Metadata only: no code, diffs or secrets.

- **Login** (`/login`): sign in with SSO when configured (below), or paste a personal access token (`kgu_…`). A SvelteKit form action checks it
  against `GET /v1/me` and stores it in an `httpOnly`, `SameSite=Strict` cookie (`Secure` over
  HTTPS). It is never put in localStorage and never reaches browser JavaScript.
- **Board** (`/`): columns รอคุณ (needs input / review / failed), กำลังทำ (backlog / running) and
  เสร็จแล้ว (done). Cards show title, status, branch, agent · model, +/- lines, owner and time ago.
  Live updates come from `GET /api/events`, a same-origin proxy of the server's SSE stream
  (`/v1/events`) to which this server adds the bearer token. Changes are announced through an
  `aria-live` region. The reducer is in `src/lib/board.ts` and tested in `src/lib/board.test.ts`.
- **Task** (`/tasks/{id}`, from a board card): its metadata and runs; members edit title, status and
  branch, owners/leads delete it. Deletions reach open boards through the `task.deleted` event.
- **Projects** (`/projects`): owners/leads create and edit; owners delete (type the name to confirm).
  A project's name opens the board filtered to it (`/?project=<id>`).
- **Run history** (`/runs`): the latest agent runs (`GET /v1/runs`). A run still open (its desktop
  crashed or went offline) can be closed by its creator or an owner/lead.
- **Members** (`/members`): everyone in the org and their role. Owners manage anyone; leads add,
  change and remove dev/viewer members. Owners can create a token for a member and hand it over.
- **Tokens** (`/tokens`): your personal access tokens (owners: everyone's). Create one per machine
  and revoke it there; revoking the token this session uses signs you out. A new token is shown
  once, in the form response; the server keeps only its hash.
- **Audit log** (`/audit`, owners and leads): every change in the org, filtered by type or person.

The pages only hide controls; the team server enforces every role rule.

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
| `KINGU_OIDC_ISSUER` | unset | Shows "เข้าสู่ระบบด้วย SSO". Same issuer as the team server. |
| `KINGU_OIDC_CLIENT_ID` | unset | OAuth client id (same as the team server's). |
| `KINGU_OIDC_CLIENT_SECRET` | unset | For confidential clients (sent with HTTP Basic). PKCE is used either way. |
| `KINGU_OIDC_PROVIDERS` | unset | More identity providers, one button each: JSON array of `{"id","name","issuer","client_id","client_secret"}` (`id`: a-z, 0-9, `-`). Each issuer must also be in the team server's `KINGU_OIDC_PROVIDERS`, which maps it to an org. The single provider above is id `sso`. |

**SSO:** register `https://<dashboard>/login/callback` as the redirect URI at the identity
provider. `/login/sso` starts an authorization-code flow with PKCE (state, nonce and verifier in a
10-minute httpOnly cookie); `/login/callback` checks state and nonce, then trades the ID token at
`POST /v1/auth/session` for a 12-hour Kingu token in the usual cookie, which expires with that token (a personal token's cookie lasts 30 days). The ID token is not kept.
People must be added on the Members page (by their email) before their first sign-in.

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
