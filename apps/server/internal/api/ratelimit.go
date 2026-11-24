package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// limiter takes one token for key, or says how long until one is available.
type limiter interface {
	allow(ctx context.Context, key string) (bool, time.Duration)
}

// rateLimiter is an in-memory token bucket per key (one key per credential).
// Each bucket holds up to burst tokens and refills at rate tokens/second.
//
// In-memory means per replica: with N replicas a client gets up to N times
// the budget. pgLimiter shares the buckets through PostgreSQL instead.
type rateLimiter struct {
	rate  float64
	burst float64
	now   func() time.Time

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter(rate float64, burst int) *rateLimiter {
	return &rateLimiter{rate: rate, burst: float64(burst), now: time.Now, buckets: map[string]*bucket{}}
}

// allow takes one token for key. When the bucket is empty it returns false
// and how long until a token is available.
func (l *rateLimiter) allow(_ context.Context, key string) (bool, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(now)
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed*l.rate)
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	return false, wait
}

// sweep drops buckets that have been full (idle) for a while, so memory stays
// bounded by the number of recently active credentials.
func (l *rateLimiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < time.Minute {
		return
	}
	l.lastSweep = now
	idle := time.Duration(l.burst/l.rate*float64(time.Second)) + time.Minute
	for k, b := range l.buckets {
		if now.Sub(b.last) > idle {
			delete(l.buckets, k)
		}
	}
}

// pgLimiter keeps the buckets in the rate_limits table, so all replicas share
// them. Each check is one atomic UPSERT (the row lock serialises concurrent
// requests for a key). If the database errors, it falls back to an in-memory
// bucket for that replica rather than failing the request.
type pgLimiter struct {
	pool     *pgxpool.Pool
	name     string
	rate     float64
	burst    float64
	fallback *rateLimiter
	logger   *slog.Logger

	mu       sync.Mutex
	lastWarn time.Time
}

func newPGLimiter(pool *pgxpool.Pool, logger *slog.Logger, name string, rate float64, burst int) *pgLimiter {
	return &pgLimiter{pool: pool, name: name, rate: rate, burst: float64(burst),
		fallback: newRateLimiter(rate, burst), logger: logger}
}

// limiterKey namespaces key by limiter and hashes long keys (OIDC subjects)
// to fit the column.
func limiterKey(name, key string) string {
	k := name + ":" + key
	if len(k) <= 200 {
		return k
	}
	sum := sha256.Sum256([]byte(key))
	return name + ":h:" + hex.EncodeToString(sum[:])
}

// The refill x = min(burst, tokens + elapsed*rate) appears three times so the
// statement stays a single UPSERT; a new key starts with a full bucket.
const pgAllowSQL = `
INSERT INTO rate_limits AS r (key, tokens, allowed, updated_at)
VALUES ($1, $3 - 1, true, clock_timestamp())
ON CONFLICT (key) DO UPDATE SET
    tokens = CASE
        WHEN LEAST($3, r.tokens + GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - r.updated_at)) * $2) >= 1
        THEN LEAST($3, r.tokens + GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - r.updated_at)) * $2) - 1
        ELSE LEAST($3, r.tokens + GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - r.updated_at)) * $2)
    END,
    allowed = LEAST($3, r.tokens + GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - r.updated_at)) * $2) >= 1,
    updated_at = clock_timestamp()
RETURNING allowed, tokens`

func (l *pgLimiter) allow(ctx context.Context, key string) (bool, time.Duration) {
	var (
		ok     bool
		tokens float64
	)
	err := l.pool.QueryRow(ctx, pgAllowSQL, limiterKey(l.name, key), l.rate, l.burst).Scan(&ok, &tokens)
	if err != nil {
		if ctx.Err() == nil {
			l.warn(err)
		}
		return l.fallback.allow(ctx, key)
	}
	if ok {
		return true, 0
	}
	return false, time.Duration((1 - tokens) / l.rate * float64(time.Second))
}

func (l *pgLimiter) warn(err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if time.Since(l.lastWarn) < time.Minute {
		return
	}
	l.lastWarn = time.Now()
	l.logger.Warn("shared rate limit unavailable; using this replica's memory", "limiter", l.name, "err", err)
}

// pruneRateLimits deletes buckets idle for an hour (every bucket is full again
// long before that).
func pruneRateLimits(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, `DELETE FROM rate_limits WHERE updated_at < now() - interval '1 hour'`)
	return tag.RowsAffected(), err
}
