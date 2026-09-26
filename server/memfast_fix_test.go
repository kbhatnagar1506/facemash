package main

// Regression tests for the fast track's review and audit findings: each one failed on
// a0be638 (scratchpad review_test.go / zz_audit*_test.go) and states the fixed behaviour.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------- splitting: linear, and the caps stop it ----------

func TestFastSplitCostIsBounded(t *testing.T) {
	measure := func(name string, obj map[string]any, maxDur time.Duration, maxAllocMB uint64) {
		t.Helper()
		runtime.GC()
		var a, b runtime.MemStats
		runtime.ReadMemStats(&a)
		start := time.Now()
		items, _ := fastSplit(obj)
		d := time.Since(start)
		runtime.ReadMemStats(&b)
		alloc := (b.TotalAlloc - a.TotalAlloc) >> 20
		t.Logf("%s: %v, %d MB allocated, %d items", name, d, alloc, len(items))
		if d > maxDur || alloc > maxAllocMB || len(items) > fastMaxItems {
			t.Errorf("%s: %v (max %v), %d MB (max %d), %d items", name, d, maxDur, alloc, maxAllocMB, len(items))
		}
	}
	// a single 8 MB line: 61 s before (each 3.9k-rune step re-copied the rest of the line)
	measure("8 MB single line", map[string]any{"memory_md": strings.Repeat("a", 8<<20)}, time.Second, 200)
	// 20 MB of tiny headings: 2.3 GB and 1.7M items built before the cap kept 500
	var sb strings.Builder
	for i := 0; sb.Len() < 20<<20; i++ {
		fmt.Fprintf(&sb, "# h%d\nx\n", i)
	}
	measure("20 MB of headings", map[string]any{"memory_md": sb.String()}, time.Second, 200)
	// 700k one-word daily notes: 812 MB before
	notes := make([]any, 700000)
	for i := range notes {
		notes[i] = map[string]any{"date": fmt.Sprintf("n%d", i), "content": "x"}
	}
	measure("700k daily notes", map[string]any{"daily_notes": notes}, time.Second, 100)
	// many paragraphs of one character each (rune counts must not be recomputed per add)
	measure("4 MB of tiny paragraphs", map[string]any{"memory_md": strings.Repeat("b\n\n", (4<<20)/3)}, time.Second, 200)
}

// The upload handler no longer splits at all: a 3 MB single-line memory_md held the request
// for 9.8 s before, 9 s of it splitting. What's left is the redaction guardrail (linear).
func TestFastUploadHandlerDoesNotSplit(t *testing.T) {
	e := mfSetup(t)
	mem := map[string]any{"memory_md": strings.Repeat("z", 3<<20)}
	start := time.Now()
	redactJSON(map[string]any{"memory_md": mem["memory_md"]}, map[string]int{})
	redact := time.Since(start)
	start = time.Now()
	e.upload(t, e.tok, mem)
	if d := time.Since(start); d > 2*redact+time.Second {
		t.Fatalf("POST /api/memory with a 3 MB line took %v (redacting it alone: %v)", d, redact)
	}
	mfIdle(t, e.fast)
}

// ---------- uploads: one at a time per person, a rate, and a global cap ----------

func TestFastUploadLimits(t *testing.T) {
	e := mfSetup(t)
	post := func(tok string) (int, string) {
		res, err := http.Post(e.srv.URL+"/api/memory/t/"+tok, "application/json", strings.NewReader(`{"user_md":"hi"}`))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode, res.Header.Get("Retry-After")
	}
	for i := 0; i < uploadBurst; i++ {
		if code, _ := post(e.tok); code != 200 {
			t.Fatalf("upload %d of the burst: %d", i+1, code)
		}
	}
	code, retry := post(e.tok)
	if code != http.StatusTooManyRequests || retry == "" {
		t.Fatalf("upload past the burst: %d (Retry-After %q)", code, retry)
	}
	// someone else is unaffected
	if _, tok2 := e.person(t, "two@gatech.edu"); true {
		if code, _ := post(tok2); code != 200 {
			t.Fatalf("another person's upload: %d", code)
		}
	}

	// one in flight per person: a second upload while the first is still being read is refused
	_, tok3 := e.person(t, "three@gatech.edu")
	pr, pw := io.Pipe()
	done := make(chan int)
	go func() {
		res, err := http.Post(e.srv.URL+"/api/memory/t/"+tok3, "application/json", pr)
		if err != nil {
			done <- 0
			return
		}
		res.Body.Close()
		done <- res.StatusCode
	}()
	pw.Write([]byte(`{"user_md":"`)) // the first upload is now in the handler, reading
	time.Sleep(100 * time.Millisecond)
	if code, _ := post(tok3); code != http.StatusTooManyRequests {
		t.Fatalf("concurrent upload by the same person: %d", code)
	}
	pw.Write([]byte(`slow"}`))
	pw.Close()
	if code := <-done; code != 200 {
		t.Fatalf("the slow upload: %d", code)
	}

	// at most uploadsAtOnce being read at once, whoever sends them; the next waits, then "busy"
	defer func(w time.Duration) { uploadSlotWait = w }(uploadSlotWait)
	uploadSlotWait = 300 * time.Millisecond
	var writers []*io.PipeWriter
	var codes []chan int
	for i := 0; i < uploadsAtOnce; i++ {
		_, tok := e.person(t, fmt.Sprintf("slow%d@gatech.edu", i))
		pr, pw := io.Pipe()
		ch := make(chan int, 1)
		go func() {
			res, err := http.Post(e.srv.URL+"/api/memory/t/"+tok, "application/json", pr)
			if err != nil {
				ch <- 0
				return
			}
			res.Body.Close()
			ch <- res.StatusCode
		}()
		pw.Write([]byte(`{"user_md":"`))
		writers, codes = append(writers, pw), append(codes, ch)
	}
	time.Sleep(150 * time.Millisecond)
	_, tok4 := e.person(t, "four@gatech.edu")
	if code, retry := post(tok4); code != http.StatusServiceUnavailable || retry == "" {
		t.Fatalf("upload while %d others are being read: %d (Retry-After %q)", uploadsAtOnce, code, retry)
	}
	// one that finds the slots full but a slot frees up while it waits goes through
	_, tok5 := e.person(t, "five@gatech.edu")
	waited := make(chan int, 1)
	go func() { code, _ := post(tok5); waited <- code }()
	time.Sleep(50 * time.Millisecond)
	for i, pw := range writers {
		pw.Write([]byte(`x"}`))
		pw.Close()
		if code := <-codes[i]; code != 200 {
			t.Fatalf("slow upload %d: %d", i, code)
		}
	}
	if code := <-waited; code != 200 {
		t.Fatalf("upload that waited for a slot: %d", code)
	}
	if code, _ := post(tok4); code != 200 {
		t.Fatalf("upload once the others are done: %d", code)
	}
	mfIdle(t, e.fast)
}

// ---------- asking: batches, rate and in-flight caps ----------

// One MCP POST (64 KB) carried 520 ask_my_memory calls, each a MAPI search.
func TestFastMCPBatchCapsToolCalls(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	var batch []string
	for i := 0; ; i++ {
		c := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"ask_my_memory","arguments":{"q":"unique question %06d"}}}`, i, i)
		if len(strings.Join(batch, ","))+len(c)+3 > maxMCPBody {
			break
		}
		batch = append(batch, c)
	}
	batch = append([]string{`{"jsonrpc":"2.0","id":"p","method":"ping"}`}, batch...)
	before := e.fake.count("R POST spaces/*/search")
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/mcp/t/"+e.tok, strings.NewReader("["+strings.Join(batch, ",")+"]"))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	res.Body.Close()
	searches := e.fake.count("R POST spaces/*/search") - before
	refused := 0
	for _, o := range out {
		if o["error"] != nil {
			refused++
		}
	}
	if searches > maxBatchCalls || len(out) != len(batch) || refused != len(batch)-1-maxBatchCalls || out[0]["result"] == nil {
		t.Fatalf("batch of %d calls: %d MAPI searches, %d answers, %d refused", len(batch)-1, searches, len(out), refused)
	}
}

func TestFastAskRateLimited(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	before := e.fake.count("R POST spaces/*/search")
	limited := 0
	for i := 0; i < fastAskBurst+10; i++ {
		if out := e.ask(t, e.tok, fmt.Sprintf("rust %d", i)); out["status"] == "rate_limited" {
			limited++
		}
	}
	if n := e.fake.count("R POST spaces/*/search") - before; limited < 5 || n > fastAskBurst+2 {
		t.Fatalf("%d rapid asks: %d rate limited, %d MAPI searches", fastAskBurst+10, limited, n)
	}
	// someone else still gets answers
	_, tok2 := e.person(t, "two@gatech.edu")
	e.upload(t, tok2, map[string]any{"user_md": "likes rust too"})
	mfIdle(t, e.fast)
	if out := e.ask(t, tok2, "rust"); out["status"] != "ok" {
		t.Fatalf("another person's ask: %v", out)
	}
	// in flight: while fastAskInFlight asks wait on a hanging MAPI, the next is refused at once
	e.fake.mu.Lock()
	e.fake.hang = true
	e.fake.mu.Unlock()
	e.fast.askTimeout = 600 * time.Millisecond
	e.fast.asks = newKeyLimiter(100, time.Millisecond, fastAskInFlight)
	var wg sync.WaitGroup
	for i := 0; i < fastAskInFlight; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); e.ask(t, tok2, "rust") }()
	}
	mfWait(t, "the hanging searches", func() bool { return e.fake.count("R POST spaces/*/search") >= before+fastAskBurst+1+fastAskInFlight })
	start := time.Now()
	if out := e.ask(t, tok2, "rust"); out["status"] != "rate_limited" || time.Since(start) > 300*time.Millisecond {
		t.Fatalf("ask with %d searches in flight: %v", fastAskInFlight, out)
	}
	wg.Wait()
	// giving up on a search cancels it, so its slot comes back
	e.fake.mu.Lock()
	e.fake.hang = false
	e.fake.mu.Unlock()
	if out := e.ask(t, tok2, "rust"); out["status"] != "ok" {
		t.Fatalf("ask once the others gave up: %v", out)
	}
}

// A global cap on searches in flight toward MAPI: past it, an ask says busy at its deadline.
func TestFastSearchSlots(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	for i := 0; i < cap(e.fast.searches); i++ {
		e.fast.searches <- struct{}{}
	}
	e.fast.askTimeout = 150 * time.Millisecond
	before := e.fake.count("R POST spaces/*/search")
	if out := e.ask(t, e.tok, "rust"); out["status"] != "busy" || e.fake.count("R POST spaces/*/search") != before {
		t.Fatalf("ask with every search slot taken: %v", out)
	}
	for i := 0; i < cap(e.fast.searches); i++ {
		<-e.fast.searches
	}
	if out := e.ask(t, e.tok, "rust"); out["status"] != "ok" {
		t.Fatalf("ask once slots are free: %v", out)
	}
}

// ---------- workers: more of them, and a big sync takes turns ----------

func TestFastThirdUploaderDoesNotWaitBehindTwo(t *testing.T) {
	e := mfSetup(t)
	block := make(chan struct{})
	e.fake.mu.Lock()
	e.fake.block = block
	e.fake.mu.Unlock()
	_, tok2 := e.person(t, "two@gatech.edu")
	_, tok3 := e.person(t, "three@gatech.edu")
	e.upload(t, e.tok, mfMemory())
	e.upload(t, tok2, mfMemory())
	mfWait(t, "two syncs writing", func() bool { return e.fake.count("W POST spaces/*/memories/bulk") == 2 })
	e.upload(t, tok3, map[string]any{"user_md": "tiny"})
	mfWait(t, "the third person's sync to start", func() bool { return e.fake.count("W POST spaces/*/memories/bulk") == 3 })
	close(block)
	mfIdle(t, e.fast)
	if out := e.ask(t, tok3, "tiny"); out["status"] != "ok" {
		t.Fatalf("third person: %v", out)
	}
}

// mfOneWorker swaps e's service for one with a single worker.
func mfOneWorker(t *testing.T, e *mfEnv) *memFast {
	e.fast.close()
	f := newMemFast(e.store, mfClient(e.fake))
	f.retryBase, f.retryMax, f.sweepEvery = 20*time.Millisecond, 100*time.Millisecond, 50*time.Millisecond
	f.start(1)
	t.Cleanup(f.close)
	e.acc.fast, e.fast = f, f
	return f
}

// Even with one worker, a 1-section upload waits for one batch of a big one, not all of it.
func TestFastBigSyncTakesTurns(t *testing.T) {
	e := mfSetup(t)
	f := mfOneWorker(t, e)
	e.fake.mu.Lock()
	e.fake.slow = 40 * time.Millisecond // each batch takes a while, as live (0.5 s a section)
	e.fake.mu.Unlock()
	var sb strings.Builder
	for i := 0; i < 5*fastBatch; i++ {
		fmt.Fprintf(&sb, "## Section %d\nnote %d\n\n", i, i)
	}
	e.upload(t, e.tok, map[string]any{"memory_md": sb.String()})
	mfWait(t, "the big sync's first batch", func() bool { return e.fake.count("W POST spaces/*/memories/bulk") == 1 })
	_, tok2 := e.person(t, "small@gatech.edu")
	e.upload(t, tok2, map[string]any{"user_md": "small and quick"})
	var bigDone int
	mfWait(t, "the small upload in the index", func() bool {
		got := e.fake.contents("")
		bigDone = len(got)
		return strings.Contains(strings.Join(got, "|"), "small and quick")
	})
	if bigDone-1 > 2*fastBatch {
		t.Fatalf("the small sync waited for %d sections of the big one", bigDone-1)
	}
	mfIdle(t, f)
	if n := len(e.fake.contents("")); n != 5*fastBatch+1 {
		t.Fatalf("memories after both: %d", n)
	}
}

// ---------- durability: a lost or failed sync heals ----------

func TestFastRestartMidSyncHeals(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, map[string]any{"memory_md": "## Coffee\nMy usual coffee order is a cortado.\n\n## Pets\nA cat named Pistachio."})
	mfIdle(t, e.fast)
	var mu sync.Mutex
	down := true
	e.fake.mu.Lock()
	e.fake.fail = func(side, op string) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		if down && op == "POST spaces/*/memories/bulk" {
			return 503, ""
		}
		return 0, ""
	}
	e.fake.mu.Unlock()
	e.upload(t, e.tok, map[string]any{"memory_md": "## Coffee\nMy usual coffee order is a flat white.\n\n## Pets\nA cat named Pistachio."})
	mfWait(t, "the old coffee section to be erased", func() bool { return len(e.fake.erasedIDs()) == 1 })
	e.fast.close() // the game container restarts
	mu.Lock()
	down = false
	mu.Unlock()
	f2 := mfService(e.store, e.fake) // the new process, same database
	defer f2.close()
	e.acc.fast = f2
	mfWait(t, "the edited section back in the index", func() bool {
		return strings.Contains(strings.Join(e.fake.contents(""), "\n"), "flat white")
	})
	mfIdle(t, f2)
	if st, _ := e.store.fastSyncState(context.Background(), "hackgt13", e.id); st.dirty != nil {
		t.Fatal("outbox marker left after a successful sync")
	}
	if got := strings.Join(e.fake.contents(""), "\n"); strings.Contains(got, "cortado") || !strings.Contains(got, "Pistachio") {
		t.Fatalf("index after healing: %q", got)
	}
}

func TestFastFailedSyncIsNeverDropped(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, map[string]any{"memory_md": "## Coffee\nMy usual coffee order is a cortado."})
	mfIdle(t, e.fast)
	var mu sync.Mutex
	down := true
	e.fake.mu.Lock()
	e.fake.fail = func(side, op string) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		if down && op == "POST spaces/*/memories/bulk" {
			return 422, "" // not retried by the client: the job-level retry runs
		}
		return 0, ""
	}
	e.fake.mu.Unlock()
	e.upload(t, e.tok, map[string]any{"memory_md": "## Coffee\nMy usual coffee order is a flat white."})
	mfWait(t, "8 failed bulk writes", func() bool { return e.fake.count("W POST spaces/*/memories/bulk") >= 9 })
	mu.Lock()
	down = false // MAPI is healthy again
	mu.Unlock()
	mfWait(t, "the coffee section back", func() bool { return e.ask(t, e.tok, "coffee order")["status"] == "ok" })
}

// A delete between the upload's SaveMemory and its uploaded() must win.
type slowSave struct {
	*memStore
	saved, release chan struct{}
}

func (s *slowSave) SaveMemory(ctx context.Context, tenant string, id int64, body []byte, exp *time.Time) (time.Time, error) {
	at, err := s.memStore.SaveMemory(ctx, tenant, id, body, exp)
	if s.saved != nil {
		close(s.saved)
		<-s.release
		s.saved = nil
	}
	return at, err
}

func TestFastDeleteRacingUploadStaysDeleted(t *testing.T) {
	fake := newMfFake(t)
	ms := newMemStore()
	st := &slowSave{memStore: ms, saved: make(chan struct{}), release: make(chan struct{})}
	acc := &accounts{store: st, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	a, _, _ := ms.SignIn(context.Background(), "hackgt13", user{Sub: "g-1", Email: "buzz@gatech.edu"})
	tok := newToken()
	ms.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(tok))
	acc.fast = mfService(ms, fake)
	defer acc.fast.close()
	mux := http.NewServeMux()
	mountMuse(mux, acc, newHub(), "event.json", "https://site.test", func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	done := make(chan int)
	go func() {
		res, err := http.Post(srv.URL+"/api/memory/t/"+tok, "application/json", strings.NewReader(`{"memory_md":"## Secret\nI am quietly job hunting."}`))
		if err != nil {
			done <- 0
			return
		}
		res.Body.Close()
		done <- res.StatusCode
	}()
	<-st.saved // agent_memory has it; uploaded() hasn't run yet
	v, exp := acc.sess.issue(kindSession, a.ID, time.Hour)
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/muse/memory", nil)
	req.Header.Set("Origin", "https://site.test")
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: v, Expires: exp})
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 204 {
		t.Fatalf("delete: %v %v", err, res)
	}
	close(st.release)
	<-done
	time.Sleep(200 * time.Millisecond) // several sweeps
	mfIdle(t, acc.fast)
	if got := fake.contents(""); len(got) != 0 {
		t.Fatalf("the person deleted their memory but the index holds %q", got)
	}
	// and an upload after the delete is indexed as usual
	res, _ = http.Post(srv.URL+"/api/memory/t/"+tok, "application/json", strings.NewReader(`{"user_md":"back again"}`))
	res.Body.Close()
	mfWait(t, "the new upload indexed", func() bool { return len(fake.contents("")) == 1 })
}

// The sync that was queued before a delete reads nothing the delete removed, even when the
// delete's DeleteMemory hasn't run yet (the upload is older than the purge marker).
func TestFastSyncSkipsUploadOlderThanDelete(t *testing.T) {
	e := mfSetup(t)
	mfOneWorker(t, e) // busy with someone else's sync while this person uploads and deletes
	block := make(chan struct{})
	e.fake.mu.Lock()
	e.fake.block = block
	e.fake.mu.Unlock()
	_, tok2 := e.person(t, "two@gatech.edu")
	e.upload(t, tok2, map[string]any{"user_md": "keeps a worker busy"})
	mfWait(t, "the other sync writing", func() bool { return e.fake.count("W POST spaces/*/memories/bulk") == 1 })
	e.upload(t, e.tok, map[string]any{"user_md": "a secret, about to be deleted"})
	if err := e.fast.forget(context.Background(), "hackgt13", e.id); err != nil {
		t.Fatal(err)
	}
	close(block)
	mfIdle(t, e.fast)
	if got := strings.Join(e.fake.contents(""), "|"); strings.Contains(got, "secret") || e.fake.count("W POST spaces/*/memories/bulk") != 1 {
		t.Fatalf("an upload older than the delete got indexed: %q", got)
	}
}

// ---------- relevance ----------

func TestFastWeakMatch(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	e.fake.mu.Lock()
	e.fake.nearest = true // like MAPI: the nearest sections come back, whatever the question
	e.fake.mu.Unlock()
	out := e.ask(t, e.tok, "asdfgh qwerty zxcv")
	if out["status"] != "weak_match" || !strings.Contains(fmt.Sprint(out["note"]), "say you don't know") || out["count"].(float64) == 0 {
		t.Fatalf("gibberish: %v", out)
	}
	if m, _ := out["top_match"].(map[string]any); m["lexical"] != nil || m["vector"].(float64) >= fastWeakVector {
		t.Fatalf("top_match: %v", out["top_match"])
	}
	if out := e.ask(t, e.tok, "what rust project am I building"); out["status"] != "ok" {
		t.Fatalf("a real question: %v", out)
	}
	v := func(x float64) *float64 { return &x }
	for _, c := range []struct {
		h    fastHit
		weak bool
	}{
		{fastHit{VectorScore: v(0.74), LexicalScore: v(0.1)}, false},
		{fastHit{VectorScore: v(0.70)}, false},                        // no shared word, close in meaning (a typo'd question)
		{fastHit{VectorScore: v(0.55), LexicalScore: v(0.05)}, false}, // shares a word
		{fastHit{VectorScore: v(0.58)}, true},
		{fastHit{}, true},
	} {
		if fastWeak(&c.h) != c.weak {
			t.Errorf("fastWeak(%+v) = %v", c.h, !c.weak)
		}
	}
}

// ---------- the one-paste prompt keeps the MCP fallback ----------

func TestFastOnePastePromptKeepsScheduleFallback(t *testing.T) {
	info := map[string]any{"memory_url": "https://d/api/memory/t/gtq_x", "prompt": connectorPrompt("https://b", "gtq_x")}
	(&memFast{}).prompts(info, "https://b", "gtq_x")
	p := info["prompt"].(string)
	for _, want := range []string{"https://b" + mcpKeyPath + "gtq_x", "get_schedule", "when=all", "https://d/api/memory/t/gtq_x", "weak_match"} {
		if !strings.Contains(p, want) {
			t.Errorf("one-paste prompt is missing %q:\n%s", want, p)
		}
	}
}

// ---------- Postgres: schema convergence and the account-delete trigger ----------

// mfScratchPostgres: a pgStore in a fresh schema of the database FASTPG_DSN names (password in
// FASTPG_PWFILE), with the game's tables and the tenant, dropped when the test ends.
func mfScratchPostgres(t *testing.T) (*pgStore, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("FASTPG_DSN")
	if dsn == "" {
		t.Skip("FASTPG_DSN not set")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if f := os.Getenv("FASTPG_PWFILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		cfg.ConnConfig.Password = strings.TrimSpace(string(b))
	}
	b := make([]byte, 4)
	rand.Read(b)
	schemaName := "fm_test_" + hex.EncodeToString(b)
	admin, err := pgx.ConnectConfig(ctx, cfg.ConnConfig.Copy())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schemaName); err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schemaName
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+schemaName+" CASCADE"); err != nil {
			t.Errorf("drop %s: %v", schemaName, err)
		}
		admin.Close(context.Background())
	})
	if _, err := pool.Exec(ctx, schema); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tenants (id, name) VALUES ('hackgt13', 'HackGT 13')`); err != nil {
		t.Fatal(err)
	}
	return &pgStore{pool: pool}, pool
}

// What a0be638 created on production facemash-db.
const fastSchemaA0be638 = `
CREATE TABLE IF NOT EXISTS mapi_spaces (
  tenant_id text NOT NULL, user_id bigint NOT NULL, space_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS mapi_items (
  tenant_id text NOT NULL, user_id bigint NOT NULL,
  space_kind text NOT NULL CHECK (space_kind IN ('private', 'directory')), key text NOT NULL,
  sha256 bytea NOT NULL, memory_id text, synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, space_kind, key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS mapi_purges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id text NOT NULL, user_id bigint NOT NULL,
  scope text NOT NULL CHECK (scope IN ('private', 'directory', 'all')), space_id text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(), done_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(), error text);
CREATE INDEX IF NOT EXISTS mapi_purges_due ON mapi_purges(next_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS mapi_purges_open ON mapi_purges(tenant_id, user_id) WHERE done_at IS NULL;
`

func TestFastSchemaConvergesWithFullBuild(t *testing.T) {
	s, pool := mfScratchPostgres(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, fastSchemaA0be638); err != nil { // production as it is now
		t.Fatal(err)
	}
	a, _, err := s.SignIn(ctx, "hackgt13", user{Sub: "pg-1", Email: "one@gatech.edu"})
	if err != nil {
		t.Fatal(err)
	}
	s.SaveMemory(ctx, "hackgt13", a.ID, []byte(`{"user_md":"x"}`), nil)
	s.fastSetSpace(ctx, "hackgt13", a.ID, "spc_indexed")
	b, _, _ := s.SignIn(ctx, "hackgt13", user{Sub: "pg-2", Email: "two@gatech.edu"})
	s.SaveMemory(ctx, "hackgt13", b.ID, []byte(`{"user_md":"never indexed"}`), nil)
	for i := 0; i < 2; i++ { // this deploy's boot, twice (idempotent)
		if err := s.fastEnsureSchema(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// the full build's DDL (mapi-integration:server/mapistore.go) finds what it expects
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS mapi_items (tenant_id text NOT NULL, user_id bigint NOT NULL,
		  space_kind text NOT NULL CHECK (space_kind IN ('private', 'directory')), key text NOT NULL,
		  sha256 bytea NOT NULL, memory_id text, keyed boolean NOT NULL DEFAULT false,
		  synced_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, user_id, space_kind, key))`,
		`SELECT key, sha256, coalesce(memory_id, ''), keyed FROM mapi_items`,
		`INSERT INTO mapi_purges (tenant_id, user_id, scope, space_id) VALUES ('hackgt13', 0, 'event', 'spc_x')`,
		`INSERT INTO mapi_outbox (tenant_id, user_id) VALUES ('hackgt13', ` + fmt.Sprint(a.ID) + `)
		  ON CONFLICT (tenant_id, user_id) DO UPDATE SET dirty_at = now(), next_at = least(mapi_outbox.next_at, now())`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatalf("full build's %q: %v", strings.Fields(q)[0]+" "+strings.Fields(q)[1], err)
		}
	}
	// the new outbox was filled with everyone already indexed (and nobody else)
	syncs, err := s.fastPendingSyncs(ctx)
	if err != nil || len(syncs) != 1 || syncs[0].id != a.ID {
		t.Fatalf("outbox after the first boot: %v %v", syncs, err)
	}
}

func TestFastAccountDeleteLeavesPurgeMarker(t *testing.T) {
	s, pool := mfScratchPostgres(t)
	ctx := context.Background()
	if err := s.fastEnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	a, _, _ := s.SignIn(ctx, "hackgt13", user{Sub: "pg-1", Email: "gone@gatech.edu"})
	b, _, _ := s.SignIn(ctx, "hackgt13", user{Sub: "pg-2", Email: "stays@gatech.edu"})
	s.fastSetSpace(ctx, "hackgt13", a.ID, "spc_gone")
	s.fastPutItems(ctx, "hackgt13", a.ID, []fastRow{{"k", []byte{1}, "mem_1"}})
	s.fastSetSpace(ctx, "hackgt13", b.ID, "spc_stays")
	// deleted by hand, as the privacy policy's "email the operator" path does
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, a.ID); err != nil {
		t.Fatal(err)
	}
	pend, err := s.fastPendingPurges(ctx)
	if err != nil || len(pend) != 1 || pend[0].id != a.ID {
		t.Fatalf("pending purges after the delete: %v %v", pend, err)
	}
	marks, spaces, err := s.fastPurges(ctx, "hackgt13", a.ID)
	if err != nil || len(marks) != 1 || len(spaces) != 1 || spaces[0] != "spc_gone" {
		t.Fatalf("purge: %v %v %v", marks, spaces, err)
	}
	// the purge then runs without a membership, and closes its marker
	fake := newMfFake(t)
	fake.spaces["spc_gone"] = fmt.Sprintf("u-%d", a.ID)
	fake.mems["mem_1"] = &mfMem{id: "mem_1", space: "spc_gone", content: "gone"}
	f := mfService(s, fake)
	defer f.close()
	mfWait(t, "the purge", func() bool { p, _ := s.fastPendingPurges(ctx); return len(p) == 0 })
	f.close()
	if len(fake.contents("")) != 0 || len(fake.spaces) != 0 {
		t.Fatalf("after purge: %v %v", fake.contents(""), fake.spaces)
	}
	// a tenant delete cascades the same way
	if _, err := pool.Exec(ctx, `DELETE FROM tenants WHERE id = 'hackgt13'`); err != nil {
		t.Fatal(err)
	}
	if _, spaces, _ := s.fastPurges(ctx, "hackgt13", b.ID); len(spaces) != 1 || spaces[0] != "spc_stays" {
		t.Fatalf("tenant delete: %v", spaces)
	}
}

func TestFastPostgresOutbox(t *testing.T) {
	s, _ := mfScratchPostgres(t)
	ctx := context.Background()
	if err := s.fastEnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	a, _, _ := s.SignIn(ctx, "hackgt13", user{Sub: "pg-1", Email: "out@gatech.edu"})
	if st, err := s.fastSyncState(ctx, "hackgt13", a.ID); err != nil || st.dirty != nil || st.received != nil || st.purged != nil {
		t.Fatalf("empty: %+v %v", st, err)
	}
	s.SaveMemory(ctx, "hackgt13", a.ID, []byte(`{"user_md": "v1"}`), nil)
	if err := s.fastMarkDirty(ctx, "hackgt13", a.ID); err != nil {
		t.Fatal(err)
	}
	st, err := s.fastSyncState(ctx, "hackgt13", a.ID)
	if err != nil || st.dirty == nil || st.received == nil || st.purged != nil {
		t.Fatalf("after upload: %+v %v", st, err)
	}
	data, err := s.fastMemoryData(ctx, "hackgt13", a.ID, *st.received)
	if err != nil || !strings.Contains(string(data), "v1") {
		t.Fatalf("data: %q %v", data, err)
	}
	if data, _ := s.fastMemoryData(ctx, "hackgt13", a.ID, st.received.Add(-time.Second)); data != nil {
		t.Fatal("data for another upload time")
	}
	if p, _ := s.fastPendingSyncs(ctx); len(p) != 1 {
		t.Fatalf("pending: %v", p)
	}
	if err := s.fastSyncFailed(ctx, "hackgt13", a.ID, "mapi 503", time.Hour); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.fastPendingSyncs(ctx); len(p) != 0 {
		t.Fatalf("pending while backing off: %v", p)
	}
	// a newer upload: the old marker time no longer clears it
	s.fastMarkDirty(ctx, "hackgt13", a.ID)
	if err := s.fastSynced(ctx, "hackgt13", a.ID, *st.dirty); err != nil {
		t.Fatal(err)
	}
	st2, _ := s.fastSyncState(ctx, "hackgt13", a.ID)
	if st2.dirty == nil {
		t.Fatal("a stale sync cleared a newer marker")
	}
	s.fastSynced(ctx, "hackgt13", a.ID, *st2.dirty)
	s.fastRequestPurge(ctx, "hackgt13", a.ID)
	if st3, _ := s.fastSyncState(ctx, "hackgt13", a.ID); st3.dirty != nil || st3.purged == nil || !st3.purged.After(*st3.received) {
		t.Fatalf("after sync and delete: %+v", st3)
	}
}

// When the best paragraph alone is over the limit, its start goes in and nothing else does.
func TestFastSnippetStaysWithinLimit(t *testing.T) {
	best := "The half marathon target " + strings.Repeat("pace detail ", 300)
	var other []string
	for i := 0; i < 12; i++ {
		other = append(other, "Also about the marathon: training note "+strings.Repeat("x", 90))
	}
	out := fastSnippet(best+"\n\n"+strings.Join(other, "\n\n"), "half marathon target", 1500)
	if n := utf8.RuneCountInString(out); n > 1500+5 || !strings.HasPrefix(out, "The half marathon target") {
		t.Fatalf("snippet is %d runes, limit 1500: %.80q", n, out)
	}
}
