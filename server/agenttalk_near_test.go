package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHub: positions the test moves around by hand.
type fakeHub struct {
	mu sync.Mutex
	at map[int64]talkPos
}

func (f *fakeHub) put(uid int64, room string, x, z float64) { f.putY(uid, room, x, 0, z) }

func (f *fakeHub) putY(uid int64, room string, x, y, z float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.at == nil {
		f.at = map[int64]talkPos{}
	}
	f.at[uid] = talkPos{uid, room, x, y, z}
}

func (f *fakeHub) talkPositions(buf []talkPos) []talkPos {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.at {
		buf = append(buf, p)
	}
	return buf
}

// nearHarness: a scanner over a fake hub, recording every start it attempts.
type nearHarness struct {
	*talkHarness
	hub    *fakeHub
	near   *talkNear
	mu     sync.Mutex
	starts [][2]int64
}

func newNearHarness(t *testing.T) *nearHarness {
	h := &nearHarness{talkHarness: newTalkHarness(t), hub: &fakeHub{}}
	h.near = newTalkNear(h.talk, h.hub, h.tenant)
	h.near.walkOffM = 0 // these tests place players directly; TestTalkNearSpawnIsNotAMeeting covers walking off
	h.talk.near = h.near
	real := h.near.start
	h.near.start = func(ctx context.Context, tenant string, a, b int64) (string, error) {
		h.mu.Lock()
		h.starts = append(h.starts, [2]int64{a, b})
		h.mu.Unlock()
		return real(ctx, tenant, a, b)
	}
	h.near.refreshOpted(time.Now())
	return h
}

// scan runs one scan at now and waits for any encounter calls it made.
func (h *nearHarness) scan(now time.Time) int {
	h.t.Helper()
	n := h.near.scan(now)
	for i := 0; i < 1000; i++ {
		h.near.mu.Lock()
		busy := len(h.near.pending) > 0
		h.near.mu.Unlock()
		if !busy {
			return n
		}
		time.Sleep(2 * time.Millisecond)
	}
	h.t.Fatal("encounter call never returned")
	return n
}

func (h *nearHarness) startCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.starts)
}

func TestTalkNearStartsAfter3mFor3s(t *testing.T) {
	h := newNearHarness(t)
	cfg := h.talk.cfg.Proximity
	if cfg.RadiusM != 3 || cfg.DwellMS != 3000 {
		t.Fatalf("config defaults: %.1f m for %d ms", cfg.RadiusM, cfg.DwellMS)
	}
	t0 := time.Now()
	h.hub.put(h.a, "hackgt", 10, 10)
	h.hub.put(h.b, "hackgt", 12.5, 10) // 2.5 m
	if n := h.scan(t0); n != 0 {
		t.Fatal("started at once")
	}
	if n := h.scan(t0.Add(2900 * time.Millisecond)); n != 0 {
		t.Fatal("started before 3 s")
	}
	if n := h.scan(t0.Add(3 * time.Second)); n != 1 {
		t.Fatal("didn't start after 3 s")
	}
	for _, uid := range []int64{h.a, h.b} {
		h.sink.wait(t, "encounter", func(f sentFrame) bool { return f.msg["t"] == "encounter" && f.uid == uid })
	}
	if h.startCount() != 1 || h.starts[0] != [2]int64{min(h.a, h.b), max(h.a, h.b)} {
		t.Fatalf("starts: %v", h.starts)
	}
	// someone already in a talk (or waiting on approvals) isn't pulled into another
	h.hub.put(h.a, "campus", 500, 500)
	h.hub.put(h.b, "campus", 600, 600)
	h.free(h.a, h.b)
	d, _, _ := h.store.SignIn(context.Background(), h.tenant, user{Sub: "g-d", Email: "d@example.com", Name: "Dee"})
	h.prefs(d.ID, talkPrefs{OptIn: true})
	h.talk.nearOpted(d.ID, talkPrefs{OptIn: true})
	h.talk.mu.Lock()
	h.talk.inTalk[memKey(h.tenant, h.c)] = "tk_other"
	h.talk.mu.Unlock()
	h.hub.put(h.c, "hackgt", 30, 30)
	h.hub.put(d.ID, "hackgt", 31, 30)
	t1 := t0.Add(time.Minute)
	for s := 0; s <= 6; s++ {
		h.scan(t1.Add(time.Duration(s) * time.Second))
	}
	if h.startCount() != 1 {
		t.Fatal("a person in a talk got another one")
	}
	h.talk.mu.Lock()
	delete(h.talk.inTalk, memKey(h.tenant, h.c))
	h.talk.mu.Unlock()
	h.scan(t1.Add(10 * time.Second))
	if h.scan(t1.Add(13*time.Second)) != 1 {
		t.Fatal("free again: should start")
	}
	h.sink.wait(t, "verdict", func(f sentFrame) bool { return f.msg["t"] == "verdict" && f.uid == d.ID })
}

func TestTalkNearNeedsSameRoomFloorAndRange(t *testing.T) {
	h := newNearHarness(t)
	t0 := time.Now()
	cases := []struct {
		name string
		b    talkPos
	}{
		{"3.5 m away", talkPos{h.b, "hackgt", 13.5, 0, 10}},
		{"another room", talkPos{h.b, "campus", 11, 0, 10}},
		{"another floor", talkPos{h.b, "hackgt", 11, 5, 10}},
	}
	for _, c := range cases {
		h.hub.put(h.a, "hackgt", 10, 10)
		h.hub.putY(h.b, c.b.room, c.b.x, c.b.y, c.b.z)
		for s := 0; s <= 10; s++ {
			h.scan(t0.Add(time.Duration(s) * time.Second))
		}
		if h.startCount() != 0 {
			t.Fatalf("%s: started", c.name)
		}
		t0 = t0.Add(time.Minute)
	}
	// walking apart resets the clock
	h.hub.put(h.b, "hackgt", 11, 10)
	h.scan(t0)
	h.scan(t0.Add(2 * time.Second))
	h.hub.put(h.b, "hackgt", 20, 10)
	h.scan(t0.Add(2500 * time.Millisecond))
	h.hub.put(h.b, "hackgt", 11, 10)
	h.scan(t0.Add(3 * time.Second))
	if h.scan(t0.Add(5*time.Second)) != 0 || h.startCount() != 0 {
		t.Fatal("the clock didn't restart when they walked apart")
	}
	if h.scan(t0.Add(6*time.Second)) != 1 {
		t.Fatal("3 s after they came back, it should start")
	}
}

func TestTalkNearBothMustOptIn(t *testing.T) {
	h := newNearHarness(t)
	h.prefs(h.b, talkPrefs{OptIn: false})
	h.near.refreshOpted(time.Now().Add(time.Hour)) // reload now
	t0 := time.Now()
	h.hub.put(h.a, "hackgt", 10, 10)
	h.hub.put(h.b, "hackgt", 11, 10)
	for s := 0; s <= 6; s++ {
		h.scan(t0.Add(time.Duration(s) * time.Second))
	}
	if h.startCount() != 0 {
		t.Fatal("B never opted in")
	}
	// busy counts as off
	h.prefs(h.b, talkPrefs{OptIn: true, Busy: true})
	h.near.refreshOpted(time.Now().Add(2 * time.Hour))
	for s := 7; s <= 12; s++ {
		h.scan(t0.Add(time.Duration(s) * time.Second))
	}
	if h.startCount() != 0 {
		t.Fatal("B is busy")
	}
	// the optin endpoint's switch reaches the scan at once
	h.prefs(h.b, talkPrefs{OptIn: true})
	h.talk.nearOpted(h.b, talkPrefs{OptIn: true})
	for s := 13; s <= 16; s++ {
		h.scan(t0.Add(time.Duration(s) * time.Second))
	}
	if h.startCount() != 1 {
		t.Fatalf("both on: %d starts", h.startCount())
	}
}

func TestTalkNearPairOncePerEventAndDailyCap(t *testing.T) {
	h := newNearHarness(t)
	h.jev.gates = map[string]float64{} // quick no-matches
	ctx := context.Background()
	t0 := time.Now()
	h.hub.put(h.a, "hackgt", 10, 10)
	h.hub.put(h.b, "hackgt", 11, 10)
	h.scan(t0)
	if h.scan(t0.Add(3*time.Second)) != 1 {
		t.Fatal("first talk")
	}
	id := h.sink.wait(t, "verdict", func(f sentFrame) bool { return f.msg["t"] == "verdict" }).msg["id"].(string)
	h.record(id)
	h.free(h.a, h.b)
	// still standing together: never again this event, even after a restart of the scanner
	for s := 4; s <= 12; s++ {
		h.scan(t0.Add(time.Duration(s) * time.Second))
	}
	if h.startCount() != 1 {
		t.Fatalf("the pair talked again: %d", h.startCount())
	}
	fresh := newTalkNear(h.talk, h.hub, h.tenant)
	fresh.walkOffM = 0
	fresh.start = h.near.start
	fresh.refreshOpted(time.Now())
	h.near, h.talk.near = fresh, fresh
	h.scan(t0.Add(20 * time.Second))
	h.scan(t0.Add(24 * time.Second)) // tries once, the store says no
	h.scan(t0.Add(28 * time.Second))
	h.scan(t0.Add(32 * time.Second))
	if h.startCount() != 2 {
		t.Fatalf("after a restart: expected exactly one refused try, got %d starts", h.startCount()-1)
	}
	if n, _ := h.store.talkCount(ctx, h.tenant, h.a, talkDayStart(time.Now()), false); n != 1 {
		t.Fatalf("A's talks: %d", n)
	}

	// daily cap (5 by default, every talk counts): A has used all 5; A and C meet
	h.hub.put(h.b, "campus", 500, 500)
	for i := 0; i < 4; i++ {
		u, _, _ := h.store.SignIn(ctx, h.tenant, user{Sub: fmt.Sprintf("g-cap%d", i), Email: fmt.Sprintf("cap%d@example.com", i), Name: "Cap"})
		rec := &talkRecord{ID: talkID(), Tenant: h.tenant, A: h.a, B: u.ID, State: "no_match", Started: time.Now().UTC(), Timings: map[string]float64{}}
		if err := h.store.talkCreate(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	if left, lim, _ := h.talk.talksLeft(ctx, h.tenant, h.a); left != 0 || lim != 5 {
		t.Fatalf("A: %d of %d left", left, lim)
	}
	if left, _, _ := h.talk.talksLeft(ctx, h.tenant, h.c); left != 5 {
		t.Fatalf("C: %d left", left)
	}
	before := h.startCount()
	h.hub.put(h.c, "hackgt", 10.5, 11)
	t1 := t0.Add(time.Minute)
	h.scan(t1)
	h.scan(t1.Add(3 * time.Second)) // tries, refused: A is at the cap
	for s := 4; s <= 40; s += 4 {
		h.scan(t1.Add(time.Duration(s) * time.Second))
	}
	if h.startCount() != before+1 {
		t.Fatalf("a capped person keeps being tried: %d", h.startCount()-before)
	}
	if n, _ := h.store.talkCount(ctx, h.tenant, h.c, talkDayStart(time.Now()), false); n != 0 {
		t.Fatalf("a refused talk counted for C: %d", n)
	}
	// C (not capped) is still free to meet someone else
	d, _, _ := h.store.SignIn(ctx, h.tenant, user{Sub: "g-d", Email: "d@example.com", Name: "Dee"})
	h.prefs(d.ID, talkPrefs{OptIn: true})
	h.talk.nearOpted(d.ID, talkPrefs{OptIn: true})
	h.hub.put(d.ID, "hackgt", 40, 40)
	h.hub.put(h.c, "hackgt", 41, 40)
	t2 := t1.Add(time.Minute)
	h.scan(t2)
	if h.scan(t2.Add(3*time.Second)) != 1 {
		t.Fatal("C and D should talk")
	}
	h.sink.wait(t, "C's verdict", func(f sentFrame) bool { return f.msg["t"] == "verdict" && f.uid == h.c })
	h.free(h.c, d.ID)
}

func TestTalkPushesReachOnlyThePair(t *testing.T) {
	// through a real Hub: A has two tabs open, B one, C and a guest are in the same room
	hub := newHub()
	mk := func(id int, uid int64) *client {
		c := &client{hub: hub, send: make(chan []byte, 64), joined: true, uid: uid}
		c.p = Player{ID: id, Room: "hackgt"}
		hub.clients[id] = c
		return c
	}
	a1, a2, b, c, guest := mk(1, 11), mk(2, 11), mk(3, 12), mk(4, 13), mk(5, 0)
	sink := hubSink{hub}
	sink.send(11, map[string]any{"t": "agents", "id": "tk_x"})
	sink.send(12, map[string]any{"t": "agents", "id": "tk_x"})
	sink.send(0, map[string]any{"t": "agents", "id": "tk_x"}) // never to guests
	for name, cl := range map[string]*client{"a1": a1, "a2": a2, "b": b} {
		if len(cl.send) != 1 {
			t.Fatalf("%s got %d frames", name, len(cl.send))
		}
	}
	if len(c.send) != 0 || len(guest.send) != 0 {
		t.Fatal("a frame reached someone outside the talk")
	}
	if !sink.online(11) || sink.online(99) {
		t.Fatal("online")
	}

	// a whole talk: every frame is addressed to A or B, never C
	h := newTalkHarness(t)
	id, _ := h.run(h.a, h.b)
	h.record(id)
	for _, f := range h.sink.all() {
		if f.uid != h.a && f.uid != h.b {
			t.Fatalf("frame %s went to #%d", f.raw, f.uid)
		}
	}
}

func TestTalkOptInEndpoint(t *testing.T) {
	h := newNearHarness(t)
	ctx := context.Background()
	u, _, _ := h.store.SignIn(ctx, h.tenant, user{Sub: "g-opt", Email: "opt@example.com", Name: "Opt Person"})
	srv := talkHTTP(t, h.talkHarness, false)
	sess, _ := h.acc.sess.issue(kindSession, u.ID, time.Hour)
	cookie := sessionCookie + "=" + sess
	get := func() string {
		code, body := talkReq(t, "GET", srv.URL+"/api/talk/optin", "", map[string]string{"Cookie": cookie})
		if code != 200 {
			t.Fatalf("get: %d %s", code, body)
		}
		return body
	}
	if b := get(); !strings.Contains(b, `"on":false`) || !strings.Contains(b, `"left":5`) || !strings.Contains(b, `"limit":5`) {
		t.Fatalf("default off, 5 left: %s", b)
	}
	// an agent's token, a missing or foreign Origin, or no session: refused
	tok := newToken()
	h.store.CreateToken(ctx, h.tenant, u.ID, museLabel, hashToken(tok))
	for name, hdr := range map[string]map[string]string{
		"agent token": {"Authorization": "Bearer " + tok, "Origin": "https://site.test"},
		"no origin":   {"Cookie": cookie},
		"bad origin":  {"Cookie": cookie, "Origin": "https://evil.test"},
		"no session":  {"Origin": "https://site.test"},
	} {
		code, _ := talkReq(t, "POST", srv.URL+"/api/talk/optin", `{"on":true}`, hdr)
		if code != http.StatusUnauthorized && code != http.StatusForbidden {
			t.Fatalf("%s: %d", name, code)
		}
	}
	if p, _ := h.store.talkPrefs(ctx, h.tenant, u.ID); p.OptIn {
		t.Fatal("switched on without the human")
	}
	if code, _ := talkReq(t, "POST", srv.URL+"/api/talk/optin", `{}`, map[string]string{"Cookie": cookie, "Origin": "https://site.test"}); code != http.StatusBadRequest {
		t.Fatalf("missing on: %d", code)
	}
	code, body := talkReq(t, "POST", srv.URL+"/api/talk/optin", `{"on":true}`, map[string]string{"Cookie": cookie, "Origin": "https://site.test"})
	if code != 200 || !strings.Contains(body, `"on":true`) {
		t.Fatalf("the human: %d %s", code, body)
	}
	h.near.mu.Lock()
	seen := h.near.opted[u.ID]
	h.near.mu.Unlock()
	if !seen {
		t.Fatal("the scan didn't hear about it")
	}
	talkReq(t, "POST", srv.URL+"/api/talk/optin", `{"on":false}`, map[string]string{"Cookie": cookie, "Origin": "https://site.test"})
	if p, _ := h.store.talkPrefs(ctx, h.tenant, u.ID); p.OptIn {
		t.Fatal("switched off")
	}
	h.near.mu.Lock()
	seen = h.near.opted[u.ID]
	h.near.mu.Unlock()
	if seen {
		t.Fatal("the scan still thinks they're on")
	}
}

// ---------- cost at 1000 players ----------

func benchPlayers(n int) *fakeHub {
	f := &fakeHub{}
	r := rand.New(rand.NewPCG(1, 2))
	for i := 0; i < n; i++ {
		// everyone in the Klaus atrium (about 120 m by 60 m): far denser than the event
		f.put(int64(i+1), "hackgt", r.Float64()*120, r.Float64()*60)
	}
	return f
}

// BenchmarkTalkNearScan: one scan with 1000 opted-in players in one room (no talks start:
// the dwell is never reached).
func BenchmarkTalkNearScan(b *testing.B) {
	cfg, _ := loadTalkConfig("")
	cfg.Proximity.DwellMS = 1 << 30
	t := newAgentTalk(cfg, &accounts{tenant: "hackgt13"}, newMemStore(), &fakeSink{})
	hub := benchPlayers(1000)
	n := newTalkNear(t, hub, "hackgt13")
	n.walkOffM = 0
	for uid := range hub.at {
		n.opted[uid] = true
	}
	n.optedAt = time.Now()
	now := time.Now()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		n.scan(now)
	}
}

// BenchmarkTalkNearSnapshot: the only part under the hub lock, on a real Hub with 1000
// signed-in players.
func BenchmarkTalkNearSnapshot(b *testing.B) {
	hub := newHub()
	for i := 1; i <= 1000; i++ {
		c := &client{hub: hub, joined: true, uid: int64(i)}
		c.p = Player{ID: i, Room: "hackgt", X: float64(i % 120), Z: float64(i % 60)}
		hub.clients[i] = c
	}
	var buf []talkPos
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		buf = hub.talkPositions(buf[:0])
	}
}

// Two people landing on the same spawn spot haven't met: nothing starts until both have
// walked off where they appeared, and then only if they're still close.
func TestTalkNearSpawnIsNotAMeeting(t *testing.T) {
	h := newNearHarness(t)
	h.near.walkOffM = talkWalkOffM
	t0 := time.Now()
	h.hub.put(h.a, "hackgt", 0, 0)
	h.hub.put(h.b, "hackgt", 0.5, 0) // both at the door
	for s := 0; s <= 10; s++ {
		if n := h.scan(t0.Add(time.Duration(s) * time.Second)); n != 0 {
			t.Fatal("started for two people standing at the spawn point")
		}
	}
	h.hub.put(h.a, "hackgt", 6, 0) // a walks in; b still at the door
	h.hub.put(h.b, "hackgt", 6.5, 1)
	t1 := t0.Add(11 * time.Second)
	for s := 0; s <= 3; s++ { // now both have walked off, and are close for 3 s
		h.scan(t1.Add(time.Duration(s) * time.Second))
	}
	if h.startCount() != 1 {
		t.Fatalf("after both walked off and stood together 3 s: %d starts", h.startCount())
	}
}
