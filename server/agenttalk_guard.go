package main

// Guard for everything an agent says in an agent talk (agenttalk.go). Every line, before it
// reaches a phone:
//   - credentials and sensitive numbers are redacted (redact.go),
//   - contact details are stripped (emails, phone numbers, links, handles),
//   - either human's name is replaced by "my human" / "your human" (names only come out at
//     the reveal, after both said yes),
//   - sentences that make specific claims the speaking agent's own brief and notes don't
//     support are dropped (an agent may only speak for its own human, from what it knows).

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var talkContact = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b`),                                                // email
	regexp.MustCompile(`(?i)\b(?:https?://|www\.)\S+`),                                                                   // links
	regexp.MustCompile(`(?i)\b(?:[a-z0-9\-]+\.)+(?:com|io|dev|app|ai|net|org|co|me|xyz|gg|so|sh|ly|edu)/\S*`),            // domain + path
	regexp.MustCompile(`(?i)\b(?:linkedin|github|twitter|x|instagram|calendly|cal|t|wa|discord)\.(?:com|me|co|gg)\b\S*`), // profile hosts
	regexp.MustCompile(`(?:\+?\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b`),                                 // phone numbers
	regexp.MustCompile(`(?i)\b(?:discord|insta(?:gram)?|twitter|telegram|snap(?:chat)?|whatsapp|signal|linkedin|github|tiktok|venmo|cashapp)(?:\s+(?:handle|username|id))?\s*(?::|@)\s*\S+`),
	regexp.MustCompile(`(?:^|\s)@[A-Za-z0-9_.]{2,}`),  // @handles
	regexp.MustCompile(`\b[A-Za-z0-9_.]{2,}#\d{4}\b`), // discord tags
}

// talkScrub redacts secrets and strips contact details.
func talkScrub(s string) string {
	s = redactText(s, map[string]int{})
	for _, re := range talkContact {
		s = re.ReplaceAllStringFunc(s, func(m string) string {
			if strings.HasPrefix(m, " ") || strings.HasPrefix(m, "\t") {
				return " [removed]"
			}
			return "[removed]"
		})
	}
	return strings.Join(strings.Fields(s), " ")
}

// talkNames hides both humans' names: by default own name → "my human", the other's →
// "your human" (jev's state uses "Human A" / "Human B" instead).
type talkNames struct {
	own, other     []string
	ownAs, otherAs string
}

func talkNameParts(names ...string) []string {
	var out []string
	seen := map[string]bool{}
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n == "" {
			continue
		}
		// the full name first, then each part (so "Ada Lovelace" goes before "Ada")
		cands := append([]string{n}, strings.Fields(n)...)
		if at := strings.IndexByte(n, '@'); at > 0 {
			cands = []string{n, n[:at]}
		}
		for _, c := range cands {
			c = strings.Trim(c, ".,;:!?\"'()")
			if utf8.RuneCountInString(c) < 3 || seen[strings.ToLower(c)] {
				continue
			}
			seen[strings.ToLower(c)] = true
			out = append(out, c)
		}
	}
	return out
}

func (n talkNames) apply(s string) string {
	for _, set := range []struct {
		names []string
		repl  string
	}{{n.own, firstNonEmpty(n.ownAs, "my human")}, {n.other, firstNonEmpty(n.otherAs, "your human")}} {
		for _, name := range set.names {
			re := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(name) + `\b('s)?`)
			s = re.ReplaceAllStringFunc(s, func(m string) string {
				if strings.HasSuffix(strings.ToLower(m), "'s") {
					return set.repl + "'s"
				}
				return set.repl
			})
		}
	}
	return s
}

// talkWords: the words of s worth checking against a brief (lowercased, lightly stemmed).
func talkWords(s string, generic map[string]bool) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\'' && r != '-' && r != '+' && r != '#'
	}) {
		w = strings.Trim(w, "'-")
		if utf8.RuneCountInString(w) < 4 && !strings.ContainsAny(w, "0123456789+#") {
			continue
		}
		if generic[w] || fastStopWords[w] {
			continue
		}
		out = append(out, talkStem(w))
	}
	return out
}

func talkStem(w string) string {
	w = strings.TrimSuffix(w, "'s")
	for _, suf := range []string{"ing", "ed", "es", "s"} {
		if strings.HasSuffix(w, suf) && utf8.RuneCountInString(w)-len(suf) >= 4 {
			return strings.TrimSuffix(w, suf)
		}
	}
	return w
}

// talkCorpus is what an agent is allowed to talk about: its own human's brief and notes,
// plus the question it was asked.
type talkCorpus map[string]bool

func newTalkCorpus(generic map[string]bool, texts ...string) talkCorpus {
	c := talkCorpus{}
	for _, t := range texts {
		for _, w := range talkWords(t, generic) {
			c[w] = true
		}
	}
	return c
}

// grounded: at least min of a sentence's specific words appear in the corpus (a sentence
// with no specific words, like "My human would love that!", always passes).
func (c talkCorpus) grounded(sentence string, generic map[string]bool, min float64) bool {
	ws := talkWords(sentence, generic)
	if len(ws) == 0 {
		return true
	}
	hit := 0
	for _, w := range ws {
		if c[w] {
			hit++
		}
	}
	return float64(hit)/float64(len(ws)) >= min
}

// talkSentences splits finished sentences off the front of s; rest is what's still arriving.
func talkSentences(s string, final bool) (done []string, rest string) {
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '.' && c != '!' && c != '?' {
			continue
		}
		j := i + 1
		for j < len(s) && (s[j] == '.' || s[j] == '!' || s[j] == '?' || s[j] == '"' || s[j] == ')') {
			j++
		}
		if j < len(s) && (s[j] == ' ' || s[j] == '\n') {
			if t := strings.TrimSpace(s[start:j]); t != "" {
				done = append(done, t)
			}
			start = j
			i = j
		}
	}
	rest = s[start:]
	if final {
		if t := strings.TrimSpace(rest); t != "" {
			done = append(done, t)
		}
		rest = ""
	}
	return done, rest
}

// talkGuard checks one sentence an agent wants to say; "" means drop it.
type talkGuard struct {
	names   talkNames
	corpus  talkCorpus
	generic map[string]bool
	min     float64
}

func (g talkGuard) sentence(s string) string {
	s = talkScrub(g.names.apply(s))
	if strings.TrimSpace(strings.ReplaceAll(s, "[removed]", "")) == "" {
		return ""
	}
	if g.corpus != nil && !g.corpus.grounded(s, g.generic, g.min) {
		return ""
	}
	return s
}

// line guards a whole line (fixed text: questions, greetings, closings, icebreakers).
func (g talkGuard) line(s string) string {
	return talkScrub(g.names.apply(s))
}
