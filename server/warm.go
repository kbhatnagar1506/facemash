package main

// Warm: no request pays a cold cost. Before the server listens, main calls startWarm, which
// loads and connects everything a first request would otherwise wait for, all at once:
//
//   - the event schedule, parsed and cached (re-read only when the file changes), and the
//     agent-talk config and question bank (already parsed by openAgentTalk)
//   - Google's sign-in keys (JWKS)
//   - the database pool: WARM_DB_CONNS connections open and each run once, and the hot
//     statements prepared on them (pgx caches a statement per connection on first use)
//   - DNS, TCP, TLS and HTTP/2 to MAPI, Gemini, jev (api.typesafe.ai) and ElevenLabs, through
//     the very clients the requests use (a warm connection in another pool helps nobody)
//
// It logs one "warm: ... in X ms" line. Then every WARM_EVERY (about 50 s) each dependency gets
// a cheap request on its own goroutine so connections and TLS sessions stay open: SELECT 1,
// MAPI's /ready, Gemini's model list, jev's /health, ElevenLabs' /v1/user. None of them spends
// a model token or a voice minute, a failure is only recorded (and retried sooner), and no
// request ever waits on a warmer. In the background it also builds the agent-talk brief of
// everyone with memory and no current brief (one at a time, paced), and keeps the shared
// /api/now snapshot fresh.
//
// GET /api/healthz: the process is up. GET /api/readyz: 200 once the boot warm-up is done and
// the database answers, with each dependency's state and latency (never a key or a URL).
//
// Outbound HTTP: every client that uses http.DefaultTransport (sign-in keys, jev outfits,
// ElevenLabs, and agent talk's Gemini and jev through talkTransport) shares one transport,
// tuned here: 64 idle connections per host, kept 5 minutes, HTTP/2 attempted. MAPI keeps its
// own (memfast.go: 90 s idle, under MAPI's 120 s keep-alive).

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	outIdleConns        = 256
	outIdlePerHost      = 64
	outIdleConnTimeout  = 5 * time.Minute
	warmCheckTimeout    = 8 * time.Second
	warmRetryMin        = 5 * time.Second
	nowRefreshEvery     = 5 * time.Second // under nowTTL (15 s), so /api/now never builds it
	warmBriefStartDelay = 10 * time.Second
	warmBriefGiveUp     = 5 // consecutive failures (Gemini down, quota): stop, memoryArrived still builds
)

func init() { tuneTransport(http.DefaultTransport) }

// tuneTransport sets the pool sizes and idle time for a shared transport. Only called before
// the transport is used (init), since a Transport's fields aren't safe to change while in use.
func tuneTransport(rt http.RoundTripper) {
	t, ok := rt.(*http.Transport)
	if !ok {
		return
	}
	t.MaxIdleConns = outIdleConns
	t.MaxIdleConnsPerHost = outIdlePerHost
	t.IdleConnTimeout = outIdleConnTimeout
	t.ForceAttemptHTTP2 = true
}

func envInt(name string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && n >= 0 {
		return n
	}
	return def
}

func envDuration(name string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(strings.TrimSpace(os.Getenv(name))); err == nil && d > 0 {
		return d
	}
	return def
}

// ---------- the event schedule, parsed once ----------

type eventDoc struct {
	Days []schedDay `json:"days"`
}

var eventCache struct {
	sync.Mutex
	path string
	mod  time.Time
	size int64
	doc  *eventDoc
}

// eventSchedule is event.json parsed, re-read only when the file changes (it can be edited
// live). The result is shared: callers must not modify it.
func eventSchedule(path string) (*eventDoc, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	eventCache.Lock()
	defer eventCache.Unlock()
	if eventCache.doc != nil && eventCache.path == path && eventCache.mod.Equal(st.ModTime()) && eventCache.size == st.Size() {
		return eventCache.doc, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc := &eventDoc{}
	if err := json.Unmarshal(b, doc); err != nil {
		return nil, err
	}
	eventCache.path, eventCache.mod, eventCache.size, eventCache.doc = path, st.ModTime(), st.Size(), doc
	return doc, nil
}

// ---------- the warmer ----------

// warmCheck is one dependency: run connects it (or keeps it connected) and says how it is.
type warmCheck struct {
	name     string
	critical bool // /api/readyz waits for it
	run      func(ctx context.Context) (detail string, err error)
}

type warmState struct {
	OK       bool      `json:"ok"`
	MS       float64   `json:"ms"`
	Detail   string    `json:"detail,omitempty"`
	Error    string    `json:"error,omitempty"`
	At       time.Time `json:"at"`
	Fails    int       `json:"fails,omitempty"` // in a row
	Critical bool      `json:"critical,omitempty"`
}

type warmer struct {
	checks  []warmCheck
	every   time.Duration
	timeout time.Duration // per check
	started time.Time

	mu     sync.Mutex
	state  map[string]warmState
	booted bool
	bootMS float64
}

func newWarmer(checks []warmCheck, every time.Duration) *warmer {
	return &warmer{checks: checks, every: every, timeout: warmCheckTimeout, started: time.Now(), state: map[string]warmState{}}
}

// runCheck runs c once (bounded, panics contained) and records the result.
func (w *warmer) runCheck(c warmCheck) warmState {
	ctx, cancel := context.WithTimeout(context.Background(), w.timeout)
	defer cancel()
	start := time.Now()
	detail, err := func() (d string, err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("panic: %v", r)
			}
		}()
		return c.run(ctx)
	}()
	s := warmState{OK: err == nil, MS: roundMS(time.Since(start)), Detail: detail, At: time.Now().UTC(), Critical: c.critical}
	w.mu.Lock()
	prev, seen := w.state[c.name]
	if err != nil {
		s.Error = warmErr(err)
		s.Fails = prev.Fails + 1
	}
	w.state[c.name] = s
	booted := w.booted
	w.mu.Unlock()
	// after boot, log only changes (a warmer every 50 s would drown the log otherwise)
	if booted && seen && prev.OK != s.OK {
		if s.OK {
			log.Printf("warm: %s back (%.0f ms)", c.name, s.MS)
		} else {
			log.Printf("warm: %s failing: %s", c.name, s.Error)
		}
	}
	return s
}

// boot runs every check at once and waits for them, at most limit (a slow one finishes in
// the background and is recorded then). It logs the one warm line.
func (w *warmer) boot(limit time.Duration) {
	start := time.Now()
	done := make(chan struct{}, len(w.checks))
	for _, c := range w.checks {
		go func() {
			w.runCheck(c)
			done <- struct{}{}
		}()
	}
	timeout := time.After(limit)
wait:
	for range w.checks {
		select {
		case <-done:
		case <-timeout:
			break wait
		}
	}
	w.mu.Lock()
	w.booted, w.bootMS = true, roundMS(time.Since(start))
	parts := make([]string, 0, len(w.checks))
	for _, c := range w.checks {
		s, ok := w.state[c.name]
		switch {
		case !ok:
			parts = append(parts, c.name+" still going")
		case s.OK && s.Detail != "":
			parts = append(parts, fmt.Sprintf("%s %.0fms (%s)", c.name, s.MS, s.Detail))
		case s.OK:
			parts = append(parts, fmt.Sprintf("%s %.0fms", c.name, s.MS))
		default:
			parts = append(parts, fmt.Sprintf("%s FAILED (%s)", c.name, s.Error))
		}
	}
	ms := w.bootMS
	w.mu.Unlock()
	log.Printf("warm: %s; ready=%v in %.0f ms", strings.Join(parts, ", "), w.ready(), ms)
}

// keep runs each check on its own goroutine every w.every (±10%), sooner after a failure,
// until stop closes.
func (w *warmer) keep(stop <-chan struct{}) {
	for _, c := range w.checks {
		go func() {
			for {
				w.mu.Lock()
				fails := w.state[c.name].Fails
				w.mu.Unlock()
				wait := jitter(w.every)
				if fails > 0 {
					wait = min(warmRetryMin<<min(fails-1, 5), wait)
				}
				select {
				case <-stop:
					return
				case <-time.After(wait):
				}
				w.runCheck(c)
			}
		}()
	}
}

func jitter(d time.Duration) time.Duration {
	return d - d/10 + time.Duration(rand.Int64N(int64(d/5)+1))
}

// ready: booted, and every critical dependency answered last time.
func (w *warmer) ready() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.booted {
		return false
	}
	for _, c := range w.checks {
		if c.critical && !w.state[c.name].OK {
			return false
		}
	}
	return true
}

func (w *warmer) mount(mux *http.ServeMux) {
	mux.HandleFunc("/api/healthz", func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		rw.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(rw).Encode(map[string]any{"ok": true, "uptime_s": int(time.Since(w.started).Seconds())})
	})
	// readyz only reads what the warmers last saw: a request never causes a check
	mux.HandleFunc("/api/readyz", func(rw http.ResponseWriter, r *http.Request) {
		ready := w.ready()
		w.mu.Lock()
		deps := make(map[string]warmState, len(w.state))
		for k, v := range w.state {
			deps[k] = v
		}
		out := map[string]any{"ready": ready, "booted": w.booted, "boot_ms": w.bootMS, "uptime_s": int(time.Since(w.started).Seconds()), "deps": deps}
		w.mu.Unlock()
		rw.Header().Set("Content-Type", "application/json")
		rw.Header().Set("Cache-Control", "no-store")
		if !ready {
			rw.WriteHeader(http.StatusServiceUnavailable)
		}
		json.NewEncoder(rw).Encode(out)
	})
}

func roundMS(d time.Duration) float64 { return float64(d.Microseconds()/100) / 10 }

// warmErr says what kind of failure it was, never the error's text (a url.Error quotes the
// URL, and an upstream's message could echo what we sent).
func warmErr(err error) string {
	var st httpStatusErr
	var dns *net.DNSError
	var op *net.OpError
	var cert *tls.CertificateVerificationError
	switch {
	case errors.As(err, &st):
		return "http " + strconv.Itoa(int(st))
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded):
		return "timeout"
	case errors.As(err, &dns):
		return "dns"
	case errors.As(err, &cert):
		return "tls"
	case errors.As(err, &op):
		return "connect: " + op.Op
	case errors.Is(err, errWarmNoKeys):
		return "no keys"
	case strings.HasPrefix(err.Error(), "panic"):
		return "panic"
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return "request failed"
	}
	return "failed"
}

type httpStatusErr int

func (e httpStatusErr) Error() string { return "http " + strconv.Itoa(int(e)) }

var errWarmNoKeys = errors.New("no keys")

// warmGet sends one small request through hc and reads the answer to the end, so the
// connection goes back to the pool for the next request (the whole point).
func warmGet(ctx context.Context, hc *http.Client, rawURL string, header map[string]string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := hc.Do(req)
	if err != nil {
		return "", err
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	res.Body.Close()
	if res.StatusCode >= 300 {
		return "", httpStatusErr(res.StatusCode)
	}
	return res.Proto, nil
}

// origin is scheme://host of u ("" if u doesn't parse).
func origin(u string) string {
	p, err := url.Parse(u)
	if err != nil || p.Host == "" {
		return ""
	}
	return p.Scheme + "://" + p.Host
}

// ---------- the checks ----------

// warmPool opens n connections (all held at once, so they are n different ones) and runs
// SELECT 1 on each: the pool then keeps them (pgxpool closes idle ones after 30 minutes, and
// this runs every minute). This is MinConns without touching the pool's config.
func warmPool(ctx context.Context, pool *pgxpool.Pool, n int) (int, error) {
	if max := int(pool.Config().MaxConns); n > max {
		n = max
	}
	n = max(n, 1)
	conns := make(chan *pgxpool.Conn, n)
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := pool.Acquire(ctx)
			if err != nil {
				errs <- err
				return
			}
			if _, err := c.Exec(ctx, "SELECT 1"); err != nil {
				c.Release()
				errs <- err
				return
			}
			conns <- c
		}()
	}
	wg.Wait()
	close(conns)
	close(errs)
	ok := 0
	for c := range conns {
		c.Release()
		ok++
	}
	if ok == 0 {
		return 0, <-errs
	}
	return ok, nil
}

// primeStatements runs the hot read paths once per warm connection with an account that
// doesn't exist, so pgx has prepared (and cached) each statement on each connection before a
// real request needs it. Nothing is written: the token lookup matches no row.
func primeStatements(ctx context.Context, acc *accounts, n int) {
	var wg sync.WaitGroup
	for range max(n, 1) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			const nobody = -1
			acc.store.Account(ctx, acc.tenant, nobody)
			acc.store.TokenOwner(ctx, make([]byte, 32))
			acc.store.MemoryInfo(ctx, acc.tenant, nobody)
			if ts, ok := acc.store.(talkStore); ok {
				ts.talkPrefs(ctx, acc.tenant, nobody)
				ts.talkBrief(ctx, acc.tenant, nobody)
			}
			if fs, ok := acc.store.(fastStore); ok {
				fs.fastSpace(ctx, acc.tenant, nobody)
			}
		}()
	}
	wg.Wait()
}

// warmGoogleKeys is the key set mountAuth will use (through googleKeysOverride, so auth.go is
// untouched), for startWarm to fetch before the first sign-in needs it.
func warmGoogleKeys() *googleKeys {
	if googleKeysOverride == nil {
		googleKeysOverride = &googleKeys{}
	}
	return googleKeysOverride
}

// jwksCheck fetches Google's keys when the set is empty or expired; otherwise it only keeps
// the connection to Google warm (a key() call with a made-up kid would count as an unknown
// key and could hold back a real refetch).
func jwksCheck(g *googleKeys) func(context.Context) (string, error) {
	state := func() (int, time.Time) {
		g.mu.Lock()
		defer g.mu.Unlock()
		return len(g.keys), g.exp
	}
	return func(ctx context.Context) (string, error) {
		n, exp := state()
		if n == 0 || !time.Now().Before(exp) {
			g.key("") // fetches the set (the empty kid itself is never found)
			if n, exp = state(); n == 0 {
				return "", errWarmNoKeys
			}
			return fmt.Sprintf("%d keys, fetched, good %s", n, time.Until(exp).Round(time.Minute)), nil
		}
		// the same transport auth.go's fetch uses (a client with no Transport: the default)
		if _, err := warmGet(ctx, http.DefaultClient, googleCerts, nil); err != nil {
			return "", err
		}
		return fmt.Sprintf("%d keys, good %s", n, time.Until(exp).Round(time.Minute)), nil
	}
}

// warmChecks is every dependency this server has configured.
func warmChecks(acc *accounts, jwks *googleKeys, eventFile string) []warmCheck {
	var cs []warmCheck
	cs = append(cs, warmCheck{name: "event", run: func(context.Context) (string, error) {
		doc, err := eventSchedule(eventFile)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%d days", len(doc.Days)), nil
	}})
	if acc == nil {
		return cs
	}
	if t := acc.talk; t != nil {
		cs = append(cs, warmCheck{name: "talkdata", run: func(context.Context) (string, error) {
			return fmt.Sprintf("config %s, %d questions", t.cfg.Version, len(t.bank)), nil
		}})
	}
	if pg, ok := acc.store.(*pgStore); ok {
		n := envInt("WARM_DB_CONNS", 4)
		var primed sync.Once
		cs = append(cs, warmCheck{name: "db", critical: true, run: func(ctx context.Context) (string, error) {
			got, err := warmPool(ctx, pg.pool, n)
			if err != nil {
				return "", err
			}
			primed.Do(func() { primeStatements(ctx, acc, got) })
			st := pg.pool.Stat()
			return fmt.Sprintf("%d warm, %d open", got, st.TotalConns()), nil
		}})
	}
	if jwks != nil && strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID")) != "" {
		cs = append(cs, warmCheck{name: "jwks", run: jwksCheck(jwks)})
	}
	if f := acc.fast; f != nil && f.mapi != nil {
		c := f.mapi
		cs = append(cs, warmCheck{name: "mapi", run: func(ctx context.Context) (string, error) {
			return warmGet(ctx, c.hc, c.read+"/ready", nil) // MAPI's readiness pings its store too
		}})
		if origin(c.write) != origin(c.read) {
			cs = append(cs, warmCheck{name: "mapi-write", run: func(ctx context.Context) (string, error) {
				return warmGet(ctx, c.hc, c.write+"/health", nil)
			}})
		}
	}
	if t := acc.talk; t != nil && t.gem != nil {
		g := t.gem
		cs = append(cs, warmCheck{name: "gemini", run: func(ctx context.Context) (string, error) {
			// listing models is free (no tokens) and checks the key
			return warmGet(ctx, g.hc, strings.TrimSuffix(g.base, "/")+"?pageSize=1", map[string]string{"x-goog-api-key": g.key})
		}})
	}
	// jev: its /health needs no key; both jev clients share the default transport
	var jevHC *http.Client
	jevAt := ""
	if t := acc.talk; t != nil && t.jev != nil {
		jevHC, jevAt = t.jev.hc, origin(t.jev.url)
	} else if acc.jev != nil {
		jevHC, jevAt = acc.jev.http, origin(jevURL)
	}
	if jevHC != nil && jevAt != "" {
		cs = append(cs, warmCheck{name: "jev", run: func(ctx context.Context) (string, error) {
			return warmGet(ctx, jevHC, jevAt+"/health", nil)
		}})
	}
	if v := acc.voice; v != nil && len(v.keys) > 0 {
		cs = append(cs, warmCheck{name: "elevenlabs", run: func(ctx context.Context) (string, error) {
			// the account's details: free, and checks the key
			return warmGet(ctx, v.http, v.api+"/v1/user", map[string]string{"xi-api-key": v.keys[0].key})
		}})
	}
	return cs
}

// ---------- precomputed answers ----------

// keepNow rebuilds the shared part of /api/now (schedule and headcount) before it goes
// stale, so no request builds it.
func keepNow(eventFile string, hub *Hub, stop <-chan struct{}) {
	t := time.NewTicker(nowRefreshEvery)
	defer t.Stop()
	for {
		sharedNow(eventFile, hub, time.Now())
		select {
		case <-stop:
			return
		case <-t.C:
		}
	}
}

// briefCandidates: people with memory whose brief is missing or older than it (newest first).
type briefCandidates interface {
	warmBriefCandidates(ctx context.Context, tenant string, limit int) ([]int64, error)
}

func (s *pgStore) warmBriefCandidates(ctx context.Context, tenant string, limit int) ([]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.user_id FROM agent_memory m
		LEFT JOIN talk_briefs b ON b.tenant_id = m.tenant_id AND b.user_id = m.user_id
		WHERE m.tenant_id = $1 AND (b.user_id IS NULL OR b.created_at < m.received_at)
		ORDER BY m.received_at DESC LIMIT $2`, tenant, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (m *memStore) warmBriefCandidates(_ context.Context, tenant string, limit int) ([]int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	type cand struct {
		id int64
		at time.Time
	}
	var cs []cand
	for k, mm := range m.memory {
		t, id, ok := memKeyID(k)
		if !ok || t != tenant {
			continue
		}
		if b, ok := m.talkTables().briefs[k]; ok && !b.At.Before(mm.received) {
			continue
		}
		cs = append(cs, cand{id, mm.received})
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].at.After(cs[j].at) })
	var out []int64
	for _, c := range cs {
		if len(out) == limit {
			break
		}
		out = append(out, c.id)
	}
	return out, nil
}

// warmBriefs builds each candidate's brief, one at a time, every apart (so Gemini's quota and
// MAPI see a trickle), and gives up after warmBriefGiveUp failures in a row.
func warmBriefs(ctx context.Context, ids []int64, every time.Duration, build func(ctx context.Context, id int64) error) (built, failed int) {
	inRow := 0
	for i, id := range ids {
		if i > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(every):
			}
		}
		if err := build(ctx, id); err != nil {
			failed++
			if inRow++; inRow >= warmBriefGiveUp {
				log.Printf("warm: briefs: stopping after %d failures in a row (last #%d: %s)", inRow, id, warmErr(err))
				return
			}
			continue
		}
		built++
		inRow = 0
	}
	return
}

// precomputeBriefs: after boot, the briefs agent talk would otherwise build on someone's first
// talk. Through briefSem (shared with memoryArrived), so it never adds to the uploads' load.
func precomputeBriefs(acc *accounts, stop <-chan struct{}) {
	t := acc.talk
	lister, ok := acc.store.(briefCandidates)
	if !t.on() || !ok || envInt("WARM_BRIEFS", 1) == 0 {
		return
	}
	select {
	case <-stop:
		return
	case <-time.After(warmBriefStartDelay):
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	lctx, lcancel := context.WithTimeout(ctx, 20*time.Second)
	ids, err := lister.warmBriefCandidates(lctx, acc.tenant, envInt("WARM_BRIEF_MAX", 400))
	lcancel()
	if err != nil {
		log.Printf("warm: briefs: listing: %s", warmErr(err))
		return
	}
	if len(ids) == 0 {
		log.Printf("warm: briefs: all current")
		return
	}
	start := time.Now()
	built, failed := warmBriefs(ctx, ids, envDuration("WARM_BRIEF_EVERY", 3*time.Second), func(ctx context.Context, id int64) error {
		select {
		case t.briefSem <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		defer func() { <-t.briefSem }()
		bctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		p, err := t.ts.talkPrefs(bctx, acc.tenant, id)
		if err == nil {
			_, err = t.buildBrief(bctx, acc.tenant, id, p, false)
		}
		return err
	})
	log.Printf("warm: briefs: %d of %d built (%d failed) in %.0f s", built, len(ids), failed, time.Since(start).Seconds())
}

// ---------- the hook ----------

// startWarm warms everything up (waiting at most WARM_BOOT_TIMEOUT), mounts /api/healthz and
// /api/readyz, and starts the keep-warm loops and the precomputing. Call it once everything
// is mounted, just before listening. jwks is warmGoogleKeys()'s set (nil: none).
func startWarm(mux *http.ServeMux, hub *Hub, acc *accounts, jwks *googleKeys, eventFile string) *warmer {
	w := newWarmer(warmChecks(acc, jwks, eventFile), envDuration("WARM_EVERY", 50*time.Second))
	w.mount(mux)
	stop := make(chan struct{}) // never closed: the loops live as long as the server
	if acc != nil {
		sharedNow(eventFile, hub, time.Now()) // before the first /api/now
		go keepNow(eventFile, hub, stop)
	}
	w.boot(envDuration("WARM_BOOT_TIMEOUT", 5*time.Second))
	w.keep(stop)
	if acc != nil && acc.talk != nil {
		go precomputeBriefs(acc, stop)
	}
	return w
}
