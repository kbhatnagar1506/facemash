package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestJevToLook(t *testing.T) {
	look, err := jevToLook(map[string]lookPick{
		"hat": {Choice: "propeller"}, "item": {Choice: "coffee"}, "eyes": {Choice: "sleepy"},
		"pattern": {Choice: "split"}, "body": {Choice: "blue"}, "accent": {Choice: "gold"},
	})
	if err != nil || look != "b=#4f7fd6;a=#ffe066;p=split;e=sleepy;h=propeller;i=coffee" {
		t.Fatalf("look %q err %v", look, err)
	}
	// an accent equal to the body would vanish: swapped for white
	look, _ = jevToLook(map[string]lookPick{
		"hat": {Choice: "none"}, "item": {Choice: "none"}, "eyes": {Choice: "dots"},
		"pattern": {Choice: "solid"}, "body": {Choice: "coral"}, "accent": {Choice: "coral"},
	})
	if !strings.Contains(look, "a=#ffffff") {
		t.Fatalf("same accent: %q", look)
	}
	if _, err := jevToLook(map[string]lookPick{"hat": {Choice: "sombrero"}}); err == nil {
		t.Fatal("an option the studio doesn't have must be refused")
	}
}

func TestJevState(t *testing.T) {
	obj := map[string]any{
		"user_md":   "I build robots.",
		"memory_md": strings.Repeat("x", 50_000),
		"bank":      map[string]any{"opinions": "Rust > Go"},
		"daily_notes": []any{
			map[string]any{"date": "2026-09-01", "content": "old"},
			map[string]any{"date": "2026-09-25", "content": "new"},
		},
	}
	s := jevState(obj)
	if len(s) > jevStateMax || !strings.HasPrefix(s, "About me:\nI build robots.") || !strings.Contains(s, "Rust > Go") {
		t.Fatalf("state (%d chars): %.120q", len(s), s)
	}
	if jevState(map[string]any{}) != "" {
		t.Fatal("empty upload should give empty state")
	}
}

// Live: JEV_LIVE_KEY_FILE=<path> go test -run TestJevLive -v (skipped otherwise).
func TestJevLive(t *testing.T) {
	f := os.Getenv("JEV_LIVE_KEY_FILE")
	if f == "" {
		t.Skip("set JEV_LIVE_KEY_FILE to call the real jev")
	}
	t.Setenv("JEV_API_KEY_FILE", f)
	j := openJev(&accounts{store: newMemStore(), tenant: "t"})
	if j == nil {
		t.Fatal("jev did not turn on")
	}
	for _, mem := range []map[string]any{
		{"user_md": "Second-year Georgia Tech CS student. Building a robot arm that sorts recycling. Up till 4am fixing servo jitter. Runs on cold brew. Favourite colour: deep blue."},
		{"user_md": "Design student who loves boba and making cute pixel art. Very social, always organising the team's karaoke night. Pink everything."},
		{"user_md": "Won three hackathons this year; ML researcher; very competitive; wears all black; energy drinks through the night."},
	} {
		start := time.Now()
		look, why, err := j.decide(context.Background(), jevState(mem))
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%4dms %s  hat=%s(%.2f) item=%s(%.2f) body=%s", time.Since(start).Milliseconds(), look, why["hat"].Choice, why["hat"].Confidence, why["item"].Choice, why["item"].Confidence, why["body"].Choice)
	}
}
