package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// ---------- the contract, mirrored independently of admin.go's types ----------

type cPerson struct {
	ID        int64   `json:"id"`
	FirstName string  `json:"first_name"`
	Bean      string  `json:"bean"`
	Source    *string `json:"source"`
}

type cScores struct {
	ValueA    float64 `json:"value_a"`
	ValueB    float64 `json:"value_b"`
	Soon      float64 `json:"soon"`
	TalkAgain float64 `json:"talk_again"`
	Depth     float64 `json:"depth"`
}

type cPair struct {
	A *bool `json:"a"`
	B *bool `json:"b"`
}

type cSummary struct {
	ID            string     `json:"id"`
	Status        string     `json:"status"`
	StartedAt     time.Time  `json:"started_at"`
	EndedAt       *time.Time `json:"ended_at"`
	A             cPerson    `json:"a"`
	B             cPerson    `json:"b"`
	Turns         int        `json:"turns"`
	StoppedAt     *string    `json:"stopped_at"`
	Match         *bool      `json:"match"`
	Reason        *string    `json:"reason"`
	Overall       *float64   `json:"overall"`
	Scores        *cScores   `json:"scores"`
	Approvals     cPair      `json:"approvals"`
	Revealed      bool       `json:"revealed"`
	WorthIt       cPair      `json:"worth_it"`
	Withheld      int        `json:"withheld"`
	ConfigVersion string     `json:"config_version"`
}

type cLine struct {
	At             time.Time `json:"at"`
	From           string    `json:"from"`
	Kind           string    `json:"kind"`
	Text           string    `json:"text"`
	QuestionID     *string   `json:"question_id"`
	Cites          []string  `json:"cites"`
	Withheld       bool      `json:"withheld"`
	WithheldReason *string   `json:"withheld_reason"`
}

type cChoice struct {
	Choice     string  `json:"choice"`
	Confidence float64 `json:"confidence"`
}

type cCheckpoint struct {
	Name    string             `json:"name"`
	At      *time.Time         `json:"at"`
	Gates   map[string]float64 `json:"gates"`
	Scores  *cScores           `json:"scores"`
	Choices map[string]cChoice `json:"choices"`
	Passed  bool               `json:"passed"`
}

type cDetail struct {
	cSummary
	Lines       []cLine       `json:"lines"`
	Checkpoints []cCheckpoint `json:"checkpoints"`
	HotTopics   []string      `json:"hot_topics"`
	Icebreaker  *struct {
		Line     string `json:"line"`
		Question string `json:"question"`
	} `json:"icebreaker"`
	TimingsMS struct {
		FirstBubble *int `json:"first_bubble"`
		Checkpoint1 *int `json:"checkpoint1"`
		Verdict     *int `json:"verdict"`
		Reveal      *int `json:"reveal"`
	} `json:"timings_ms"`
}

type cList struct {
	Items []cSummary `json:"items"`
	Next  *string    `json:"next"`
}

type cOverview struct {
	UsersTotal         int       `json:"users_total"`
	UsersSignedInToday int       `json:"users_signed_in_today"`
	ActiveNow          int       `json:"active_now"`
	InKlausNow         int       `json:"in_klaus_now"`
	ActivityHoursTotal *float64  `json:"activity_hours_total"`
	MemoriesTotal      int       `json:"memories_total"`
	MuseConnected      int       `json:"muse_connected"`
	VoiceOnboarded     *int      `json:"voice_onboarded"`
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

var (
	cSummaryKeys = []string{"id", "status", "started_at", "ended_at", "a", "b", "turns", "stopped_at", "match", "reason", "overall",
		"scores", "approvals", "revealed", "worth_it", "withheld", "config_version"}
	cDetailExtra   = []string{"lines", "checkpoints", "hot_topics", "icebreaker", "timings_ms"}
	cPersonKeys    = []string{"id", "first_name", "bean", "source"}
	cLineKeys      = []string{"at", "from", "kind", "text", "question_id", "cites", "withheld", "withheld_reason"}
	cCheckKeys     = []string{"name", "at", "gates", "scores", "choices", "passed"}
	cTimingKeys    = []string{"first_bubble", "checkpoint1", "verdict", "reveal"}
	cOverviewKeys  = []string{"users_total", "users_signed_in_today", "active_now", "in_klaus_now", "activity_hours_total", "memories_total", "muse_connected", "voice_onboarded", "talks_total", "talks_live", "talks_today", "matches_total", "approvals_both", "reveals_total", "worth_it_yes", "worth_it_no", "withheld_lines_total", "as_of"}
	cStatuses      = map[string]bool{"live": true, "done": true, "abandoned": true}
	cStoppedAts    = map[string]bool{"checkpoint1": true, "checkpoint2": true, "cap": true, "error": true}
	cLineKinds     = map[string]bool{"greeting": true, "question": true, "answer": true, "close": true}
	emailLike      = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
	adminTestOrgin = "https://site.test"
)

// strictDecode: every field the server sends must be in the contract.
func strictDecode(t *testing.T, body string, v any) {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("contract mismatch: %v\n%s", err, body)
	}
}

// hasKeys: every contract key is present (nulls included), and nothing else.
func hasKeys(t *testing.T, what string, m map[string]any, keys []string) {
	t.Helper()
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
		if _, ok := m[k]; !ok {
			t.Errorf("%s: missing %q in %v", what, k, m)
		}
	}
	for k := range m {
		if !want[k] {
			t.Errorf("%s: extra key %q", what, k)
		}
	}
}

func checkSummaryKeys(t *testing.T, m map[string]any) {
	t.Helper()
	hasKeys(t, "talk", m, append(append([]string(nil), cSummaryKeys...), extraKeysIfDetail(m)...))
	for _, side := range []string{"a", "b"} {
		p, _ := m[side].(map[string]any)
		hasKeys(t, "person", p, cPersonKeys)
	}
	for _, k := range []string{"approvals", "worth_it"} {
		p, _ := m[k].(map[string]any)
		hasKeys(t, k, p, []string{"a", "b"})
	}
	if sc, ok := m["scores"].(map[string]any); ok {
		hasKeys(t, "scores", sc, []string{"value_a", "value_b", "soon", "talk_again", "depth"})
	}
	st, _ := m["status"].(string)
	if !cStatuses[st] {
		t.Errorf("status %q", st)
	}
	if s, ok := m["stopped_at"].(string); ok && !cStoppedAts[s] {
		t.Errorf("stopped_at %q", s)
	}
}

func extraKeysIfDetail(m map[string]any) []string {
	if _, ok := m["lines"]; ok {
		return cDetailExtra
	}
	return nil
}

// ---------- helpers ----------

type adminTestEnv struct {
	srv *httptest.Server
	api *adminAPI
	acc *accounts
}

func newAdminEnv(t *testing.T, acc *accounts, hub *Hub, tune func(*adminAPI)) *adminTestEnv {
	t.Helper()
	mux := http.NewServeMux()
	api := mountAdmin(mux, acc, hub)
	if api == nil {
		t.Fatal("admin not mounted")
	}
	if tune != nil {
		tune(api)
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		api.bc.close()
		srv.Close()
	})
	return &adminTestEnv{srv: srv, api: api, acc: acc}
}

func (e *adminTestEnv) cookie(uid int64) string {
	v, _ := e.acc.sess.issue(kindSession, uid, time.Hour)
	return sessionCookie + "=" + v
}

func (e *adminTestEnv) get(t *testing.T, path, cookie string) (int, string, http.Header) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+path, nil)
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b), res.Header
}

func (e *adminTestEnv) mustGet(t *testing.T, path, cookie string) string {
	t.Helper()
	code, body, _ := e.get(t, path, cookie)
	if code != http.StatusOK {
		t.Fatalf("GET %s: %d %s", path, code, body)
	}
	return body
}

func memAccounts() (*memStore, *accounts) {
	store := newMemStore()
	return store, &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
}

func signIn(t *testing.T, s Store, tenant, email, name, given string) int64 {
	t.Helper()
	a, _, err := s.SignIn(context.Background(), tenant, user{Sub: "g-" + email, Email: email, Name: name, Given: given})
	if err != nil {
		t.Fatal(err)
	}
	return a.ID
}

// sseEvent is one Server-Sent Event (or a comment, with event "comment").
type sseEvent struct {
	event string
	data  string
}

// readSSE streams events from an open response into a channel until it ends.
func readSSE(body io.Reader) <-chan sseEvent {
	out := make(chan sseEvent, 1024)
	go func() {
		defer close(out)
		sc := bufio.NewScanner(body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		var ev sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if ev.event != "" || ev.data != "" {
					out <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, ":"):
				out <- sseEvent{event: "comment", data: line}
			case strings.HasPrefix(line, "event: "):
				ev.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data += strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return out
}

func (e *adminTestEnv) stream(t *testing.T, cookie, query string) (<-chan sseEvent, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.srv.URL+"/api/admin/stream"+query, nil)
	req.Header.Set("Cookie", cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("stream: %d %s", res.StatusCode, b)
	}
	return readSSE(res.Body), func() { cancel(); res.Body.Close() }
}

// ---------- auth ----------

func TestAdminAuthByEmailAllowList(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", " Boss@Example.com , second@example.org")
	store, acc := memAccounts()
	boss := signIn(t, store, "hackgt13", "boss@EXAMPLE.com", "Boss Person", "Boss")
	other := signIn(t, store, "hackgt13", "someone@example.com", "Some One", "Some")
	elsewhere := signIn(t, store, "otherevent", "second@example.org", "Second Admin", "Second") // not a member here
	e := newAdminEnv(t, acc, newHub(), nil)
	paths := []string{"/api/admin/me", "/api/admin/overview", "/api/admin/talks", "/api/admin/talks/tk_x", "/api/admin/stream"}
	for _, p := range paths {
		if code, _, _ := e.get(t, p, ""); code != http.StatusUnauthorized {
			t.Errorf("%s signed out: %d", p, code)
		}
		if code, _, _ := e.get(t, p, sessionCookie+"=1.9999999999.forged"); code != http.StatusUnauthorized {
			t.Errorf("%s forged cookie: %d", p, code)
		}
		// a ticket (the game socket's token) is not a session
		tk, _ := acc.sess.issue(kindTicket, boss, time.Hour)
		if code, _, _ := e.get(t, p, sessionCookie+"="+tk); code != http.StatusUnauthorized {
			t.Errorf("%s ticket as cookie: %d", p, code)
		}
		if code, _, _ := e.get(t, p, e.cookie(other)); code != http.StatusForbidden {
			t.Errorf("%s non-admin: %d", p, code)
		}
		if code, _, _ := e.get(t, p, e.cookie(elsewhere)); code != http.StatusUnauthorized {
			t.Errorf("%s admin email but not in this tenant: %d", p, code)
		}
	}
	code, body, hdr := e.get(t, "/api/admin/me?email=someone@example.com", e.cookie(boss))
	if code != http.StatusOK || hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("me: %d %s %v", code, body, hdr)
	}
	var me struct {
		Admin  bool   `json:"admin"`
		Email  string `json:"email"`
		Tenant string `json:"tenant"`
	}
	strictDecode(t, body, &me)
	if !me.Admin || me.Email != "boss@example.com" || me.Tenant != "hackgt13" {
		t.Fatalf("me: %+v", me)
	}
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/api/admin/overview", nil)
	req.Header.Set("Cookie", e.cookie(boss))
	req.Header.Set("Origin", adminTestOrgin)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %v %v", res, err)
	}

	// no allow-list: nobody is an admin
	t.Setenv("ADMIN_EMAILS", "")
	e2 := newAdminEnv(t, acc, newHub(), nil)
	if code, _, _ := e2.get(t, "/api/admin/me", e2.cookie(boss)); code != http.StatusForbidden {
		t.Fatalf("empty ADMIN_EMAILS: %d", code)
	}
}

func TestAdminRateLimit(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "boss@example.com")
	store, acc := memAccounts()
	boss := signIn(t, store, "hackgt13", "boss@example.com", "Boss", "Boss")
	e := newAdminEnv(t, acc, nil, nil)
	limited := 0
	for i := 0; i < 80; i++ {
		code, _, hdr := e.get(t, "/api/admin/me", e.cookie(boss))
		if code == http.StatusTooManyRequests {
			limited++
			if hdr.Get("Retry-After") == "" {
				t.Fatal("429 without Retry-After")
			}
		}
	}
	if limited == 0 {
		t.Fatal("80 requests at once were never limited")
	}
}

// ---------- talks: list, detail, filters (a real fake talk run) ----------

func adminHarness(t *testing.T) (*talkHarness, *adminTestEnv) {
	t.Helper()
	t.Setenv("ADMIN_EMAILS", "carmody@example.com")
	h := newTalkHarness(t)
	e := newAdminEnv(t, h.acc, newHub(), nil)
	return h, e
}

func weakGates() map[string]float64 {
	return map[string]float64{"a_fixed_b": 0.1, "b_fixed_a": 0.1, "same_problem": 0.1, "team": 0.1, "going_through": 0.1, "rare": 0.1, "one_sided": 0.1, "busy": 0.05}
}

func TestAdminTalksContract(t *testing.T) {
	h, e := adminHarness(t)
	ctx := context.Background()
	admin := e.cookie(h.c)

	// a match both approve, with feedback
	matchID, _ := h.run(h.a, h.b)
	h.waitIcebreaker(matchID)
	if st, err := h.talk.decide(ctx, h.tenant, h.a, matchID, true); err != nil || st != "awaiting" {
		t.Fatalf("approve a: %s %v", st, err)
	}
	if st, err := h.talk.decide(ctx, h.tenant, h.b, matchID, true); err != nil || st != "revealed" {
		t.Fatalf("approve b: %s %v", st, err)
	}
	h.talk.feedback(ctx, h.tenant, h.a, matchID, true)
	h.talk.feedback(ctx, h.tenant, h.b, matchID, false)
	// a no-match
	h.jev.mu.Lock()
	h.jev.gates = weakGates()
	h.jev.mu.Unlock()
	noID, v := h.run(h.b, h.c)
	if v["match"] != false {
		t.Fatalf("expected no match: %v", v)
	}
	h.record(noID)

	body := e.mustGet(t, "/api/admin/talks", admin)
	var list cList
	strictDecode(t, body, &list)
	var raw struct{ Items []map[string]any }
	json.Unmarshal([]byte(body), &raw)
	for _, m := range raw.Items {
		checkSummaryKeys(t, m)
	}
	if len(list.Items) != 2 || list.Next != nil {
		t.Fatalf("list: %s", body)
	}
	if list.Items[0].ID != noID || list.Items[1].ID != matchID {
		t.Fatalf("newest first: %s %s", list.Items[0].ID, list.Items[1].ID)
	}
	m, n := list.Items[1], list.Items[0]
	if m.Status != "done" || m.Match == nil || !*m.Match || !m.Revealed || m.StoppedAt == nil || *m.StoppedAt != "checkpoint2" ||
		m.Reason == nil || *m.Reason != "b_fixed_a" || m.Scores == nil || m.Overall == nil || m.EndedAt == nil ||
		m.Approvals.A == nil || !*m.Approvals.A || m.Approvals.B == nil || !*m.Approvals.B ||
		m.WorthIt.A == nil || !*m.WorthIt.A || m.WorthIt.B == nil || *m.WorthIt.B || m.Turns < 3 || m.ConfigVersion == "" {
		t.Fatalf("match summary: %+v", m)
	}
	if m.Scores.Depth != 4 || m.Scores.ValueA != 4 || *m.Overall != 84 { // (4+4+5+4+4)/5 = 4.2 of 5
		t.Fatalf("scores: %+v overall %v", m.Scores, *m.Overall)
	}
	if m.A.ID != h.a || m.A.FirstName != "Zephyrine" || m.B.FirstName != "Octavian" || m.A.Bean == "" || m.A.Source != nil {
		t.Fatalf("people: %+v %+v", m.A, m.B)
	}
	if n.Match == nil || *n.Match || n.StoppedAt == nil || *n.StoppedAt != "checkpoint1" || n.Scores != nil || n.Overall != nil ||
		n.Approvals.A != nil || n.WorthIt.B != nil || n.Revealed {
		t.Fatalf("no-match summary: %+v", n)
	}

	// detail
	body = e.mustGet(t, "/api/admin/talks/"+matchID, admin)
	var d cDetail
	strictDecode(t, body, &d)
	var rawD map[string]any
	json.Unmarshal([]byte(body), &rawD)
	checkSummaryKeys(t, rawD)
	for _, l := range rawD["lines"].([]any) {
		hasKeys(t, "line", l.(map[string]any), cLineKeys)
	}
	for _, c := range rawD["checkpoints"].([]any) {
		hasKeys(t, "checkpoint", c.(map[string]any), cCheckKeys)
	}
	hasKeys(t, "timings_ms", rawD["timings_ms"].(map[string]any), cTimingKeys)
	if d.ID != matchID || len(d.Lines) < 4 || d.Lines[0].Kind != "greeting" || d.Icebreaker == nil || d.HotTopics == nil {
		t.Fatalf("detail: %s", body)
	}
	for i, l := range d.Lines {
		if !cLineKinds[l.Kind] || (l.From != "a" && l.From != "b") || l.Cites == nil || l.At.Before(d.StartedAt) {
			t.Fatalf("line %d: %+v", i, l)
		}
		if l.Kind == "question" && l.QuestionID == nil {
			t.Fatalf("question without id: %+v", l)
		}
	}
	if len(d.Checkpoints) != 2 || d.Checkpoints[0].Name != "checkpoint1" || !d.Checkpoints[0].Passed || len(d.Checkpoints[0].Gates) == 0 ||
		d.Checkpoints[1].Name != "checkpoint2" || !d.Checkpoints[1].Passed || d.Checkpoints[1].Scores == nil ||
		d.Checkpoints[1].Choices["reason"].Choice != "b_fixed_a" || d.Checkpoints[1].Choices["opener"].Choice != "ask_fix" ||
		d.Checkpoints[0].At == nil {
		t.Fatalf("checkpoints: %+v", d.Checkpoints)
	}
	if d.TimingsMS.FirstBubble == nil || d.TimingsMS.Checkpoint1 == nil || d.TimingsMS.Verdict == nil || d.TimingsMS.Reveal == nil {
		t.Fatalf("timings: %+v", d.TimingsMS)
	}
	body = e.mustGet(t, "/api/admin/talks/"+noID, admin)
	strictDecode(t, body, &d)
	if len(d.Checkpoints) != 1 || d.Checkpoints[0].Passed || d.Checkpoints[0].Choices != nil || d.TimingsMS.Reveal != nil || d.Icebreaker != nil {
		t.Fatalf("no-match detail: %s", body)
	}
	if code, _, _ := e.get(t, "/api/admin/talks/tk_nope", admin); code != http.StatusNotFound {
		t.Fatalf("unknown talk: %d", code)
	}

	// filters
	for q, want := range map[string]int{"?match=true": 1, "?match=false": 1, "?status=live": 0, "?status=done": 2, "?status=all&match=true": 1} {
		var l cList
		strictDecode(t, e.mustGet(t, "/api/admin/talks"+q, admin), &l)
		if len(l.Items) != want {
			t.Errorf("%s: %d items, want %d", q, len(l.Items), want)
		}
	}
	for _, q := range []string{"?status=bogus", "?match=maybe", "?limit=0", "?limit=x", "?cursor=@@@", "?cursor=" + adminCursor(time.Now(), "notatalk")} {
		if code, _, _ := e.get(t, "/api/admin/talks"+q, admin); code != http.StatusBadRequest {
			t.Errorf("%s: %d", q, code)
		}
	}

	// overview from the same data
	body = e.mustGet(t, "/api/admin/overview", admin)
	var ov cOverview
	strictDecode(t, body, &ov)
	var rawO map[string]any
	json.Unmarshal([]byte(body), &rawO)
	hasKeys(t, "overview", rawO, cOverviewKeys)
	if ov.UsersTotal != 3 || ov.TalksTotal != 2 || ov.TalksToday != 2 || ov.MatchesTotal != 1 || ov.ApprovalsBoth != 1 || ov.RevealsTotal != 1 ||
		ov.WorthItYes != 1 || ov.WorthItNo != 1 || ov.TalksLive != 0 || ov.ActivityHoursTotal == nil || *ov.ActivityHoursTotal != 0 || ov.VoiceOnboarded == nil || *ov.VoiceOnboarded != 0 || ov.AsOf.IsZero() {
		t.Fatalf("overview: %s", body)
	}
}

// ---------- pagination ----------

func TestAdminTalksPagination(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "boss@example.com")
	store, acc := memAccounts()
	ctx := context.Background()
	boss := signIn(t, store, "hackgt13", "boss@example.com", "Boss", "Boss")
	var ids []int64
	for i := 0; i < 7; i++ {
		ids = append(ids, signIn(t, store, "hackgt13", fmt.Sprintf("p%d@example.com", i), fmt.Sprintf("Person%d Last", i), ""))
	}
	base := time.Now().Add(-time.Hour).UTC()
	var want []string
	k := 0
	for i := 0; i < len(ids) && k < 13; i++ {
		for j := i + 1; j < len(ids) && k < 13; j++ {
			rec := &talkRecord{ID: fmt.Sprintf("tk_%03d", k), Tenant: "hackgt13", A: ids[i], B: ids[j], ConfigVersion: "v1",
				State: []string{"no_match", "revealed", "expired"}[k%3], Started: base.Add(time.Duration(k/2) * time.Minute), Timings: map[string]float64{}}
			if err := store.talkCreate(ctx, rec); err != nil { // pairs of talks share a start time: the id breaks the tie
				t.Fatal(err)
			}
			want = append(want, rec.ID)
			k++
		}
	}
	sort.Slice(want, func(i, j int) bool { return want[i] > want[j] }) // same order as (started desc, id desc) here
	e := newAdminEnv(t, acc, nil, nil)
	var got []string
	cursor := ""
	pages := 0
	for {
		var l cList
		q := "/api/admin/talks?limit=5"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		strictDecode(t, e.mustGet(t, q, e.cookie(boss)), &l)
		pages++
		for _, it := range l.Items {
			got = append(got, it.ID)
			if it.A.FirstName == "" || strings.Contains(it.A.FirstName, " ") {
				t.Fatalf("first name: %+v", it.A)
			}
		}
		if l.Next == nil {
			break
		}
		if len(l.Items) != 5 || pages > 5 {
			t.Fatalf("page %d: %d items", pages, len(l.Items))
		}
		cursor = *l.Next
	}
	if pages != 3 || strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("pages %d\n got %v\nwant %v", pages, got, want)
	}
	var l cList
	strictDecode(t, e.mustGet(t, "/api/admin/talks?limit=13", e.cookie(boss)), &l)
	if len(l.Items) != 13 || l.Next != nil {
		t.Fatalf("exact page: %d %v", len(l.Items), l.Next)
	}
	strictDecode(t, e.mustGet(t, "/api/admin/talks?limit=100000", e.cookie(boss)), &l)
	if len(l.Items) != 13 {
		t.Fatalf("big limit: %d", len(l.Items))
	}
}

func TestAdminTalksSearchAndStatus(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "boss@example.com")
	store, acc := memAccounts()
	ctx := context.Background()
	boss := signIn(t, store, "hackgt13", "boss@example.com", "Boss", "Boss")
	ada := signIn(t, store, "hackgt13", "ada@example.com", "Ada Lovelace", "Ada")
	var others []int64
	for i := 0; i < 12; i++ {
		others = append(others, signIn(t, store, "hackgt13", fmt.Sprintf("o%d@example.com", i), fmt.Sprintf("Other%d", i), ""))
	}
	base := time.Now().Add(-time.Hour).UTC()
	mk := func(i int, a, b int64, state string, started time.Time, edit func(*talkRecord)) string {
		rec := &talkRecord{ID: fmt.Sprintf("tk_s%02d", i), Tenant: "hackgt13", A: a, B: b, State: state, Started: started, Timings: map[string]float64{},
			Transcript: []talkLine{{Side: "a", Kind: "greet", Text: "Hello there"}, {Side: "b", Kind: "answer", Text: "My human builds robots.",
				Dropped: 1, DroppedText: []string{"WITHHELDNEEDLE lives here"}}}}
		if edit != nil {
			edit(rec)
		}
		if err := store.talkCreate(ctx, rec); err != nil {
			t.Fatal(err)
		}
		return rec.ID
	}
	// every third talk mentions a tabla in what an agent said; Ada is in two
	var tabla []string
	for i := 0; i < 12; i++ {
		id := mk(i, boss, others[i], "no_match", base.Add(time.Duration(i)*time.Second), func(r *talkRecord) {
			if i%3 == 0 {
				r.Transcript = append(r.Transcript, talkLine{Side: "a", Kind: "answer", Text: "My human plays the TABLA."})
			}
			r.HotTopics = []string{"A: soldering ↔ B's notes: diary: MEMORYNEEDLE"}
		})
		if i%3 == 0 {
			tabla = append([]string{id}, tabla...)
		}
	}
	mk(20, ada, others[0], "revealed", base.Add(30*time.Second), func(r *talkRecord) {
		r.Icebreaker = &talkIcebreaker{Line: "You both fixed a flaky relay.", Question: "How did you debug the relay?"}
	})
	mk(21, ada, others[1], "error", base.Add(31*time.Second), nil)
	mk(22, others[2], others[3], "live", time.Now().Add(-10*time.Minute).UTC(), nil) // its run is long gone
	mk(23, others[4], others[5], "live", time.Now().UTC(), nil)                      // just started
	e := newAdminEnv(t, acc, nil, nil)
	c := e.cookie(boss)
	list := func(q string) (ids []string, next *string) {
		t.Helper()
		var l cList
		strictDecode(t, e.mustGet(t, "/api/admin/talks?"+q, c), &l)
		for _, it := range l.Items {
			ids = append(ids, it.ID)
			if it.Turns < 2 {
				t.Fatalf("turns should count lines: %+v", it)
			}
		}
		return ids, l.Next
	}
	all := func(q string) []string {
		t.Helper()
		var out []string
		cursor := ""
		for i := 0; i < 20; i++ {
			ids, next := list(q + cursor)
			out = append(out, ids...)
			if next == nil {
				return out
			}
			cursor = "&cursor=" + *next
		}
		t.Fatal("pagination never ended")
		return nil
	}
	if got := all("q=tabla&limit=2"); strings.Join(got, ",") != strings.Join(tabla, ",") {
		t.Fatalf("q=tabla: %v want %v", got, tabla)
	}
	if got := all("q=ADA&limit=1"); strings.Join(got, ",") != "tk_s21,tk_s20" {
		t.Fatalf("q=ada: %v", got)
	}
	if got := all("q=debug%20the%20relay"); strings.Join(got, ",") != "tk_s20" {
		t.Fatalf("icebreaker search: %v", got)
	}
	if got := all("q=soldering&limit=5"); len(got) != 12 {
		t.Fatalf("hot topic search: %v", got)
	}
	for _, q := range []string{"withheldneedle", "memoryneedle", "diary", "lovelace", "ada@example.com"} {
		if got := all("q=" + q); len(got) != 0 {
			t.Fatalf("q=%s matched what is never shown: %v", q, got)
		}
	}
	if got := all("status=abandoned"); strings.Join(got, ",") != "tk_s22,tk_s21" {
		t.Fatalf("abandoned: %v", got)
	}
	if got := all("status=live"); strings.Join(got, ",") != "tk_s23" {
		t.Fatalf("live: %v", got)
	}
	done := all("status=done&limit=3")
	if len(done) != 15 || done[0] != "tk_s22" || strings.Contains(strings.Join(done, ","), "tk_s23") {
		t.Fatalf("done (abandoned included, live not): %v", done)
	}
	if got := all("status=all&limit=4"); len(got) != 16 {
		t.Fatalf("all: %v", got)
	}
	if code, _, _ := e.get(t, "/api/admin/talks?q="+strings.Repeat("x", 101), c); code != http.StatusBadRequest {
		t.Fatalf("long q: %d", code)
	}
	// a small scan budget: short (even empty) pages with a next, and still every match exactly once
	e = newAdminEnv(t, acc, nil, func(a *adminAPI) { a.scanBatch, a.scanMax = 2, 3 })
	c = e.cookie(boss)
	empty := 0
	var got []string
	cursor := ""
	for i := 0; i < 40; i++ {
		ids, next := list("q=tabla&limit=2" + cursor)
		if len(ids) == 0 {
			empty++
		}
		got = append(got, ids...)
		if next == nil {
			break
		}
		cursor = "&cursor=" + *next
	}
	if strings.Join(got, ",") != strings.Join(tabla, ",") || empty == 0 {
		t.Fatalf("budgeted scan: %v (empty pages %d) want %v", got, empty, tabla)
	}
}

// ---------- test accounts are hidden by default ----------

func TestAdminHidesTestAccountsByDefault(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "boss@example.com")
	store, acc := memAccounts()
	ctx := context.Background()
	boss := signIn(t, store, "hackgt13", "boss@example.com", "Boss", "Boss")
	real1 := signIn(t, store, "hackgt13", "real@gatech.edu", "Real One", "Real")
	bot := signIn(t, store, "hackgt13", "Bot1@FaceMash.Test", "Bot One", "Bot")
	store.SaveMemory(ctx, "hackgt13", bot, []byte(`{"user_md":"x"}`), nil)
	store.talkCreate(ctx, &talkRecord{ID: "tk_real", Tenant: "hackgt13", A: boss, B: real1, State: "no_match", Started: time.Now().UTC(), Timings: map[string]float64{}})
	store.talkCreate(ctx, &talkRecord{ID: "tk_bot", Tenant: "hackgt13", A: real1, B: bot, State: "revealed", Started: time.Now().UTC(), Timings: map[string]float64{}})
	e := newAdminEnv(t, acc, nil, nil)
	c := e.cookie(boss)
	var ov, ovAll cOverview
	strictDecode(t, e.mustGet(t, "/api/admin/overview", c), &ov)
	strictDecode(t, e.mustGet(t, "/api/admin/overview?include_test=true", c), &ovAll)
	if ov.UsersTotal != 2 || ov.TalksTotal != 1 || ov.MemoriesTotal != 0 || ovAll.UsersTotal != 3 || ovAll.TalksTotal != 2 || ovAll.MemoriesTotal != 1 || ovAll.RevealsTotal != 1 {
		t.Fatalf("overview: %+v / %+v", ov, ovAll)
	}
	var l cList
	strictDecode(t, e.mustGet(t, "/api/admin/talks", c), &l)
	if len(l.Items) != 1 || l.Items[0].ID != "tk_real" {
		t.Fatalf("default list: %+v", l.Items)
	}
	strictDecode(t, e.mustGet(t, "/api/admin/talks?include_test=true", c), &l)
	if len(l.Items) != 2 {
		t.Fatalf("include_test list: %+v", l.Items)
	}
	if code, _, _ := e.get(t, "/api/admin/talks/tk_bot", c); code != http.StatusNotFound {
		t.Fatalf("test talk detail by default: %d", code)
	}
	e.mustGet(t, "/api/admin/talks/tk_bot?include_test=true", c)
}

// ---------- the stream ----------

func TestAdminStreamFollowsATalk(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "carmody@example.com")
	h := newTalkHarness(t)
	h.talk.cfg.Limits.MinGapMS = 30 // a talk long enough to watch
	h.jev.gates = weakGates()       // a no-match: it ends on its own
	e := newAdminEnv(t, h.acc, newHub(), func(a *adminAPI) {
		a.bc.livePoll, a.bc.dbPoll, a.bc.keepalive = 5*time.Millisecond, 40*time.Millisecond, 60*time.Millisecond
		a.bc.buf = 64
	})
	events, stop := e.stream(t, e.cookie(h.c), "")
	defer stop()
	// a viewer that never reads (and has a tiny buffer) must not hold anything up
	stuck := &adminSub{ch: make(chan []byte, 2), uid: h.c}
	e.api.bc.mu.Lock()
	e.api.bc.subs[stuck] = struct{}{}
	e.api.bc.perUID[h.c]++
	e.api.bc.mu.Unlock()
	next := func(what string, pred func(sseEvent) bool) sseEvent {
		t.Helper()
		deadline := time.After(10 * time.Second)
		for {
			select {
			case ev, ok := <-events:
				if !ok {
					t.Fatalf("stream ended waiting for %s", what)
				}
				if pred(ev) {
					return ev
				}
			case <-deadline:
				t.Fatalf("timed out waiting for %s", what)
			}
		}
	}
	ov := next("overview", func(ev sseEvent) bool { return ev.event == "overview" })
	var o cOverview
	strictDecode(t, ov.data, &o)

	start := time.Now()
	id, err := h.talk.encounter(context.Background(), h.tenant, h.a, h.b, false)
	if err != nil {
		t.Fatal(err)
	}
	isTalk := func(status string) func(sseEvent) bool {
		return func(ev sseEvent) bool {
			if ev.event != "talk" {
				return false
			}
			var s cSummary
			strictDecode(t, ev.data, &s)
			return s.ID == id && s.Status == status
		}
	}
	var lines []cLine
	sawLive := false
	endEv := next("talk end", func(ev sseEvent) bool {
		if ev.event == "line" {
			var l struct {
				TalkID string `json:"talk_id"`
				Line   cLine  `json:"line"`
			}
			strictDecode(t, ev.data, &l)
			if l.TalkID == id {
				lines = append(lines, l.Line)
			}
			return false
		}
		sawLive = sawLive || isTalk("live")(ev)
		return isTalk("done")(ev)
	})
	if !sawLive {
		t.Fatal("never saw the talk live")
	}
	var end cSummary
	strictDecode(t, endEv.data, &end)
	rec := h.record(id)
	if len(lines) != len(rec.Transcript) || lines[0].Kind != "greeting" || lines[len(lines)-1].Kind != "close" {
		t.Fatalf("lines: got %d of %d: %+v", len(lines), len(rec.Transcript), lines)
	}
	for i, l := range lines {
		if l.Text != talkScrub(rec.Transcript[i].Text) {
			t.Fatalf("line %d out of order: %q vs %q", i, l.Text, rec.Transcript[i].Text)
		}
	}
	if end.Match == nil || *end.Match || end.EndedAt == nil || end.A.FirstName != "Zephyrine" {
		t.Fatalf("end: %+v", end)
	}
	next("keepalive", func(ev sseEvent) bool { return ev.event == "comment" && strings.Contains(ev.data, "keepalive") })
	if took := time.Since(start); took > 8*time.Second {
		t.Fatalf("talk took %v", took)
	}
	// the stuck viewer filled its buffer and was dropped; nobody waited for it
	n := 0
	for range stuck.ch {
		n++
	}
	if n > 2 {
		t.Fatalf("stuck viewer held %d frames", n)
	}
	e.api.bc.mu.Lock()
	_, still := e.api.bc.subs[stuck]
	e.api.bc.mu.Unlock()
	if still {
		t.Fatal("stuck viewer not dropped")
	}
}

func TestAdminSlowSubscriberNeverBlocks(t *testing.T) {
	_, acc := memAccounts()
	b := mountAdmin(http.NewServeMux(), acc, nil).bc
	b.buf = 8
	slow, _ := b.subscribe(1, false)
	fast, _ := b.subscribe(2, false)
	testOnly, _ := b.subscribe(3, true)
	defer b.close()
	start := time.Now()
	for i := 0; i < 1000; i++ {
		b.publish([]byte(fmt.Sprintf("event: x\ndata: %d\n\n", i)), func(s *adminSub) bool { return s != testOnly })
		select {
		case <-fast.ch:
		case <-time.After(time.Second):
			t.Fatal("fast viewer starved")
		}
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("publishing took %v", took)
	}
	n := 0
	for range slow.ch { // closed after it filled
		n++
	}
	if n != b.buf {
		t.Fatalf("slow viewer got %d frames before being dropped", n)
	}
	if b.count() != 2 {
		t.Fatalf("subscribers left: %d", b.count())
	}
	select {
	case f := <-testOnly.ch:
		t.Fatalf("filtered viewer got %q", f)
	default:
	}
	// per-admin cap
	for i := 0; i < b.maxPerUID; i++ {
		if _, err := b.subscribe(9, false); err != nil && i < b.maxPerUID {
			t.Fatalf("stream %d refused: %v", i, err)
		}
	}
	if _, err := b.subscribe(9, false); err == nil {
		t.Fatal("no cap on streams per admin")
	}
}

// ---------- privacy ----------

func TestAdminNoEmailsKeysOrMemory(t *testing.T) {
	h, e := adminHarness(t)
	ctx := context.Background()
	admin := e.cookie(h.c)
	h.store.SaveMemory(ctx, h.tenant, h.a, []byte(`{"user_md":"SECRETMEMORYSNIPPET call me at zeph@private.example"}`), nil)
	h.store.CreateToken(ctx, h.tenant, h.b, museLabel, hashToken("fm_TOKENVALUE123"))
	events, stop := e.stream(t, admin, "?include_test=true")
	defer stop()
	id, _ := h.run(h.a, h.b)
	h.waitIcebreaker(id)
	h.talk.decide(ctx, h.tenant, h.a, id, true)
	h.talk.decide(ctx, h.tenant, h.b, id, true)
	rec := h.record(id)
	// what the guard withheld, and a memory-index topic, must never come out
	rec.Transcript = append(rec.Transcript, talkLine{N: 99, Side: "a", Kind: "answer", Text: "My human likes tabla.", Dropped: 3,
		DroppedText: []string{"DROPPEDSECRETTEXT about Zephyrine Quux", "[removed]"}, NotInMemory: true})
	rec.HotTopics = append(rec.HotTopics, "A: flaky websocket ↔ B's notes: journal: NOTESNIPPETSECRET octavian@example.com")
	if err := h.store.talkSave(ctx, rec); err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, p := range []string{"/api/admin/overview", "/api/admin/overview?include_test=true", "/api/admin/talks", "/api/admin/talks?include_test=true",
		"/api/admin/talks/" + id, "/api/admin/talks/" + id + "?include_test=true"} {
		all.WriteString(e.mustGet(t, p, admin))
	}
	detail := e.mustGet(t, "/api/admin/talks/"+id, admin)
	var d cDetail
	strictDecode(t, detail, &d)
	last := d.Lines[len(d.Lines)-1]
	if !last.Withheld || last.WithheldReason == nil || !strings.Contains(*last.WithheldReason, "1 sentence(s) not supported") ||
		!strings.Contains(*last.WithheldReason, "1 sentence(s) that were only contact") || !strings.Contains(*last.WithheldReason, "1 sentence(s) past") {
		t.Fatalf("withheld line: %+v", last)
	}
	if d.Withheld < 1 || !strings.Contains(strings.Join(d.HotTopics, "|"), "B's notes (a match in their memory)") {
		t.Fatalf("withheld %d topics %v", d.Withheld, d.HotTopics)
	}
	// and the stream, until the talk's final state went by
	deadline := time.After(5 * time.Second)
	for done := false; !done; {
		select {
		case ev := <-events:
			all.WriteString(ev.data)
			if ev.event == "talk" && strings.Contains(ev.data, `"revealed":true`) {
				done = true
			}
		case <-deadline:
			t.Fatal("the stream never showed the talk revealed")
		}
	}
	out := all.String()
	if m := emailLike.FindString(out); m != "" {
		t.Fatalf("an email in admin output: %q", m)
	}
	for _, bad := range []string{"SECRETMEMORYSNIPPET", "DROPPEDSECRETTEXT", "NOTESNIPPETSECRET", "Quux", "Blix", "fm_TOKENVALUE123",
		fmt.Sprintf("%x", hashToken("fm_TOKENVALUE123")), "journal:", strings.TrimPrefix(admin, sessionCookie+"=")} {
		if strings.Contains(out, bad) {
			t.Fatalf("%q in admin output", bad)
		}
	}
	if !strings.Contains(out, `"source":"muse"`) || !strings.Contains(out, "Octavian") {
		t.Fatal("expected Octavian as a muse-connected first name")
	}
}

// ---------- the test-account purge ----------

func purgeFixture(t *testing.T, s interface {
	Store
	talkStore
}) (keep, gone []int64) {
	t.Helper()
	ctx := context.Background()
	mk := func(tenant, email string) int64 { return signIn(t, s, tenant, email, "X Y", "X") }
	real := mk("hackgt13", "real@gatech.edu")
	lookalike1 := mk("hackgt13", "someone@facemash.test.example.com")
	lookalike2 := mk("hackgt13", "facemash.test@gmail.com")
	lookalike3 := mk("hackgt13", "person@notfacemash.test.org")
	bot1 := mk("hackgt13", "bot1@facemash.test")
	bot2 := mk("hackgt13", " Bot2@FaceMash.TEST")
	mk("otherevent", "bot1@facemash.test") // bot1 in a second tenant too
	mk("otherevent", "real@gatech.edu")
	for _, id := range []int64{real, bot1, lookalike1} {
		if _, err := s.SaveMemory(ctx, "hackgt13", id, []byte(`{"user_md":"hi"}`), nil); err != nil {
			t.Fatal(err)
		}
		if err := s.CreateToken(ctx, "hackgt13", id, museLabel, hashToken(fmt.Sprintf("tok-%d", id))); err != nil {
			t.Fatal(err)
		}
		if err := s.talkSavePrefs(ctx, "hackgt13", id, talkPrefs{OptIn: true}); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	for i, pair := range [][2]int64{{real, lookalike1}, {real, bot1}, {bot1, bot2}, {lookalike2, lookalike3}} {
		if err := s.talkCreate(ctx, &talkRecord{ID: fmt.Sprintf("tk_p%d", i), Tenant: "hackgt13", A: pair[0], B: pair[1], State: "no_match",
			Started: now, Timings: map[string]float64{}}); err != nil {
			t.Fatal(err)
		}
	}
	return []int64{real, lookalike1, lookalike2, lookalike3}, []int64{bot1, bot2}
}

func TestAdminPurgeTestAccountsMemory(t *testing.T) {
	store := newMemStore()
	ctx := context.Background()
	keep, gone := purgeFixture(t, store)
	store.fastSetSpace(ctx, "hackgt13", gone[0], "spc_bot1")
	store.fastSetSpace(ctx, "hackgt13", keep[0], "spc_real")

	rep, err := store.purgeTestAccounts(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.DryRun || rep.Accounts != 2 || rep.Memberships != 3 || rep.Talks != 2 || rep.Memories != 1 || rep.Tokens != 1 || rep.PurgesQueued != 3 {
		t.Fatalf("dry run: %+v", rep)
	}
	if _, err := store.Account(ctx, "hackgt13", gone[0]); err != nil {
		t.Fatal("dry run deleted something")
	}
	if txt := adminPurgeText(rep); !strings.Contains(txt, "DRY RUN") || !strings.Contains(txt, "accounts (email ends in @facemash.test): 2") {
		t.Fatalf("text: %s", txt)
	}

	rep, err = store.purgeTestAccounts(ctx, false)
	if err != nil || rep.DryRun || rep.Accounts != 2 {
		t.Fatalf("purge: %+v %v", rep, err)
	}
	for _, id := range gone {
		for _, tenant := range []string{"hackgt13", "otherevent"} {
			if _, err := store.Account(ctx, tenant, id); err == nil {
				t.Fatalf("#%d still in %s", id, tenant)
			}
		}
	}
	for _, id := range keep {
		if _, err := store.Account(ctx, "hackgt13", id); err != nil {
			t.Fatalf("#%d (not a test account) was deleted", id)
		}
	}
	if _, err := store.Account(ctx, "otherevent", keep[0]); err != nil {
		t.Fatal("a real account's other membership was deleted")
	}
	if info, _ := store.MemoryInfo(ctx, "hackgt13", keep[0]); info["stored"] != true {
		t.Fatal("real memory deleted")
	}
	if st, _ := store.TokenStatus(ctx, "hackgt13", keep[1], museLabel); st["connected"] != true {
		t.Fatal("real token deleted")
	}
	for _, tid := range []string{"tk_p0", "tk_p3"} {
		if _, err := store.talkGet(ctx, "hackgt13", tid); err != nil {
			t.Fatalf("%s (no test account in it) deleted", tid)
		}
	}
	for _, tid := range []string{"tk_p1", "tk_p2"} {
		if _, err := store.talkGet(ctx, "hackgt13", tid); err == nil {
			t.Fatalf("%s survived", tid)
		}
	}
	marks, spaces, _ := store.fastPurges(ctx, "hackgt13", gone[0])
	if len(marks) != 1 || len(spaces) != 1 || spaces[0] != "spc_bot1" {
		t.Fatalf("bot1 MAPI purge: %v %v", marks, spaces)
	}
	if marks, _, _ := store.fastPurges(ctx, "hackgt13", keep[0]); len(marks) != 0 {
		t.Fatal("a purge queued for a real account")
	}
	if sid, _, _ := store.fastSpace(ctx, "hackgt13", keep[0]); sid != "spc_real" {
		t.Fatal("real space forgotten")
	}
	// the same address can sign up again cleanly
	signIn(t, store, "hackgt13", "bot1@facemash.test", "Bot", "Bot")
	if rep, _ := store.purgeTestAccounts(ctx, false); rep.Accounts != 1 {
		t.Fatalf("second purge: %+v", rep)
	}
}

// Against a real Postgres when FASTPG_DSN names one (a scratch schema, dropped afterwards).
func TestAdminPurgeAndQueriesPostgres(t *testing.T) {
	s, pool := mfScratchPostgres(t)
	ctx := context.Background()
	if err := s.fastEnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.talkEnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tenants (id, name) VALUES ('otherevent', 'Other')`); err != nil {
		t.Fatal(err)
	}
	keep, gone := purgeFixture(t, s)
	if err := s.fastSetSpace(ctx, "hackgt13", gone[0], "spc_bot1"); err != nil {
		t.Fatal(err)
	}
	if err := s.fastSetSpace(ctx, "hackgt13", keep[0], "spc_real"); err != nil {
		t.Fatal(err)
	}
	// the read side, while everyone is still here
	rec, _ := s.talkGet(ctx, "hackgt13", "tk_p0")
	rec.State, rec.Approvals, rec.Feedback = "revealed", map[string]string{"a": "approve", "b": "approve"}, map[string]bool{"a": true}
	rec.Transcript = []talkLine{{Side: "a", Kind: "answer", Text: "hi", Dropped: 2}, {Side: "b", Kind: "answer", Text: "yo"}}
	if err := s.talkSave(ctx, rec); err != nil {
		t.Fatal(err)
	}
	day := talkDayStart(time.Now())
	c, err := s.adminCounts(ctx, "hackgt13", day, false)
	if err != nil || c.users != 4 || c.memories != 2 || c.museConnected != 2 || c.signedInToday != 4 {
		t.Fatalf("counts: %+v %v", c, err)
	}
	if c, _ := s.adminCounts(ctx, "hackgt13", day, true); c.users != 6 {
		t.Fatalf("counts with test: %+v", c)
	}
	st, err := s.adminTalkStats(ctx, "hackgt13", day, false)
	if err != nil || st.total != 2 || st.matches != 1 || st.approvalsBoth != 1 || st.reveals != 1 || st.worthYes != 1 || st.worthNo != 0 || st.withheldLines != 1 || st.today != 2 {
		t.Fatalf("stats: %+v %v", st, err)
	}
	rows, err := s.adminTalks(ctx, "hackgt13", adminTalkQuery{states: "all", limit: 10})
	if err != nil || len(rows) != 2 {
		t.Fatalf("talks: %v %v", rows, err)
	}
	// the cursor round-trips through the API's encoding against Postgres's microseconds
	first, _ := s.adminTalks(ctx, "hackgt13", adminTalkQuery{states: "all", includeTest: true, limit: 1})
	at, id, ok := parseAdminCursor(adminCursor(first[0].started, first[0].rec.ID))
	rest, err := s.adminTalks(ctx, "hackgt13", adminTalkQuery{states: "all", includeTest: true, limit: 10, before: &at, beforeID: id})
	if !ok || err != nil || len(rest) != 3 || rest[0].rec.ID == first[0].rec.ID {
		t.Fatalf("pg cursor: %v %v %d", ok, err, len(rest))
	}
	rows, err = s.adminTalks(ctx, "hackgt13", adminTalkQuery{states: "all", match: ptr(true), includeTest: true, limit: 10, before: ptr(time.Now().Add(time.Hour)), beforeID: "tk_z"})
	if err != nil || len(rows) != 1 || rows[0].rec.ID != "tk_p0" {
		t.Fatalf("filtered talks: %v %v", rows, err)
	}
	for _, states := range []string{"open", "open_error"} {
		if rows, err := s.adminTalks(ctx, "hackgt13", adminTalkQuery{states: states, includeTest: true, limit: 10}); err != nil || len(rows) != 0 {
			t.Fatalf("%s: %v %v", states, rows, err)
		}
	}
	// the HTTP side on Postgres
	t.Setenv("ADMIN_EMAILS", "real@gatech.edu")
	e := newAdminEnv(t, &accounts{store: s, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}, nil, nil)
	var l cList
	strictDecode(t, e.mustGet(t, "/api/admin/talks?q=hi&status=done&limit=1", e.cookie(keep[0])), &l)
	if len(l.Items) != 1 || l.Items[0].ID != "tk_p0" || l.Next != nil || l.Items[0].Withheld != 1 {
		t.Fatalf("pg talks: %+v", l)
	}
	var ov cOverview
	strictDecode(t, e.mustGet(t, "/api/admin/overview", e.cookie(keep[0])), &ov)
	if ov.UsersTotal != 4 || ov.TalksTotal != 2 || ov.WithheldLinesTotal != 1 || ov.MuseConnected != 2 {
		t.Fatalf("pg overview: %+v", ov)
	}
	strictDecode(t, e.mustGet(t, "/api/admin/talks/tk_p0", e.cookie(keep[0])), &cDetail{})

	people, err := s.adminPeople(ctx, "hackgt13", []int64{keep[0], gone[0], 999999})
	if err != nil || len(people) != 2 || !people[gone[0]].test || people[keep[0]].test || !people[keep[0]].muse || people[keep[0]].first != "X" {
		t.Fatalf("people: %+v %v", people, err)
	}
	if ch, err := s.adminTalksChanged(ctx, "hackgt13", time.Now().Add(-time.Minute)); err != nil || len(ch) != 4 {
		t.Fatalf("changed: %d %v", len(ch), err)
	}

	rep, err := s.purgeTestAccounts(ctx, true)
	if err != nil || rep.Accounts != 2 || rep.Memberships != 3 || rep.Talks != 2 || rep.Memories != 1 || rep.Tokens != 1 || rep.PurgesQueued != 3 {
		t.Fatalf("dry run: %+v %v", rep, err)
	}
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	if n != 6 {
		t.Fatalf("dry run changed users: %d", n)
	}
	rep, err = s.purgeTestAccounts(ctx, false)
	if err != nil || rep.Accounts != 2 {
		t.Fatalf("purge: %+v %v", rep, err)
	}
	var emails []string
	r, _ := pool.Query(ctx, `SELECT email FROM users ORDER BY id`)
	for r.Next() {
		var e string
		r.Scan(&e)
		emails = append(emails, e)
	}
	r.Close()
	if len(emails) != 4 || strings.Contains(strings.Join(emails, ","), "bot") {
		t.Fatalf("users left: %v", emails)
	}
	var talks []string
	r, _ = pool.Query(ctx, `SELECT id FROM talks ORDER BY id`)
	for r.Next() {
		var id string
		r.Scan(&id)
		talks = append(talks, id)
	}
	r.Close()
	if strings.Join(talks, ",") != "tk_p0,tk_p3" {
		t.Fatalf("talks left: %v", talks)
	}
	var botMarks, realMarks int
	pool.QueryRow(ctx, `SELECT count(*) FROM mapi_purges WHERE user_id = ANY($1)`, gone).Scan(&botMarks)
	pool.QueryRow(ctx, `SELECT count(*) FROM mapi_purges WHERE user_id = ANY($1)`, keep).Scan(&realMarks)
	if botMarks < 3 || realMarks != 0 {
		t.Fatalf("purge markers: bots %d, real %d", botMarks, realMarks)
	}
	var sid string
	pool.QueryRow(ctx, `SELECT space_id FROM mapi_purges WHERE user_id = $1 AND tenant_id = 'hackgt13' AND space_id <> '' LIMIT 1`, gone[0]).Scan(&sid)
	if sid != "spc_bot1" {
		t.Fatalf("bot1's space not queued: %q", sid)
	}
	if sid, _, _ := s.fastSpace(ctx, "hackgt13", keep[0]); sid != "spc_real" {
		t.Fatal("real space touched")
	}
	pool.QueryRow(ctx, `SELECT count(*) FROM agent_memory`).Scan(&n)
	if n != 2 {
		t.Fatalf("memories left: %d", n)
	}
}
