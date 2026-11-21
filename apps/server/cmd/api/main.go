// Command api is the Kingu team server: task sync, auth and audit over PostgreSQL.
package main

import (
	"cmp"
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

	"github.com/jackc/pgx/v5/pgxpool"

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
	flag.StringVar(&m.newOrg, "create-org", "", "create an org with this name, mint an owner token for -mint-token-user, print both and exit")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)
	if err := run(logger, *migrate || *migrateOnly, *migrateOnly, m); err != nil {
		logger.Error("fatal", "err", err)
		os.Exit(1)
	}
}

type mintFlags struct{ org, user, role, newOrg string }

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
		if err := runMigrations(startCtx, logger, pool); err != nil {
			return err
		}
		if migrateOnly {
			logger.Info("migrations complete")
			return nil
		}
	}

	if mint.newOrg != "" {
		if mint.org != "" || mint.user == "" {
			return errors.New("-create-org needs -mint-token-user (the first owner) and no -mint-token-org")
		}
		orgID, err := api.CreateOrg(startCtx, pool, mint.newOrg)
		if err != nil {
			return fmt.Errorf("create org: %w", err)
		}
		t, err := api.MintToken(startCtx, pool, orgID, mint.user, "owner", "cli", 0)
		if err != nil {
			return fmt.Errorf("mint token: %w", err)
		}
		fmt.Println("org_id:", orgID)
		fmt.Println(t.Token)
		return nil
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

	cfg, err := serverConfig(os.Getenv)
	if err != nil {
		return err
	}
	if cfg.Dev {
		logger.Warn("KINGU_DEV=1: X-Kingu-Org header auth and POST /v1/dev/tokens are enabled; never expose this server")
	}
	if cfg.OIDC != nil {
		logger.Info("OIDC sign-in enabled", "issuer", cfg.OIDC.Issuer, "org", cfg.OIDC.OrgID)
	}
	for _, p := range cfg.OIDCProviders {
		logger.Info("OIDC sign-in enabled", "issuer", p.Issuer, "org", p.OrgID)
	}
	var certs *certReloader
	if c, k := os.Getenv("KINGU_TLS_CERT"), os.Getenv("KINGU_TLS_KEY"); c != "" || k != "" {
		if certs, err = newCertReloader(c, k); err != nil {
			return err
		}
	}
	app := api.New(pool, logger, cfg)
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
	if certs != nil {
		srv.TLSConfig = certs.tlsConfig()
	}
	errCh := make(chan error, 1)
	go func() {
		logger.Info("kingu api listening", "addr", addr, "tls", certs != nil,
			"rate_limit_store", cmp.Or(cfg.RateLimitStore, "memory"), "trusted_proxies", len(cfg.TrustedProxies))
		if certs != nil {
			errCh <- srv.ListenAndServeTLS("", "")
		} else {
			errCh <- srv.ListenAndServe()
		}
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

// runMigrations applies migrations over KINGU_MIGRATE_DATABASE_URL when set
// (a role that owns the schema), then grants the serving role (DATABASE_URL)
// only data access. Without it, the serving role runs them itself.
func runMigrations(ctx context.Context, logger *slog.Logger, serving *pgxpool.Pool) error {
	dsn := os.Getenv("KINGU_MIGRATE_DATABASE_URL")
	if dsn == "" {
		return db.Migrate(ctx, serving, logger)
	}
	owner, err := db.Open(ctx, dsn)
	if err != nil {
		return fmt.Errorf("migration database: %w", err)
	}
	defer owner.Close()
	if err := db.Migrate(ctx, owner, logger); err != nil {
		return err
	}
	role, err := db.CurrentRole(ctx, serving)
	if err != nil {
		return err
	}
	if err := db.GrantApp(ctx, owner, role); err != nil {
		return fmt.Errorf("grant serving role %q: %w", role, err)
	}
	logger.Info("granted data access to the serving role", "role", role)
	return nil
}
