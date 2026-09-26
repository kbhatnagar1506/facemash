package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func getJSON(t *testing.T, mux *http.ServeMux, path string) (int, map[string]any, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s: %v: %s", path, err, rec.Body.String())
	}
	return rec.Code, out, rec.Body.String()
}

func TestReadyz(t *testing.T) {
	var dbUp atomic.Bool
	checks := []warmCheck{
		{name: "db", critical: true, run: func(context.Context) (string, error) {
			if !dbUp.Load() {
				return "", &net.OpError{Op: "dial", Err: errors.New("refused")}
			}
			return "4 warm", nil
		}},
		// a failure's text never reaches /api/readyz (it can quote a URL, and so a key)
		{name: "gemini", run: func(ctx context.Context) (string, error) {
			req, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:1/models?key=SECRETKEY", nil)
			_, err := http.DefaultClient.Do(req)
			return "", err
		}},
		{name: "jev", run: func(context.Context) (string, error) { panic("boom SECRETKEY") }},
		{name: "elevenlabs", run: func(context.Context) (string, error) { return "", httpStatusErr(401) }},
	}
	w := newWarmer(checks, time.Hour)
	mux := http.NewServeMux()
	w.mount(mux)

	if code, out, _ := getJSON(t, mux, "/api/healthz"); code != 200 || out["ok"] != true {
		t.Fatalf("healthz %d %v", code, out)
	}
	if code, out, _ := getJSON(t, mux, "/api/readyz"); code != 503 || out["ready"] != false || out["booted"] != false {
		t.Fatalf("readyz before boot: %d %v", code, out)
	}

	w.boot(5 * time.Second) // the db is down: booted, not ready
	code, out, body := getJSON(t, mux, "/api/readyz")
	if code != 503 || out["booted"] != true {
		t.Fatalf("readyz with the db down: %d %v", code, out)
	}
	if strings.Contains(body, "SECRETKEY") || strings.Contains(body, "127.0.0.1") || strings.Contains(body, "boom") {
		t.Fatalf("readyz leaks an error's text: %s", body)
	}
	deps := out["deps"].(map[string]any)
	for name, want := range map[string]string{"db": "connect: dial", "gemini": "connect: dial", "jev": "panic", "elevenlabs": "http 401"} {
		d := deps[name].(map[string]any)
		if d["ok"] != false || d["error"] != want {
			t.Errorf("%s: %v, want error %q", name, d, want)
		}
	}

	// the db comes up: only critical dependencies decide readiness
	dbUp.Store(true)
	w.runCheck(checks[0])
	code, out, _ = getJSON(t, mux, "/api/readyz")
	if code != 200 || out["ready"] != true {
		t.Fatalf("readyz with the db up: %d %v", code, out)
	}
	d := out["deps"].(map[string]any)["db"].(map[string]any)
	if d["ok"] != true || d["detail"] != "4 warm" || d["critical"] != true {
		t.Fatalf("db: %v", d)
	}
}

// A hung dependency doesn't hold boot past its limit, and is recorded when it gives up.
func TestWarmBootBounded(t *testing.T) {
	hung := warmCheck{name: "mapi", run: func(ctx context.Context) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}}
	fast := warmCheck{name: "event", run: func(context.Context) (string, error) { return "3 days", nil }}
	w := newWarmer([]warmCheck{hung, fast}, time.Hour)
	w.timeout = 300 * time.Millisecond
	start := time.Now()
	w.boot(50 * time.Millisecond)
	if took := time.Since(start); took > 250*time.Millisecond {
		t.Fatalf("boot waited %v for a hung dependency", took)
	}
	if !w.ready() {
		t.Fatal("a non-critical dependency held readiness")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		w.mu.Lock()
		s, ok := w.state["mapi"]
		w.mu.Unlock()
		if ok {
			if s.OK || s.Error != "timeout" {
				t.Fatalf("hung check recorded as %+v", s)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("hung check never recorded")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The keep-warm loops go on through failures (retrying sooner) and stop when told.
func TestWarmKeepTolerant(t *testing.T) {
	var calls atomic.Int32
	flaky := warmCheck{name: "jev", run: func(context.Context) (string, error) {
		n := calls.Add(1)
		if n%2 == 0 {
			panic("flaky")
		}
		if n%3 == 0 {
			return "", errors.New("down")
		}
		return "", nil
	}}
	w := newWarmer([]warmCheck{flaky}, 20*time.Millisecond)
	w.boot(time.Second)
	stop := make(chan struct{})
	w.keep(stop)
	deadline := time.Now().Add(3 * time.Second)
	for calls.Load() < 8 {
		if time.Now().After(deadline) {
			t.Fatalf("keep-warm stopped after %d calls", calls.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(stop)
	time.Sleep(60 * time.Millisecond)
	n := calls.Load()
	time.Sleep(100 * time.Millisecond)
	if calls.Load() > n+1 {
		t.Fatalf("keep-warm still running after stop: %d -> %d", n, calls.Load())
	}
}

// warmGet reads each answer to the end, so the next request reuses the connection.
func TestWarmGetReusesConnection(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bad" {
			http.Error(w, strings.Repeat("x", 5000), http.StatusBadGateway)
			return
		}
		if r.Header.Get("x-goog-api-key") != "k" {
			http.Error(w, "no key", http.StatusForbidden)
			return
		}
		w.Write([]byte(strings.Repeat("model ", 2000)))
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			conns.Add(1)
		}
	}
	srv.Start()
	defer srv.Close()
	hc := &http.Client{Transport: &http.Transport{}}
	ctx := context.Background()
	for range 3 {
		if _, err := warmGet(ctx, hc, srv.URL+"/models", map[string]string{"x-goog-api-key": "k"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := warmGet(ctx, hc, srv.URL+"/bad", nil); warmErr(err) != "http 502" {
		t.Fatalf("got %v", err)
	}
	if _, err := warmGet(ctx, hc, srv.URL+"/models", nil); warmErr(err) != "http 403" {
		t.Fatalf("got %v", err)
	}
	if n := conns.Load(); n != 1 {
		t.Fatalf("%d connections for 5 requests, want 1", n)
	}
}

// With every upstream failing, startWarm still returns promptly and the server is ready (the
// memory store has no critical dependency).
func TestStartWarmUpstreamsDown(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer down.Close()
	dir := t.TempDir()
	ev := filepath.Join(dir, "event.json")
	os.WriteFile(ev, []byte(`{"days":[{"label":"Fri","date":"2026-09-25","title":"Friday","items":[]}]}`), 0o644)

	_, acc := memAccounts()
	acc.fast = &memFast{mapi: &fastClient{read: down.URL, write: down.URL, hc: http.DefaultClient}}
	acc.voice = newVoiceGuide([]*voiceKey{{name: "primary", key: "el-test", agent: "a"}}, down.URL, 1)
	cfg, err := loadTalkConfig("")
	if err != nil {
		t.Fatal(err)
	}
	acc.talk = newAgentTalk(cfg, acc, acc.store.(talkStore), nil)
	acc.talk.gem = &talkGemini{key: "g-test", base: down.URL + "/v1beta/models/", hc: talkTransport()}
	acc.talk.jev = &talkJev{key: "j-test", url: "http://127.0.0.1:1/v1/systemone", hc: talkTransport()}

	mux := http.NewServeMux()
	start := time.Now()
	w := newWarmer(warmChecks(acc, nil, ev), time.Hour)
	w.mount(mux)
	w.boot(5 * time.Second)
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("boot took %v", took)
	}
	code, out, body := getJSON(t, mux, "/api/readyz")
	if code != 200 {
		t.Fatalf("readyz %d: %s", code, body)
	}
	for _, k := range []string{"g-test", "el-test", "j-test"} {
		if strings.Contains(body, k) {
			t.Fatalf("readyz shows a key: %s", body)
		}
	}
	deps := out["deps"].(map[string]any)
	want := map[string]string{"mapi": "http 503", "gemini": "http 503", "elevenlabs": "http 503", "jev": "connect: dial"}
	for name, e := range want {
		d, ok := deps[name].(map[string]any)
		if !ok || d["ok"] != false || d["error"] != e {
			t.Errorf("%s: %v, want error %q", name, deps[name], e)
		}
	}
	for _, name := range []string{"event", "talkdata"} {
		if d, ok := deps[name].(map[string]any); !ok || d["ok"] != true {
			t.Errorf("%s: %v", name, deps[name])
		}
	}
	if _, ok := deps["db"]; ok {
		t.Error("memory store reported as a database")
	}
}

func TestEventScheduleCache(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "event.json")
	os.WriteFile(p, []byte(`{"days":[{"title":"Friday"}]}`), 0o644)
	a, err := eventSchedule(p)
	if err != nil || len(a.Days) != 1 {
		t.Fatalf("%v %v", a, err)
	}
	if b, _ := eventSchedule(p); b != a {
		t.Fatal("unchanged file parsed again")
	}
	// edited live: picked up (a different size is enough, whatever the clock's resolution)
	os.WriteFile(p, []byte(`{"days":[{"title":"Friday"},{"title":"Saturday"}]}`), 0o644)
	if b, err := eventSchedule(p); err != nil || len(b.Days) != 2 {
		t.Fatalf("edit not picked up: %v %v", b, err)
	}
	os.WriteFile(p, []byte(`{"days":`), 0o644)
	if _, err := eventSchedule(p); err == nil {
		t.Fatal("broken file accepted")
	}
	if _, err := schedule(p, "now", time.Now()); err == nil {
		t.Fatal("schedule from a broken file")
	}
}

func TestWarmBriefCandidates(t *testing.T) {
	store, acc := memAccounts()
	ctx := context.Background()
	var ids []int64
	for _, e := range []string{"a@x.test", "b@x.test", "c@x.test", "d@x.test"} {
		a, _, err := store.SignIn(ctx, acc.tenant, user{Sub: e, Email: e})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, a.ID)
	}
	now := time.Now()
	store.mu.Lock()
	// a: memory, no brief; b: brief older than its memory; c: brief newer; d: no memory
	store.memory[memKey(acc.tenant, ids[0])] = memMemory{data: []byte(`{}`), received: now.Add(-time.Minute)}
	store.memory[memKey(acc.tenant, ids[1])] = memMemory{data: []byte(`{}`), received: now}
	store.memory[memKey(acc.tenant, ids[2])] = memMemory{data: []byte(`{}`), received: now.Add(-time.Hour)}
	store.memory[memKey("other", ids[3])] = memMemory{data: []byte(`{}`), received: now}
	store.talkTables().briefs[memKey(acc.tenant, ids[1])] = talkBrief{At: now.Add(-time.Hour)}
	store.talkTables().briefs[memKey(acc.tenant, ids[2])] = talkBrief{At: now}
	store.mu.Unlock()
	got, err := store.warmBriefCandidates(ctx, acc.tenant, 10)
	if err != nil || len(got) != 2 || got[0] != ids[1] || got[1] != ids[0] {
		t.Fatalf("candidates %v %v, want [%d %d]", got, err, ids[1], ids[0])
	}
	if got, _ := store.warmBriefCandidates(ctx, acc.tenant, 1); len(got) != 1 {
		t.Fatalf("limit ignored: %v", got)
	}
}

func TestWarmBriefsPacedAndGivesUp(t *testing.T) {
	ctx := context.Background()
	var at []time.Time
	built, failed := warmBriefs(ctx, []int64{1, 2, 3}, 30*time.Millisecond, func(context.Context, int64) error {
		at = append(at, time.Now())
		return nil
	})
	if built != 3 || failed != 0 {
		t.Fatalf("built %d failed %d", built, failed)
	}
	if gap := at[2].Sub(at[0]); gap < 55*time.Millisecond {
		t.Fatalf("not paced: %v for 3 builds", gap)
	}
	// a failure now and then is skipped; warmBriefGiveUp in a row stops the run
	var n int
	ids := make([]int64, 20)
	built, failed = warmBriefs(ctx, ids, time.Millisecond, func(context.Context, int64) error {
		n++
		if n == 1 || n > 2 {
			return errors.New("quota")
		}
		return nil
	})
	if built != 1 || failed != 1+warmBriefGiveUp || n != 2+warmBriefGiveUp {
		t.Fatalf("built %d failed %d calls %d", built, failed, n)
	}
	// stopping (shutdown) ends it between builds
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if built, _ = warmBriefs(cctx, []int64{1, 2, 3}, time.Hour, func(context.Context, int64) error { return nil }); built != 1 {
		t.Fatalf("built %d after cancel", built)
	}
}

func TestTunedDefaultTransport(t *testing.T) {
	tr := http.DefaultTransport.(*http.Transport)
	if tr.MaxIdleConnsPerHost < 32 || tr.IdleConnTimeout < 4*time.Minute || !tr.ForceAttemptHTTP2 {
		t.Fatalf("default transport not tuned: %d per host, idle %v, h2 %v", tr.MaxIdleConnsPerHost, tr.IdleConnTimeout, tr.ForceAttemptHTTP2)
	}
	if talkTransport().Transport != http.DefaultTransport {
		t.Fatal("agent talk doesn't share the tuned transport")
	}
}
