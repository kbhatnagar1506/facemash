package main

// Reading a memory upload without letting its shape cost more than its bytes.
//
// An upload can be 25 MB (agents send whole memory folders straight to this server), and
// decoding that into map[string]any is what used to take the game down: 25 MB of tiny values
// ([0,0,...] or [{},{},...]) becomes about 1 GB of interfaces and maps. So an upload is read
// in two cheap passes over its bytes, and only what something here actually uses is built:
//
//  1. memoryShape walks the bytes once, allocating nothing, and rejects what no memory export
//     looks like: nesting deeper than maxMemoryDepth, or more than maxMemoryValues values.
//  2. The memory prompt's fields are decoded (user_id, exported_at, user_md, memory_md,
//     daily_notes, bank.{experience, opinions, reflections, world}: what fastSplit, jevState
//     and ingestMemory read). Everything else is skipped by the scanner without being built
//     (and so never stored either), and the lists that could still grow (notes, paragraphs)
//     are capped as they are read.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	maxMemoryDepth  = 32      // a memory export is 4 levels deep: {daily_notes: [{content: [...]}]}
	maxMemoryValues = 500_000 // every string, number, list and object counts; notes and files are few and long
	maxMemoryNotes  = 20_000  // daily notes (fastSplit looks at fastMaxNotes of them)
	maxMemoryParts  = 50_000  // paragraphs in one list-valued file or note
)

// memoryError is a rejected upload: the status to answer with and why.
type memoryError struct {
	status int
	msg    string
}

func (e *memoryError) Error() string { return e.msg }

var (
	errMemoryNotObject = &memoryError{http.StatusBadRequest, "send one JSON object"}
	errMemoryTooDeep   = &memoryError{http.StatusBadRequest, fmt.Sprintf("nested over %d levels deep: send the memory files as the prompt shows", maxMemoryDepth)}
	errMemoryTooMany   = &memoryError{http.StatusRequestEntityTooLarge, "too many separate values: send the memory files as text, as the prompt shows"}
)

// decodeMemory reads an upload into the object the rest of the server works with. Only the
// fields listed above are kept; a rejected upload returns a *memoryError.
func decodeMemory(b []byte) (map[string]any, error) {
	if err := memoryShape(b); err != nil {
		return nil, err
	}
	var doc struct {
		UserID     memString `json:"user_id"`
		ExportedAt memString `json:"exported_at"`
		UserMD     memString `json:"user_md"`
		MemoryMD   memString `json:"memory_md"`
		DailyNotes memNotes  `json:"daily_notes"`
		Bank       memBank   `json:"bank"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		var me *memoryError
		if errors.As(err, &me) {
			return nil, me
		}
		return nil, errMemoryNotObject
	}
	obj := map[string]any{}
	for k, v := range map[string]memString{"user_id": doc.UserID, "exported_at": doc.ExportedAt, "user_md": doc.UserMD, "memory_md": doc.MemoryMD} {
		if v.ok {
			obj[k] = v.s
		}
	}
	if doc.DailyNotes.v != nil {
		obj["daily_notes"] = doc.DailyNotes.v
	}
	if doc.Bank.v != nil {
		obj["bank"] = doc.Bank.v
	}
	return obj, nil
}

// readMemoryBody reads an upload body of up to maxMemory bytes; errUploadTooBig past that.
// With a Content-Length it reads into one buffer of that size (io.ReadAll's doublings would
// leave about as much again behind as garbage).
func readMemoryBody(r io.Reader, length int64) ([]byte, error) {
	if length > maxMemory {
		return nil, errUploadTooBig
	}
	if length < 0 {
		raw, err := io.ReadAll(io.LimitReader(r, maxMemory+1))
		if err == nil && len(raw) > maxMemory {
			err = errUploadTooBig
		}
		return raw, err
	}
	raw := make([]byte, length)
	n, err := io.ReadFull(r, raw)
	if errors.Is(err, io.ErrUnexpectedEOF) {
		err = io.EOF
	}
	return raw[:n], err
}

var errUploadTooBig = errors.New("over 25 MB")

// bigParse: one big upload (over bigUpload bytes) is parsed at a time, whether in its
// handler or read back by a memory-index worker (memfast.go).
var bigParse = make(chan struct{}, bigUploadsAtOnce)

// takeParseSlot waits for bigParse (a worker: no deadline, but it gives up when stopping).
func takeParseSlot(ctx context.Context, stop <-chan struct{}) bool {
	select {
	case bigParse <- struct{}{}:
		return true
	case <-ctx.Done():
	case <-stop:
	}
	return false
}

// memoryShape: one pass over the bytes, nothing allocated. It checks the top level is an
// object and counts depth and values; json.Unmarshal checks the rest of the syntax after.
func memoryShape(b []byte) error {
	i := jsonSkipWS(b, 0)
	if i >= len(b) || b[i] != '{' {
		return errMemoryNotObject
	}
	depth, values := 0, 0
	for ; i < len(b); i++ {
		switch c := b[i]; c {
		case '"':
			i = jsonStringEnd(b, i) - 1
			// a string after ':' or in a list is a value; a key isn't
			if j := jsonSkipWS(b, i+1); j >= len(b) || b[j] != ':' {
				values++
			}
		case '{', '[':
			depth++
			values++
			if depth > maxMemoryDepth {
				return errMemoryTooDeep
			}
		case '}', ']':
			depth--
		case ' ', '\t', '\r', '\n', ',', ':':
		default: // a number, true, false or null
			values++
			for i+1 < len(b) && !jsonDelim(b[i+1]) {
				i++
			}
		}
		if values > maxMemoryValues {
			return errMemoryTooMany
		}
	}
	return nil
}

func jsonDelim(c byte) bool {
	switch c {
	case ',', '}', ']', ' ', '\t', '\r', '\n', ':', '"', '{', '[':
		return true
	}
	return false
}

func jsonSkipWS(b []byte, i int) int {
	for i < len(b) && (b[i] == ' ' || b[i] == '\t' || b[i] == '\r' || b[i] == '\n') {
		i++
	}
	return i
}

// jsonStringEnd: the index just past the string that starts at b[i] ('"').
func jsonStringEnd(b []byte, i int) int {
	for j := i + 1; j < len(b); j++ {
		switch b[j] {
		case '\\':
			j++
		case '"':
			return j + 1
		}
	}
	return len(b)
}

// jsonValueEnd: the index just past the value that starts at b[i]. b is valid JSON (these
// run inside json.Unmarshal, which has checked it).
func jsonValueEnd(b []byte, i int) int {
	switch b[i] {
	case '"':
		return jsonStringEnd(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); j++ {
			switch b[j] {
			case '"':
				j = jsonStringEnd(b, j) - 1
			case '{', '[':
				depth++
			case '}', ']':
				if depth--; depth == 0 {
					return j + 1
				}
			}
		}
		return len(b)
	}
	j := i
	for j < len(b) && !jsonDelim(b[j]) {
		j++
	}
	return j
}

// jsonEach calls fn with each element of the (valid) JSON list or object in b, without
// copying: key is nil for a list, and the raw key (quotes included) for an object.
func jsonEach(b []byte, fn func(key, val []byte) error) error {
	i := jsonSkipWS(b, 0)
	if i >= len(b) || (b[i] != '[' && b[i] != '{') {
		return nil
	}
	obj := b[i] == '{'
	i++
	for {
		i = jsonSkipWS(b, i)
		if i >= len(b) || b[i] == ']' || b[i] == '}' {
			return nil
		}
		var key []byte
		if obj {
			end := jsonStringEnd(b, i)
			key = b[i:end]
			i = jsonSkipWS(b, end) + 1 // past ':'
			i = jsonSkipWS(b, i)
		}
		end := jsonValueEnd(b, i)
		if err := fn(key, b[i:end]); err != nil {
			return err
		}
		i = jsonSkipWS(b, end)
		if i < len(b) && b[i] == ',' {
			i++
		}
	}
}

// memString keeps a JSON string; anything else is ignored.
type memString struct {
	s  string
	ok bool
}

func (m *memString) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || b[0] != '"' {
		return nil
	}
	m.s, m.ok = jsonUnquote(b)
	return nil
}

// jsonUnquote decodes a (valid) JSON string literal into one allocation. (encoding/json
// makes two for a string with escapes in it, which every markdown file has: 50 MB for 25.)
// Invalid UTF-8 and lone surrogates become U+FFFD, as encoding/json does.
func jsonUnquote(b []byte) (string, bool) {
	if len(b) < 2 || b[0] != '"' || b[len(b)-1] != '"' {
		return "", false
	}
	b = b[1 : len(b)-1]
	var sb strings.Builder
	sb.Grow(len(b))
	for i := 0; i < len(b); {
		c := b[i]
		switch {
		case c == '\\' && i+1 < len(b):
			i += 2
			switch b[i-1] {
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('\t')
			case 'r':
				sb.WriteByte('\r')
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'u':
				r := jsonHex4(b, i)
				if r < 0 {
					return "", false
				}
				i += 4
				if utf16.IsSurrogate(r) {
					r2 := rune(-1)
					if i+1 < len(b) && b[i] == '\\' && b[i+1] == 'u' {
						r2 = jsonHex4(b, i+2)
					}
					if dec := utf16.DecodeRune(r, r2); dec != utf8.RuneError {
						i += 6
						r = dec
					} else {
						r = utf8.RuneError
					}
				}
				sb.WriteRune(r)
			default: // \" \\ \/
				sb.WriteByte(b[i-1])
			}
		case c < utf8.RuneSelf:
			sb.WriteByte(c)
			i++
		default:
			r, size := utf8.DecodeRune(b[i:])
			if r == utf8.RuneError && size == 1 {
				sb.WriteRune(utf8.RuneError)
			} else {
				sb.Write(b[i : i+size])
			}
			i += size
		}
	}
	return sb.String(), true
}

func jsonHex4(b []byte, i int) rune {
	if i+4 > len(b) {
		return -1
	}
	var r rune
	for _, c := range b[i : i+4] {
		switch {
		case c >= '0' && c <= '9':
			c -= '0'
		case c >= 'a' && c <= 'f':
			c = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			c = c - 'A' + 10
		default:
			return -1
		}
		r = r*16 + rune(c)
	}
	return r
}

// marshalMemory is json.Marshal for a decoded upload (strings, lists and objects of them),
// written into one buffer of the right size; anything else goes through json.Marshal.
func marshalMemory(v any) ([]byte, error) {
	n, ok := jsonSize(v)
	if !ok {
		return json.Marshal(v)
	}
	return appendJSON(make([]byte, 0, n), v), nil
}

// jsonSize: an upper bound on v's encoding; false for types appendJSON doesn't write.
func jsonSize(v any) (int, bool) {
	switch t := v.(type) {
	case string:
		return jsonStringSize(t), true
	case []any:
		n := 2
		for _, e := range t {
			m, ok := jsonSize(e)
			if !ok {
				return 0, false
			}
			n += m + 1
		}
		return n, true
	case map[string]any:
		n := 2
		for k, e := range t {
			m, ok := jsonSize(e)
			if !ok {
				return 0, false
			}
			n += jsonStringSize(k) + m + 2
		}
		return n, true
	}
	return 0, false
}

// jsonStringSize: the exact length of appendJSONString's output.
func jsonStringSize(s string) int {
	n := 2
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\t':
				n += 2
			case c < 0x20:
				n += 6
			default:
				n++
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1, r == '\u2028', r == '\u2029':
			n += 6
		default:
			n += size
		}
		i += size
	}
	return n
}

func appendJSON(dst []byte, v any) []byte {
	switch t := v.(type) {
	case string:
		return appendJSONString(dst, t)
	case []any:
		dst = append(dst, '[')
		for i, e := range t {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = appendJSON(dst, e)
		}
		return append(dst, ']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		dst = append(dst, '{')
		for i, k := range keys {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = appendJSONString(dst, k)
			dst = append(dst, ':')
			dst = appendJSON(dst, t[k])
		}
		return append(dst, '}')
	}
	return append(dst, "null"...)
}

func appendJSONString(dst []byte, s string) []byte {
	const hex = "0123456789abcdef"
	dst = append(dst, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < utf8.RuneSelf {
			i++
			continue
		}
		if c < utf8.RuneSelf {
			dst = append(dst, s[start:i]...)
			switch c {
			case '"', '\\':
				dst = append(dst, '\\', c)
			case '\n':
				dst = append(dst, '\\', 'n')
			case '\r':
				dst = append(dst, '\\', 'r')
			case '\t':
				dst = append(dst, '\\', 't')
			default:
				dst = append(dst, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
			}
			i++
			start = i
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			dst = append(dst, s[start:i]...)
			dst = append(dst, "\\ufffd"...)
			i += size
			start = i
			continue
		}
		if r == '\u2028' || r == '\u2029' {
			dst = append(dst, s[start:i]...)
			dst = append(dst, '\\', 'u', '2', '0', '2', hex[r&0xf])
			i += size
			start = i
			continue
		}
		i += size
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}

// memText is a file's text: a string, or a list of strings (paragraphs; fastText joins them).
type memText struct{ v any }

func (m *memText) UnmarshalJSON(b []byte) error {
	switch {
	case len(b) == 0:
	case b[0] == '"':
		var s string
		if json.Unmarshal(b, &s) == nil {
			m.v = s
		}
	case b[0] == '[':
		var parts []any
		err := jsonEach(b, func(_, val []byte) error {
			if len(parts) >= maxMemoryParts {
				return errMemoryTooMany
			}
			var s memString
			s.UnmarshalJSON(val)
			if s.ok {
				parts = append(parts, s.s)
			}
			return nil
		})
		if err != nil {
			return err
		}
		m.v = parts
	}
	return nil
}

// memBank keeps bank.{experience, opinions, reflections, world}.
type memBank struct{ v map[string]any }

func (m *memBank) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || b[0] != '{' {
		return nil
	}
	var bank struct {
		Experience  memText `json:"experience"`
		Opinions    memText `json:"opinions"`
		Reflections memText `json:"reflections"`
		World       memText `json:"world"`
	}
	if err := json.Unmarshal(b, &bank); err != nil {
		return err
	}
	m.v = map[string]any{}
	for k, t := range map[string]memText{"experience": bank.Experience, "opinions": bank.Opinions, "reflections": bank.Reflections, "world": bank.World} {
		if t.v != nil {
			m.v[k] = t.v
		}
	}
	return nil
}

// memNotes keeps daily_notes as [{date, content}] (what the prompt asks for) or {date: content}.
type memNotes struct{ v any }

func (m *memNotes) UnmarshalJSON(b []byte) error {
	if len(b) == 0 {
		return nil
	}
	n := 0
	count := func() error {
		if n++; n > maxMemoryNotes {
			return errMemoryTooMany
		}
		return nil
	}
	switch b[0] {
	case '[':
		notes := []any{}
		err := jsonEach(b, func(_, val []byte) error {
			if err := count(); err != nil {
				return err
			}
			if val[0] != '{' {
				return nil
			}
			var note struct {
				Date    memString `json:"date"`
				Content memText   `json:"content"`
			}
			if err := json.Unmarshal(val, &note); err != nil {
				return err
			}
			if note.Content.v == nil && !note.Date.ok {
				return nil // nothing anyone reads
			}
			out := map[string]any{}
			if note.Date.ok {
				out["date"] = note.Date.s
			}
			if note.Content.v != nil {
				out["content"] = note.Content.v
			}
			notes = append(notes, out)
			return nil
		})
		if err != nil {
			return err
		}
		m.v = notes
	case '{':
		notes := map[string]any{}
		err := jsonEach(b, func(key, val []byte) error {
			if err := count(); err != nil {
				return err
			}
			var date string
			var content memText
			if json.Unmarshal(key, &date) != nil {
				return nil
			}
			if err := content.UnmarshalJSON(val); err != nil {
				return err
			}
			if content.v != nil {
				notes[date] = content.v
			}
			return nil
		})
		if err != nil {
			return err
		}
		m.v = notes
	}
	return nil
}

// ---------- reading the body: a deadline and a minimum rate ----------

// A slow body holds one of the few upload slots (each can buffer 25 MB), so a trickle is cut
// off: no byte for uploadIdle, under uploadMinRate on average once uploadGrace has passed, or
// still going after uploadMaxTime (25 MB in 3 minutes is ~140 KB/s).
var (
	uploadIdle    = 15 * time.Second
	uploadGrace   = 10 * time.Second
	uploadMaxTime = 3 * time.Minute
	uploadMinRate = 32 << 10 // bytes a second
)

var errUploadSlow = errors.New("upload too slow")

// slowBody enforces the rate on r's body through the connection's read deadline.
type slowBody struct {
	r     io.Reader
	rc    *http.ResponseController
	start time.Time
	n     int64
}

func newSlowBody(w http.ResponseWriter, r *http.Request) *slowBody {
	s := &slowBody{r: r.Body, rc: http.NewResponseController(w), start: time.Now()}
	s.rc.SetReadDeadline(s.deadline(s.start))
	return s
}

func (s *slowBody) deadline(now time.Time) time.Time {
	d := now.Add(uploadIdle)
	if end := s.start.Add(uploadMaxTime); end.Before(d) {
		d = end
	}
	return d
}

func (s *slowBody) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	s.n += int64(n)
	now := time.Now()
	if el := now.Sub(s.start); el > uploadGrace && float64(s.n) < float64(uploadMinRate)*el.Seconds() && err == nil {
		return n, errUploadSlow
	}
	if n > 0 {
		s.rc.SetReadDeadline(s.deadline(now))
	}
	return n, err
}

// done clears the deadline (the connection may carry more requests).
func (s *slowBody) done() { s.rc.SetReadDeadline(time.Time{}) }
