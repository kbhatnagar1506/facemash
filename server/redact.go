package main

// Guardrail on what agents send us. The prompt tells an attendee's agent never to include
// credentials or sensitive numbers, but an agent can ignore instructions, so every string
// in an upload is scrubbed here before anything is stored or indexed. It errs on the side
// of redacting: a lost token in a note costs nothing, a stored password costs a lot.

import (
	"regexp"
	"strings"
)

type redaction struct {
	kind string
	re   *regexp.Regexp
	// keep: how many leading capture groups to keep (e.g. the "password:" label)
	keep bool
	// check: an extra test on the match (e.g. the card checksum) before it counts
	check func(string) bool
}

var redactions = []redaction{
	{kind: "private key", re: regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)`)},
	{kind: "key", re: regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`)},                                        // AWS
	{kind: "key", re: regexp.MustCompile(`\bAIza[0-9A-Za-z_\-]{35}\b`)},                                           // Google
	{kind: "key", re: regexp.MustCompile(`\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}`)},                              // OpenAI / Anthropic
	{kind: "key", re: regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})`)},        // GitHub
	{kind: "key", re: regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9\-]{10,}`)},                                     // Slack
	{kind: "key", re: regexp.MustCompile(`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`)},                        // Stripe
	{kind: "key", re: regexp.MustCompile(`\b(?:gtqp?_|sm_)[A-Za-z0-9_\-]{20,}`)},                                  // ours, and MAPI's
	{kind: "token", re: regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`)}, // JWT
	{kind: "token", re: regexp.MustCompile(`(?i)(\bbearer\s+)[A-Za-z0-9._~+/\-]{16,}=*`), keep: true},
	{kind: "password", re: regexp.MustCompile(`(?i)(\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s@/]+(@)`), keep: true}, // user:pass@ in URLs
	// "password: hunter2", "API_KEY=abc", "client secret - xyz": keep the label, drop the value
	{kind: "secret", re: regexp.MustCompile(`(?i)(\b(?:password|passwd|passcode|pwd|pin|secret|client[_ \-]?secret|api[_ \-]?key|access[_ \-]?key|secret[_ \-]?key|access[_ \-]?token|auth[_ \-]?token|refresh[_ \-]?token|private[_ \-]?key)\b["']?\s*(?:[:=]|\bis\b|-)\s*["']?)[^\s"',;]{3,}`), keep: true},
	{kind: "SSN", re: regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`)},
	{kind: "card number", re: regexp.MustCompile(`\b(?:\d[ \-]?){12,18}\d\b`), check: luhn},
}

// redactText returns s with credentials and sensitive numbers replaced, and how many of
// each kind were found.
func redactText(s string, counts map[string]int) string {
	for _, r := range redactions {
		s = r.re.ReplaceAllStringFunc(s, func(m string) string {
			if r.check != nil && !r.check(m) {
				return m
			}
			counts[r.kind]++
			label := "[redacted " + r.kind + "]"
			if r.keep {
				if sub := r.re.FindStringSubmatch(m); len(sub) > 1 {
					tail := ""
					if len(sub) > 2 {
						tail = sub[2]
					}
					return sub[1] + label + tail
				}
			}
			return label
		})
	}
	return s
}

// redactJSON scrubs every string (and object key) in a decoded JSON value in place.
func redactJSON(v any, counts map[string]int) any {
	switch t := v.(type) {
	case string:
		return redactText(t, counts)
	case []any:
		for i := range t {
			t[i] = redactJSON(t[i], counts)
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[redactText(k, counts)] = redactJSON(val, counts)
		}
		return out
	}
	return v
}

// luhn: card numbers pass the Luhn checksum; most other long digit runs (phone numbers,
// order ids, timestamps) don't, so they are left alone.
func luhn(s string) bool {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, s)
	if len(digits) < 13 || len(digits) > 19 {
		return false
	}
	sum, double := 0, false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		double = !double
	}
	return sum%10 == 0
}
