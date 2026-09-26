package main

import (
	"context"
	"log"
	"sync"
	"time"
)

// Signing out ends every session and game ticket issued before that moment, on this device
// and any other. Tokens are stateless ("<id>.<expiry>.<mac>"), so each user has a "sessions
// valid after" time (users.sessions_after) and a token issued before it is refused.
//
// Checking is memory only: the few users who ever signed out are mirrored here, loaded at
// start and refreshed every revokeRefresh (for other servers' sign-outs); this server's own
// sign-outs apply at once. So no request, and no game hello under the hub's lock, waits on
// the database for it.

const revokeRefresh = 30 * time.Second

// revokeStore is the part of a Store that keeps sessions_after (pgStore and memStore).
type revokeStore interface {
	SetSessionsAfter(ctx context.Context, id int64, t time.Time) error
	AllSessionsAfter(ctx context.Context) (map[int64]time.Time, error)
}

type revocations struct {
	mu    sync.RWMutex
	after map[int64]time.Time
	store revokeStore // nil: memory only
}

// newRevocations loads what's stored and keeps it fresh. A store without sessions_after
// gives a memory-only list (sign-outs still apply until a restart).
func newRevocations(s Store) *revocations {
	r := &revocations{after: map[int64]time.Time{}}
	if rs, ok := s.(revokeStore); ok {
		r.store = rs
		_, pg := s.(*pgStore) // Postgres may still be coming up (accounts.connect): load in the background
		if !pg {
			r.refresh()
		}
		go func() {
			if pg {
				r.refresh()
			}
			for range time.Tick(revokeRefresh) {
				r.refresh()
			}
		}()
	}
	return r
}

func (r *revocations) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m, err := r.store.AllSessionsAfter(ctx)
	if err != nil {
		log.Printf("auth: loading sign-outs: %v", err)
		return
	}
	r.mu.Lock()
	for id, t := range m {
		if t.After(r.after[id]) {
			r.after[id] = t
		}
	}
	r.mu.Unlock()
}

// valid: a token for id issued at issuedUnix (seconds) is still good. Same-second counts as
// after, so signing straight back in works.
func (r *revocations) valid(id, issuedUnix int64) bool {
	if r == nil {
		return true
	}
	r.mu.RLock()
	t, ok := r.after[id]
	r.mu.RUnlock()
	return !ok || issuedUnix >= t.Unix()
}

// revoke ends id's sessions and tickets issued before now.
func (r *revocations) revoke(ctx context.Context, id int64) error {
	if r == nil {
		return nil
	}
	now := time.Now()
	r.mu.Lock()
	r.after[id] = now
	r.mu.Unlock()
	if r.store == nil {
		return nil
	}
	return r.store.SetSessionsAfter(ctx, id, now)
}

// ttlFor is how long a kind of token lives, so its issue time is its expiry minus this.
func ttlFor(kind string) time.Duration {
	if kind == kindTicket {
		return ticketTTL
	}
	return sessionTTL
}

// ---------- stores ----------

func (s *pgStore) SetSessionsAfter(ctx context.Context, id int64, t time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET sessions_after = $2 WHERE id = $1`, id, t)
	return err
}

func (s *pgStore) AllSessionsAfter(ctx context.Context) (map[int64]time.Time, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, sessions_after FROM users WHERE sessions_after IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]time.Time{}
	for rows.Next() {
		var id int64
		var t time.Time
		if err := rows.Scan(&id, &t); err != nil {
			return nil, err
		}
		out[id] = t
	}
	return out, rows.Err()
}

func (s *memStore) SetSessionsAfter(_ context.Context, id int64, t time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.after == nil {
		s.after = map[int64]time.Time{}
	}
	s.after[id] = t
	return nil
}

func (s *memStore) AllSessionsAfter(context.Context) (map[int64]time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[int64]time.Time, len(s.after))
	for id, t := range s.after {
		out[id] = t
	}
	return out, nil
}
