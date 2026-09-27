package main

import (
	"context"
	"math"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestNPCsAreNotPeople(t *testing.T) {
	h := newHub()
	h.addNPC(7, "Pip", "b=#ff8a3d;a=#ffffff;p=dots;e=happy;h=bunny;i=boba", "hackgt", 3.2, -10.55, 0, nil)
	h.addNPC(7, "Pip", "", "hackgt", 0, 0, 0, nil) // once
	if n := len(h.clients); n != 1 {
		t.Fatalf("clients: %d", n)
	}
	if c := h.counts(); c["online"] != 0 || c["hackgt"] != 0 {
		t.Fatalf("NPCs aren't counted as people online: %v", c)
	}
	if p := h.usagePresent(); len(p) != 0 {
		t.Fatalf("NPCs don't count in usage: %v", p)
	}
	if got := h.talkPositions(nil); len(got) != 1 || got[0].uid != 7 || got[0].room != "hackgt" {
		t.Fatalf("but agents can meet them: %v", got)
	}
	if s := npcSpots(55); len(s) != 55 || s[0] == s[1] {
		t.Fatalf("spots: %d", len(s))
	}
}

func TestNPCsHaveNoDailyCap(t *testing.T) {
	h := newTalkHarness(t)
	h.talk.cfg.Limits.TalksPerDay = 1
	id, _ := h.run(h.a, h.b)
	h.record(id)
	if _, err := h.talk.encounter(context.Background(), h.tenant, h.a, h.c, false); err == nil {
		t.Fatal("a person is capped after their daily talk")
	}
	h.talk.setNPCs([]int64{h.a})
	if _, err := h.talk.encounter(context.Background(), h.tenant, h.a, h.c, false); err != nil {
		t.Fatalf("an NPC isn't: %v", err)
	}
}

// The hall's NPCs walk around tables, not through them, and sit down at seats; campus NPCs
// run, cycle and walk along the paths near Klaus.
func TestNPCsMoveAround(t *testing.T) {
	w := &npcWorld{hall: loadHallGrid(), campus: loadCampusWalk(), seats: npcSpots(60), taken: map[int]bool{}}
	if w.hall == nil || len(w.hall.open) < 1000 || w.campus == nil || len(w.campus.Nodes) < 500 {
		t.Fatal("the hall grid and campus paths should load")
	}
	rooms := map[string]int{}
	kinds := map[string]int{}
	for i := 0; i < 55; i++ {
		b, room, _, _, _ := w.place(i, [3]float64{})
		rooms[room]++
		kinds[b.kind]++
	}
	if rooms["campus"] < 15 || rooms["hackgt"] < 25 || kinds["run"] == 0 || kinds["bike"] == 0 || kinds["walk"] == 0 {
		t.Fatalf("spread: %v %v", rooms, kinds)
	}
	// a hall walk never steps on a blocked cell and gets where it's going
	for n := 0; n < 30; n++ {
		b, _, x, z, _ := w.place(n*9+5, [3]float64{})
		p := &Player{X: x, Z: z}
		now := time.Now()
		b.until = now
		sat, moved := false, 0.0
		for k := 0; k < 3000 && !sat; k++ {
			px, pz := p.X, p.Z
			w.step(b, p, now, 0.1)
			moved += math.Hypot(p.X-px, p.Z-pz)
			if len(b.path) > 0 && !w.hall.snapExact(p.X, p.Z) && w.hall.snap(p.X, p.Z) < 0 {
				t.Fatalf("walked off the floor at %.1f,%.1f", p.X, p.Z)
			}
			if p.A == actSit {
				sat = true
			}
			if len(b.path) == 0 {
				now = b.until // skip the rest
			}
		}
		if moved == 0 {
			t.Fatal("a hall NPC never moved")
		}
	}
	// campus: a cyclist rides at bike speed, flagged as a bike
	b := &npcBrain{kind: "bike", seat: -1, node: 0}
	p0 := w.campus.Nodes[0]
	p := &Player{X: p0[0], Z: p0[1]}
	now := time.Now()
	w.step(b, p, now, 0.1) // picks a ride
	if p.A != actBike || len(b.path) == 0 {
		t.Fatalf("cyclist: act %d path %d", p.A, len(b.path))
	}
	x, z := p.X, p.Z
	for k := 0; k < 10; k++ {
		w.step(b, p, now, 0.1)
	}
	if d := math.Hypot(p.X-x, p.Z-z); d < 3 || d > 9 || !p.M {
		t.Fatalf("a second on a bike covers 6.5-8.5 m, got %.1f", d)
	}
}

// Walking right up to an NPC: it stops, turns to you and waves, and a chat opens with its
// hello (once per pair); passing by at a distance, or staying in contact, does nothing more.
func TestNPCContactOpensChat(t *testing.T) {
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13"}
	ctx := context.Background()
	npc, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "npc:pip", Email: "npc-pip" + testEmailSuffix, Name: "Pip", Given: "Pip"})
	me, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "me", Email: "me@x.test", Name: "Dana", Given: "Dana"})
	hub := newHub()
	mountConnections(http.NewServeMux(), acc, hub, func(*http.Request) bool { return true })
	defer func() { conns = nil }()
	w := &npcWorld{seats: npcSpots(60), taken: map[int]bool{}, touched: map[[2]int64]time.Time{}}
	hub.addNPC(npc.ID, "Pip", "", "hackgt", 0, 0, 0, &npcBrain{kind: "hall", seat: -1, path: [][2]float64{{5, 5}}})
	// a signed-in player, 3 m away: not in contact
	hub.mu.Lock()
	p := &client{hub: hub, send: make(chan []byte, 16), joined: true, uid: me.ID}
	p.p = Player{ID: hub.nextID, Name: "Dana", X: 3, Z: 0, Room: "hackgt"}
	hub.nextID++
	hub.clients[p.p.ID] = p
	now := time.Now()
	if got := w.npcContacts(hub, now); len(got) != 0 {
		hub.mu.Unlock()
		t.Fatalf("3 m away is not contact: %v", got)
	}
	p.p.X = 1 // a bean's width: contact
	got := w.npcContacts(hub, now)
	var n *client
	for _, c := range hub.clients {
		if c.npc {
			n = c
		}
	}
	again := w.npcContacts(hub, now.Add(time.Second)) // still touching
	hub.mu.Unlock()
	if len(got) != 1 || got[0].playerUID != me.ID || got[0].npcUID != npc.ID {
		t.Fatalf("contact: %v", got)
	}
	if len(again) != 0 {
		t.Fatal("staying in contact doesn't reopen the chat")
	}
	if n.brain.path != nil || n.p.M || n.p.A != actWave || math.Abs(n.p.R-math.Pi/2) > 1e-9 {
		t.Fatalf("the NPC stops, faces you and waves: path %v moving %v act %d r %.2f", n.brain.path, n.p.M, n.p.A, n.p.R)
	}
	// the chat: one thread with the NPC's hello, reused on the next contact; your game hears
	conns.openNPCChat("hackgt13", got[0])
	conns.openNPCChat("hackgt13", got[0])
	rows, _ := store.connList(ctx, "hackgt13", me.ID)
	if len(rows) != 1 || rows[0].last == nil || rows[0].last.From != npc.ID || !strings.Contains(rows[0].last.Text, "Pip") {
		t.Fatalf("one chat, opened by Pip's hello: %+v", rows)
	}
	pings := 0
	for len(p.send) > 0 {
		if m := <-p.send; strings.Contains(string(m), `"t":"npc"`) {
			pings++
		}
	}
	if pings != 2 {
		t.Fatalf("your game is told both times: %d", pings)
	}
}
