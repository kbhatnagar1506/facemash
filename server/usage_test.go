package main

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"
)

func usageFixture(t *testing.T) (*memStore, *usageTracker, *usageMeterT) {
	t.Helper()
	st := newMemStore()
	ctx := context.Background()
	for _, email := range []string{"a@x.test", "b@x.test", "qa@facemash.test"} {
		if _, _, err := st.SignIn(ctx, "t1", user{Sub: email, Email: email, Name: strings.Split(email, "@")[0]}); err != nil {
			t.Fatal(err)
		}
	}
	m := &usageMeterT{rows: map[usageMeterKey]*usageMeterRow{}, now: time.Now}
	return st, newUsageTracker("t1", st, m), m
}

func TestUsageSessionsMergeAndEnd(t *testing.T) {
	st, tr, _ := usageFixture(t)
	ctx := context.Background()
	t0 := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)
	at := func(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }

	// #1 plays 60 s in the hall, moving; #2 idles on campus
	for s := 0; s <= 60; s += 10 {
		tr.observe(at(s), map[int64]usagePresence{
			1: {joined: at(0), moved: at(s), hall: true},
			2: {joined: at(0)}, // never walked
		})
	}
	// both leave; #1 reloads 30 s later (same session), #2 stays gone past the gap
	tr.observe(at(70), map[int64]usagePresence{})
	tr.observe(at(100), map[int64]usagePresence{1: {joined: at(95), moved: at(95), hall: true}})
	for s := 110; s <= 70+int(usageGap/time.Second)+30; s += 10 {
		tr.observe(at(s), map[int64]usagePresence{1: {joined: at(95), moved: at(95)}})
		if err := tr.flush(ctx); err != nil {
			t.Fatal(err)
		}
	}
	rows, _ := st.usageSessions(ctx, "t1", false)
	if len(rows) != 2 {
		t.Fatalf("sessions: %d %+v", len(rows), rows)
	}
	by := map[int64]usageSessionRow{}
	for _, r := range rows {
		by[r.UserID] = r
	}
	one, two := by[1], by[2]
	if one.Ended != nil || !one.Started.Equal(at(0)) {
		t.Fatalf("#1 should be one open session since t0 (the reload merged): %+v", one)
	}
	if two.Ended == nil || !two.Ended.Equal(at(60)) || two.secs() != 60 {
		t.Fatalf("#2 should end at its last sample: %+v", two)
	}
	if two.Active != 0 || two.Hall != 0 {
		t.Fatalf("#2 idled on campus: %+v", two)
	}
	if one.Hall < 60 || one.Active < 50 { // the first sample (moved == joined) isn't active
		t.Fatalf("#1 moved in the hall: %+v", one)
	}
	if _, open := tr.open[2]; open {
		t.Fatal("#2's session should be forgotten once written and past the gap")
	}
	// back after the gap: a new session
	tr.observe(at(1000), map[int64]usagePresence{2: {joined: at(1000), moved: at(1000)}})
	tr.flush(ctx)
	if rows, _ := st.usageSessions(ctx, "t1", false); len(rows) != 3 {
		t.Fatalf("a return after the gap is a new session: %d", len(rows))
	}
}

func TestUsageTestAccountsAndPurge(t *testing.T) {
	st, tr, _ := usageFixture(t)
	ctx := context.Background()
	now := time.Now()
	tr.observe(now, map[int64]usagePresence{1: {joined: now}, 3: {joined: now}})
	if err := tr.flush(ctx); err != nil {
		t.Fatal(err)
	}
	if rows, _ := st.usageSessions(ctx, "t1", false); len(rows) != 1 {
		t.Fatalf("test accounts are hidden by default: %d", len(rows))
	}
	if rows, _ := st.usageSessions(ctx, "t1", true); len(rows) != 2 {
		t.Fatalf("include_test shows them: %d", len(rows))
	}
	if _, err := st.purgeTestAccounts(ctx, false); err != nil {
		t.Fatal(err)
	}
	if rows, _ := st.usageSessions(ctx, "t1", true); len(rows) != 1 {
		t.Fatalf("the purge takes a test account's sessions: %d", len(rows))
	}
}

func TestUsageMeterFlushAndRetry(t *testing.T) {
	st, tr, m := usageFixture(t)
	ctx := context.Background()
	m.add("gemini", "g-lite", true, 1000, 200, 0)
	m.add("gemini", "g-lite", false, 0, 0, 0)
	m.add("voice", "elevenlabs", true, 0, 0, 90)
	if err := tr.flush(ctx); err != nil {
		t.Fatal(err)
	}
	m.add("gemini", "g-lite", true, 500, 100, 0)
	tr.flush(ctx)
	rows, _ := st.usageMeterRows(ctx, "t1")
	day := time.Now().Add(-time.Hour)
	svc, voice, cost, _ := usageServices(rows, day, usageRates("g-lite=1/10,elevenlabs=0.5"))
	if len(svc) != 2 {
		t.Fatalf("services: %+v", svc)
	}
	g := svc[0]
	if g.Kind != "gemini" || g.Calls != 3 || g.Failed != 1 || g.TokensIn != 1500 || g.TokensOut != 300 || g.CallsToday != 3 {
		t.Fatalf("gemini: %+v", g)
	}
	// 1500/1e6*1 + 300/1e6*10 = 0.0045 -> 0.00; voice 1.5 min * 0.5 = 0.75
	if g.CostUSD == nil || *g.CostUSD != 0 || svc[1].CostUSD == nil || *svc[1].CostUSD != 0.75 || cost == nil || *cost != 0.75 {
		t.Fatalf("cost: %+v %+v %v", g, svc[1], cost)
	}
	if voice.Calls != 1 || voice.Minutes != 1.5 || voice.AvgCallSec != 90 {
		t.Fatalf("voice: %+v", voice)
	}
	if _, _, c, _ := usageServices(rows, day, nil); c != nil {
		t.Fatal("unpriced: no cost")
	}
}

type failingUsage struct{ usageStore }

func (failingUsage) usageSaveSessions(context.Context, string, []usageSessionRow) error {
	return context.DeadlineExceeded
}

func TestUsageFlushFailureKeepsEverything(t *testing.T) {
	st, _, m := usageFixture(t)
	tr := newUsageTracker("t1", failingUsage{st}, m)
	now := time.Now()
	tr.observe(now, map[int64]usagePresence{1: {joined: now}})
	m.add("jev", "j", true, 0, 0, 0)
	if tr.flush(context.Background()) == nil {
		t.Fatal("want the save error")
	}
	if !tr.open[1].dirty || len(m.rows) != 1 {
		t.Fatal("a failed save must keep the session dirty and the meter counts")
	}
	tr.store = st
	if err := tr.flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rows, _ := st.usageSessions(context.Background(), "t1", false); len(rows) != 1 {
		t.Fatal("written on the retry")
	}
}

func TestUsageFigures(t *testing.T) {
	now := time.Date(2026, 9, 26, 18, 30, 0, 0, time.UTC)
	day := time.Date(2026, 9, 26, 4, 0, 0, 0, time.UTC)
	ts := func(h, m int) time.Time { return time.Date(2026, 9, 26, h, m, 0, 0, time.UTC) }
	end := func(v time.Time) *time.Time { return &v }
	rows := []usageSessionRow{
		{UserID: 1, Started: ts(2, 0), Ended: end(ts(5, 0)), Active: 3600, Hall: 7200}, // 3 h, 1 h of it today
		{UserID: 1, Started: ts(10, 0), Ended: end(ts(10, 30))},                        // 30 min
		{UserID: 2, Started: ts(10, 15), Seen: ts(11, 15)},                             // 1 h, cut off (no end)
	}
	p, hours, people := usageFigures(rows, now, day)
	if p.Sessions != 3 || p.People != 2 || p.PeopleToday != 2 || p.SessionsToday != 3 || p.Returning != 1 {
		t.Fatalf("counts: %+v", p)
	}
	if math.Abs(p.Hours-4.5) > 1e-9 || math.Abs(p.HoursToday-2.5) > 1e-9 || p.ActiveHours != 1 || p.HallHours != 2 {
		t.Fatalf("hours: %+v", p)
	}
	if p.MedianSessionMin != 60 || p.AvgSessionMin != 90 || p.AvgPerPersonMin != 135 {
		t.Fatalf("lengths: %+v", p)
	}
	if p.PeakOnline != 2 || p.PeakAt == nil || !p.PeakAt.Equal(ts(10, 15)) {
		t.Fatalf("peak: %+v", p)
	}
	if people[1] != [2]float64{12600, 2} {
		t.Fatalf("per person: %v", people)
	}
	if len(hours) != 24 || !hours[23].Hour.Equal(ts(18, 0)) {
		t.Fatalf("hours window: %v .. %v", hours[0].Hour, hours[23].Hour)
	}
	var at10 usageHour
	for _, h := range hours {
		if h.Hour.Equal(ts(10, 0)) {
			at10 = h
		}
	}
	if at10.People != 2 || at10.Minutes != 75 {
		t.Fatalf("10:00: %+v", at10)
	}
}

func TestUsageRatesParse(t *testing.T) {
	r := usageRates(" a=0.1/0.4 , b=2, bad, c=x/1, d=-1 ")
	if len(r) != 2 || r["a"] != (usageRate{in: 0.1, out: 0.4}) || r["b"] != (usageRate{perMin: 2}) {
		t.Fatalf("%+v", r)
	}
}

// The Postgres side, against a scratch schema (FASTPG_DSN; skipped without one).
func TestUsagePostgres(t *testing.T) {
	st, pool := mfScratchPostgres(t)
	ctx := context.Background()
	if err := st.usageEnsureSchema(ctx, "hackgt13"); err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, email := range []string{"a@x.test", "qa@facemash.test"} {
		a, _, err := st.SignIn(ctx, "hackgt13", user{Sub: email, Email: email, Name: "A"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, a.ID)
	}
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	end := t0.Add(10 * time.Minute)
	rows := []usageSessionRow{
		{ID: "ps_a", UserID: ids[0], Started: t0, Seen: t0.Add(time.Minute), Active: 30, Hall: 10},
		{ID: "ps_q", UserID: ids[1], Started: t0, Seen: end, Ended: &end},
		{ID: "ps_gone", UserID: 999999, Started: t0, Seen: t0}, // no membership: skipped, not an error
	}
	if err := st.usageSaveSessions(ctx, "hackgt13", rows); err != nil {
		t.Fatal(err)
	}
	rows[0].Seen, rows[0].Active = t0.Add(2*time.Minute), 60
	if err := st.usageSaveSessions(ctx, "hackgt13", rows[:1]); err != nil {
		t.Fatal(err)
	}
	got, err := st.usageSessions(ctx, "hackgt13", false)
	if err != nil || len(got) != 1 || got[0].ID != "ps_a" || got[0].Active != 60 || !got[0].Seen.Equal(t0.Add(2*time.Minute)) || got[0].Ended != nil {
		t.Fatalf("sessions: %v %+v", err, got)
	}
	if all, _ := st.usageSessions(ctx, "hackgt13", true); len(all) != 2 {
		t.Fatalf("with test accounts: %+v", all)
	}
	// a restart closes what was open at its last sample
	if err := st.usageEnsureSchema(ctx, "hackgt13"); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.usageSessions(ctx, "hackgt13", false); got[0].Ended == nil || !got[0].Ended.Equal(got[0].Seen) {
		t.Fatalf("boot should end open sessions: %+v", got[0])
	}

	h := t0.Truncate(time.Hour)
	m := []usageMeterRow{{usageMeterKey: usageMeterKey{"gemini", "g", h}, Calls: 2, Failed: 1, TokensIn: 10, TokensOut: 5, Seconds: 0}}
	for i := 0; i < 2; i++ {
		if err := st.usageSaveMeter(ctx, "hackgt13", m); err != nil {
			t.Fatal(err)
		}
	}
	mr, err := st.usageMeterRows(ctx, "hackgt13")
	if err != nil || len(mr) != 1 || mr[0].Calls != 4 || mr[0].Failed != 2 || mr[0].TokensIn != 20 || !mr[0].Hour.Equal(h) {
		t.Fatalf("meter: %v %+v", err, mr)
	}

	// the speed panel reads the talks' own timings
	if err := st.talkEnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	rec := &talkRecord{ID: "tk_speed", Tenant: "hackgt13", A: ids[0], B: ids[1], State: "no_match", Started: time.Now().UTC(),
		Transcript: []talkLine{{Kind: "question", QID: "q001"}, {Kind: "answer", FirstMS: 400, TookMS: 900}, {Kind: "question", QID: "q002"}, {Kind: "answer", FirstMS: 600, TookMS: 1100}},
		Jev:        []talkJevCall{{What: "pick", TookMS: 350, Options: 60}, {What: "pick", TookMS: 1500, Options: 60, Err: "timeout"}, {What: "checkpoint1", TookMS: 200}}}
	if err := st.talkCreate(ctx, rec); err != nil {
		t.Fatal(err)
	}
	tt, err := st.usageTalkTimes(ctx, "hackgt13", time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if sp := usageSpeedOf(tt); sp.Talks != 1 || sp.QuestionsPerTalk != 2 || sp.Picks != 2 || sp.PickFailed != 1 || sp.Answers != 2 || sp.FirstWordsP50MS != 400 {
		t.Fatalf("speed: %+v", sp)
	}

	// deleting an account takes its sessions (cascade)
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, ids[1]); err != nil {
		t.Fatal(err)
	}
	if all, _ := st.usageSessions(ctx, "hackgt13", true); len(all) != 1 {
		t.Fatalf("after delete: %+v", all)
	}
}
