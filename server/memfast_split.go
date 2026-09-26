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
	fastMaxTotalBytes = 5 << 20 // per person, across every item
	fastMaxItems      = 500     // per person
	fastMaxSlug       = 60      // bytes of a heading in a key
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

// fastSplit turns an upload into items, highest priority first (user_md, memory_md, daily
// notes newest first, then the bank), and applies the per-person caps; cut says how many
// sections the caps left out.
func fastSplit(obj map[string]any) (items []fastItem, cut int) {
	var all []fastItem
	if s, ok := obj["user_md"].(string); ok {
		all = append(all, fastMarkdown("muse:user_md", "user_md", "About me (USER.md)", s)...)
	}
	if s, ok := obj["memory_md"].(string); ok {
		all = append(all, fastMarkdown("muse:memory_md", "memory_md", "Long-term memory (MEMORY.md)", s)...)
	}
	all = append(all, fastDaily(obj["daily_notes"])...)
	if bank, ok := obj["bank"].(map[string]any); ok {
		for _, name := range fastBankFiles {
			if s := fastText(bank[name]); s != "" {
				all = append(all, fastMarkdown("muse:bank:"+name, "bank", "Memory bank: "+name, s)...)
			}
		}
	}
	total := 0
	for i, it := range all {
		if len(items) >= fastMaxItems || total+len(it.Content) > fastMaxTotalBytes {
			return items, len(all) - i
		}
		total += len(it.Content)
		items = append(items, it)
	}
	return items, 0
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

// fastDaily reads daily_notes as [{date, content}] (what the prompt asks for) or {date: content}.
func fastDaily(v any) []fastItem {
	type note struct{ date, content string }
	var notes []note
	switch t := v.(type) {
	case []any:
		for _, e := range t {
			if m, ok := e.(map[string]any); ok {
				d, _ := m["date"].(string)
				notes = append(notes, note{d, fastText(m["content"])})
			}
		}
	case map[string]any:
		for d, c := range t {
			notes = append(notes, note{d, fastText(c)})
		}
	}
	// newest first; undated last, in a stable order
	sort.SliceStable(notes, func(i, j int) bool {
		di, dj := fastDateRE.FindString(notes[i].date), fastDateRE.FindString(notes[j].date)
		if di != dj {
			return di > dj
		}
		return notes[i].date < notes[j].date
	})
	var out []fastItem
	seen := map[string]int{}
	for _, n := range notes {
		body := strings.TrimSpace(fastClean(n.content))
		if body == "" {
			continue
		}
		label, key := "undated", "undated"
		var at *time.Time
		if d := fastDateRE.FindString(n.date); d != "" {
			if t, err := time.Parse("2006-01-02", d); err == nil {
				noon := t.Add(12 * time.Hour) // noon UTC keeps the date the same across US time zones
				at, label, key = &noon, d, d
			}
		} else if s := fastSlug(n.date); s != "" {
			label, key = strings.TrimSpace(fastClean(n.date)), s
		}
		key = fastUnique(seen, "muse:daily:"+key)
		out = append(out, fastPieces(key, "daily_note", "Daily note — "+fastLine(label), body, at)...)
	}
	return out
}

// fastMarkdown cuts a file at its headings (levels 1-3; not inside code fences). The text
// before the first heading keys as the file itself.
func fastMarkdown(base, section, label, s string) []fastItem {
	type part struct {
		path []string
		body []string
	}
	parts := []part{{}}
	var stack []string // heading titles by level
	fence := ""
	for _, line := range strings.Split(fastClean(s), "\n") {
		trim := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(trim, fence) {
				fence = ""
			}
		} else if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			fence = trim[:3]
		} else if lvl, title := fastHeading(line); lvl > 0 {
			if len(stack) >= lvl {
				stack = stack[:lvl-1]
			}
			for len(stack) < lvl-1 {
				stack = append(stack, "")
			}
			stack = append(stack, title)
			var path []string
			for _, t := range stack {
				if t != "" {
					path = append(path, t)
				}
			}
			parts = append(parts, part{path: path})
			continue
		}
		parts[len(parts)-1].body = append(parts[len(parts)-1].body, line)
	}
	var out []fastItem
	seen := map[string]int{}
	for _, p := range parts {
		body := strings.TrimSpace(strings.Join(p.body, "\n"))
		if body == "" {
			continue
		}
		key, head := base, label
		if len(p.path) > 0 {
			slugs := make([]string, 0, len(p.path))
			for _, t := range p.path {
				slugs = append(slugs, fastSlug(t))
			}
			key = base + ":" + fastTrim(strings.Join(slugs, "/"), fastMaxSlug*2)
			head = label + " — " + fastLine(strings.Join(p.path, " › "))
		}
		out = append(out, fastPieces(fastUnique(seen, key), section, head, body, nil)...)
	}
	return out
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
func fastPieces(key, section, head, body string, at *time.Time) []fastItem {
	room := fastMaxItemChars - utf8.RuneCountInString(head) - len(" (part 999)") - 1
	chunks := fastChunks(body, room)
	out := make([]fastItem, 0, len(chunks))
	for i, c := range chunks {
		k, h := key, head
		if i > 0 {
			k = fmt.Sprintf("%s#%d", key, i+1)
			h = fmt.Sprintf("%s (part %d)", head, i+1)
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
		out = append(out, it)
	}
	return out
}

// fastChunks cuts text into pieces of at most limit runes, at paragraph breaks, then line
// breaks, then anywhere.
func fastChunks(s string, limit int) []string {
	if utf8.RuneCountInString(s) <= limit {
		return []string{s}
	}
	var out []string
	cur := ""
	flush := func() {
		if t := strings.TrimSpace(cur); t != "" {
			out = append(out, t)
		}
		cur = ""
	}
	add := func(piece, sep string) {
		if cur == "" {
			cur = piece
		} else if utf8.RuneCountInString(cur)+len(sep)+utf8.RuneCountInString(piece) <= limit {
			cur += sep + piece
		} else {
			flush()
			cur = piece
		}
	}
	for _, para := range strings.Split(s, "\n\n") {
		if utf8.RuneCountInString(para) <= limit {
			add(para, "\n\n")
			continue
		}
		for _, line := range strings.Split(para, "\n") {
			for utf8.RuneCountInString(line) > limit {
				r := []rune(line)
				add(string(r[:limit]), "\n")
				line = string(r[limit:])
			}
			add(line, "\n")
		}
	}
	flush()
	return out
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
