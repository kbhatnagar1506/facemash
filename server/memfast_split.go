package main

// Splitting a Muse memory upload into keyed sections for the memory index (see memfast.go).
//
// Only the fields the memory prompt asks for are read: user_md, memory_md, daily_notes and
// bank.{experience,opinions,reflections,world}. Anything else in the upload (user_id, a
// stray people/ folder) never leaves this server. Each markdown file is cut at its headings,
// each daily note is its own section, and anything over fastMaxItemChars is cut again at
// paragraph breaks. Keys are stable across uploads (they come from headings and dates, not
// positions), so re-sending an unchanged file costs nothing and an edited section replaces
// exactly its own old copy.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	fastMaxItemChars  = 4000    // runes per item, header line included
	fastMaxTotalBytes = 1 << 20 // per person, across every item
	fastMaxItems      = 200     // per person
	fastMaxSlug       = 60      // bytes of a heading in a key
	// Only the start of a huge file is read at all, and only so many daily notes are looked
	// at: whatever an upload holds (up to 25 MB), splitting it costs about the same.
	fastMaxFileBytes = 4 * fastMaxTotalBytes
	fastMaxNotes     = 5000
)

// fastItem is one section, ready to write.
type fastItem struct {
	Key      string     // stable: "muse:memory_md:projects", "muse:daily:2026-09-25#2"
	Section  string     // user_md | memory_md | daily_note | bank
	Content  string     // a self-describing first line, then the text
	Occurred *time.Time // daily notes: the note's date
	SHA      []byte     // sha256 of everything above
}

var fastBankFiles = []string{"experience", "opinions", "reflections", "world"}

var fastDateRE = regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)

// fastEmit takes the next item; false means the caps are reached and splitting stops.
type fastEmit func(fastItem) bool

// fastSplit turns an upload into items, highest priority first (user_md, memory_md, daily
// notes newest first, then the bank), and stops as soon as the per-person caps are reached
// (capped says whether they were), so a huge upload costs no more than a full one.
func fastSplit(obj map[string]any) (items []fastItem, capped bool) {
	total := 0
	emit := func(it fastItem) bool {
		if len(items) >= fastMaxItems || total+len(it.Content) > fastMaxTotalBytes {
			capped = true
			return false
		}
		total += len(it.Content)
		items = append(items, it)
		return true
	}
	if s, ok := obj["user_md"].(string); ok && !fastMarkdownTo("muse:user_md", "user_md", "About me (USER.md)", s, emit) {
		return items, capped
	}
	if s, ok := obj["memory_md"].(string); ok && !fastMarkdownTo("muse:memory_md", "memory_md", "Long-term memory (MEMORY.md)", s, emit) {
		return items, capped
	}
	if !fastDailyTo(obj["daily_notes"], emit) {
		return items, capped
	}
	if bank, ok := obj["bank"].(map[string]any); ok {
		for _, name := range fastBankFiles {
			if s := fastText(bank[name]); s != "" && !fastMarkdownTo("muse:bank:"+name, "bank", "Memory bank: "+name, s, emit) {
				return items, capped
			}
		}
	}
	return items, capped
}

// fastHead: at most n bytes of s, cut at a character boundary.
func fastHead(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// fastText accepts a string, or a list of strings (joined as paragraphs).
func fastText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var parts []string
		for _, p := range t {
			if s, ok := p.(string); ok && strings.TrimSpace(s) != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n\n")
	}
	return ""
}

func fastClean(s string) string {
	s = strings.ToValidUTF8(s, "�")
	s = strings.ReplaceAll(s, "\x00", "") // Postgres text can't hold NUL
	return strings.ReplaceAll(s, "\r\n", "\n")
}

// fastDailyTo reads daily_notes as [{date, content}] (what the prompt asks for) or {date: content}.
func fastDailyTo(v any, emit fastEmit) bool {
	type note struct {
		date, day string // day: the YYYY-MM-DD in date, if any
		content   any
	}
	var notes []note
	add := func(d string, c any) {
		if len(notes) < fastMaxNotes {
			notes = append(notes, note{d, fastDateRE.FindString(d), c})
		}
	}
	switch t := v.(type) {
	case []any:
		for _, e := range t {
			if m, ok := e.(map[string]any); ok {
				d, _ := m["date"].(string)
				add(d, m["content"])
			}
		}
	case map[string]any:
		for d, c := range t {
			add(d, c)
		}
	}
	// newest first; undated last, in a stable order
	sort.SliceStable(notes, func(i, j int) bool {
		if notes[i].day != notes[j].day {
			return notes[i].day > notes[j].day
		}
		return notes[i].date < notes[j].date
	})
	seen := map[string]int{}
	for _, n := range notes {
		body := strings.TrimSpace(fastClean(fastHead(fastText(n.content), fastMaxFileBytes)))
		if body == "" {
			continue
		}
		label, key := "undated", "undated"
		var at *time.Time
		if n.day != "" {
			if t, err := time.Parse("2006-01-02", n.day); err == nil {
				noon := t.Add(12 * time.Hour) // noon UTC keeps the date the same across US time zones
				at, label, key = &noon, n.day, n.day
			}
		} else if s := fastSlug(n.date); s != "" {
			label, key = strings.TrimSpace(fastClean(n.date)), s
		}
		key = fastUnique(seen, "muse:daily:"+key)
		if !fastPieces(key, "daily_note", "Daily note — "+fastLine(label), body, at, emit) {
			return false
		}
	}
	return true
}

// fastMarkdown is fastMarkdownTo without the caps (tests).
func fastMarkdown(base, section, label, s string) []fastItem {
	var out []fastItem
	fastMarkdownTo(base, section, label, s, func(it fastItem) bool { out = append(out, it); return true })
	return out
}

// fastMarkdownTo cuts a file at its headings (levels 1-3; not inside code fences). The text
// before the first heading keys as the file itself. One pass, no copy of the file per line.
func fastMarkdownTo(base, section, label, s string, emit fastEmit) bool {
	s = fastClean(fastHead(s, fastMaxFileBytes))
	seen := map[string]int{}
	var path []string     // the current part's headings (none before the first)
	var stack []string    // heading titles by level
	start, fence := 0, "" // where the current part's text starts
	flush := func(end int) bool {
		body := strings.TrimSpace(s[start:end])
		if body == "" {
			return true
		}
		key, head := base, label
		if len(path) > 0 {
			slugs := make([]string, 0, len(path))
			for _, t := range path {
				slugs = append(slugs, fastSlug(t))
			}
			key = base + ":" + fastTrim(strings.Join(slugs, "/"), fastMaxSlug*2)
			head = label + " — " + fastLine(strings.Join(path, " › "))
		}
		return fastPieces(fastUnique(seen, key), section, head, body, nil, emit)
	}
	for pos := 0; pos < len(s); {
		end, next := len(s), len(s)
		if i := strings.IndexByte(s[pos:], '\n'); i >= 0 {
			end, next = pos+i, pos+i+1
		}
		line := s[pos:end]
		trim := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(trim, fence) {
				fence = ""
			}
		} else if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			fence = trim[:3]
		} else if lvl, title := fastHeading(line); lvl > 0 {
			if !flush(pos) {
				return false
			}
			if len(stack) >= lvl {
				stack = stack[:lvl-1]
			}
			for len(stack) < lvl-1 {
				stack = append(stack, "")
			}
			stack = append(stack, title)
			path = nil
			for _, t := range stack {
				if t != "" {
					path = append(path, t)
				}
			}
			start = next
		}
		pos = next
	}
	return flush(len(s))
}

// fastHeading: "## Projects ##" → 2, "Projects".
func fastHeading(line string) (int, string) {
	if len(line) == 0 || line[0] != '#' {
		return 0, ""
	}
	lvl := 0
	for lvl < len(line) && line[lvl] == '#' {
		lvl++
	}
	if lvl > 3 || lvl == len(line) || (line[lvl] != ' ' && line[lvl] != '\t') {
		return 0, ""
	}
	title := strings.TrimSpace(strings.TrimRight(strings.TrimSpace(line[lvl:]), "#"))
	if title == "" {
		return 0, ""
	}
	return lvl, title
}

// fastPieces makes one item, or several (key, key#2, key#3...) when the text is long.
func fastPieces(key, section, head, body string, at *time.Time, emit fastEmit) bool {
	room := fastMaxItemChars - utf8.RuneCountInString(head) - len(" (part 999)") - 1
	i := 0
	return fastChunksTo(body, room, func(c string) bool {
		i++
		k, h := key, head
		if i > 1 {
			k = fmt.Sprintf("%s#%d", key, i)
			h = fmt.Sprintf("%s (part %d)", head, i)
		}
		it := fastItem{Key: k, Section: section, Content: h + "\n" + c, Occurred: at}
		sum := sha256.New()
		fmt.Fprintf(sum, "%s\x00%s\x00", it.Key, it.Section)
		if at != nil {
			sum.Write([]byte(at.UTC().Format(time.RFC3339)))
		}
		sum.Write([]byte{0})
		sum.Write([]byte(it.Content))
		it.SHA = sum.Sum(nil)
		return emit(it)
	})
}

// fastChunks is fastChunksTo, collected (tests).
func fastChunks(s string, limit int) []string {
	var out []string
	fastChunksTo(s, limit, func(c string) bool { out = append(out, c); return true })
	return out
}

// fastChunksTo cuts text into pieces of at most limit runes, at paragraph breaks, then line
// breaks, then anywhere, handing each to emit until it says stop. Linear in the text: rune
// counts are kept, never recounted, and a long line is walked once.
func fastChunksTo(s string, limit int, emit func(string) bool) bool {
	if utf8.RuneCountInString(s) <= limit {
		return emit(s)
	}
	var cur strings.Builder
	n := 0 // runes in cur
	flush := func() bool {
		t := strings.TrimSpace(cur.String())
		cur.Reset()
		n = 0
		return t == "" || emit(t)
	}
	add := func(piece string, pn int, sep string) bool {
		switch {
		case cur.Len() == 0:
		case n+len(sep)+pn <= limit:
			cur.WriteString(sep)
			n += len(sep)
		default:
			if !flush() {
				return false
			}
		}
		cur.WriteString(piece)
		n += pn
		return true
	}
	for rest := s; ; {
		para, after, more := strings.Cut(rest, "\n\n")
		if pn := utf8.RuneCountInString(para); pn <= limit {
			if !add(para, pn, "\n\n") {
				return false
			}
		} else {
			for lines := para; ; {
				line, after, more := strings.Cut(lines, "\n")
				ln := utf8.RuneCountInString(line)
				for ; ln > limit; ln -= limit {
					i := 0
					for k := 0; k < limit; k++ {
						_, size := utf8.DecodeRuneInString(line[i:])
						i += size
					}
					if !add(line[:i], limit, "\n") {
						return false
					}
					line = line[i:]
				}
				if !add(line, ln, "\n") {
					return false
				}
				if !more {
					break
				}
				lines = after
			}
		}
		if !more {
			break
		}
		rest = after
	}
	return flush()
}

// fastSlug: "Projects & Ideas!" → "projects-ideas". Headings with no ASCII letters or digits
// key by a short hash, which is just as stable.
func fastSlug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(fastTrim(b.String(), fastMaxSlug), "-")
	if out == "" && strings.TrimSpace(s) != "" {
		h := sha256.Sum256([]byte(strings.TrimSpace(s)))
		out = "h" + hex.EncodeToString(h[:4])
	}
	return out
}

// fastUnique adds ~2, ~3... to a key already used in the same upload.
func fastUnique(seen map[string]int, key string) string {
	seen[key]++
	if n := seen[key]; n > 1 {
		return fmt.Sprintf("%s~%d", key, n)
	}
	return key
}

func fastTrim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] // slugs are ASCII
}

// fastLine keeps a title to one short line.
func fastLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > 120 {
		s = string(r[:120]) + "…"
	}
	return s
}
