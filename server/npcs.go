package main

// NPC attendees: 55 cute, fictional hackers (talkdata/npcs.json) hanging out at the HackGT
// hall's tables, so the room is alive and every visitor has someone to meet. Each is a real
// account at the event (email npc-<slug>@facemash.test, so admin views hide them unless asked
// and -purge-test-accounts removes them) with its own memory, opted in to agent talk. The
// hub holds them as players with no socket; the talk engine lets them talk with real people
// (never with each other), with no daily cap, and they say yes to a match by themselves.
// NPCS=off turns them off.

import (
	"context"
	"encoding/json"
	"log"
	"math"
	mrand "math/rand/v2"
	"strings"
	"time"
)

type npcPersona struct {
	Slug   string         `json:"slug"`
	Name   string         `json:"name"`
	Look   string         `json:"look"`
	Memory map[string]any `json:"memory"`
}

func loadNPCs() []npcPersona {
	b, err := talkFS.ReadFile("talkdata/npcs.json")
	if err != nil {
		return nil
	}
	var out []npcPersona
	if json.Unmarshal(b, &out) != nil {
		return nil
	}
	return out
}

// npcSpots: standing places around the ten hacking tables (hall/layout.ts TABLES: rows at
// z = -12, -6.5, -1, 4.5, 10; columns at x = 3.2, 10.4; 4.4 m x 0.9 m), three along each long
// side, facing the table; the rest spread along the aisle between the columns.
func npcSpots(n int) [][3]float64 {
	var out [][3]float64
	for _, z := range []float64{-12, -6.5, -1, 4.5, 10} {
		for _, x := range []float64{3.2, 10.4} {
			for _, dx := range []float64{-1.5, 0, 1.5} {
				out = append(out, [3]float64{x + dx, z + 1.45, math.Pi}, [3]float64{x + dx, z - 1.45, 0})
			}
		}
	}
	for i := 0; len(out) < n; i++ {
		out = append(out, [3]float64{6.8, -14 + float64(i)*2.5, float64(i%2) * math.Pi})
	}
	return out[:n]
}

// addNPC puts an NPC in the hall as a player (drawn for everyone, no screen of its own).
func (h *Hub) addNPC(uid int64, name, look string, x, z, r float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		if c.npc && c.uid == uid {
			return // already here
		}
	}
	now := time.Now()
	c := &client{hub: h, send: make(chan []byte, 256), npc: true, joined: true, uid: uid, joinedAt: now, lastMove: now}
	c.p = Player{ID: h.nextID, Name: name, Color: "#4f7fd6", X: x, Z: z, R: r, Room: "hackgt", Look: cleanLook(look)}
	h.nextID++
	h.clients[c.p.ID] = c
	h.dirty = true
	go func() {
		for range c.send { // talk frames and room chatter addressed to the NPC: nobody to show them to
		}
	}()
}

// npcFidget: now and then an NPC turns a little (leans in, looks around), so the room breathes.
func (h *Hub) npcFidget() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		if c.npc && mrand.IntN(4) == 0 {
			c.p.R += (mrand.Float64() - 0.5) * 0.9
			h.dirty = true
		}
	}
}

// startNPCs makes (or refreshes) the NPC accounts once the database is up, then seats them.
func startNPCs(acc *accounts, hub *Hub) {
	if strings.EqualFold(envOr("NPCS", "on"), "off") || acc == nil || hub == nil {
		return
	}
	personas := loadNPCs()
	if len(personas) == 0 {
		return
	}
	go func() {
		if !acc.waitReady(10 * time.Minute) {
			log.Printf("npcs: database never came up; no NPCs")
			return
		}
		ts, _ := acc.store.(talkStore)
		spots := npcSpots(len(personas))
		var ids []int64
		for i, p := range personas {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			a, _, err := acc.store.SignIn(ctx, acc.tenant, user{Sub: "npc:" + p.Slug, Email: "npc-" + p.Slug + testEmailSuffix, Name: p.Name, Given: p.Name})
			if err != nil {
				cancel()
				log.Printf("npcs: %s: %v", p.Slug, err)
				continue
			}
			acc.store.SaveProfile(ctx, acc.tenant, a.ID, Profile{Name: p.Name, Color: "#4f7fd6", Look: cleanLook(p.Look)})
			if info, err := acc.store.MemoryInfo(ctx, acc.tenant, a.ID); err == nil && info["stored"] != true && len(p.Memory) > 0 {
				p.Memory["source"] = "npc"
				if raw, err := json.Marshal(p.Memory); err == nil {
					acc.store.SaveMemory(ctx, acc.tenant, a.ID, raw, nil)
				}
			}
			if ts != nil {
				ts.talkSavePrefs(ctx, acc.tenant, a.ID, talkPrefs{OptIn: true})
			}
			cancel()
			ids = append(ids, a.ID)
			s := spots[i]
			hub.addNPC(a.ID, p.Name, p.Look, s[0], s[1], s[2])
		}
		if acc.talk != nil {
			acc.talk.setNPCs(ids)
		}
		log.Printf("npcs: %d at the HackGT tables", len(ids))
		for range time.Tick(3 * time.Second) {
			hub.npcFidget()
		}
	}()
}
