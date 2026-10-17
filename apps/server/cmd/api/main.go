// Command api is the Kingu team server: task sync, auth and audit over PostgreSQL.
package main

import (
	"log/slog"
	"net/http"
	"os"
)

func main() {
	addr := os.Getenv("KINGU_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8787"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	slog.Info("kingu api listening", "addr", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
