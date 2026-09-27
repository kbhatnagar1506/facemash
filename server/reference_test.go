package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReferenceSetByOrganizersOnly(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "boss@x.test")
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	boss, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "b", Email: "boss@x.test", Name: "Boss"})
	guest, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "g", Email: "guest@x.test", Name: "Guest"})
	mux := http.NewServeMux()
	adm := mountAdmin(mux, acc, nil)
	file := filepath.Join(t.TempDir(), "reference.json")
	ok := func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" }
	mountReference(mux, acc, nil, adm, ok, openRefStore(file))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	do := func(method string, who int64, origin, body string) (int, map[string]any) {
		req, _ := http.NewRequest(method, srv.URL+"/api/reference", strings.NewReader(body))
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if who != 0 {
			v, exp := acc.sess.issue(kindSession, who, time.Hour)
			req.AddCookie(&http.Cookie{Name: sessionCookie, Value: v, Expires: exp})
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
	if c, out := do("GET", 0, "", ""); c != 200 || len(out) != 0 {
		t.Fatalf("no reference yet: %d %v", c, out)
	}
	if c, _ := do("POST", guest.ID, "https://site.test", `{"x":3.2,"z":-1.5,"table":5}`); c != 403 {
		t.Fatalf("an attendee can't set it: %d", c)
	}
	if c, _ := do("POST", boss.ID, "https://evil.test", `{"x":3.2,"z":-1.5,"table":5}`); c != 403 {
		t.Fatalf("another site can't set it: %d", c)
	}
	if c, _ := do("POST", boss.ID, "https://site.test", `{"x":900,"z":0}`); c != 400 {
		t.Fatalf("outside the hall: %d", c)
	}
	if c, out := do("POST", boss.ID, "https://site.test", `{"x":3.2,"z":-1.5,"table":5}`); c != 200 || out["table"] != float64(5) {
		t.Fatalf("organizer sets it: %d %v", c, out)
	}
	if c, out := do("GET", 0, "", ""); c != 200 || out["x"] != 3.2 || out["z"] != -1.5 {
		t.Fatalf("everyone reads it: %d %v", c, out)
	}
	if r := openRefStore(file).get(); r == nil || r.Table != 5 {
		t.Fatalf("kept across a restart: %+v", r)
	}
	// clearing: organizers only, and it stays cleared across a restart
	if c, _ := do("DELETE", guest.ID, "https://site.test", ""); c != 403 {
		t.Fatalf("an attendee can't clear it: %d", c)
	}
	if c, _ := do("DELETE", boss.ID, "", ""); c != 403 {
		t.Fatalf("no origin: %d", c)
	}
	if c, _ := do("DELETE", boss.ID, "https://site.test", ""); c != 204 {
		t.Fatalf("organizer clears it: %d", c)
	}
	if c, out := do("GET", 0, "", ""); c != 200 || len(out) != 0 {
		t.Fatalf("cleared for everyone: %d %v", c, out)
	}
	if r := openRefStore(file).get(); r != nil {
		t.Fatalf("still cleared after a restart: %+v", r)
	}
	if c, _ := do("DELETE", boss.ID, "https://site.test", ""); c != 204 {
		t.Fatalf("clearing twice is fine: %d", c)
	}
}
