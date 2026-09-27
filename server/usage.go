package main

// Usage: how long people spend in the game, and how much the paid services are used (the
// admin's Usage view, GET /api/admin/usage; the overview's activity hours come from here too).
//
// Play sessions: every usageSample the tracker looks at who is in the game (signed-in
// players, from the hub; nothing sits on the game's hot path). A person's session runs from
// their socket's hello until they've been gone for usageGap, so a page reload or a phone
// changing networks doesn't start a new one, and two tabs are one session. Each sample also
// adds to the session's active time (they moved in the last usageIdle) and hall time (they're
// in the HackGT hall). Sessions are written every sample (one statement for everyone); a
// session cut off by a restart ends at the last sample that saw it.
//
// Service meter: every Gemini, jev and ElevenLabs call adds to a counter per (service, model,
// hour): calls, failures, tokens in and out, seconds. The counters are written with the
// sessions. They count every account, test ones included (the calls cost the same).
//
// Cost: only when USAGE_RATES prices the models, e.g.
//   USAGE_RATES=gemini-3.1-flash-lite=0.10/0.40,gemini-3.8-flash=0.50/3.00,elevenlabs=0.10
// (US dollars per million tokens in/out; for voice, per minute). Unpriced: cost is null.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	usageSample = 10 * time.Second
	usageGap    = 2 * time.Minute  // back within this: the same session
	usageIdle   = 60 * time.Second // moved within this: active
	usageTop    = 10               // people in the report's top list
	usageTTL    = 10 * time.Second // the report is worked out at most this often
)

// ---------- rows ----------

type usageSessionRow struct {
	ID      string
	UserID  int64
	Started time.Time
	Seen    time.Time  // the last sample that saw them
	Ended   *time.Time // nil while they're (or may be) still playing
	Active  float64    // seconds
	Hall    float64    // seconds
	test    bool       // read side only
}

func (r usageSessionRow) stop() time.Time {
	if r.Ended != nil {
		return *r.Ended
	}
	return r.Seen
}

func (r usageSessionRow) secs() float64 { return math.Max(0, r.stop().Sub(r.Started).Seconds()) }

type usageMeterKey struct {
	Kind, Model string
	Hour        time.Time
}

type usageMeterRow struct {
	usageMeterKey
	Calls, Failed       int64
	TokensIn, TokensOut int64
	Seconds             float64
}

// usageStore: Postgres and memory (below).
type usageStore interface {
	usageSaveSessions(ctx context.Context, tenant string, rows []usageSessionRow) error
	usageSaveMeter(ctx context.Context, tenant string, rows []usageMeterRow) error
	usageSessions(ctx context.Context, tenant string, includeTest bool) ([]usageSessionRow, error)
	usageMeterRows(ctx context.Context, tenant string) ([]usageMeterRow, error)
	usageTalkTimes(ctx context.Context, tenant string, since time.Time) (usageTalkTimes, error)
}

// usageTalkTimes: the raw timings of the agent talks since some time (the speed panel).
type usageTalkTimes struct {
	talks, questions int
	picks            []usagePickTime
	firstMS, tookMS  []float64 // answers: to the first words, to the whole answer
}

type usagePickTime struct {
	ms      float64
	options int
	failed  bool
}

// ---------- the meter ----------

type usageMeterT struct {
	mu   sync.Mutex
	rows map[usageMeterKey]*usageMeterRow
	now  func() time.Time
}

// meter counts service calls for the whole server; the tracker writes it out.
var meter = &usageMeterT{rows: map[usageMeterKey]*usageMeterRow{}, now: time.Now}

// add records one call. model says which (for voice: "elevenlabs").
func (m *usageMeterT) add(kind, model string, ok bool, in, out int64, secs float64) {
	if m == nil {
		return
	}
	k := usageMeterKey{kind, model, m.now().UTC().Truncate(time.Hour)}
	m.mu.Lock()
	r := m.rows[k]
	if r == nil {
		r = &usageMeterRow{usageMeterKey: k}
		m.rows[k] = r
	}
	r.Calls++
	if !ok {
		r.Failed++
	}
	r.TokensIn += in
	r.TokensOut += out
	r.Seconds += secs
	m.mu.Unlock()
}

// drain takes everything counted so far (putBack returns it after a failed write).
func (m *usageMeterT) drain() []usageMeterRow {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]usageMeterRow, 0, len(m.rows))
	for _, r := range m.rows {
		out = append(out, *r)
	}
	clear(m.rows)
	return out
}

func (m *usageMeterT) putBack(rows []usageMeterRow) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, x := range rows {
		r := m.rows[x.usageMeterKey]
		if r == nil {
			r = &usageMeterRow{usageMeterKey: x.usageMeterKey}
			m.rows[x.usageMeterKey] = r
		}
		r.Calls += x.Calls
		r.Failed += x.Failed
		r.TokensIn += x.TokensIn
		r.TokensOut += x.TokensOut
		r.Seconds += x.Seconds
	}
}

// ---------- the session tracker ----------

// usagePresence: one signed-in person in the game right now (all their sockets together).
type usagePresence struct {
	joined time.Time // their earliest socket's hello
	moved  time.Time // their latest move
	hall   bool
}

// usagePresent: who's playing, from the hub (its lock held only to copy).
func (h *Hub) usagePresent() map[int64]usagePresence {
	out := map[int64]usagePresence{}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		if !c.joined || c.uid == 0 || c.npc {
			continue
		}
		p, seen := out[c.uid]
		if !seen || c.joinedAt.Before(p.joined) {
			p.joined = c.joinedAt
		}
		if c.walkedAt.After(p.moved) { // walking, not an idle turn or bob
			p.moved = c.walkedAt
		}
		p.hall = p.hall || c.p.Room == "hackgt"
		out[c.uid] = p
	}
	return out
}

type usageSession struct {
	row   usageSessionRow
	dirty bool // changed since the last write
}

type usageTracker struct {
	tenant string
	store  usageStore
	meter  *usageMeterT

	mu   sync.Mutex
	open map[int64]*usageSession // by account: playing, or gone less than usageGap
	last time.Time               // the previous sample
}

func newUsageTracker(tenant string, st usageStore, m *usageMeterT) *usageTracker {
	return &usageTracker{tenant: tenant, store: st, meter: m, open: map[int64]*usageSession{}}
}

// startUsage samples the hub and writes sessions and the meter every usageSample.
func startUsage(acc *accounts, hub *Hub) *usageTracker {
	st, ok := acc.store.(usageStore)
	if !ok {
		return nil
	}
	t := newUsageTracker(acc.tenant, st, meter)
	go func() {
		tick := time.NewTicker(usageSample)
		defer tick.Stop()
		for range tick.C {
			t.observe(time.Now(), hub.usagePresent())
			if acc.dbDown.Load() {
				continue // written once the database is up (nothing is lost meanwhile)
			}
			ctx, cancel := context.WithTimeout(context.Background(), usageSample)
			if err := t.flush(ctx); err != nil {
				log.Printf("usage: not saved yet (will retry): %v", err)
			}
			cancel()
		}
	}()
	log.Printf("usage: tracking play sessions every %v", usageSample)
	return t
}

// observe folds one sample into the sessions.
func (t *usageTracker) observe(now time.Time, present map[int64]usagePresence) {
	t.mu.Lock()
	defer t.mu.Unlock()
	dt := usageSample
	if !t.last.IsZero() && now.Sub(t.last) > 0 && now.Sub(t.last) < 3*usageSample {
		dt = now.Sub(t.last) // a late tick counts what really passed (a stalled one, at most three)
	}
	t.last = now
	for uid, p := range present {
		s := t.open[uid]
		step := dt
		if s == nil {
			start := p.joined
			if start.IsZero() || start.After(now) || now.Sub(start) > 3*usageSample {
				start = now // a hello from before this server started tracking: from now
			}
			s = &usageSession{row: usageSessionRow{ID: usageID(), UserID: uid, Started: start}}
			t.open[uid] = s
			step = min(dt, now.Sub(start)) // a new session: only the time since its hello
		}
		s.row.Seen = now
		s.row.Ended = nil // back within usageGap: the same session goes on
		if p.hall {
			s.row.Hall += step.Seconds()
		}
		if !p.moved.IsZero() && now.Sub(p.moved) <= usageIdle {
			s.row.Active += step.Seconds()
		}
		s.dirty = true
	}
	for uid, s := range t.open {
		if _, ok := present[uid]; ok {
			continue
		}
		switch {
		case s.row.Ended == nil:
			end := s.row.Seen
			s.row.Ended = &end
			s.dirty = true
		case !s.dirty && now.Sub(s.row.Seen) > usageGap:
			delete(t.open, uid) // over, and written
		}
	}
}

// flush writes the changed sessions and the meter's counts.
func (t *usageTracker) flush(ctx context.Context) error {
	t.mu.Lock()
	var rows []usageSessionRow
	var sent []*usageSession
	for _, s := range t.open {
		if s.dirty {
			rows = append(rows, s.row)
			sent = append(sent, s)
			s.dirty = false
		}
	}
	t.mu.Unlock()
	if len(rows) > 0 {
		if err := t.store.usageSaveSessions(ctx, t.tenant, rows); err != nil {
			t.mu.Lock()
			for _, s := range sent {
				s.dirty = true
			}
			t.mu.Unlock()
			return err
		}
	}
	if m := t.meter.drain(); len(m) > 0 {
		if err := t.store.usageSaveMeter(ctx, t.tenant, m); err != nil {
			t.meter.putBack(m)
			return err
		}
	}
	return nil
}

func usageID() string {
	b := make([]byte, 9)
	rand.Read(b)
	return "ps_" + hex.EncodeToString(b)
}

// ---------- the report ----------

type usagePlay struct {
	People           int        `json:"people"`       // everyone who has played
	PeopleToday      int        `json:"people_today"` // played since the start of today
	Sessions         int        `json:"sessions"`
	SessionsToday    int        `json:"sessions_today"`
	Hours            float64    `json:"hours"` // time in the game, all sessions
	HoursToday       float64    `json:"hours_today"`
	ActiveHours      float64    `json:"active_hours"` // of which moving about
	HallHours        float64    `json:"hall_hours"`   // of which in the HackGT hall
	AvgSessionMin    float64    `json:"avg_session_min"`
	MedianSessionMin float64    `json:"median_session_min"`
	AvgPerPersonMin  float64    `json:"avg_per_person_min"`
	Returning        int        `json:"returning"` // came back for a second session
	PeakOnline       int        `json:"peak_online"`
	PeakAt           *time.Time `json:"peak_at"`
	OnlineNow        int        `json:"online_now"`
}

type usageHour struct {
	Hour    time.Time `json:"hour"`
	People  int       `json:"people"`
	Minutes float64   `json:"minutes"`
}

type usagePerson struct {
	adminPerson
	Minutes  float64 `json:"minutes"`
	Sessions int     `json:"sessions"`
}

type usageService struct {
	Kind       string   `json:"kind"` // gemini | jev | voice
	Model      string   `json:"model"`
	Calls      int64    `json:"calls"`
	Failed     int64    `json:"failed"`
	CallsToday int64    `json:"calls_today"`
	TokensIn   int64    `json:"tokens_in"`
	TokensOut  int64    `json:"tokens_out"`
	Minutes    float64  `json:"minutes"`
	CostUSD    *float64 `json:"cost_usd"` // null: not priced (USAGE_RATES)
	CostToday  *float64 `json:"cost_today_usd"`
}

type usageVoice struct {
	Calls      int64   `json:"calls"`
	Minutes    float64 `json:"minutes"`
	AvgCallSec float64 `json:"avg_call_sec"`
	People     int     `json:"people"` // have a voice memory
}

// usageSpeed: how fast the agent talks run (the last usageSpeedFor), for checking it's snappy.
type usageSpeed struct {
	Talks            int     `json:"talks"`
	QuestionsPerTalk float64 `json:"questions_per_talk"`
	Picks            int     `json:"picks"` // jev choosing the next question
	PickP50MS        float64 `json:"pick_p50_ms"`
	PickP90MS        float64 `json:"pick_p90_ms"`
	PickFailed       int     `json:"pick_failed"` // timed out or errored (the first eligible question is asked instead)
	AvgOptions       float64 `json:"avg_options"` // questions jev chose from
	Answers          int     `json:"answers"`
	FirstWordsP50MS  float64 `json:"first_words_p50_ms"` // an answer's first words on screen
	FirstWordsP90MS  float64 `json:"first_words_p90_ms"`
	AnswerP50MS      float64 `json:"answer_p50_ms"` // the whole answer
	HoursBack        int     `json:"hours_back"`
}

const usageSpeedFor = 24 * time.Hour

func pctl(xs []float64, p float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	ys := append([]float64(nil), xs...)
	sort.Float64s(ys)
	i := int(math.Ceil(p*float64(len(ys)))) - 1
	return math.Round(ys[max(0, min(i, len(ys)-1))])
}

func usageSpeedOf(t usageTalkTimes) usageSpeed {
	sp := usageSpeed{Talks: t.talks, Picks: len(t.picks), Answers: len(t.firstMS), HoursBack: int(usageSpeedFor / time.Hour)}
	if t.talks > 0 {
		sp.QuestionsPerTalk = math.Round(float64(t.questions)/float64(t.talks)*10) / 10
	}
	var ms []float64
	opts := 0
	for _, p := range t.picks {
		ms = append(ms, p.ms)
		opts += p.options
		if p.failed {
			sp.PickFailed++
		}
	}
	sp.PickP50MS, sp.PickP90MS = pctl(ms, 0.5), pctl(ms, 0.9)
	if len(t.picks) > 0 {
		sp.AvgOptions = math.Round(float64(opts)/float64(len(t.picks))*10) / 10
	}
	sp.FirstWordsP50MS, sp.FirstWordsP90MS, sp.AnswerP50MS = pctl(t.firstMS, 0.5), pctl(t.firstMS, 0.9), pctl(t.tookMS, 0.5)
	return sp
}

type usageReportT struct {
	Speed     usageSpeed     `json:"speed"`
	Play      usagePlay      `json:"play"`
	Hourly    []usageHour    `json:"hourly"` // the last 24 hours, oldest first (empty hours included)
	Top       []usagePerson  `json:"top"`
	Voice     usageVoice     `json:"voice"`
	Services  []usageService `json:"services"`
	CostUSD   *float64       `json:"cost_usd"` // every priced service; null when none is priced
	CostToday *float64       `json:"cost_today_usd"`
	AsOf      time.Time      `json:"as_of"`
}

// usageFigures works out the play numbers, the hours and the top list from the sessions.
func usageFigures(rows []usageSessionRow, now, day time.Time) (usagePlay, []usageHour, map[int64][2]float64) {
	var p usagePlay
	people := map[int64][2]float64{} // seconds, sessions
	today := map[int64]bool{}
	var lens []float64
	type edge struct {
		at time.Time
		d  int
	}
	var edges []edge
	for _, r := range rows {
		s := r.secs()
		lens = append(lens, s)
		p.Sessions++
		p.Hours += s
		p.ActiveHours += math.Min(r.Active, s)
		p.HallHours += math.Min(r.Hall, s)
		x := people[r.UserID]
		people[r.UserID] = [2]float64{x[0] + s, x[1] + 1}
		if r.stop().After(day) {
			p.SessionsToday++
			today[r.UserID] = true
			from := r.Started
			if from.Before(day) {
				from = day
			}
			p.HoursToday += math.Max(0, r.stop().Sub(from).Seconds())
		}
		edges = append(edges, edge{r.Started, 1}, edge{r.stop(), -1})
	}
	p.People, p.PeopleToday = len(people), len(today)
	for _, x := range people {
		if x[1] >= 2 {
			p.Returning++
		}
	}
	if p.Sessions > 0 {
		p.AvgSessionMin = p.Hours / float64(p.Sessions) / 60
		sort.Float64s(lens)
		mid := len(lens) / 2
		med := lens[mid]
		if len(lens)%2 == 0 {
			med = (lens[mid-1] + lens[mid]) / 2
		}
		p.MedianSessionMin = med / 60
	}
	if p.People > 0 {
		p.AvgPerPersonMin = p.Hours / float64(p.People) / 60
	}
	// peak: most sessions open at once (an end before a start at the same instant)
	sort.Slice(edges, func(i, j int) bool {
		if !edges[i].at.Equal(edges[j].at) {
			return edges[i].at.Before(edges[j].at)
		}
		return edges[i].d < edges[j].d
	})
	n := 0
	for _, e := range edges {
		if n += e.d; n > p.PeakOnline {
			p.PeakOnline = n
			at := e.at.UTC()
			p.PeakAt = &at
		}
	}
	p.Hours, p.HoursToday, p.ActiveHours, p.HallHours = p.Hours/3600, p.HoursToday/3600, p.ActiveHours/3600, p.HallHours/3600

	// the last 24 hours, hour by hour: who played in each, and for how many minutes
	end := now.UTC().Truncate(time.Hour)
	hours := make([]usageHour, 24)
	who := make([]map[int64]bool, 24)
	for i := range hours {
		hours[i].Hour = end.Add(time.Duration(i-23) * time.Hour)
		who[i] = map[int64]bool{}
	}
	first := hours[0].Hour
	for _, r := range rows {
		a, b := r.Started, r.stop()
		if !b.After(first) {
			continue
		}
		for i := range hours {
			h0, h1 := hours[i].Hour, hours[i].Hour.Add(time.Hour)
			lo, hi := a, b
			if lo.Before(h0) {
				lo = h0
			}
			if hi.After(h1) {
				hi = h1
			}
			if hi.After(lo) {
				hours[i].Minutes += hi.Sub(lo).Minutes()
				who[i][r.UserID] = true
			}
		}
	}
	for i := range hours {
		hours[i].People = len(who[i])
		hours[i].Minutes = math.Round(hours[i].Minutes*10) / 10
	}
	return p, hours, people
}

// usageRates: USAGE_RATES, "model=in/out" per million tokens, or "model=perMinute".
type usageRate struct{ in, out, perMin float64 }

func usageRates(s string) map[string]usageRate {
	out := map[string]usageRate{}
	for _, part := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || k == "" {
			continue
		}
		a, b, pair := strings.Cut(v, "/")
		x, err1 := strconv.ParseFloat(strings.TrimSpace(a), 64)
		if err1 != nil || x < 0 {
			continue
		}
		if !pair {
			out[k] = usageRate{perMin: x}
			continue
		}
		if y, err := strconv.ParseFloat(strings.TrimSpace(b), 64); err == nil && y >= 0 {
			out[k] = usageRate{in: x, out: y}
		}
	}
	return out
}

func (r usageRate) cost(in, out int64, secs float64) float64 {
	return float64(in)/1e6*r.in + float64(out)/1e6*r.out + secs/60*r.perMin
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// usageServices sums the meter per (service, model), with cost where it's priced.
func usageServices(rows []usageMeterRow, day time.Time, rates map[string]usageRate) ([]usageService, usageVoice, *float64, *float64) {
	type acc struct {
		s                 usageService
		todayIn, todayOut int64
		todaySecs, secs   float64
	}
	by := map[[2]string]*acc{}
	var voice usageVoice
	var voiceSecs float64
	for _, r := range rows {
		k := [2]string{r.Kind, r.Model}
		a := by[k]
		if a == nil {
			a = &acc{s: usageService{Kind: r.Kind, Model: r.Model}}
			by[k] = a
		}
		a.s.Calls += r.Calls
		a.s.Failed += r.Failed
		a.s.TokensIn += r.TokensIn
		a.s.TokensOut += r.TokensOut
		a.secs += r.Seconds
		if r.Hour.Add(time.Hour).After(day) { // the hour overlaps today
			a.s.CallsToday += r.Calls
			a.todayIn += r.TokensIn
			a.todayOut += r.TokensOut
			a.todaySecs += r.Seconds
		}
		if r.Kind == "voice" && r.Model != "elevenlabs-tts" && r.Model != "saved" { // calls, and answers written down
			voice.Calls += r.Calls - r.Failed
			voiceSecs += r.Seconds
		}
	}
	var total, today *float64
	var out []usageService
	for _, a := range by {
		a.s.Minutes = math.Round(a.secs/60*10) / 10
		if rate, ok := rates[a.s.Model]; ok {
			c, t := round2(rate.cost(a.s.TokensIn, a.s.TokensOut, a.secs)), round2(rate.cost(a.todayIn, a.todayOut, a.todaySecs))
			a.s.CostUSD, a.s.CostToday = &c, &t
			if total == nil {
				total, today = new(float64), new(float64)
			}
			*total += c
			*today += t
		}
		out = append(out, a.s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Model < out[j].Model
	})
	if total != nil {
		*total, *today = round2(*total), round2(*today)
	}
	voice.Minutes = math.Round(voiceSecs/60*10) / 10
	if voice.Calls > 0 {
		voice.AvgCallSec = math.Round(voiceSecs / float64(voice.Calls))
	}
	return out, voice, total, today
}

// ---------- Postgres ----------

func (s *pgStore) usageEnsureSchema(ctx context.Context, tenant string) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS play_sessions (
  id         text PRIMARY KEY,
  tenant_id  text   NOT NULL,
  user_id    bigint NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL,
  ended_at   timestamptz,
  active_s   double precision NOT NULL DEFAULT 0,
  hall_s     double precision NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS play_sessions_tenant ON play_sessions(tenant_id, started_at);
CREATE INDEX IF NOT EXISTS play_sessions_user ON play_sessions(tenant_id, user_id);
CREATE TABLE IF NOT EXISTS usage_meter (
  tenant_id  text NOT NULL,
  kind       text NOT NULL,
  model      text NOT NULL,
  hour       timestamptz NOT NULL,
  calls      bigint NOT NULL DEFAULT 0,
  failed     bigint NOT NULL DEFAULT 0,
  tokens_in  bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  seconds    double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, kind, model, hour)
);`)
	if err != nil {
		return err
	}
	// sessions a restart cut off end at the last sample that saw them
	_, err = s.pool.Exec(ctx, `UPDATE play_sessions SET ended_at = last_seen WHERE tenant_id = $1 AND ended_at IS NULL`, tenant)
	return err
}

func (s *pgStore) usageSaveSessions(ctx context.Context, tenant string, rows []usageSessionRow) error {
	n := len(rows)
	ids, users := make([]string, n), make([]int64, n)
	started, seen, ended := make([]time.Time, n), make([]time.Time, n), make([]*time.Time, n)
	active, hall := make([]float64, n), make([]float64, n)
	for i, r := range rows {
		ids[i], users[i], started[i], seen[i], ended[i], active[i], hall[i] = r.ID, r.UserID, r.Started, r.Seen, r.Ended, r.Active, r.Hall
	}
	// someone deleted mid-session (their membership is gone) is skipped, not an error
	_, err := s.pool.Exec(ctx, `INSERT INTO play_sessions (id, tenant_id, user_id, started_at, last_seen, ended_at, active_s, hall_s)
		SELECT x.i, $1, x.u, x.st, x.ls, x.en, x.a, x.h
		FROM unnest($2::text[], $3::bigint[], $4::timestamptz[], $5::timestamptz[], $6::timestamptz[], $7::double precision[], $8::double precision[])
		  AS x(i, u, st, ls, en, a, h)
		WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = $1 AND m.user_id = x.u)
		ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, ended_at = excluded.ended_at,
		  active_s = excluded.active_s, hall_s = excluded.hall_s`,
		tenant, ids, users, started, seen, ended, active, hall)
	return err
}

func (s *pgStore) usageSaveMeter(ctx context.Context, tenant string, rows []usageMeterRow) error {
	n := len(rows)
	kinds, models, hours := make([]string, n), make([]string, n), make([]time.Time, n)
	calls, failed, tin, tout, secs := make([]int64, n), make([]int64, n), make([]int64, n), make([]int64, n), make([]float64, n)
	for i, r := range rows {
		kinds[i], models[i], hours[i] = r.Kind, r.Model, r.Hour
		calls[i], failed[i], tin[i], tout[i], secs[i] = r.Calls, r.Failed, r.TokensIn, r.TokensOut, r.Seconds
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO usage_meter (tenant_id, kind, model, hour, calls, failed, tokens_in, tokens_out, seconds)
		SELECT $1, x.k, x.m, x.h, x.c, x.f, x.ti, x.tn, x.s
		FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[], $9::double precision[])
		  AS x(k, m, h, c, f, ti, tn, s)
		ON CONFLICT (tenant_id, kind, model, hour) DO UPDATE SET
		  calls = usage_meter.calls + excluded.calls, failed = usage_meter.failed + excluded.failed,
		  tokens_in = usage_meter.tokens_in + excluded.tokens_in, tokens_out = usage_meter.tokens_out + excluded.tokens_out,
		  seconds = usage_meter.seconds + excluded.seconds`,
		tenant, kinds, models, hours, calls, failed, tin, tout, secs)
	return err
}

func (s *pgStore) usageSessions(ctx context.Context, tenant string, includeTest bool) ([]usageSessionRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT p.id, p.user_id, p.started_at, p.last_seen, p.ended_at, p.active_s, p.hall_s
		FROM play_sessions p JOIN users u ON u.id = p.user_id
		WHERE p.tenant_id = $1 AND ($2 OR NOT `+pgIsTest("u.email")+`)`, tenant, includeTest)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []usageSessionRow
	for rows.Next() {
		var r usageSessionRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.Started, &r.Seen, &r.Ended, &r.Active, &r.Hall); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *pgStore) usageMeterRows(ctx context.Context, tenant string) ([]usageMeterRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT kind, model, hour, calls, failed, tokens_in, tokens_out, seconds
		FROM usage_meter WHERE tenant_id = $1`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []usageMeterRow
	for rows.Next() {
		var r usageMeterRow
		if err := rows.Scan(&r.Kind, &r.Model, &r.Hour, &r.Calls, &r.Failed, &r.TokensIn, &r.TokensOut, &r.Seconds); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *pgStore) usageTalkTimes(ctx context.Context, tenant string, since time.Time) (usageTalkTimes, error) {
	var out usageTalkTimes
	arr := func(f string) string {
		return "CASE WHEN jsonb_typeof(t.record->'" + f + "') = 'array' THEN t.record->'" + f + "' ELSE '[]'::jsonb END"
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*), coalesce(sum((SELECT count(*) FROM jsonb_array_elements(`+arr("transcript")+`) l WHERE l->>'kind' = 'question')), 0)
		FROM talks t WHERE t.tenant_id = $1 AND t.started_at >= $2`, tenant, since).Scan(&out.talks, &out.questions); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT coalesce((j->>'took_ms')::float8, 0), coalesce((j->>'options')::int, 0), coalesce(j->>'err', '') <> ''
		FROM talks t CROSS JOIN LATERAL jsonb_array_elements(`+arr("jev")+`) j
		WHERE t.tenant_id = $1 AND t.started_at >= $2 AND j->>'what' = 'pick'`, tenant, since)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var p usagePickTime
		if err := rows.Scan(&p.ms, &p.options, &p.failed); err != nil {
			rows.Close()
			return out, err
		}
		out.picks = append(out.picks, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `SELECT coalesce((l->>'first_ms')::float8, 0), coalesce((l->>'took_ms')::float8, 0)
		FROM talks t CROSS JOIN LATERAL jsonb_array_elements(`+arr("transcript")+`) l
		WHERE t.tenant_id = $1 AND t.started_at >= $2 AND l->>'kind' = 'answer' AND (l->>'first_ms') IS NOT NULL`, tenant, since)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var f, tk float64
		if err := rows.Scan(&f, &tk); err != nil {
			return out, err
		}
		out.firstMS, out.tookMS = append(out.firstMS, f), append(out.tookMS, tk)
	}
	return out, rows.Err()
}

// ---------- memory ----------

func (m *memStore) usageTalkTimes(_ context.Context, tenant string, since time.Time) (usageTalkTimes, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out usageTalkTimes
	for _, rec := range m.talkTables().talks {
		if rec.Tenant != tenant || rec.Started.Before(since) {
			continue
		}
		out.talks++
		for _, l := range rec.Transcript {
			switch {
			case l.Kind == "question":
				out.questions++
			case l.Kind == "answer" && l.FirstMS > 0:
				out.firstMS, out.tookMS = append(out.firstMS, l.FirstMS), append(out.tookMS, l.TookMS)
			}
		}
		for _, j := range rec.Jev {
			if j.What == "pick" {
				out.picks = append(out.picks, usagePickTime{ms: j.TookMS, options: j.Options, failed: j.Err != ""})
			}
		}
	}
	return out, nil
}

type memUsageTables struct {
	sessions map[string]usageSessionRow // by id
	tenantOf map[string]string
	meter    map[string]map[usageMeterKey]usageMeterRow // by tenant
}

func (m *memStore) usageT() *memUsageTables {
	if m.usage == nil {
		m.usage = &memUsageTables{sessions: map[string]usageSessionRow{}, tenantOf: map[string]string{}, meter: map[string]map[usageMeterKey]usageMeterRow{}}
	}
	return m.usage
}

func (m *memStore) usageSaveSessions(_ context.Context, tenant string, rows []usageSessionRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.usageT()
	for _, r := range rows {
		if m.members[memKey(tenant, r.UserID)] == nil {
			continue
		}
		if r.Ended != nil {
			e := *r.Ended
			r.Ended = &e
		}
		u.sessions[r.ID] = r
		u.tenantOf[r.ID] = tenant
	}
	return nil
}

func (m *memStore) usageSaveMeter(_ context.Context, tenant string, rows []usageMeterRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.usageT()
	t := u.meter[tenant]
	if t == nil {
		t = map[usageMeterKey]usageMeterRow{}
		u.meter[tenant] = t
	}
	for _, r := range rows {
		x := t[r.usageMeterKey]
		x.usageMeterKey = r.usageMeterKey
		x.Calls += r.Calls
		x.Failed += r.Failed
		x.TokensIn += r.TokensIn
		x.TokensOut += r.TokensOut
		x.Seconds += r.Seconds
		t[r.usageMeterKey] = x
	}
	return nil
}

func (m *memStore) usageSessions(_ context.Context, tenant string, includeTest bool) ([]usageSessionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.usageT()
	var out []usageSessionRow
	for id, r := range u.sessions {
		if u.tenantOf[id] != tenant || (!includeTest && m.isTestID(r.UserID)) {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

func (m *memStore) usageMeterRows(_ context.Context, tenant string) ([]usageMeterRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []usageMeterRow
	for _, r := range m.usageT().meter[tenant] {
		out = append(out, r)
	}
	return out, nil
}

// memUsageForget drops a deleted account's sessions (the purge; Postgres cascades).
func (m *memStore) memUsageForget(gone map[int64]bool) int {
	if m.usage == nil {
		return 0
	}
	n := 0
	for id, r := range m.usage.sessions {
		if gone[r.UserID] {
			delete(m.usage.sessions, id)
			delete(m.usage.tenantOf, id)
			n++
		}
	}
	return n
}

var usageRatesEnv = sync.OnceValue(func() map[string]usageRate { return usageRates(os.Getenv("USAGE_RATES")) })

// ---------- the admin endpoint ----------

var errNoUsage = errors.New("usage: this store doesn't track it")

// usageReport: worked out at most once per usageTTL per include_test (many viewers, one read).
func (a *adminAPI) usageReport(ctx context.Context, withTest bool) (*usageReportT, error) {
	st, ok := a.acc.store.(usageStore)
	if !ok {
		return nil, errNoUsage
	}
	now := a.now()
	a.usageMu.Lock()
	defer a.usageMu.Unlock()
	if u := a.usage[withTest]; u != nil && now.Sub(u.AsOf) < usageTTL {
		return u, nil
	}
	rows, err := st.usageSessions(ctx, a.acc.tenant, withTest)
	if err != nil {
		return nil, err
	}
	meterRows, err := st.usageMeterRows(ctx, a.acc.tenant)
	if err != nil {
		return nil, err
	}
	day := talkDayStart(now)
	play, hourly, people := usageFigures(rows, now, day)
	if a.hub != nil {
		play.OnlineNow = a.hub.counts()["online"]
	}
	u := &usageReportT{Play: play, Hourly: hourly, Top: []usagePerson{}, AsOf: now.UTC().Truncate(time.Millisecond)}
	u.Services, u.Voice, u.CostUSD, u.CostToday = usageServices(meterRows, day, usageRatesEnv())
	if u.Services == nil {
		u.Services = []usageService{}
	}
	ids := make([]int64, 0, len(people))
	for id := range people {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if people[ids[i]][0] != people[ids[j]][0] {
			return people[ids[i]][0] > people[ids[j]][0]
		}
		return ids[i] < ids[j]
	})
	if len(ids) > usageTop {
		ids = ids[:usageTop]
	}
	names := a.peopleFor(ctx, ids)
	for _, id := range ids {
		u.Top = append(u.Top, usagePerson{adminPerson: adminPersonOf(id, names[id]), Minutes: math.Round(people[id][0]/60*10) / 10, Sessions: int(people[id][1])})
	}
	if c, err := a.store.adminCounts(ctx, a.acc.tenant, day, withTest); err == nil {
		u.Voice.People = c.voice
	}
	if tt, err := st.usageTalkTimes(ctx, a.acc.tenant, now.Add(-usageSpeedFor)); err == nil {
		u.Speed = usageSpeedOf(tt)
	} else {
		log.Printf("admin: usage: talk speed: %v", err)
	}
	a.usage[withTest] = u
	return u, nil
}

func (a *adminAPI) handleUsage(w http.ResponseWriter, r *http.Request, _ adminCaller) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	u, err := a.usageReport(ctx, includeTest(r))
	if err != nil {
		log.Printf("admin: usage: %v", err)
		adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
		return
	}
	adminJSON(w, http.StatusOK, u)
}
