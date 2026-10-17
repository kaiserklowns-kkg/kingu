package api

import (
	"math"
	"sync"
	"time"
)

// rateLimiter is an in-memory token bucket per key (one key per credential).
// Each bucket holds up to burst tokens and refills at rate tokens/second.
//
// In-memory means per replica: with N replicas a client gets up to N times
// the budget. TODO(ops): move to a shared store if that matters.
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
func (l *rateLimiter) allow(key string) (bool, time.Duration) {
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
