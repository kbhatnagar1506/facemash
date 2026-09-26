package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Saving as people play: the socket knows where every signed-in player is, so the hub
// writes their position every few seconds (only if they moved) and once more when they
// leave. Database writes happen off the hub's lock, batched by one writer (saver, below).

const saveEvery = 10 * time.Second

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// openAccounts sets up the account store: Cloud SQL through the connector with IAM auth
// (DB_INSTANCE + DB_IAM_USER), or Postgres directly (DB_HOST + DB_USER + DB_PASSWORD, TLS
// required). Nothing is dialled here: connect (below) reaches the database in the background
// and keeps trying, and until it has, the routes that need it answer 503 (gate) while the
// game itself runs. With neither set, a memory store, which is fine for local dev. nil only
// when the database settings themselves are unusable.
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
	s, err := newPostgres(t)
	if err != nil {
		log.Printf("accounts: database settings unusable, sign-in off: %v", err)
		return nil
	}
	log.Printf("accounts: Postgres at %s, tenant %s (connecting in the background)", where, tenant)
	a.store = s
	a.sess.rev = newRevocations(s)
	a.dbDown.Store(true)
	return a
}

// connect brings the database up in the background, retrying with backoff: the tables, the
// tenant, then what memfast and jev keep there. Only then do the gated routes open and the
// memory index's workers start. For the memory store it's all immediate.
func (a *accounts) connect() {
	a.readyOnce.Do(func() { a.ready = make(chan struct{}) })
	pg, _ := a.store.(*pgStore)
	up := func() {
		a.dbDown.Store(false)
		close(a.ready)
		if a.fast != nil {
			a.fast.start(fastWorkers)
		}
	}
	if pg == nil {
		up()
		return
	}
	go func() {
		wait, extrasTried := time.Second, 0
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			err := pg.bootstrap(ctx, a.tenant, envOr("TENANT_NAME", "HackGT 13"))
			if err == nil {
				// what memfast and jev keep in the database; after a few failures they come up
				// anyway (memfast's own retries cover it) rather than keep sign-in off
				if err = a.bootExtras(ctx, pg); err != nil {
					if extrasTried++; extrasTried >= 3 {
						log.Printf("accounts: going on without: %v", err)
						err = nil
					}
				}
			}
			cancel()
			if err == nil {
				log.Printf("accounts: database up")
				up()
				return
			}
			log.Printf("accounts: database unavailable, retrying in %v: %v", wait, err)
			time.Sleep(wait)
			wait = min(2*wait, 30*time.Second)
		}
	}()
}

func (a *accounts) bootExtras(ctx context.Context, pg *pgStore) error {
	if a.fast != nil {
		if err := pg.fastEnsureSchema(ctx); err != nil {
			return fmt.Errorf("memfast schema: %w", err)
		}
	}
	if a.jev != nil {
		if err := a.jev.usePostgres(ctx, pg); err != nil {
			return fmt.Errorf("jev table: %w", err)
		}
	}
	if err := pg.usageEnsureSchema(ctx, a.tenant); err != nil {
		return fmt.Errorf("usage tables: %w", err)
	}
	return nil
}

// waitReady: for the command-line tools, which need the database before doing anything.
func (a *accounts) waitReady(d time.Duration) bool {
	a.readyOnce.Do(func() { a.ready = make(chan struct{}) })
	select {
	case <-a.ready:
		return true
	case <-time.After(d):
		return false
	}
}

// dbPaths are the routes that need the database; gate answers them 503 until it is up.
var dbPaths = []string{"/api/auth/google", "/api/profile", "/api/muse", "/api/mcp", "/api/now", "/api/memory", "/api/ask", "/api/look", "/api/voice", "/api/dev"}

// gate holds back the routes that need the database while it isn't reachable yet (boot
// with Cloud SQL down): "temporarily unavailable" instead of hanging on a dead pool. /api/me
// only needs it for someone signed in.
func (a *accounts) gate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.dbDown.Load() && a.needsDB(r) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Retry-After", "5")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":"temporarily unavailable: try again in a moment"}` + "\n"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *accounts) needsDB(r *http.Request) bool {
	p := r.URL.Path
	if p == "/api/me" {
		_, signedIn := a.sess.read(r)
		return signedIn
	}
	for _, d := range dbPaths {
		if p == d || strings.HasPrefix(p, d+"/") {
			return true
		}
	}
	return false
}

// ---------- saving as people play ----------

// Profile and position saves from the game are queued (the latest per player wins) and
// written by one goroutine, a batch per statement: a thousand players moving, or joining
// at once after a reconnect, is one connection and a few statements, not a thousand of each.

type saver struct {
	mu       sync.Mutex
	progress map[int64]Progress
	profiles map[int64]Profile
	kick     chan struct{}
}

const saveBatch = 500 // players per statement

func (a *accounts) saveProfile(id int64, p Profile) {
	a.queueSave(func(s *saver) { s.profiles[id] = p })
}

func (a *accounts) saveProgress(id int64, p Progress) {
	a.queueSave(func(s *saver) { s.progress[id] = p })
}

// saveProgresses queues many at once (the hub's periodic save): one batch, not a trickle.
func (a *accounts) saveProgresses(ps map[int64]Progress) {
	if len(ps) == 0 {
		return
	}
	a.queueSave(func(s *saver) {
		for id, p := range ps {
			s.progress[id] = p
		}
	})
}

func (a *accounts) queueSave(add func(*saver)) {
	s := &a.saves
	s.mu.Lock()
	if s.kick == nil {
		s.progress, s.profiles, s.kick = map[int64]Progress{}, map[int64]Profile{}, make(chan struct{}, 1)
		go a.saveWriter()
	}
	add(s)
	s.mu.Unlock()
	select {
	case s.kick <- struct{}{}:
	default: // a write is already due
	}
}

func (a *accounts) saveWriter() {
	s := &a.saves
	for range s.kick {
		for a.dbDown.Load() { // kept (latest per player) until the database is there
			time.Sleep(time.Second)
		}
		s.mu.Lock()
		progress, profiles := s.progress, s.profiles
		s.progress, s.profiles = map[int64]Progress{}, map[int64]Profile{}
		s.mu.Unlock()
		a.writeBatches(profiles, progress)
	}
}

func (a *accounts) writeBatches(profiles map[int64]Profile, progress map[int64]Progress) {
	for len(profiles) > 0 {
		chunk := map[int64]Profile{}
		for id, p := range profiles {
			if len(chunk) == saveBatch {
				break
			}
			chunk[id] = p
			delete(profiles, id)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := a.store.SaveProfiles(ctx, a.tenant, chunk); err != nil {
			log.Printf("accounts: saving %d profiles: %v", len(chunk), err)
		}
		cancel()
	}
	for len(progress) > 0 {
		chunk := map[int64]Progress{}
		for id, p := range progress {
			if len(chunk) == saveBatch {
				break
			}
			chunk[id] = p
			delete(progress, id)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := a.store.SaveProgresses(ctx, a.tenant, chunk); err != nil {
			log.Printf("accounts: saving %d positions: %v", len(chunk), err)
		}
		cancel()
	}
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
	batch := map[int64]Progress{}
	h.mu.Lock()
	for _, c := range h.clients {
		if !c.joined || c.uid == 0 {
			continue
		}
		p := c.progress()
		// half a metre or a room change is worth a write; standing still isn't
		if p.Room != c.saved.Room || math.Hypot(p.X-c.saved.X, p.Z-c.saved.Z) > 0.5 || math.Abs(p.Y-c.saved.Y) > 0.5 {
			c.saved = p
			batch[c.uid] = p
		}
	}
	h.mu.Unlock()
	acct.saveProgresses(batch)
}
