package main

// -talk-sim: a whole agent talk between built-in fictional people, with the live models,
// printed as a timeline with timings. No database or MAPI: a memory store, and a small
// word-match search over each person's fictional notes standing in for their MAPI space.
//
//   GEMINI_API_KEY_FILE=... JEV_API_KEY_FILE=... go run . -talk-sim                  one strong pair, one non-match
//   ... -talk-sim -talk-sim-pair strong -talk-sim-runs 5                             p50/p95 over 5 runs
//   ... -talk-sim -talk-sim-bench 10                                                 jev pick latency: bank vs fixture, with/without memory
//   ... -talk-sim -talk-sim-brief                                                    build the briefs from the notes (Gemini) instead

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type talkSimOpts struct {
	run   *bool
	pair  *string
	runs  *int
	bench *int
	nomem *bool
	brief *bool
	quiet *bool
}

func talkSimFlags() *talkSimOpts {
	return &talkSimOpts{
		run:   flag.Bool("talk-sim", false, "run agent talks between built-in fictional people with the live models, print the timeline, and exit"),
		pair:  flag.String("talk-sim-pair", "both", "talk-sim: strong, none, or both"),
		runs:  flag.Int("talk-sim-runs", 1, "talk-sim: runs per pair (p50/p95 when more than 1)"),
		bench: flag.Int("talk-sim-bench", 0, "talk-sim: time N jev picks each way (full bank vs fixture, with vs without memory context) and exit"),
		nomem: flag.Bool("talk-sim-nomem", false, "talk-sim: no memory outlet for jev (no hot topics, no snippets)"),
		brief: flag.Bool("talk-sim-brief", false, "talk-sim: build the briefs from the fictional notes with Gemini (timed) instead of using the built-in ones"),
		quiet: flag.Bool("talk-sim-quiet", false, "talk-sim: no timeline, only the numbers"),
	}
}

func (o *talkSimOpts) on() bool { return o != nil && o.run != nil && *o.run }

type simPerson struct {
	name, email, look string
	brief             talkBrief
	notes             []string
}

var simPeople = map[string][2]simPerson{
	"strong": {
		{
			name: "Priya Raman", email: "priya.sim@example.com", look: "b=#ff8a3d;a=#ffffff;p=split;e=happy;h=headphones;i=phone",
			brief: talkBrief{
				OneLine:     "Building a React Native app with a live pickup-soccer scoreboard",
				StuckOn:     []string{"flaky WebSocket reconnects in React Native when the phone sleeps", "duplicate score events after a reconnect"},
				Solved:      []string{"Postgres row-level security for multi-league data", "Expo push notifications for game alerts"},
				LookingFor:  []string{"someone who has built realtime WebSocket infrastructure"},
				Rare:        []string{"tabla", "pickup soccer stats"},
				InterruptOK: true,
			},
			notes: []string{
				"Sep 25: lost 3 hours to socket drops. Android kills the WebSocket when the screen locks, my reconnect loop fires twice and the scoreboard double-counts goals.",
				"Learned tabla for 8 years in Pune; still practise teentaal on weekends.",
				"Set up Postgres row-level security so each league only sees its own games.",
				"Want to find someone who has done realtime at scale: backoff, resume tokens, idempotent events.",
			},
		},
		{
			name: "Marcus Webb", email: "marcus.sim@example.com", look: "b=#4f7fd6;a=#ffe066;p=stripes;e=shades;h=cap;i=laptop",
			brief: talkBrief{
				OneLine:     "Building a Go relay that fans out live game events to thousands of phones",
				StuckOn:     []string{"choosing a hosting region with low latency to Atlanta"},
				Solved:      []string{"a Go WebSocket relay that survives reconnects using resume tokens", "idempotent event IDs so replayed events never double-count"},
				LookingFor:  []string{"a React Native developer to build a client for the relay"},
				Rare:        []string{"tabla", "Carnatic percussion"},
				InterruptOK: true,
			},
			notes: []string{
				"Relay design: every client gets a resume token; on reconnect the server replays missed events by sequence number, and events carry idempotency keys so nothing double-counts.",
				"Client side: exponential backoff with jitter capped at 30s, heartbeat every 15s to spot dead sockets when a phone sleeps.",
				"Played tabla in my college's Indian music ensemble; teentaal is my favourite cycle.",
				"Need a React Native person to build the demo client for the relay.",
			},
		},
	},
	"none": {
		{
			name: "Chloe Martin", email: "chloe.sim@example.com", look: "b=#ff7eb6;a=#ffffff;p=hearts;e=star;h=bunny;i=boba",
			brief: talkBrief{
				OneLine:     "Designing a Figma prototype for a dining-hall menu app",
				StuckOn:     []string{"picking a colour palette that passes WCAG contrast checks"},
				Solved:      []string{"user interviews with 12 freshmen about dining-hall menus"},
				LookingFor:  []string{"a UX mentor to review the prototype"},
				Rare:        []string{"K-pop dance covers"},
				InterruptOK: true,
			},
			notes: []string{
				"Interviewed 12 freshmen: they want allergens and hours on the first screen.",
				"My pastel palette fails WCAG AA contrast on the menu cards.",
				"Film K-pop dance covers with my club every Sunday.",
			},
		},
		{
			name: "Dmitri Volkov", email: "dmitri.sim@example.com", look: "b=#4a4e57;a=#1f2430;p=solid;e=dots;h=none;i=energy",
			brief: talkBrief{
				OneLine:     "Writing a Rust toolchain that loads telemetry decoders onto a CubeSat FPGA",
				StuckOn:     []string{"timing closure on a Lattice ECP5 FPGA"},
				Solved:      []string{"a Rust parser for CCSDS space packets"},
				LookingFor:  []string{"someone with Verilog timing-closure experience"},
				Rare:        []string{"competitive birdwatching"},
				InterruptOK: true,
			},
			notes: []string{
				"ECP5 build misses timing by 2ns on the decoder path; trying pipelining the CRC.",
				"Wrote a zero-copy Rust parser for CCSDS space packets.",
				"Big-year birding: 212 species this year, chasing a painted bunting.",
			},
		},
	},
}

// simRecall: word-match search over a person's fictional notes (stands in for their MAPI space).
type simRecall struct {
	generic map[string]bool
	notes   map[int64][]string
	delay   time.Duration
}

func (s simRecall) search(ctx context.Context, _ string, id int64, q string, n int) []talkSnippet {
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil
		}
	}
	qw := talkWords(q, s.generic)
	if len(qw) == 0 {
		return nil
	}
	var hits []talkSnippet
	for i, note := range s.notes[id] {
		nw := map[string]bool{}
		for _, w := range talkWords(note, s.generic) {
			nw[w] = true
		}
		m := 0
		for _, w := range qw {
			if nw[w] {
				m++
			}
		}
		if m > 0 {
			hits = append(hits, talkSnippet{From: fmt.Sprintf("note %d", i+1), Text: note, Score: float64(m) / float64(len(qw))})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > n {
		hits = hits[:n]
	}
	return hits
}

// simSink records every frame, and prints the show from A's phone.
type simSink struct {
	mu      sync.Mutex
	start   time.Time
	a       int64
	print   bool
	frames  []map[string]any
	verdict chan map[string]any
	reveal  chan map[string]any
	seen    map[int]bool
}

func (s *simSink) online(int64) bool  { return true }
func (s *simSink) where(int64) string { return "right next to you" }
func (s *simSink) since() string      { return fmt.Sprintf("+%6.3fs", time.Since(s.start).Seconds()) }
func (s *simSink) send(uid int64, msg map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, msg)
	if uid != s.a {
		if msg["t"] == "reveal" {
			s.reveal <- msg
		}
		return
	}
	switch msg["t"] {
	case "encounter":
		s.out("encounter pushed to both phones (bean only)")
	case "agents":
		l := msg["line"].(map[string]any)
		who := "A-agent"
		if l["from"] == "their_agent" {
			who = "B-agent"
		}
		n := l["n"].(int)
		switch {
		case l["typing"] == true:
		case l["partial"] == true:
			if !s.seen[n] {
				s.seen[n] = true
				s.out(fmt.Sprintf("%s   (first words on screen)", who))
			}
		default:
			s.out(fmt.Sprintf("%s: %s", who, l["text"]))
		}
	case "verdict":
		s.out(fmt.Sprintf("VERDICT match=%v %v", msg["match"], msg["reason"]))
		s.verdict <- msg
	case "reveal":
		o := msg["other"].(map[string]any)
		ice, _ := json.Marshal(msg["icebreaker"])
		s.out(fmt.Sprintf("REVEAL other=%v icebreaker=%s", o["name"], ice))
		s.reveal <- msg
	case "closed":
		s.out("closed")
	}
}

func (s *simSink) out(line string) {
	if s.print {
		fmt.Printf("  %s  %s\n", s.since(), line)
	}
}

type simResult struct {
	match                                  bool
	firstBubble, firstQuestion, firstWords float64
	checkpoint1, verdict, reveal, total    float64
	picks, turns, firstTok                 []float64
	questions                              []string
	gates                                  map[string]float64
	scores                                 any
	hot                                    []string
	briefMS                                []float64
	enough                                 []float64
	drops                                  []string
}

func simOnce(cfg *talkConfig, gem *talkGemini, jev *talkJev, pairName string, o *talkSimOpts) (simResult, error) {
	var res simResult
	people := simPeople[pairName]
	store := newMemStore()
	acc := &accounts{store: store, tenant: "sim", sess: sessions{secret: []byte("sim-sim-sim-sim-sim-sim-sim-sim!")}}
	ctx := context.Background()
	var ids [2]int64
	notes := map[int64][]string{}
	for i, p := range people {
		a, _, _ := store.SignIn(ctx, "sim", user{Sub: "sim:" + p.email, Email: p.email, Name: p.name, Given: strings.Fields(p.name)[0]})
		ids[i] = a.ID
		store.SaveProfile(ctx, "sim", a.ID, Profile{Name: strings.Fields(p.name)[0], Look: p.look})
		store.talkSavePrefs(ctx, "sim", a.ID, talkPrefs{OptIn: true, OkayToShare: true})
		notes[a.ID] = p.notes
		if *o.brief {
			up, _ := json.Marshal(map[string]any{"user_md": strings.Join(p.notes, "\n\n")})
			store.SaveMemory(ctx, "sim", a.ID, up, nil)
		} else {
			store.talkSaveBrief(ctx, "sim", a.ID, p.brief)
		}
	}
	sink := &simSink{start: time.Now(), a: ids[0], print: !*o.quiet, verdict: make(chan map[string]any, 1), reveal: make(chan map[string]any, 2), seen: map[int]bool{}}
	c := *cfg
	c.Memory.Use = !*o.nomem
	t := newAgentTalk(&c, acc, store, sink)
	t.gem, t.jev = gem, jev
	if !*o.nomem {
		t.recall = simRecall{generic: cfg.generic, notes: notes, delay: 120 * time.Millisecond} // ~MAPI search latency
	}
	if *o.brief {
		for _, id := range ids {
			start := time.Now()
			if _, err := t.buildBrief(ctx, "sim", id, talkPrefs{OptIn: true, OkayToShare: true}, true); err != nil {
				return res, err
			}
			res.briefMS = append(res.briefMS, ms(time.Since(start)))
		}
		if !*o.quiet {
			for _, id := range ids {
				b, _ := store.talkBrief(ctx, "sim", id)
				j, _ := json.Marshal(b)
				fmt.Printf("  brief #%d: %s\n", id, j)
			}
		}
	}
	sink.start = time.Now()
	id, err := t.encounter(ctx, "sim", ids[0], ids[1], true)
	if err != nil {
		return res, err
	}
	v := <-sink.verdict
	res.match = v["match"] == true
	if res.match {
		t.decide(ctx, "sim", ids[0], id, true)
		t.decide(ctx, "sim", ids[1], id, true)
		<-sink.reveal
		<-sink.reveal
	}
	var rec *talkRecord
	for i := 0; i < 200; i++ { // the record lands a moment after the last frame
		rec, err = store.talkGet(ctx, "sim", id)
		if err == nil && rec.State != "live" && rec.State != "awaiting" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		return res, err
	}
	tm := rec.Timings
	res.firstBubble, res.firstQuestion, res.firstWords = tm["first_bubble"], tm["first_question"], tm["first_answer_words"]
	res.checkpoint1, res.verdict, res.reveal, res.total = tm["checkpoint1"], tm["verdict"], tm["revealed"], tm["end"]
	res.gates, res.scores, res.hot = rec.Gates, rec.Verdict, rec.HotTopics
	for _, j := range rec.Jev {
		if j.What == "pick" {
			res.picks = append(res.picks, j.TookMS)
			if e, ok := j.Answers["enough"]; ok && e.Noul != nil {
				res.enough = append(res.enough, *e.Noul)
			}
		}
	}
	var qAt float64
	for _, l := range rec.Transcript {
		switch l.Kind {
		case "question":
			qAt = l.AtMS
			res.questions = append(res.questions, l.QID+" "+l.Text)
		case "answer":
			if l.Dropped > 0 || l.NotInMemory {
				res.drops = append(res.drops, fmt.Sprintf("n%d not_in_memory=%v dropped=%q", l.N, l.NotInMemory, l.DroppedText))
			}
			res.turns = append(res.turns, l.AtMS-qAt)
			res.firstTok = append(res.firstTok, l.FirstMS)
		}
	}
	return res, nil
}

func pct(xs []float64, p float64) float64 {
	if len(xs) == 0 {
		return math.NaN()
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	i := int(math.Ceil(p*float64(len(s)))) - 1
	return s[max(0, min(i, len(s)-1))]
}

func runTalkSim(o *talkSimOpts, cfgPath string) int {
	cfg, err := loadTalkConfig(cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	gk, jk := talkKey("GEMINI_API_KEY"), talkKey("JEV_API_KEY")
	if gk == "" || jk == "" {
		fmt.Fprintln(os.Stderr, "talk-sim needs GEMINI_API_KEY(_FILE) and JEV_API_KEY(_FILE)")
		return 1
	}
	gem, jev := newTalkGemini(gk), newTalkJev(jk, cfg.Models.JevModel)
	if *o.bench > 0 {
		return simBench(cfg, jev, *o.bench)
	}
	pairs := []string{"strong", "none"}
	if *o.pair != "both" {
		pairs = []string{*o.pair}
	}
	fmt.Printf("agent talk sim: config %s, agent %s (fallback %s), writer %s, memory outlet %v\n",
		cfg.Version, cfg.Models.Agent.Model, cfg.Models.AgentFallback.Model, cfg.Models.Writer.Model, !*o.nomem)
	for _, pair := range pairs {
		var all []simResult
		for i := 0; i < *o.runs; i++ {
			if !*o.quiet {
				fmt.Printf("\n== %s pair, run %d\n", pair, i+1)
			}
			r, err := simOnce(cfg, gem, jev, pair, o)
			if err != nil {
				fmt.Fprintln(os.Stderr, "run failed:", err)
				return 1
			}
			all = append(all, r)
			if !*o.quiet {
				fmt.Printf("  hot topics: %q\n  gates: %v\n  verdict: %v\n  phase-2 'enough': %v\n  guard/memory: %v\n", r.hot, r.gates, r.scores, r.enough, r.drops)
				if len(r.briefMS) > 0 {
					fmt.Printf("  brief builds: %.0f ms, %.0f ms\n", r.briefMS[0], r.briefMS[1])
				}
			}
		}
		simReport(pair, all)
	}
	return 0
}

func simReport(pair string, all []simResult) {
	col := func(f func(simResult) float64) []float64 {
		var xs []float64
		for _, r := range all {
			if v := f(r); v > 0 {
				xs = append(xs, v)
			}
		}
		return xs
	}
	flat := func(f func(simResult) []float64) []float64 {
		var xs []float64
		for _, r := range all {
			xs = append(xs, f(r)...)
		}
		return xs
	}
	matches := 0
	for _, r := range all {
		if r.match {
			matches++
		}
	}
	fmt.Printf("\n%s pair: %d runs, %d matched\n", pair, len(all), matches)
	row := func(name string, xs []float64) {
		if len(xs) > 0 {
			fmt.Printf("  %-34s p50 %7.0f ms   p95 %7.0f ms   (n=%d)\n", name, pct(xs, 0.5), pct(xs, 0.95), len(xs))
		}
	}
	row("first bubble (greeting)", col(func(r simResult) float64 { return r.firstBubble }))
	row("first question bubble", col(func(r simResult) float64 { return r.firstQuestion }))
	row("first answer words on screen", col(func(r simResult) float64 { return r.firstWords }))
	row("jev pick", flat(func(r simResult) []float64 { return r.picks }))
	row("agent turn (question→answer done)", flat(func(r simResult) []float64 { return r.turns }))
	row("answer model: first words", flat(func(r simResult) []float64 { return r.firstTok }))
	row("checkpoint 1 decided", col(func(r simResult) float64 { return r.checkpoint1 }))
	row("verdict pushed", col(func(r simResult) float64 { return r.verdict }))
	row("reveal (both approve instantly)", col(func(r simResult) float64 { return r.reveal }))
	row("whole talk", col(func(r simResult) float64 { return r.total }))
	for i, r := range all {
		fmt.Printf("  run %d questions: %s\n", i+1, strings.Join(r.questions, " | "))
	}
}

// simBench times jev's pick alone: the full bank vs the fixture, with and without the
// memory outlet in the state.
func simBench(cfg *talkConfig, jev *talkJev, n int) int {
	bank, ver := loadTalkBank()
	people := simPeople["strong"]
	store := newMemStore()
	acc := &accounts{store: store, tenant: "sim", sess: sessions{secret: []byte("sim-sim-sim-sim-sim-sim-sim-sim!")}}
	mk := func(useMem bool, b []talkQuestion) *talkRun {
		c := *cfg
		c.Memory.Use = useMem
		t := newAgentTalk(&c, acc, store, &simSink{})
		t.jev, t.bank = jev, b
		r := &talkRun{t: t, rec: &talkRecord{Tenant: "sim", Timings: map[string]float64{}}, asked: map[string]bool{}}
		for i, p := range people {
			br := p.brief
			r.sides[i] = &talkSide{person: talkPerson{id: int64(i + 1), names: talkNameParts(p.name)}, prefs: talkPrefs{OptIn: true, OkayToShare: true}, brief: &br}
			r.sides[i].snippets = []talkSnippet{{Text: p.notes[0]}, {Text: p.notes[1]}, {Text: p.notes[3%len(p.notes)]}}
		}
		r.hot = t.finishTopics(t.lexicalTopics(context.Background(), "sim", r.sides, true), r.sides)
		r.rec.Transcript = []talkLine{
			{Side: "a", Kind: "question", Text: "What is your human building at HackGT 13?"},
			{Side: "b", Kind: "answer", Text: "My human is building a Go relay that fans out live game events to thousands of phones."},
			{Side: "b", Kind: "question", Text: "What is your human stuck on right now?"},
		}
		return r
	}
	type variant struct {
		name   string
		mem    bool
		bank   []talkQuestion
		chosen map[string]int
		lat    []float64
		state  int
		opts   int
	}
	vs := []*variant{
		{name: "full bank (" + ver + "), with memory", mem: true, bank: bank},
		{name: "full bank (" + ver + "), no memory", mem: false, bank: bank},
		{name: "fixture (14), with memory", mem: true, bank: talkFixtureBank},
		{name: "fixture (14), no memory", mem: false, bank: talkFixtureBank},
	}
	for _, v := range vs {
		v.chosen = map[string]int{}
		r := mk(v.mem, v.bank)
		r.asked["f01"], r.asked["f02"] = true, true
		for _, q := range bank {
			if strings.HasPrefix(q.Text, "What is your human building at HackGT 13") {
				r.asked[q.ID] = true
			}
		}
		opts := r.options(3, &cfg.Phase1)
		state := r.state(1, cfg.Phase1.Objective, "")
		v.state, v.opts = len(state), len(opts)
		for i := 0; i < n; i++ {
			start := time.Now()
			ans, err := jev.ask(context.Background(), state, map[string]any{"next": r.pickQuestion(1, opts)})
			if err != nil {
				fmt.Fprintln(os.Stderr, "jev:", err)
				return 1
			}
			v.lat = append(v.lat, ms(time.Since(start)))
			v.chosen[ans["next"].Choice]++
		}
	}
	byID := map[string]string{}
	for _, q := range append(append([]talkQuestion(nil), bank...), talkFixtureBank...) {
		byID[q.ID] = q.Text
	}
	fmt.Printf("jev pick latency, %d calls each (strong pair, 3 lines in, B's agent asks next)\n", n)
	for _, v := range vs {
		fmt.Printf("  %-32s options %3d  state %5d chars  p50 %4.0f ms  p95 %4.0f ms\n", v.name, v.opts, v.state, pct(v.lat, 0.5), pct(v.lat, 0.95))
		for id, c := range v.chosen {
			fmt.Printf("      %dx %s %s\n", c, id, byID[id])
		}
	}
	return 0
}
