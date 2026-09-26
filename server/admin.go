package main

// Organizer-only admin API (HackGT 13). The contract is admin-api-contract.md (shared with the
// admin UI); in short, all GET, JSON, Cache-Control: no-store:
//   /api/admin/me                who you are (admins only)
//   /api/admin/overview          headline numbers from real data; untracked ones are null
//   /api/admin/talks             agent talks, newest first: ?status=live|done|abandoned|all
//                                &match=true|false&q=<search>&limit=50&cursor=<next>
//   /api/admin/talks/<id>        one talk: transcript, checkpoints, hot topics, timings
//   /api/admin/stream            Server-Sent Events: "talk", "line", "overview" (+ keepalives)
// Every endpoint takes ?include_test=true to include @facemash.test accounts (hidden by default).
//
// Who: the normal session cookie (gtq_session) of a signed-in account whose email, lowercased,
// is in ADMIN_EMAILS (comma-separated). Signed out: 401. Anyone else: 403. Identity comes only
// from the session; nothing in the request can claim it. A mild per-admin rate limit applies.
//
// Privacy: first names only; no emails (except your own on /me), keys, contact details or raw
// memory. Transcripts are what the agents said aloud (already guarded); what the guard
// withheld is only counted and explained, never shown. Hot topics drawn from someone's memory
// index are cut to "X's notes" without the snippet.
//
// The stream never touches the talk engine's hot path: one goroutine polls the engine's live
// table (holding its locks only to copy a record) and the talks table for other changes, and
// fans pre-encoded frames out to every admin viewer without blocking; a viewer that falls
// behind is disconnected (EventSource reconnects on its own).
//
// Operator CLI: server -purge-test-accounts [-dry-run=false] deletes ONLY accounts whose email
// ends in @facemash.test (their memberships, talks, memory, tokens, and a queued MAPI purge).
// Dry run by default.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	adminPurgeFlag = flag.Bool("purge-test-accounts", false, "delete every account whose email ends in @facemash.test (memberships, talks, memory, tokens; queues their MAPI purge), print counts, and exit; a dry run unless -dry-run=false")
	adminDryRun    = flag.Bool("dry-run", true, "with -purge-test-accounts: only count, change nothing")
)

// adminCLI runs the operator commands; true means one ran and the server should exit.
func adminCLI(keyFile string) bool {
	if !*adminPurgeFlag {
		return false
	}
	a := openAccounts(keyFile)
	if a == nil {
		log.Fatal("purge-test-accounts: no database")
	}
	defer a.store.Close()
	if _, mem := a.store.(*memStore); mem {
		log.Printf("purge-test-accounts: accounts are in memory (no DB_INSTANCE/DB_HOST): nothing to purge")
	}
	as, ok := a.store.(adminStore)
	if !ok {
		log.Fatal("purge-test-accounts: this store can't purge")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	rep, err := as.purgeTestAccounts(ctx, *adminDryRun)
	if err != nil {
		log.Printf("purge-test-accounts: %v (nothing changed)", err)
		os.Exit(1)
	}
	fmt.Print(adminPurgeText(rep))
	return true
}

func adminPurgeText(rep adminPurgeReport) string {
	var b strings.Builder
	if rep.DryRun {
		b.WriteString("purge-test-accounts: DRY RUN, nothing changed (add -dry-run=false to delete)\n")
	} else {
		b.WriteString("purge-test-accounts: deleted\n")
	}
	fmt.Fprintf(&b, "  accounts (email ends in %s): %d %v\n", testEmailSuffix, rep.Accounts, rep.IDs)
	fmt.Fprintf(&b, "  memberships: %d\n  agent talks: %d\n  agent memories: %d\n  api tokens: %d\n  MAPI purges queued: %d\n",
		rep.Memberships, rep.Talks, rep.Memories, rep.Tokens, rep.PurgesQueued)
	return b.String()
}

// ---------- contract types ----------

type adminPerson struct {
	ID        int64   `json:"id"`
	FirstName string  `json:"first_name"`
	Bean      string  `json:"bean"`
	Source    *string `json:"source"`
}

type adminScores struct {
	ValueA    float64 `json:"value_a"`
	ValueB    float64 `json:"value_b"`
	Soon      float64 `json:"soon"`
	TalkAgain float64 `json:"talk_again"`
	Depth     float64 `json:"depth"`
}

type adminBoolPair struct {
	A *bool `json:"a"`
	B *bool `json:"b"`
}

type adminTalkSummary struct {
	ID            string        `json:"id"`
	Status        string        `json:"status"`
	StartedAt     time.Time     `json:"started_at"`
	EndedAt       *time.Time    `json:"ended_at"`
	A             adminPerson   `json:"a"`
	B             adminPerson   `json:"b"`
	Turns         int           `json:"turns"`
	StoppedAt     *string       `json:"stopped_at"`
	Match         *bool         `json:"match"`
	Reason        *string       `json:"reason"`
	Overall       *float64      `json:"overall"`
	Scores        *adminScores  `json:"scores"`
	Approvals     adminBoolPair `json:"approvals"`
	Revealed      bool          `json:"revealed"`
	WorthIt       adminBoolPair `json:"worth_it"`
	Withheld      int           `json:"withheld"`
	ConfigVersion string        `json:"config_version"`
}

type adminLine struct {
	At             time.Time `json:"at"`
	From           string    `json:"from"`
	Kind           string    `json:"kind"`
	Text           string    `json:"text"`
	QuestionID     *string   `json:"question_id"`
	Cites          []string  `json:"cites"`
	Withheld       bool      `json:"withheld"`
	WithheldReason *string   `json:"withheld_reason"`
}

type adminChoice struct {
	Choice     string  `json:"choice"`
	Confidence float64 `json:"confidence"`
}

type adminCheckpoint struct {
	Name    string                 `json:"name"`
	At      *time.Time             `json:"at"`
	Gates   map[string]float64     `json:"gates"`
	Scores  *adminScores           `json:"scores"`
	Choices map[string]adminChoice `json:"choices"`
	Passed  bool                   `json:"passed"`
}

type adminTimings struct {
	FirstBubble *int `json:"first_bubble"`
	Checkpoint1 *int `json:"checkpoint1"`
	Verdict     *int `json:"verdict"`
	Reveal      *int `json:"reveal"`
}

type adminTalkDetail struct {
	adminTalkSummary
	Lines       []adminLine       `json:"lines"`
	Checkpoints []adminCheckpoint `json:"checkpoints"`
	HotTopics   []string          `json:"hot_topics"`
	Icebreaker  *talkIcebreaker   `json:"icebreaker"`
	TimingsMS   adminTimings      `json:"timings_ms"`
}

type adminOverview struct {
	UsersTotal         int       `json:"users_total"`
	UsersSignedInToday int       `json:"users_signed_in_today"`
	ActiveNow          int       `json:"active_now"`
	InKlausNow         int       `json:"in_klaus_now"`
	ActivityHoursTotal *float64  `json:"activity_hours_total"` // not tracked: null
	MemoriesTotal      int       `json:"memories_total"`
	MuseConnected      int       `json:"muse_connected"`
	VoiceOnboarded     *int      `json:"voice_onboarded"` // not tracked: null
	TalksTotal         int       `json:"talks_total"`
	TalksLive          int       `json:"talks_live"`
	TalksToday         int       `json:"talks_today"`
	MatchesTotal       int       `json:"matches_total"`
	ApprovalsBoth      int       `json:"approvals_both"`
	RevealsTotal       int       `json:"reveals_total"`
	WorthItYes         int       `json:"worth_it_yes"`
	WorthItNo          int       `json:"worth_it_no"`
	WithheldLinesTotal int       `json:"withheld_lines_total"`
	AsOf               time.Time `json:"as_of"`
}

// ---------- the API ----------

type adminAPI struct {
	acc    *accounts
	hub    *Hub
	store  adminStore
	ts     talkStore
	admins map[string]bool
	lim    *keyLimiter
	now    func() time.Time
	ovTTL  time.Duration
	bc     *adminBroadcaster
	// a filtered page reads scanBatch rows at a time, at most scanMax per request
	scanBatch, scanMax int

	authMu sync.Mutex
	auth   map[int64]adminAuthEntry

	peopleMu sync.Mutex
	people   map[int64]adminPeopleEntry

	ovMu sync.Mutex
	ov   map[bool]*adminOverview
}

type adminAuthEntry struct {
	email string
	admin bool
	exp   time.Time
}

type adminPeopleEntry struct {
	row adminPersonRow
	exp time.Time
}

type adminCaller struct {
	uid   int64
	email string
}

var errAdminBusy = errors.New("too many admin streams")

// mountAdmin adds /api/admin/*; nil when there are no accounts to read.
func mountAdmin(mux *http.ServeMux, acc *accounts, hub *Hub) *adminAPI {
	if acc == nil {
		return nil
	}
	st, ok := acc.store.(adminStore)
	if !ok {
		return nil
	}
	ts, _ := acc.store.(talkStore)
	a := &adminAPI{
		acc: acc, hub: hub, store: st, ts: ts, admins: talkAdmins(), now: time.Now, ovTTL: 5 * time.Second, scanBatch: 100, scanMax: 3000,
		lim:  newKeyLimiter(60, 200*time.Millisecond, 8), // 60 at once, then 5 a second; 8 in flight
		auth: map[int64]adminAuthEntry{}, people: map[int64]adminPeopleEntry{}, ov: map[bool]*adminOverview{},
	}
	a.bc = newAdminBroadcaster(a)
	if len(a.admins) == 0 {
		log.Printf("admin: ADMIN_EMAILS is empty: /api/admin answers 403 to everyone")
	} else {
		log.Printf("admin: %d admin(s) allowed", len(a.admins))
	}
	mux.HandleFunc("/api/admin/me", a.guard(false, a.handleMe))
	mux.HandleFunc("/api/admin/overview", a.guard(false, a.handleOverview))
	mux.HandleFunc("/api/admin/talks", a.guard(false, a.handleTalks))
	mux.HandleFunc("/api/admin/talks/", a.guard(false, a.handleTalk))
	mux.HandleFunc("/api/admin/stream", a.guard(true, a.handleStream))
	mux.HandleFunc("/api/admin/", a.guard(false, func(w http.ResponseWriter, r *http.Request, _ adminCaller) {
		adminJSON(w, http.StatusNotFound, map[string]string{"error": "no such admin endpoint"})
	}))
	return a
}

func adminJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// guard: GET only, a session, the rate limit, then the allow-list.
func (a *adminAPI) guard(stream bool, h func(http.ResponseWriter, *http.Request, adminCaller)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET")
			adminJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET only"})
			return
		}
		uid, ok := a.acc.sess.read(r)
		if !ok {
			adminJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		release, wait, ok := a.lim.acquire(fastWho{"admin", uid})
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(wait.Seconds())))))
			adminJSON(w, http.StatusTooManyRequests, map[string]string{"error": "slow down"})
			return
		}
		if stream {
			release() // a stream holds no in-flight slot; the broadcaster caps streams itself
		} else {
			defer release()
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		email, admin, err := a.who(ctx, uid)
		cancel()
		switch {
		case errors.Is(err, errNoAccount):
			adminJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		case err != nil:
			log.Printf("admin: account %d: %v", uid, err)
			adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		case !admin:
			adminJSON(w, http.StatusForbidden, map[string]string{"error": "organizers only"})
			return
		}
		h(w, r, adminCaller{uid: uid, email: email})
	}
}

// who: the account's email and whether it is on the allow-list (cached 30 s).
func (a *adminAPI) who(ctx context.Context, uid int64) (string, bool, error) {
	now := a.now()
	a.authMu.Lock()
	e, ok := a.auth[uid]
	a.authMu.Unlock()
	if ok && now.Before(e.exp) {
		return e.email, e.admin, nil
	}
	acct, err := a.acc.store.Account(ctx, a.acc.tenant, uid)
	if err != nil {
		return "", false, err
	}
	email := strings.ToLower(strings.TrimSpace(acct.User.Email))
	e = adminAuthEntry{email: email, admin: email != "" && a.admins[email], exp: now.Add(30 * time.Second)}
	a.authMu.Lock()
	a.auth[uid] = e
	a.authMu.Unlock()
	return e.email, e.admin, nil
}

func includeTest(r *http.Request) bool {
	v := r.URL.Query().Get("include_test")
	return v == "true" || v == "1"
}

func (a *adminAPI) handleMe(w http.ResponseWriter, r *http.Request, c adminCaller) {
	adminJSON(w, http.StatusOK, map[string]any{"admin": true, "email": c.email, "tenant": a.acc.tenant})
}

func (a *adminAPI) handleOverview(w http.ResponseWriter, r *http.Request, _ adminCaller) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	ov, err := a.overview(ctx, includeTest(r))
	if err != nil {
		log.Printf("admin: overview: %v", err)
		adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
		return
	}
	adminJSON(w, http.StatusOK, ov)
}

// ---------- overview ----------

// overview: computed at most once per ovTTL per include_test (many viewers, one query).
func (a *adminAPI) overview(ctx context.Context, withTest bool) (*adminOverview, error) {
	now := a.now()
	a.ovMu.Lock()
	defer a.ovMu.Unlock()
	if ov := a.ov[withTest]; ov != nil && now.Sub(ov.AsOf) < a.ovTTL {
		return ov, nil
	}
	day := talkDayStart(now)
	c, err := a.store.adminCounts(ctx, a.acc.tenant, day, withTest)
	if err != nil {
		return nil, err
	}
	ts, err := a.store.adminTalkStats(ctx, a.acc.tenant, day, withTest)
	if err != nil {
		return nil, err
	}
	ov := &adminOverview{
		UsersTotal: c.users, UsersSignedInToday: c.signedInToday, MemoriesTotal: c.memories, MuseConnected: c.museConnected,
		TalksTotal: ts.total, TalksLive: ts.live, TalksToday: ts.today, MatchesTotal: ts.matches, ApprovalsBoth: ts.approvalsBoth,
		RevealsTotal: ts.reveals, WorthItYes: ts.worthYes, WorthItNo: ts.worthNo, WithheldLinesTotal: ts.withheldLines,
		AsOf: now.UTC().Truncate(time.Millisecond),
	}
	if a.hub != nil {
		counts := a.hub.counts()
		ov.ActiveNow, ov.InKlausNow = counts["online"], counts["hackgt"]
	}
	if a.acc.talk != nil { // the engine knows what's really running (a row can outlive a restart)
		live := a.liveRecords()
		ov.TalksLive = 0
		people := a.peopleFor(ctx, talkPeopleIDs(live))
		for _, rec := range live {
			if withTest || !(people[rec.A].test || people[rec.B].test) {
				ov.TalksLive++
			}
		}
	}
	a.ov[withTest] = ov
	return ov, nil
}

// ---------- people ----------

func talkPeopleIDs(recs map[string]*talkRecord) []int64 {
	var ids []int64
	for _, r := range recs {
		ids = append(ids, r.A, r.B)
	}
	return ids
}

// peopleFor: first name, bean, test flag and source per account (cached a minute).
func (a *adminAPI) peopleFor(ctx context.Context, ids []int64) map[int64]adminPersonRow {
	now := a.now()
	out := map[int64]adminPersonRow{}
	var missing []int64
	seen := map[int64]bool{}
	a.peopleMu.Lock()
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if e, ok := a.people[id]; ok && now.Before(e.exp) {
			out[id] = e.row
		} else {
			missing = append(missing, id)
		}
	}
	a.peopleMu.Unlock()
	if len(missing) == 0 {
		return out
	}
	rows, err := a.store.adminPeople(ctx, a.acc.tenant, missing)
	if err != nil {
		log.Printf("admin: people: %v", err)
		return out
	}
	a.peopleMu.Lock()
	if len(a.people) > 20000 {
		clear(a.people)
	}
	for _, id := range missing {
		row := rows[id] // someone deleted since: an empty row
		a.people[id] = adminPeopleEntry{row: row, exp: now.Add(time.Minute)}
		out[id] = row
	}
	a.peopleMu.Unlock()
	return out
}

func adminPersonOf(id int64, p adminPersonRow) adminPerson {
	out := adminPerson{ID: id, FirstName: p.first, Bean: p.look}
	if p.muse {
		s := "muse"
		out.Source = &s
	}
	return out
}

// ---------- talks ----------

// liveRecords: copies of the talks the engine is running (or holding for approvals).
func (a *adminAPI) liveRecords() map[string]*talkRecord {
	t := a.acc.talk
	if t == nil {
		return nil
	}
	t.mu.Lock()
	runs := make([]*talkRun, 0, len(t.live))
	for _, r := range t.live {
		runs = append(runs, r)
	}
	t.mu.Unlock()
	out := make(map[string]*talkRecord, len(runs))
	for _, r := range runs {
		r.mu.Lock()
		rec := r.rec.copy()
		r.mu.Unlock()
		if rec.Tenant == a.acc.tenant {
			out[rec.ID] = rec
		}
	}
	return out
}

func adminTime(t time.Time) time.Time { return t.UTC().Truncate(time.Millisecond) }

func adminAt(rec *talkRecord, ms float64) time.Time {
	return adminTime(rec.Started.Add(time.Duration(ms * float64(time.Millisecond))))
}

func ptr[T any](v T) *T { return &v }

func adminFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

// adminScoresOf maps jev's checkpoint-2 scores onto the contract (depth is jev's small_talk).
func adminScoresOf(m map[string]float64) *adminScores {
	if len(m) == 0 {
		return nil
	}
	return &adminScores{ValueA: m["value_a"], ValueB: m["value_b"], Soon: m["soon"], TalkAgain: m["talk_again"], Depth: m["small_talk"]}
}

func (s *adminScores) overall() float64 {
	mean := (s.ValueA + s.ValueB + s.Soon + s.TalkAgain + s.Depth) / 5
	return math.Round(math.Max(0, math.Min(100, mean/5*100))*10) / 10 // jev scores are 0-5
}

func verdictScores(v map[string]any) map[string]float64 {
	raw, ok := v["scores"].(map[string]any)
	if !ok {
		if m, ok := v["scores"].(map[string]float64); ok {
			return m
		}
		return nil
	}
	out := map[string]float64{}
	for k, x := range raw {
		if f, ok := adminFloat(x); ok {
			out[k] = f
		}
	}
	return out
}

func (a *adminAPI) status(rec *talkRecord, running bool) string {
	age := a.now().Sub(rec.Started)
	switch rec.State {
	case "live":
		if running {
			return "live"
		}
		// the run is gone (a restart): nobody will finish it
		if (a.acc.talk != nil && age > 15*time.Second) || age > 5*time.Minute {
			return "abandoned"
		}
		return "live"
	case "awaiting":
		if !running && age > 30*time.Minute {
			return "abandoned"
		}
		return "live"
	case "error":
		return "abandoned"
	}
	return "done"
}

// stoppedAt: where the talk ended up.
func stoppedAt(rec *talkRecord) *string {
	why, _ := rec.Verdict["why"].(string)
	switch {
	case rec.State == "live":
		return nil
	case rec.State == "error":
		return ptr("error")
	case why == "judge unavailable":
		if rec.Timings["end"] >= 175000 { // the 3-minute cap on a talk ran out
			return ptr("cap")
		}
		return ptr("error")
	case why == "nothing fired" || why == "red flag":
		return ptr("checkpoint1")
	case why == "checkpoint 2" || talkMatched(rec.State):
		return ptr("checkpoint2")
	}
	return nil
}

func (a *adminAPI) summary(rec *talkRecord, running bool, people map[int64]adminPersonRow) adminTalkSummary {
	s := adminTalkSummary{
		ID: rec.ID, Status: a.status(rec, running), StartedAt: adminTime(rec.Started),
		A: adminPersonOf(rec.A, people[rec.A]), B: adminPersonOf(rec.B, people[rec.B]),
		StoppedAt: stoppedAt(rec), Revealed: rec.State == "revealed", ConfigVersion: rec.ConfigVersion,
	}
	if rec.Ended != nil {
		s.EndedAt = ptr(adminTime(*rec.Ended))
	}
	s.Turns = len(rec.Transcript) // every bubble so far
	for _, l := range rec.Transcript {
		if talkLineWithheld(l) {
			s.Withheld++
		}
	}
	switch {
	case talkMatched(rec.State):
		s.Match = ptr(true)
	case rec.State == "no_match":
		s.Match = ptr(false)
	}
	if reason, _ := rec.Verdict["reason"].(string); reason != "" && rec.State != "live" {
		s.Reason = &reason
	}
	if sc := adminScoresOf(verdictScores(rec.Verdict)); sc != nil {
		s.Scores = sc
		s.Overall = ptr(sc.overall())
	}
	pair := func(get func(side string) (bool, bool)) adminBoolPair {
		var p adminBoolPair
		if v, ok := get("a"); ok {
			p.A = ptr(v)
		}
		if v, ok := get("b"); ok {
			p.B = ptr(v)
		}
		return p
	}
	s.Approvals = pair(func(side string) (bool, bool) {
		v, ok := rec.Approvals[side]
		return v == "approve", ok
	})
	s.WorthIt = pair(func(side string) (bool, bool) {
		v, ok := rec.Feedback[side]
		return v, ok
	})
	return s
}

// adminWithheldReason explains a line the guard trimmed, without showing what it trimmed.
func adminWithheldReason(l talkLine) *string {
	if l.Dropped == 0 {
		return nil
	}
	unsafe, ungrounded := 0, 0
	for _, d := range l.DroppedText {
		if strings.TrimSpace(strings.ReplaceAll(d, "[removed]", "")) == "" {
			unsafe++
		} else {
			ungrounded++
		}
	}
	capped := max(0, l.Dropped-len(l.DroppedText))
	var parts []string
	if ungrounded > 0 {
		parts = append(parts, fmt.Sprintf("%d sentence(s) not supported by this agent's own brief or notes", ungrounded))
	}
	if unsafe > 0 {
		parts = append(parts, fmt.Sprintf("%d sentence(s) that were only contact details or secrets", unsafe))
	}
	if capped > 0 {
		parts = append(parts, fmt.Sprintf("%d sentence(s) past the answer length cap", capped))
	}
	s := "guard withheld " + strings.Join(parts, "; ")
	if l.NotInMemory && ungrounded+unsafe > 0 && l.Kind == "answer" {
		s += "; the kind not-in-memory line may have been said instead"
	}
	return &s
}

func adminLineOf(rec *talkRecord, l talkLine) adminLine {
	kind := l.Kind
	if kind == "greet" {
		kind = "greeting"
	}
	out := adminLine{At: adminAt(rec, l.AtMS), From: l.Side, Kind: kind, Text: talkScrub(l.Text), Cites: []string{},
		Withheld: talkLineWithheld(l), WithheldReason: adminWithheldReason(l)}
	if l.QID != "" {
		out.QuestionID = ptr(l.QID)
	}
	for _, c := range l.Cites { // brief field names and note numbers; scrubbed and short anyway
		if c = talkScrub(c); c != "" && len(out.Cites) < 8 {
			if r := []rune(c); len(r) > 40 {
				c = string(r[:40])
			}
			out.Cites = append(out.Cites, c)
		}
	}
	return out
}

// adminHotTopic keeps what two briefs share; a memory-index hit keeps only whose notes matched.
func adminHotTopic(s string) string {
	if i := strings.Index(s, "'s notes:"); i >= 0 {
		return strings.TrimSpace(s[:i+len("'s notes")]) + " (a match in their memory)"
	}
	return talkScrub(s)
}

func (a *adminAPI) detail(rec *talkRecord, running bool, people map[int64]adminPersonRow) adminTalkDetail {
	d := adminTalkDetail{adminTalkSummary: a.summary(rec, running, people), Lines: []adminLine{}, Checkpoints: []adminCheckpoint{},
		HotTopics: []string{}, Icebreaker: rec.Icebreaker}
	for _, l := range rec.Transcript {
		d.Lines = append(d.Lines, adminLineOf(rec, l))
	}
	for _, h := range rec.HotTopics {
		d.HotTopics = append(d.HotTopics, adminHotTopic(h))
	}
	why, _ := rec.Verdict["why"].(string)
	at := func(k string) *time.Time {
		if v, ok := rec.Timings[k]; ok {
			return ptr(adminAt(rec, v))
		}
		return nil
	}
	for _, c := range rec.Jev {
		switch c.What {
		case "checkpoint1":
			cp := adminCheckpoint{Name: "checkpoint1", At: at("checkpoint1"), Gates: map[string]float64{}}
			for k, v := range rec.Gates {
				cp.Gates[k] = v
			}
			if len(cp.Gates) == 0 {
				for k, ans := range c.Answers {
					if g, ok := strings.CutPrefix(k, "gate_"); ok && ans.Noul != nil {
						cp.Gates[g] = *ans.Noul
					}
				}
			}
			cp.Passed = c.Err == "" && why != "nothing fired" && why != "red flag" && why != "judge unavailable"
			d.Checkpoints = append(d.Checkpoints, cp)
		case "checkpoint2":
			cp := adminCheckpoint{Name: "checkpoint2", At: at("checkpoint2"), Gates: map[string]float64{}, Passed: c.Err == "" && rec.Fired}
			scores := map[string]float64{}
			for k, ans := range c.Answers {
				if s, ok := strings.CutPrefix(k, "score_"); ok && ans.Score != nil {
					scores[s] = *ans.Score
				}
			}
			cp.Scores = adminScoresOf(scores)
			if c.Err == "" {
				cp.Choices = map[string]adminChoice{}
				for _, k := range []string{"reason", "opener"} {
					if ans, ok := c.Answers[k]; ok {
						cp.Choices[k] = adminChoice{Choice: ans.Choice, Confidence: ans.Confidence}
					}
				}
			}
			d.Checkpoints = append(d.Checkpoints, cp)
		}
	}
	ms := func(k string) *int {
		if v, ok := rec.Timings[k]; ok {
			return ptr(int(math.Round(v)))
		}
		return nil
	}
	d.TimingsMS = adminTimings{FirstBubble: ms("first_bubble"), Checkpoint1: ms("checkpoint1"), Verdict: ms("verdict"), Reveal: ms("revealed")}
	return d
}

func adminCursor(started time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(started.UnixNano(), 10) + "|" + id))
}

func parseAdminCursor(s string) (time.Time, string, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, "", false
	}
	ns, id, ok := strings.Cut(string(b), "|")
	n, err := strconv.ParseInt(ns, 10, 64)
	if !ok || err != nil || !strings.HasPrefix(id, "tk_") || len(id) > 64 {
		return time.Time{}, "", false
	}
	return time.Unix(0, n).UTC(), id, true
}

// adminSearchable: the text a search may match, all of it already safe to show (first names,
// hot topics as shown, the icebreaker, what the agents said). Never withheld text or memory.
func adminSearchable(rec *talkRecord, s adminTalkSummary) string {
	var b strings.Builder
	b.WriteString(s.A.FirstName + "\n" + s.B.FirstName + "\n")
	for _, h := range rec.HotTopics {
		b.WriteString(adminHotTopic(h) + "\n")
	}
	if rec.Icebreaker != nil {
		b.WriteString(talkScrub(rec.Icebreaker.Line) + "\n" + talkScrub(rec.Icebreaker.Question) + "\n")
	}
	for _, l := range rec.Transcript {
		b.WriteString(talkScrub(l.Text) + "\n")
	}
	return strings.ToLower(b.String())
}

// handleTalks: newest first. Filters the store can't answer exactly (the status as the engine
// sees it, the search) are applied while scanning, so a page can be short when the scan budget
// runs out; "next" is then where to carry on. Keep following next until it is null.
func (a *adminAPI) handleTalks(w http.ResponseWriter, r *http.Request, _ adminCaller) {
	qs := r.URL.Query()
	status := qs.Get("status")
	q := adminTalkQuery{includeTest: includeTest(r)}
	switch status {
	case "", "all":
		status, q.states = "all", "all"
	case "live":
		q.states = "open"
	case "done": // includes abandoned
		q.states = "all"
	case "abandoned":
		q.states = "open_error"
	default:
		adminJSON(w, http.StatusBadRequest, map[string]string{"error": "status is live, done, abandoned or all"})
		return
	}
	switch qs.Get("match") {
	case "":
	case "true":
		q.match = ptr(true)
	case "false":
		q.match = ptr(false)
	default:
		adminJSON(w, http.StatusBadRequest, map[string]string{"error": "match is true or false"})
		return
	}
	limit := 50
	if v := qs.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			adminJSON(w, http.StatusBadRequest, map[string]string{"error": "limit is 1-200"})
			return
		}
		limit = min(n, 200)
	}
	if c := qs.Get("cursor"); c != "" {
		t, id, ok := parseAdminCursor(c)
		if !ok {
			adminJSON(w, http.StatusBadRequest, map[string]string{"error": "bad cursor"})
			return
		}
		q.before, q.beforeID = &t, id
	}
	search := strings.ToLower(strings.TrimSpace(qs.Get("q")))
	if len(search) > 100 {
		adminJSON(w, http.StatusBadRequest, map[string]string{"error": "q is at most 100 characters"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	keep := func(s adminTalkSummary) bool {
		switch status {
		case "live":
			return s.Status == "live"
		case "done":
			return s.Status != "live"
		case "abandoned":
			return s.Status == "abandoned"
		}
		return true
	}
	live := a.liveRecords()
	items := []adminTalkSummary{}
	var next *string
	var lastKept *adminTalkRow
	scanned := 0
	q.limit = a.scanBatch
	if status == "all" && search == "" {
		q.limit = limit + 1 // every row is an item: one more says whether there is a next page
	}
scan:
	for {
		rows, err := a.store.adminTalks(ctx, a.acc.tenant, q)
		if err != nil {
			log.Printf("admin: talks: %v", err)
			adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
		var ids []int64
		for _, row := range rows {
			ids = append(ids, row.rec.A, row.rec.B)
		}
		people := a.peopleFor(ctx, ids)
		for i := range rows {
			row := &rows[i]
			scanned++
			rec, running := row.rec, false
			if lr, ok := live[rec.ID]; ok {
				rec, running = lr, true
			}
			s := a.summary(rec, running, people)
			if !keep(s) || (search != "" && !strings.Contains(adminSearchable(rec, s), search)) {
				continue
			}
			if len(items) == limit { // one match past the page: there is a next page
				next = ptr(adminCursor(lastKept.started, lastKept.rec.ID))
				break scan
			}
			items = append(items, s)
			lastKept = row
		}
		if len(rows) < q.limit {
			break // nothing older
		}
		last := rows[len(rows)-1]
		if scanned >= a.scanMax { // budget spent: carry on from here next time
			next = ptr(adminCursor(last.started, last.rec.ID))
			break
		}
		q.before, q.beforeID = &last.started, last.rec.ID
	}
	adminJSON(w, http.StatusOK, map[string]any{"items": items, "next": next})
}

func (a *adminAPI) handleTalk(w http.ResponseWriter, r *http.Request, _ adminCaller) {
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/talks/")
	if !strings.HasPrefix(id, "tk_") || len(id) > 64 || strings.Contains(id, "/") || a.ts == nil {
		adminJSON(w, http.StatusNotFound, map[string]string{"error": "no such talk"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	rec, running := a.liveRecords()[id], true
	if rec == nil {
		running = false
		var err error
		if rec, err = a.ts.talkGet(ctx, a.acc.tenant, id); errors.Is(err, errNoTalk) {
			adminJSON(w, http.StatusNotFound, map[string]string{"error": "no such talk"})
			return
		} else if err != nil {
			log.Printf("admin: talk %s: %v", id, err)
			adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
	}
	people := a.peopleFor(ctx, []int64{rec.A, rec.B})
	if !includeTest(r) && (people[rec.A].test || people[rec.B].test) {
		adminJSON(w, http.StatusNotFound, map[string]string{"error": "no such talk (a test account's: add ?include_test=true)"})
		return
	}
	adminJSON(w, http.StatusOK, a.detail(rec, running, people))
}

// ---------- the stream ----------

func (a *adminAPI) handleStream(w http.ResponseWriter, r *http.Request, c adminCaller) {
	withTest := includeTest(r)
	sub, err := a.bc.subscribe(c.uid, withTest)
	if err != nil {
		w.Header().Set("Retry-After", "10")
		adminJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
		return
	}
	defer a.bc.unsubscribe(sub)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	write := func(p []byte) bool {
		rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := w.Write(p); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	if !write([]byte("retry: 3000\n\n")) {
		return
	}
	// what's true right now, then changes as they happen
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	if ov, err := a.overview(ctx, withTest); err == nil {
		write(sseFrame("overview", ov))
	}
	live := a.liveRecords()
	people := a.peopleFor(ctx, talkPeopleIDs(live))
	cancel()
	for _, rec := range live {
		if withTest || !(people[rec.A].test || people[rec.B].test) {
			write(sseFrame("talk", a.summary(rec, true, people)))
		}
	}
	keep := time.NewTicker(a.bc.keepalive)
	defer keep.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case frame, ok := <-sub.ch:
			if !ok { // fell too far behind: dropped (the browser reconnects)
				return
			}
			if !write(frame) {
				return
			}
		case <-keep.C:
			if !write([]byte(": keepalive\n\n")) {
				return
			}
		}
	}
}

func sseFrame(event string, v any) []byte {
	b, _ := json.Marshal(v) // one line: encoding/json never emits a raw newline
	return []byte("event: " + event + "\ndata: " + string(b) + "\n\n")
}

type adminSub struct {
	ch       chan []byte
	uid      int64
	withTest bool
}

type adminSeen struct {
	sig   string
	lines int
}

// adminBroadcaster: one poller, many viewers. publish never blocks: a viewer whose buffer is
// full is dropped.
type adminBroadcaster struct {
	a         *adminAPI
	livePoll  time.Duration
	dbPoll    time.Duration
	ovEvery   time.Duration
	keepalive time.Duration
	buf       int
	maxPerUID int
	maxTotal  int

	mu     sync.Mutex
	subs   map[*adminSub]struct{}
	perUID map[int64]int
	once   sync.Once
	stop   chan struct{}
	// watchedSince: when the first of the current viewers came (the DB poll starts there)
	watchedSince time.Time

	// loop goroutine only
	seen     map[string]adminSeen
	wasLive  map[string]bool
	dbPrimed bool
	lastDB   time.Time
}

func newAdminBroadcaster(a *adminAPI) *adminBroadcaster {
	return &adminBroadcaster{a: a, livePoll: 250 * time.Millisecond, dbPoll: 2 * time.Second, ovEvery: 10 * time.Second,
		keepalive: 15 * time.Second, buf: 256, maxPerUID: 4, maxTotal: 200,
		subs: map[*adminSub]struct{}{}, perUID: map[int64]int{}, stop: make(chan struct{}),
		seen: map[string]adminSeen{}, wasLive: map[string]bool{}}
}

func (b *adminBroadcaster) subscribe(uid int64, withTest bool) (*adminSub, error) {
	b.start()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.perUID[uid] >= b.maxPerUID || len(b.subs) >= b.maxTotal {
		return nil, errAdminBusy
	}
	if len(b.subs) == 0 {
		b.watchedSince = b.a.now()
	}
	s := &adminSub{ch: make(chan []byte, b.buf), uid: uid, withTest: withTest}
	b.subs[s] = struct{}{}
	b.perUID[uid]++
	return s, nil
}

// start runs the poller (once); the live table is followed even with nobody watching, so a
// viewer's first events are only what's new.
func (b *adminBroadcaster) start() { b.once.Do(func() { go b.loop() }) }

func (b *adminBroadcaster) removeLocked(s *adminSub) {
	if _, ok := b.subs[s]; !ok {
		return
	}
	delete(b.subs, s)
	if b.perUID[s.uid]--; b.perUID[s.uid] <= 0 {
		delete(b.perUID, s.uid)
	}
	close(s.ch)
}

func (b *adminBroadcaster) unsubscribe(s *adminSub) {
	b.mu.Lock()
	b.removeLocked(s)
	b.mu.Unlock()
}

func (b *adminBroadcaster) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

// publish queues frame for every viewer want accepts; never blocks.
func (b *adminBroadcaster) publish(frame []byte, want func(*adminSub) bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs {
		if want != nil && !want(s) {
			continue
		}
		select {
		case s.ch <- frame:
		default:
			b.removeLocked(s) // too slow: let it reconnect and catch up from /talks
		}
	}
}

func (b *adminBroadcaster) close() {
	b.mu.Lock()
	select {
	case <-b.stop:
	default:
		close(b.stop)
	}
	for s := range b.subs {
		b.removeLocked(s)
	}
	b.mu.Unlock()
}

func (b *adminBroadcaster) loop() {
	live := time.NewTicker(b.livePoll)
	db := time.NewTicker(b.dbPoll)
	ov := time.NewTicker(b.ovEvery)
	defer live.Stop()
	defer db.Stop()
	defer ov.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-live.C:
			b.pollLive()
		case <-db.C:
			b.pollDB()
		case <-ov.C:
			b.pushOverview()
		}
	}
}

func talkSig(r *talkRecord) string {
	return fmt.Sprintf("%s|%d|%v|%v|%v|%d|%d|%v|%v|%d", r.State, len(r.Transcript), r.Approvals, r.Feedback, r.Fired,
		len(r.Timings), len(r.Jev), r.Icebreaker != nil, r.Ended != nil, len(r.HotTopics))
}

// pollLive diffs the engine's live table: new lines, changed talks, and talks that just left it.
func (b *adminBroadcaster) pollLive() {
	t := b.a.acc.talk
	if t == nil {
		return
	}
	t.mu.Lock()
	runs := make([]*talkRun, 0, len(t.live))
	for _, r := range t.live {
		runs = append(runs, r)
	}
	t.mu.Unlock()
	now := map[string]bool{}
	for _, r := range runs {
		r.mu.Lock()
		if r.rec.Tenant != b.a.acc.tenant {
			r.mu.Unlock()
			continue
		}
		id, sig := r.rec.ID, talkSig(r.rec)
		now[id] = true
		if prev, ok := b.seen[id]; ok && prev.sig == sig {
			r.mu.Unlock()
			continue
		}
		rec := r.rec.copy()
		r.mu.Unlock()
		b.update(rec, true)
	}
	for id := range b.wasLive {
		if now[id] {
			continue
		}
		// it left the live table: its last lines and final state are in the store
		if b.count() == 0 {
			delete(b.seen, id)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		rec, err := b.a.ts.talkGet(ctx, b.a.acc.tenant, id)
		cancel()
		if err == nil {
			b.update(rec, false)
		}
	}
	b.wasLive = now
}

// pollDB: changes to talks the engine isn't running (feedback, approvals after a restart).
func (b *adminBroadcaster) pollDB() {
	if b.count() == 0 {
		b.dbPrimed = false
		return
	}
	now := b.a.now()
	since := b.lastDB.Add(-2 * time.Second) // overlap: clocks, and rows saved mid-poll
	if !b.dbPrimed {
		b.mu.Lock()
		since = b.watchedSince.Add(-2 * time.Second)
		b.mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	recs, err := b.a.store.adminTalksChanged(ctx, b.a.acc.tenant, since)
	cancel()
	if err != nil {
		log.Printf("admin: stream: %v", err)
		return
	}
	b.lastDB = now
	for _, rec := range recs {
		if b.wasLive[rec.ID] {
			continue
		}
		prev, ok := b.seen[rec.ID]
		if ok && prev.sig == talkSig(rec) {
			continue
		}
		if !ok { // not followed line by line: only its summary is news
			b.seen[rec.ID] = adminSeen{lines: len(rec.Transcript)}
		}
		b.update(rec, false)
	}
	b.dbPrimed = true
	if len(b.seen) > 50000 {
		clear(b.seen)
	}
}

// update publishes rec's new lines and its summary, if anything changed since last seen.
func (b *adminBroadcaster) update(rec *talkRecord, running bool) {
	sig := talkSig(rec)
	prev, ok := b.seen[rec.ID]
	if ok && prev.sig == sig {
		return
	}
	b.seen[rec.ID] = adminSeen{sig: sig, lines: len(rec.Transcript)}
	if b.count() == 0 { // tracked all the same, so a viewer who comes later gets only what's new
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	people := b.a.peopleFor(ctx, []int64{rec.A, rec.B})
	cancel()
	want := func(s *adminSub) bool { return true }
	if people[rec.A].test || people[rec.B].test {
		want = func(s *adminSub) bool { return s.withTest }
	}
	for _, l := range rec.Transcript[min(prev.lines, len(rec.Transcript)):] {
		b.publish(sseFrame("line", map[string]any{"talk_id": rec.ID, "line": adminLineOf(rec, l)}), want)
	}
	b.publish(sseFrame("talk", b.a.summary(rec, running, people)), want)
}

func (b *adminBroadcaster) pushOverview() {
	var with, without bool
	b.mu.Lock()
	for s := range b.subs {
		if s.withTest {
			with = true
		} else {
			without = true
		}
	}
	b.mu.Unlock()
	for _, flag := range []bool{false, true} {
		if (flag && !with) || (!flag && !without) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		ov, err := b.a.overview(ctx, flag)
		cancel()
		if err != nil {
			log.Printf("admin: stream overview: %v", err)
			continue
		}
		b.publish(sseFrame("overview", ov), func(s *adminSub) bool { return s.withTest == flag })
	}
}
