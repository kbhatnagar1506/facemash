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

// Ways an agent (or an attendee) could slip a secret past the patterns above. Every case
// here got through before.
func TestRedactionBypasses(t *testing.T) {
	cases := []struct {
		name string
		v    any
		gone []string
	}{
		{"password key", map[string]any{"password": "hunter2hunter2"}, []string{"hunter2hunter2"}},
		{"env-style key", map[string]any{"OPENAI_API_KEY": "abcd1234efgh5678ijkl"}, []string{"abcd1234efgh5678ijkl"}},
		{"short pin under a label", map[string]any{"bank pin": "4321"}, []string{"4321"}},
		{"numeric pin", map[string]any{"pin": 4321.0}, []string{"4321"}},
		{"camelCase key", map[string]any{"clientSecret": "xyz"}, []string{"xyz"}},
		{"secret list", map[string]any{"DB_PASSWORD": []any{"one1", map[string]any{"x": "two2"}}}, []string{"one1", "two2"}},
		{"nested label", map[string]any{"bank": map[string]any{"GITHUB_TOKEN": "tok"}}, []string{`"tok"`}},
		{"zero-width space", "ghp_​" + strings.Repeat("A", 36), []string{strings.Repeat("A", 36)}},
		{"soft hyphen", "sk-proj-abcdefghij­klmnopqrstuvwx", []string{"abcdefghij", "klmnopqrstuvwx"}},
		{"full-width colon", "password： hunter2", []string{"hunter2"}},
		{"full-width label", "ｐａｓｓｗｏｒｄ: hunter2", []string{"hunter2"}},
		{"ssn no dashes", "my ssn 123456789", []string{"123456789"}},
		{"ssn spaces", "my ssn 123 45 6789", []string{"123 45 6789"}},
		{"ssn label", "Social Security Number: 123.45.6789", []string{"123.45.6789"}},
		{"card with dots", "card 4111.1111.1111.1111", []string{"4111.1111.1111.1111"}},
		{"token split across items", []any{"ghp_" + strings.Repeat("B", 15), strings.Repeat("B", 21)}, []string{"BBBBBBBBBBBBBBB"}},
		{"label split across items", []any{"my ssn", "123456789"}, []string{"123456789"}},
		{"no-colon password", "my password hunter2", []string{"hunter2"}},
		{"password was", "the wifi password was s3cret!", []string{"s3cret"}},
		{"no-colon pin", "my PIN 4321, don't tell", []string{"4321"}},
		{"env var in text", "export OPENAI_API_KEY=abcd1234efgh5678ijkl", []string{"abcd1234efgh5678ijkl"}},
		{"token env var", "GITHUB_TOKEN: abcdefgh12345678", []string{"abcdefgh12345678"}},
		{"bare aws secret", "aws secret key unlabeled wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", []string{"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}},
	}
	for _, c := range cases {
		counts := map[string]int{}
		b, err := json.Marshal(redactJSON(c.v, counts))
		if err != nil {
			t.Fatal(err)
		}
		out := string(b)
		for _, g := range c.gone {
			if strings.Contains(out, g) {
				t.Errorf("%s: still contains %q -> %s", c.name, g, out)
			}
		}
		if len(counts) == 0 {
			t.Errorf("%s: nothing counted -> %s", c.name, out)
		}
	}
}

// The new rules must not eat ordinary memory: app keys, words that contain a label, nine
// digit numbers without an SSN label, non-ASCII text.
func TestRedactBypassFixesLeaveNormalDataAlone(t *testing.T) {
	for _, s := range []string{
		"My PIN code tip: never reuse",
		"tokens per second went up; token_count is 812",
		"The secret to good demos is rehearsal.",
		"order 123456789 shipped",
		"zip 30332-0280, call 404-894-2000 or +1 404 555 0123",
		"Klaus 1116 at 9:30",
		"ＨａｃｋＧＴ　１３ was great",
		"🎉 José and Zoë won — naïve café résumé",
		"Hebrew שלום and Arabic مرحبا with a bidi mark‏ inside",
		"password managers are great; my password manager is 1Password",
		"Pin 2026 goals to the wall; spin 1234 times",
		"src/Components/Header/IndexPage1234567.tsx and commit 3a7bd3e2360a3d29eea436fcfb7e44c735d117c4",
		"https://github.com/Foo/Barbazquux1234567/tree/main",
		"a keyboard shortcut, the key insight, primary key (a, b)",
		"pi is 3.14159265358979 and e is 2.718281828459045",
		"ids 123456789, 987654321 and ip 10.0.0.1",
	} {
		counts := map[string]int{}
		if out := redactText(s, counts); out != s {
			t.Errorf("changed normal text:\n in  %q\n out %q (%v)", s, out, counts)
		}
	}
	for _, k := range []string{"user_md", "memory_md", "daily_notes", "bank", "experience", "opinions", "reflections", "world", "date", "content", "user_id", "exported_at", "source", "token_count", "keyboard", "tokens", "spin", "pinned", "password_hint", "zip code", "keys"} {
		if isSecretLabel(k) {
			t.Errorf("%q treated as a secret label", k)
		}
	}
	var v any
	json.Unmarshal([]byte(`{"user_md":"likes rust","memory_md":"x","daily_notes":[{"date":"2026-09-25","content":"hi"}],"bank":{"world":["a","b"],"experience":["ghp_short","tail"],"opinions":[],"reflections":[]},"user_id":"42","exported_at":"2026-09-26T10:00:00Z","source":"claude"}`), &v)
	counts := map[string]int{}
	before, _ := json.Marshal(v)
	after, _ := json.Marshal(redactJSON(v, counts))
	if string(before) != string(after) || len(counts) != 0 {
		t.Fatalf("memory export changed:\n %s\n %s (%v)", before, after, counts)
	}
}

// The upload path runs this over up to 25 MB; normalization only happens for non-ASCII
// text and nothing is copied when nothing matches.
func BenchmarkRedactText(b *testing.B) {
	ascii := strings.Repeat("Met Priya at HackGT 13 on 2026-09-26; order 123456789 shipped. ", 16<<10)
	// every prefilter passes: the regexes run over all of it
	busy := strings.Repeat("The key opinion: my pass/class at 9/26 + order 1234567890123 via https://x.io; token SSN? ", 12<<10)
	uni := strings.Repeat("José met Zoë at ＨａｃｋＧＴ — café 🎉 order 123456789. ", 16<<10)
	for _, c := range []struct{ name, s string }{{"ascii", ascii}, {"busy", busy}, {"unicode", uni}} {
		b.Run(c.name, func(b *testing.B) {
			b.SetBytes(int64(len(c.s)))
			for i := 0; i < b.N; i++ {
				redactText(c.s, map[string]int{})
			}
		})
	}
}
