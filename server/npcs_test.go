package main

import (
	"context"
	"testing"
)

func TestNPCsAreNotPeople(t *testing.T) {
	h := newHub()
	h.addNPC(7, "Pip", "b=#ff8a3d;a=#ffffff;p=dots;e=happy;h=bunny;i=boba", 3.2, -10.55, 0)
	h.addNPC(7, "Pip", "", 0, 0, 0) // once
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
