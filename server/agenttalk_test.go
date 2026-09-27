package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- fakes ----------

// fakeGemini answers like the three Gemini prompts do: briefs, agent answers (streamed over
// SSE), icebreakers. answer decides what an agent says, given its user prompt.
type fakeGemini struct {
	mu      sync.Mutex
	prompts []string // every agent-answer user prompt
	answer  func(user string) string
	fail    map[string]int // model → HTTP status to fail with
	calls   map[string]int // model → calls
}

var fakeMarker = regexp.MustCompile(`MARK[A-Z0-9]+`)

func (f *fakeGemini) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		model, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/v1beta/models/"), ":")
		f.mu.Lock()
		if f.calls == nil {
			f.calls = map[string]int{}
		}
		f.calls[model]++
		code := f.fail[model]
		f.mu.Unlock()
		if code != 0 {
			w.WriteHeader(code)
			io.WriteString(w, `{"error":{"status":"UNAVAILABLE"}}`)
			return
		}
		if r.Method == http.MethodGet { // warm-up
			io.WriteString(w, `{}`)
			return
		}
		var in struct {
			System struct {
				Parts []struct{ Text string } `json:"parts"`
			} `json:"systemInstruction"`
			Contents []struct {
				Parts []struct{ Text string } `json:"parts"`
			} `json:"contents"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		sys, user := in.System.Parts[0].Text, in.Contents[0].Parts[0].Text
		var out string
		switch {
		case strings.Contains(sys, "condense"):
			out = `{"one_line":"Building a thing","stuck_on":["flaky websocket reconnects"],"solved":[],"looking_for":[],"rare":["tabla"],"going_through":["first hackathon"],"interrupt_ok":true}`
		case strings.Contains(sys, "icebreaker"):
			out = `{"line":"One of you already beat flaky websocket reconnects, Octavian.","question":"How did you make the websocket relay survive reconnects?"}`
		default:
			f.mu.Lock()
			f.prompts = append(f.prompts, user)
			ans := f.answer
			f.mu.Unlock()
			text := "My human is working on something fun."
			if ans != nil {
				text = ans(user)
			}
			b, _ := json.Marshal(map[string]any{"answer": text, "cites": []string{"stuck_on"}, "not_in_memory": false})
			out = string(b)
		}
		chunk := func(s string) string {
			b, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": s}}}}}})
			return string(b)
		}
		if strings.Contains(r.URL.Path, ":streamGenerateContent") {
			w.Header().Set("Content-Type", "text/event-stream")
			for i := 0; i < len(out); i += 17 { // small pieces, like the real stream
				fmt.Fprintf(w, "data: %s\r\n\r\n", chunk(out[i:min(i+17, len(out))]))
				w.(http.Flusher).Flush()
			}
			return
		}
		io.WriteString(w, chunk(out))
	}
}

// fakeJev answers every question type; pick decides the "next" choice.
type fakeJev struct {
	mu     sync.Mutex
	gates  map[string]float64 // gate key → noul
	scores map[string]float64
	reason string
	pick   func(opts map[string]string) string
	states []string
	enough float64
}

func (f *fakeJev) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			State     string                     `json:"state"`
			Questions map[string]json.RawMessage `json:"questions"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.states = append(f.states, in.State)
		ans := map[string]any{}
		for name, raw := range in.Questions {
			var q struct {
				Type     string          `json:"type"`
				Criteria json.RawMessage `json:"criteria"`
			}
			json.Unmarshal(raw, &q)
			switch {
			case name == "next":
				var opts map[string]string
				json.Unmarshal(q.Criteria, &opts)
				choice := ""
				if f.pick != nil {
					choice = f.pick(opts)
				} else {
					ids := make([]string, 0, len(opts))
					for id := range opts {
						ids = append(ids, id)
					}
					sort.Strings(ids)
					choice = ids[0]
				}
				ans[name] = map[string]any{"choice": choice, "confidence": 0.7}
			case name == "enough":
				ans[name] = map[string]any{"noul": f.enough}
			case strings.HasPrefix(name, "gate_"):
				ans[name] = map[string]any{"noul": f.gates[strings.TrimPrefix(name, "gate_")]}
			case strings.HasPrefix(name, "score_"):
				ans[name] = map[string]any{"score": f.scores[strings.TrimPrefix(name, "score_")], "confidence": 0.7}
			case name == "reason":
				ans[name] = map[string]any{"choice": f.reason}
			case name == "opener":
				ans[name] = map[string]any{"choice": "ask_fix"}
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"answers": ans})
	}
}

type sentFrame struct {
	uid int64
	msg map[string]any
	raw string
}

type fakeSink struct {
	mu     sync.Mutex
	frames []sentFrame
	off    map[int64]bool
}

func (s *fakeSink) send(uid int64, msg map[string]any) {
	b, _ := json.Marshal(msg)
	var cp map[string]any
	json.Unmarshal(b, &cp)
	s.mu.Lock()
	s.frames = append(s.frames, sentFrame{uid, cp, string(b)})
	s.mu.Unlock()
}
func (s *fakeSink) online(uid int64) bool { s.mu.Lock(); defer s.mu.Unlock(); return !s.off[uid] }
func (s *fakeSink) where(int64) string    { return "nearby" }

func (s *fakeSink) all() []sentFrame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]sentFrame(nil), s.frames...)
}

func (s *fakeSink) wait(t *testing.T, what string, pred func(sentFrame) bool) sentFrame {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, f := range s.all() {
			if pred(f) {
				return f
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
	return sentFrame{}
}

// fixedRecall: every search of a person's memory returns their notes, whatever the query.
type fixedRecall struct{ notes map[int64][]string }

func (f fixedRecall) search(_ context.Context, _ string, id int64, _ string, n int) []talkSnippet {
	var out []talkSnippet
	for i, s := range f.notes[id] {
		if i < n {
			out = append(out, talkSnippet{From: "note", Text: s, Score: 0.9})
		}
	}
	return out
}

// ---------- harness ----------

type talkHarness struct {
	t      *testing.T
	store  *memStore
	acc    *accounts
	talk   *agentTalk
	sink   *fakeSink
	gem    *fakeGemini
	jev    *fakeJev
	a, b   int64 // tenant "hackgt13"
	c      int64 // same tenant, a third person
	x      int64 // another tenant
	tenant string
}

func strongGates() map[string]float64 {
	return map[string]float64{"a_fixed_b": 0.1, "b_fixed_a": 0.9, "same_problem": 0.3, "team": 0.8, "going_through": 0.2, "rare": 0.9, "one_sided": 0.1, "busy": 0.05}
}

func newTalkHarness(t *testing.T) *talkHarness {
	t.Helper()
	cfg, err := loadTalkConfig("")
	if err != nil {
		t.Fatal(err)
	}
	cfg.Limits.MinGapMS = 0
	cfg.Phase1.Questions = 3
	cfg.Phase2.Questions = 2
	cfg.Phase2.MinQuestions = 1
	cfg.Models.HedgeMS = 2000
	store := newMemStore()
	h := &talkHarness{t: t, store: store, tenant: "hackgt13", sink: &fakeSink{off: map[int64]bool{}},
		gem: &fakeGemini{}, jev: &fakeJev{gates: strongGates(), scores: map[string]float64{"value_a": 4, "value_b": 4, "soon": 5, "talk_again": 4, "small_talk": 4}, reason: "b_fixed_a"}}
	h.acc = &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	ctx := context.Background()
	mk := func(tenant, email, name, given string, b talkBrief) int64 {
		a, _, _ := store.SignIn(ctx, tenant, user{Sub: "g-" + email, Email: email, Name: name, Given: given})
		store.SaveProfile(ctx, tenant, a.ID, Profile{Name: given, Look: "b=#ff8a3d;h=cap"})
		store.talkSavePrefs(ctx, tenant, a.ID, talkPrefs{OptIn: true})
		b.V = talkBriefVersion // current: not rebuilt in the background
		store.talkSaveBrief(ctx, tenant, a.ID, b)
		return a.ID
	}
	h.a = mk("hackgt13", "zephyrine@example.com", "Zephyrine Quux", "Zephyrine", talkBrief{OneLine: "Building a live soccer scoreboard app", StuckOn: []string{"flaky websocket reconnects on phones"}, Rare: []string{"tabla"}, GoingThrough: []string{"first hackathon"}, InterruptOK: true})
	h.b = mk("hackgt13", "octavian@example.com", "Octavian Blix", "Octavian", talkBrief{OneLine: "Building a websocket relay in Go", Solved: []string{"websocket relay that survives reconnects"}, Rare: []string{"tabla"}, GoingThrough: []string{"first hackathon"}, InterruptOK: true})
	h.c = mk("hackgt13", "carmody@example.com", "Carmody Vale", "Carmody", talkBrief{OneLine: "Painting murals", InterruptOK: true})
	h.x = mk("otherevent", "xylo@example.com", "Xylo Fenn", "Xylo", talkBrief{OneLine: "Elsewhere", InterruptOK: true})
	gsrv := httptest.NewServer(h.gem.handler())
	jsrv := httptest.NewServer(h.jev.handler())
	t.Cleanup(gsrv.Close)
	t.Cleanup(jsrv.Close)
	h.talk = newAgentTalk(cfg, h.acc, store, h.sink)
	h.talk.bank = talkFixtureBank
	h.talk.gem = &talkGemini{key: "test", base: gsrv.URL + "/v1beta/models/", hc: gsrv.Client()}
	h.talk.jev = &talkJev{key: "test", url: jsrv.URL, model: "jev-latest", hc: jsrv.Client()}
	h.acc.talk = h.talk
	return h
}

func (h *talkHarness) prefs(id int64, p talkPrefs) {
	h.store.talkSavePrefs(context.Background(), h.tenant, id, p)
}

// run starts a talk between a and b and waits for its verdict.
func (h *talkHarness) run(a, b int64) (string, map[string]any) {
	h.t.Helper()
	id, err := h.talk.encounter(context.Background(), h.tenant, a, b, false)
	if err != nil {
		h.t.Fatalf("encounter: %v", err)
	}
	v := h.sink.wait(h.t, "verdict", func(f sentFrame) bool { return f.msg["t"] == "verdict" && f.msg["id"] == id && f.uid == a })
	return id, v.msg
}

func (h *talkHarness) record(id string) *talkRecord {
	h.t.Helper()
	var rec *talkRecord
	for i := 0; i < 400; i++ {
		var err error
		if rec, err = h.store.talkGet(context.Background(), h.tenant, id); err == nil && rec.State != "live" {
			return rec
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("talk %s never finished", id)
	return rec
}

func (h *talkHarness) waitIcebreaker(id string) {
	for i := 0; i < 400; i++ {
		if rec, _ := h.store.talkGet(context.Background(), h.tenant, id); rec != nil && rec.Icebreaker != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func questionIDs(rec *talkRecord) []string {
	var out []string
	for _, l := range rec.Transcript {
		if l.Kind == "question" {
			out = append(out, l.QID)
		}
	}
	return out
}

// ---------- tests ----------

func TestTalkNamesNeverBeforeReveal(t *testing.T) {
	h := newTalkHarness(t)
	h.gem.answer = func(string) string {
		// a misbehaving agent: names, an email and a phone number
		return "Zephyrine Quux says hi to Octavian! Mail octavian@example.com or call 404-555-0199. My human is stuck on flaky websocket reconnects."
	}
	id, v := h.run(h.a, h.b)
	if v["match"] != true {
		t.Fatalf("expected a match: %v", v)
	}
	h.waitIcebreaker(id)
	if st, err := h.talk.decide(context.Background(), h.tenant, h.a, id, true); err != nil || st != "awaiting" {
		t.Fatalf("first approve: %s %v", st, err)
	}
	st, err := h.talk.decide(context.Background(), h.tenant, h.b, id, true)
	if err != nil || st != "revealed" {
		t.Fatalf("second approve: %s %v", st, err)
	}
	secret := regexp.MustCompile(`(?i)zephyrine|quux|octavian|blix|example\.com|404-555`)
	revealed := false
	for _, f := range h.sink.all() {
		if f.msg["t"] == "reveal" {
			revealed = true
			if f.uid == h.a && !strings.Contains(f.raw, "Octavian") {
				t.Fatalf("A's reveal should name B: %s", f.raw)
			}
			if ice := f.msg["icebreaker"].(map[string]any); secret.MatchString(fmt.Sprint(ice)) {
				t.Fatalf("names in the icebreaker: %v", ice)
			}
			continue
		}
		if revealed {
			continue
		}
		if secret.MatchString(f.raw) {
			t.Fatalf("a name or contact went out before the reveal: %s", f.raw)
		}
	}
	if !revealed {
		t.Fatal("no reveal")
	}
	rec := h.record(id)
	for _, l := range rec.Transcript {
		if secret.MatchString(l.Text) {
			t.Fatalf("stored transcript has a name: %q", l.Text)
		}
	}
}

func TestTalkConsentGatedQuestions(t *testing.T) {
	gatedFirst := func(opts map[string]string) string {
		for _, id := range []string{"f07", "f08"} {
			if _, ok := opts[id]; ok {
				return id
			}
		}
		ids := make([]string, 0, len(opts))
		for id := range opts {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		return ids[0]
	}
	// only one side allowed it: never asked
	h := newTalkHarness(t)
	h.jev.pick = gatedFirst
	h.talk.cfg.Phase1.MaxDepth, h.talk.cfg.Phase2.MaxDepth = 3, 3
	h.prefs(h.a, talkPrefs{OptIn: true, OkayToShare: true})
	h.prefs(h.b, talkPrefs{OptIn: true, OkayToShare: false})
	id, _ := h.run(h.a, h.b)
	for _, q := range questionIDs(h.record(id)) {
		if q == "f07" || q == "f08" {
			t.Fatalf("consent-gated %s asked without both consenting", q)
		}
	}
	for _, st := range h.jev.states {
		if strings.Contains(st, "first hackathon") {
			t.Fatal("going_through reached jev without both consenting")
		}
	}
	for _, p := range h.gem.prompts {
		if strings.Contains(p, "first hackathon") {
			t.Fatal("going_through reached an agent without both consenting")
		}
	}
	// both allowed: it may come up
	h2 := newTalkHarness(t)
	h2.jev.pick = gatedFirst
	h2.talk.cfg.Phase1.MaxDepth = 3
	h2.prefs(h2.a, talkPrefs{OptIn: true, OkayToShare: true})
	h2.prefs(h2.b, talkPrefs{OptIn: true, OkayToShare: true})
	id2, _ := h2.run(h2.a, h2.b)
	got := questionIDs(h2.record(id2))
	if len(got) == 0 || (got[0] != "f07" && got[0] != "f08") {
		t.Fatalf("with both consenting the gated question should be allowed: %v", got)
	}
}

func TestTalkNoRepeats(t *testing.T) {
	h := newTalkHarness(t)
	h.jev.pick = func(map[string]string) string { return "f02" } // jev keeps choosing the same one
	h.talk.cfg.Phase2.Questions = 5
	h.jev.enough = 0
	id, _ := h.run(h.a, h.b)
	qs := questionIDs(h.record(id))
	seen := map[string]bool{}
	for _, q := range qs {
		if seen[q] {
			t.Fatalf("repeated %s in %v", q, qs)
		}
		seen[q] = true
	}
	if len(qs) != h.talk.cfg.Phase1.Questions+5 {
		t.Fatalf("expected %d questions, got %v", h.talk.cfg.Phase1.Questions+5, qs)
	}
}

func TestTalkCheckpoint1StopsWarmly(t *testing.T) {
	h := newTalkHarness(t)
	h.jev.gates = map[string]float64{"a_fixed_b": 0.1, "b_fixed_a": 0.2, "same_problem": 0.1, "team": 0.3, "rare": 0.2, "going_through": 0.1, "one_sided": 0.1, "busy": 0.1}
	id, v := h.run(h.a, h.b)
	if v["match"] != false {
		t.Fatalf("expected match:false, got %v", v)
	}
	rec := h.record(id)
	if n := len(questionIDs(rec)); n != h.talk.cfg.Phase1.Questions {
		t.Fatalf("no phase 2 after a failed checkpoint 1: %d questions", n)
	}
	var closes []talkLine
	for _, l := range rec.Transcript {
		if l.Kind == "close" {
			closes = append(closes, l)
		}
	}
	if len(closes) != 2 || closes[0].Side != "a" || closes[1].Side != "b" {
		t.Fatalf("both agents should close: %+v", closes)
	}
	warm := false
	for _, pair := range h.talk.cfg.Lines.Close {
		warm = warm || (closes[0].Text == pair[0] && closes[1].Text == pair[1])
	}
	if !warm {
		t.Fatalf("closing lines should be the configured warm ones: %q / %q", closes[0].Text, closes[1].Text)
	}
	// the close came before the verdict, on both phones
	for _, uid := range []int64{h.a, h.b} {
		lastClose, verdict := -1, -1
		for i, f := range h.sink.all() {
			if f.uid != uid {
				continue
			}
			if f.msg["t"] == "agents" && strings.Contains(f.raw, closes[1].Text) {
				lastClose = i
			}
			if f.msg["t"] == "verdict" {
				verdict = i
				if len(f.msg) != 3 { // t, id, match: nothing else (no weak spots)
					t.Fatalf("no-match verdict carries extra detail: %v", f.msg)
				}
			}
		}
		if lastClose < 0 || verdict < lastClose {
			t.Fatalf("uid %d: close %d, verdict %d", uid, lastClose, verdict)
		}
	}
	if rec.State != "no_match" || rec.Fired {
		t.Fatalf("state %s fired %v", rec.State, rec.Fired)
	}
	// a red flag stops it too, even with a strong positive
	h2 := newTalkHarness(t)
	h2.jev.gates = strongGates()
	h2.jev.gates["one_sided"] = 0.95
	if _, v := h2.run(h2.a, h2.b); v["match"] != false {
		t.Fatal("a one-sided pair must not continue")
	}
}

func TestTalkFireRuleUsesLowerValue(t *testing.T) {
	cfg, _ := loadTalkConfig("")
	hi := cfg.Fire.ValueMin + 1
	lo := cfg.Fire.ValueMin - 1
	soon := cfg.Fire.SoonOrAgainMin
	if !talkFires(cfg, map[string]float64{"value_a": hi, "value_b": hi, "soon": soon}, "a_fixed_b") {
		t.Fatal("both high should fire")
	}
	if talkFires(cfg, map[string]float64{"value_a": 5, "value_b": lo, "soon": 5, "talk_again": 5}, "a_fixed_b") {
		t.Fatal("the LOWER value decides: one side low must not fire")
	}
	if talkFires(cfg, map[string]float64{"value_a": lo, "value_b": 5, "soon": 5}, "b_fixed_a") {
		t.Fatal("the LOWER value decides (other side)")
	}
	if talkFires(cfg, map[string]float64{"value_a": hi, "value_b": hi, "soon": soon - 1, "talk_again": soon - 1}, "team") {
		t.Fatal("neither soon nor talk-again: no fire")
	}
	if !talkFires(cfg, map[string]float64{"value_a": hi, "value_b": hi, "soon": 0, "talk_again": soon}, "team") {
		t.Fatal("talk-again alone is enough")
	}
	if talkFires(cfg, map[string]float64{"value_a": 5, "value_b": 5, "soon": 5, "talk_again": 5}, "none") {
		t.Fatal("reason none never fires")
	}
	// end to end: jev scores B's value low
	h := newTalkHarness(t)
	h.jev.scores = map[string]float64{"value_a": 5, "value_b": 1, "soon": 5, "talk_again": 5}
	id, v := h.run(h.a, h.b)
	if v["match"] != false {
		t.Fatalf("lower value should block: %v", v)
	}
	rec := h.record(id)
	if rec.Verdict["min_value"].(float64) != 1 {
		t.Fatalf("verdict should record the lower value: %v", rec.Verdict)
	}
}

func TestTalkRevealOnlyAfterBothApprove(t *testing.T) {
	h := newTalkHarness(t)
	id, v := h.run(h.a, h.b)
	if v["match"] != true || v["reason"] != "they_fixed_yours" || v["ask"] == "" {
		t.Fatalf("A's verdict: %v", v)
	}
	vb := h.sink.wait(t, "B's verdict", func(f sentFrame) bool { return f.msg["t"] == "verdict" && f.uid == h.b })
	if vb.msg["reason"] != "you_fixed_theirs" {
		t.Fatalf("reason is relative to each phone: %v", vb.msg)
	}
	ctx := context.Background()
	if _, err := h.talk.decide(ctx, h.tenant, h.c, id, true); !errors.Is(err, errNoTalk) {
		t.Fatalf("a stranger can't approve: %v", err)
	}
	if _, err := h.talk.decide(ctx, h.tenant, h.a, id, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	for _, f := range h.sink.all() {
		if f.msg["t"] == "reveal" {
			t.Fatal("one approval must reveal nothing")
		}
	}
	view, _ := h.talk.view(ctx, h.tenant, h.a, id)
	if strings.Contains(fmt.Sprint(view), "Octavian") {
		t.Fatalf("view before both approve shows a name: %v", view)
	}
	h.talk.decide(ctx, h.tenant, h.a, id, true) // a repeat changes nothing
	if _, err := h.talk.decide(ctx, h.tenant, h.b, id, true); err != nil {
		t.Fatal(err)
	}
	ra := h.sink.wait(t, "A's reveal", func(f sentFrame) bool { return f.msg["t"] == "reveal" && f.uid == h.a })
	rb := h.sink.wait(t, "B's reveal", func(f sentFrame) bool { return f.msg["t"] == "reveal" && f.uid == h.b })
	if ra.msg["other"].(map[string]any)["name"] != "Octavian" || rb.msg["other"].(map[string]any)["name"] != "Zephyrine" {
		t.Fatalf("reveals: %v / %v", ra.msg, rb.msg)
	}
	ice := ra.msg["icebreaker"].(map[string]any)
	if !strings.HasSuffix(ice["question"].(string), "?") {
		t.Fatalf("icebreaker: %v", ice)
	}
	rec := h.record(id)
	if rec.State != "revealed" || rec.Approvals["a"] != "approve" || rec.Approvals["b"] != "approve" {
		t.Fatalf("record: %s %v", rec.State, rec.Approvals)
	}

	// a skip closes it and reveals nothing
	h2 := newTalkHarness(t)
	id2, _ := h2.run(h2.a, h2.b)
	h2.talk.decide(ctx, h2.tenant, h2.a, id2, true)
	if st, _ := h2.talk.decide(ctx, h2.tenant, h2.b, id2, false); st != "skipped" {
		t.Fatalf("skip: %s", st)
	}
	h2.sink.wait(t, "closed", func(f sentFrame) bool { return f.msg["t"] == "closed" && f.uid == h2.a })
	for _, f := range h2.sink.all() {
		if f.msg["t"] == "reveal" {
			t.Fatal("a skip must reveal nothing")
		}
	}
	if _, err := h2.talk.decide(ctx, h2.tenant, h2.a, id2, true); !errors.Is(err, errTalkState) {
		t.Fatalf("after a skip nothing more happens: %v", err)
	}
}

// free waits until neither person is in a live talk any more.
func (h *talkHarness) free(ids ...int64) {
	for i := 0; i < 400; i++ {
		h.talk.mu.Lock()
		busy := false
		for _, id := range ids {
			busy = busy || h.talk.inTalk[memKey(h.tenant, id)] != ""
		}
		h.talk.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatal("still in a talk")
}

func TestTalkCooldownAndDailyCap(t *testing.T) {
	h := newTalkHarness(t)
	ctx := context.Background()
	if h.talk.cfg.Limits.TalksPerDay != 5 {
		t.Fatalf("config default: %d talks per person per day", h.talk.cfg.Limits.TalksPerDay)
	}
	h.jev.gates = map[string]float64{} // quick no-matches: every talk that starts counts anyway
	var others []int64
	for i := 0; i < 6; i++ {
		a, _, _ := h.store.SignIn(ctx, h.tenant, user{Sub: fmt.Sprintf("g-p%d", i), Email: fmt.Sprintf("p%d@example.com", i), Name: fmt.Sprintf("Person %d", i)})
		h.prefs(a.ID, talkPrefs{OptIn: true})
		others = append(others, a.ID)
	}
	for i := 0; i < 5; i++ {
		id, _ := h.run(h.a, others[i])
		h.record(id)
		h.free(h.a, others[i])
	}
	// the 6th talk for A, as either side
	_, err := h.talk.encounter(ctx, h.tenant, h.a, others[5], false)
	if !errors.Is(err, errTalkCap) || !strings.Contains(err.Error(), "a_uid") {
		t.Fatalf("6th talk (A first): %v", err)
	}
	_, err = h.talk.encounter(ctx, h.tenant, others[5], h.a, false)
	if !errors.Is(err, errTalkCap) || !strings.Contains(err.Error(), "b_uid") {
		t.Fatalf("6th talk (A second): %v", err)
	}
	// the other person wasn't touched by the refusal, and still has all 5
	if n, _ := h.store.talkCount(ctx, h.tenant, others[5], talkDayStart(time.Now()), false); n != 0 {
		t.Fatalf("a refused talk must not count: %d", n)
	}
	// after a restart the count comes from the store
	restarted := newAgentTalk(h.talk.cfg, h.acc, h.store, h.sink)
	restarted.gem, restarted.jev, restarted.bank = h.talk.gem, h.talk.jev, h.talk.bank
	if _, err := restarted.encounter(ctx, h.tenant, h.a, others[5], false); !errors.Is(err, errTalkCap) {
		t.Fatalf("after a restart: %v", err)
	}
	if _, err := restarted.encounter(ctx, h.tenant, h.a, others[5], true); err != nil {
		t.Fatalf("a forced demo run skips the caps: %v", err)
	}

	// the optional intros cap
	h2 := newTalkHarness(t)
	h2.talk.cfg.Limits.IntrosPerDay = 1
	if _, v := h2.run(h2.a, h2.b); v["match"] != true {
		t.Fatal("expected a match")
	}
	h2.free(h2.a, h2.b)
	if _, err := h2.talk.encounter(ctx, h2.tenant, h2.a, h2.c, false); !errors.Is(err, errTalkCap) {
		t.Fatalf("A had their intro for today: %v", err)
	}
	// the pair cooldown, either order
	h4 := newTalkHarness(t)
	h4.jev.gates = map[string]float64{}
	id4, _ := h4.run(h4.a, h4.b)
	h4.record(id4)
	h4.free(h4.a, h4.b)
	if _, err := h4.talk.encounter(ctx, h4.tenant, h4.b, h4.a, false); !errors.Is(err, errTalkPair) {
		t.Fatalf("the same pair talks once per event: %v", err)
	}
	if _, err := h4.talk.encounter(ctx, h4.tenant, h4.a, h4.c, false); err != nil {
		t.Fatalf("a new pair is fine: %v", err)
	}
	// busy and offline people are skipped
	h3 := newTalkHarness(t)
	h3.prefs(h3.b, talkPrefs{OptIn: true, Busy: true})
	if _, err := h3.talk.encounter(ctx, h3.tenant, h3.a, h3.b, false); !errors.Is(err, errTalkBusy) {
		t.Fatalf("busy: %v", err)
	}
	h3.sink.off[h3.c] = true
	if _, err := h3.talk.encounter(ctx, h3.tenant, h3.a, h3.c, false); !errors.Is(err, errTalkOffline) {
		t.Fatalf("offline: %v", err)
	}
}

func talkHTTP(t *testing.T, h *talkHarness, dev bool) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	originOK := func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" }
	mountMuse(mux, h.acc, newHub(), "event.json", "https://site.test", originOK)
	mountTalk(mux, h.acc, h.talk, originOK, dev)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func talkReq(t *testing.T, method, url, body string, hdr map[string]string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestTalkOptInDefaultOffAndOnlyByTheHuman(t *testing.T) {
	h := newTalkHarness(t)
	ctx := context.Background()
	a, _, _ := h.store.SignIn(ctx, h.tenant, user{Sub: "g-new", Email: "new@example.com", Name: "New Person"})
	if p, _ := h.store.talkPrefs(ctx, h.tenant, a.ID); p.OptIn || p.OkayToShare {
		t.Fatalf("defaults must be off: %+v", p)
	}
	if _, err := h.talk.encounter(ctx, h.tenant, a.ID, h.b, false); !errors.Is(err, errTalkOptIn) {
		t.Fatalf("not opted in: %v", err)
	}
	srv := talkHTTP(t, h, false)
	tok := newToken()
	h.store.CreateToken(ctx, h.tenant, a.ID, museLabel, hashToken(tok))
	// the person's agent (bearer token, even from an allowed origin) can't switch it on
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/prefs", `{"opt_in":true}`, map[string]string{"Authorization": "Bearer " + tok, "Origin": "https://site.test"}); code != http.StatusUnauthorized {
		t.Fatalf("agent token: %d", code)
	}
	// nor can a tool call: no MCP tool touches agent talk
	for _, tl := range museTools {
		if strings.Contains(tl.Name, "talk") || strings.Contains(tl.Path, "talk") {
			t.Fatalf("an agent tool reaches agent talk: %s", tl.Name)
		}
	}
	sess, _ := h.acc.sess.issue(kindSession, a.ID, time.Hour)
	cookie := sessionCookie + "=" + sess
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/prefs", `{"opt_in":true}`, map[string]string{"Cookie": cookie}); code != http.StatusForbidden {
		t.Fatalf("no origin: %d", code)
	}
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/prefs", `{"opt_in":true}`, map[string]string{"Cookie": cookie, "Origin": "https://evil.test"}); code != http.StatusForbidden {
		t.Fatalf("wrong origin: %d", code)
	}
	if code, body := talkReq(t, "GET", srv.URL+"/api/talk/prefs", "", map[string]string{"Cookie": cookie}); code != 200 || !strings.Contains(body, `"opt_in":false`) {
		t.Fatalf("get: %d %s", code, body)
	}
	if code, body := talkReq(t, "POST", srv.URL+"/api/talk/prefs", `{"opt_in":true}`, map[string]string{"Cookie": cookie, "Origin": "https://site.test"}); code != 200 || !strings.Contains(body, `"opt_in":true`) {
		t.Fatalf("the human, from the app: %d %s", code, body)
	}
	if p, _ := h.store.talkPrefs(ctx, h.tenant, a.ID); !p.OptIn || p.OkayToShare {
		t.Fatalf("saved: %+v", p)
	}
	// guests (no session) can't have prefs at all
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/prefs", `{"opt_in":true}`, map[string]string{"Origin": "https://site.test"}); code != http.StatusUnauthorized {
		t.Fatalf("guest: %d", code)
	}
	if _, err := h.talk.encounter(ctx, h.tenant, 0, h.b, false); !errors.Is(err, errTalkWho) {
		t.Fatalf("guest encounter: %v", err)
	}
}

func TestTalkEncounterTriggerNotPublic(t *testing.T) {
	h := newTalkHarness(t)
	srv := talkHTTP(t, h, false)
	body := fmt.Sprintf(`{"a_uid":%d,"b_uid":%d}`, h.a, h.b)
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/encounter", body, map[string]string{"Origin": "https://site.test"}); code != http.StatusNotFound {
		t.Fatalf("public trigger: %d", code)
	}
	sess, _ := h.acc.sess.issue(kindSession, h.c, time.Hour)
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/encounter", body, map[string]string{"Origin": "https://site.test", "Cookie": sessionCookie + "=" + sess}); code != http.StatusNotFound {
		t.Fatalf("a non-admin: %d", code)
	}
	// an admin from the allow-list, from the app
	t.Setenv("ADMIN_EMAILS", "carmody@example.com")
	srv2 := talkHTTP(t, h, false)
	code, out := talkReq(t, "POST", srv2.URL+"/api/talk/encounter", body, map[string]string{"Origin": "https://site.test", "Cookie": sessionCookie + "=" + sess})
	if code != 200 || !strings.Contains(out, `"id":"tk_`) {
		t.Fatalf("admin: %d %s", code, out)
	}
	h.sink.wait(t, "verdict", func(f sentFrame) bool { return f.msg["t"] == "verdict" })
	// -dev-talk: localhost only
	t.Setenv("ADMIN_EMAILS", "")
	h2 := newTalkHarness(t)
	srv3 := talkHTTP(t, h2, true)
	local := strings.Replace(srv3.URL, "127.0.0.1", "localhost", 1)
	body2 := fmt.Sprintf(`{"a_uid":%d,"b_uid":%d}`, h2.a, h2.b)
	if code, out := talkReq(t, "POST", local+"/api/talk/encounter", body2, nil); code != 200 {
		t.Fatalf("dev trigger: %d %s", code, out)
	}
	if code, _ := talkReq(t, "POST", local+"/api/talk/encounter", body2, map[string]string{"X-Forwarded-For": "1.2.3.4"}); code != http.StatusNotFound {
		t.Fatalf("dev trigger through a proxy: %d", code)
	}
}

func TestTalkTenantIsolation(t *testing.T) {
	h := newTalkHarness(t)
	ctx := context.Background()
	if _, err := h.talk.encounter(ctx, h.tenant, h.a, h.x, false); !errors.Is(err, errTalkWho) {
		t.Fatalf("someone from another event: %v", err)
	}
	if _, err := h.talk.encounter(ctx, "otherevent", h.a, h.x, false); !errors.Is(err, errTalkWho) {
		t.Fatalf("A isn't at the other event: %v", err)
	}
	id, _ := h.run(h.a, h.b)
	h.record(id)
	if _, err := h.store.talkGet(ctx, "otherevent", id); !errors.Is(err, errNoTalk) {
		t.Fatalf("a talk is only visible in its tenant: %v", err)
	}
	if _, err := h.talk.decide(ctx, "otherevent", h.a, id, true); err == nil {
		t.Fatal("approving from another tenant must fail")
	}
	if _, err := h.talk.view(ctx, "otherevent", h.a, id); err == nil {
		t.Fatal("viewing from another tenant must fail")
	}
	// rarity only counts this event's briefs
	h.store.talkSaveBrief(ctx, "otherevent", h.x, talkBrief{Rare: []string{"tabla"}, V: talkBriefVersion})
	r := h.talk.rarityFor(ctx, h.tenant)
	if r.n != 3 || r.count("tabla", h.talk.cfg.generic) != 2 {
		t.Fatalf("rarity leaks across tenants: n=%d tabla=%d", r.n, r.count("tabla", h.talk.cfg.generic))
	}
	// prefs are per tenant
	h.store.talkSavePrefs(ctx, "otherevent", h.x, talkPrefs{OptIn: true})
	if p, _ := h.store.talkPrefs(ctx, h.tenant, h.x); p.OptIn {
		t.Fatal("prefs leak across tenants")
	}
}

func TestTalkConfigFromFile(t *testing.T) {
	b, _ := talkFS.ReadFile("talkdata/talk_config.json")
	var m map[string]any
	json.Unmarshal(b, &m)
	m["version"] = "test-42"
	m["gate_threshold"] = 0.77
	m["fire"].(map[string]any)["value_min"] = 4.5
	dir := t.TempDir()
	p := filepath.Join(dir, "talk.json")
	out, _ := json.Marshal(m)
	os.WriteFile(p, out, 0o600)
	cfg, err := loadTalkConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Version != "test-42" || cfg.GateThreshold != 0.77 || cfg.Fire.ValueMin != 4.5 {
		t.Fatalf("file values not used: %s %v %v", cfg.Version, cfg.GateThreshold, cfg.Fire.ValueMin)
	}
	// the talk records which config it ran with
	h := newTalkHarness(t)
	cfg.Limits.MinGapMS = 0
	h.talk.cfg = cfg
	h.jev.scores = map[string]float64{"value_a": 5, "value_b": 5, "soon": 5, "talk_again": 5}
	id, _ := h.run(h.a, h.b)
	if rec := h.record(id); rec.ConfigVersion != "test-42" {
		t.Fatalf("record's config version: %s", rec.ConfigVersion)
	}
	// typos and missing knobs fail loudly
	m["gate_threshhold"] = 0.5
	out, _ = json.Marshal(m)
	os.WriteFile(p, out, 0o600)
	if _, err := loadTalkConfig(p); err == nil {
		t.Fatal("an unknown knob must be refused")
	}
	delete(m, "gate_threshhold")
	delete(m, "gates")
	out, _ = json.Marshal(m)
	os.WriteFile(p, out, 0o600)
	if _, err := loadTalkConfig(p); err == nil {
		t.Fatal("no gates must be refused")
	}
	if _, err := loadTalkConfig(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("a missing file must be an error")
	}
}

func TestTalkGuard(t *testing.T) {
	cases := map[string]string{
		"ping me at zeph@example.com!":                   "zeph@example.com",
		"call 404-555-0199 tonight":                      "404-555-0199",
		"text (404) 555 0199":                            "555 0199",
		"see https://zeph.dev/portfolio":                 "zeph.dev",
		"my site is zeph.dev/blog":                       "zeph.dev",
		"find me on linkedin.com/in/zeph":                "linkedin.com",
		"I'm @zephq everywhere":                          "@zephq",
		"discord: zeph#1234":                             "zeph#1234",
		"github: zephq":                                  "zephq",
		"the password: hunter2222 is on a sticky":        "hunter2222",
		"key sk-ant-abcdefghijklmnopqrstuvwxyz0123":      "sk-ant-abcdefghijklmnopqrstuvwxyz0123",
		"Authorization: Bearer abcdefghijklmnop12345678": "abcdefghijklmnop12345678",
	}
	for in, bad := range cases {
		if out := talkScrub(in); strings.Contains(out, bad) {
			t.Errorf("%q → %q still has %q", in, out, bad)
		}
	}
	for _, keep := range []string{"socket.io reconnects are flaky", "React Native 0.76 on Android 14", "Go 1.27 with net/http"} {
		if out := talkScrub(keep); out != keep {
			t.Errorf("%q changed to %q", keep, out)
		}
	}
	n := talkNames{own: talkNameParts("Zephyrine Quux", "zephq@example.com"), other: talkNameParts("Octavian Blix")}
	if got := n.apply("Zephyrine Quux met Octavian's team; zephq says hi"); strings.Contains(got, "Zephyrine") || strings.Contains(got, "Octavian") || strings.Contains(got, "zephq") {
		t.Fatalf("names: %q", got)
	}
	if got := n.apply("Octavian's relay"); got != "your human's relay" {
		t.Fatalf("possessive: %q", got)
	}
	cfg, _ := loadTalkConfig("")
	g := talkGuard{names: n, corpus: newTalkCorpus(cfg.generic, `{"stuck_on":["flaky websocket reconnects in React Native"],"rare":["tabla"]}`), generic: cfg.generic, min: cfg.Guard.GroundMin}
	if g.sentence("My human is stuck on flaky WebSocket reconnects!") == "" {
		t.Fatal("a grounded sentence was dropped")
	}
	if g.sentence("My human would love that!") == "" {
		t.Fatal("a sentence with no claims was dropped")
	}
	if g.sentence("My human built a Kubernetes operator in Rust for satellites.") != "" {
		t.Fatal("an ungrounded claim got through")
	}
	if s := g.sentence("My human plays tabla, email zephq@example.com."); strings.Contains(s, "@") || s == "" {
		t.Fatalf("contact inside a grounded sentence: %q", s)
	}
}

func TestTalkMemorySnippetsNeverCrossSides(t *testing.T) {
	h := newTalkHarness(t)
	h.talk.recall = fixedRecall{notes: map[int64][]string{
		h.a: {"MARKASECRET flaky websocket reconnects notes from A", "MARKATABLA tabla practice every weekend"},
		h.b: {"MARKBSECRET websocket relay resume tokens notes from B", "MARKBTABLA tabla ensemble"},
	}}
	h.talk.cfg.Memory.OverlapMinScore = 0
	// an agent that repeats every marker it can see
	h.gem.answer = func(user string) string {
		m := fakeMarker.FindAllString(user, -1)
		return "My human says websocket reconnects and tabla " + strings.Join(m, " ") + "."
	}
	id, _ := h.run(h.a, h.b)
	h.waitIcebreaker(id)
	h.talk.decide(context.Background(), h.tenant, h.a, id, true)
	h.talk.decide(context.Background(), h.tenant, h.b, id, true)
	rec := h.record(id)
	// jev did get the memory outlet (hot topics and snippets from both sides)
	sawA, sawB := false, false
	for _, st := range h.jev.states {
		sawA = sawA || strings.Contains(st, "MARKA")
		sawB = sawB || strings.Contains(st, "MARKB")
	}
	if !sawA || !sawB || len(rec.HotTopics) == 0 {
		t.Fatalf("jev should see both sides' memory: A %v B %v topics %q", sawA, sawB, rec.HotTopics)
	}
	// but each agent only ever saw its own human's notes
	for _, p := range h.gem.prompts {
		isB := strings.Contains(p, "websocket relay in Go")
		if isB && strings.Contains(p, "MARKA") || !isB && strings.Contains(p, "MARKB") {
			t.Fatalf("an agent saw the other human's notes:\n%s", p)
		}
		for _, hot := range rec.HotTopics {
			if strings.Contains(p, hot) {
				t.Fatal("hot topics reached an agent")
			}
		}
	}
	for _, l := range rec.Transcript {
		if l.Side == "b" && strings.Contains(l.Text, "MARKA") || l.Side == "a" && strings.Contains(l.Text, "MARKB") {
			t.Fatalf("line %d by %s carries the other side's memory: %q", l.N, l.Side, l.Text)
		}
	}
	// on the phones: A's memory only ever inside lines A's own agent said, and vice versa
	for _, f := range h.sink.all() {
		for _, mark := range []struct {
			m    string
			side int64
		}{{"MARKA", h.a}, {"MARKB", h.b}} {
			if !strings.Contains(f.raw, mark.m) {
				continue
			}
			if f.msg["t"] != "agents" {
				t.Fatalf("%s outside an agent's line: %s", mark.m, f.raw)
			}
			from := f.msg["line"].(map[string]any)["from"]
			mine := from == "your_agent"
			if (f.uid == mark.side) != mine {
				t.Fatalf("%s in a line the other agent said: %s", mark.m, f.raw)
			}
		}
	}
	answered := false
	for _, l := range rec.Transcript {
		answered = answered || (l.Kind == "answer" && (strings.Contains(l.Text, "MARKA") || strings.Contains(l.Text, "MARKB")))
	}
	if !answered {
		t.Fatal("agents should be able to use their own human's notes")
	}
}

func TestTalkRecordAndFeedback(t *testing.T) {
	h := newTalkHarness(t)
	srv := talkHTTP(t, h, false)
	id, _ := h.run(h.a, h.b)
	h.waitIcebreaker(id)
	rec := h.record(id)
	if rec.ConfigVersion == "" || rec.BankVersion == "" || len(rec.Transcript) == 0 || len(rec.Jev) < 3 || rec.Timings["checkpoint1"] == 0 || rec.Timings["first_bubble"] < 0 {
		t.Fatalf("record is missing things: %+v", rec)
	}
	for _, j := range rec.Jev {
		if j.What == "checkpoint1" && len(j.Answers) == 0 {
			t.Fatal("jev's answers should be stored")
		}
	}
	sa, _ := h.acc.sess.issue(kindSession, h.a, time.Hour)
	sc, _ := h.acc.sess.issue(kindSession, h.c, time.Hour)
	hdr := func(s string) map[string]string {
		return map[string]string{"Cookie": sessionCookie + "=" + s, "Origin": "https://site.test"}
	}
	if code, body := talkReq(t, "POST", srv.URL+"/api/talk/"+id+"/approve", "", hdr(sa)); code != 200 || !strings.Contains(body, "awaiting") {
		t.Fatalf("approve: %d %s", code, body)
	}
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/"+id+"/approve", "", map[string]string{"Cookie": sessionCookie + "=" + sa}); code != http.StatusForbidden {
		t.Fatalf("approve without origin: %d", code)
	}
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/"+id+"/feedback", `{"worth_it":true}`, hdr(sc)); code != http.StatusNotFound {
		t.Fatalf("a stranger's feedback: %d", code)
	}
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/"+id+"/feedback", `{"worth_it":true}`, hdr(sa)); code != http.StatusNoContent {
		t.Fatalf("feedback: %d", code)
	}
	if code, body := talkReq(t, "GET", srv.URL+"/api/talk/"+id, "", hdr(sa)); code != 200 || strings.Contains(body, "Octavian") || !strings.Contains(body, "your_agent") {
		t.Fatalf("view: %d %s", code, body)
	}
	got, _ := h.store.talkGet(context.Background(), h.tenant, id)
	if got.Feedback["a"] != true || got.Approvals["a"] != "approve" {
		t.Fatalf("stored: %v %v", got.Feedback, got.Approvals)
	}
}

func TestTalkPartialStringAndSentences(t *testing.T) {
	full := `{"answer": "My human loves \"tabla\". Also Go!\nReally?", "cites": []}`
	for i := 0; i <= len(full); i++ {
		s, done := talkPartialString(full[:i], "answer")
		if !strings.HasPrefix(`My human loves "tabla". Also Go!`+"\n"+`Really?`, s) {
			t.Fatalf("prefix %d: %q", i, s)
		}
		if done != (i > strings.Index(full, `?"`)+1) {
			t.Fatalf("done at %d: %v", i, done)
		}
	}
	done, rest := talkSentences("One. Two! Three", false)
	if len(done) != 2 || rest != " Three" {
		t.Fatalf("%q %q", done, rest)
	}
	done, _ = talkSentences("Uses socket.io and e.g. Go. End", true)
	if strings.Join(done, "|") != "Uses socket.io and e.g.|Go.|End" {
		t.Fatalf("%q", done)
	}
}

func TestTalkGeminiHedgesToFallback(t *testing.T) {
	h := newTalkHarness(t)
	h.gem.fail = map[string]int{h.talk.cfg.Models.Agent.Model: 503}
	id, _ := h.run(h.a, h.b)
	rec := h.record(id)
	for _, l := range rec.Transcript {
		if l.Kind == "answer" && l.Model != h.talk.cfg.Models.AgentFallback.Model {
			t.Fatalf("answer %d came from %q", l.N, l.Model)
		}
	}
	// both down: the show still goes on with the kind fallback line
	h2 := newTalkHarness(t)
	h2.gem.fail = map[string]int{h2.talk.cfg.Models.Agent.Model: 500, h2.talk.cfg.Models.AgentFallback.Model: 500}
	id2, _ := h2.run(h2.a, h2.b)
	kind := map[string]bool{h2.talk.cfg.Lines.NotInMemory: true}
	for _, s := range h2.talk.cfg.Lines.NotInMemoryAlts {
		kind[s] = true
	}
	last, answers := "", 0
	for _, l := range h2.record(id2).Transcript {
		if l.Kind != "answer" {
			continue
		}
		answers++
		if !kind[l.Text] || !l.NotInMemory {
			t.Fatalf("fallback line: %q", l.Text)
		}
		if l.Text == last && len(kind) > 1 {
			t.Fatalf("the same fallback twice in a row: %q", l.Text)
		}
		last = l.Text
	}
	// nothing to find: the questions stop after limits.max_misses blanks, not after all of them
	if max := h2.talk.cfg.Limits.MaxMisses; max > 0 && answers > max {
		t.Fatalf("%d blank answers; it should stop after %d", answers, max)
	}
}

// Questions go only where the answering agent's brief has something to say.
func TestAnswerableByBrief(t *testing.T) {
	thin := &talkBrief{OneLine: "fintech app with ElevenLabs"}
	if !answerable(thin, "now_at_hackgt") || answerable(thin, "where_from") || answerable(thin, "stuck_and_solved") || answerable(thin, "fun_and_play") {
		t.Fatal("a thin brief answers only what it holds")
	}
	full := &talkBrief{OneLine: "x", Life: []string{"grew up in Kochi"}, Rare: []string{"tabla"}, StuckOn: []string{"BLE"}}
	for _, typ := range []string{"where_from", "fun_and_play", "stuck_and_solved", "values_and_beliefs", "interests_and_rare"} {
		if !answerable(full, typ) {
			t.Errorf("%s should be askable", typ)
		}
	}
}

func TestTalkBankLoads(t *testing.T) {
	bank, ver := loadTalkBank()
	if len(bank) == 0 || len(bank) > 255 {
		t.Fatalf("bank: %d (%s)", len(bank), ver)
	}
	gated := 0
	for _, q := range bank {
		if q.gated() {
			gated++
			if q.Consent != "okay_to_share" {
				t.Fatalf("%s has a consent we don't know: %q", q.ID, q.Consent)
			}
		}
	}
	if ver != "fixture" && gated == 0 {
		t.Fatal("the bank should have consent-gated questions")
	}
}

// The agents get to know the humans as people: never two project questions in a row
// (pick.max_work_streak), and the personal side of the bank does get asked.
func TestTalkAlternatesWorkAndPersonal(t *testing.T) {
	h := newTalkHarness(t)
	if h.talk.cfg.Pick.MaxWorkStreak != 1 || len(h.talk.cfg.Pick.WorkTypes) == 0 {
		t.Fatalf("config: %+v", h.talk.cfg.Pick)
	}
	id, _ := h.run(h.a, h.b)
	rec := h.record(id)
	work := map[string]bool{}
	for _, typ := range h.talk.cfg.Pick.WorkTypes {
		work[typ] = true
	}
	var types []string
	personal := 0
	for _, l := range rec.Transcript {
		if l.Kind != "question" {
			continue
		}
		typ := h.talk.bankType(l.QID)
		if n := len(types); n > 0 && work[typ] && work[types[n-1]] {
			t.Errorf("two project questions in a row: %v then %s", types, typ)
		}
		if !work[typ] {
			personal++
		}
		types = append(types, typ)
	}
	if len(types) < 2 || personal == 0 {
		t.Fatalf("question types: %v", types)
	}
}

func TestBriefLifeAndVersion(t *testing.T) {
	b := cleanBrief(talkBrief{Life: []string{"grew up in Kochi", "rock climbing", "teaches kids to code", "chess", "fifth"}}, false)
	if len(b.Life) != 4 {
		t.Fatalf("life is capped at 4: %v", b.Life)
	}
	h := newTalkHarness(t)
	ctx := context.Background()
	old := talkBrief{OneLine: "old brief"} // made before life existed
	h.store.talkSaveBrief(ctx, h.tenant, h.c, old)
	got, err := h.talk.briefFor(ctx, h.tenant, h.c, talkPrefs{OptIn: true})
	if err != nil || got.OneLine != "old brief" {
		t.Fatalf("an old brief is used right away: %v %+v", err, got)
	}
	for i := 0; i < 400; i++ { // and rebuilt in the background
		if b, _ := h.store.talkBrief(ctx, h.tenant, h.c); b != nil && b.V == talkBriefVersion {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("an old brief should be rebuilt at the current version")
}

// Every bank question has a casual wording for the chat; jev still sees the plain one.
func TestBankSaysEveryQuestionCasually(t *testing.T) {
	bank, _ := loadTalkBank()
	if len(bank) < 200 {
		t.Fatalf("bank: %d questions", len(bank))
	}
	for _, q := range bank {
		s := q.said()
		if q.Say == "" || !strings.HasSuffix(s, "?") || strings.Contains(strings.ToLower(s), "your human") || len(strings.Fields(s)) > 25 {
			t.Errorf("%s: %q", q.ID, s)
		}
	}
}

// jev chooses from at most pick.max_options questions, dealt across every type (fast, varied).
func TestTalkOptionsCappedAndBalanced(t *testing.T) {
	h := newTalkHarness(t)
	bank, _ := loadTalkBank()
	h.talk.bank = bank
	r := &talkRun{t: h.talk, rec: &talkRecord{}, asked: map[string]bool{}, sides: [2]*talkSide{{}, {}}}
	ph := h.talk.cfg.Phase2
	opts := r.eligible(1, &ph, nil)
	if len(opts) != h.talk.cfg.Pick.MaxOptions {
		t.Fatalf("options: %d, want %d", len(opts), h.talk.cfg.Pick.MaxOptions)
	}
	per := map[string]int{}
	for _, q := range opts {
		per[q.Type]++
	}
	lo, hi := 1<<30, 0
	for _, n := range per {
		lo, hi = min(lo, n), max(hi, n)
	}
	if len(per) < 9 || hi-lo > 1 && lo < 3 {
		t.Fatalf("not balanced across types: %v", per)
	}
}

func TestUsageSpeed(t *testing.T) {
	sp := usageSpeedOf(usageTalkTimes{talks: 2, questions: 25,
		picks:   []usagePickTime{{ms: 300, options: 60}, {ms: 500, options: 60}, {ms: 1500, options: 60, failed: true}},
		firstMS: []float64{400, 600}, tookMS: []float64{1000, 1400}})
	if sp.Picks != 3 || sp.PickP50MS != 500 || sp.PickP90MS != 1500 || sp.PickFailed != 1 || sp.AvgOptions != 60 ||
		sp.FirstWordsP50MS != 400 || sp.AnswerP50MS != 1000 || sp.QuestionsPerTalk != 12.5 {
		t.Fatalf("%+v", sp)
	}
}
