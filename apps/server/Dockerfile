# Kingu team server. Build context: apps/server
#   docker build -t kingu-api apps/server
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# Static binary, no shell, runs as uid 65532.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api
ENV KINGU_API_ADDR=0.0.0.0:8787
EXPOSE 8787
USER nonroot:nonroot
ENTRYPOINT ["/api"]
