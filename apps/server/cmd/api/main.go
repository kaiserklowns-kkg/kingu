// Command api is the Kingu team server: task sync, auth and audit over PostgreSQL.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
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
	var m mintFlags
	flag.StringVar(&m.org, "mint-token-org", "", "mint a personal access token for this org uuid, print it and exit")
	flag.StringVar(&m.user, "mint-token-user", "", "user id for -mint-token-org (added as a member if needed)")
	flag.StringVar(&m.role, "mint-token-role", "dev", "member role for a new member: owner|lead|dev|viewer")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)
	if err := run(logger, *migrate || *migrateOnly, *migrateOnly, m); err != nil {
		logger.Error("fatal", "err", err)
		os.Exit(1)
	}
}

type mintFlags struct{ org, user, role string }

func run(logger *slog.Logger, migrate, migrateOnly bool, mint mintFlags) error {
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

	if mint.org != "" || mint.user != "" {
		if mint.org == "" || mint.user == "" {
			return errors.New("-mint-token-org and -mint-token-user must be given together")
		}
		t, err := api.MintToken(startCtx, pool, mint.org, mint.user, mint.role, "cli", 0)
		if err != nil {
			return fmt.Errorf("mint token: %w", err)
		}
		// The plaintext token is printed once and never stored.
		fmt.Println(t.Token)
		return nil
	}

	dev := os.Getenv("KINGU_DEV") == "1"
	if dev {
		logger.Warn("KINGU_DEV=1: X-Kingu-Org header auth and POST /v1/dev/tokens are enabled; never expose this server")
	}
	app := api.New(pool, logger, api.Config{Dev: dev})
	app.Start(ctx)

	srv := &http.Server{
		Addr:    addr,
		Handler: app.Handler(),
		// WriteTimeout applies to ordinary responses; the SSE handler extends
		// its write deadline per event via http.ResponseController.
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
