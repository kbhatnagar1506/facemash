package main

// NPC life: the hall's NPCs spread out and wander (walk to a seat at a table and hack for a
// while, stand around the room, wave at people), and the rest are outside on campus running,
// cycling and walking the real paths near Klaus. The hub moves them 10 times a second.
//
// Where they can go comes from two files made from the game's own map data:
//   - talkdata/hall_grid.json: the hall's walkable ground-floor cells (scripts/hall_grid.mts,
//     from the HallCollider the client uses), searched breadth-first for a route.
//   - talkdata/campus_walk.json: the footpath and road network within ~380 m of Klaus
//     (scripts/campus_walk.py, from campus.json), searched with Dijkstra.

import (
	"container/heap"
	"encoding/json"
	"math"
	mrand "math/rand/v2"
	"time"
)

// Activities, sent in the position frame's moving byte (bit 0 moving, bits 1-3 activity).
const (
	actNone uint8 = iota
	actRun
	actBike
	actSit
	actWave
)

const npcTick = 100 * time.Millisecond

// ---------- the hall ----------

type hallGrid struct {
	X0, Z0, Step float64
	Rows         []string
	w, h         int
	open         []int // walkable cell indexes
}

func loadHallGrid() *hallGrid {
	b, err := talkFS.ReadFile("talkdata/hall_grid.json")
	if err != nil {
		return nil
	}
	var g hallGrid
	if json.Unmarshal(b, &g) != nil || len(g.Rows) == 0 || g.Step <= 0 {
		return nil
	}
	g.h, g.w = len(g.Rows), len(g.Rows[0])
	for k, r := range g.Rows {
		for i := 0; i < len(r) && i < g.w; i++ {
			if r[i] == '.' {
				g.open = append(g.open, k*g.w+i)
			}
		}
	}
	return &g
}

func (g *hallGrid) ok(i, k int) bool {
	return i >= 0 && k >= 0 && i < g.w && k < g.h && i < len(g.Rows[k]) && g.Rows[k][i] == '.'
}

func (g *hallGrid) at(c int) (float64, float64) {
	return g.X0 + float64(c%g.w)*g.Step, g.Z0 + float64(c/g.w)*g.Step
}

// snap: the nearest walkable cell to (x, z), or -1.
func (g *hallGrid) snap(x, z float64) int {
	ci, ck := int(math.Round((x-g.X0)/g.Step)), int(math.Round((z-g.Z0)/g.Step))
	for r := 0; r <= 8; r++ {
		for di := -r; di <= r; di++ {
			for dk := -r; dk <= r; dk++ {
				if max(abs(di), abs(dk)) == r && g.ok(ci+di, ck+dk) {
					return (ck+dk)*g.w + ci + di
				}
			}
		}
	}
	return -1
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func (g *hallGrid) clear(ax, az, bx, bz float64) bool {
	n := int(math.Ceil(math.Hypot(bx-ax, bz-az) / (g.Step / 2)))
	for i := 1; i < n; i++ {
		t := float64(i) / float64(n)
		c := g.snapExact(ax+(bx-ax)*t, az+(bz-az)*t)
		if !c {
			return false
		}
	}
	return true
}

func (g *hallGrid) snapExact(x, z float64) bool {
	return g.ok(int(math.Round((x-g.X0)/g.Step)), int(math.Round((z-g.Z0)/g.Step)))
}

// path: waypoints from (fx, fz) to (tx, tz) around everything, trimmed to the turns; nil if
// there's no way.
func (g *hallGrid) path(fx, fz, tx, tz float64) [][2]float64 {
	s, e := g.snap(fx, fz), g.snap(tx, tz)
	if s < 0 || e < 0 {
		return nil
	}
	prev := make([]int32, g.w*g.h)
	for i := range prev {
		prev[i] = -1
	}
	prev[s] = int32(s)
	q := []int{s}
	dirs := [8][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {1, -1}, {-1, 1}, {-1, -1}}
	for j := 0; j < len(q) && prev[e] < 0; j++ {
		c := q[j]
		i, k := c%g.w, c/g.w
		for _, d := range dirs {
			ni, nk := i+d[0], k+d[1]
			if !g.ok(ni, nk) || prev[nk*g.w+ni] >= 0 {
				continue
			}
			if d[0] != 0 && d[1] != 0 && (!g.ok(i+d[0], k) || !g.ok(i, k+d[1])) {
				continue // no cutting corners
			}
			prev[nk*g.w+ni] = int32(c)
			q = append(q, nk*g.w+ni)
		}
	}
	if prev[e] < 0 {
		return nil
	}
	var cells []int
	for c := e; ; c = int(prev[c]) {
		cells = append(cells, c)
		if c == s {
			break
		}
	}
	var out [][2]float64
	ax, az := fx, fz
	for j := len(cells) - 2; j >= 0; j-- {
		x, z := g.at(cells[j])
		if !g.clear(ax, az, x, z) {
			px, pz := g.at(cells[j+1])
			out = append(out, [2]float64{px, pz})
			ax, az = px, pz
		}
	}
	return append(out, [2]float64{tx, tz})
}

// ---------- the campus ----------

type campusWalk struct {
	Center [2]float64    `json:"center"`
	Nodes  [][2]float64  `json:"nodes"`
	Edges  [][3]int      `json:"edges"`
	adj    [][]campusArc // per node
}

type campusArc struct {
	to   int
	d    float64
	foot bool
}

func loadCampusWalk() *campusWalk {
	b, err := talkFS.ReadFile("talkdata/campus_walk.json")
	if err != nil {
		return nil
	}
	var w campusWalk
	if json.Unmarshal(b, &w) != nil || len(w.Nodes) == 0 {
		return nil
	}
	w.adj = make([][]campusArc, len(w.Nodes))
	for _, e := range w.Edges {
		a, c := e[0], e[1]
		if a < 0 || c < 0 || a >= len(w.Nodes) || c >= len(w.Nodes) {
			continue
		}
		d := math.Hypot(w.Nodes[a][0]-w.Nodes[c][0], w.Nodes[a][1]-w.Nodes[c][1])
		w.adj[a] = append(w.adj[a], campusArc{c, d, e[2] == 1})
		w.adj[c] = append(w.adj[c], campusArc{a, d, e[2] == 1})
	}
	return &w
}

// campusRange: campus NPCs stay within this far of Klaus, where everyone starts.
const campusRange = 190.0

// nearKlaus: a random node within campusRange of Klaus; with from >= 0, one 40-220 m from
// (x, z) if there is one.
func (w *campusWalk) nearKlaus(from int, x, z float64) int {
	best := -1
	for try := 0; try < 60; try++ {
		t := mrand.IntN(len(w.Nodes))
		n := w.Nodes[t]
		if math.Hypot(n[0]-w.Center[0], n[1]-w.Center[1]) > campusRange {
			continue
		}
		if best < 0 && t != from {
			best = t
		}
		if from < 0 {
			return t
		}
		if d := math.Hypot(n[0]-x, n[1]-z); d > 40 && d < 220 {
			return t
		}
	}
	if best < 0 {
		best = 0
	}
	return best
}

type pqItem struct {
	n int
	d float64
}
type pq []pqItem

func (p pq) Len() int           { return len(p) }
func (p pq) Less(i, j int) bool { return p[i].d < p[j].d }
func (p pq) Swap(i, j int)      { p[i], p[j] = p[j], p[i] }
func (p *pq) Push(x any)        { *p = append(*p, x.(pqItem)) }
func (p *pq) Pop() any          { o := *p; it := o[len(o)-1]; *p = o[:len(o)-1]; return it }

// route: the node path from a to b. Walkers and runners stay on footpaths when they can
// (roads cost four times as much); cyclists prefer the roads.
func (w *campusWalk) route(a, b int, bike bool) []int {
	dist := make([]float64, len(w.Nodes))
	prev := make([]int, len(w.Nodes))
	for i := range dist {
		dist[i], prev[i] = math.Inf(1), -1
	}
	dist[a] = 0
	h := &pq{{a, 0}}
	for h.Len() > 0 {
		it := heap.Pop(h).(pqItem)
		if it.n == b {
			break
		}
		if it.d > dist[it.n] {
			continue
		}
		for _, e := range w.adj[it.n] {
			cost := e.d
			if e.foot == bike {
				cost *= 4
			}
			if nd := it.d + cost; nd < dist[e.to] {
				dist[e.to], prev[e.to] = nd, it.n
				heap.Push(h, pqItem{e.to, nd})
			}
		}
	}
	if prev[b] < 0 && a != b {
		return nil
	}
	var out []int
	for n := b; n != a; n = prev[n] {
		out = append(out, n)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// ---------- the NPCs ----------

// npcBrain: what one NPC is doing. Only the hub's NPC loop touches it (under h.mu).
type npcBrain struct {
	kind  string // "hall", or on campus "walk", "run", "bike"
	path  [][2]float64
	speed float64
	act   uint8 // while moving
	until time.Time
	seat  int // hall: the seat it's heading for or sitting at (-1: none)
	node  int // campus: the graph node it's at or heading for
}

type npcWorld struct {
	hall   *hallGrid
	campus *campusWalk
	seats  [][3]float64 // hall table seats: x, z, facing
	taken  map[int]bool // seats someone is using or walking to
	// touched: when each NPC and player were last in contact (npc_chat.go), keyed npc, player
	touched map[[2]int64]time.Time
}

// place: where NPC i starts, and what it does. About 45% are outside on campus (runners,
// cyclists and walkers in turn); the rest spread through the hall.
func (w *npcWorld) place(i int, spot [3]float64) (b *npcBrain, room string, x, z, r float64) {
	r = mrand.Float64() * 2 * math.Pi
	if w.campus != nil && (w.hall == nil || i%9 < 4) {
		b = &npcBrain{kind: [...]string{"run", "bike", "walk", "walk"}[i%9], seat: -1}
		b.node = w.campus.nearKlaus(-1, 0, 0)
		p := w.campus.Nodes[b.node]
		b.until = time.Now().Add(time.Duration(mrand.IntN(5000)) * time.Millisecond)
		return b, "campus", p[0], p[1], r
	}
	b = &npcBrain{kind: "hall", seat: -1}
	b.until = time.Now().Add(time.Duration(mrand.IntN(8000)) * time.Millisecond)
	if w.hall != nil && len(w.hall.open) > 0 {
		x, z = w.hall.at(w.hall.open[mrand.IntN(len(w.hall.open))])
		return b, "hackgt", x, z, r
	}
	return b, "hackgt", spot[0], spot[1], spot[2]
}

// next: the NPC arrived (or finished resting); pick what to do now.
func (w *npcWorld) next(b *npcBrain, p *Player, now time.Time) {
	if b.kind == "hall" {
		if b.seat >= 0 {
			delete(w.taken, b.seat)
			b.seat = -1
		}
		if w.hall == nil {
			b.until = now.Add(time.Minute)
			return
		}
		var tx, tz float64
		if len(w.seats) > 0 && mrand.IntN(10) < 4 {
			// a free seat at a table, to hack for a while
			for try := 0; try < 8; try++ {
				s := mrand.IntN(len(w.seats))
				if !w.taken[s] {
					b.seat = s
					w.taken[s] = true
					break
				}
			}
		}
		if b.seat >= 0 {
			tx, tz = w.seats[b.seat][0], w.seats[b.seat][1]
		} else {
			// somewhere else in the room, not too far
			for try := 0; try < 20; try++ {
				tx, tz = w.hall.at(w.hall.open[mrand.IntN(len(w.hall.open))])
				if math.Hypot(tx-p.X, tz-p.Z) < 22 {
					break
				}
			}
		}
		b.path = w.hall.path(p.X, p.Z, tx, tz)
		b.speed, b.act = 1.2+mrand.Float64()*0.4, actNone
		if b.path == nil {
			if b.seat >= 0 {
				delete(w.taken, b.seat)
				b.seat = -1
			}
			b.until = now.Add(5 * time.Second)
		}
		return
	}
	// campus: somewhere 40-220 m away along the paths, staying around Klaus
	c := w.campus
	target := c.nearKlaus(b.node, p.X, p.Z)
	route := c.route(b.node, target, b.kind == "bike")
	b.path = b.path[:0]
	for _, n := range route {
		b.path = append(b.path, c.Nodes[n])
	}
	b.node = target
	switch b.kind {
	case "run":
		b.speed, b.act = 3.6+mrand.Float64()*1.2, actRun
	case "bike":
		b.speed, b.act = 6.5+mrand.Float64()*2, actBike
	default:
		b.speed, b.act = 1.3+mrand.Float64()*0.4, actNone
	}
	if len(b.path) == 0 {
		b.until = now.Add(3 * time.Second)
	}
}

// step moves one NPC along its path; true if anything about it changed.
func (w *npcWorld) step(b *npcBrain, p *Player, now time.Time, dt float64) bool {
	if len(b.path) == 0 {
		if now.Before(b.until) {
			if b.kind != "hall" || b.seat < 0 {
				// resting: now and then turn a little, or wave
				if mrand.IntN(40) == 0 {
					p.R += (mrand.Float64() - 0.5) * 1.2
					return true
				}
				if p.A == actWave && mrand.IntN(25) == 0 || p.A == actNone && mrand.IntN(400) == 0 {
					p.A ^= actWave
					return true
				}
			}
			return false
		}
		w.next(b, p, now)
		p.A = b.act
		return true
	}
	left := b.speed * dt
	for left > 0 && len(b.path) > 0 {
		t := b.path[0]
		dx, dz := t[0]-p.X, t[1]-p.Z
		d := math.Hypot(dx, dz)
		if d > 1e-3 {
			p.R = math.Atan2(dx, dz)
		}
		if d <= left {
			p.X, p.Z = t[0], t[1]
			b.path = b.path[1:]
			left -= d
			continue
		}
		p.X += dx / d * left
		p.Z += dz / d * left
		left = 0
	}
	p.M = true
	if len(b.path) == 0 {
		// arrived: sit and hack, or rest a bit
		p.M, p.A = false, actNone
		switch {
		case b.kind == "hall" && b.seat >= 0:
			p.R, p.A = w.seats[b.seat][2], actSit
			b.until = now.Add(time.Duration(40+mrand.IntN(100)) * time.Second)
		case b.kind == "hall":
			b.until = now.Add(time.Duration(6+mrand.IntN(30)) * time.Second)
		default:
			b.until = now.Add(time.Duration(2+mrand.IntN(12)) * time.Second)
		}
	}
	return true
}

// npcLive moves every NPC, forever (started by startNPCs), and opens a chat when a player
// walks right up to one (npc_chat.go).
func (h *Hub) npcLive(w *npcWorld, tenant string) {
	t := time.NewTicker(npcTick)
	defer t.Stop()
	last := time.Now()
	for now := range t.C {
		dt := math.Min(now.Sub(last).Seconds(), 0.5)
		last = now
		h.mu.Lock()
		for _, c := range h.clients {
			if c.npc && c.brain != nil && w.step(c.brain, &c.p, now, dt) {
				h.dirty = true
			}
		}
		var met []npcContact
		if w.touched != nil {
			met = w.npcContacts(h, now)
		}
		h.mu.Unlock()
		for _, k := range met {
			go conns.openNPCChat(tenant, k)
		}
	}
}
