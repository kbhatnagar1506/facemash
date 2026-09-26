package main

// Agent talk's web trigger (no Bluetooth): the Hub already knows where every joined player
// is. A talk starts when two signed-in players who BOTH turned agent talk on are in the same
// room, on the same floor, within proximity.radius_m of each other for proximity.dwell_ms
// (talkdata/talk_config.json). Live GPS/steps and keyboard movement both move the bean, so
// both work.
//
// The scan runs in its own goroutine every proximity.scan_ms. It holds the hub lock only to
// copy (uid, room, x, y, z) of the signed-in players (a few microseconds at 1000 players;
// BenchmarkTalkNearSnapshot), then does everything else off the lock, so the 15 Hz tick
// never waits on it. Who is opted in comes from one query every optin_refresh_ms (plus the
// optin endpoint updating it at once), never a query per player.
//
// Before a talk starts, encounter() checks both people again against the store: opted in,
// not busy, online, under the daily cap, not already in a talk, and the pair's first talk of
// the event (the talks table's unique pair key). The scanner remembers the answers so it
// doesn't keep asking: a pair that talked is done for the event, a person at their cap is
// skipped until the next event day, anything else is retried after retry_ms.

import (
	"context"
	"errors"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// talkPos is one signed-in player's position, copied out of the hub.
type talkPos struct {
	uid     int64
	room    string
	x, y, z float64
}

// talkPositions is where the scanner reads positions from (the Hub; a fake in tests).
type talkPositions interface {
	talkPositions(buf []talkPos) []talkPos
}

// talkPositions copies every joined, signed-in player's position (the only work done under
// the hub lock).
func (h *Hub) talkPositions(buf []talkPos) []talkPos {
	h.mu.Lock()
	for _, c := range h.clients {
		if c.joined && c.uid != 0 {
			buf = append(buf, talkPos{c.uid, c.p.Room, c.p.X, c.p.Y, c.p.Z})
		}
	}
	h.mu.Unlock()
	return buf
}

type talkPair [2]int64 // lower uid first

func mkPair(a, b int64) talkPair {
	if a > b {
		a, b = b, a
	}
	return talkPair{a, b}
}

type talkNear struct {
	t      *agentTalk
	src    talkPositions
	tenant string
	// start begins a talk (t.encounter; tests may wrap it).
	start func(ctx context.Context, tenant string, a, b int64) (string, error)

	mu       sync.Mutex // everything below: the scan goroutine and encounter results
	opted    map[int64]bool
	optedAt  time.Time
	since    map[talkPair]time.Time // in range since
	done     map[talkPair]bool      // talked (or tried and the store said they already had)
	retry    map[talkPair]time.Time // don't try before
	capped   map[int64]time.Time    // at their daily cap for the event day starting then
	pending  map[int64]bool         // an encounter call is in flight for them
	prefetch map[talkPair]bool      // hot topics already asked for
	arrived  map[int64]talkPos      // where each player appeared in their current room
	walked   map[int64]bool         // has moved off that spot (spawn points don't count as meeting)
	walkOffM float64                // how far that is (talkWalkOffM; 0 = off, for tests)

	buf  []talkPos // scratch, reused every scan
	grid map[talkCell][]int
	seen map[talkPair]bool
	one  map[int64]bool
	busy map[int64]bool
}

// talkWalkOffM: how far from where they appeared in a room someone must walk before they
// can meet anyone there.
const talkWalkOffM = 2.0

type talkCell struct {
	room string
	x, z int
}

func newTalkNear(t *agentTalk, src talkPositions, tenant string) *talkNear {
	n := &talkNear{
		t: t, src: src, tenant: tenant,
		opted: map[int64]bool{}, since: map[talkPair]time.Time{}, done: map[talkPair]bool{},
		retry: map[talkPair]time.Time{}, capped: map[int64]time.Time{}, pending: map[int64]bool{},
		prefetch: map[talkPair]bool{}, arrived: map[int64]talkPos{}, walked: map[int64]bool{}, walkOffM: talkWalkOffM, grid: map[talkCell][]int{}, seen: map[talkPair]bool{},
		one: map[int64]bool{}, busy: map[int64]bool{},
	}
	n.start = func(ctx context.Context, tenant string, a, b int64) (string, error) {
		return t.encounter(ctx, tenant, a, b, false)
	}
	return n
}

// watchProximity starts the scanner (main.go); it runs for the life of the server.
func (t *agentTalk) watchProximity(src talkPositions) {
	if !t.on() || t.cfg.Proximity.RadiusM <= 0 {
		log.Printf("talk: proximity trigger off")
		return
	}
	n := newTalkNear(t, src, t.acc.tenant)
	t.mu.Lock()
	t.near = n
	t.mu.Unlock()
	log.Printf("talk: proximity trigger on (%.1f m for %d ms, scan every %d ms)", t.cfg.Proximity.RadiusM, t.cfg.Proximity.DwellMS, t.cfg.Proximity.ScanMS)
	go func() {
		tick := time.NewTicker(t.cfg.ms(max(t.cfg.Proximity.ScanMS, 50)))
		defer tick.Stop()
		for now := range tick.C {
			n.refreshOpted(now)
			n.scan(now)
		}
	}()
}

// setOpted records a person's switch at once (the optin endpoint), without waiting for the
// next refresh.
func (n *talkNear) setOpted(uid int64, on bool) {
	if n == nil {
		return
	}
	n.mu.Lock()
	if on {
		n.opted[uid] = true
	} else {
		delete(n.opted, uid)
	}
	n.mu.Unlock()
}

// refreshOpted reloads who is opted in (and not busy), at most every optin_refresh_ms.
func (n *talkNear) refreshOpted(now time.Time) {
	n.mu.Lock()
	fresh := !n.optedAt.IsZero() && now.Sub(n.optedAt) < n.t.cfg.ms(n.t.cfg.Proximity.OptinRefreshMS)
	n.mu.Unlock()
	if fresh {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	ids, err := n.t.ts.talkOptedIn(ctx, n.tenant)
	cancel()
	n.mu.Lock()
	defer n.mu.Unlock()
	n.optedAt = now
	if err != nil {
		log.Printf("talk: proximity: who opted in: %v", err)
		return
	}
	n.opted = make(map[int64]bool, len(ids))
	for _, id := range ids {
		n.opted[id] = true
	}
}

// scan finds pairs that have been close long enough and starts their talks. Returns how
// many it started (tests).
func (n *talkNear) scan(now time.Time) int {
	cfg := &n.t.cfg.Proximity
	r := cfg.RadiusM
	n.buf = n.src.talkPositions(n.buf[:0])

	n.mu.Lock()
	defer n.mu.Unlock()
	day := talkDayStart(now)
	for uid, d := range n.capped {
		if !d.Equal(day) {
			delete(n.capped, uid)
		}
	}
	for p, at := range n.retry {
		if !now.Before(at) {
			delete(n.retry, p)
		}
	}
	// who can talk: opted in, not capped, not starting one, not already in a talk or waiting
	// on one's approvals; each account once (several tabs share a uid)
	one, busy := n.one, n.busy
	clear(one)
	clear(busy)
	n.t.mu.Lock()
	prefix := n.tenant + "/"
	for k := range n.t.inTalk { // a handful: parse them rather than format a key per player
		if rest, ok := strings.CutPrefix(k, prefix); ok {
			if uid, err := strconv.ParseInt(rest, 10, 64); err == nil {
				busy[uid] = true
			}
		}
	}
	for _, run := range n.t.live { // waiting on approvals: their phone is showing that talk
		run.mu.Lock()
		if run.rec.State == "awaiting" && run.rec.Tenant == n.tenant {
			one[run.rec.A], one[run.rec.B] = true, true
		}
		run.mu.Unlock()
	}
	ps := n.buf[:0]
	for _, p := range n.buf {
		// everyone lands on the same spawn spot: only count people who have walked off where
		// they appeared in this room, so arriving together (or an idle tab at the door) isn't a meeting
		if a, ok := n.arrived[p.uid]; !ok || a.room != p.room {
			n.arrived[p.uid], n.walked[p.uid] = p, n.walkOffM <= 0
		} else if !n.walked[p.uid] && math.Hypot(p.x-a.x, p.z-a.z) >= n.walkOffM {
			n.walked[p.uid] = true
		}
		if !n.walked[p.uid] {
			continue
		}
		if !n.opted[p.uid] || n.pending[p.uid] || one[p.uid] {
			continue
		}
		if _, c := n.capped[p.uid]; c {
			continue
		}
		if busy[p.uid] {
			continue
		}
		one[p.uid] = true
		ps = append(ps, p)
	}
	n.t.mu.Unlock()

	// bucket by room and radius-sized cells; only neighbouring cells can hold a close pair
	for k, v := range n.grid {
		n.grid[k] = v[:0] // keep the slices; empty cells cost nothing to look up
	}
	cell := func(v float64) int { return int(math.Floor(v / r)) }
	for i, p := range ps {
		k := talkCell{p.room, cell(p.x), cell(p.z)}
		n.grid[k] = append(n.grid[k], i)
	}
	clear(n.seen)
	type ready struct {
		pair  talkPair
		since time.Time
	}
	var due []ready
	for i, p := range ps {
		cx, cz := cell(p.x), cell(p.z)
		for dx := -1; dx <= 1; dx++ {
			for dz := -1; dz <= 1; dz++ {
				for _, j := range n.grid[talkCell{p.room, cx + dx, cz + dz}] {
					if j <= i {
						continue
					}
					q := ps[j]
					if math.Abs(q.y-p.y) > cfg.FloorGapM || math.Hypot(q.x-p.x, q.z-p.z) > r {
						continue
					}
					pair := mkPair(p.uid, q.uid)
					if n.done[pair] {
						continue
					}
					if _, wait := n.retry[pair]; wait {
						continue
					}
					n.seen[pair] = true
					at, ok := n.since[pair]
					if !ok {
						at = now
						n.since[pair] = now
					}
					// hot topics while they stand there, once they've lingered a moment (not
					// for everyone who merely walks past)
					if !n.prefetch[pair] && now.Sub(at) >= n.t.cfg.ms(cfg.DwellMS)/3 {
						n.prefetch[pair] = true
						n.t.prefetch(n.tenant, pair[0], pair[1])
					}
					if now.Sub(at) >= n.t.cfg.ms(cfg.DwellMS) {
						due = append(due, ready{pair, at})
					}
				}
			}
		}
	}
	for p := range n.since {
		if !n.seen[p] { // walked apart: the clock starts over
			delete(n.since, p)
		}
	}
	// longest-waiting pairs first; each person in at most one new talk
	sort.Slice(due, func(i, j int) bool { return due[i].since.Before(due[j].since) })
	started := 0
	for _, g := range due {
		a, b := g.pair[0], g.pair[1]
		if n.pending[a] || n.pending[b] {
			continue
		}
		n.pending[a], n.pending[b] = true, true
		delete(n.since, g.pair)
		started++
		go n.try(g.pair, now)
	}
	return started
}

// try starts one talk and remembers the answer.
func (n *talkNear) try(pair talkPair, now time.Time) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	a, b := pair[0], pair[1]
	id, err := n.start(ctx, n.tenant, a, b)
	var full []int64
	if errors.Is(err, errTalkCap) {
		for _, uid := range []int64{a, b} {
			if left, _, e := n.t.talksLeft(ctx, n.tenant, uid); e == nil && left <= 0 {
				full = append(full, uid)
			}
		}
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.pending, a)
	delete(n.pending, b)
	switch {
	case err == nil:
		n.done[pair] = true
		log.Printf("talk: proximity: %s started (#%d, #%d)", id, a, b)
	case errors.Is(err, errTalkPair):
		n.done[pair] = true
	case len(full) > 0:
		day := talkDayStart(now)
		for _, uid := range full {
			n.capped[uid] = day
		}
	default:
		n.retry[pair] = now.Add(n.t.cfg.ms(n.t.cfg.Proximity.RetryMS))
		if !errors.Is(err, errTalkBusy) && !errors.Is(err, errTalkOptIn) && !errors.Is(err, errTalkOffline) {
			log.Printf("talk: proximity: #%d, #%d: %v", a, b, err)
		}
	}
}

// talksLeft: how many more agent talks this person can have today, and the limit (0: none).
func (t *agentTalk) talksLeft(ctx context.Context, tenant string, uid int64) (int, int, error) {
	lim := t.cfg.Limits.TalksPerDay
	if lim <= 0 {
		return 1 << 30, 0, nil
	}
	used, err := t.ts.talkCount(ctx, tenant, uid, talkDayStart(time.Now()), false)
	if err != nil {
		return 0, lim, err
	}
	return max(lim-used, 0), lim, nil
}
