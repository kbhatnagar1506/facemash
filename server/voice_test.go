package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
}

var fakeAgents = map[string]string{"xk_primary_1": "agent_a", "xk_backup_2": "agent_b", "xk_broken_3": "agent_a"}

func newFakeEleven(t *testing.T) (*fakeEleven, *httptest.Server) {
	f := &fakeEleven{keyErr: map[string]int{}, mints: map[string]int{}, convs: map[string]map[string]any{}, polls: map[string]int{}}
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
		"metadata":                            map[string]any{"start_time_unix_secs": time.Now().Unix()},
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
