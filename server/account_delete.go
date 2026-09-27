package main

// Deleting your own account (/settings: "Delete my account"). DELETE /api/me, signed in and
// from the site itself: your memory's index copy is queued for erasure first (so it goes even
// across a restart), then your account and everything that hangs off it goes in one
// transaction (memberships, progress, tokens, memory, talk prefs, briefs, every talk you were
// in and its chat), and you're signed out everywhere. Sign in again and you start fresh.

import (
	"context"
	"log"
	"net/http"
	"time"
)

type accountDeleter interface {
	deleteAccount(ctx context.Context, id int64) error
}

func (s *pgStore) deleteAccount(ctx context.Context, id int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	hasPurges, err := s.pgHas(ctx, tx, "mapi_purges")
	if err != nil {
		return err
	}
	if hasPurges {
		hasSpaces, err := s.pgHas(ctx, tx, "mapi_spaces")
		if err != nil {
			return err
		}
		space := `''`
		if hasSpaces {
			space = `coalesce((SELECT s.space_id FROM mapi_spaces s WHERE s.tenant_id = m.tenant_id AND s.user_id = m.user_id), '')`
		}
		if _, err := tx.Exec(ctx, `INSERT INTO mapi_purges (tenant_id, user_id, scope, space_id)
			SELECT m.tenant_id, m.user_id, 'private', `+space+` FROM memberships m WHERE m.user_id = $1`, id); err != nil {
			return err
		}
	}
	hasTalks, err := s.pgHas(ctx, tx, "talks")
	if err != nil {
		return err
	}
	if hasTalks {
		if _, err := tx.Exec(ctx, `DELETE FROM talks WHERE a_id = $1 OR b_id = $1`, id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (m *memStore) deleteAccount(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.users[id]; !ok {
		return nil
	}
	m.purgeLocked(map[int64]bool{id: true})
	return nil
}

// deleteMe handles DELETE /api/me.
func deleteMe(acc *accounts, originOK func(*http.Request) bool, w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") == "" || !originOK(r) { // only from our own pages
		adminJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
		return
	}
	id, ok := acc.sess.read(r)
	if !ok {
		adminJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
		return
	}
	del, ok := acc.store.(accountDeleter)
	if !ok {
		adminJSON(w, http.StatusNotImplemented, map[string]string{"error": "not available"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if acc.fast != nil {
		if err := acc.fast.forget(ctx, acc.tenant, id); err != nil {
			log.Printf("account: memory purge for #%d: %v", id, err)
			adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
	}
	acc.jev.forget(ctx, acc.tenant, id)
	acc.talk.forget(ctx, acc.tenant, id)
	if err := del.deleteAccount(ctx, id); err != nil {
		log.Printf("account: deleting #%d: %v", id, err)
		adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
		return
	}
	acc.talk.forgetHost(id)
	if err := acc.sess.rev.revoke(ctx, id); err != nil {
		log.Printf("account: sign-out for deleted #%d: %v", id, err)
	}
	setSession(w, r, "", time.Unix(0, 0))
	log.Printf("account: #%d deleted their account", id)
	w.WriteHeader(http.StatusNoContent)
}
