// Command api is the Kingu team server: task sync, auth and audit over PostgreSQL.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/api"
	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

func main() {
	migrate := flag.Bool("migrate", false, "apply pending database migrations before serving")
	migrateOnly := flag.Bool("migrate-only", false, "apply pending database migrations and exit")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)
	if err := run(logger, *migrate || *migrateOnly, *migrateOnly); err != nil {
		logger.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger, migrate, migrateOnly bool) error {
	addr := os.Getenv("KINGU_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8787"
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := db.Open(startCtx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()

	// RLS is the tenant boundary; a superuser/BYPASSRLS role would silently
	// see every org's data.
	if err := db.CheckRole(startCtx, pool); err != nil {
		return err
	}
	if migrate {
		if err := db.Migrate(startCtx, pool, logger); err != nil {
			return err
		}
		if migrateOnly {
			logger.Info("migrations complete")
			return nil
		}
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           api.New(pool, logger).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	errCh := make(chan error, 1)
	go func() {
		logger.Info("kingu api listening", "addr", addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	return srv.Shutdown(shutdownCtx)
}
