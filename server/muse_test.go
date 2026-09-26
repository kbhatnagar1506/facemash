package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func museServer(t *testing.T) (*httptest.Server, *accounts, *memStore, int64, string) {
	t.Helper()
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	a, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "g-1", Email: "buzz@gatech.edu", Name: "Buzz Bee", Given: "Buzz"})
	store.SaveProfile(context.Background(), "hackgt13", a.ID, Profile{Name: "Buzz", Color: "#4f7fd6", Look: "b=#3b63c4;h=headphones;i=phone;l=hackgt"})
	store.SaveProgress(context.Background(), "hackgt13", a.ID, Progress{Room: "hackgt", X: 1, Z: 2})
	tok := newToken()
	store.CreateToken(context.Background(), "hackgt13", a.ID, museLabel, hashToken(tok))
	hub := newHub()
	mux := http.NewServeMux()
	mountMuse(mux, acc, hub, "event.json", "https://site.test", func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, acc, store, a.ID, tok
}

func rpc(t *testing.T, url, tok, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", url+"/api/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestMCP(t *testing.T) {
	srv, _, _, _, tok := museServer(t)

	if code, _ := rpc(t, srv.URL, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := rpc(t, srv.URL, "gtq_nope", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); code != http.StatusUnauthorized {
		t.Fatalf("bad token: %d", code)
	}

	code, init := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`)
	res, _ := init["result"].(map[string]any)
	if code != 200 || res["protocolVersion"] != "2025-03-26" || res["serverInfo"].(map[string]any)["name"] != "hackgt13" {
		t.Fatalf("initialize: %d %v", code, init)
	}
	if code, _ := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); code != http.StatusAccepted {
		t.Fatalf("notification: %d", code)
	}

	_, list := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := list["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(museTools) {
		t.Fatalf("tools: %v", tools)
	}

	_, me := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_my_profile","arguments":{}}}`)
	sc := me["result"].(map[string]any)["structuredContent"].(map[string]any)
	if sc["name"] != "Buzz" || sc["email"] != "buzz@gatech.edu" || !strings.Contains(sc["bean"].(string), "headphones") || sc["last_seen"].(map[string]any)["room"] != "hackgt" {
		t.Fatalf("profile: %v", sc)
	}
	text := me["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "buzz@gatech.edu") {
		t.Fatalf("text content: %s", text)
	}

	_, sch := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_schedule","arguments":{"when":"all"}}}`)
	if sch["result"].(map[string]any)["isError"] != false {
		t.Fatalf("schedule: %v", sch)
	}
	_, who := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_whos_here"}}`)
	if who["result"].(map[string]any)["structuredContent"].(map[string]any)["online"] != 0.0 {
		t.Fatalf("online: %v", who)
	}
	_, bad := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nope"}}`)
	if bad["error"] == nil {
		t.Fatalf("unknown tool: %v", bad)
	}
	_, unk := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":7,"method":"sampling/whatever"}`)
	if unk["error"].(map[string]any)["code"] != -32601.0 {
		t.Fatalf("unknown method: %v", unk)
	}
	// the key can ride in the connector URL instead of a header
	for path, want := range map[string]int{"/api/mcp/t/" + tok: 200, "/api/mcp/t/gtq_wrong": 401, "/api/mcp/t/": 401} {
		req, _ := http.NewRequest("POST", srv.URL+path, strings.NewReader(`{"jsonrpc":"2.0","id":9,"method":"tools/list"}`))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != want {
			t.Fatalf("POST %s: %d, want %d", path[:14], res.StatusCode, want)
		}
	}
	// a page on another site can't drive it through someone's browser
	req, _ := http.NewRequest("POST", srv.URL+"/api/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Origin", "https://evil.test")
	if res, _ := http.DefaultClient.Do(req); res.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", res.StatusCode)
	}
}

func TestMuseRESTAndOpenAPI(t *testing.T) {
	srv, _, _, _, tok := museServer(t)
	get := func(path, tok string) (int, map[string]any) {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := get("/api/muse/v1/me", ""); code != 401 {
		t.Fatalf("rest without token: %d", code)
	}
	if code, me := get("/api/muse/v1/me", tok); code != 200 || me["name"] != "Buzz" {
		t.Fatalf("rest me: %d %v", code, me)
	}
	if code, s := get("/api/muse/v1/schedule?when=today", tok); code != 200 || s["now"] == nil {
		t.Fatalf("rest schedule: %d %v", code, s)
	}
	code, doc := get("/api/openapi.json", "")
	paths, _ := doc["paths"].(map[string]any)
	if code != 200 || doc["openapi"] != "3.1.0" || len(paths) != len(museTools) || doc["servers"].([]any)[0].(map[string]any)["url"] != "https://site.test" {
		t.Fatalf("openapi: %d %v", code, doc)
	}
}

func TestMuseTokens(t *testing.T) {
	srv, acc, store, id, old := museServer(t)
	cookie := func() *http.Cookie {
		v, exp := acc.sess.issue(kindSession, id, time.Hour)
		return &http.Cookie{Name: sessionCookie, Value: v, Expires: exp}
	}
	post := func(path, origin string, c *http.Cookie) (int, map[string]any) {
		req, _ := http.NewRequest("POST", srv.URL+path, nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if c != nil {
			req.AddCookie(c)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := post("/api/muse/token", "https://evil.test", cookie()); code != 403 {
		t.Fatalf("cross-site token: %d", code)
	}
	if code, _ := post("/api/muse/token", "https://site.test", nil); code != 401 {
		t.Fatalf("signed-out token: %d", code)
	}
	code, info := post("/api/muse/token", "https://site.test", cookie())
	fresh, _ := info["token"].(string)
	if code != 200 || !strings.HasPrefix(fresh, tokenPrefix) || info["mcp"] != "https://site.test/api/mcp" || !strings.Contains(info["prompt"].(string), "/api/mcp") {
		t.Fatalf("token: %d %v", code, info)
	}
	// a new token replaces the old one
	if code, _ := rpc(t, srv.URL, old, `{"jsonrpc":"2.0","id":1,"method":"ping"}`); code != 401 {
		t.Fatalf("old token still works: %d", code)
	}
	if code, _ := rpc(t, srv.URL, fresh, `{"jsonrpc":"2.0","id":1,"method":"ping"}`); code != 200 {
		t.Fatalf("new token: %d", code)
	}
	// only the hash is stored
	for h := range store.tokens {
		if strings.Contains(h, fresh) {
			t.Fatal("token stored in the clear")
		}
	}
	if code, _ := post("/api/muse/revoke", "https://site.test", cookie()); code != 204 {
		t.Fatalf("revoke: %d", code)
	}
	if code, _ := rpc(t, srv.URL, fresh, `{"jsonrpc":"2.0","id":1,"method":"ping"}`); code != 401 {
		t.Fatalf("revoked token still works: %d", code)
	}
}

func TestSchedule(t *testing.T) {
	loc, _ := time.LoadLocation(eventTZ)
	at := time.Date(2026, 9, 25, 17, 45, 0, 0, loc) // Friday: team formation and the sponsor fair
	out, err := schedule("event.json", "now", at)
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	now := m["happening_now"].([]map[string]any)
	names := []string{}
	for _, e := range now {
		names = append(names, e["what"].(string))
	}
	if !strings.Contains(strings.Join(names, ","), "Team Formation") || !strings.Contains(strings.Join(names, ","), "Sponsor Fair") {
		t.Fatalf("happening at 5:45 PM Friday: %v", names)
	}
	if next := m["up_next"].([]map[string]any); len(next) == 0 || next[0]["what"] != "Dinner" {
		t.Fatalf("up next: %v", m["up_next"])
	}
	if over, _ := schedule("event.json", "now", time.Date(2026, 10, 5, 12, 0, 0, 0, loc)); over.(map[string]any)["note"] != "HackGT 13 is over." {
		t.Fatalf("after the event: %v", over)
	}
	if d := describeLook("b=#3b63c4;h=headphones;i=phone;l=hackgt", ""); d != "a #3b63c4 bean, wearing headphones, holding a phone, with the hackgt logo" {
		t.Fatalf("describeLook: %q", d)
	}
}

func TestMusePairing(t *testing.T) {
	srv, acc, _, id, _ := museServer(t)
	cookie := func() *http.Cookie {
		v, exp := acc.sess.issue(kindSession, id, time.Hour)
		return &http.Cookie{Name: sessionCookie, Value: v, Expires: exp}
	}
	do := func(method, path, origin, body string, c *http.Cookie) (int, map[string]any) {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if c != nil {
			req.AddCookie(c)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := do("POST", "/api/muse/pair", "https://evil.test", "", cookie()); code != 403 {
		t.Fatalf("cross-site pair: %d", code)
	}
	if code, _ := do("POST", "/api/muse/pair", "https://site.test", "", nil); code != 401 {
		t.Fatalf("signed-out pair: %d", code)
	}
	code, p := do("POST", "/api/muse/pair", "https://site.test", "", cookie())
	pc, _ := p["code"].(string)
	if code != 200 || !strings.HasPrefix(pc, pairPrefix) || p["url"] != "https://site.test/muse#"+pc || !strings.Contains(p["prompt"].(string), pc) || !strings.Contains(p["prompt"].(string), "/api/muse/claim") {
		t.Fatalf("pair: %d %v", code, p)
	}
	if _, st := do("GET", "/api/muse/status", "", "", cookie()); st["pairing"] != true {
		t.Fatalf("status while pairing: %v", st)
	}
	// a link preview GETting the page can't spend the code
	if code, _ := do("GET", "/api/muse/claim?code="+pc, "", "", nil); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET claim: %d", code)
	}
	code, got := do("POST", "/api/muse/claim", "", `{"code":"`+pc+`"}`, nil)
	tok, _ := got["token"].(string)
	if code != 200 || !strings.HasPrefix(tok, tokenPrefix) || got["mcp"] != "https://site.test/api/mcp" || got["connector_url"] != "https://site.test/api/mcp/t/"+tok || !strings.Contains(got["prompt"].(string), "/api/mcp/t/"+tok) {
		t.Fatalf("claim: %d %v", code, got)
	}
	if code, _ := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_my_profile"}}`); code != 200 {
		t.Fatalf("claimed token doesn't work: %d", code)
	}
	if code, _ := do("POST", "/api/muse/claim", "", `{"code":"`+pc+`"}`, nil); code != http.StatusGone {
		t.Fatalf("second claim: %d", code)
	}
	if _, st := do("GET", "/api/muse/status", "", "", cookie()); st["connected"] != true || st["pairing"] != false || st["last_used"] == nil {
		t.Fatalf("status after claim: %v", st)
	}
	// a new code replaces the old one; expired codes don't work
	_, p1 := do("POST", "/api/muse/pair", "https://site.test", "", cookie())
	_, p2 := do("POST", "/api/muse/pair", "https://site.test", "", cookie())
	if code, _ := do("POST", "/api/muse/claim", "", `{"code":"`+p1["code"].(string)+`"}`, nil); code != http.StatusGone {
		t.Fatalf("replaced code still works: %d", code)
	}
	pp := newPairings()
	c, _ := pp.create("hackgt13", id)
	for h, q := range pp.codes {
		q.exp = time.Now().Add(-time.Second)
		pp.codes[h] = q
	}
	if _, ok := pp.take(c); ok {
		t.Fatal("expired code redeemed")
	}
	if code, _ := do("POST", "/api/muse/claim", "", `{"code":"nope"}`, nil); code != 400 {
		t.Fatalf("junk code: %d", code)
	}
	_ = p2
	// hammering the claim endpoint gets throttled
	last := 0
	for i := 0; i < 25; i++ {
		last, _ = do("POST", "/api/muse/claim", "", `{"code":"gtqp_guess"}`, nil)
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("no rate limit: %d", last)
	}
}

func TestNowFastPath(t *testing.T) {
	srv, _, _, _, tok := museServer(t)
	get := func(path, auth string) (int, map[string]any) {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	for _, c := range []struct{ path, auth string }{{"/api/now/t/" + tok, ""}, {"/api/now", tok}} {
		code, out := get(c.path, c.auth)
		you, _ := out["you"].(map[string]any)
		people, _ := out["people"].(map[string]any)
		if code != 200 || out["now"] == nil || out["happening_now"] == nil || out["up_next"] == nil || people == nil || you["name"] != "Buzz" || you["last_seen"] == nil {
			t.Fatalf("GET %s: %d %v", c.path[:9], code, out)
		}
	}
	if code, _ := get("/api/now", ""); code != 401 {
		t.Fatalf("no key: %d", code)
	}
	if code, _ := get("/api/now/t/gtq_wrong", ""); code != 401 {
		t.Fatalf("bad key: %d", code)
	}
	// the same snapshot as one MCP tool, listed first
	_, list := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if first := list["result"].(map[string]any)["tools"].([]any)[0].(map[string]any); first["name"] != "get_happening_now" {
		t.Fatalf("first tool: %v", first["name"])
	}
	_, now := rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_happening_now"}}`)
	if sc := now["result"].(map[string]any)["structuredContent"].(map[string]any); sc["you"] == nil || sc["happening_now"] == nil {
		t.Fatalf("get_happening_now: %v", sc)
	}
}

func TestNowCache(t *testing.T) {
	loc, _ := time.LoadLocation(eventTZ)
	t0 := time.Date(2026, 9, 25, 17, 45, 0, 0, loc)
	a := sharedNow("event.json", nil, t0)
	b := sharedNow("event.json", nil, t0.Add(5*time.Second))
	if a["now"] != b["now"] {
		t.Fatal("within the TTL the snapshot should be reused")
	}
	c := sharedNow("event.json", nil, t0.Add(nowTTL+time.Minute)) // "now" reads to the minute
	if c["now"] == a["now"] {
		t.Fatal("after the TTL the snapshot should refresh")
	}
}

func TestPromptFastPath(t *testing.T) {
	p := connectorPrompt("https://site.test", "gtq_abc")
	for _, want := range []string{"ONE HTTP GET to https://site.test/api/now/t/gtq_abc", "Don't list tools", "https://site.test/api/mcp/t/gtq_abc", "keep them secret"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt is missing %q", want)
		}
	}
}

func TestLatencyReport(t *testing.T) {
	l := &callLog{by: map[int64][]museCall{}, asks: map[int64][]time.Time{}}
	t0 := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)
	l.ask(1, t0)
	l.add(1, "GET /api/now", t0.Add(4200*time.Millisecond), 30*time.Millisecond)
	l.add(1, "mcp tools/call get_schedule", t0.Add(6*time.Second), 20*time.Millisecond)
	// a second question a minute later, untimed
	l.add(1, "GET /api/now", t0.Add(70*time.Second), 25*time.Millisecond)
	l.ask(1, t0.Add(2*time.Minute)) // asked, nothing yet
	rep := l.report(1, t0.Add(2*time.Minute+time.Second))
	if len(rep) != 3 {
		t.Fatalf("questions: %d %v", len(rep), rep)
	}
	if rep[0]["status"] != "waiting for the agent" {
		t.Fatalf("newest should be waiting: %v", rep[0])
	}
	timed := rep[2]
	if timed["calls"] != 2 || timed["ask_to_first_call_ms"] != 4200.0 || timed["ask_to_last_response_ms"] != 6020.0 || timed["server_ms"] != 50.0 {
		t.Fatalf("timed question: %v", timed)
	}
	if rep[1]["asked_at"] != nil || rep[1]["calls"] != 1 {
		t.Fatalf("untimed question: %v", rep[1])
	}
	if other := l.report(2, t0); len(other) != 0 {
		t.Fatalf("someone else's calls leaked: %v", other)
	}
}
