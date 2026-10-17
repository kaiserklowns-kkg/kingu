package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kaiserklowns-kkg/kingu/apps/server/internal/db"
)

// NotifyChannel is the PostgreSQL LISTEN/NOTIFY channel written by the
// task/run triggers (payload "<org_id>:<event_id>").
const NotifyChannel = "kingu_events"

const (
	// replayBatch bounds one catch-up query.
	replayBatch = 200
	// maxReplay bounds how far a reconnecting client is replayed before it
	// is told to reload instead (event "reset").
	maxReplay = 2000
	// writeTimeout bounds each SSE write; the stream itself has no deadline.
	sseWriteTimeout = 10 * time.Second
)

// ---- broker: one LISTEN connection fanned out to per-org subscribers ------

type broker struct {
	pool   *pgxpool.Pool
	logger *slog.Logger

	mu   sync.Mutex
	subs map[string]map[chan struct{}]struct{} // org id -> wake channels
}

func newBroker(pool *pgxpool.Pool, logger *slog.Logger) *broker {
	return &broker{pool: pool, logger: logger, subs: map[string]map[chan struct{}]struct{}{}}
}

// subscribe returns a channel that receives a (coalesced) wake-up whenever
// an event for org is committed. The notification carries no data: the
// subscriber reads new rows itself, under RLS, from its last seen id.
func (b *broker) subscribe(org string) (chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	b.mu.Lock()
	if b.subs[org] == nil {
		b.subs[org] = map[chan struct{}]struct{}{}
	}
	b.subs[org][ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs[org], ch)
		if len(b.subs[org]) == 0 {
			delete(b.subs, org)
		}
		b.mu.Unlock()
	}
}

func (b *broker) wake(org string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for o, set := range b.subs {
		if org != "" && o != org {
			continue
		}
		for ch := range set {
			select {
			case ch <- struct{}{}:
			default: // already pending
			}
		}
	}
}

// run holds a dedicated connection in LISTEN until ctx ends, reconnecting
// with backoff. After every (re)connect all subscribers are woken so they
// catch up on anything committed while the listener was down.
func (b *broker) run(ctx context.Context) {
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil {
		err := b.listen(ctx)
		if ctx.Err() != nil {
			return
		}
		b.logger.Warn("event listener disconnected; retrying", "err", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (b *broker) listen(ctx context.Context) error {
	pc, err := b.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// Take the connection out of the pool: LISTEN state must not leak to
	// other users, and it lives as long as the listener.
	conn := pc.Hijack()
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "LISTEN "+NotifyChannel); err != nil {
		return err
	}
	b.wake("")
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		org, _, _ := strings.Cut(n.Payload, ":")
		if _, ok := parseUUID(org); ok {
			b.wake(org)
		}
	}
}

// ---- retention --------------------------------------------------------------

func (s *Server) pruneLoop(ctx context.Context) {
	t := time.NewTicker(s.cfg.PruneInterval)
	defer t.Stop()
	for {
		if n, err := db.PruneEvents(ctx, s.pool); err != nil && ctx.Err() == nil {
			s.logger.Warn("prune org_events failed", "err", err)
		} else if n > 0 {
			s.logger.Info("pruned expired org_events", "rows", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ---- per-credential stream cap ----------------------------------------------

type streamCounter struct {
	mu sync.Mutex
	n  map[string]int
}

func (c *streamCounter) acquire(key string, limit int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n[key] >= limit {
		return false
	}
	c.n[key]++
	return true
}

func (c *streamCounter) release(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n[key]--; c.n[key] <= 0 {
		delete(c.n, key)
	}
}

// ---- GET /v1/events -----------------------------------------------------------

// Event is one entry of the org event feed as sent over SSE.
type Event struct {
	ID        int64           `json:"id"`
	Kind      string          `json:"kind"`
	ProjectID *string         `json:"project_id"`
	TaskID    *string         `json:"task_id"`
	At        time.Time       `json:"at"`
	Data      json.RawMessage `json:"data"`
}

// lastEventID reads the resume point from the Last-Event-ID header (sent by
// EventSource on reconnect) or the last_event_id query parameter.
func lastEventID(r *http.Request) (int64, bool, error) {
	v := r.Header.Get("Last-Event-ID")
	if v == "" {
		v = r.URL.Query().Get("last_event_id")
	}
	if v == "" {
		return 0, false, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		return 0, false, errBadRequest("invalid_input", "Last-Event-ID must be a non-negative integer")
	}
	return n, true, nil
}

// handleEvents streams the caller's org events as Server-Sent Events.
//
//   - New events are pushed as `id: <n>`, `event: <kind>`, `data: <Event JSON>`.
//   - A comment line (`: ping`) is sent every Config.Heartbeat.
//   - With Last-Event-ID, events after that id are replayed first. If that
//     id has already been pruned (or the gap exceeds maxReplay) the server
//     sends `event: reset` and resumes from the newest event; the client
//     should reload its snapshot.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	p, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	resume, hasResume, err := lastEventID(r)
	if err != nil {
		writeError(w, s.toAPIError(r, err))
		return
	}
	if !s.streams.acquire(p.Key, s.cfg.MaxStreams) {
		writeError(w, &apiError{Status: http.StatusTooManyRequests, Code: "too_many_streams",
			Message: fmt.Sprintf("at most %d concurrent event streams per credential", s.cfg.MaxStreams)})
		return
	}
	defer s.streams.release(p.Key)

	ctx := r.Context()
	// Subscribe before reading the starting point so nothing committed in
	// between is missed.
	wake, unsubscribe := s.broker.subscribe(p.OrgID)
	defer unsubscribe()

	var (
		last  int64
		reset bool
	)
	err = db.WithOrg(ctx, s.pool, p.OrgID, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM orgs)`).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errUnknownOrg
		}
		var newest int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(max(id), 0) FROM org_events`).Scan(&newest); err != nil {
			return err
		}
		last = newest
		if !hasResume {
			return nil
		}
		// Replay only when the client's last event is still retained (so
		// nothing between it and now was pruned) and the gap is bounded.
		var retained bool
		var gap int64
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM org_events WHERE id = $1),
			        (SELECT count(*) FROM org_events WHERE id > $1)`, resume).Scan(&retained, &gap); err != nil {
			return err
		}
		if (retained || resume == 0) && gap <= maxReplay {
			last = resume
		} else {
			reset = true
		}
		return nil
	})
	if err != nil {
		writeError(w, s.toAPIError(r, err))
		return
	}

	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-store")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	write := func(chunk string) error {
		_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
		if _, err := w.Write([]byte(chunk)); err != nil {
			return err
		}
		return rc.Flush()
	}
	if err := write("retry: 3000\n: connected\n\n"); err != nil {
		return
	}
	if reset {
		if err := write(fmt.Sprintf("id: %d\nevent: reset\ndata: {\"reason\":\"replay_unavailable\"}\n\n", last)); err != nil {
			return
		}
	}

	catchUp := func() error {
		for {
			var batch []Event
			err := db.WithOrg(ctx, s.pool, p.OrgID, func(tx pgx.Tx) error {
				rows, err := tx.Query(ctx,
					`SELECT id, kind, project_id::text, task_id::text, created_at, payload
					   FROM org_events WHERE id > $1 ORDER BY id LIMIT $2`, last, replayBatch)
				if err != nil {
					return err
				}
				batch, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (Event, error) {
					var e Event
					err := row.Scan(&e.ID, &e.Kind, &e.ProjectID, &e.TaskID, &e.At, &e.Data)
					return e, err
				})
				return err
			})
			if err != nil {
				return err
			}
			for _, e := range batch {
				data, err := json.Marshal(e)
				if err != nil {
					return err
				}
				if err := write(fmt.Sprintf("id: %d\nevent: %s\ndata: %s\n\n", e.ID, e.Kind, data)); err != nil {
					return err
				}
				last = e.ID
			}
			if len(batch) < replayBatch {
				return nil
			}
		}
	}
	if err := catchUp(); err != nil {
		s.logStreamEnd(r, err)
		return
	}

	heartbeat := time.NewTicker(s.cfg.Heartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-wake:
			if err := catchUp(); err != nil {
				s.logStreamEnd(r, err)
				return
			}
		case <-heartbeat.C:
			if err := write(": ping\n\n"); err != nil {
				return
			}
			// Fallback for a missed NOTIFY (listener reconnecting).
			if err := catchUp(); err != nil {
				s.logStreamEnd(r, err)
				return
			}
		}
	}
}

func (s *Server) logStreamEnd(r *http.Request, err error) {
	if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
		return
	}
	s.logger.Warn("event stream ended", "err", err)
}
