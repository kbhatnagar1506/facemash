package main

// Bumping into an NPC: walk right up to one of the AI attendees and it stops, turns to you
// and says hi, like someone you just met at a table. That opens a chat between the two of
// you (it's on /chats too, and the NPC answers every message from its own memory), and your
// game shows the chat right there. Contact means close: about a bean's width apart.

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"strings"
	"time"
)

const (
	npcContactHall   = 1.3 // metres, in the hall (beans are scaled down to people size there)
	npcContactCampus = 2.0
	npcContactAgain  = 90 * time.Second // apart this long, then touching again re-opens the chat
	npcChatPause     = 25 * time.Second // the NPC stays put to talk
)

type npcContact struct {
	npcUID, npcPID, playerUID int64
	npcName                   string
}

// npcContacts finds new contacts between NPCs and signed-in players (under h.mu). The NPC
// stops and turns to the player; the caller opens the chat outside the lock.
func (w *npcWorld) npcContacts(h *Hub, now time.Time) []npcContact {
	var out []npcContact
	for _, n := range h.clients {
		if !n.npc || n.brain == nil {
			continue
		}
		for _, c := range h.clients {
			if c.npc || !c.joined || c.uid == 0 || c.p.Room != n.p.Room || math.Abs(c.p.Y-n.p.Y) > 1.5 {
				continue
			}
			r := npcContactCampus
			if n.p.Room == "hackgt" {
				r = npcContactHall
			}
			if math.Hypot(c.p.X-n.p.X, c.p.Z-n.p.Z) > r {
				continue
			}
			key := [2]int64{n.uid, c.uid}
			seen, ok := w.touched[key]
			w.touched[key] = now
			if ok && now.Sub(seen) < npcContactAgain {
				continue // still touching, or only just apart
			}
			// stop, face them, wave (a seated NPC stays seated and just turns)
			b := n.brain
			b.path = nil
			if b.until.Before(now.Add(npcChatPause)) {
				b.until = now.Add(npcChatPause)
			}
			n.p.M = false
			n.p.R = math.Atan2(c.p.X-n.p.X, c.p.Z-n.p.Z)
			if n.p.A != actSit {
				n.p.A = actWave
			}
			h.dirty = true
			out = append(out, npcContact{npcUID: n.uid, npcPID: int64(n.p.ID), playerUID: c.uid, npcName: n.p.Name})
		}
	}
	return out
}

// openNPCChat makes sure the player and the NPC have a chat (one per pair), has the NPC say
// hi if it's new, and tells the player's game to show it.
func (c *connections) openNPCChat(tenant string, k npcContact) {
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ts, _ := c.acc.store.(talkStore)
	if ts == nil {
		return
	}
	var rec *talkRecord
	if rows, err := c.st.connList(ctx, tenant, k.playerUID); err == nil {
		for _, row := range rows {
			if row.rec.A == k.npcUID || row.rec.B == k.npcUID {
				rec = row.rec
				break
			}
		}
	}
	if rec == nil {
		now := time.Now().UTC()
		// Forced: a chat from bumping into someone doesn't use up the pair's one agent talk
		rec = &talkRecord{ID: talkID(), Tenant: tenant, A: k.npcUID, B: k.playerUID, State: "revealed", Started: now, Ended: &now, Forced: true}
		if err := ts.talkCreate(ctx, rec); err != nil {
			log.Printf("npc chat: %v", err)
			return
		}
		if _, err := c.post(ctx, tenant, connMsg{Talk: rec.ID, From: k.npcUID, Text: c.npcHello(ctx, tenant, k)}, rec); err != nil {
			log.Printf("npc chat: %s: hello: %v", rec.ID, err)
		}
	}
	if c.hub != nil {
		c.hub.sendUID(k.playerUID, mustJSON(map[string]any{"t": "npc", "talk": rec.ID, "pid": k.npcPID, "name": k.npcName}))
	}
}

// npcHello: the NPC's first line to someone who walked up, from its own memory.
func (c *connections) npcHello(ctx context.Context, tenant string, k npcContact) string {
	plain := "Oh hey! I'm " + k.npcName + ". What are you building this weekend?"
	t := c.acc.talk
	ts, _ := c.acc.store.(talkStore)
	if t == nil || t.gem == nil || ts == nil {
		return plain
	}
	them, err := t.person(ctx, tenant, k.playerUID)
	if err != nil {
		return plain
	}
	raw, _ := ts.talkMemory(ctx, tenant, k.npcUID)
	var notes map[string]any
	if json.Unmarshal(raw, &notes) != nil {
		return plain
	}
	sys := "You are " + k.npcName + ", an attendee at HackGT 13. " + them.name + " just walked right up to you. " +
		"Say hi in one or two short, warm, casual sentences, like meeting someone at a hackathon table: who you are " +
		"and one specific thing you're into or working on (from YOUR NOTES), then ask them something. No contact details, no links."
	text, _, err := t.gem.hedged(ctx, t.cfg.Models.Agent, t.cfg.Models.AgentFallback, t.cfg.ms(t.cfg.Models.WriterTimeoutMS/2), sys,
		"YOUR NOTES:\n"+jevState(notes)+"\n\nYour hello:", nil, nil)
	if text = strings.TrimSpace(strings.Trim(strings.TrimSpace(text), "\"")); err != nil || text == "" {
		return plain
	}
	return text
}
