# Kingu team dashboard. Build context: the repository root (it uses the root bun.lock)
#   docker build -f apps/web/Dockerfile -t kingu-web .
FROM oven/bun:1.4-alpine AS build
WORKDIR /repo
# Workspace manifests first so the dependency layer caches; only the dashboard's
# dependencies are installed.
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/agent-host/package.json apps/agent-host/
RUN bun install --frozen-lockfile --filter @kingu/web
COPY apps/web apps/web
RUN cd apps/web && bun run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /repo/apps/web/build ./build
COPY --from=build /repo/apps/web/package.json ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "build"]
