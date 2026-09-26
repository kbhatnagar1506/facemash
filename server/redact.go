package main

// Guardrail on what agents send us. The prompt tells an attendee's agent never to include
// credentials or sensitive numbers, but an agent can ignore instructions, so every string
// in an upload is scrubbed here before anything is stored or indexed. It errs on the side
// of redacting: a lost token in a note costs nothing, a stored password costs a lot.
//
// Matching runs on a normalized copy of the text (NFKC, invisible characters removed) so
// full-width colons, zero-width spaces and soft hyphens can't hide a secret. Text in which
// nothing is found comes back exactly as it arrived.

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

type redaction struct {
	kind string
	re   *regexp.Regexp
	// group: which capture group is the secret (0: the whole match). Text outside it (a
	// "password:" label, a URL's user) is kept.
	group int
	// check: an extra test on the secret (e.g. the card checksum) before it counts
	check func(string) bool
	// before: an extra test on the text preceding the match ("my" in "my pin 4321")
	before func(prefix string) bool
	// prefilter, so most rules never run a regex over most text: every match contains one
	// of lits (compared lower-cased when fold), or pre must say the text could match
	lits []string
	fold bool
	pre  func(string) bool
}

// the labels that announce a secret in running text ("password: x", "API_KEY=x")
const secretLabels = `password|passwd|passcode|passphrase|pwd|pin|secret|client[_ \-]?secret|api[_ \-]?key|access[_ \-]?key|secret[_ \-]?key|access[_ \-]?token|auth[_ \-]?token|refresh[_ \-]?token|private[_ \-]?key`

var redactions = []redaction{
	{kind: "private key", re: regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)`), lits: []string{"-----BEGIN "}},
	{kind: "key", re: regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`), lits: []string{"AKIA", "ASIA"}},                                                                        // AWS
	{kind: "key", re: regexp.MustCompile(`\bAIza[0-9A-Za-z_\-]{35}\b`), lits: []string{"AIza"}},                                                                                   // Google
	{kind: "key", re: regexp.MustCompile(`\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}`), lits: []string{"sk-"}},                                                                       // OpenAI / Anthropic
	{kind: "key", re: regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})`), lits: []string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"}}, // GitHub
	{kind: "key", re: regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9\-]{10,}`), lits: []string{"xox"}},                                                                              // Slack
	{kind: "key", re: regexp.MustCompile(`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`), lits: []string{"_live_", "_test_"}},                                                    // Stripe
	{kind: "key", re: regexp.MustCompile(`\b(?:gtqp?_|sm_)[A-Za-z0-9_\-]{20,}`), lits: []string{"gtq", "sm_"}},                                                                    // ours, and MAPI's
	{kind: "token", re: regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`), lits: []string{"eyJ"}},                                          // JWT
	{kind: "token", re: regexp.MustCompile(`(?i)\bbearer\s+([A-Za-z0-9._~+/\-]{16,}=*)`), group: 1, lits: []string{"bearer"}, fold: true},
	{kind: "password", re: regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:([^\s@/]+)@`), group: 1, lits: []string{"://"}}, // user:pass@ in URLs
	// "password: hunter2", "OPENAI_API_KEY=abc", "client secret - xyz", "pin is 4321": keep
	// the label, drop the value. The label may carry an env-style prefix (DB_PASSWORD).
	{kind: "secret", re: regexp.MustCompile(`(?i)(?:\b|_)(?:` + secretLabels + `)\b["']?\s*(?:[:=]|\bis\b|-)\s*["']?([^\s"',;]{3,})`), group: 1, check: notRedacted,
		lits: []string{"pass", "pwd", "pin", "secret", "key", "token"}, fold: true},
	// GITHUB_TOKEN=..., SLACK_BOT_TOKEN: ...
	{kind: "secret", re: regexp.MustCompile(`(?i)_token\b["']?\s*[:=]\s*["']?([^\s"',;]{8,})`), group: 1, check: notRedacted, lits: []string{"_token"}, fold: true},
	// "my password hunter2", "password was s3cret!": no separator, so the value must look
	// like one (a digit or a symbol) and "password managers are great" stays
	{kind: "secret", re: regexp.MustCompile(`(?i)\b(?:password|passwd|passcode|passphrase|pwd)(?:\s+was)?\s+["']?([^\s"',;]*[^\s"',;.!?:)\]}])`), group: 1, check: looksLikeSecretValue,
		lits: []string{"pass", "pwd"}, fold: true},
	// "my pin 4321", "bank PIN code 123456": digits, after a possessive or an owner word
	{kind: "secret", re: regexp.MustCompile(`(?i)\bpin(?:\s+(?:code|number|no\.?))?\s*#?\s+(?:was\s+)?(\d{4,8})\b`), group: 1, before: pinOwner, lits: []string{"pin"}, fold: true},
	{kind: "SSN", re: regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`), pre: func(s string) bool { return digitRun(s, 9, "-") }},
	// "ssn 123456789", "SSN# 123 45 6789", "social security number is 123.45.6789": other
	// layouts only right after an SSN label, so order ids and phone numbers are left alone
	{kind: "SSN", re: regexp.MustCompile(`(?i)\b(?:ssn|ss\s*#|social\s+security(?:\s+(?:number|no|num))?|soc\.?\s*sec\.?)[^\d\n]{0,24}?(\d{3}[ .\-]?\d{2}[ .\-]?\d{4})\b`), group: 1, check: validSSN,
		lits: []string{"ss", "soc"}, fold: true},
	{kind: "card number", re: regexp.MustCompile(`\b(?:\d[ \-]?){12,18}\d\b`), check: luhn, pre: func(s string) bool { return digitRun(s, 13, " -") }},
	{kind: "card number", re: regexp.MustCompile(`\b\d{4}\.\d{4,6}\.\d{4,5}(?:\.\d{1,7})?\b`), check: luhn, pre: func(s string) bool { return digitRun(s, 13, ".") }}, // 4111.1111.1111.1111
	// a bare AWS secret access key: exactly 40 base64 characters standing alone, mixed case
	// with a digit and a '/' or '+' (so git SHAs, which are hex, and words never qualify)
	{kind: "key", re: regexp.MustCompile(`(?:^|[\s"'=:,(\[{<>])([A-Za-z0-9/+]{40})(?:$|[\s"',;.)\]}<>])`), group: 1, check: awsSecretLike, lits: []string{"/", "+"}},
}

// redactText returns s with credentials and sensitive numbers replaced, and how many of
// each kind were found.
func redactText(s string, counts map[string]int) string {
	out, _ := redactTextN(s, counts)
	return out
}

// redactTextN is redactText that also says how many redactions it made. With none, s
// itself comes back (not its normalized form).
func redactTextN(s string, counts map[string]int) (string, int) {
	t := normalizeForMatch(s)
	hits := 0
	lower, lowerOK := "", false
	for i := range redactions {
		r := &redactions[i]
		hay := t
		if r.fold {
			if !lowerOK {
				lower, lowerOK = asciiLower(t), true
			}
			hay = lower
		}
		if (r.lits != nil && !containsAny(hay, r.lits)) || (r.pre != nil && !r.pre(t)) {
			continue
		}
		if out := r.apply(t, counts, &hits); out != t {
			t, lowerOK = out, false
		}
	}
	if hits == 0 {
		return s, 0
	}
	return t, hits
}

func (r *redaction) apply(s string, counts map[string]int, hits *int) string {
	locs := r.re.FindAllStringSubmatchIndex(s, -1)
	if locs == nil {
		return s
	}
	var b strings.Builder
	last, found := 0, false
	for _, l := range locs {
		a, e := l[2*r.group], l[2*r.group+1]
		if a < 0 || a < last {
			continue
		}
		if r.check != nil && !r.check(s[a:e]) {
			continue
		}
		if r.before != nil && !r.before(s[:l[0]]) {
			continue
		}
		if !found {
			b.Grow(len(s))
			found = true
		}
		b.WriteString(s[last:a])
		b.WriteString("[redacted " + r.kind + "]")
		last = e
		counts[r.kind]++
		*hits++
	}
	if !found {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

// normalizeForMatch folds compatibility characters (full-width letters and colons,
// ligatures, non-breaking spaces) with NFKC and drops invisible characters that could
// split a secret. ASCII text, the common case, is returned as is without copying.
func normalizeForMatch(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return s
	}
	s = strings.Map(func(r rune) rune {
		if invisible(r) {
			return -1
		}
		return r
	}, s)
	return norm.NFKC.String(s)
}

func invisible(r rune) bool {
	switch {
	case r == 0x00AD, r == 0x034F, r == 0x061C, r == 0x180E, r == 0xFEFF:
		return true
	case r >= 0x200B && r <= 0x200F, r >= 0x202A && r <= 0x202E, r >= 0x2060 && r <= 0x2064, r >= 0x2066 && r <= 0x2069:
		return true
	case r >= 0xFE00 && r <= 0xFE0F, r >= 0xE0000 && r <= 0xE007F: // variation selectors, tags
		return true
	}
	return false
}

func containsAny(s string, lits []string) bool {
	for _, l := range lits {
		if strings.Contains(s, l) {
			return true
		}
	}
	return false
}

// asciiLower lower-cases ASCII letters only, so byte offsets stay put; it copies nothing
// when there is nothing to change.
func asciiLower(s string) string {
	i := 0
	for i < len(s) && !(s[i] >= 'A' && s[i] <= 'Z') {
		i++
	}
	if i == len(s) {
		return s
	}
	b := []byte(s)
	for ; i < len(b); i++ {
		if c := b[i]; c >= 'A' && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

// digitRun reports whether s has at least n digits in a row, allowing single separators
// from seps between them: the cheap test before the number rules run.
func digitRun(s string, n int, seps string) bool {
	run, prevDigit := 0, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			run++
			if run >= n {
				return true
			}
			prevDigit = true
		case prevDigit && strings.IndexByte(seps, c) >= 0:
			prevDigit = false
		default:
			run, prevDigit = 0, false
		}
	}
	return false
}

// pinOwner: a bare "pin 4321" is only a PIN after a word that owns one ("my", "bank",
// "atm"), which keeps "Pin 2026 goals to the wall" alone.
func pinOwner(prefix string) bool {
	end := len(prefix)
	for end > 0 && strings.IndexByte(" \t\r\n", prefix[end-1]) >= 0 {
		end--
	}
	start := end
	for start > 0 && end-start < 12 && isASCIILetter(prefix[start-1]) {
		start--
	}
	if start == end || end == len(prefix) || (start > 0 && isASCIILetter(prefix[start-1])) {
		return false
	}
	return pinOwners[asciiLower(prefix[start:end])]
}

var pinOwners = map[string]bool{
	"my": true, "the": true, "our": true, "your": true, "his": true, "her": true, "their": true,
	"bank": true, "atm": true, "card": true, "debit": true, "credit": true, "phone": true, "sim": true,
	"door": true, "garage": true, "gate": true, "lock": true, "safe": true, "alarm": true,
	"voicemail": true, "new": true, "old": true,
}

func isASCIILetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

func notRedacted(v string) bool { return !strings.HasPrefix(v, "[redacted") }

// looksLikeSecretValue: a word after "password" with no separator is only a value when it
// has a digit or a symbol in it ("hunter2", "p@ss") and isn't one of our own markers.
func looksLikeSecretValue(v string) bool {
	if len(v) < 4 || !notRedacted(v) {
		return false
	}
	return strings.IndexFunc(v, func(r rune) bool {
		return (r >= '0' && r <= '9') || strings.ContainsRune("!@#$%^&*_+=~/\\|<>", r)
	}) >= 0
}

// validSSN rejects numbers the SSA never issues (area 000, 666 or 9xx, group 00, serial
// 0000), which keeps the labelled forms from eating arbitrary digits.
func validSSN(v string) bool {
	d := digitsOf(v)
	if len(d) != 9 {
		return false
	}
	area, group, serial := d[:3], d[3:5], d[5:]
	return area != "000" && area != "666" && area[0] != '9' && group != "00" && serial != "0000"
}

func awsSecretLike(v string) bool {
	if len(v) != 40 || v[0] == '/' || v[39] == '/' || strings.Contains(v, "//") {
		return false
	}
	var upper, lower, digit, sym int
	for i := 0; i < len(v); i++ {
		switch c := v[i]; {
		case c >= 'A' && c <= 'Z':
			upper++
		case c >= 'a' && c <= 'z':
			lower++
		case c >= '0' && c <= '9':
			digit++
		default:
			sym++
		}
	}
	return upper >= 4 && lower >= 4 && digit >= 1 && sym >= 1 && sym <= 6
}

// redactJSON scrubs every string (and object key) in a decoded JSON value. Maps come back
// as new maps; slices are rewritten in place. A value under a key that names a secret
// ("password", "OPENAI_API_KEY", "bank pin") is dropped whole, whatever it looks like.
func redactJSON(v any, counts map[string]int) any {
	switch t := v.(type) {
	case string:
		return redactText(t, counts)
	case []any:
		// a secret split across neighbouring strings (["ghp_abc", "def..."]) is caught by
		// also checking each short adjacent pair joined
		var prev string
		prevOK, prevHits := false, 0
		for i := range t {
			s, ok := t[i].(string)
			if !ok {
				t[i] = redactJSON(t[i], counts)
				prevOK = false
				continue
			}
			out, n := redactTextN(s, counts)
			t[i] = out
			if prevOK {
				if kind := seamSecret(prev, s, prevHits+n); kind != "" {
					t[i-1] = "[redacted " + kind + "]"
					t[i] = "[redacted " + kind + "]"
					counts[kind]++
				}
			}
			prev, prevOK, prevHits = s, true, n
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if isSecretLabel(k) {
				out[redactText(k, counts)] = redactAll(val, counts)
			} else {
				out[redactText(k, counts)] = redactJSON(val, counts)
			}
		}
		return out
	}
	return v
}

// seamMax bounds the pair check so a long array of long strings stays linear and cheap.
const seamMax = 256

// seamSecret reports the kind of a secret that the two strings form together but neither
// holds alone (have: what the halves matched on their own), or "".
func seamSecret(a, b string, have int) string {
	if a == "" || b == "" || len(a) > seamMax || len(b) > seamMax {
		return ""
	}
	for _, sep := range [...]string{"", " "} {
		scratch := map[string]int{}
		if _, n := redactTextN(a+sep+b, scratch); n > have {
			kinds := make([]string, 0, len(scratch))
			for k := range scratch {
				kinds = append(kinds, k)
			}
			sort.Strings(kinds)
			return kinds[0]
		}
	}
	return ""
}

// redactAll replaces every string and number inside a value stored under a secret label.
func redactAll(v any, counts map[string]int) any {
	switch t := v.(type) {
	case string:
		if t == "" {
			return t
		}
		counts["secret"]++
		return "[redacted secret]"
	case float64, int, int64, interface{ String() string }: // json numbers, however decoded
		counts["secret"]++
		return "[redacted secret]"
	case []any:
		for i := range t {
			t[i] = redactAll(t[i], counts)
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[redactText(k, counts)] = redactAll(val, counts)
		}
		return out
	}
	return v
}

var (
	// a key whose last word is one of these names a secret: "password", "DB_PASSWORD",
	// "GITHUB_TOKEN", "client_secret", "bank pin"
	secretKeyWords = map[string]bool{
		"password": true, "passwords": true, "passwd": true, "passcode": true, "passcodes": true,
		"passphrase": true, "pwd": true, "pin": true, "secret": true, "secrets": true,
		"token": true, "apikey": true, "apikeys": true, "secretkey": true, "accesskey": true,
		"privatekey": true, "credential": true, "credentials": true, "creds": true,
		"cvv": true, "cvc": true, "ssn": true, "otp": true,
	}
	// ... or whose last two words are one of these: "OPENAI_API_KEY", "aws access key"
	secretKeyPairs = map[string]bool{
		"api key": true, "api keys": true, "access key": true, "access keys": true,
		"secret key": true, "secret keys": true, "private key": true, "private keys": true,
		"ssh key": true, "signing key": true, "encryption key": true, "master key": true,
		"pass word": true, "pass code": true, "pass phrase": true, "social security": true,
		"access code": true, "security code": true, "recovery code": true, "recovery codes": true,
		"backup code": true, "backup codes": true,
	}
	// compounds without a separator: "dbpassword", "openaiapikey"
	secretKeySuffixes = []string{"password", "passwd", "passcode", "apikey", "secretkey", "privatekey", "accesskey"}
	// a trailing word that doesn't change the meaning: "pin code", "ssn number", "secret value"
	secretKeyTails = map[string]bool{"code": true, "number": true, "no": true, "num": true, "value": true}
)

// isSecretLabel reports whether a JSON object key names a secret. It works on whole
// words, so "token_count", "keyboard", "bank" and "user_id" are not labels.
func isSecretLabel(k string) bool {
	if k == "" || len(k) > 80 {
		return false
	}
	w := labelWords(normalizeForMatch(k))
	if secretWords(w) {
		return true
	}
	if n := len(w); n >= 2 && secretKeyTails[w[n-1]] {
		return secretWords(w[:n-1])
	}
	return false
}

func secretWords(w []string) bool {
	n := len(w)
	if n == 0 {
		return false
	}
	last := w[n-1]
	if secretKeyWords[last] || (n >= 2 && secretKeyPairs[w[n-2]+" "+last]) {
		return true
	}
	for _, suf := range secretKeySuffixes {
		if len(last) > len(suf) && strings.HasSuffix(last, suf) {
			return true
		}
	}
	return false
}

// labelWords splits a key into lower-case words on anything that isn't a letter or digit
// and on camelCase humps ("clientSecret" -> client, secret); trailing digits are dropped
// ("password2" -> password).
func labelWords(k string) []string {
	var words []string
	var cur []rune
	flush := func() {
		w := strings.TrimRightFunc(string(cur), unicode.IsDigit)
		if w != "" {
			words = append(words, strings.ToLower(w))
		}
		cur = cur[:0]
	}
	prevLower := false
	for _, r := range k {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			if unicode.IsUpper(r) && prevLower {
				flush()
			}
			cur = append(cur, r)
			prevLower = unicode.IsLower(r) || unicode.IsDigit(r)
		default:
			flush()
			prevLower = false
		}
	}
	flush()
	return words
}

func digitsOf(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, s)
}

// luhn: card numbers pass the Luhn checksum; most other long digit runs (phone numbers,
// order ids, timestamps) don't, so they are left alone.
func luhn(s string) bool {
	digits := digitsOf(s)
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
