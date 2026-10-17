// Package db owns the PostgreSQL connection pool, schema migrations and the
// org-scoped transaction helper that drives Row-Level Security.
package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/kaiserklowns-kkg/kingu/apps/server/migrations"
)

// Open creates a pgx pool for dsn and verifies connectivity.
func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// Migrate applies all pending embedded migrations over the pool.
func Migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		return fmt.Errorf("goose provider: %w", err)
	}
	results, err := provider.Up(ctx)
	if err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	for _, r := range results {
		logger.Info("migration applied", "version", r.Source.Version, "path", r.Source.Path, "duration", r.Duration)
	}
	return nil
}

// ErrRLSBypass is returned by CheckRole when the connected role would ignore
// Row-Level Security policies.
var ErrRLSBypass = errors.New("database role bypasses row-level security (superuser or BYPASSRLS); connect as an ordinary role")

// CheckRole refuses roles for which RLS policies are not enforced.
func CheckRole(ctx context.Context, pool *pgxpool.Pool) error {
	var bypass bool
	err := pool.QueryRow(ctx,
		`SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&bypass)
	if err != nil {
		return fmt.Errorf("inspect current role: %w", err)
	}
	if bypass {
		return ErrRLSBypass
	}
	return nil
}

// WithOrg runs fn inside a transaction whose app.org_id setting is orgID, so
// every statement in fn is filtered by the org_isolation RLS policies. The
// setting is transaction-local (set_config(..., true)) and therefore cannot
// leak to the next user of the pooled connection.
func WithOrg(ctx context.Context, pool *pgxpool.Pool, orgID string, fn func(pgx.Tx) error) error {
	return pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.org_id', $1, true)`, orgID); err != nil {
			return fmt.Errorf("set app.org_id: %w", err)
		}
		return fn(tx)
	})
}

// EventRetention is how long org_events rows are kept. It mirrors the
// retention_prune_* policies in migrations/0002_team_sync.sql, which are what
// actually bound the deletion.
const EventRetention = 72 * time.Hour

// PruneEvents deletes org_events older than EventRetention across all orgs.
// It enables the retention policies with the transaction-local
// app.prune_events setting; those policies only ever expose expired rows.
func PruneEvents(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var n int64
	err := pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.prune_events', 'on', true)`); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM org_events WHERE created_at < now() - $1::interval`,
			fmt.Sprintf("%d seconds", int64(EventRetention.Seconds())))
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
		return nil
	})
	return n, err
}
