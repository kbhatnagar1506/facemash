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
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the image has no zoneinfo; the event runs on Atlanta time
)

const (
	museLabel    = "muse"
	tokenPrefix  = "gtq_"
	pairPrefix   = "gtqp_"
	pairTTL      = 10 * time.Minute
	mcpVersion   = "2025-06-18"
	eventTZ      = "America/New_York"
	maxMCPBody   = 64 * 1024
	serverTitle  = "HackGT 13"
	serverSlug   = "hackgt13"
	serverVer    = "1.0.0"
	instructions = "Tools for a HackGT 13 attendee (Georgia Tech's hackathon at the Klaus Advanced Computing Building, Sept 25-27 2026). " +
		"Use get_schedule for what's happening and when, get_my_profile for the person you're helping (their name, bean avatar and where they were last in the event's virtual campus), " +
		"and get_whos_here for how many people are in the virtual campus and the Klaus atrium right now. Times are US Eastern."
)

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
}

func (c *museCaller) now() time.Time {
	if c.nowFunc != nil {
		return c.nowFunc()
	}
	return time.Now()
}

var museTools = []tool{
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
	b, err := os.ReadFile(eventFile)
	if err != nil {
		return nil, errors.New("schedule unavailable")
	}
	var ev struct {
		Days []schedDay `json:"days"`
	}
	if json.Unmarshal(b, &ev) != nil {
		return nil, errors.New("schedule unavailable")
	}
	loc, _ := time.LoadLocation(eventTZ)
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
func mountMuse(mux *http.ServeMux, acc *accounts, hub *Hub, eventFile, base string, originOK func(*http.Request) bool) {
	writeJSON := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(v)
	}
	// who's calling: a bearer token from the app (never a session cookie, which a
	// cross-site page could ride along on)
	caller := func(r *http.Request) (*museCaller, error) {
		auth := r.Header.Get("Authorization")
		tok, ok := strings.CutPrefix(auth, "Bearer ")
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
	mux.HandleFunc("/api/mcp", func(w http.ResponseWriter, r *http.Request) {
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
			for _, m := range batch {
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
	})

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
		delete(info, "prompt")
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
		for _, t := range museTools {
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
		for _, t := range museTools {
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
