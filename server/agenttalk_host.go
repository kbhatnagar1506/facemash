package main

// The host: the event's own person (TALK_HOST_EMAIL, else the first of ADMIN_EMAILS). Every
// new player's agent gets one talk with the host's agent soon after they join the game, so
// everyone meets them (the demo's promise), whether or not the host has the game open. Each
// pair still talks at most once (the talks table's pair key), and the host has no daily cap.

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// hostDelays: when to try after someone joins (their page turns agent talk on first, and
// their brief may still be building); later tries cover a busy moment.
var hostDelays = []time.Duration{6 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 90 * time.Second}

func talkHostEmail() string {
	if e := strings.ToLower(strings.TrimSpace(os.Getenv("TALK_HOST_EMAIL"))); e != "" {
		return e
	}
	for _, e := range strings.Split(os.Getenv("ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			return e
		}
	}
	return ""
}

type talkHost struct {
	email string
	mu    sync.Mutex
	id    int64
	tried map[int64]bool // players already queued for a host talk (this run)
}

// hostID: the host's account at this event, looked up once they exist.
func (t *agentTalk) hostID(ctx context.Context, tenant string) int64 {
	h := t.host
	if h == nil || h.email == "" {
		return 0
	}
	h.mu.Lock()
	id := h.id
	h.mu.Unlock()
	if id != 0 {
		return id
	}
	switch st := t.acc.store.(type) {
	case *pgStore:
		st.pool.QueryRow(ctx, `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
			WHERE lower(u.email) = $2`, tenant, h.email).Scan(&id)
	case *memStore:
		st.mu.Lock()
		if uid, ok := st.byEmail[h.email]; ok && st.members[memKey(tenant, uid)] != nil {
			id = uid
		}
		st.mu.Unlock()
	}
	if id != 0 {
		h.mu.Lock()
		h.id = id
		h.mu.Unlock()
		log.Printf("talk: host is #%d (%s)", id, h.email)
	}
	return id
}

// greetHost starts the host's talk with a player who just joined (in the background).
func (t *agentTalk) greetHost(tenant string, uid int64) {
	if t == nil || !t.on() || t.host == nil || t.host.email == "" || uid <= 0 {
		return
	}
	h := t.host
	h.mu.Lock()
	if h.tried[uid] {
		h.mu.Unlock()
		return
	}
	h.tried[uid] = true
	h.mu.Unlock()
	go func() {
		for _, d := range hostDelays {
			time.Sleep(d)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			host := t.hostID(ctx, tenant)
			if host == 0 || host == uid {
				cancel()
				return
			}
			id, err := t.encounterOpt(ctx, tenant, host, uid, false, true)
			cancel()
			switch {
			case err == nil:
				log.Printf("talk: host talk %s with #%d", id, uid)
				return
			case errors.Is(err, errTalkPair), errors.Is(err, errTalkWho), errors.Is(err, errTalkOff):
				return // already talked, or can't
			}
			// not opted in yet, offline for a moment, busy or full: try again shortly
		}
		h.mu.Lock()
		delete(h.tried, uid) // their next visit tries again
		h.mu.Unlock()
	}()
}
