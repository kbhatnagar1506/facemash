package main

// The connector for people's own AI agents (Meta's Muse first). An attendee creates a
// personal token in the app and gives it to their agent; the agent can then ask us
// things on their behalf. The same tools are served two ways, since Muse builds custom
// connectors from either:
//   - MCP (Model Context Protocol, streamable HTTP, stateless JSON responses) at /api/mcp
//   - a plain REST API described by OpenAPI 3.1 at /api/openapi.json
// Everything is scoped to the token's owner and tenant. Tools are read-only for now.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the image has no zoneinfo; the event runs on Atlanta time
)

const (
	museLabel   = "muse"
	tokenPrefix = "gtq_"
	pairPrefix  = "gtqp_"
	mcpKeyPath  = "/api/mcp/t/"    // + token: the connector URL carries its own key
	nowKeyPath  = "/api/now/t/"    // + token: the one-GET fast path
	memKeyPath  = "/api/memory/t/" // + token: where an agent sends what it remembers
	maxMemory   = 25 << 20         // bytes; uploads go straight to this server (Vercel's proxy caps bodies near 4.5 MB)
	pairTTL     = 10 * time.Minute
	mcpVersion  = "2025-06-18"
	eventTZ     = "America/New_York"
	maxMCPBody  = 64 * 1024
	// one HTTP request runs at most this many tool calls (a JSON-RPC batch can carry hundreds)
	maxBatchCalls = 4
	// uploads, per person: one at a time, a burst of 6 then one every 30 s. In all: at most 4
	// being read at once (each can be 25 MB), and one big one (over 1 MB) being parsed and
	// redacted at a time, which is ~0.5 s of CPU per MB: the game always keeps a core.
	uploadBurst      = 6
	uploadEvery      = 30 * time.Second
	uploadsAtOnce    = 4
	bigUploadsAtOnce = 1
	bigUpload        = 1 << 20
	maxLabel         = 300 // bytes of an MCP request's log label
	serverTitle      = "HackGT 13"
	serverSlug       = "hackgt13"
	serverVer        = "1.0.0"
	instructions     = "Tools for a HackGT 13 attendee (Georgia Tech's hackathon at the Klaus Advanced Computing Building, Sept 25-27 2026). " +
		"Use get_schedule for what's happening and when, get_my_profile for the person you're helping (their name, bean avatar and where they were last in the event's virtual campus), " +
		"and get_whos_here for how many people are in the virtual campus and the Klaus atrium right now. Times are US Eastern."
)

// uploadSlotWait: how long an upload waits for a free slot before "busy, try again".
var uploadSlotWait = 10 * time.Second

// takeSlot waits up to uploadSlotWait for room in ch; false: none came (or the client left).
func takeSlot(ctx context.Context, ch chan struct{}) bool {
	t := time.NewTimer(uploadSlotWait)
	defer t.Stop()
	select {
	case ch <- struct{}{}:
		return true
	case <-t.C:
	case <-ctx.Done():
	}
	return false
}

var supportedMCP = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

func hashToken(t string) []byte {
	h := sha256.Sum256([]byte(t))
	return h[:]
}

func newToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return tokenPrefix + base64.RawURLEncoding.EncodeToString(b)
}

// ---------- the tools ----------

type tool struct {
	Name        string
	Title       string
	Description string
	Input       map[string]any // JSON Schema for the arguments
	Path        string         // REST: GET /api/muse/v1/<Path>
	Run         func(ctx context.Context, c *museCaller, args map[string]any) (any, error)
}

// museCaller is who a request is for, plus what the tools can read.
type museCaller struct {
	tenant  string
	id      int64
	acc     *accounts
	hub     *Hub
	event   string // event.json path
	nowFunc func() time.Time
	label   string // what this request asked for (for the latency log)
}

func (c *museCaller) now() time.Time {
	if c.nowFunc != nil {
		return c.nowFunc()
	}
	return time.Now()
}

var museTools = []tool{
	{
		Name:        "get_happening_now",
		Title:       "HackGT right now",
		Description: "Start here: one call answers most questions. What's happening at HackGT 13 right now and up next (US Eastern), how many people are in the virtual campus and the Klaus atrium, and the attendee you're helping (name, bean, where they were last).",
		Input:       map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		Path:        "now",
		Run: func(ctx context.Context, c *museCaller, _ map[string]any) (any, error) {
			return c.snapshot(ctx)
		},
	},
	{
		Name:        "get_my_profile",
		Title:       "My HackGT profile",
		Description: "The attendee you're helping: their name, email, bean avatar, and where they last were in the HackGT 13 virtual campus (outdoors on campus or inside the Klaus atrium) and when.",
		Input:       map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		Path:        "me",
		Run: func(ctx context.Context, c *museCaller, _ map[string]any) (any, error) {
			a, err := c.acc.store.Account(ctx, c.tenant, c.id)
			if err != nil {
				return nil, err
			}
			out := map[string]any{
				"event":        serverTitle,
				"name":         firstNonEmpty(a.Profile.Name, a.User.Name),
				"google_name":  a.User.Name,
				"email":        a.User.Email,
				"bean":         describeLook(a.Profile.Look, a.Profile.Color),
				"member_since": a.User.Created.UTC().Format(time.RFC3339),
			}
			if p := a.Progress; p != nil {
				place := "outdoors on the Georgia Tech campus"
				if p.Room == "hackgt" {
					place = "inside the Klaus atrium (the HackGT hall)"
				}
				out["last_seen"] = map[string]any{"where": place, "room": p.Room, "at": p.At.UTC().Format(time.RFC3339)}
			} else {
				out["last_seen"] = nil
			}
			return out, nil
		},
	},
	{
		Name:        "get_schedule",
		Title:       "HackGT schedule",
		Description: "HackGT 13's schedule (US Eastern time). when=now (default) gives what's happening right now and what's next; today gives the whole current day; all gives every day.",
		Input: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"when": map[string]any{"type": "string", "enum": []string{"now", "today", "all"}, "default": "now", "description": "now: happening now and up next; today: today's full schedule; all: every day"},
			},
			"additionalProperties": false,
		},
		Path: "schedule",
		Run: func(_ context.Context, c *museCaller, args map[string]any) (any, error) {
			when, _ := args["when"].(string)
			return schedule(c.event, when, c.now())
		},
	},
	{
		Name:        "get_whos_here",
		Title:       "Who's here",
		Description: "How many attendees are in the HackGT 13 virtual campus right now, and how many of them are inside the Klaus atrium.",
		Input:       map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		Path:        "online",
		Run: func(_ context.Context, c *museCaller, _ map[string]any) (any, error) {
			n := c.hub.counts()
			return map[string]any{"online": n["online"], "in_klaus_atrium": n["hackgt"], "on_campus": n["campus"]}, nil
		},
	},
}

// The shared part of "now" (schedule + headcount) is precomputed and reused for
// nowTTL, so answering is a memory read plus one small account lookup.
const nowTTL = 15 * time.Second

var nowCache struct {
	sync.Mutex
	at    time.Time
	event string
	blob  map[string]any
}

func sharedNow(eventFile string, hub *Hub, now time.Time) map[string]any {
	nowCache.Lock()
	defer nowCache.Unlock()
	if nowCache.blob != nil && nowCache.event == eventFile && now.Sub(nowCache.at) < nowTTL && now.After(nowCache.at) {
		return nowCache.blob
	}
	blob := map[string]any{"event": serverTitle, "where": "Klaus Advanced Computing Building, Georgia Tech", "time_zone": eventTZ}
	if sch, err := schedule(eventFile, "now", now); err == nil {
		for k, v := range sch.(map[string]any) {
			blob[k] = v
		}
	}
	if hub != nil {
		n := hub.counts()
		blob["people"] = map[string]any{"online": n["online"], "in_klaus_atrium": n["hackgt"], "on_campus": n["campus"]}
	}
	nowCache.at, nowCache.event, nowCache.blob = now, eventFile, blob
	return blob
}

// snapshot is everything most questions need, in one blob.
func (c *museCaller) snapshot(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	for k, v := range sharedNow(c.event, c.hub, c.now()) {
		out[k] = v
	}
	a, err := c.acc.store.Account(ctx, c.tenant, c.id)
	if err != nil {
		return nil, err
	}
	me := map[string]any{"name": firstNonEmpty(a.Profile.Name, a.User.Name), "email": a.User.Email, "bean": describeLook(a.Profile.Look, a.Profile.Color)}
	if p := a.Progress; p != nil {
		place := "outdoors on the Georgia Tech campus"
		if p.Room == "hackgt" {
			place = "inside the Klaus atrium"
		}
		me["last_seen"] = map[string]any{"where": place, "at": p.At.UTC().Format(time.RFC3339)}
	}
	out["you"] = me
	return out, nil
}

func firstNonEmpty(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

// describeLook turns an encoded bean ("b=#3b63c4;h=headphones;i=phone;…") into words.
func describeLook(look, color string) string {
	if look == "" {
		if color == "" {
			return "a default bean"
		}
		return "a bean in " + color
	}
	f := map[string]string{}
	for _, kv := range strings.Split(look, ";") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			f[k] = v
		}
	}
	parts := []string{"a " + firstNonEmpty(f["b"], color) + " bean"}
	if f["h"] != "" && f["h"] != "none" {
		parts = append(parts, "wearing "+f["h"])
	}
	if f["i"] != "" && f["i"] != "none" {
		parts = append(parts, "holding a "+f["i"])
	}
	if f["l"] != "" && f["l"] != "none" {
		parts = append(parts, "with the "+f["l"]+" logo")
	}
	return strings.Join(parts, ", ")
}

func (h *Hub) counts() map[string]int {
	counts := map[string]int{"online": 0, "campus": 0, "hackgt": 0}
	h.mu.Lock()
	for _, c := range h.clients {
		if c.joined {
			counts["online"]++
			counts[c.p.Room]++
		}
	}
	h.mu.Unlock()
	return counts
}

type schedItem struct {
	Item  string `json:"item"`
	Time  string `json:"time"`
	Start string `json:"start"`
	End   string `json:"end"`
	Where string `json:"where"`
}

type schedDay struct {
	Label string      `json:"label"`
	Date  string      `json:"date"`
	Title string      `json:"title"`
	Items []schedItem `json:"items"`
}

func schedule(eventFile, when string, now time.Time) (any, error) {
	ev, err := eventSchedule(eventFile) // parsed once, re-read when the file changes (warm.go)
	if err != nil {
		return nil, errors.New("schedule unavailable")
	}
	loc := talkLoc()
	now = now.In(loc)
	at := func(date, hm string) (time.Time, bool) {
		t, err := time.ParseInLocation("2006-01-02 15:04", date+" "+hm, loc)
		return t, err == nil
	}
	entry := func(d schedDay, it schedItem) map[string]any {
		m := map[string]any{"what": it.Item, "day": d.Title, "time": it.Time}
		if it.Where != "" {
			m["where"] = it.Where
		}
		return m
	}
	nowStr := now.Format("Monday Jan 2, 3:04 PM MST")
	switch when {
	case "all":
		return map[string]any{"now": nowStr, "days": ev.Days}, nil
	case "today":
		for _, d := range ev.Days {
			if d.Date == now.Format("2006-01-02") {
				return map[string]any{"now": nowStr, "today": d}, nil
			}
		}
		return map[string]any{"now": nowStr, "today": nil, "note": "Nothing is scheduled today; HackGT 13 runs " + dayRange(ev.Days) + "."}, nil
	}
	// now: what's on, then the next three
	type ev2 struct {
		start, end time.Time
		m          map[string]any
	}
	var all []ev2
	for _, d := range ev.Days {
		for _, it := range d.Items {
			s, ok := at(d.Date, it.Start)
			if !ok {
				continue
			}
			e, ok := at(d.Date, it.End)
			if !ok || !e.After(s) {
				e = s.Add(30 * time.Minute) // point-in-time items ("Hacking Begins") count for half an hour
			}
			all = append(all, ev2{s, e, entry(d, it)})
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].start.Before(all[j].start) })
	happening := []map[string]any{}
	next := []map[string]any{}
	for _, e := range all {
		if !now.Before(e.start) && now.Before(e.end) {
			happening = append(happening, e.m)
		} else if e.start.After(now) && len(next) < 3 {
			next = append(next, e.m)
		}
	}
	out := map[string]any{"now": nowStr, "happening_now": happening, "up_next": next}
	if len(all) > 0 && now.After(all[len(all)-1].end) {
		out["note"] = "HackGT 13 is over."
	}
	return out, nil
}

func dayRange(days []schedDay) string {
	if len(days) == 0 {
		return "on its published dates"
	}
	return days[0].Title + " to " + days[len(days)-1].Title
}

// ---------- HTTP: auth, MCP, REST, OpenAPI, tokens ----------

// mountMuse adds the connector endpoints. base is the public origin (for URLs we hand out).
// ingestMemory is the one way a memory about someone gets in, whoever brought it (their
// agent's upload, or what they told the voice guide, voice.go): scrub it, keep the latest
// copy, queue it for their private index (memfast.go) and pick their bean an outfit from
// it (jevlook.go). Always for one (tenant, person), which the caller got from a token or a
// session, never from the body. raw, when given, is obj as it arrived: kept byte for byte
// unless something had to be redacted. It returns the stored JSON and how many items were
// redacted.
func ingestMemory(ctx context.Context, acc *accounts, tenant string, id int64, obj map[string]any, raw []byte, what string) ([]byte, int, error) {
	// guardrail: credentials and sensitive numbers never get stored or indexed, whatever
	// the agent sent (redact.go); only the counts are logged
	counts := map[string]int{}
	obj = redactJSON(obj, counts).(map[string]any)
	redacted := 0
	for _, n := range counts {
		redacted += n
	}
	if redacted > 0 {
		log.Printf("muse: #%d %s: %d item(s) redacted %v", id, what, redacted, counts)
	}
	body := raw
	if redacted > 0 || body == nil {
		var err error
		if body, err = json.Marshal(obj); err != nil {
			return nil, redacted, err
		}
	}
	var exported *time.Time
	if s, _ := obj["exported_at"].(string); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			exported = &t
		}
	}
	if err := acc.store.SaveMemory(ctx, tenant, id, body, exported); err != nil {
		log.Printf("muse: memory for #%d: %v", id, err)
		return nil, redacted, err
	}
	acc.fast.uploaded(ctx, tenant, id) // and into their private memory index, in the background
	acc.jev.suggest(tenant, id, obj)   // and an outfit for their bean, picked from it
	acc.talk.memoryArrived(tenant, id) // and the brief their agent talks from (agenttalk.go)
	return body, redacted, nil
}

func mountMuse(mux *http.ServeMux, acc *accounts, hub *Hub, eventFile, base string, originOK func(*http.Request) bool) {
	// this server's own public address, for big uploads that shouldn't pass through Vercel
	direct := strings.TrimRight(envOr("DIRECT_URL", base), "/")
	writeJSON := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(v)
	}
	// who's calling: a bearer token from the app (never a session cookie, which a
	// cross-site page could ride along on)
	// The token comes as "Authorization: Bearer gtq_…", or inside the connector URL
	// (/api/mcp/t/gtq_…) so an agent only has to register one URL: nothing to sign in to.
	caller := func(r *http.Request) (*museCaller, error) {
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		for _, prefix := range []string{mcpKeyPath, nowKeyPath, memKeyPath, askKeyPath} {
			if inURL, found := strings.CutPrefix(r.URL.Path, prefix); found {
				tok, ok = inURL, true
			}
		}
		if !ok || !strings.HasPrefix(tok, tokenPrefix) {
			return nil, errBadToken
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		tenant, id, err := acc.store.TokenOwner(ctx, hashToken(strings.TrimSpace(tok)))
		if err != nil {
			return nil, err
		}
		return &museCaller{tenant: tenant, id: id, acc: acc, hub: hub, event: eventFile}, nil
	}
	unauthorized := func(w http.ResponseWriter) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="`+serverSlug+`", error="invalid_token", error_description="Create a token in the HackGT 13 app: Connect your Muse"`)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing or invalid token: create one in the HackGT 13 app (Connect your Muse)"})
	}

	// --- MCP ---
	mcp := func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
		case http.MethodGet, http.MethodDelete:
			// stateless server: no server-to-client stream, no sessions to end
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		default:
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !originOK(r) {
			http.Error(w, "bad origin", http.StatusForbidden) // DNS-rebinding guard from the MCP spec
			return
		}
		c, err := caller(r)
		if err != nil {
			unauthorized(w)
			return
		}
		start := time.Now()
		defer func() { calls.add(c.id, "mcp "+c.label, start, time.Since(start)) }()
		body, err := io.ReadAll(io.LimitReader(r.Body, maxMCPBody))
		if err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		body = []byte(strings.TrimSpace(string(body)))
		if len(body) > 0 && body[0] == '[' { // batches (older protocol versions)
			var batch []json.RawMessage
			if json.Unmarshal(body, &batch) != nil {
				writeJSON(w, http.StatusOK, rpcError(nil, -32700, "parse error"))
				return
			}
			var out []any
			toolCalls := 0
			for _, m := range batch {
				var peek struct {
					Method string          `json:"method"`
					ID     json.RawMessage `json:"id"`
				}
				if json.Unmarshal(m, &peek) == nil && peek.Method == "tools/call" {
					if toolCalls++; toolCalls > maxBatchCalls {
						if len(peek.ID) > 0 && string(peek.ID) != "null" {
							out = append(out, rpcError(peek.ID, -32600, fmt.Sprintf("at most %d tool calls per request: send the rest separately", maxBatchCalls)))
						}
						continue
					}
				}
				if resp := handleRPC(r.Context(), c, m); resp != nil {
					out = append(out, resp)
				}
			}
			if len(out) == 0 {
				w.WriteHeader(http.StatusAccepted)
				return
			}
			writeJSON(w, http.StatusOK, out)
			return
		}
		resp := handleRPC(r.Context(), c, body)
		if resp == nil { // a notification or a response: nothing to say
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("MCP-Protocol-Version", mcpVersion)
		writeJSON(w, http.StatusOK, resp)
	}
	mux.HandleFunc("/api/mcp", mcp)
	mux.HandleFunc(mcpKeyPath, mcp)

	// --- REST (the same tools) ---
	for _, t := range museTools {
		t := t
		mux.HandleFunc("/api/muse/v1/"+t.Path, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", "GET")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			c, err := caller(r)
			if err != nil {
				unauthorized(w)
				return
			}
			start := time.Now()
			defer func() { calls.add(c.id, "GET "+r.URL.Path, start, time.Since(start)) }()
			args := map[string]any{}
			for k, v := range r.URL.Query() {
				args[k] = v[0]
			}
			ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
			defer cancel()
			out, err := t.Run(ctx, c, args)
			if err != nil {
				log.Printf("muse: %s for #%d: %v", t.Name, c.id, err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, out)
		})
	}
	// the fast path: one GET, one JSON blob (key in the Authorization header or in the URL)
	nowHandler := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && (r.Method != http.MethodPost || acc.fast == nil) {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		c, err := caller(r)
		if err != nil {
			unauthorized(w)
			return
		}
		start := time.Now()
		label := "GET /api/now"
		defer func() { calls.add(c.id, label, start, time.Since(start)) }()
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		// ?q= (or POST {"q"}) also searches the person's own notes, alongside (memfast.go)
		mem := acc.fast.nowMemory(r, c)
		if mem != nil {
			label = r.Method + " /api/now +memory"
		}
		out, err := c.snapshot(ctx)
		if err != nil {
			log.Printf("muse: now for #%d: %v", c.id, err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
		if mem != nil {
			out["memory"] = <-mem
		}
		writeJSON(w, http.StatusOK, out)
	}
	mux.HandleFunc("/api/now", nowHandler)
	mux.HandleFunc(nowKeyPath, nowHandler)

	// an agent sends what it remembers about its person (their choice: the page asks first)
	uploads := newKeyLimiter(uploadBurst, uploadEvery, 1)
	reading := make(chan struct{}, uploadsAtOnce)
	parsingBig := make(chan struct{}, bigUploadsAtOnce)
	busy := func(w http.ResponseWriter) {
		w.Header().Set("Retry-After", "10")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "busy: send it again in a few seconds"})
	}
	memoryHandler := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodPut {
			w.Header().Set("Allow", "POST")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST one JSON object"})
			return
		}
		c, err := caller(r)
		if err != nil {
			unauthorized(w)
			return
		}
		release, wait, ok := uploads.acquire(fastWho{c.tenant, c.id})
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(wait.Seconds())))))
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "you just sent your memory; wait a moment before sending it again"})
			return
		}
		defer release()
		if !takeSlot(r.Context(), reading) {
			busy(w)
			return
		}
		defer func() { <-reading }()
		start := time.Now()
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxMemory+1))
		label := fmt.Sprintf("POST /api/memory %.1fKB", float64(len(raw))/1024)
		defer func() { calls.add(c.id, label, start, time.Since(start)) }()
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "couldn't read the body"})
			return
		}
		if len(raw) > maxMemory {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "over 25 MB: send only the memory files, not everything"})
			return
		}
		if len(raw) > bigUpload {
			if !takeSlot(r.Context(), parsingBig) {
				busy(w)
				return
			}
			defer func() { <-parsingBig }()
		}
		var obj map[string]any
		if json.Unmarshal(raw, &obj) != nil || obj == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "send one JSON object"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		body, redacted, err := ingestMemory(ctx, acc, c.tenant, c.id, obj, raw, "memory upload")
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "kb": float64(len(body)*10/1024) / 10, "redacted": redacted})
	}
	mux.HandleFunc("/api/memory", memoryHandler)
	mux.HandleFunc(memKeyPath, memoryHandler)
	// questions about the person themself, answered from their own notes (memfast.go)
	if acc.fast != nil {
		ask := acc.fast.askHandler(caller, unauthorized, writeJSON)
		mux.HandleFunc("/api/ask", ask)
		mux.HandleFunc(askKeyPath, ask)
	}

	// for the page: what's stored (never the content), and a way to delete it
	mux.HandleFunc("/api/muse/memory", func(w http.ResponseWriter, r *http.Request) {
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if r.Method == http.MethodDelete || r.Method == http.MethodPost {
			if r.Header.Get("Origin") == "" || !originOK(r) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
				return
			}
			// the index copy first: once that's recorded, its erase happens even across restarts
			if err := acc.fast.forget(ctx, acc.tenant, id); err != nil {
				log.Printf("muse: memory purge for #%d: %v", id, err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
				return
			}
			acc.jev.forget(ctx, acc.tenant, id)
			acc.talk.forget(ctx, acc.tenant, id)
			if err := acc.store.DeleteMemory(ctx, acc.tenant, id); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		info, err := acc.store.MemoryInfo(ctx, acc.tenant, id)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
		writeJSON(w, http.StatusOK, info)
	})

	// latency test: "I'm asking my agent now", then how fast it came to us and got its answer
	mux.HandleFunc("/api/muse/ask", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Origin") == "" || !originOK(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		calls.ask(id, time.Now())
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/api/muse/latency", func(w http.ResponseWriter, r *http.Request) {
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"questions": calls.report(id, time.Now())})
	})

	mux.HandleFunc("/api/openapi.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		writeJSON(w, http.StatusOK, openAPI(base))
	})

	// --- tokens, from the signed-in app ---
	sameSite := func(r *http.Request) bool {
		return r.Method == http.MethodPost && r.Header.Get("Origin") != "" && originOK(r)
	}
	mux.HandleFunc("/api/muse/token", func(w http.ResponseWriter, r *http.Request) {
		if !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		tok := newToken()
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		if err := acc.store.CreateToken(ctx, acc.tenant, id, museLabel, hashToken(tok)); err != nil {
			log.Printf("muse: token for #%d: %v", id, err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable"})
			return
		}
		// the token is shown once; only its hash is kept
		writeJSON(w, http.StatusOK, connectInfo(base, tok))
	})
	mux.HandleFunc("/api/muse/revoke", func(w http.ResponseWriter, r *http.Request) {
		if !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		if err := acc.store.RevokeTokens(ctx, acc.tenant, id, museLabel); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// --- pairing (personal QR) ---
	pairs := newPairings()
	mux.HandleFunc("/api/muse/pair", func(w http.ResponseWriter, r *http.Request) {
		if !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		code, exp := pairs.create(acc.tenant, id)
		writeJSON(w, http.StatusOK, map[string]any{
			"code":    code,
			"expires": exp.UTC().Format(time.RFC3339),
			// the code rides in the fragment: it never reaches a server log or a Referer
			"url":    base + "/muse#" + code,
			"prompt": pairPrompt(base, code, exp),
		})
	})
	// the agent redeems the code (no session: it's the agent calling, from anywhere)
	mux.HandleFunc("/api/muse/claim", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			// link previews and crawlers GET things; only a deliberate POST redeems a code
			w.Header().Set("Allow", "POST")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": `POST {"code": "gtqp_..."} to redeem a pairing code`})
			return
		}
		if !pairs.allow(clientIP(r)) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, wait a minute"})
			return
		}
		var in struct{ Code string }
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1024))
		if json.Unmarshal(b, &in) != nil || !strings.HasPrefix(strings.TrimSpace(in.Code), pairPrefix) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": `send JSON {"code": "gtqp_..."}`})
			return
		}
		p, ok := pairs.take(strings.TrimSpace(in.Code))
		if !ok {
			writeJSON(w, http.StatusGone, map[string]string{"error": "this pairing code was already used or has expired; make a new one in the HackGT 13 app (Connect your Muse)"})
			return
		}
		tok := newToken()
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		if err := acc.store.CreateToken(ctx, p.tenant, p.id, museLabel, hashToken(tok)); err != nil {
			log.Printf("muse: claim for #%d: %v", p.id, err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable, try again"})
			return
		}
		log.Printf("muse: #%d paired an agent", p.id)
		info := connectInfo(base, tok)
		info["connector_url"] = base + mcpKeyPath + tok
		info["now_url"] = base + nowKeyPath + tok
		// straight to this server, not through Vercel's proxy (which caps request bodies)
		info["memory_url"] = direct + memKeyPath + tok
		info["memory_prompt"] = memoryPrompt(direct + memKeyPath + tok)
		info["prompt"] = connectorPrompt(base, tok)
		acc.fast.prompts(info, base, tok) // + the memory fast path, when it's on
		info["token_type"] = "Bearer"
		info["next"] = "Save token as a secret credential (never show it in chat). Use it as \"Authorization: Bearer <token>\" for the MCP server at " + base + "/api/mcp or the REST API described at " + base + "/api/openapi.json."
		writeJSON(w, http.StatusOK, info)
	})
	// for the app: is an agent connected yet (so the QR screen can say so)?
	mux.HandleFunc("/api/muse/status", func(w http.ResponseWriter, r *http.Request) {
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		st, err := acc.store.TokenStatus(ctx, acc.tenant, id, museLabel)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable"})
			return
		}
		st["pairing"] = pairs.pending(acc.tenant, id)
		writeJSON(w, http.StatusOK, st)
	})
}

// ---------- pairing: the personal QR ----------

// A pairing code is a one-time, 10-minute ticket that the attendee hands their agent
// (through a QR or a copy button); the agent trades it for a real token at /api/muse/claim.
// Codes live in memory (they're short-lived) and only their hashes are kept.
type pairings struct {
	mu    sync.Mutex
	codes map[string]pairing // sha256(code) → owner
	hits  map[string][]time.Time
}

type pairing struct {
	tenant string
	id     int64
	exp    time.Time
}

func newPairings() *pairings {
	return &pairings{codes: map[string]pairing{}, hits: map[string][]time.Time{}}
}

func (p *pairings) create(tenant string, id int64) (string, time.Time) {
	b := make([]byte, 24)
	rand.Read(b)
	code := pairPrefix + base64.RawURLEncoding.EncodeToString(b)
	exp := time.Now().Add(pairTTL)
	p.mu.Lock()
	defer p.mu.Unlock()
	for h, q := range p.codes { // one live code per person; drop expired ones
		if (q.tenant == tenant && q.id == id) || time.Now().After(q.exp) {
			delete(p.codes, h)
		}
	}
	p.codes[string(hashToken(code))] = pairing{tenant, id, exp}
	return code, exp
}

// take redeems a code once.
func (p *pairings) take(code string) (pairing, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := string(hashToken(code))
	q, ok := p.codes[h]
	delete(p.codes, h)
	if !ok || time.Now().After(q.exp) {
		return pairing{}, false
	}
	return q, true
}

func (p *pairings) pending(tenant string, id int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, q := range p.codes {
		if q.tenant == tenant && q.id == id && time.Now().Before(q.exp) {
			return true
		}
	}
	return false
}

// allow rate-limits claims per client IP (codes are unguessable; this just keeps noise down).
func (p *pairings) allow(ip string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	recent := p.hits[ip][:0]
	for _, t := range p.hits[ip] {
		if now.Sub(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= 20 {
		p.hits[ip] = recent
		return false
	}
	p.hits[ip] = append(recent, now)
	if len(p.hits) > 10000 { // don't grow without bound
		p.hits = map[string][]time.Time{}
	}
	return true
}

func clientIP(r *http.Request) string {
	// behind Vercel and Caddy: the first hop in X-Forwarded-For is the caller
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

// pairPrompt is what the attendee pastes into their agent.
func pairPrompt(base, code string, exp time.Time) string {
	loc, _ := time.LoadLocation(eventTZ)
	return "Connect to my HackGT 13 account.\n" +
		"1. Send an HTTP POST to " + base + "/api/muse/claim with the JSON body {\"code\": \"" + code + "\"}. It works once and expires at " + exp.In(loc).Format("3:04 PM MST") + ".\n" +
		"2. The response contains a token. Save it as a secret credential for HackGT 13 (a bearer token). Don't show it to me or repeat it in chat.\n" +
		"3. Build a custom integration to HackGT 13: its MCP server URL is " + base + "/api/mcp (OpenAPI document: " + base + "/api/openapi.json), and every request uses that token as \"Authorization: Bearer <token>\".\n" +
		"4. Then tell me what's happening at HackGT right now."
}

// connectorPrompt is what the attendee pastes into their agent: a fast path it can use for
// every question (one GET, one JSON blob) and an explicit "don't do the slow thing", since
// agents default to handshaking, listing tools and chaining calls.
// memoryPrompt asks the agent to send what it remembers about its person, fast: a script
// moves the files from disk to us so they never pass through the agent's context, a
// defined "done" so it stops, and nothing about other people.
func memoryPrompt(url string) string {
	return "Send all of your memory about me to my HackGT 13 account. The link below contains my private key: never show it in chat.\n" +
		"Be fast: no narration, no questions, no exploring.\n" +
		memorySteps(url) +
		"4. Reply \"done\" + KB sent. Nothing else."
}

// memorySteps: script, don't converse (the files go from disk to us, never through the
// agent's context), nothing about other people, and a time limit so it stops.
func memorySteps(url string) string {
	return "1. Write a script (python or bash) that reads these files and POSTs them as ONE JSON object to " + url + " :\n" +
		"   ~/MEMORY.md, ~/USER.md, ~/memory/*.md, ~/memory/bank/experience.md, ~/memory/bank/opinions.md, ~/memory/bank/reflections.md, ~/memory/bank/world.md\n" +
		"   Skip files that don't exist. Never include ~/memory/people/ or anything about other people. Don't paste file contents into chat: the script reads them straight off disk.\n" +
		"   Never send credentials or anything sensitive: leave out any line with a password, API key, token, private key, card or bank number, government ID number, or health detail.\n" +
		"2. JSON shape: {\"user_id\": \"<my name>\", \"exported_at\": \"<UTC ISO time>\", \"memory_md\": \"...\", \"user_md\": \"...\", " +
		"\"daily_notes\": [{\"date\": \"...\", \"content\": \"...\"}], \"bank\": {\"experience\": \"...\", \"opinions\": \"...\", \"reflections\": \"...\", \"world\": \"...\"}}\n" +
		"3. Run it. If any step takes over 30 seconds, skip it and tell me.\n"
}

func connectorPrompt(base, tok string) string {
	return "Save this as my HackGT 13 skill. Both links contain my private key: keep them secret and never show them in chat.\n" +
		"FAST PATH, use it for every HackGT question: make ONE HTTP GET to " + base + nowKeyPath + tok +
		" and answer from the JSON it returns (what's on now and next, how many people are here, and my profile). " +
		"Don't list tools, don't do an MCP handshake, don't make other calls first.\n" +
		"Only if that doesn't cover the question: the MCP server at " + base + mcpKeyPath + tok + " has the full schedule (get_schedule with when=all).\n" +
		"Now tell me what's happening at HackGT right now."
}

// connectInfo is what the app shows (and what you'd paste into Muse).
func connectInfo(base, tok string) map[string]any {
	return map[string]any{
		"token":   tok,
		"mcp":     base + "/api/mcp",
		"openapi": base + "/api/openapi.json",
		"prompt": "Build a custom integration to HackGT 13. Its MCP server URL is " + base + "/api/mcp " +
			"(OpenAPI document: " + base + "/api/openapi.json). It uses a bearer token, which I'll give you through the secure credential flow. " +
			"I want you to be able to tell me what's happening at HackGT, what's next, and what my HackGT profile says.",
	}
}

// ---------- JSON-RPC / MCP ----------

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func rpcResult(id json.RawMessage, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func rpcError(id json.RawMessage, code int, msg string) map[string]any {
	var idv any = id
	if id == nil {
		idv = nil
	}
	return map[string]any{"jsonrpc": "2.0", "id": idv, "error": map[string]any{"code": code, "message": msg}}
}

// handleRPC answers one message; nil means no reply (notifications, stray responses).
func handleRPC(ctx context.Context, c *museCaller, raw json.RawMessage) any {
	var m rpcReq
	if json.Unmarshal(raw, &m) != nil || m.JSONRPC != "2.0" {
		return rpcError(nil, -32700, "parse error")
	}
	// one line per call, so we can see what agents actually ask (names only, no payloads)
	tool := ""
	if m.Method == "tools/call" {
		var p struct {
			Name string `json:"name"`
		}
		json.Unmarshal(m.Params, &p)
		tool = " " + p.Name
	}
	if len(c.label) < maxLabel {
		if c.label != "" {
			c.label += ", "
		}
		c.label += m.Method + tool
		if len(c.label) >= maxLabel {
			c.label = fastHead(c.label, maxLabel) + "…"
		}
	}
	if m.Method == "" { // a response to something we never sent
		return nil
	}
	if len(m.ID) == 0 || string(m.ID) == "null" { // notification
		return nil
	}
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(m.Params, &p)
		v := mcpVersion
		for _, s := range supportedMCP {
			if p.ProtocolVersion == s {
				v = s
			}
		}
		return rpcResult(m.ID, map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": serverSlug, "title": serverTitle, "version": serverVer},
			"instructions":    instructions,
		})
	case "ping":
		return rpcResult(m.ID, map[string]any{})
	case "tools/list":
		list := make([]map[string]any, 0, len(museTools))
		for _, t := range c.tools() {
			list = append(list, map[string]any{
				"name": t.Name, "title": t.Title, "description": t.Description, "inputSchema": t.Input,
				"annotations": map[string]any{"title": t.Title, "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
			})
		}
		return rpcResult(m.ID, map[string]any{"tools": list})
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return rpcError(m.ID, -32602, "invalid params")
		}
		for _, t := range c.tools() {
			if t.Name != p.Name {
				continue
			}
			if p.Arguments == nil {
				p.Arguments = map[string]any{}
			}
			cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
			out, err := t.Run(cctx, c, p.Arguments)
			cancel()
			if err != nil {
				log.Printf("muse: %s for #%d: %v", t.Name, c.id, err)
				return rpcResult(m.ID, map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": "Couldn't get that right now: " + err.Error()}}})
			}
			b, _ := json.Marshal(out)
			return rpcResult(m.ID, map[string]any{
				"content":           []any{map[string]any{"type": "text", "text": string(b)}},
				"structuredContent": out,
				"isError":           false,
			})
		}
		return rpcError(m.ID, -32602, fmt.Sprintf("unknown tool: %s", p.Name))
	case "resources/list":
		return rpcResult(m.ID, map[string]any{"resources": []any{}})
	case "prompts/list":
		return rpcResult(m.ID, map[string]any{"prompts": []any{}})
	}
	return rpcError(m.ID, -32601, "method not found: "+m.Method)
}

// ---------- OpenAPI ----------

func openAPI(base string) map[string]any {
	paths := map[string]any{}
	for _, t := range museTools {
		op := map[string]any{
			"operationId": t.Name,
			"summary":     t.Title,
			"description": t.Description,
			"security":    []any{map[string]any{"bearer": []any{}}},
			"responses": map[string]any{
				"200": map[string]any{"description": "OK", "content": map[string]any{"application/json": map[string]any{"schema": map[string]any{"type": "object"}}}},
				"401": map[string]any{"description": "Missing or invalid token"},
			},
		}
		if props, _ := t.Input["properties"].(map[string]any); len(props) > 0 {
			var params []any
			for name, schema := range props {
				s, _ := schema.(map[string]any)
				params = append(params, map[string]any{"name": name, "in": "query", "required": false, "description": s["description"], "schema": s})
			}
			op["parameters"] = params
		}
		paths["/api/muse/v1/"+t.Path] = map[string]any{"get": op}
	}
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "HackGT 13 attendee API",
			"version":     serverVer,
			"description": instructions + " Authenticate with the personal token from the HackGT 13 app (Connect your Muse) as a bearer token.",
		},
		"servers":    []any{map[string]any{"url": base}},
		"paths":      paths,
		"components": map[string]any{"securitySchemes": map[string]any{"bearer": map[string]any{"type": "http", "scheme": "bearer", "description": "Personal token starting gtq_"}}},
	}
}

// mintTestToken makes (or reuses) a test account for email and prints a fresh connector
// token for it: for trying the connector before Google sign-in is switched on.
// Run on the VM: docker exec game /app/server -muse-token you@example.com
func mintTestToken(email, keyFile, base string) {
	a := openAccounts(keyFile)
	if a == nil {
		log.Fatal("no database")
	}
	defer a.store.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	acc, _, err := a.store.SignIn(ctx, a.tenant, user{Sub: "test:" + email, Email: email, Name: "Test attendee", Given: "Test"})
	if err != nil {
		log.Fatal(err)
	}
	tok := newToken()
	if err := a.store.CreateToken(ctx, a.tenant, acc.ID, museLabel, hashToken(tok)); err != nil {
		log.Fatal(err)
	}
	json.NewEncoder(os.Stdout).Encode(connectInfo(base, tok))
}

// mintTestSession prints a session cookie value for a test account (made if needed).
// Run on the VM: docker exec game /app/server -session-for you@example.com -session-key /data/session.key
func mintTestSession(email, keyFile string) {
	a := openAccounts(keyFile)
	if a == nil {
		log.Fatal("no database")
	}
	defer a.store.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	acc, _, err := a.store.SignIn(ctx, a.tenant, user{Sub: "test:" + email, Email: email, Name: "Test attendee", Given: "Test"})
	if err != nil {
		log.Fatal(err)
	}
	v, _ := a.sess.issue(kindSession, acc.ID, time.Hour)
	fmt.Println(v)
}

// ---------- latency log ----------

// calls remembers each person's recent agent calls (in memory, last 300) and the moments
// they said "I'm asking now", so a question can be timed: ask → the agent's first call to
// us → our last response. Calls less than questionGap apart belong to the same question.
var calls = &callLog{by: map[int64][]museCall{}, asks: map[int64][]time.Time{}}

const questionGap = 20 * time.Second

type museCall struct {
	At   time.Time
	What string
	Dur  time.Duration
}

type callLog struct {
	mu   sync.Mutex
	by   map[int64][]museCall
	asks map[int64][]time.Time
}

func (l *callLog) add(id int64, what string, at time.Time, d time.Duration) {
	log.Printf("agent: #%d %s %.1fms", id, what, float64(d.Microseconds())/1000)
	l.mu.Lock()
	defer l.mu.Unlock()
	cs := append(l.by[id], museCall{at, what, d})
	if len(cs) > 300 {
		cs = cs[len(cs)-300:]
	}
	l.by[id] = cs
}

func (l *callLog) ask(id int64, at time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	as := append(l.asks[id], at)
	if len(as) > 50 {
		as = as[len(as)-50:]
	}
	l.asks[id] = as
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// report: the last few questions, newest first.
func (l *callLog) report(id int64, now time.Time) []map[string]any {
	l.mu.Lock()
	cs := append([]museCall(nil), l.by[id]...)
	asks := append([]time.Time(nil), l.asks[id]...)
	l.mu.Unlock()
	type burst struct{ calls []museCall }
	var bursts []burst
	for _, c := range cs {
		if n := len(bursts); n > 0 {
			last := bursts[n-1].calls[len(bursts[n-1].calls)-1]
			if c.At.Sub(last.At.Add(last.Dur)) < questionGap {
				bursts[n-1].calls = append(bursts[n-1].calls, c)
				continue
			}
		}
		bursts = append(bursts, burst{[]museCall{c}})
	}
	var out []map[string]any
	used := map[int]bool{}
	for _, a := range asks {
		q := map[string]any{"asked_at": a.UTC().Format(time.RFC3339Nano)}
		for i, b := range bursts {
			if used[i] || b.calls[0].At.Before(a) || b.calls[0].At.Sub(a) > 5*time.Minute {
				continue
			}
			used[i] = true
			fillBurst(q, b.calls)
			q["ask_to_first_call_ms"] = ms(b.calls[0].At.Sub(a))
			last := b.calls[len(b.calls)-1]
			q["ask_to_last_response_ms"] = ms(last.At.Add(last.Dur).Sub(a))
			break
		}
		if q["calls"] == nil {
			if now.Sub(a) > 5*time.Minute {
				q["status"] = "no calls came"
			} else {
				q["status"] = "waiting for the agent"
			}
		}
		out = append(out, q)
	}
	// calls nobody timed still show, so every question is visible
	for i, b := range bursts {
		if !used[i] {
			q := map[string]any{"asked_at": nil}
			fillBurst(q, b.calls)
			out = append(out, q)
		}
	}
	sort.Slice(out, func(i, j int) bool { return sortKey(out[i]) > sortKey(out[j]) })
	if len(out) > 15 {
		out = out[:15]
	}
	return out
}

func fillBurst(q map[string]any, cs []museCall) {
	var server time.Duration
	what := make([]string, 0, len(cs))
	for _, c := range cs {
		server += c.Dur
		what = append(what, c.What)
	}
	last := cs[len(cs)-1]
	q["first_call_at"] = cs[0].At.UTC().Format(time.RFC3339Nano)
	q["calls"] = len(cs)
	q["what"] = what
	q["fetch_span_ms"] = ms(last.At.Add(last.Dur).Sub(cs[0].At))
	q["server_ms"] = ms(server)
}

func sortKey(q map[string]any) string {
	if s, ok := q["asked_at"].(string); ok {
		return s
	}
	s, _ := q["first_call_at"].(string)
	return s
}
