package main

import (
	"context"
	"log"
	"math"
	"os"
	"time"
)

// Saving as people play: the socket knows where every signed-in player is, so the hub
// writes their position every few seconds (only if they moved) and once more when they
// leave. Database writes happen off the hub's lock, on their own goroutines.

const saveEvery = 10 * time.Second

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// openAccounts connects the account store: Cloud SQL through the connector with IAM auth
// (DB_INSTANCE + DB_IAM_USER), or Postgres directly (DB_HOST + DB_USER + DB_PASSWORD, TLS
// required). A failure to reach it turns sign-in off rather than keeping the game down.
// With neither set, a memory store, which is fine for local dev.
func openAccounts(keyFile string) *accounts {
	tenant := envOr("TENANT", "hackgt13")
	a := &accounts{tenant: tenant, sess: sessions{secret: loadSecret(keyFile)}}
	t := dbTarget{
		Instance: os.Getenv("DB_INSTANCE"), IAMUser: os.Getenv("DB_IAM_USER"),
		Host: os.Getenv("DB_HOST"), User: os.Getenv("DB_USER"), Password: os.Getenv("DB_PASSWORD"),
		DB: envOr("DB_NAME", "facemash"),
	}
	where := t.Instance
	if t.Host != "" {
		where = t.Host
	}
	if where == "" {
		log.Printf("accounts: in memory (set DB_INSTANCE for Cloud SQL), tenant %s", tenant)
		a.store = newMemStore()
		a.sess.rev = newRevocations(a.store)
		return a
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s, err := openPostgres(ctx, t, tenant, envOr("TENANT_NAME", "HackGT 13"))
	if err != nil {
		log.Printf("accounts: database unavailable, sign-in off: %v", err)
		return nil
	}
	log.Printf("accounts: Postgres at %s, tenant %s", where, tenant)
	a.store = s
	a.sess.rev = newRevocations(s)
	return a
}

func (a *accounts) saveProfile(id int64, p Profile) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := a.store.SaveProfile(ctx, a.tenant, id, p); err != nil {
			log.Printf("accounts: profile #%d: %v", id, err)
		}
	}()
}

func (a *accounts) saveProgress(id int64, p Progress) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := a.store.SaveProgress(ctx, a.tenant, id, p); err != nil {
			log.Printf("accounts: progress #%d: %v", id, err)
		}
	}()
}

// progress is where c is now. Must be called with the hub's lock held.
func (c *client) progress() Progress {
	return Progress{Room: c.p.Room, X: c.p.X, Z: c.p.Z, Y: c.p.Y, R: c.p.R}
}

func (h *Hub) saveLoop() {
	t := time.NewTicker(saveEvery)
	defer t.Stop()
	for range t.C {
		h.saveMoved()
	}
}

// saveMoved writes the position of every signed-in player who has moved since their last save.
func (h *Hub) saveMoved() {
	type pending struct {
		id int64
		p  Progress
	}
	var batch []pending
	h.mu.Lock()
	for _, c := range h.clients {
		if !c.joined || c.uid == 0 {
			continue
		}
		p := c.progress()
		// half a metre or a room change is worth a write; standing still isn't
		if p.Room != c.saved.Room || math.Hypot(p.X-c.saved.X, p.Z-c.saved.Z) > 0.5 || math.Abs(p.Y-c.saved.Y) > 0.5 {
			c.saved = p
			batch = append(batch, pending{c.uid, p})
		}
	}
	h.mu.Unlock()
	for _, b := range batch {
		acct.saveProgress(b.id, b.p)
	}
}
