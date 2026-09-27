package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConnectionsChat(t *testing.T) {
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	ctx := context.Background()
	a, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "a", Email: "a@x.test", Name: "Ann Lee", Given: "Ann"})
	b, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "b", Email: "b@x.test", Name: "Bo Kim", Given: "Bo"})
	c, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "c", Email: "c@x.test", Name: "Cy", Given: "Cy"})
	rec := &talkRecord{ID: "tk_1", Tenant: "hackgt13", A: a.ID, B: b.ID, State: "revealed", Started: time.Now().UTC(),
		Icebreaker: &talkIcebreaker{Line: "You both fight BLE pairing.", Question: "What finally worked?"}}
	store.talkCreate(ctx, rec)
	nomatch := &talkRecord{ID: "tk_2", Tenant: "hackgt13", A: a.ID, B: c.ID, State: "no_match", Started: time.Now().UTC()}
	store.talkCreate(ctx, nomatch)
	mux := http.NewServeMux()
	hub := newHub()
	mountConnections(mux, acc, hub, func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	defer func() { conns = nil }()
	conns.revealed(rec) // what the reveal does
	srv := httptest.NewServer(mux)
	defer srv.Close()
	do := func(method, path string, who int64, origin, body string) (int, map[string]any) {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		v, exp := acc.sess.issue(kindSession, who, time.Hour)
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: v, Expires: exp})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	code, out := do("GET", "/api/connections", a.ID, "", "")
	list, _ := out["connections"].([]any)
	if code != 200 || len(list) != 1 {
		t.Fatalf("Ann has one connection (the match, not the no-match): %d %v", code, out)
	}
	first := list[0].(map[string]any)
	if first["other"].(map[string]any)["first_name"] != "Bo" || !strings.Contains(first["last"].(map[string]any)["text"].(string), "BLE pairing") {
		t.Fatalf("with Bo, opened by the icebreaker: %v", first)
	}
	if code, _ := do("POST", "/api/connections/tk_1/messages", a.ID, "https://evil.test", `{"text":"hi"}`); code != 403 {
		t.Fatalf("another site: %d", code)
	}
	if code, m := do("POST", "/api/connections/tk_1/messages", a.ID, "https://site.test", `{"text":"hey Bo! what finally worked?"}`); code != 200 || m["from"] != "you" {
		t.Fatalf("Ann says hi: %d %v", code, m)
	}
	code, out = do("GET", "/api/connections/tk_1/messages", b.ID, "", "")
	msgs, _ := out["messages"].([]any)
	if code != 200 || len(msgs) != 2 || msgs[0].(map[string]any)["from"] != "agents" || msgs[1].(map[string]any)["from"] != "them" || out["other"].(map[string]any)["first_name"] != "Ann" {
		t.Fatalf("Bo sees the agents' line then Ann's: %d %v", code, out)
	}
	last := msgs[1].(map[string]any)["id"].(float64)
	if _, out = do("GET", fmt.Sprintf("/api/connections/tk_1/messages?after=%d", int64(last)), b.ID, "", ""); len(out["messages"].([]any)) != 0 {
		t.Fatalf("after the last one: nothing new: %v", out)
	}
	if code, _ := do("GET", "/api/connections/tk_1/messages", c.ID, "", ""); code != 404 {
		t.Fatalf("Cy can't read their thread: %d", code)
	}
	if code, _ := do("GET", "/api/connections/tk_2/messages", a.ID, "", ""); code != 404 {
		t.Fatalf("a no-match isn't a connection: %d", code)
	}
}
