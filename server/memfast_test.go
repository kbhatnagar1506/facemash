package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------- a fake MAPI ----------

type mfMem struct {
	id, space, content string
	meta               map[string]any
}

type mfFake struct {
	t       *testing.T
	mu      sync.Mutex
	next    int
	spaces  map[string]string // id → slug
	mems    map[string]*mfMem
	calls   []string // "R POST search", "W POST memories/bulk", ...
	erased  []string
	key     string
	fail    func(side, op string) (status int, retryAfter string) // inject errors; 0 = none
	block   chan struct{}                                         // bulk writes wait on this when set
	hang    bool                                                  // searches never answer
	hostile string                                                // a space whose memories every search also returns
	read    *httptest.Server
	write   *httptest.Server
}

func newMfFake(t *testing.T) *mfFake {
	f := &mfFake{t: t, spaces: map[string]string{}, mems: map[string]*mfMem{}, key: "mk_test_key"}
	f.read = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { f.serve("R", w, r) }))
	f.write = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { f.serve("W", w, r) }))
	t.Cleanup(func() { f.read.Close(); f.write.Close() })
	return f
}

func (f *mfFake) id(prefix string) string {
	f.next++
	return fmt.Sprintf("%s_%06d", prefix, f.next)
}

func (f *mfFake) memJSON(m *mfMem) map[string]any {
	return map[string]any{"id": m.id, "space_id": m.space, "content": m.content, "metadata": m.meta, "status": "active"}
}

func (f *mfFake) problem(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"type": "x", "code": code, "status": status, "detail": "secret content must never be logged"})
}

func (f *mfFake) serve(side string, w http.ResponseWriter, r *http.Request) {
	op := fastOp(r.URL.Path)
	f.mu.Lock()
	f.calls = append(f.calls, side+" "+r.Method+" "+op)
	fail, block, hang := f.fail, f.block, f.hang
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+f.key {
		f.problem(w, 401, "unauthorized")
		return
	}
	if fail != nil {
		if st, ra := fail(side, r.Method+" "+op); st != 0 {
			if ra != "" {
				w.Header().Set("Retry-After", ra)
			}
			f.problem(w, st, "injected")
			return
		}
	}
	body, _ := io.ReadAll(r.Body) // (first: the server only notices a client hanging up once the body is read)
	if op == "spaces/*/memories/bulk" && block != nil {
		<-block
	}
	if op == "spaces/*/search" && hang {
		<-r.Context().Done()
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
	f.mu.Lock()
	defer f.mu.Unlock()
	reply := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	switch {
	case r.Method == "POST" && op == "spaces":
		var in struct{ Slug, Name string }
		json.Unmarshal(body, &in)
		for id, s := range f.spaces {
			if s == in.Slug {
				_ = id
				f.problem(w, 409, "conflict")
				return
			}
		}
		id := f.id("spc")
		f.spaces[id] = in.Slug
		reply(201, map[string]any{"id": id, "slug": in.Slug, "name": in.Name})
	case r.Method == "GET" && op == "spaces":
		var items []map[string]any
		for id, s := range f.spaces {
			items = append(items, map[string]any{"id": id, "slug": s})
		}
		reply(200, map[string]any{"items": items})
	case r.Method == "DELETE" && len(parts) == 2:
		if _, ok := f.spaces[parts[1]]; !ok {
			f.problem(w, 404, "not_found")
			return
		}
		delete(f.spaces, parts[1])
		for id, m := range f.mems {
			if m.space == parts[1] {
				delete(f.mems, id) // (the real one keeps their version history: hence erase first)
			}
		}
		w.WriteHeader(204)
	case r.Method == "POST" && op == "spaces/*/memories/bulk":
		sid := parts[1]
		if _, ok := f.spaces[sid]; !ok {
			f.problem(w, 404, "not_found")
			return
		}
		var in struct {
			Items []struct {
				Content  string         `json:"content"`
				Metadata map[string]any `json:"metadata"`
			} `json:"items"`
		}
		if err := json.Unmarshal(body, &in); err != nil || len(in.Items) == 0 || len(in.Items) > 100 {
			f.problem(w, 422, "validation_error")
			return
		}
		var out []map[string]any
		for _, it := range in.Items {
			var dup *mfMem
			for _, m := range f.mems {
				if m.space == sid && m.content == it.Content {
					dup = m
				}
			}
			if dup == nil {
				dup = &mfMem{id: f.id("mem"), space: sid, content: it.Content, meta: it.Metadata}
				f.mems[dup.id] = dup
			}
			out = append(out, map[string]any{"memory": f.memJSON(dup), "created": true})
		}
		reply(201, map[string]any{"items": out, "created": len(out), "duplicates": 0})
	case r.Method == "POST" && op == "spaces/*/memories/*/erase":
		m := f.mems[parts[3]]
		if m == nil || m.space != parts[1] {
			f.problem(w, 404, "not_found")
			return
		}
		delete(f.mems, m.id)
		f.erased = append(f.erased, m.id)
		reply(200, map[string]any{"memory_id": m.id, "space_id": m.space})
	case r.Method == "GET" && op == "spaces/*/memories":
		if _, ok := f.spaces[parts[1]]; !ok {
			f.problem(w, 404, "not_found")
			return
		}
		var ids []string
		for id, m := range f.mems {
			if m.space == parts[1] {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		start := 0
		if c := r.URL.Query().Get("cursor"); c != "" {
			fmt.Sscan(c, &start)
		}
		var items []map[string]any
		next := ""
		for i := start; i < len(ids); i++ {
			if len(items) == 2 { // tiny pages, so paging is exercised
				next = fmt.Sprint(i)
				break
			}
			items = append(items, f.memJSON(f.mems[ids[i]]))
		}
		reply(200, map[string]any{"items": items, "next_cursor": next})
	case r.Method == "POST" && op == "spaces/*/search":
		var in struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		json.Unmarshal(body, &in)
		type hit struct {
			m     *mfMem
			score float64
		}
		var hits []hit
		words := strings.Fields(strings.ToLower(in.Query))
		for _, m := range f.mems {
			if m.space != parts[1] && m.space != f.hostile {
				continue
			}
			n := 0
			for _, wd := range words {
				if len(wd) > 2 && strings.Contains(strings.ToLower(m.content), wd) {
					n++
				}
			}
			if n > 0 || m.space == f.hostile {
				hits = append(hits, hit{m, float64(n+1) / float64(len(words)+1)})
			}
		}
		sort.Slice(hits, func(i, j int) bool {
			if hits[i].score != hits[j].score {
				return hits[i].score > hits[j].score
			}
			return hits[i].m.id < hits[j].m.id
		})
		var results []map[string]any
		for _, h := range hits {
			if len(results) < in.Limit {
				results = append(results, map[string]any{"memory": f.memJSON(h.m), "score": h.score, "matched_text": ""})
			}
		}
		reply(200, map[string]any{"query": in.Query, "results": results, "count": len(results)})
	default:
		f.problem(w, 404, "not_found")
	}
}

// count: calls matching "W POST spaces/*/memories/bulk" and the like.
func (f *mfFake) count(call string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == call {
			n++
		}
	}
	return n
}

func (f *mfFake) since(n int) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls[n:]...)
}

func (f *mfFake) erasedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.erased...)
}

func (f *mfFake) slug(sid string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.spaces[sid]
}

func (f *mfFake) total() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *mfFake) contents(sid string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.mems {
		if sid == "" || m.space == sid {
			out = append(out, m.content)
		}
	}
	sort.Strings(out)
	return out
}

// ---------- the game server, with the feature on ----------

type mfEnv struct {
	srv   *httptest.Server
	acc   *accounts
	store *memStore
	id    int64
	tok   string
	fake  *mfFake
	fast  *memFast
}

func mfClient(fake *mfFake) *fastClient {
	c := newFastClient(fake.read.URL, fake.write.URL, func(tenant string) string {
		if tenant == "hackgt13" {
			return fake.key
		}
		return ""
	})
	c.backoff, c.maxWait = 5*time.Millisecond, 50*time.Millisecond
	return c
}

func mfService(store fastStore, fake *mfFake) *memFast {
	f := newMemFast(store, mfClient(fake))
	f.retryBase, f.retryMax, f.sweepEvery = 20*time.Millisecond, 100*time.Millisecond, 50*time.Millisecond
	f.start(fastWorkers)
	return f
}

func mfSetup(t *testing.T) *mfEnv {
	t.Helper()
	e := &mfEnv{fake: newMfFake(t), store: newMemStore()}
	e.acc = &accounts{store: e.store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	a, _, _ := e.store.SignIn(context.Background(), "hackgt13", user{Sub: "g-1", Email: "buzz@gatech.edu", Name: "Buzz Bee", Given: "Buzz"})
	e.store.SaveProfile(context.Background(), "hackgt13", a.ID, Profile{Name: "Buzz"})
	e.id = a.ID
	e.tok = newToken()
	e.store.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(e.tok))
	e.fast = mfService(e.store, e.fake)
	e.acc.fast = e.fast
	mux := http.NewServeMux()
	mountMuse(mux, e.acc, newHub(), "event.json", "https://site.test", func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	e.srv = httptest.NewServer(mux)
	t.Cleanup(func() { e.srv.Close(); e.fast.close() })
	return e
}

// another attendee on the same server
func (e *mfEnv) person(t *testing.T, email string) (int64, string) {
	a, _, err := e.store.SignIn(context.Background(), "hackgt13", user{Sub: "g-" + email, Email: email})
	if err != nil {
		t.Fatal(err)
	}
	tok := newToken()
	e.store.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(tok))
	return a.ID, tok
}

func (e *mfEnv) do(t *testing.T, method, path, body string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (e *mfEnv) upload(t *testing.T, tok string, mem map[string]any) {
	t.Helper()
	b, _ := json.Marshal(mem)
	if code, out := e.do(t, "POST", "/api/memory/t/"+tok, string(b), nil); code != 200 {
		t.Fatalf("upload: %d %v", code, out)
	}
}

func (e *mfEnv) ask(t *testing.T, tok, q string) map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"q": q})
	code, out := e.do(t, "POST", "/api/ask/t/"+tok, string(b), nil)
	if code != 200 {
		t.Fatalf("ask: %d %v", code, out)
	}
	return out
}

// idle waits for the workers to finish everything queued.
func mfIdle(t *testing.T, f *memFast) {
	t.Helper()
	mfWait(t, "workers idle", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.queue) == 0 && len(f.pending) == 0 && len(f.running) == 0
	})
}

func mfWait(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 500; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func mfMemory() map[string]any {
	return map[string]any{
		"user_id":     "Buzz (ignored: identity comes from the key)",
		"exported_at": "2026-09-26T17:20:00Z",
		"user_md":     "Buzz is a second-year CS student at Georgia Tech.",
		"memory_md":   "Top note.\n\n## Projects\nBuilding a rust compiler plugin for HackGT.\n\n## Food\nLoves boba, hates cilantro.\n",
		"daily_notes": []any{
			map[string]any{"date": "2026-09-25", "content": "Met the team; picked the drone idea."},
			map[string]any{"date": "2026-09-26", "content": "Debugged the websocket server all night."},
		},
		"bank":   map[string]any{"opinions": "Tabs over spaces.", "world": "Klaus has the good whiteboards.", "people": "never read"},
		"people": "Alice's phone number is secret",
	}
}

// ---------- tests ----------

func TestFastSplit(t *testing.T) {
	items, cut := fastSplit(mfMemory())
	if cut != 0 {
		t.Fatalf("cut: %d", cut)
	}
	var keys []string
	for _, it := range items {
		keys = append(keys, it.Key)
		if strings.Contains(it.Content, "Alice") || strings.Contains(it.Content, "never read") || strings.Contains(it.Content, "ignored") {
			t.Fatalf("a field outside the whitelist got through: %q", it.Content)
		}
		if first, _, _ := strings.Cut(it.Content, "\n"); first == "" || strings.Contains(it.Content[len(first):], first) {
			t.Fatalf("first line should describe the item: %q", it.Content)
		}
	}
	want := []string{"muse:user_md", "muse:memory_md", "muse:memory_md:projects", "muse:memory_md:food",
		"muse:daily:2026-09-26", "muse:daily:2026-09-25", "muse:bank:opinions", "muse:bank:world"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("keys (priority order, daily newest first):\n got %v\nwant %v", keys, want)
	}
	if !strings.HasPrefix(items[2].Content, "Long-term memory (MEMORY.md) — Projects\n") || !strings.HasPrefix(items[4].Content, "Daily note — 2026-09-26\n") ||
		items[4].Occurred == nil || items[4].Occurred.Format("2006-01-02") != "2026-09-26" || items[4].Section != "daily_note" {
		t.Fatalf("headers: %q / %q", items[2].Content, items[4].Content)
	}

	// deterministic: same input (daily notes as a map, iterated in random order) → same items
	m := mfMemory()
	m["daily_notes"] = map[string]any{"2026-09-25": "a", "2026-09-26": "b", "2026-09-24": "c", "someday": "d"}
	a, _ := fastSplit(m)
	for i := 0; i < 20; i++ {
		b, _ := fastSplit(m)
		if len(a) != len(b) {
			t.Fatal("item count changed between runs")
		}
		for j := range a {
			if a[j].Key != b[j].Key || string(a[j].SHA) != string(b[j].SHA) {
				t.Fatalf("run %d item %d: %s vs %s", i, j, a[j].Key, b[j].Key)
			}
		}
	}

	// keys come from headings, not positions: a new section doesn't disturb the others
	m2 := mfMemory()
	m2["memory_md"] = "Top note.\n\n## Brand new\nhello\n\n## Projects\nBuilding a rust compiler plugin for HackGT.\n\n## Food\nLoves boba, hates cilantro.\n"
	b, _ := fastSplit(m2)
	sha := map[string]string{}
	for _, it := range items {
		sha[it.Key] = string(it.SHA)
	}
	changed := 0
	for _, it := range b {
		if sha[it.Key] != string(it.SHA) {
			changed++
		}
	}
	if changed != 1 {
		t.Fatalf("inserting one section changed %d items", changed)
	}

	// long sections split at paragraphs into stable keys; nothing is over the cap
	para := strings.Repeat("word ", 150) // ~750 chars
	long := "## Big\n" + strings.Repeat(para+"\n\n", 20) + "```\n# not a heading\n```\n## Big\nsame title again\n### Deep\nnested"
	its := fastMarkdown("muse:memory_md", "memory_md", "Long-term memory (MEMORY.md)", long)
	var ks []string
	for _, it := range its {
		ks = append(ks, it.Key)
		if n := utf8.RuneCountInString(it.Content); n > fastMaxItemChars {
			t.Fatalf("%s is %d chars", it.Key, n)
		}
	}
	if ks[0] != "muse:memory_md:big" || ks[1] != "muse:memory_md:big#2" || !strings.Contains(strings.Join(ks, ","), "muse:memory_md:big~2") ||
		!strings.Contains(strings.Join(ks, ","), "muse:memory_md:big/deep") || strings.Contains(strings.Join(ks, ","), "not-a-heading") {
		t.Fatalf("keys: %v", ks)
	}
	if !strings.Contains(its[1].Content, "(part 2)") {
		t.Fatalf("part header: %q", its[1].Content[:60])
	}
	// one enormous line still splits
	if got := fastChunks(strings.Repeat("x", 9000), 4000); len(got) != 3 || len(got[0]) != 4000 {
		t.Fatalf("hard split: %d pieces", len(got))
	}

	// caps: item count and total size
	var notes []any
	for i := 0; i < fastMaxItems+50; i++ {
		notes = append(notes, map[string]any{"date": fmt.Sprintf("2026-%02d-%02d", 1+i/28%12, 1+i%28), "content": fmt.Sprintf("note %d", i)})
	}
	capped, cut := fastSplit(map[string]any{"daily_notes": notes})
	if len(capped) > fastMaxItems || cut == 0 {
		t.Fatalf("item cap: %d items, %d cut", len(capped), cut)
	}
	big, cut := fastSplit(map[string]any{"memory_md": strings.Repeat(strings.Repeat("y", 3000)+"\n\n", 3000)})
	total := 0
	for _, it := range big {
		total += len(it.Content)
	}
	if total > fastMaxTotalBytes || cut == 0 {
		t.Fatalf("size cap: %d bytes, %d cut", total, cut)
	}
}

func TestFastSyncDiffs(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	sid, _, _ := e.store.fastSpace(context.Background(), "hackgt13", e.id)
	if !strings.HasPrefix(sid, "spc_") || e.fake.slug(sid) != fmt.Sprintf("u-%d", e.id) {
		t.Fatalf("space: %q", sid)
	}
	if got := e.fake.contents(sid); len(got) != 8 {
		t.Fatalf("memories: %d %v", len(got), got)
	}
	rows, _ := e.store.fastItems(context.Background(), "hackgt13", e.id)
	if len(rows) != 8 || rows["muse:memory_md:food"].MemID == "" {
		t.Fatalf("rows: %v", rows)
	}
	// writes go to the write port, and only there
	if e.fake.count("W POST spaces/*/memories/bulk") != 1 || e.fake.count("R POST spaces/*/memories/bulk") != 0 {
		t.Fatalf("calls: %v", e.fake.since(0))
	}

	// the same upload again: nothing to do
	before := e.fake.total()
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	if n := e.fake.total() - before; n != 0 {
		t.Fatalf("unchanged re-upload made %d MAPI calls: %v", n, e.fake.since(before))
	}

	// one section changed: its old copy is erased, then the new one written
	m := mfMemory()
	m["memory_md"] = "Top note.\n\n## Projects\nBuilding a rust compiler plugin for HackGT.\n\n## Food\nLoves boba AND cilantro now.\n"
	oldFood := rows["muse:memory_md:food"].MemID
	e.upload(t, e.tok, m)
	mfIdle(t, e.fast)
	calls := e.fake.since(before)
	if e.fake.count("W POST spaces/*/memories/*/erase") != 1 || e.fake.count("W POST spaces/*/memories/bulk") != 2 || len(calls) != 2 ||
		calls[0] != "W POST spaces/*/memories/*/erase" || e.fake.erasedIDs()[0] != oldFood {
		t.Fatalf("changed section: %v (erased %v)", calls, e.fake.erasedIDs())
	}
	all := strings.Join(e.fake.contents(sid), "|")
	if !strings.Contains(all, "AND cilantro") || strings.Contains(all, "hates cilantro") {
		t.Fatalf("contents after change: %v", all)
	}

	// a section removed: erased, nothing written
	delete(m, "bank")
	before = e.fake.total()
	e.upload(t, e.tok, m)
	mfIdle(t, e.fast)
	if e.fake.count("W POST spaces/*/memories/*/erase") != 3 || e.fake.count("W POST spaces/*/memories/bulk") != 2 {
		t.Fatalf("removed section: %v", e.fake.since(before))
	}
	rows, _ = e.store.fastItems(context.Background(), "hackgt13", e.id)
	if len(rows) != 6 || len(e.fake.contents(sid)) != 6 {
		t.Fatalf("after removal: %d rows, %d memories", len(rows), len(e.fake.contents(sid)))
	}
}

func TestFastCoalesces(t *testing.T) {
	e := mfSetup(t)
	block := make(chan struct{})
	e.fake.mu.Lock()
	e.fake.block = block
	e.fake.mu.Unlock()
	version := func(v string) map[string]any { return map[string]any{"memory_md": "## Now\nversion " + v} }
	e.upload(t, e.tok, version("1"))
	mfWait(t, "the first write to start", func() bool { return e.fake.count("W POST spaces/*/memories/bulk") == 1 })
	for _, v := range []string{"2", "3", "4"} {
		e.upload(t, e.tok, version(v))
	}
	close(block)
	mfIdle(t, e.fast)
	if n := e.fake.count("W POST spaces/*/memories/bulk"); n != 2 {
		t.Fatalf("bulk writes: %d, want 2 (the first, then only the latest)", n)
	}
	got := strings.Join(e.fake.contents(""), "|")
	if !strings.Contains(got, "version 4") || strings.Contains(got, "version 2") || strings.Contains(got, "version 3") || strings.Contains(got, "version 1") {
		t.Fatalf("contents: %v", got)
	}
}

func TestFastWriteRetries(t *testing.T) {
	e := mfSetup(t)
	var mu sync.Mutex
	failures := 0
	e.fake.mu.Lock()
	e.fake.fail = func(side, op string) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		if op == "POST spaces/*/memories/bulk" && failures < 2 {
			failures++
			if failures == 1 {
				return 429, "0"
			}
			return 503, ""
		}
		if op == "POST spaces/*/search" {
			return 503, ""
		}
		return 0, ""
	}
	e.fake.mu.Unlock()
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	if n := e.fake.count("W POST spaces/*/memories/bulk"); n != 3 || len(e.fake.contents("")) != 8 {
		t.Fatalf("429 then 503 then success: %d bulk calls, %d memories", n, len(e.fake.contents("")))
	}
	// reads never retry: a person is waiting
	before := e.fake.count("R POST spaces/*/search")
	if out := e.ask(t, e.tok, "rust"); out["status"] != "busy" || e.fake.count("R POST spaces/*/search")-before != 1 {
		t.Fatalf("failed read: %v, %d calls", out, e.fake.count("R POST spaces/*/search")-before)
	}

	// Retry-After is honoured (in seconds, capped for the test by maxWait)
	c := mfClient(e.fake)
	c.maxWait = 2 * time.Second
	n := 0
	e.fake.mu.Lock()
	e.fake.fail = func(side, op string) (int, string) {
		if op == "GET spaces" {
			mu.Lock()
			defer mu.Unlock()
			if n++; n == 1 {
				return 429, "1"
			}
		}
		return 0, ""
	}
	e.fake.mu.Unlock()
	start := time.Now()
	if err := c.do(context.Background(), "hackgt13", "GET", "/v1/spaces", nil, nil, true); err != nil || time.Since(start) < 900*time.Millisecond {
		t.Fatalf("Retry-After: %v after %v", err, time.Since(start))
	}
	// a 4xx other than 429 is final, and the error never carries MAPI's detail
	e.fake.mu.Lock()
	e.fake.fail = func(side, op string) (int, string) { return 422, "" }
	e.fake.mu.Unlock()
	before = e.fake.total()
	err := c.do(context.Background(), "hackgt13", "POST", "/v1/spaces", map[string]any{"slug": "x"}, nil, true)
	if fastStatus(err) != 422 || e.fake.total()-before != 1 || strings.Contains(err.Error(), "secret") {
		t.Fatalf("422: %v, %d calls", err, e.fake.total()-before)
	}
}

func TestFastAskOwnSpaceOnly(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	otherID, otherTok := e.person(t, "other@gatech.edu")
	e.upload(t, otherTok, map[string]any{"memory_md": "## Plans\nOther person also likes rust, and has a secret plan."})
	mfIdle(t, e.fast)

	out := e.ask(t, e.tok, "what rust project am I building")
	res, _ := out["results"].([]any)
	if out["status"] != "ok" || len(res) == 0 || !strings.Contains(fmt.Sprint(out["note"]), "own notes") {
		t.Fatalf("ask: %v", out)
	}
	for _, r := range res {
		if strings.Contains(fmt.Sprint(r), "secret plan") {
			t.Fatalf("someone else's note came back: %v", r)
		}
	}
	top := res[0].(map[string]any)
	if top["key"] != "memory_md:projects" || top["section"] != "memory_md" || top["from"] != "Long-term memory (MEMORY.md) — Projects" ||
		!strings.Contains(top["text"].(string), "rust compiler") || top["score"].(float64) <= 0 {
		t.Fatalf("top hit: %v", top)
	}

	// a MAPI that answers with another space's memories: every such hit is dropped
	otherSid, _, _ := e.store.fastSpace(context.Background(), "hackgt13", otherID)
	e.fake.mu.Lock()
	e.fake.hostile = otherSid
	e.fake.mu.Unlock()
	out = e.ask(t, e.tok, "secret plan")
	if strings.Contains(fmt.Sprint(out), "secret plan") {
		t.Fatalf("hostile hit got through: %v", out)
	}
	// the search went to the read port, for this person's space
	mySid, _, _ := e.store.fastSpace(context.Background(), "hackgt13", e.id)
	if e.fake.count("R POST spaces/*/search") != 2 || e.fake.count("W POST spaces/*/search") != 0 || mySid == otherSid {
		t.Fatalf("searches: %v", e.fake.since(0))
	}

	// someone with nothing sent yet
	_, newTok := e.person(t, "new@gatech.edu")
	if out := e.ask(t, newTok, "anything"); out["status"] != "no_memory" {
		t.Fatalf("no memory yet: %v", out)
	}
	// the key can be a bearer token, ?q= works, and a question is required
	if code, out := e.do(t, "GET", "/api/ask?q=boba", "", map[string]string{"Authorization": "Bearer " + e.tok}); code != 200 || out["status"] != "ok" {
		t.Fatalf("GET ?q=: %d %v", code, out)
	}
	if code, _ := e.do(t, "POST", "/api/ask/t/"+e.tok, `{}`, nil); code != 400 {
		t.Fatalf("no question: %d", code)
	}
	if code, _ := e.do(t, "POST", "/api/ask/t/gtq_wrong", `{"q":"x"}`, nil); code != 401 {
		t.Fatalf("bad key: %d", code)
	}
	// the MCP tool: listed (read-only), and it answers the same way
	_, list := rpc(t, e.srv.URL, e.tok, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	found := false
	for _, tl := range list["result"].(map[string]any)["tools"].([]any) {
		if m := tl.(map[string]any); m["name"] == "ask_my_memory" {
			found = m["annotations"].(map[string]any)["readOnlyHint"] == true
		}
	}
	_, call := rpc(t, e.srv.URL, e.tok, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ask_my_memory","arguments":{"q":"boba"}}}`)
	sc, _ := call["result"].(map[string]any)["structuredContent"].(map[string]any)
	if !found || sc["status"] != "ok" || !strings.Contains(fmt.Sprint(sc["results"]), "boba") {
		t.Fatalf("tool: listed %v, call %v", found, call)
	}
}

func TestFastAskDeadline(t *testing.T) {
	if fastAskTimeout != 1200*time.Millisecond {
		t.Fatalf("deadline is %v", fastAskTimeout)
	}
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	e.fake.mu.Lock()
	e.fake.hang = true
	e.fake.mu.Unlock()
	e.fast.askTimeout = 300 * time.Millisecond
	start := time.Now()
	out := e.ask(t, e.tok, "rust")
	if el := time.Since(start); out["status"] != "busy" || el > 900*time.Millisecond {
		t.Fatalf("hanging search: %v after %v", out, el)
	}
	// /api/now?q= still answers with the snapshot, on time
	start = time.Now()
	code, now := e.do(t, "GET", "/api/now/t/"+e.tok+"?q=rust", "", nil)
	mem, _ := now["memory"].(map[string]any)
	if el := time.Since(start); code != 200 || now["happening_now"] == nil || mem["status"] != "busy" || el > 900*time.Millisecond {
		t.Fatalf("now with a hanging search: %d %v after %v", code, now, el)
	}
}

func TestFastNowOnlyCallsMAPIWithAQuestion(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	before := e.fake.total()
	for _, path := range []string{"/api/now/t/" + e.tok, "/api/now/t/" + e.tok + "?q="} {
		code, out := e.do(t, "GET", path, "", nil)
		if code != 200 || out["memory"] != nil || out["happening_now"] == nil {
			t.Fatalf("GET %s: %d %v", path[:8], code, out)
		}
	}
	if n := e.fake.total() - before; n != 0 {
		t.Fatalf("/api/now without q made %d MAPI calls", n)
	}
	code, out := e.do(t, "GET", "/api/now/t/"+e.tok+"?q=boba", "", nil)
	if mem, _ := out["memory"].(map[string]any); code != 200 || mem["status"] != "ok" || out["you"] == nil {
		t.Fatalf("GET ?q=: %d %v", code, out)
	}
	code, out = e.do(t, "POST", "/api/now/t/"+e.tok, `{"q":"what did I debug"}`, nil)
	if mem, _ := out["memory"].(map[string]any); code != 200 || mem["status"] != "ok" || !strings.Contains(fmt.Sprint(mem), "websocket") {
		t.Fatalf("POST {q}: %d %v", code, out)
	}
	// a paired agent is told about the memory fast path
	cookie := func() *http.Cookie {
		v, exp := e.acc.sess.issue(kindSession, e.id, time.Hour)
		return &http.Cookie{Name: sessionCookie, Value: v, Expires: exp}
	}
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/muse/pair", nil)
	req.Header.Set("Origin", "https://site.test")
	req.AddCookie(cookie())
	res, _ := http.DefaultClient.Do(req)
	var p map[string]any
	json.NewDecoder(res.Body).Decode(&p)
	res.Body.Close()
	_, got := e.do(t, "POST", "/api/muse/claim", `{"code":"`+p["code"].(string)+`"}`, nil)
	tok, _ := got["token"].(string)
	prompt, _ := got["prompt"].(string)
	for _, want := range []string{"ONE HTTP GET to https://site.test/api/now/t/" + tok, "ONE HTTP POST to https://site.test/api/ask/t/" + tok, `{"q": `, "Don't list tools", "keep them secret"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt is missing %q", want)
		}
	}
	if !strings.Contains(fmt.Sprint(got["memory_prompt"]), "/api/ask/t/"+tok) || got["ask_url"] != "https://site.test/api/ask/t/"+tok {
		t.Errorf("memory prompt / ask_url: %v", got)
	}
}

func TestFastDeletePurges(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	sid, _, _ := e.store.fastSpace(context.Background(), "hackgt13", e.id)
	// something in the space we have no row for (say a write whose answer was lost)
	e.fake.mu.Lock()
	e.fake.mems["mem_orphan"] = &mfMem{id: "mem_orphan", space: sid, content: "orphan"}
	e.fake.mu.Unlock()
	cookie := func() *http.Cookie {
		v, exp := e.acc.sess.issue(kindSession, e.id, time.Hour)
		return &http.Cookie{Name: sessionCookie, Value: v, Expires: exp}
	}
	req, _ := http.NewRequest("DELETE", e.srv.URL+"/api/muse/memory", nil)
	req.Header.Set("Origin", "https://site.test")
	req.AddCookie(cookie())
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 204 {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	mfIdle(t, e.fast)
	mfWait(t, "the purge", func() bool {
		_, purging, _ := e.store.fastSpace(context.Background(), "hackgt13", e.id)
		return !purging
	})
	e.fake.mu.Lock()
	erased, spaces := len(e.fake.erased), len(e.fake.spaces)
	e.fake.mu.Unlock()
	if erased != 9 || spaces != 0 || len(e.fake.contents("")) != 0 {
		t.Fatalf("after delete: %d erased (want 8 + the orphan), %d spaces left, %v", erased, spaces, e.fake.contents(""))
	}
	rows, _ := e.store.fastItems(context.Background(), "hackgt13", e.id)
	if s, _, _ := e.store.fastSpace(context.Background(), "hackgt13", e.id); s != "" || len(rows) != 0 {
		t.Fatalf("bookkeeping left: %q %v", s, rows)
	}
	if out := e.ask(t, e.tok, "rust"); out["status"] != "no_memory" {
		t.Fatalf("ask after delete: %v", out)
	}
	// sending memory again starts a fresh space
	e.upload(t, e.tok, map[string]any{"user_md": "back again"})
	mfIdle(t, e.fast)
	if got := e.fake.contents(""); len(got) != 1 || !strings.Contains(got[0], "back again") {
		t.Fatalf("after re-upload: %v", got)
	}
}

func TestFastDeleteBeatsAQueuedUpload(t *testing.T) {
	e := mfSetup(t)
	block := make(chan struct{})
	e.fake.mu.Lock()
	e.fake.block = block
	e.fake.mu.Unlock()
	e.upload(t, e.tok, map[string]any{"user_md": "first"})
	mfWait(t, "the first write to start", func() bool { return e.fake.count("W POST spaces/*/memories/bulk") == 1 })
	e.upload(t, e.tok, map[string]any{"user_md": "second, sent just before the delete"})
	if err := e.fast.forget(context.Background(), "hackgt13", e.id); err != nil {
		t.Fatal(err)
	}
	close(block)
	mfIdle(t, e.fast)
	if got := e.fake.contents(""); len(got) != 0 || e.fake.count("W POST spaces/*/memories/bulk") != 1 {
		t.Fatalf("after delete: %v (%d bulk writes)", got, e.fake.count("W POST spaces/*/memories/bulk"))
	}
}

func TestFastPurgeSurvivesRestart(t *testing.T) {
	e := mfSetup(t)
	e.upload(t, e.tok, mfMemory())
	mfIdle(t, e.fast)
	down := true
	var mu sync.Mutex
	e.fake.mu.Lock()
	e.fake.fail = func(side, op string) (int, string) {
		mu.Lock()
		defer mu.Unlock()
		if down && strings.Contains(op, "erase") {
			return 503, ""
		}
		return 0, ""
	}
	e.fake.mu.Unlock()
	if err := e.fast.forget(context.Background(), "hackgt13", e.id); err != nil {
		t.Fatal(err)
	}
	mfWait(t, "a failed purge attempt", func() bool {
		e.store.mu.Lock()
		defer e.store.mu.Unlock()
		return len(e.store.fast.purges) == 1 && e.store.fast.purges[0].tries > 0
	})
	e.fast.close() // the server stops mid-purge
	if n := len(e.fake.contents("")); n != 8 {
		t.Fatalf("memories before the restart: %d", n)
	}
	mu.Lock()
	down = false
	mu.Unlock()
	// a new process over the same database finds the open marker and finishes the job
	f2 := mfService(e.store, e.fake)
	defer f2.close()
	mfWait(t, "the purge after restart", func() bool {
		_, purging, _ := e.store.fastSpace(context.Background(), "hackgt13", e.id)
		return !purging
	})
	e.fake.mu.Lock()
	spaces := len(e.fake.spaces)
	e.fake.mu.Unlock()
	if n := len(e.fake.contents("")); n != 0 || spaces != 0 {
		t.Fatalf("after restart: %d memories, %d spaces", n, spaces)
	}
}

func TestFastOffWithoutEnv(t *testing.T) {
	for _, k := range []string{"MAPI_READ_URL", "MAPI_WRITE_URL", "MAPI_KEY_hackgt13", "MAPI_KEY_HACKGT13", "MAPI_KEY_FILE_hackgt13", "MAPI_KEY_FILE_HACKGT13"} {
		t.Setenv(k, "")
	}
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13"}
	if openMemFast(acc) != nil {
		t.Fatal("on without MAPI env")
	}
	t.Setenv("MAPI_READ_URL", "http://127.0.0.1:9")
	if openMemFast(acc) != nil {
		t.Fatal("on without a key for the tenant")
	}
	keyFile := filepath.Join(t.TempDir(), "mapi.key")
	os.WriteFile(keyFile, []byte("mk_from_file\n"), 0o600)
	t.Setenv("MAPI_KEY_FILE_hackgt13", keyFile)
	f := openMemFast(acc)
	if f == nil || f.mapi.key("hackgt13") != "mk_from_file" || f.mapi.write != "http://127.0.0.1:9" || f.mapi.key("other") != "" {
		t.Fatal("key file not used")
	}
	f.close()

	// off: the connector is exactly as before
	srv, _, _, _, tok := museServer(t)
	for _, path := range []string{"/api/ask/t/" + tok, "/api/ask"} {
		req, _ := http.NewRequest("POST", srv.URL+path, strings.NewReader(`{"q":"x"}`))
		req.Header.Set("Authorization", "Bearer "+tok)
		res, _ := http.DefaultClient.Do(req)
		if res.StatusCode == 200 {
			t.Fatalf("%s answers while off", path[:8])
		}
	}
	_, list := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if strings.Contains(fmt.Sprint(list), "ask_my_memory") {
		t.Fatal("ask_my_memory listed while off")
	}
	res, _ := http.Get(srv.URL + "/api/now/t/" + tok + "?q=rust")
	var now map[string]any
	json.NewDecoder(res.Body).Decode(&now)
	res.Body.Close()
	if now["memory"] != nil || now["happening_now"] == nil {
		t.Fatalf("now while off: %v", now)
	}
	if res, _ := http.Post(srv.URL+"/api/now/t/"+tok, "application/json", strings.NewReader(`{"q":"x"}`)); res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/now while off: %d", res.StatusCode)
	}
	var nilFast *memFast
	nilFast.uploaded("hackgt13", 1, map[string]any{"user_md": "x"})
	if err := nilFast.forget(context.Background(), "hackgt13", 1); err != nil {
		t.Fatal(err)
	}
}

// The Postgres half of the bookkeeping, against a real database when one is given:
// FASTPG_DSN="host=127.0.0.1 port=... user=... dbname=... sslmode=disable" go test -run TestFastPostgres
func TestFastPostgres(t *testing.T) {
	dsn := os.Getenv("FASTPG_DSN")
	if dsn == "" {
		t.Skip("FASTPG_DSN not set")
	}
	ctx := context.Background()
	s, err := mfOpenPostgres(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.fastEnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.fastEnsureSchema(ctx); err != nil { // idempotent
		t.Fatal(err)
	}
	a, _, err := s.SignIn(ctx, "hackgt13", user{Sub: "pg-1", Email: fmt.Sprintf("pg%d@gatech.edu", time.Now().UnixNano())})
	if err != nil {
		t.Fatal(err)
	}
	if sid, purging, err := s.fastSpace(ctx, "hackgt13", a.ID); err != nil || sid != "" || purging {
		t.Fatalf("empty: %q %v %v", sid, purging, err)
	}
	if err := s.fastSetSpace(ctx, "hackgt13", a.ID, "spc_1"); err != nil {
		t.Fatal(err)
	}
	if err := s.fastPutItems(ctx, "hackgt13", a.ID, []fastRow{{"k1", []byte{1, 2}, "mem_1"}, {"k2", []byte{3}, "mem_2"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.fastPutItems(ctx, "hackgt13", a.ID, []fastRow{{"k1", []byte{9}, "mem_9"}}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.fastItems(ctx, "hackgt13", a.ID)
	if err != nil || len(rows) != 2 || rows["k1"].MemID != "mem_9" || rows["k1"].SHA[0] != 9 {
		t.Fatalf("items: %v %v", rows, err)
	}
	if err := s.fastDropItems(ctx, "hackgt13", a.ID, []string{"k2"}); err != nil {
		t.Fatal(err)
	}
	if err := s.fastRequestPurge(ctx, "hackgt13", a.ID); err != nil {
		t.Fatal(err)
	}
	marks, spaces, err := s.fastPurges(ctx, "hackgt13", a.ID)
	if err != nil || len(marks) != 1 || len(spaces) != 1 || spaces[0] != "spc_1" {
		t.Fatalf("purges: %v %v %v", marks, spaces, err)
	}
	if _, purging, _ := s.fastSpace(ctx, "hackgt13", a.ID); !purging {
		t.Fatal("not purging")
	}
	pend, err := s.fastPendingPurges(ctx)
	if err != nil || !strings.Contains(fmt.Sprint(pend), fmt.Sprint(a.ID)) {
		t.Fatalf("pending: %v %v", pend, err)
	}
	if err := s.fastPurgeFailed(ctx, marks, "mapi 503 injected"); err != nil {
		t.Fatal(err)
	}
	if err := s.fastClear(ctx, "hackgt13", a.ID, marks); err != nil {
		t.Fatal(err)
	}
	rows, _ = s.fastItems(ctx, "hackgt13", a.ID)
	sid, purging, _ := s.fastSpace(ctx, "hackgt13", a.ID)
	if marks, _, _ := s.fastPurges(ctx, "hackgt13", a.ID); len(rows) != 0 || sid != "" || purging || len(marks) != 0 {
		t.Fatalf("after clear: %v %q %v %v", rows, sid, purging, marks)
	}
}

// mfOpenPostgres: a pgStore on a plain DSN (a local test database, no TLS), with the game's
// schema and the tenant in place, as openPostgres would leave it.
func mfOpenPostgres(ctx context.Context, dsn string) (*pgStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s := &pgStore{pool: pool}
	if _, err := pool.Exec(ctx, schema); err != nil {
		s.Close()
		return nil, err
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tenants (id, name) VALUES ('hackgt13', 'HackGT 13') ON CONFLICT (id) DO NOTHING`); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}
