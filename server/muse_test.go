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
