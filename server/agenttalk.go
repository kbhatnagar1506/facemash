package main

// Agent talk: when two signed-in attendees meet (Bluetooth, within ~1.5 m; for now a test
// trigger), their AI agents talk on their behalf, jev judges whether they should meet, both
// humans approve, and only then are names and an icebreaker revealed.
//
// The show, pushed to both phones over their game sockets (Hub clients by uid):
//   {"t":"encounter","id","other":{"bean"}}                   t≈0, no names
//   {"t":"agents","id","line":{"n","from","text",...}}        each bubble; "from" is your_agent
//                                                             or their_agent for that phone;
//                                                             "typing" and "partial" frames
//                                                             stream a bubble as it's written
//   {"t":"verdict","id","match":false}                        after a warm close, or
//   {"t":"verdict","id","match":true,"reason","why","ask"}    then POST /api/talk/<id>/approve|skip
//   {"t":"reveal","id","other":{"name","where"},"icebreaker"} only once BOTH approved
//   {"t":"closed","id"}                                       someone skipped, or time ran out
//
// How a talk runs (every knob in talkdata/talk_config.json):
//   - Phase 1: the agents take turns. jev picks each question from the bank (a "choice" over
//     up to 255 {id: text} options: never repeated, never consent-gated unless both humans
//     allowed it); the other agent answers from its own human's brief and notes only
//     (Gemini, streamed; every sentence guarded, agenttalk_guard.go). jev's pick for the next
//     turn runs while the current answer streams, and the next answer starts as soon as its
//     question is known, so bubbles keep coming.
//   - Checkpoint 1 (after phase1.questions): one jev call, the gates as noul. Nothing fired,
//     or a red flag (one-sided, busy): the agents close warmly, verdict match:false.
//   - Phase 2: up to phase2.questions more, steered toward what fired.
//   - Checkpoint 2: one jev call with the scores and two choices. Fires when the LOWER of the
//     two values, the better of soon/talk-again, and the reason all clear config thresholds.
//
// jev also gets a "memory outlet": the hot topics where the two people's memories meet
// (brief against brief, and each brief line searched in the other's MAPI space), plus a few
// snippets from each side's own space for the latest question. jev only uses them to choose;
// they are never handed to the other agent.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// ---------- wiring ----------

// talkSink is how a talk reaches phones (the Hub in the server; a printer in -talk-sim).
type talkSink interface {
	send(uid int64, msg map[string]any)
	online(uid int64) bool
	where(uid int64) string
}

type hubSink struct{ h *Hub }

func (s hubSink) send(uid int64, msg map[string]any) { s.h.sendUID(uid, mustJSON(msg)) }

func (s hubSink) online(uid int64) bool {
	s.h.mu.Lock()
	defer s.h.mu.Unlock()
	for _, c := range s.h.clients {
		if c.joined && c.uid == uid {
			return true
		}
	}
	return false
}

func (s hubSink) where(uid int64) string {
	s.h.mu.Lock()
	defer s.h.mu.Unlock()
	for _, c := range s.h.clients {
		if c.joined && c.uid == uid {
			if c.p.Room == "hackgt" {
				return "right next to you, inside the Klaus atrium"
			}
			return "right next to you, outdoors on campus"
		}
	}
	return "nearby"
}

// sendUID queues msg for every socket this account has open; how many got it.
func (h *Hub) sendUID(uid int64, msg []byte) int {
	if uid == 0 {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, c := range h.clients {
		if c.joined && c.uid == uid {
			c.trySend(msg)
			n++
		}
	}
	return n
}

// talkSnippet is one hit from a person's own memory.
type talkSnippet struct {
	From  string  `json:"from"`
	Text  string  `json:"text"`
	Score float64 `json:"score"`
}

// talkRecall searches one person's own memory (their private MAPI space); nil: no search.
type talkRecall interface {
	search(ctx context.Context, tenant string, id int64, q string, n int) []talkSnippet
}

type fastRecall struct{ f *memFast }

func (r fastRecall) search(ctx context.Context, tenant string, id int64, q string, n int) []talkSnippet {
	out := r.f.ask(ctx, tenant, id, q) // own space only (memfast.go drops anything else)
	res, _ := out["results"].([]map[string]any)
	var hits []talkSnippet
	for _, h := range res {
		if len(hits) >= n {
			break
		}
		from, _ := h["from"].(string)
		text, _ := h["text"].(string)
		score, _ := h["score"].(float64)
		hits = append(hits, talkSnippet{From: from, Text: text, Score: score})
	}
	return hits
}

type agentTalk struct {
	cfg         *talkConfig
	bank        []talkQuestion
	bankVersion string
	gem         *talkGemini // nil: the feature is off (prefs still work)
	jev         *talkJev
	acc         *accounts
	ts          talkStore
	recall      talkRecall
	sink        talkSink

	mu       sync.Mutex
	live     map[string]*talkRun // by talk id: running, or waiting for approvals
	inTalk   map[string]string   // "<tenant>/<uid>" → the live talk they're in
	hot      map[string][]string // "<tenant>/<lo>-<hi>" → hot topics (prefetched)
	rarity   map[string]*talkRarity
	building map[string]chan struct{} // brief builds in flight
	sem      chan struct{}
	briefSem chan struct{}
}

func (t *agentTalk) on() bool { return t != nil && t.gem != nil && t.jev != nil }

// openAgentTalk: prefs always work when the store can hold them; the talks themselves need
// GEMINI_API_KEY(_FILE) and JEV_API_KEY(_FILE). Config: cfgPath or the embedded one.
func openAgentTalk(acc *accounts, sink talkSink, cfgPath string) *agentTalk {
	if acc == nil {
		return nil
	}
	ts, ok := acc.store.(talkStore)
	if !ok {
		return nil
	}
	cfg, err := loadTalkConfig(firstNonEmpty(cfgPath, os.Getenv("TALK_CONFIG_FILE")))
	if err != nil {
		log.Printf("talk: off: %v", err)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := ts.talkEnsureSchema(ctx); err != nil {
		log.Printf("talk: off: schema: %v", err)
		return nil
	}
	t := newAgentTalk(cfg, acc, ts, sink)
	if gk, jk := talkKey("GEMINI_API_KEY"), talkKey("JEV_API_KEY"); gk != "" && jk != "" {
		t.gem, t.jev = newTalkGemini(gk), newTalkJev(jk, cfg.Models.JevModel)
	}
	if acc.fast != nil {
		t.recall = fastRecall{acc.fast}
	}
	log.Printf("talk: config %s, bank %s (%d questions), talks %v, memory outlet %v", cfg.Version, t.bankVersion, len(t.bank), t.on(), t.recall != nil)
	return t
}

func newAgentTalk(cfg *talkConfig, acc *accounts, ts talkStore, sink talkSink) *agentTalk {
	bank, ver := loadTalkBank()
	return &agentTalk{
		cfg: cfg, bank: bank, bankVersion: ver, acc: acc, ts: ts, sink: sink,
		live: map[string]*talkRun{}, inTalk: map[string]string{}, hot: map[string][]string{},
		rarity: map[string]*talkRarity{}, building: map[string]chan struct{}{},
		sem: make(chan struct{}, max(1, cfg.Limits.MaxConcurrent)), briefSem: make(chan struct{}, 2),
	}
}

func (t *agentTalk) bankType(id string) string {
	for _, q := range t.bank {
		if q.ID == id {
			return q.Type
		}
	}
	return ""
}

func talkID() string {
	b := make([]byte, 9)
	rand.Read(b)
	return "tk_" + base64.RawURLEncoding.EncodeToString(b)
}

func talkDayStart(now time.Time) time.Time {
	loc, err := time.LoadLocation(eventTZ)
	if err != nil {
		loc = time.UTC
	}
	n := now.In(loc)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, loc)
}

// ---------- people and briefs ----------

type talkPerson struct {
	id    int64
	name  string // shown only at the reveal
	names []string
	look  string
}

func (t *agentTalk) person(ctx context.Context, tenant string, id int64) (talkPerson, error) {
	a, err := t.acc.store.Account(ctx, tenant, id)
	if err != nil {
		return talkPerson{}, err
	}
	return talkPerson{
		id: id, name: firstNonEmpty(a.Profile.Name, a.User.Given, a.User.Name, "someone"),
		names: talkNameParts(a.Profile.Name, a.User.Name, a.User.Given, a.User.Email),
		look:  a.Profile.Look,
	}, nil
}

var talkBriefSchema = map[string]any{
	"type": "OBJECT",
	"properties": map[string]any{
		"stuck_on":      map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
		"solved":        map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
		"looking_for":   map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
		"rare":          map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
		"going_through": map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
		"interrupt_ok":  map[string]any{"type": "BOOLEAN"},
		"one_line":      map[string]any{"type": "STRING"},
	},
	"required":         []string{"stuck_on", "solved", "looking_for", "rare", "going_through", "interrupt_ok", "one_line"},
	"propertyOrdering": []string{"one_line", "stuck_on", "solved", "looking_for", "rare", "going_through", "interrupt_ok"},
}

// cleanBrief caps and scrubs a brief (the model's output is never trusted as is).
func cleanBrief(b talkBrief, okayToShare bool) talkBrief {
	list := func(in []string, n int) []string {
		var out []string
		for _, s := range in {
			s = talkScrub(s)
			if r := []rune(s); len(r) > 100 {
				s = string(r[:100])
			}
			if strings.TrimSpace(strings.ReplaceAll(s, "[removed]", "")) != "" && len(out) < n {
				out = append(out, s)
			}
		}
		return out
	}
	b.StuckOn, b.Solved, b.LookingFor, b.Rare = list(b.StuckOn, 3), list(b.Solved, 4), list(b.LookingFor, 3), list(b.Rare, 4)
	b.GoingThrough = list(b.GoingThrough, 2)
	if !okayToShare {
		b.GoingThrough = nil
	}
	b.OneLine = talkScrub(b.OneLine)
	if r := []rune(b.OneLine); len(r) > 160 {
		b.OneLine = string(r[:160])
	}
	return b
}

// briefFor: the stored brief (going_through only while the person allows it), built now if
// there isn't one yet.
func (t *agentTalk) briefFor(ctx context.Context, tenant string, id int64, p talkPrefs) (*talkBrief, error) {
	b, err := t.ts.talkBrief(ctx, tenant, id)
	if err != nil {
		return nil, err
	}
	if b == nil {
		if b, err = t.buildBrief(ctx, tenant, id, p, false); err != nil {
			return nil, err
		}
	}
	cb := cleanBrief(*b, p.OkayToShare)
	return &cb, nil
}

// buildBrief condenses the person's memory into a brief (one build per person at a time).
func (t *agentTalk) buildBrief(ctx context.Context, tenant string, id int64, p talkPrefs, force bool) (*talkBrief, error) {
	key := memKey(tenant, id)
	for {
		t.mu.Lock()
		ch, busy := t.building[key]
		if !busy {
			ch = make(chan struct{})
			t.building[key] = ch
			t.mu.Unlock()
			break
		}
		t.mu.Unlock()
		select {
		case <-ch:
			if !force {
				if b, err := t.ts.talkBrief(ctx, tenant, id); err == nil && b != nil {
					return b, nil
				}
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	defer func() {
		t.mu.Lock()
		close(t.building[key])
		delete(t.building, key)
		t.mu.Unlock()
	}()
	start := time.Now()
	input := t.briefInput(ctx, tenant, id)
	sum := sha256.Sum256([]byte(fmt.Sprintf("%v|%s|%s", p.OkayToShare, t.cfg.Version, input)))
	hash := hex.EncodeToString(sum[:])
	if cur, err := t.ts.talkBrief(ctx, tenant, id); err == nil && cur != nil && cur.Hash == hash {
		return cur, nil
	}
	b := talkBrief{InterruptOK: true, At: time.Now().UTC(), Hash: hash}
	if strings.TrimSpace(input) != "" && t.gem != nil {
		rule := t.cfg.Prompts.BriefGoingNo
		if p.OkayToShare {
			rule = t.cfg.Prompts.BriefGoingYes
		}
		sys := strings.ReplaceAll(t.cfg.Prompts.Brief, "{going_through_rule}", rule)
		wctx, cancel := context.WithTimeout(ctx, t.cfg.ms(t.cfg.Models.WriterTimeoutMS))
		out, model, err := t.gem.hedged(wctx, t.cfg.Models.Writer, t.cfg.Models.WriterFallback, t.cfg.ms(t.cfg.Models.WriterTimeoutMS/2),
			sys, "MEMORY (their own agent's notes about them):\n"+input, talkBriefSchema, nil)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("brief: %w", err)
		}
		if err := json.Unmarshal([]byte(out), &b); err != nil {
			return nil, fmt.Errorf("brief: bad JSON from %s", model)
		}
		b.At, b.Hash = time.Now().UTC(), hash
	}
	b = cleanBrief(b, p.OkayToShare)
	if err := t.ts.talkSaveBrief(ctx, tenant, id, b); err != nil {
		return nil, err
	}
	t.mu.Lock()
	delete(t.rarity, tenant)
	t.mu.Unlock()
	log.Printf("talk: #%d brief built in %.0fms", id, ms(time.Since(start)))
	return &b, nil
}

// briefInput: the person's upload (already redacted when it arrived; scrubbed again), plus
// what their MAPI space says to a few standard questions.
func (t *agentTalk) briefInput(ctx context.Context, tenant string, id int64) string {
	var b strings.Builder
	if raw, err := t.ts.talkMemory(ctx, tenant, id); err == nil && len(raw) > 0 {
		var obj map[string]any
		if json.Unmarshal(raw, &obj) == nil {
			b.WriteString(jevState(obj))
		}
	}
	if t.recall != nil && len(t.cfg.Memory.BriefQueries) > 0 {
		res := make([][]talkSnippet, len(t.cfg.Memory.BriefQueries))
		var wg sync.WaitGroup
		for i, q := range t.cfg.Memory.BriefQueries {
			wg.Add(1)
			go func() {
				defer wg.Done()
				res[i] = t.recall.search(ctx, tenant, id, q, 3)
			}()
		}
		wg.Wait()
		seen := map[string]bool{}
		for _, hits := range res {
			for _, h := range hits {
				if !seen[h.Text] {
					seen[h.Text] = true
					b.WriteString("From my notes (" + h.From + "):\n" + h.Text + "\n\n")
				}
			}
		}
	}
	s := redactText(b.String(), map[string]int{})
	if n := t.cfg.Memory.BriefInputChars; n > 0 && len(s) > n {
		s = strings.ToValidUTF8(s[:n], "")
	}
	return s
}

// memoryArrived rebuilds the person's brief in the background (muse.go calls it after an upload).
func (t *agentTalk) memoryArrived(tenant string, id int64) {
	if !t.on() || id == 0 {
		return
	}
	go func() {
		t.briefSem <- struct{}{}
		defer func() { <-t.briefSem }()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		p, err := t.ts.talkPrefs(ctx, tenant, id)
		if err == nil {
			_, err = t.buildBrief(ctx, tenant, id, p, true)
		}
		if err != nil {
			log.Printf("talk: #%d brief: %v", id, err)
		}
	}()
}

// forget drops the person's brief (when they delete their memory).
func (t *agentTalk) forget(ctx context.Context, tenant string, id int64) {
	if t == nil {
		return
	}
	t.ts.talkDeleteBrief(ctx, tenant, id)
	t.mu.Lock()
	delete(t.rarity, tenant)
	suffix, prefix := fmt.Sprintf("-%d", id), fmt.Sprintf("%s/%d-", tenant, id)
	for k := range t.hot {
		if strings.HasPrefix(k, prefix) || (strings.HasPrefix(k, tenant+"/") && strings.HasSuffix(k, suffix)) {
			delete(t.hot, k)
		}
	}
	t.mu.Unlock()
}

// ---------- rarity ----------

type talkRarity struct {
	n  int
	df map[string]int // word → how many briefs have it in their rare list
}

func (t *agentTalk) rarityFor(ctx context.Context, tenant string) *talkRarity {
	t.mu.Lock()
	r := t.rarity[tenant]
	t.mu.Unlock()
	if r != nil {
		return r
	}
	lists, err := t.ts.talkRareTags(ctx, tenant)
	r = &talkRarity{df: map[string]int{}}
	if err == nil {
		r.n = len(lists)
		for _, tags := range lists {
			seen := map[string]bool{}
			for _, tag := range tags {
				for _, w := range talkWords(tag, t.cfg.generic) {
					if !seen[w] {
						seen[w] = true
						r.df[w]++
					}
				}
			}
		}
	}
	t.mu.Lock()
	t.rarity[tenant] = r
	t.mu.Unlock()
	return r
}

// count: how many people's briefs share this tag (its most specific word decides).
func (r *talkRarity) count(tag string, generic map[string]bool) int {
	best := -1
	for _, w := range talkWords(tag, generic) {
		if c := r.df[w]; best < 0 || c < best {
			best = c
		}
	}
	return max(best, 0)
}

// ---------- starting a talk ----------

var (
	errTalkOff     = errors.New("agent talk is off")
	errTalkWho     = errors.New("both people must be signed-in attendees of this event")
	errTalkOptIn   = errors.New("both people must have turned on agent talk")
	errTalkBusy    = errors.New("one of them is busy")
	errTalkOffline = errors.New("both people must have the game open")
	errTalkCap     = errors.New("daily limit reached")
	errTalkFull    = errors.New("too many talks right now")
	errTalkNotYour = errors.New("not your talk")
	errTalkState   = errors.New("this talk isn't waiting for that")
)

// encounter starts a talk between a and b (tenant-scoped). The show runs in the background.
func (t *agentTalk) encounter(ctx context.Context, tenant string, a, b int64, force bool) (string, error) {
	if !t.on() {
		return "", errTalkOff
	}
	if a <= 0 || b <= 0 || a == b {
		return "", errTalkWho
	}
	var pa, pb talkPerson
	var prefA, prefB talkPrefs
	var err error
	if pa, err = t.person(ctx, tenant, a); err != nil {
		return "", errTalkWho
	}
	if pb, err = t.person(ctx, tenant, b); err != nil {
		return "", errTalkWho
	}
	if prefA, err = t.ts.talkPrefs(ctx, tenant, a); err != nil {
		return "", err
	}
	if prefB, err = t.ts.talkPrefs(ctx, tenant, b); err != nil {
		return "", err
	}
	if !prefA.OptIn || !prefB.OptIn {
		return "", errTalkOptIn
	}
	if prefA.Busy || prefB.Busy {
		return "", errTalkBusy
	}
	if t.cfg.Limits.RequireOnline && (!t.sink.online(a) || !t.sink.online(b)) {
		return "", errTalkOffline
	}
	if !force {
		if err := t.underCaps(ctx, tenant, a, b); err != nil {
			return "", err
		}
	}
	select {
	case t.sem <- struct{}{}:
	default:
		return "", errTalkFull
	}
	release := func() { <-t.sem }
	rec := &talkRecord{
		ID: talkID(), Tenant: tenant, A: a, B: b, ConfigVersion: t.cfg.Version, BankVersion: t.bankVersion,
		State: "live", Started: time.Now().UTC(), Timings: map[string]float64{}, Forced: force,
	}
	t.mu.Lock()
	ka, kb := memKey(tenant, a), memKey(tenant, b)
	if t.inTalk[ka] != "" || t.inTalk[kb] != "" {
		t.mu.Unlock()
		release()
		return "", errTalkBusy
	}
	t.inTalk[ka], t.inTalk[kb] = rec.ID, rec.ID
	t.mu.Unlock()
	unmark := func() {
		t.mu.Lock()
		if t.inTalk[ka] == rec.ID {
			delete(t.inTalk, ka)
		}
		if t.inTalk[kb] == rec.ID {
			delete(t.inTalk, kb)
		}
		t.mu.Unlock()
	}
	if err := t.ts.talkCreate(ctx, rec); err != nil {
		unmark()
		release()
		return "", err
	}
	r := &talkRun{t: t, rec: rec, start: time.Now(), sides: [2]*talkSide{{person: pa, prefs: prefA}, {person: pb, prefs: prefB}}, iceReady: make(chan struct{})}
	t.mu.Lock()
	t.live[rec.ID] = r
	t.mu.Unlock()
	go func() {
		defer release()
		defer unmark()
		r.run()
	}()
	return rec.ID, nil
}

// underCaps: each person has at most limits.talks_per_day agent talks per event day (every
// talk that started counts, match or not), and, when intros_per_day is set, at most that
// many matches. Counted from the talks table, so it survives restarts. Both people are
// checked before anything starts.
func (t *agentTalk) underCaps(ctx context.Context, tenant string, a, b int64) error {
	day := talkDayStart(time.Now())
	for i, id := range []int64{a, b} {
		who := [2]string{"a_uid", "b_uid"}[i]
		if lim := t.cfg.Limits.TalksPerDay; lim > 0 {
			n, err := t.ts.talkCount(ctx, tenant, id, day, false)
			if err != nil {
				return err
			}
			if n >= lim {
				return fmt.Errorf("%w: %s already had %d agent talks today (limit %d)", errTalkCap, who, n, lim)
			}
		}
		if lim := t.cfg.Limits.IntrosPerDay; lim > 0 {
			n, err := t.ts.talkCount(ctx, tenant, id, day, true)
			if err != nil {
				return err
			}
			if n >= lim {
				return fmt.Errorf("%w: %s already had %d intros today (limit %d)", errTalkCap, who, n, lim)
			}
		}
	}
	return nil
}

// prefetch computes a pair's hot topics ahead of an encounter (for when proximity says two
// people are approaching). Cached per pair.
func (t *agentTalk) prefetch(tenant string, a, b int64) {
	if !t.on() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var s [2]*talkSide
		for i, id := range []int64{a, b} {
			p, err := t.ts.talkPrefs(ctx, tenant, id)
			if err != nil {
				return
			}
			br, err := t.briefFor(ctx, tenant, id, p)
			if err != nil {
				return
			}
			s[i] = &talkSide{person: talkPerson{id: id}, prefs: p, brief: br}
		}
		topics := t.hotTopics(ctx, tenant, s, nil)
		t.mu.Lock()
		t.hot[t.pairKey(tenant, a, b)] = topics
		t.mu.Unlock()
	}()
}

func (t *agentTalk) pairKey(tenant string, a, b int64) string {
	return fmt.Sprintf("%s/%d-%d", tenant, min(a, b), max(a, b))
}
