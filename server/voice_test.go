package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeEleven stands in for ElevenLabs: two accounts ("xk_primary_1" and "xk_backup_2" keys, one agent
// each), and whatever the test sets for a bad key.
type fakeEleven struct {
	mu      sync.Mutex
	keyErr  map[string]int // key → status it gets (0: fine)
	mints   map[string]int // key → signed URLs asked for
	fetches int
	noConv  bool // leave conversation_id out of signed URLs (bind by the session secret)
	next    int
	convs   map[string]map[string]any // conversation id → GET body
	polls   map[string]int

	deleted    map[string]string // conversation id → key that deleted it
	deleteFail int               // the next DELETEs that fail with 503
	deletes    int               // DELETE requests, failed or not
	pageSize   int               // list page size (0: whatever was asked)
	lists      int
	start      int64 // start time for addConv (0: now)
}

var fakeAgents = map[string]string{"xk_primary_1": "agent_a", "xk_backup_2": "agent_b", "xk_broken_3": "agent_a"}

func newFakeEleven(t *testing.T) (*fakeEleven, *httptest.Server) {
	f := &fakeEleven{keyErr: map[string]int{}, mints: map[string]int{}, convs: map[string]map[string]any{}, polls: map[string]int{}, deleted: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		k := r.Header.Get("xi-api-key")
		if r.URL.Path == "/v1/convai/conversation/get-signed-url" {
			f.mints[k]++ // asked, whether or not it works
		}
		if code := f.keyErr[k]; code != 0 {
			w.WriteHeader(code)
			if code == 400 {
				fmt.Fprint(w, `{"detail":{"type":"authentication_error","code":"invalid_api_key","message":"API key ID used as API key"}}`)
			} else {
				fmt.Fprint(w, `{"detail":{"message":"nope"}}`)
			}
			return
		}
		if _, ok := fakeAgents[k]; !ok {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/v1/convai/conversation/get-signed-url":
			if r.URL.Query().Get("agent_id") != fakeAgents[k] {
				w.WriteHeader(404)
				return
			}
			f.next++
			u := fmt.Sprintf("wss://fake/v1/convai/conversation?agent_id=%s&conversation_signature=sig", fakeAgents[k])
			if !f.noConv {
				u += fmt.Sprintf("&conversation_id=conv_%d", f.next)
			}
			json.NewEncoder(w).Encode(map[string]string{"signed_url": u})
		case r.URL.Path == "/v1/convai/conversations" && r.Method == http.MethodGet:
			// the account's conversations for one agent, started before a time, oldest first
			f.lists++
			q := r.URL.Query()
			before, _ := strconv.ParseInt(q.Get("call_start_before_unix"), 10, 64)
			var ids []string
			for id, c := range f.convs {
				st := c["metadata"].(map[string]any)["start_time_unix_secs"].(int64)
				if c["agent_id"] == fakeAgents[k] && c["agent_id"] == q.Get("agent_id") && (before == 0 || st < before) {
					ids = append(ids, id)
				}
			}
			sort.Strings(ids)
			from, _ := strconv.Atoi(q.Get("cursor"))
			size, _ := strconv.Atoi(q.Get("page_size"))
			if f.pageSize > 0 {
				size = f.pageSize
			}
			to := min(len(ids), from+size)
			var page []map[string]any
			for _, id := range ids[min(from, to):to] {
				c := f.convs[id]
				page = append(page, map[string]any{"conversation_id": id, "agent_id": c["agent_id"], "status": c["status"],
					"start_time_unix_secs": c["metadata"].(map[string]any)["start_time_unix_secs"]})
			}
			out := map[string]any{"conversations": page, "has_more": to < len(ids)}
			if to < len(ids) {
				out["next_cursor"] = strconv.Itoa(to)
			}
			json.NewEncoder(w).Encode(out)
		case strings.HasPrefix(r.URL.Path, "/v1/convai/conversations/") && r.Method == http.MethodDelete:
			f.deletes++
			if f.deleteFail > 0 {
				f.deleteFail--
				w.WriteHeader(503)
				fmt.Fprint(w, `{"detail":"try later, hunter2"}`)
				return
			}
			id := strings.TrimPrefix(r.URL.Path, "/v1/convai/conversations/")
			c, ok := f.convs[id]
			if !ok || c["agent_id"] != fakeAgents[k] {
				w.WriteHeader(404)
				return
			}
			delete(f.convs, id)
			f.deleted[id] = k
			fmt.Fprint(w, `{}`)
		case strings.HasPrefix(r.URL.Path, "/v1/convai/conversations/"):
			f.fetches++
			id := strings.TrimPrefix(r.URL.Path, "/v1/convai/conversations/")
			c, ok := f.convs[id]
			if !ok || c["agent_id"] != fakeAgents[k] {
				w.WriteHeader(404)
				return
			}
			f.polls[id]++
			out := map[string]any{}
			for kk, v := range c {
				out[kk] = v
			}
			if f.polls[id] == 1 {
				out["status"] = "in-progress" // the first look is still mid-call
			}
			json.NewEncoder(w).Encode(out)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

// startAt: when the next added conversation started (now, unless a test set f.start).
func (f *fakeEleven) startAt() int64 {
	if f.start != 0 {
		return f.start
	}
	return time.Now().Unix()
}

func (f *fakeEleven) setKeyErr(k string, code int) {
	f.mu.Lock()
	f.keyErr[k] = code
	f.mu.Unlock()
}

func (f *fakeEleven) addConv(id, agent, session string, lines ...string) {
	var tr []map[string]any
	for i, l := range lines {
		role, msg, _ := strings.Cut(l, ": ")
		tr = append(tr, map[string]any{"role": role, "message": msg, "time_in_call_secs": i * 5})
	}
	f.mu.Lock()
	f.convs[id] = map[string]any{
		"agent_id": agent, "conversation_id": id, "status": "done", "transcript": tr,
		"metadata":                            map[string]any{"start_time_unix_secs": f.startAt()},
		"conversation_initiation_client_data": map[string]any{"dynamic_variables": map[string]any{"fm_session": session, "first_name": "Buzz"}},
	}
	f.mu.Unlock()
}

type voiceEnv struct {
	srv   *httptest.Server
	acc   *accounts
	store *memStore
	fake  *fakeEleven
	v     *voiceGuide
	a, b  int64 // two attendees
}

func voiceServer(t *testing.T, keys []*voiceKey, cap int) *voiceEnv {
	t.Helper()
	fake, fsrv := newFakeEleven(t)
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	a, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "g-1", Email: "buzz@gatech.edu", Name: "Buzz Bee", Given: "Buzz"})
	b, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "g-2", Email: "george@gatech.edu", Name: "George Burdell", Given: "George"})
	var v *voiceGuide
	if keys != nil {
		v = newVoiceGuide(keys, fsrv.URL, cap)
		v.pollWait = 10 * time.Millisecond
		acc.voice = v
	}
	mux := http.NewServeMux()
	mountVoice(mux, acc, v, func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &voiceEnv{srv, acc, store, fake, v, a.ID, b.ID}
}

func (e *voiceEnv) post(t *testing.T, path string, who int64, origin, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", e.srv.URL+path, strings.NewReader(body))
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if who != 0 {
		v, exp := e.acc.sess.issue(kindSession, who, time.Hour)
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: v, Expires: exp})
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

const site = "https://site.test"

func TestVoiceOff(t *testing.T) {
	t.Setenv("ELEVENLABS_API_KEY", "")
	t.Setenv("ELEVENLABS_API_KEY_FILE", "")
	t.Setenv("ELEVENLABS_API_KEY_BACKUP", "")
	t.Setenv("ELEVENLABS_API_KEY_BACKUP_FILE", "")
	t.Setenv("ELEVENLABS_AGENT_ID", "agent_x")
	if openVoice() != nil {
		t.Fatal("no keys: voice should be off")
	}
	t.Setenv("ELEVENLABS_API_KEY", "k")
	t.Setenv("ELEVENLABS_AGENT_ID", "")
	if openVoice() != nil {
		t.Fatal("no agent: voice should be off")
	}
	e := voiceServer(t, nil, 1)
	if code, _ := e.post(t, "/api/voice/start", e.a, site, ""); code != http.StatusNotFound {
		t.Fatalf("off: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"conv_1"}`); code != http.StatusNotFound {
		t.Fatalf("off finish: %d", code)
	}
}

func TestVoiceStartGuards(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}}, 10)
	if code, _ := e.post(t, "/api/voice/start", e.a, "", ""); code != http.StatusForbidden {
		t.Fatalf("no origin: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/start", e.a, "https://evil.test", ""); code != http.StatusForbidden {
		t.Fatalf("bad origin: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/start", 0, site, ""); code != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", code)
	}
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/voice/start", nil)
	req.Header.Set("Origin", site)
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != http.StatusForbidden {
		t.Fatalf("GET: %d", res.StatusCode)
	}
	code, out := e.post(t, "/api/voice/start", e.a, site, "")
	if code != 200 || !strings.HasPrefix(out["signed_url"].(string), "wss://") || out["session"] == "" || out["first_name"] != "Buzz" || len(out["questions"].([]any)) != 5 {
		t.Fatalf("start: %d %v", code, out)
	}
	if strings.Contains(fmt.Sprint(out), "xk_") {
		t.Fatal("the key must never reach the page")
	}
	// 3 an hour each
	e.post(t, "/api/voice/start", e.a, site, "")
	e.post(t, "/api/voice/start", e.a, site, "")
	if code, _ := e.post(t, "/api/voice/start", e.a, site, ""); code != http.StatusTooManyRequests {
		t.Fatalf("4th call in an hour: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/start", e.b, site, ""); code != 200 {
		t.Fatalf("someone else isn't limited by that: %d", code)
	}
}

func TestVoiceCap(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}}, 1)
	if code, _ := e.post(t, "/api/voice/start", e.a, site, ""); code != 200 {
		t.Fatalf("first: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/start", e.b, site, ""); code != http.StatusServiceUnavailable {
		t.Fatalf("over the cap: %d", code)
	}
	// once a call is old enough to be over, its place frees up
	e.v.mu.Lock()
	e.v.now = func() time.Time { return time.Now().Add(voiceLiveFor + time.Second) }
	e.v.mu.Unlock()
	if code, _ := e.post(t, "/api/voice/start", e.b, site, ""); code != 200 {
		t.Fatalf("after the first call: %d", code)
	}
}

// A hung-up call, or one replaced by the same person's next call, frees its place at once.
func TestVoiceHangUpFreesThePlace(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}}, 1)
	if code, _ := e.post(t, "/api/voice/start", e.a, site, ""); code != 200 {
		t.Fatalf("first: %d", code)
	}
	// A starts again (the old call left running in another tab): the new one replaces it
	if code, _ := e.post(t, "/api/voice/start", e.a, site, ""); code != 200 {
		t.Fatalf("a second call of one's own: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/start", e.b, site, ""); code != http.StatusServiceUnavailable {
		t.Fatalf("A's call still holds the one place: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/end", e.a, site, ""); code != http.StatusNoContent {
		t.Fatalf("hang up: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/start", e.b, site, ""); code != 200 {
		t.Fatalf("after A hung up: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/end", e.a, "https://evil.test", ""); code != http.StatusForbidden {
		t.Fatalf("hang up from another site: %d", code)
	}
}

func TestVoiceKeyFailover(t *testing.T) {
	for _, bad := range []int{400, 401, 429, 503} {
		t.Run(fmt.Sprint(bad), func(t *testing.T) {
			e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_broken_3", agent: "agent_a"}, {name: "backup", key: "xk_backup_2", agent: "agent_b"}}, 10)
			e.fake.setKeyErr("xk_broken_3", bad)
			code, out := e.post(t, "/api/voice/start", e.a, site, "")
			if code != 200 || !strings.Contains(out["signed_url"].(string), "agent_b") {
				t.Fatalf("backup: %d %v", code, out)
			}
			e.post(t, "/api/voice/start", e.b, site, "")
			want := 1
			if bad == 503 {
				want = 2 // a blip, not the key's fault: the primary is tried again next time
			}
			e.fake.mu.Lock()
			defer e.fake.mu.Unlock()
			if e.fake.mints["xk_broken_3"] != want || e.fake.mints["xk_backup_2"] != 2 {
				t.Fatalf("after a %d the bad key is skipped: %v", bad, e.fake.mints)
			}
		})
	}
	// both bad: an honest error, no key in it
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_broken_3", agent: "agent_a"}}, 10)
	e.fake.setKeyErr("xk_broken_3", 401)
	if code, out := e.post(t, "/api/voice/start", e.a, site, ""); code != http.StatusBadGateway || strings.Contains(fmt.Sprint(out), "xk_") {
		t.Fatalf("no key works: %d %v", code, out)
	}
}

var transcript = []string{
	"agent: Hi Buzz, I'm the HackGT 13 voice guide for facemash, and I've got five quick questions so your bean can get to know you. First: What are you building this weekend, and what's the part you're most excited about?",
	"user: A drone that waters plants.",
	"agent: Love that. What part are you most excited about?",
	"user: The computer vision bit.",
	"agent: Nice. What's the one thing you're stuck on right now, the bug or problem you'd love help with?",
	"user: Our login is broken, my password is hunter2 if that helps",
	"agent: Got it. What's something you're really good at that you could help someone else with here?",
	"user: Rust and embedded stuff.",
	"agent: What's a niche thing you're into that almost nobody else here shares?",
	"user: Competitive yo-yo.",
	"agent: Who would be your dream person to meet this weekend, and why?",
	"user: Someone from NASA, because space.",
	"agent: Thanks Buzz, that's everything, your bean is getting dressed.",
}

func TestVoiceFinish(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}}, 10)
	_, st := e.post(t, "/api/voice/start", e.a, site, "")
	conv := strings.Split(strings.Split(st["signed_url"].(string), "conversation_id=")[1], "&")[0]
	e.fake.addConv(conv, "agent_a", st["session"].(string), transcript...)
	_, stB := e.post(t, "/api/voice/start", e.b, site, "")
	convB := strings.Split(strings.Split(stB["signed_url"].(string), "conversation_id=")[1], "&")[0]

	if code, _ := e.post(t, "/api/voice/finish", e.a, "", `{"conversation_id":"`+conv+`"}`); code != http.StatusForbidden {
		t.Fatalf("no origin: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"../x"}`); code != http.StatusBadRequest {
		t.Fatalf("junk id: %d", code)
	}
	// someone else's call: refused, and nothing is saved for them
	if code, _ := e.post(t, "/api/voice/finish", e.b, site, `{"conversation_id":"`+conv+`"}`); code != http.StatusForbidden {
		t.Fatalf("B finishing A's call: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+convB+`"}`); code != http.StatusForbidden {
		t.Fatalf("A finishing B's call: %d", code)
	}

	code, out := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+conv+`"}`)
	if code != 200 || out["ok"] != true || out["redacted"].(float64) < 1 {
		t.Fatalf("finish: %d %v", code, out)
	}
	ans := out["answers"].([]any)
	if len(ans) != 5 || ans[0].(map[string]any)["a"] != "A drone that waters plants. The computer vision bit." || strings.Contains(fmt.Sprint(ans), "hunter2") {
		t.Fatalf("answers: %v", ans)
	}
	e.store.mu.Lock()
	mem := e.store.memory[memKey("hackgt13", e.a)]
	e.store.mu.Unlock()
	var obj map[string]any
	if json.Unmarshal(mem.data, &obj) != nil {
		t.Fatalf("stored: %s", mem.data)
	}
	md := obj["user_md"].(string)
	if obj["source"] != "voice" || obj["user_id"] != "Buzz Bee" || !strings.HasPrefix(md, "# What Buzz told the HackGT voice guide\n") ||
		!strings.Contains(md, "## "+voiceQuestions[3]+"\nCompetitive yo-yo.") || !strings.Contains(md, "Someone from NASA, because space.") {
		t.Fatalf("memory: %s", md)
	}
	for _, agentOnly := range []string{"Love that", "Got it", "your bean is getting dressed", "I'm the HackGT 13 voice guide", "hunter2"} {
		if strings.Contains(string(mem.data), agentOnly) {
			t.Fatalf("memory holds %q: %s", agentOnly, md)
		}
	}
	if info, _ := e.store.MemoryInfo(context.Background(), "hackgt13", e.b); info["stored"] != false {
		t.Fatal("B got a memory")
	}

	// again: the same answer, no second fetch or save
	e.fake.mu.Lock()
	fetched := e.fake.fetches
	e.fake.mu.Unlock()
	e.store.DeleteMemory(context.Background(), "hackgt13", e.a)
	code, again := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+conv+`"}`)
	e.fake.mu.Lock()
	fetchedAgain := e.fake.fetches
	e.fake.mu.Unlock()
	if code != 200 || fmt.Sprint(again) != fmt.Sprint(out) || fetchedAgain != fetched {
		t.Fatalf("idempotent: %d %v (fetches %d→%d)", code, again, fetched, fetchedAgain)
	}
	if info, _ := e.store.MemoryInfo(context.Background(), "hackgt13", e.a); info["stored"] != false {
		t.Fatal("a repeat finish must not save again")
	}
	if code, _ := e.post(t, "/api/voice/finish", e.b, site, `{"conversation_id":"`+conv+`"}`); code != http.StatusForbidden {
		t.Fatalf("B after A finished: %d", code)
	}
}

// without a conversation id in the signed URL, the session secret the page passed in binds it
func TestVoiceFinishBySession(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}}, 10)
	e.fake.noConv = true
	_, st := e.post(t, "/api/voice/start", e.a, site, "")
	_, stB := e.post(t, "/api/voice/start", e.b, site, "")
	e.fake.addConv("conv_a", "agent_a", st["session"].(string), transcript...)
	e.fake.addConv("conv_b", "agent_a", stB["session"].(string), transcript[:2]...)
	e.fake.addConv("conv_forged", "agent_a", "someone-elses-secret", transcript...)
	if code, _ := e.post(t, "/api/voice/finish", e.b, site, `{"conversation_id":"conv_a"}`); code != http.StatusForbidden {
		t.Fatalf("B finishing A's call: %d", code)
	}
	if code, _ := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"conv_forged"}`); code != http.StatusForbidden {
		t.Fatalf("a call nobody started here: %d", code)
	}
	if code, out := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"conv_a"}`); code != 200 || len(out["answers"].([]any)) != 5 {
		t.Fatalf("A: %d %v", code, out)
	}
	if code, out := e.post(t, "/api/voice/finish", e.b, site, `{"conversation_id":"conv_b"}`); code != 200 || len(out["answers"].([]any)) != 1 {
		t.Fatalf("B: %d %v", code, out)
	}
}

// the call lives in the backup's account when the backup started it
func TestVoiceFinishOnBackupAccount(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_broken_3", agent: "agent_a"}, {name: "backup", key: "xk_backup_2", agent: "agent_b"}}, 10)
	e.fake.setKeyErr("xk_broken_3", 401)
	_, st := e.post(t, "/api/voice/start", e.a, site, "")
	conv := strings.Split(strings.Split(st["signed_url"].(string), "conversation_id=")[1], "&")[0]
	e.fake.addConv(conv, "agent_b", st["session"].(string), transcript...)
	if code, out := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+conv+`"}`); code != 200 || len(out["answers"].([]any)) != 5 {
		t.Fatalf("finish: %d %v", code, out)
	}
	// and it's deleted there, with the key of the account it lives in
	e.v.bg.Wait()
	e.fake.mu.Lock()
	defer e.fake.mu.Unlock()
	if e.fake.deleted[conv] != "xk_backup_2" {
		t.Fatalf("deleted with %q", e.fake.deleted[conv])
	}
}

func TestVoiceStillGoing(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}}, 10)
	e.v.pollFor = 30 * time.Millisecond
	_, st := e.post(t, "/api/voice/start", e.a, site, "")
	conv := strings.Split(strings.Split(st["signed_url"].(string), "conversation_id=")[1], "&")[0]
	e.fake.addConv(conv, "agent_a", st["session"].(string), transcript...)
	e.fake.mu.Lock()
	e.fake.convs[conv]["status"] = "in-progress"
	e.fake.mu.Unlock()
	if code, _ := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+conv+`"}`); code != http.StatusConflict {
		t.Fatalf("mid-call: %d", code)
	}
	e.fake.mu.Lock()
	e.fake.convs[conv]["status"] = "done"
	e.fake.mu.Unlock()
	if code, _ := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+conv+`"}`); code != 200 {
		t.Fatalf("after: %d", code)
	}
}

func TestMemoryFrom(t *testing.T) {
	var c conversation
	msg := func(s string) *string { return &s }
	for _, l := range []string{
		"user: hello?",                // before any question: dropped
		"agent: " + voiceQuestions[1], // they can start later...
		"user: segfaults",             // ...
		"agent: " + voiceQuestions[0], // ...and an earlier question never pulls answers back
		"user: still segfaults",       // counts for question 2
		"agent: What’s a niche thing you’re into that almost nobody else here shares?", // curly quotes
		"user: knitting",
	} {
		role, m, _ := strings.Cut(l, ": ")
		c.Transcript = append(c.Transcript, struct {
			Role    string  `json:"role"`
			Message *string `json:"message"`
		}{role, msg(m)})
	}
	obj, ans := memoryFrom("Buzz Bee", "Buzz", c, time.Unix(0, 0))
	if len(ans) != 2 || ans[0].A != "segfaults still segfaults" || ans[1].Q != voiceQuestions[3] || ans[1].A != "knitting" {
		t.Fatalf("answers: %+v", ans)
	}
	if strings.Contains(obj["user_md"].(string), "hello?") || obj["exported_at"] != "1970-01-01T00:00:00Z" {
		t.Fatalf("memory: %v", obj)
	}
}

// A dead or muted mic must not run the clock: the agent hangs up on silence, well before the cap.
func TestVoiceAgentHangsUpOnSilence(t *testing.T) {
	cc := voiceAgentConfig()["conversation_config"].(map[string]any)
	silent := cc["turn"].(map[string]any)["silence_end_call_timeout"].(int)
	max := cc["conversation"].(map[string]any)["max_duration_seconds"].(int)
	if silent <= 0 || silent >= max {
		t.Fatalf("silence_end_call_timeout %d should be set and under max_duration_seconds %d", silent, max)
	}
	prompt := cc["agent"].(map[string]any)["prompt"].(map[string]any)["prompt"].(string)
	if !strings.Contains(prompt, "Don't keep asking") {
		t.Fatal("the prompt should tell the guide to stop checking in and end the call")
	}
	// the backstop behind deleting each transcript ourselves: ElevenLabs keeps none past a day
	priv := voiceAgentConfig()["platform_settings"].(map[string]any)["privacy"].(map[string]any)
	if priv["record_voice"] != false || priv["retention_days"] != 1 || priv["delete_transcript_and_pii"] != true {
		t.Fatalf("privacy: %v", priv)
	}
}

// logsTo collects the log for one test.
type logBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func logsTo(t *testing.T) *logBuf {
	l := &logBuf{}
	log.SetOutput(l)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return l
}

// Once the answers are saved, ElevenLabs' copy of the call is deleted: retried when it fails,
// on the account the call lives in, and the log says only how it went (a status code).
func TestVoiceForgetsTranscript(t *testing.T) {
	logs := logsTo(t)
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}}, 10)
	e.v.forgetWaits = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	_, st := e.post(t, "/api/voice/start", e.a, site, "")
	conv := strings.Split(strings.Split(st["signed_url"].(string), "conversation_id=")[1], "&")[0]
	e.fake.addConv(conv, "agent_a", st["session"].(string), transcript...)
	e.fake.mu.Lock()
	e.fake.deleteFail = 2 // two blips, then it works
	e.fake.mu.Unlock()

	code, out := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+conv+`"}`)
	if code != 200 || len(out["answers"].([]any)) != 5 {
		t.Fatalf("finish: %d %v", code, out)
	}
	e.v.bg.Wait()
	e.fake.mu.Lock()
	by, left, tries := e.fake.deleted[conv], e.fake.convs[conv], e.fake.deletes
	e.fake.mu.Unlock()
	if by != "xk_primary_1" || left != nil || tries != 3 {
		t.Fatalf("deleted by %q, still there: %v, %d tries", by, left != nil, tries)
	}
	// finishing again still works: the answers are remembered here, not fetched again
	if code, again := e.post(t, "/api/voice/finish", e.a, site, `{"conversation_id":"`+conv+`"}`); code != 200 || fmt.Sprint(again) != fmt.Sprint(out) {
		t.Fatalf("again after delete: %d %v", code, again)
	}

	// never works: it gives up after the retries, and the sweep is left to it
	_, stB := e.post(t, "/api/voice/start", e.b, site, "")
	convB := strings.Split(strings.Split(stB["signed_url"].(string), "conversation_id=")[1], "&")[0]
	e.fake.addConv(convB, "agent_a", stB["session"].(string), transcript...)
	e.fake.mu.Lock()
	e.fake.deleteFail, e.fake.deletes = 100, 0
	e.fake.mu.Unlock()
	if code, _ := e.post(t, "/api/voice/finish", e.b, site, `{"conversation_id":"`+convB+`"}`); code != 200 {
		t.Fatalf("finish B: %d", code)
	}
	e.v.bg.Wait()
	e.fake.mu.Lock()
	tries, left = e.fake.deletes, e.fake.convs[convB]
	e.fake.mu.Unlock()
	if tries != 4 || left == nil {
		t.Fatalf("B: %d tries, still there: %v", tries, left != nil)
	}

	l := logs.String()
	if !strings.Contains(l, "transcript deleted at ElevenLabs: 200") || !strings.Contains(l, "transcript not deleted at ElevenLabs: 503") {
		t.Fatalf("log: %s", l)
	}
	for _, never := range []string{"hunter2", "xk_primary_1", conv, convB, "drone"} {
		if strings.Contains(l, never) {
			t.Fatalf("the log holds %q: %s", never, l)
		}
	}
}

// The sweep deletes old calls nobody finished (a closed tab), in every account, a page at a
// time; never a new one, one still going, one being saved, or another agent's.
func TestVoiceSweepTranscripts(t *testing.T) {
	e := voiceServer(t, []*voiceKey{{name: "primary", key: "xk_primary_1", agent: "agent_a"}, {name: "backup", key: "xk_backup_2", agent: "agent_b"}}, 10)
	f := e.fake
	f.mu.Lock()
	f.pageSize = 2
	f.start = time.Now().Add(-voiceSweepAge - 5*time.Minute).Unix()
	f.mu.Unlock()
	for _, id := range []string{"old_a1", "old_a2", "old_a3", "old_live", "old_saving"} {
		f.addConv(id, "agent_a", "s", transcript...)
	}
	f.addConv("old_b", "agent_b", "s", transcript...)
	f.addConv("old_other", "agent_x", "s", transcript...)
	f.mu.Lock()
	f.convs["old_live"]["status"] = "in-progress"
	f.start = time.Now().Add(-5 * time.Minute).Unix()
	f.mu.Unlock()
	f.addConv("new_a", "agent_a", "s", transcript...)
	e.v.mu.Lock()
	e.v.saving["old_saving"] = true
	e.v.mu.Unlock()

	if n := e.v.sweepTranscripts(context.Background()); n != 4 {
		t.Fatalf("swept %d, want 4", n)
	}
	f.mu.Lock()
	var left []string
	for id := range f.convs {
		left = append(left, id)
	}
	sort.Strings(left)
	byB, lists := f.deleted["old_b"], f.lists
	f.mu.Unlock()
	if fmt.Sprint(left) != "[new_a old_live old_other old_saving]" || byB != "xk_backup_2" || lists < 4 {
		t.Fatalf("left %v, old_b deleted by %q, %d list calls", left, byB, lists)
	}
	if n := e.v.sweepTranscripts(context.Background()); n != 0 {
		t.Fatalf("second sweep: %d", n)
	}
}
