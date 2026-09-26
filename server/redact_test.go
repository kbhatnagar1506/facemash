package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestRedactText(t *testing.T) {
	cases := []struct {
		in, gone, kept string
	}{
		{"deploy key -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY----- done", "b3BlbnNzaC1rZXk", "deploy key"},
		{"aws AKIAABCDEFGHIJKLMNOP for prod", "AKIAABCDEFGHIJKLMNOP", "for prod"},
		{"maps AIzaSyA1234567890abcdefghijklmnopqrstuv ok", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "ok"},
		{"openai sk-proj-abcdefghijklmnopqrstuvwx1234", "abcdefghijklmnopqrstuvwx1234", "openai"},
		{"anthropic sk-ant-api03-abcdefghijklmnopqrstu", "abcdefghijklmnopqrstu", "anthropic"},
		{"gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "gh token"},
		{"stripe sk_live_abcdefghijklmnop1234", "sk_live_abcdefghijklmnop1234", "stripe"},
		{"our gtq_abcdefghijklmnopqrstuvwxyz", "gtq_abcdefghijklmnopqrstuvwxyz", "our"},
		{"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "dozjgNryP4J3jVmNHl0w5N", "jwt"},
		{"Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789abcdef", "Bearer"},
		{"db postgres://admin:hunter22@db.example.com/app", "hunter22", "postgres://admin:"},
		{"wifi password: correcthorse", "correcthorse", "password: "},
		{"API_KEY=zzzz9999yyyy", "zzzz9999yyyy", "API_KEY="},
		{"my client secret is abc123xyz", "abc123xyz", "client secret is "},
		{"ssn 123-45-6789 on file", "123-45-6789", "on file"},
		{"card 4111 1111 1111 1111 exp", "4111 1111 1111 1111", "exp"},
	}
	for _, c := range cases {
		counts := map[string]int{}
		out := redactText(c.in, counts)
		if strings.Contains(out, c.gone) {
			t.Errorf("%q: still contains %q -> %q", c.in, c.gone, out)
		}
		if !strings.Contains(out, c.kept) || !strings.Contains(out, "[redacted ") {
			t.Errorf("%q: lost context %q or no marker -> %q", c.in, c.kept, out)
		}
		if len(counts) == 0 {
			t.Errorf("%q: nothing counted", c.in)
		}
	}
}

// Ordinary notes must come through untouched: no false positives on the things people
// actually write about (dates, phone numbers, order ids, the word "key", code talk).
func TestRedactLeavesNormalTextAlone(t *testing.T) {
	for _, s := range []string{
		"Met Priya at HackGT 13 on 2026-09-26, she fixed the WebSocket reconnect bug.",
		"Call me at 404-555-0123 or (404) 555 0199.",
		"Order 1234567890123 shipped; tracking 9400111899223344556677.",
		"The key insight: batch the embeddings. Primary key is (tenant, user).",
		"I prefer Rust over Go for systems work; password managers are great.",
		"Commit a2876be fixed it; the hash sha256 was 3a7bd3e2360a3d29eea436fcfb7e44c735d117c4.",
	} {
		counts := map[string]int{}
		if out := redactText(s, counts); out != s {
			t.Errorf("changed normal text:\n in  %q\n out %q (%v)", s, out, counts)
		}
	}
}

func TestRedactJSON(t *testing.T) {
	var v any
	json.Unmarshal([]byte(`{"memory_md":"api key: sk-abcdefghijklmnopqrstuvwx","daily_notes":[{"date":"2026-09-25","content":"card 4111111111111111"}],"bank":{"world":"fine"}}`), &v)
	counts := map[string]int{}
	out, _ := json.Marshal(redactJSON(v, counts))
	s := string(out)
	if strings.Contains(s, "sk-abcdefghijklmnopqrstuvwx") || strings.Contains(s, "4111111111111111") || !strings.Contains(s, "fine") || !strings.Contains(s, "2026-09-25") {
		t.Fatalf("redactJSON: %s", s)
	}
	if counts["card number"] != 1 {
		t.Fatalf("counts: %v", counts)
	}
}

// End to end through the upload endpoint: what gets stored is already scrubbed.
func TestMemoryUploadIsRedacted(t *testing.T) {
	srv, acc, store, id, tok := museServer(t)
	body := `{"memory_md":"deploy with AWS key AKIAABCDEFGHIJKLMNOP and wifi password: correcthorse","user_md":"likes rust"}`
	req, _ := http.NewRequest("POST", srv.URL+"/api/memory/t/"+tok, strings.NewReader(body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	res.Body.Close()
	if res.StatusCode != 200 || out["redacted"] != 2.0 {
		t.Fatalf("upload: %d %v", res.StatusCode, out)
	}
	stored := string(store.memory[memKey(acc.tenant, id)].data)
	if strings.Contains(stored, "AKIAABCDEFGHIJKLMNOP") || strings.Contains(stored, "correcthorse") || !strings.Contains(stored, "likes rust") {
		t.Fatalf("stored: %s", stored)
	}
	if !strings.Contains(memoryPrompt("https://x.test/api/memory/t/gtq_x"), "Never send credentials") {
		t.Fatal("prompt lacks the credentials rule")
	}
}
