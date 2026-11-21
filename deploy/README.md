# Deploying the Kingu team server

`docker-compose.yml` runs the whole team side on one machine:

| Service | What it does |
|---------|--------------|
| `db` | PostgreSQL 16. On first start, `initdb/01-roles.sh` creates two roles: `kingu_owner` (owns the schema, runs migrations) and `kingu_app` (serves the API; data access only). Neither may bypass row-level security. |
| `migrate` | One-shot job: `api -migrate-only` with `KINGU_MIGRATE_DATABASE_URL` set to the owner role, then grants `kingu_app` read/write on the tables. It runs on every `up`, so upgrades migrate before the new API starts. |
| `api` | The team server (`apps/server`) as `kingu_app`. Rate limits live in PostgreSQL (`KINGU_RATE_LIMIT_STORE=postgres`), so you can scale it: `docker compose up -d --scale api=3`. |
| `web` | The dashboard (`apps/web`). |
| `caddy` | HTTPS for both hostnames (certificates from Let's Encrypt/ZeroSSL, renewed automatically), HTTP → HTTPS redirects, and streaming for Server-Sent Events. |

## First start

```sh
cp deploy/.env.example deploy/.env      # set hostnames and three passwords (openssl rand -hex 32)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build

# Create the org and its first owner; prints the org id and the owner's token.
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm api -create-org "Acme" -mint-token-user alice@acme.com
```

Sign in at `https://$KINGU_WEB_HOST` with that token, add teammates on **Members**, and give each
a token (or turn on SSO). In the desktop app, set the team server to `https://$KINGU_API_HOST`.

DNS for both hostnames must point at the machine, and ports 80 and 443 must be reachable for
certificates to be issued.

## SSO

Register an OAuth/OIDC client at your identity provider with the redirect URI
`https://$KINGU_WEB_HOST/login/callback`, then set `KINGU_OIDC_ISSUER`, `KINGU_OIDC_CLIENT_ID`,
`KINGU_OIDC_CLIENT_SECRET` (if the client is confidential) and `KINGU_OIDC_ORG` (the org id
printed above) in `.env` and run `up -d` again. People are matched by verified email, so add them on
Members first.

## Without Docker

- **TLS on the API itself:** `KINGU_TLS_CERT` and `KINGU_TLS_KEY` (PEM files). A renewed pair is
  picked up within a minute, no restart needed.
- **Behind your own proxy or load balancer:** list its addresses in `KINGU_TRUSTED_PROXIES`
  (comma-separated IPs or CIDRs) so failed sign-ins are limited per real client, and run the
  dashboard with `PROTOCOL_HEADER=x-forwarded-proto HOST_HEADER=x-forwarded-host`. Disable response
  buffering for `/v1/events` (nginx: `proxy_buffering off;`).
- **Several API replicas:** `KINGU_RATE_LIMIT_STORE=postgres`.
- **Separate migration role:** run `api -migrate-only` with `KINGU_MIGRATE_DATABASE_URL` (owner) and
  `DATABASE_URL` (serving role); it grants the serving role what it needs after migrating.

## Backups

All state is in PostgreSQL (`pgdata` volume). For example:

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T db pg_dump -U postgres -Fc kingu > kingu-$(date +%F).dump
```
