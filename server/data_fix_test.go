package main

// Regression tests for the memory / database / data-path review (each failed before its fix).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// heapPeak samples HeapAlloc until stop is called; it returns the peak above the level
// when it started.
func heapPeak() (stop func() uint64) {
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	var peak uint64
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		var m runtime.MemStats
		for {
			runtime.ReadMemStats(&m)
			if m.HeapAlloc > peak {
				peak = m.HeapAlloc
			}
			select {
			case <-done:
				return
			case <-time.After(2 * time.Millisecond):
			}
		}
	}()
	return func() uint64 {
		close(done)
		wg.Wait()
		if peak < base.HeapAlloc {
			return 0
		}
		return peak - base.HeapAlloc
	}
}

func filler(head, item, tail string, size int) string {
	var sb strings.Builder
	sb.Grow(size + 64)
	sb.WriteString(head)
	for sb.Len() < size-len(tail)-len(item) {
		sb.WriteString(item)
	}
	sb.WriteString(tail)
	return sb.String()
}

// 25 MB of tiny values used to become ~1 GB of heap (the container's cap is 1200 MB).
func TestUploadOfTinyValuesStaysSmall(t *testing.T) {
	srv, _, _, _, tok := museServer(t)
	for _, shape := range []struct{ name, head, item, tail string }{
		{"numbers", `{"memory_md":"x","a":[`, "0,", "0]}"},
		{"empty objects", `{"memory_md":"x","a":[`, "{},", "{}]}"},
		{"empty notes", `{"memory_md":"x","daily_notes":[`, "{},", "{}]}"},
		{"tiny notes", `{"daily_notes":[`, `{"content":"a"},`, `{"content":"a"}]}`},
		{"paragraphs", `{"bank":{"world":[`, `"a",`, `"a"]}}`},
		{"deep", `{"a":`, "[", "]}"},
	} {
		body := filler(shape.head, shape.item, shape.tail, maxMemory-64)
		stop := heapPeak()
		start := time.Now()
		res, err := http.Post(srv.URL+memKeyPath+tok, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		peak := stop()
		t.Logf("%-13s 25 MB -> %d in %v, peak heap +%d MB (on top of the test's own copy of the body)", shape.name, res.StatusCode, time.Since(start).Round(time.Millisecond), peak>>20)
		if res.StatusCode != http.StatusRequestEntityTooLarge && res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d %s", shape.name, res.StatusCode, b)
		}
		if peak > 150<<20 {
			t.Errorf("%s: peak heap +%d MB", shape.name, peak>>20)
		}
		time.Sleep(10 * time.Millisecond)
		// the next one would wait on this person's upload rate limit
		srv, _, _, _, tok = museServer(t)
	}
}

// A full-size upload that is accepted (25 MB of text) also stays well under the cap.
func TestBigTextUploadHeap(t *testing.T) {
	srv, _, store, id, tok := museServer(t)
	// (backquoted: the \n are JSON escapes)
	body := filler(`{"user_id":"Buzz","memory_md":"`, `## Notes\nWorked on the drone, fixed the camera bug, ate pizza at Klaus.\n`, `"}`, maxMemory-64)
	stop := heapPeak()
	res, err := http.Post(srv.URL+memKeyPath+tok, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	peak := stop()
	t.Logf("25 MB of text -> %d %s, peak heap +%d MB (on top of the test's own copy of the body)", res.StatusCode, strings.TrimSpace(string(b)), peak>>20)
	if res.StatusCode != 200 {
		t.Fatalf("upload: %d %s", res.StatusCode, b)
	}
	if peak > 150<<20 {
		t.Errorf("peak heap +%d MB", peak>>20)
	}
	store.mu.Lock()
	n := len(store.memory[memKey("hackgt13", id)].data)
	store.mu.Unlock()
	if n < maxMemory/2 {
		t.Fatalf("stored %d bytes", n)
	}
}

// fastReads counts how often the memory index's workers read an upload back.
type fastReads struct {
	*memStore
	reads atomic.Int64
}

func (s *fastReads) fastMemoryData(ctx context.Context, tenant string, id int64, received time.Time) ([]byte, error) {
	s.reads.Add(1)
	return s.memStore.fastMemoryData(ctx, tenant, id, received)
}

// With the memory index on, the worker used to parse every upload a second time (outside
// the big-upload slot) while the next one was parsed in its handler. Now the handler's split
// is handed over; nothing is read back, and two big uploads back to back don't stack.
func TestWorkerUsesTheHandlersSplit(t *testing.T) {
	fake := newMfFake(t)
	ms := &fastReads{memStore: newMemStore()}
	acc := &accounts{store: ms, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	var toks []string
	for i := 0; i < 2; i++ {
		a, _, _ := ms.SignIn(context.Background(), "hackgt13", user{Sub: fmt.Sprint("g-", i), Email: fmt.Sprintf("p%d@x.y", i)})
		tok := newToken()
		ms.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(tok))
		toks = append(toks, tok)
	}
	acc.fast = mfService(ms, fake)
	defer acc.fast.close()
	mux := http.NewServeMux()
	mountMuse(mux, acc, newHub(), "event.json", "https://site.test", func(*http.Request) bool { return true })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	body := filler(`{"memory_md":"`, `## Day\nShipped the bean studio and fixed the socket.\n\n`, `"}`, maxMemory-64)
	stop := heapPeak()
	for _, tok := range toks {
		res, err := http.Post(srv.URL+memKeyPath+tok, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("upload: %d", res.StatusCode)
		}
	}
	mfIdle(t, acc.fast)
	peak := stop()
	t.Logf("two ~25 MB uploads back to back, index on: peak heap +%d MB (on top of the test's own copy of the body); read back %d times", peak>>20, ms.reads.Load())
	if ms.reads.Load() != 0 {
		t.Errorf("the worker read the upload back %d times", ms.reads.Load())
	}
	if peak > 150<<20 {
		t.Errorf("peak heap +%d MB", peak>>20)
	}
	if got := fake.contents(""); len(got) == 0 {
		t.Fatal("nothing indexed")
	}
}

func TestDecodeMemoryKeepsOnlyWhatIsRead(t *testing.T) {
	obj, err := decodeMemory([]byte(`{"user_id":"Buzz","exported_at":"2026-09-26T17:20:00Z","memory_md":"likes rust","user_md":"me",
		"daily_notes":[{"date":"2026-09-25","content":"hi","mood":{"x":[1,2]}},{"date":"2026-09-24","content":["a","b",3]},7,{}],
		"bank":{"world":"w","opinions":["o1","o2"],"people":"Alice's number"},"people":{"alice":"secret"},"extra":[0,0,{}]}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(obj)
	want := `{"bank":{"opinions":["o1","o2"],"world":"w"},"daily_notes":[{"content":"hi","date":"2026-09-25"},{"content":["a","b"],"date":"2026-09-24"}],"exported_at":"2026-09-26T17:20:00Z","memory_md":"likes rust","user_id":"Buzz","user_md":"me"}`
	if string(b) != want {
		t.Fatalf("decoded:\n got %s\nwant %s", b, want)
	}
	if items, _ := fastSplit(obj); len(items) == 0 {
		t.Fatal("nothing to index")
	}
	obj, _ = decodeMemory([]byte(`{"daily_notes":{"2026-09-25":"hi","2026-09-26":["x","y"]}}`))
	if b, _ := json.Marshal(obj); string(b) != `{"daily_notes":{"2026-09-25":"hi","2026-09-26":["x","y"]}}` {
		t.Fatalf("map notes: %s", b)
	}
	for in, status := range map[string]int{
		`not json`:     400,
		`[1,2]`:        400,
		`{"a":1} junk`: 400,
		`{"a":` + strings.Repeat("[", maxMemoryDepth+1) + strings.Repeat("]", maxMemoryDepth+1) + `}`: 400,
		`{"daily_notes":[` + strings.Repeat(`{"content":"a"},`, maxMemoryNotes) + `{"content":"a"}]}`: 413,
		`{"bank":{"world":[` + strings.Repeat(`"a",`, maxMemoryParts) + `"a"]}}`:                      413,
		`{"x":[` + strings.Repeat(`0,`, maxMemoryValues) + `0]}`:                                      413,
	} {
		_, err := decodeMemory([]byte(in))
		me, ok := err.(*memoryError)
		if !ok || me.status != status {
			t.Errorf("%.40q: %v, want %d", in, err, status)
		}
	}
}

// ---- tokens: no database work for bad ones, a minute's cache for good ones ----

type countOwner struct {
	*memStore
	n atomic.Int64
}

func (s *countOwner) TokenOwner(ctx context.Context, h []byte) (string, int64, error) {
	s.n.Add(1)
	return s.memStore.TokenOwner(ctx, h)
}

func TestTokenChecksSpareTheDatabase(t *testing.T) {
	st := &countOwner{memStore: newMemStore()}
	acc := &accounts{store: st, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	a, _, _ := st.SignIn(context.Background(), "hackgt13", user{Sub: "s", Email: "a@b.c"})
	mux := http.NewServeMux()
	mountMuse(mux, acc, newHub(), "event.json", "https://site.test", func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	get := func(path, ip string) int {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if ip != "" {
			req.Header.Set("X-Forwarded-For", ip)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	// malformed: never looked up
	for i := 0; i < 300; i++ {
		if code := get(nowKeyPath+"gtq_garbage"+fmt.Sprint(i), "10.0.0.1"); code != 401 {
			t.Fatalf("garbage token: %d", code)
		}
	}
	if n := st.n.Load(); n != 0 {
		t.Fatalf("malformed tokens cost %d lookups", n)
	}
	// well-formed but unknown: an address gets a few, then waits
	limited := 0
	for i := 0; i < 100; i++ {
		if get(nowKeyPath+newToken(), "10.0.0.2") == http.StatusTooManyRequests {
			limited++
		}
	}
	if n := st.n.Load(); n > tokenMissBurst+2 || limited == 0 {
		t.Fatalf("100 unknown tokens from one address: %d lookups, %d limited", n, limited)
	}
	if code := get(nowKeyPath+newToken(), "10.0.0.3"); code != 401 {
		t.Fatalf("another address: %d", code)
	}
	// a good token is looked up once a minute, however often it's used (and its last_used with it)
	tok := newToken()
	st.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(tok))
	before := st.n.Load()
	for i := 0; i < 10; i++ {
		if code := get("/api/muse/v1/me?x=1", ""); code != 401 {
			t.Fatalf("no token: %d", code)
		}
		req, _ := http.NewRequest("GET", srv.URL+"/api/muse/v1/me", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		res, _ := http.DefaultClient.Do(req)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("good token: %d", res.StatusCode)
		}
	}
	if n := st.n.Load() - before; n != 1 {
		t.Fatalf("10 calls with one token: %d lookups", n)
	}
	// revoking it takes effect at once, cache or not
	v, exp := acc.sess.issue(kindSession, a.ID, time.Hour)
	req, _ := http.NewRequest("POST", srv.URL+"/api/muse/revoke", nil)
	req.Header.Set("Origin", "https://site.test")
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: v, Expires: exp})
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	req, _ = http.NewRequest("GET", srv.URL+"/api/muse/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("revoked token: %d", res.StatusCode)
	}
}

func TestNowIsRateLimitedPerToken(t *testing.T) {
	srv, _, _, _, tok := museServer(t)
	limited := 0
	for i := 0; i < nowTokenBurst+10; i++ {
		res, err := http.Get(srv.URL + nowKeyPath + tok)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode == http.StatusTooManyRequests {
			limited++
			if res.Header.Get("Retry-After") == "" {
				t.Fatal("429 without Retry-After")
			}
		} else if res.StatusCode != 200 {
			t.Fatalf("now: %d", res.StatusCode)
		}
	}
	if limited < 5 {
		t.Fatalf("%d calls in a burst: only %d limited", nowTokenBurst+10, limited)
	}
}

func TestTokenWellFormed(t *testing.T) {
	if !tokenWellFormed(newToken()) {
		t.Fatal("newToken isn't well formed")
	}
	for _, bad := range []string{"", "gtq_", "gtq_garbage", "gtqp_" + strings.Repeat("a", 43), "gtq_" + strings.Repeat("a", 42) + "!", "xyz_" + strings.Repeat("a", 43), "gtq_" + strings.Repeat("a", 44)} {
		if tokenWellFormed(bad) {
			t.Errorf("%q passed", bad)
		}
	}
}

// ---- database errors stay in the log ----

type deadAccountStore struct {
	*memStore
	pg *pgStore
}

func (s *deadAccountStore) Account(ctx context.Context, tenant string, id int64) (Account, error) {
	return s.pg.Account(ctx, tenant, id)
}

func TestAgentsNeverSeeDatabaseErrors(t *testing.T) {
	cfg, _ := pgxpool.ParseConfig("host=127.0.0.1 port=1 user=facemash_app database=facemash sslmode=disable connect_timeout=1")
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	mem := newMemStore()
	a, _, _ := mem.SignIn(context.Background(), "hackgt13", user{Sub: "s", Email: "a@b.c"})
	tok := newToken()
	mem.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(tok))
	acc := &accounts{store: &deadAccountStore{mem, &pgStore{pool: pool}}, tenant: "hackgt13"}
	mux := http.NewServeMux()
	mountMuse(mux, acc, newHub(), "event.json", "https://site.test", func(*http.Request) bool { return true })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/api/muse/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	_, out := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_my_profile"}}`)
	ob, _ := json.Marshal(out)
	for _, s := range []string{string(b), string(ob)} {
		for _, leak := range []string{"facemash_app", "127.0.0.1", "dial", "connect", "port"} {
			if strings.Contains(s, leak) {
				t.Fatalf("response leaks %q: %s", leak, s)
			}
		}
	}
	if res.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(ob), `"isError":true`) {
		t.Fatalf("REST %d %s / MCP %s", res.StatusCode, b, ob)
	}
	// a tool's own message for the agent still gets through
	if publicMessage(publicError("q is required")) != "q is required" {
		t.Fatal("publicError lost")
	}
}

// ---- the game's saves: batched, one writer ----

type batchCount struct {
	*memStore
	single            atomic.Int64
	batches, cur, max atomic.Int64
	rows              atomic.Int64
}

func (s *batchCount) SaveProgress(ctx context.Context, tenant string, id int64, p Progress) error {
	s.single.Add(1)
	return s.memStore.SaveProgress(ctx, tenant, id, p)
}

func (s *batchCount) SaveProgresses(ctx context.Context, tenant string, ps map[int64]Progress) error {
	n := s.cur.Add(1)
	if n > s.max.Load() {
		s.max.Store(n)
	}
	s.batches.Add(1)
	time.Sleep(20 * time.Millisecond)
	err := s.memStore.SaveProgresses(ctx, tenant, ps)
	s.cur.Add(-1)
	s.rows.Add(int64(len(ps)))
	return err
}

func TestSaveMovedIsBatched(t *testing.T) {
	st := &batchCount{memStore: newMemStore()}
	acct = &accounts{store: st, tenant: "hackgt13"}
	defer func() { acct = nil }()
	h := newHub()
	for i := 1; i <= 1000; i++ {
		st.SignIn(context.Background(), "hackgt13", user{Sub: fmt.Sprint(i), Email: fmt.Sprintf("u%d@x.y", i)})
		h.clients[i] = &client{hub: h, joined: true, uid: int64(i), p: Player{ID: i, Room: "campus", X: 5}}
	}
	before := runtime.NumGoroutine()
	h.saveMoved()
	spawned := runtime.NumGoroutine() - before
	mfWait(t, "1000 positions saved", func() bool { return st.rows.Load() == 1000 })
	t.Logf("goroutines spawned: %d; %d batch statements, at most %d at once", spawned, st.batches.Load(), st.max.Load())
	if spawned > 2 || st.max.Load() != 1 || st.batches.Load() != 1000/saveBatch || st.single.Load() != 0 {
		t.Fatalf("spawned %d, batches %d (max %d at once), single saves %d", spawned, st.batches.Load(), st.max.Load(), st.single.Load())
	}
	a, _ := st.Account(context.Background(), "hackgt13", 700)
	if a.Progress == nil || a.Progress.X != 5 {
		t.Fatalf("progress: %+v", a.Progress)
	}
}

// ---- slow upload bodies don't hold the slots ----

func TestSlowUploadsAreCutOff(t *testing.T) {
	oldWait, oldIdle, oldGrace := uploadSlotWait, uploadIdle, uploadGrace
	uploadSlotWait, uploadIdle, uploadGrace = 2*time.Second, 300*time.Millisecond, 300*time.Millisecond
	defer func() { uploadSlotWait, uploadIdle, uploadGrace = oldWait, oldIdle, oldGrace }()
	st := newMemStore()
	acc := &accounts{store: st, tenant: "hackgt13"}
	var toks []string
	for i := 0; i < 6; i++ {
		a, _, _ := st.SignIn(context.Background(), "hackgt13", user{Sub: fmt.Sprint(i), Email: fmt.Sprintf("u%d@x.y", i)})
		tk := newToken()
		st.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(tk))
		toks = append(toks, tk)
	}
	mux := http.NewServeMux()
	mountMuse(mux, acc, newHub(), "event.json", "https://site.test", func(*http.Request) bool { return true })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	stalled := make(chan int, 5)
	var pws []*io.PipeWriter
	for i := 0; i < 4; i++ { // four bodies that start and never finish
		pr, pw := io.Pipe()
		pws = append(pws, pw)
		req, _ := http.NewRequest("POST", srv.URL+memKeyPath+toks[i], pr)
		go func() {
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				stalled <- 0
				return
			}
			res.Body.Close()
			stalled <- res.StatusCode
		}()
		pw.Write([]byte(`{"memory_md":"`))
	}
	// and one that trickles a byte at a time, never going idle
	pr, pw := io.Pipe()
	pws = append(pws, pw)
	go func() {
		pw.Write([]byte(`{"memory_md":"`))
		for i := 0; i < 40; i++ {
			time.Sleep(50 * time.Millisecond)
			if _, err := pw.Write([]byte("a")); err != nil {
				return
			}
		}
	}()
	go func() {
		req, _ := http.NewRequest("POST", srv.URL+memKeyPath+toks[4], pr)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			stalled <- 0
			return
		}
		res.Body.Close()
		stalled <- res.StatusCode
	}()
	defer func() {
		for _, pw := range pws {
			pw.Close()
		}
	}()
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	res, err := http.Post(srv.URL+memKeyPath+toks[5], "application/json", strings.NewReader(`{"memory_md":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	t.Logf("6th person's small upload with 4 stalled and 1 trickling: %d %s after %v", res.StatusCode, strings.TrimSpace(string(b)), time.Since(start).Round(time.Millisecond))
	if res.StatusCode != 200 {
		t.Fatalf("small upload behind slow ones: %d %s", res.StatusCode, b)
	}
	for i := 0; i < 5; i++ {
		select {
		case code := <-stalled:
			if code != http.StatusRequestTimeout && code != 0 {
				t.Errorf("a slow upload got %d", code)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("a slow upload was never cut off")
		}
	}
}

// ---- jev: "delete my memory" wins over a suggestion still being made ----

type jevSlowRT struct{}

func (jevSlowRT) RoundTrip(r *http.Request) (*http.Response, error) {
	time.Sleep(300 * time.Millisecond)
	body := `{"answers":{"hat":{"choice":"crown"},"item":{"choice":"laptop"},"eyes":{"choice":"happy"},"pattern":{"choice":"solid"},"body":{"choice":"blue"},"accent":{"choice":"gold"}}}`
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
}

func TestJevSuggestionDoesNotOutliveDelete(t *testing.T) {
	j := &jevLook{key: "k", http: &http.Client{Transport: jevSlowRT{}}, sem: make(chan struct{}, 2), byID: map[string]suggestedLook{}}
	j.suggest("hackgt13", 7, map[string]any{"user_md": "I love winning hackathons"})
	time.Sleep(50 * time.Millisecond)
	j.forget(context.Background(), "hackgt13", 7) // "delete my memory", mid-request
	time.Sleep(500 * time.Millisecond)
	if s, ok := j.get(context.Background(), "hackgt13", 7); ok {
		t.Fatalf("after delete: suggestion %q", s.Look)
	}
	// a new upload after the delete gets its outfit as usual
	j.suggest("hackgt13", 7, map[string]any{"user_md": "I love winning hackathons"})
	mfWait(t, "the new suggestion", func() bool { _, ok := j.get(context.Background(), "hackgt13", 7); return ok })
}

// ---- the database down at boot: routes mounted, 503 until it's up ----

func TestGateWhileDatabaseIsDown(t *testing.T) {
	acc := &accounts{store: newMemStore(), tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	acc.dbDown.Store(true)
	h := acc.gate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(299) }))
	signedIn, _ := acc.sess.issue(kindSession, 1, time.Hour)
	try := func(path string, cookie bool) int {
		req := httptest.NewRequest("POST", path, nil)
		if cookie {
			req.AddCookie(&http.Cookie{Name: sessionCookie, Value: signedIn})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code == 503 && (!strings.Contains(w.Body.String(), "temporarily unavailable") || w.Header().Get("Retry-After") == "") {
			t.Fatalf("%s: %s", path, w.Body)
		}
		return w.Code
	}
	for _, p := range []string{"/api/auth/google", "/api/profile", "/api/muse/token", "/api/mcp", "/api/mcp/t/x", "/api/now", "/api/now/t/x", "/api/memory/t/x", "/api/ask", "/api/look/suggested", "/api/voice/start"} {
		if code := try(p, false); code != 503 {
			t.Errorf("%s while down: %d", p, code)
		}
	}
	if try("/api/me", true) != 503 || try("/api/me", false) != 299 {
		t.Error("/api/me: signed in needs the database, signed out doesn't")
	}
	for _, p := range []string{"/", "/ws", "/api/online", "/api/event", "/api/memoryx", "/assets/x.js"} {
		if code := try(p, false); code != 299 {
			t.Errorf("%s while down: %d", p, code)
		}
	}
	acc.dbDown.Store(false)
	if code := try("/api/auth/google", false); code != 299 {
		t.Errorf("after coming up: %d", code)
	}
}

// Postgres settings are turned into a pool without dialling, so a boot with the database
// down doesn't turn sign-in off; connect then keeps trying in the background.
func TestPostgresPoolIsLazy(t *testing.T) {
	start := time.Now()
	s, err := newPostgres(dbTarget{Host: "127.0.0.1", User: "nobody", DB: "nothing"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if time.Since(start) > time.Second || s.pool.Config().MaxConns != dbMaxConns {
		t.Fatalf("newPostgres took %v, pool %d", time.Since(start), s.pool.Config().MaxConns)
	}
	// and the schema never drops a constraint unguarded (a boot would take users' exclusive lock)
	for _, line := range strings.Split(schema, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "ALTER TABLE users DROP CONSTRAINT IF EXISTS") {
			t.Fatalf("unguarded: %s", line)
		}
	}
	if !strings.Contains(schema, "FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_google_sub_key'") {
		t.Fatal("the constraint drop isn't checked first")
	}
}

// With the memory store, connect is immediate and starts the index's workers.
func TestConnectMemoryStore(t *testing.T) {
	acc := &accounts{store: newMemStore(), tenant: "hackgt13"}
	acc.connect()
	if !acc.waitReady(time.Second) || acc.dbDown.Load() {
		t.Fatal("memory store not ready")
	}
}

// The one-allocation string decoder and encoder agree with encoding/json.
func TestMemoryJSONCodec(t *testing.T) {
	for _, in := range []string{
		`""`, `"plain"`, `"line\nbreak\ttab\r\\ \" \/ \b\f"`, `"\u00e9\u4e2d\ud83d\ude00"`, `"lone \ud800 surrogate"`, `"bad \udc00\u0041"`,
		`"raw ütf-8 中文 😀"`, "\"invalid \xff\xfe bytes\"", `"\u2028\u2029 and <html> & stuff"`, `"ctrl \u0001\u001f"`,
	} {
		want := ""
		json.Unmarshal([]byte(in), &want)
		got, ok := jsonUnquote([]byte(in))
		if !ok || got != want {
			t.Errorf("unquote %q: got %q want %q", in, got, want)
		}
		v := map[string]any{"k\n": got, "list": []any{got, "x"}, "m": map[string]any{"z": got}}
		b, err := marshalMemory(v)
		if err != nil || !json.Valid(b) {
			t.Fatalf("marshal %q: %s %v", in, b, err)
		}
		n, _ := jsonSize(v)
		var back any
		json.Unmarshal(b, &back)
		std, _ := json.Marshal(v)
		var stdBack any
		json.Unmarshal(std, &stdBack)
		if fmt.Sprint(back) != fmt.Sprint(stdBack) || len(b) > n {
			t.Errorf("marshal %q: %s (size %d, bound %d) vs %s", in, b, len(b), n, std)
		}
	}
}
