package main

// One agent talk, start to verdict (see agenttalk.go for the whole picture).

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	mrand "math/rand/v2"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type talkSide struct {
	person   talkPerson
	prefs    talkPrefs
	brief    *talkBrief
	snippets []talkSnippet // latest hits from this person's own memory (jev's state only)
}

type talkRun struct {
	t     *agentTalk
	start time.Time
	sides [2]*talkSide

	mu       sync.Mutex // rec, the sides' snippets, hot
	rec      *talkRecord
	hot      []string
	asked    map[string]bool // main loop only
	n        int             // next line number (main loop only)
	lastLine time.Time       // main loop only
	iceReady chan struct{}
	iceOnce  sync.Once
	expiry   *time.Timer
}

func sideName(i int) string { return [2]string{"a", "b"}[i] }

func (r *talkRun) sinceMS() float64 { return ms(time.Since(r.start)) }

func (r *talkRun) bothShare() bool {
	return r.sides[0].prefs.OkayToShare && r.sides[1].prefs.OkayToShare
}

func (r *talkRun) mark(k string) {
	r.mu.Lock()
	if _, ok := r.rec.Timings[k]; !ok {
		r.rec.Timings[k] = r.sinceMS()
	}
	r.mu.Unlock()
}

func (r *talkRun) logJev(c talkJevCall) {
	r.mu.Lock()
	r.rec.Jev = append(r.rec.Jev, c)
	r.mu.Unlock()
}

// pushBoth sends the same frame to both phones.
func (r *talkRun) pushBoth(msg map[string]any) {
	for _, s := range r.sides {
		r.t.sink.send(s.person.id, msg)
	}
}

// pushLine sends a bubble; "from" is relative to each phone.
func (r *talkRun) pushLine(side, n int, text string, extra map[string]any) {
	for i, s := range r.sides {
		from := "their_agent"
		if i == side {
			from = "your_agent"
		}
		line := map[string]any{"n": n, "from": from, "text": text}
		for k, v := range extra {
			line[k] = v
		}
		r.t.sink.send(s.person.id, map[string]any{"t": "agents", "id": r.rec.ID, "line": line})
	}
}

// pace keeps at least min_gap_ms between bubbles, so the show reads rather than dumps.
func (r *talkRun) pace() {
	gap := r.t.cfg.ms(r.t.cfg.Limits.MinGapMS)
	if wait := time.Until(r.lastLine.Add(gap)); wait > 0 && !r.lastLine.IsZero() {
		time.Sleep(wait)
	}
	r.lastLine = time.Now()
}

func (r *talkRun) names(side int) talkNames {
	return talkNames{own: r.sides[side].person.names, other: r.sides[1-side].person.names}
}

// say posts a whole line from one side's agent (greetings, questions, closings).
func (r *talkRun) say(side int, kind, qid, text string) {
	r.pace()
	text = talkGuard{names: r.names(side)}.line(text)
	r.mu.Lock()
	n := r.n
	r.n++
	r.rec.Transcript = append(r.rec.Transcript, talkLine{N: n, Side: sideName(side), Kind: kind, QID: qid, Text: text, AtMS: r.sinceMS()})
	r.mu.Unlock()
	if n == 0 {
		r.mark("first_bubble")
	}
	r.pushLine(side, n, text, nil)
}

func (r *talkRun) save() {
	r.mu.Lock()
	rec := r.rec.copy()
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := r.t.ts.talkSave(ctx, rec); err != nil {
		log.Printf("talk: saving %s: %v", rec.ID, err)
	}
}

// finish records the end state; the run leaves the live table unless it awaits approvals.
func (r *talkRun) finish(state string) {
	r.mu.Lock()
	r.rec.State = state
	if state != "awaiting" {
		now := time.Now().UTC()
		r.rec.Ended = &now
		r.rec.Timings["end"] = r.sinceMS()
	}
	r.mu.Unlock()
	r.save()
	if state != "awaiting" {
		r.t.mu.Lock()
		delete(r.t.live, r.rec.ID)
		r.t.mu.Unlock()
	}
}

// ---------- the show ----------

func (r *talkRun) run() {
	cfg := r.t.cfg
	defer func() {
		if p := recover(); p != nil {
			log.Printf("talk: %s: panic: %v", r.rec.ID, p)
			r.finish("error")
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// t≈0: both phones learn someone's here (their bean only)
	for i, s := range r.sides {
		r.t.sink.send(s.person.id, map[string]any{"t": "encounter", "id": r.rec.ID, "other": map[string]any{"bean": r.sides[1-i].person.look}})
	}
	r.mark("encounter")
	go r.t.gem.warm(cfg.Models.Agent)

	// briefs (normally built when the memory arrived) while A's agent says hi
	var wg sync.WaitGroup
	for i, s := range r.sides {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, err := r.t.briefFor(ctx, r.rec.Tenant, s.person.id, s.prefs)
			if err != nil {
				log.Printf("talk: %s: brief for side %s: %v", r.rec.ID, sideName(i), err)
			}
			if b == nil {
				b = &talkBrief{InterruptOK: true}
			}
			s.brief = b
		}()
	}
	var greet [2]string
	if len(cfg.Lines.Greet) > 0 {
		greet = cfg.Lines.Greet[mrand.IntN(len(cfg.Lines.Greet))]
		r.say(0, "greet", "", greet[0])
	}
	wg.Wait()
	r.mark("briefs_ready")
	r.startHot(ctx)
	r.asked = map[string]bool{}

	// the first pick runs while B's agent says hi back
	p1, p2 := &cfg.Phase1, &cfg.Phase2
	plan := r.plan(ctx, 0, p1, "", nil)
	if greet[1] != "" {
		r.say(1, "greet", "", greet[1])
	}
	turn, dried := 0, false
	for ; turn < p1.Questions && plan != nil; turn++ {
		var next *talkPlan
		plan, next = r.step(plan, func() *talkPlan {
			if turn+1 < p1.Questions {
				return r.plan(ctx, turn+1, p1, "", nil)
			}
			return nil
		})
		if plan == nil {
			break
		}
		plan = next
		if r.dry() { // they keep drawing blanks: stop asking
			if plan != nil {
				plan.cancel()
			}
			turn++
			dried = true
			break
		}
	}

	// checkpoint 1: the gates, and phase 2's first pick, in one jev call
	gates, first, err := r.checkpoint1(ctx, turn)
	r.mark("checkpoint1")
	fired := r.fired(gates)
	if err != nil || len(fired) == 0 || r.redFlag(gates) {
		if first != nil {
			first.cancel()
		}
		why := "nothing fired"
		switch {
		case err != nil:
			why = "judge unavailable"
		case r.redFlag(gates):
			why = "red flag"
		}
		r.noMatch(why)
		return
	}

	// phase 2, steered toward what fired
	steer := r.steer(fired)
	plan = first
	if dried && plan != nil { // nothing more to find by asking: straight to the verdict
		plan.cancel()
		plan = nil
	}
	for k := 0; k < p2.Questions && plan != nil; k++ {
		n := turn
		var next *talkPlan
		var shown *talkPlan
		shown, next = r.step(plan, func() *talkPlan {
			if k+1 >= p2.Questions {
				return nil
			}
			var extra map[string]any
			if k+1 >= p2.MinQuestions && p2.Enough.Instructions != "" {
				extra = map[string]any{"enough": map[string]any{"type": "noul", "instructions": p2.Enough.Instructions}}
			}
			return r.plan(ctx, n+1, p2, steer, extra)
		})
		if shown == nil {
			break
		}
		turn++
		plan = next
		if r.dry() {
			if plan != nil {
				plan.cancel()
			}
			break
		}
	}

	// checkpoint 2
	verdict, fire := r.checkpoint2(ctx)
	r.mark("checkpoint2")
	r.mu.Lock()
	r.rec.Verdict, r.rec.Fired = verdict, fire
	r.mu.Unlock()
	if !fire {
		r.noMatch("checkpoint 2")
		return
	}
	r.match(verdict)
}

// step waits for plan's pick, asks it, starts the next plan (so its pick runs while this
// answer streams), and shows this answer. It returns plan (nil if nothing was asked) and the
// next plan.
func (r *talkRun) step(plan *talkPlan, next func() *talkPlan) (*talkPlan, *talkPlan) {
	pick := <-plan.pick
	if pick.stop || pick.enough {
		plan.cancel()
		return nil, nil
	}
	ans := <-plan.ans
	r.asked[pick.q.ID] = true
	r.say(plan.asker, "question", pick.q.ID, pick.q.said())
	if plan.n == 0 {
		r.mark("first_question")
	}
	np := next()
	r.show(ans)
	return plan, np
}

// ---------- planning a turn: jev's pick, then the answer at once ----------

type talkPickResult struct {
	q      talkQuestion
	stop   bool // nothing left to ask
	enough bool // jev says there's enough to decide
}

type talkPlan struct {
	n      int
	asker  int
	pick   chan talkPickResult // one value
	ans    chan *talkTurn      // one value, after pick (unless it stopped)
	cancel context.CancelFunc
}

// plan snapshots jev's state now (on the main loop) and picks in the background; the
// answer starts the moment the pick lands.
func (r *talkRun) plan(ctx context.Context, n int, ph *talkPhase, steer string, extra map[string]any) *talkPlan {
	ctx, cancel := context.WithCancel(ctx)
	p := &talkPlan{n: n, asker: n % 2, pick: make(chan talkPickResult, 1), ans: make(chan *talkTurn, 1), cancel: cancel}
	opts := r.options(n, ph)
	if len(opts) == 0 {
		p.pick <- talkPickResult{stop: true}
		return p
	}
	state := r.state(p.asker, ph.Objective, steer)
	qs := map[string]any{"next": r.pickQuestion(p.asker, opts)}
	for k, v := range extra {
		qs[k] = v
	}
	go func() {
		start := time.Now()
		pctx, pcancel := context.WithTimeout(ctx, r.t.cfg.ms(r.t.cfg.Models.PickTimeoutMS))
		ans, err := r.t.jev.ask(pctx, state, qs)
		pcancel()
		call := talkJevCall{What: "pick", N: n, TookMS: ms(time.Since(start)), Options: len(opts), State: len(state), Answers: ans}
		if err != nil {
			call.Err = err.Error()
		}
		r.logJev(call)
		res := talkPickResult{q: r.chosen(ans, opts)}
		if a, ok := ans["enough"]; ok && a.Noul != nil && *a.Noul >= r.t.cfg.Phase2.Enough.Threshold {
			res.enough = true
		}
		p.pick <- res
		if !res.enough {
			p.ans <- r.startAnswer(ctx, n, res.q, 1-p.asker)
		}
	}()
	return p
}

// planFrom: a plan whose pick is already known (checkpoint 1 picks phase 2's first question).
func (r *talkRun) planFrom(ctx context.Context, n int, q talkQuestion) *talkPlan {
	ctx, cancel := context.WithCancel(ctx)
	p := &talkPlan{n: n, asker: n % 2, pick: make(chan talkPickResult, 1), ans: make(chan *talkTurn, 1), cancel: cancel}
	p.pick <- talkPickResult{q: q}
	p.ans <- r.startAnswer(ctx, n, q, 1-p.asker)
	return p
}

// options: what may be asked next: never twice, deep ones only in phase 2, and questions
// that need consent only when both humans gave it. At most pick.max_options (jev's limit).
func (r *talkRun) options(n int, ph *talkPhase) map[string]talkQuestion {
	recent := map[string]bool{} // the types just asked, for variety
	pick := r.t.cfg.Pick
	streak, counting := 0, true // work questions in a row, most recent first
	r.mu.Lock()
	for i, k := len(r.rec.Transcript)-1, 0; i >= 0; i-- {
		l := r.rec.Transcript[i]
		if l.Kind != "question" {
			continue
		}
		typ := r.t.bankType(l.QID)
		if k < pick.TypeCooldown {
			recent[typ] = true
		}
		k++
		if counting && slices.Contains(pick.WorkTypes, typ) {
			streak++
		} else {
			counting = false
		}
		if k >= pick.TypeCooldown && !counting {
			break
		}
	}
	r.mu.Unlock()
	// the humans are people first: after max_work_streak project questions, a personal one
	if pick.MaxWorkStreak > 0 && streak >= pick.MaxWorkStreak {
		for _, typ := range pick.WorkTypes {
			recent[typ] = true
		}
	}
	return r.eligible(n, ph, recent)
}

// dry: the last limits.max_misses answers were all "don't know" (there's nothing more to find).
func (r *talkRun) dry() bool {
	max := r.t.cfg.Limits.MaxMisses
	if max <= 0 {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	misses := 0
	for i := len(r.rec.Transcript) - 1; i >= 0 && misses < max; i-- {
		l := r.rec.Transcript[i]
		if l.Kind != "answer" {
			continue
		}
		if !l.NotInMemory {
			return false
		}
		misses++
	}
	return misses >= max
}

// missLine: the kind "don't know", a different one from the last time it was said.
func (r *talkRun) missLine() string {
	lines := append([]string{r.t.cfg.Lines.NotInMemory}, r.t.cfg.Lines.NotInMemoryAlts...)
	r.mu.Lock()
	last := ""
	for i := len(r.rec.Transcript) - 1; i >= 0; i-- {
		if l := r.rec.Transcript[i]; l.Kind == "answer" && l.NotInMemory {
			last = l.Text
			break
		}
	}
	r.mu.Unlock()
	for range 4 {
		if s := lines[mrand.IntN(len(lines))]; s != last || len(lines) == 1 {
			return s
		}
	}
	return lines[0]
}

// answerable: could this brief answer a question of this type? Asking what the other agent
// can't know only gets "don't know" (its notes may still help, but the brief is the summary).
func answerable(b *talkBrief, typ string) bool {
	if b == nil {
		return true
	}
	has := func(xs ...[]string) bool {
		for _, x := range xs {
			if len(x) > 0 {
				return true
			}
		}
		return false
	}
	switch typ {
	case "now_at_hackgt", "building_and_craft":
		return b.OneLine != "" || has(b.Solved, b.StuckOn)
	case "stuck_and_solved":
		return has(b.StuckOn, b.Solved)
	case "career_and_path", "future_and_followup":
		return b.OneLine != "" || has(b.LookingFor)
	case "interests_and_rare", "fun_and_play":
		return has(b.Rare, b.Life)
	case "where_from", "values_and_beliefs":
		return has(b.Life)
	case "life_and_personal":
		return has(b.Life, b.GoingThrough)
	}
	return true
}

func (r *talkRun) eligible(n int, ph *talkPhase, recent map[string]bool) map[string]talkQuestion {
	share := r.bothShare()
	var brief *talkBrief // the answering agent's
	if s := r.sides[1-n%2]; s != nil {
		brief = s.brief
	}
	byType := map[string][]talkQuestion{}
	var types []string
	for _, q := range r.t.bank {
		if r.asked[q.ID] || (q.gated() && (!share || q.Consent != "okay_to_share")) {
			continue
		}
		if ph.MaxDepth > 0 && q.Depth > ph.MaxDepth {
			continue
		}
		if n == 0 && q.Type == "future_and_followup" { // nothing to follow up yet
			continue
		}
		if recent[q.Type] || !answerable(brief, q.Type) {
			continue
		}
		if byType[q.Type] == nil {
			types = append(types, q.Type)
		}
		byType[q.Type] = append(byType[q.Type], q)
	}
	// at most pick.max_options, dealt evenly across the types in a shuffled order: a smaller
	// choice for jev (a faster pick) that still spans every kind of question
	for _, qs := range byType {
		mrand.Shuffle(len(qs), func(i, j int) { qs[i], qs[j] = qs[j], qs[i] })
	}
	out := map[string]talkQuestion{}
	for round := 0; len(out) < r.t.cfg.Pick.MaxOptions; round++ {
		dealt := false
		for _, typ := range types {
			if qs := byType[typ]; round < len(qs) && len(out) < r.t.cfg.Pick.MaxOptions {
				out[qs[round].ID] = qs[round]
				dealt = true
			}
		}
		if !dealt {
			break
		}
	}
	if len(out) == 0 && len(recent) > 0 { // variety must never leave nothing to ask
		return r.eligible(n, ph, nil)
	}
	return out
}

func (r *talkRun) pickQuestion(asker int, opts map[string]talkQuestion) map[string]any {
	crit := make(map[string]string, len(opts))
	for id, q := range opts {
		d := q.Text
		if len(q.Informs) > 0 {
			d += " [" + q.Type + "; informs " + strings.Join(q.Informs, ", ") + "]"
		}
		crit[id] = d
	}
	who := "Human A's agent asks Human B's agent"
	if asker == 1 {
		who = "Human B's agent asks Human A's agent"
	}
	return map[string]any{"type": "choice", "instructions": r.t.cfg.Pick.Instructions + " Next: " + who + ".", "criteria": crit}
}

// chosen: jev's pick, or (jev down, or an answer that isn't an option) the first eligible
// question, shallowest first.
func (r *talkRun) chosen(ans map[string]jevAns, opts map[string]talkQuestion) talkQuestion {
	if a, ok := ans["next"]; ok {
		if q, ok := opts[a.Choice]; ok {
			return q
		}
	}
	ids := make([]string, 0, len(opts))
	for id := range opts {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if opts[ids[i]].Depth != opts[ids[j]].Depth {
			return opts[ids[i]].Depth < opts[ids[j]].Depth
		}
		return ids[i] < ids[j]
	})
	return opts[ids[0]]
}

// ---------- jev's state ----------

// state is what jev sees: the phase, both briefs, the hot topics, a few snippets from each
// side's own memory, and the conversation, within memory.state_budget_chars (the oldest
// lines go first). Names never appear (Human A / Human B).
func (r *talkRun) state(asker int, objective, steer string) string {
	cfg := r.t.cfg
	r.mu.Lock()
	hot := append([]string(nil), r.hot...)
	snips := [2][]talkSnippet{append([]talkSnippet(nil), r.sides[0].snippets...), append([]talkSnippet(nil), r.sides[1].snippets...)}
	lines := append([]talkLine(nil), r.rec.Transcript...)
	r.mu.Unlock()

	var head strings.Builder
	head.WriteString("OBJECTIVE: " + objective + "\n")
	if steer != "" {
		head.WriteString("STEER: " + steer + "\n")
	}
	who := [2]string{"Human A", "Human B"}
	head.WriteString("NEXT: " + who[asker] + "'s agent asks " + who[1-asker] + "'s agent.\n\n")
	rar := r.t.rarityFor(context.Background(), r.rec.Tenant)
	for i, s := range r.sides {
		head.WriteString(strings.ToUpper(who[i]) + " (brief from their own agent):\n" + r.briefText(s.brief, rar) + "\n")
	}
	if cfg.Memory.Use && len(hot) > 0 {
		head.WriteString("HOT TOPICS (where their memories meet):\n")
		for _, h := range hot {
			head.WriteString("- " + h + "\n")
		}
		head.WriteString("\n")
	}
	var mem strings.Builder
	if cfg.Memory.Use {
		for i := range r.sides {
			if len(snips[i]) == 0 {
				continue
			}
			mem.WriteString(strings.ToUpper(who[i]) + "'S OWN NOTES (for the latest question):\n")
			for _, sn := range snips[i] {
				mem.WriteString("- " + talkTrim(sn.Text, cfg.Memory.SnippetChars) + "\n")
			}
		}
		if mem.Len() > 0 {
			mem.WriteString("\n")
		}
	}
	budget := cfg.Memory.StateBudgetChars
	if budget <= 0 {
		budget = 12000
	}
	left := budget - head.Len() - mem.Len() - 40
	if left < 0 && mem.Len() > 0 { // the snippets give way before the conversation
		left += mem.Len()
		mem.Reset()
	}
	var conv []string
	for i := len(lines) - 1; i >= 0; i-- {
		l := who[0] + "'s agent: "
		if lines[i].Side == "b" {
			l = who[1] + "'s agent: "
		}
		l += lines[i].Text + "\n"
		if len(l) > left {
			break
		}
		left -= len(l)
		conv = append(conv, l)
	}
	var b strings.Builder
	b.WriteString(head.String())
	b.WriteString(mem.String())
	b.WriteString("CONVERSATION SO FAR:\n")
	for i := len(conv) - 1; i >= 0; i-- {
		b.WriteString(conv[i])
	}
	if len(conv) == 0 {
		b.WriteString("(nothing yet)\n")
	}
	out := talkNames{own: r.sides[0].person.names, other: r.sides[1].person.names, ownAs: "Human A", otherAs: "Human B"}.apply(b.String())
	if len(out) > budget {
		out = strings.ToValidUTF8(out[:budget], "")
	}
	return out
}

func talkTrim(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); n > 0 && len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// briefText renders a brief for jev (and the icebreaker writer), with how rare each rare
// thing is in this event; going_through only while both humans allow it.
func (r *talkRun) briefText(b *talkBrief, rar *talkRarity) string {
	if b == nil {
		return "(no brief: their agent hasn't shared anything yet)\n"
	}
	var s strings.Builder
	add := func(label string, xs []string) {
		if len(xs) > 0 {
			s.WriteString(label + ": " + strings.Join(xs, "; ") + "\n")
		}
	}
	if b.OneLine != "" {
		s.WriteString("About: " + b.OneLine + "\n")
	}
	add("Stuck on", b.StuckOn)
	add("Has built or solved", b.Solved)
	add("Looking for", b.LookingFor)
	var rare []string
	for _, tag := range b.Rare {
		if rar != nil && rar.n > 1 {
			tag += fmt.Sprintf(" (%d of %d people here)", max(rar.count(tag, r.t.cfg.generic), 1), rar.n)
		}
		rare = append(rare, tag)
	}
	add("Rare", rare)
	add("Outside the project", b.Life)
	if r.bothShare() {
		add("Going through", b.GoingThrough)
	}
	if b.InterruptOK {
		s.WriteString("Open to being interrupted: yes\n")
	} else {
		s.WriteString("Open to being interrupted: no, heads-down\n")
	}
	return s.String()
}

// ---------- an answer ----------

type talkTurn struct {
	n      int
	q      talkQuestion
	side   int         // the answering agent
	events chan string // guarded sentences as they're written; closed at the end
	line   talkLine    // the whole answer, set before events closes
	cancel context.CancelFunc
}

var talkAnswerSchema = map[string]any{
	"type": "OBJECT",
	"properties": map[string]any{
		"answer":        map[string]any{"type": "STRING"},
		"cites":         map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
		"not_in_memory": map[string]any{"type": "BOOLEAN"},
	},
	"required":         []string{"answer", "cites", "not_in_memory"},
	"propertyOrdering": []string{"answer", "cites", "not_in_memory"},
}

// agentBrief: the brief as the answering agent sees it (its own human only).
func (r *talkRun) agentBrief(b *talkBrief) string {
	m := map[string]any{"one_line": b.OneLine, "stuck_on": b.StuckOn, "solved": b.Solved, "looking_for": b.LookingFor, "rare": b.Rare, "life": b.Life, "interrupt_ok": b.InterruptOK}
	if r.bothShare() && len(b.GoingThrough) > 0 {
		m["going_through"] = b.GoingThrough
	}
	out, _ := json.Marshal(m)
	return string(out)
}

// startAnswer: the answering agent looks in its own human's memory for the question (and the
// asking side does too, for jev's next pick), then answers from its own brief and notes,
// streamed. Every sentence is guarded before it goes anywhere.
func (r *talkRun) startAnswer(ctx context.Context, n int, q talkQuestion, side int) *talkTurn {
	ctx, cancel := context.WithCancel(ctx)
	t := &talkTurn{n: n, q: q, side: side, events: make(chan string, 16), cancel: cancel}
	cfg := r.t.cfg
	go func() {
		defer close(t.events)
		start := time.Now()
		me := r.sides[side]
		// each side's own memory for this question: the answerer's notes feed its answer;
		// both sides' feed jev's next pick. Never the other way round.
		var notes [2][]talkSnippet
		if r.t.recall != nil && cfg.Memory.Use && cfg.Memory.SnippetsPerSide > 0 {
			sctx, scancel := context.WithTimeout(ctx, cfg.ms(cfg.Memory.SnippetTimeoutMS))
			var wg sync.WaitGroup
			for i := range r.sides {
				wg.Add(1)
				go func() {
					defer wg.Done()
					notes[i] = r.t.recall.search(sctx, r.rec.Tenant, r.sides[i].person.id, q.Text, cfg.Memory.SnippetsPerSide)
				}()
			}
			wg.Wait()
			scancel()
			r.mu.Lock()
			for i := range r.sides {
				if len(notes[i]) > 0 {
					r.sides[i].snippets = notes[i]
				}
			}
			r.mu.Unlock()
		}
		own := notes[side]
		names := r.names(side)
		var nb strings.Builder
		for i, sn := range own {
			nb.WriteString(fmt.Sprintf("%d. %s\n", i+1, names.apply(talkScrub(talkTrim(sn.Text, cfg.Memory.SnippetChars)))))
		}
		if nb.Len() == 0 {
			nb.WriteString("(none)\n")
		}
		brief := r.agentBrief(me.brief)
		var already []string // what this agent already said (its own lines only)
		r.mu.Lock()
		for _, l := range r.rec.Transcript {
			if l.Kind == "answer" && l.Side == sideName(side) {
				already = append(already, "- "+l.Text)
			}
		}
		r.mu.Unlock()
		if len(already) > 3 {
			already = already[len(already)-3:]
		}
		guard := talkGuard{
			names:   names,
			corpus:  newTalkCorpus(cfg.generic, brief, nb.String(), q.Text),
			generic: cfg.generic, min: cfg.Guard.GroundMin,
		}
		sys := strings.ReplaceAll(cfg.Prompts.Agent, "{max_words}", strconv.Itoa(cfg.Limits.AnswerMaxWords))
		user := "BRIEF (your human):\n" + brief + "\n\nNOTES (from your human's own memory):\n" + nb.String()
		if len(already) > 0 {
			user += "\nYOU ALREADY SAID:\n" + strings.Join(already, "\n") + "\n"
		}
		user += "\nThe other agent asks: \"" + q.said() + "\"\nReply as JSON {answer, cites, not_in_memory}."

		var buf strings.Builder
		consumed, words, dropped := 0, 0, 0
		var said, droppedText []string
		first := time.Duration(0)
		emit := func(sentences []string) {
			for _, s := range sentences {
				if words >= cfg.Limits.AnswerMaxWords+cfg.Limits.AnswerMaxWords/2 { // runaway answer
					dropped++
					continue
				}
				g := guard.sentence(s)
				if g == "" {
					dropped++
					droppedText = append(droppedText, talkScrub(guard.names.apply(s)))
					continue
				}
				if first == 0 {
					first = time.Since(start)
				}
				words += len(strings.Fields(g))
				said = append(said, g)
				select {
				case t.events <- g:
				case <-ctx.Done():
				}
			}
		}
		actx, acancel := context.WithTimeout(ctx, cfg.ms(cfg.Models.AgentTimeoutMS))
		out, model, err := r.t.gem.hedged(actx, cfg.Models.Agent, cfg.Models.AgentFallback, cfg.ms(cfg.Models.HedgeMS), sys, user, talkAnswerSchema, func(piece string) {
			buf.WriteString(piece)
			partial, _ := talkPartialString(buf.String(), "answer")
			if len(partial) < consumed {
				return
			}
			done, rest := talkSentences(partial[consumed:], false)
			consumed = len(partial) - len(rest)
			emit(done)
		})
		acancel()
		var res struct {
			Answer      string   `json:"answer"`
			Cites       []string `json:"cites"`
			NotInMemory bool     `json:"not_in_memory"`
		}
		if err == nil && json.Unmarshal([]byte(out), &res) == nil {
			if len(res.Answer) >= consumed {
				done, _ := talkSentences(res.Answer[consumed:], true)
				emit(done)
			}
		} else {
			if err == nil {
				err = fmt.Errorf("bad JSON")
			}
			partial, _ := talkPartialString(buf.String(), "answer")
			if len(partial) > consumed {
				done, _ := talkSentences(partial[consumed:], true)
				emit(done)
			}
			if ctx.Err() == nil {
				log.Printf("talk: %s: answer %d: %v", r.rec.ID, n, err)
			}
		}
		if len(said) == 0 && ctx.Err() == nil { // nothing safe to say: the kind fallback
			miss := r.missLine()
			said = append(said, miss)
			res.NotInMemory = true
			if first == 0 {
				first = time.Since(start)
			}
			select {
			case t.events <- miss:
			case <-ctx.Done():
			}
		}
		t.line = talkLine{Side: sideName(side), Kind: "answer", QID: q.ID, Text: strings.Join(said, " "), Cites: res.Cites,
			NotInMemory: res.NotInMemory, Dropped: dropped, DroppedText: droppedText, Model: model, FirstMS: ms(first), TookMS: ms(time.Since(start))}
	}()
	return t
}

// show streams an answer to both phones: a typing bubble, then each guarded sentence as it
// lands, then the whole line.
func (r *talkRun) show(t *talkTurn) {
	r.pace()
	n := r.n
	r.n++
	r.pushLine(t.side, n, "", map[string]any{"typing": true})
	var text []string
	for s := range t.events {
		text = append(text, s)
		if len(text) == 1 && t.n == 0 {
			r.mark("first_answer_words")
		}
		r.pushLine(t.side, n, strings.Join(text, " "), map[string]any{"partial": true})
	}
	line := t.line
	line.N, line.AtMS = n, r.sinceMS()
	if line.Text == "" { // cancelled mid-way: keep what was shown
		line.Text = strings.Join(text, " ")
	}
	r.pushLine(t.side, n, line.Text, nil)
	r.lastLine = time.Now()
	r.mu.Lock()
	r.rec.Transcript = append(r.rec.Transcript, line)
	r.mu.Unlock()
}

// ---------- checkpoints ----------

// gateOn: a consent gate (going_through) only when both allowed it and both briefs hold something.
func (r *talkRun) gateOn(g talkGate) bool {
	if !g.RequiresConsent {
		return true
	}
	return r.bothShare() && len(r.sides[0].brief.GoingThrough) > 0 && len(r.sides[1].brief.GoingThrough) > 0
}

// checkpoint1: one jev call with every gate (as noul) and, if phase 2 may follow, its first
// pick (which only runs if something fired).
func (r *talkRun) checkpoint1(ctx context.Context, n int) (map[string]float64, *talkPlan, error) {
	cfg := r.t.cfg
	qs := map[string]any{}
	for _, g := range cfg.Gates {
		if r.gateOn(g) {
			qs["gate_"+g.Key] = map[string]any{"type": "noul", "instructions": g.Instructions}
		}
	}
	var opts map[string]talkQuestion
	if cfg.Phase2.Questions > 0 {
		if opts = r.options(n, &cfg.Phase2); len(opts) > 0 {
			qs["next"] = r.pickQuestion(n%2, opts)
		}
	}
	state := r.state(n%2, cfg.Phase2.Objective, cfg.Phase2.GenericSteer)
	start := time.Now()
	jctx, cancel := context.WithTimeout(ctx, cfg.ms(cfg.Models.JudgeTimeoutMS))
	ans, err := r.t.jev.ask(jctx, state, qs)
	cancel()
	call := talkJevCall{What: "checkpoint1", N: n, TookMS: ms(time.Since(start)), Options: len(opts), State: len(state), Answers: ans}
	if err != nil {
		call.Err = err.Error()
	}
	r.logJev(call)
	if err != nil {
		return nil, nil, err
	}
	gates := map[string]float64{}
	for _, g := range cfg.Gates {
		if a, ok := ans["gate_"+g.Key]; ok && a.Noul != nil {
			gates[g.Key] = *a.Noul
		}
	}
	r.mu.Lock()
	r.rec.Gates = gates
	r.mu.Unlock()
	var first *talkPlan
	if len(opts) > 0 {
		first = r.planFrom(ctx, n, r.chosen(ans, opts))
	}
	return gates, first, nil
}

// fired: the positive gates at or over the threshold, in config order.
func (r *talkRun) fired(gates map[string]float64) []string {
	var out []string
	for _, g := range r.t.cfg.Gates {
		if !g.Negative && r.gateOn(g) && gates[g.Key] >= r.t.cfg.GateThreshold {
			out = append(out, g.Key)
		}
	}
	return out
}

func (r *talkRun) redFlag(gates map[string]float64) bool {
	for _, g := range r.t.cfg.Gates {
		if g.Negative && gates[g.Key] >= r.t.cfg.NegativeThreshold {
			return true
		}
	}
	return false
}

func (r *talkRun) steer(fired []string) string {
	var parts []string
	for _, k := range fired {
		if d, ok := r.t.cfg.Checkpoint2.Reason.Criteria[k]; ok {
			parts = append(parts, d)
		} else {
			parts = append(parts, k)
		}
	}
	return "Checkpoint 1 found: " + strings.Join(parts, "; ") + ". Ask what shows how strong this is, specifically, and how soon it would help."
}

// talkFires is the fire rule: the LOWER of the two values, the better of soon and
// talk-again, and a real reason.
func talkFires(c *talkConfig, scores map[string]float64, reason string) bool {
	return math.Min(scores["value_a"], scores["value_b"]) >= c.Fire.ValueMin &&
		math.Max(scores["soon"], scores["talk_again"]) >= c.Fire.SoonOrAgainMin &&
		reason != "" && reason != "none"
}

func (r *talkRun) checkpoint2(ctx context.Context) (map[string]any, bool) {
	cfg := r.t.cfg
	qs := map[string]any{}
	for k, s := range cfg.Checkpoint2.Scores {
		qs["score_"+k] = map[string]any{"type": "score", "instructions": s.Instructions, "criteria": s.Criteria}
	}
	reasons := map[string]string{}
	for k, v := range cfg.Checkpoint2.Reason.Criteria {
		if k == "going_through" && !r.bothShare() {
			continue
		}
		reasons[k] = v
	}
	qs["reason"] = map[string]any{"type": "choice", "instructions": cfg.Checkpoint2.Reason.Instructions, "criteria": reasons}
	qs["opener"] = map[string]any{"type": "choice", "instructions": cfg.Checkpoint2.Opener.Instructions, "criteria": cfg.Checkpoint2.Opener.Criteria}
	state := r.state(0, "Decide whether these two humans should meet in person now.", "")
	start := time.Now()
	jctx, cancel := context.WithTimeout(ctx, cfg.ms(cfg.Models.JudgeTimeoutMS))
	ans, err := r.t.jev.ask(jctx, state, qs)
	cancel()
	call := talkJevCall{What: "checkpoint2", TookMS: ms(time.Since(start)), State: len(state), Answers: ans}
	if err != nil {
		call.Err = err.Error()
		r.logJev(call)
		return map[string]any{"error": "judge unavailable"}, false
	}
	r.logJev(call)
	scores := map[string]float64{}
	for k := range cfg.Checkpoint2.Scores {
		if a, ok := ans["score_"+k]; ok && a.Score != nil {
			scores[k] = *a.Score
		}
	}
	reason := ans["reason"].Choice
	if _, ok := reasons[reason]; !ok {
		reason = "none"
	}
	opener := ans["opener"].Choice
	if _, ok := cfg.Checkpoint2.Opener.Criteria[opener]; !ok {
		opener = ""
	}
	fire := talkFires(cfg, scores, reason)
	return map[string]any{
		"scores": scores, "reason": reason, "opener": opener, "fire": fire,
		"min_value": math.Min(scores["value_a"], scores["value_b"]), "soon_or_again": math.Max(scores["soon"], scores["talk_again"]),
	}, fire
}

// ---------- endings ----------

// noMatch: the agents close warmly (never a word about anyone's weak spots), then match:false.
func (r *talkRun) noMatch(why string) {
	cl := r.t.cfg.Lines.Close[mrand.IntN(len(r.t.cfg.Lines.Close))]
	r.say(0, "close", "", cl[0])
	r.say(1, "close", "", cl[1])
	r.mu.Lock()
	if r.rec.Verdict == nil {
		r.rec.Verdict = map[string]any{}
	}
	r.rec.Verdict["why"] = why
	r.rec.Fired = false
	r.mu.Unlock()
	r.pushBoth(map[string]any{"t": "verdict", "id": r.rec.ID, "match": false})
	r.mark("verdict")
	r.finish("no_match")
}

// talkRelReason: the reason from one phone's side (a_fixed_b is "you fixed theirs" for A).
func talkRelReason(reason string, side int) string {
	switch {
	case reason == "a_fixed_b" && side == 0, reason == "b_fixed_a" && side == 1:
		return "you_fixed_theirs"
	case reason == "a_fixed_b", reason == "b_fixed_a":
		return "they_fixed_yours"
	}
	return reason
}

// match: ask both humans, and write the icebreaker while they decide.
func (r *talkRun) match(verdict map[string]any) {
	reason, _ := verdict["reason"].(string)
	r.mark("verdict")
	go r.icebreaker(verdict)
	// awaiting before the phones hear about it, so an instant "Meet them" isn't turned away
	ttl := time.Duration(max(r.t.cfg.Limits.ApproveTTLS, 1)) * time.Second
	r.mu.Lock()
	r.expiry = time.AfterFunc(ttl, func() { r.t.expire(r) })
	r.mu.Unlock()
	r.finish("awaiting")
	for i, s := range r.sides {
		rel := talkRelReason(reason, i)
		r.t.sink.send(s.person.id, map[string]any{"t": "verdict", "id": r.rec.ID, "match": true, "reason": rel,
			"why": r.t.cfg.Lines.Why[rel], "ask": r.t.cfg.Lines.Ask})
	}
}

var talkIcebreakerSchema = map[string]any{
	"type":             "OBJECT",
	"properties":       map[string]any{"line": map[string]any{"type": "STRING"}, "question": map[string]any{"type": "STRING"}},
	"required":         []string{"line", "question"},
	"propertyOrdering": []string{"line", "question"},
}

func (r *talkRun) icebreaker(verdict map[string]any) {
	defer r.iceOnce.Do(func() { close(r.iceReady) })
	cfg := r.t.cfg
	start := time.Now()
	reason, _ := verdict["reason"].(string)
	opener, _ := verdict["opener"].(string)
	sys := strings.NewReplacer("{opener}", cfg.Checkpoint2.Opener.Criteria[opener], "{reason}", cfg.Checkpoint2.Reason.Criteria[reason]).Replace(cfg.Prompts.Icebreaker)
	rar := r.t.rarityFor(context.Background(), r.rec.Tenant)
	var u strings.Builder
	u.WriteString("BRIEFS\nHuman A:\n" + r.briefText(r.sides[0].brief, rar) + "\nHuman B:\n" + r.briefText(r.sides[1].brief, rar) + "\nTRANSCRIPT\n")
	r.mu.Lock()
	for _, l := range r.rec.Transcript {
		if l.Kind == "question" || l.Kind == "answer" {
			u.WriteString("Human " + strings.ToUpper(l.Side) + "'s agent: " + l.Text + "\n")
		}
	}
	r.mu.Unlock()
	user := talkNames{own: r.sides[0].person.names, other: r.sides[1].person.names, ownAs: "Human A", otherAs: "Human B"}.apply(u.String())
	ctx, cancel := context.WithTimeout(context.Background(), cfg.ms(cfg.Models.WriterTimeoutMS))
	defer cancel()
	ice := cfg.Lines.IcebreakerFallback
	out, _, err := r.t.gem.hedged(ctx, cfg.Models.Writer, cfg.Models.WriterFallback, cfg.ms(cfg.Models.WriterTimeoutMS/3), sys, user, talkIcebreakerSchema, nil)
	var got talkIcebreaker
	if err == nil && json.Unmarshal([]byte(out), &got) == nil {
		// names come out at the reveal anyway, but the icebreaker is the same for both: none
		g := talkGuard{names: talkNames{own: r.sides[0].person.names, other: r.sides[1].person.names, ownAs: "you", otherAs: "you"}}
		got.Line, got.Question = g.line(got.Line), g.line(got.Question)
		if got.Line != "" && strings.HasSuffix(strings.TrimSpace(got.Question), "?") {
			ice = got
		}
	} else if err != nil {
		log.Printf("talk: %s: icebreaker: %v", r.rec.ID, err)
	}
	r.mu.Lock()
	r.rec.Icebreaker = &ice
	r.rec.Timings["icebreaker_ms"] = ms(time.Since(start))
	r.mu.Unlock()
	r.save()
}

// ---------- hot topics ----------

// startHot: the lexical topics now (brief against brief), the MAPI ones in the background.
func (r *talkRun) startHot(ctx context.Context) {
	t := r.t
	key := t.pairKey(r.rec.Tenant, r.sides[0].person.id, r.sides[1].person.id)
	t.mu.Lock()
	cached, ok := t.hot[key]
	t.mu.Unlock()
	if ok {
		r.mu.Lock()
		r.hot = cached
		r.rec.HotTopics = cached
		r.mu.Unlock()
		return
	}
	lex := t.lexicalTopics(ctx, r.rec.Tenant, r.sides, r.bothShare())
	set := func(topics []talkTopic) {
		out := t.finishTopics(topics, r.sides)
		r.mu.Lock()
		r.hot = out
		r.rec.HotTopics = out
		r.mu.Unlock()
		t.mu.Lock()
		t.hot[key] = out
		t.mu.Unlock()
	}
	set(lex)
	if t.recall == nil || !t.cfg.Memory.Use {
		return
	}
	go func() {
		start := time.Now()
		set(append(lex, t.mapiTopics(ctx, r.rec.Tenant, r.sides)...))
		r.mu.Lock()
		r.rec.Timings["hot_topics_ms"] = ms(time.Since(start))
		r.mu.Unlock()
	}()
}

// hotTopics, for prefetch: both kinds, synchronously.
func (t *agentTalk) hotTopics(ctx context.Context, tenant string, s [2]*talkSide, _ []talkTopic) []string {
	share := s[0].prefs.OkayToShare && s[1].prefs.OkayToShare
	topics := t.lexicalTopics(ctx, tenant, s, share)
	if t.recall != nil && t.cfg.Memory.Use {
		topics = append(topics, t.mapiTopics(ctx, tenant, s)...)
	}
	return t.finishTopics(topics, s)
}

type talkTopic struct {
	text  string
	score float64
}

func talkOverlap(x, y string, generic map[string]bool) float64 {
	a, b := map[string]bool{}, map[string]bool{}
	for _, w := range talkWords(x, generic) {
		a[w] = true
	}
	for _, w := range talkWords(y, generic) {
		b[w] = true
	}
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	in := 0
	for w := range a {
		if b[w] {
			in++
		}
	}
	return float64(in) / float64(len(a)+len(b)-in)
}

// lexicalTopics: where the two briefs meet, word for word (instant, no calls).
func (t *agentTalk) lexicalTopics(ctx context.Context, tenant string, s [2]*talkSide, share bool) []talkTopic {
	var out []talkTopic
	who := [2]string{"A", "B"}
	g := t.cfg.generic
	b := [2]*talkBrief{s[0].brief, s[1].brief}
	if b[0] == nil || b[1] == nil {
		return nil
	}
	for i := 0; i < 2; i++ {
		j := 1 - i
		for _, x := range b[i].StuckOn {
			for _, y := range b[j].Solved {
				if ov := talkOverlap(x, y, g); ov >= 0.15 {
					out = append(out, talkTopic{fmt.Sprintf("%s stuck on: %s ↔ %s solved: %s", who[i], x, who[j], y), 0.5 + ov})
				}
			}
		}
		for _, x := range b[i].LookingFor {
			for _, y := range append(append([]string(nil), b[j].Solved...), b[j].OneLine) {
				if ov := talkOverlap(x, y, g); ov >= 0.15 {
					out = append(out, talkTopic{fmt.Sprintf("%s looking for: %s ↔ %s has: %s", who[i], x, who[j], y), 0.3 + ov})
				}
			}
		}
	}
	for _, x := range b[0].StuckOn {
		for _, y := range b[1].StuckOn {
			if ov := talkOverlap(x, y, g); ov >= 0.2 {
				out = append(out, talkTopic{fmt.Sprintf("both stuck on: %s / %s", x, y), 0.4 + ov})
			}
		}
	}
	rar := t.rarityFor(ctx, tenant)
	for _, x := range b[0].Rare {
		for _, y := range b[1].Rare {
			if ov := talkOverlap(x, y, g); ov >= 0.2 {
				c := max(rar.count(x, g), 2)
				rarity := 0.5
				if rar.n > 1 {
					rarity = 1 - float64(c)/float64(rar.n)
				}
				out = append(out, talkTopic{fmt.Sprintf("both: %s (%d of %d people here)", x, c, max(rar.n, 2)), ov + rarity})
			}
		}
	}
	if share {
		for _, x := range b[0].GoingThrough {
			for _, y := range b[1].GoingThrough {
				if ov := talkOverlap(x, y, g); ov >= 0.2 {
					out = append(out, talkTopic{fmt.Sprintf("both going through: %s / %s", x, y), 0.3 + ov})
				}
			}
		}
	}
	return out
}

// mapiTopics: each side's brief lines searched in the OTHER person's memory space. The hits
// only ever reach jev's state (as a short phrase), never the other agent.
func (t *agentTalk) mapiTopics(ctx context.Context, tenant string, s [2]*talkSide) []talkTopic {
	cfg := t.cfg
	ctx, cancel := context.WithTimeout(ctx, cfg.ms(cfg.Memory.OverlapTimeoutMS))
	defer cancel()
	who := [2]string{"A", "B"}
	type job struct {
		i    int
		line string
	}
	var jobs []job
	for i := 0; i < 2; i++ {
		b := s[i].brief
		if b == nil {
			continue
		}
		var lines []string
		lines = append(lines, b.StuckOn...)
		lines = append(lines, b.LookingFor...)
		lines = append(lines, b.Rare...)
		lines = append(lines, b.Life...)
		lines = append(lines, b.Solved...)
		for k, l := range lines {
			if k >= cfg.Memory.OverlapQueriesPerSide {
				break
			}
			jobs = append(jobs, job{i, l})
		}
	}
	res := make([]*talkTopic, len(jobs))
	var wg sync.WaitGroup
	for k, jb := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j := 1 - jb.i
			hits := t.recall.search(ctx, tenant, s[j].person.id, jb.line, 1)
			if len(hits) == 0 || hits[0].Score < cfg.Memory.OverlapMinScore {
				return
			}
			short := talkTrim(firstNonEmpty(hits[0].From+": ", "")+hits[0].Text, 90)
			res[k] = &talkTopic{fmt.Sprintf("%s: %s ↔ %s's notes: %s", who[jb.i], jb.line, who[j], short), hits[0].Score}
		}()
	}
	wg.Wait()
	var out []talkTopic
	for _, tp := range res {
		if tp != nil {
			out = append(out, *tp)
		}
	}
	return out
}

// finishTopics: best first, no repeats, scrubbed, names out, at most max_hot_topics.
func (t *agentTalk) finishTopics(topics []talkTopic, s [2]*talkSide) []string {
	sort.SliceStable(topics, func(i, j int) bool { return topics[i].score > topics[j].score })
	names := talkNames{own: s[0].person.names, other: s[1].person.names, ownAs: "A", otherAs: "B"}
	seen := map[string]bool{}
	out := []string{}
	for _, tp := range topics {
		txt := names.apply(talkScrub(tp.text))
		if seen[txt] || len(out) >= t.cfg.Memory.MaxHotTopics {
			continue
		}
		seen[txt] = true
		out = append(out, txt)
	}
	return out
}
