package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Deleting your own account takes everything with it (memory, talks and their chats), signs
// you out, and leaves everyone else alone; signing in again starts fresh.
func TestDeleteMyAccount(t *testing.T) {
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	ctx := context.Background()
	me, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "g:me", Email: "me@x.test", Name: "Krish", Given: "Krish"})
	them, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "g:them", Email: "them@x.test", Name: "Dana", Given: "Dana"})
	other, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "g:o", Email: "o@x.test", Name: "Oz", Given: "Oz"})
	store.SaveMemory(ctx, "hackgt13", me.ID, json.RawMessage(`{"user_md":"hi"}`), nil)
	store.SaveMemory(ctx, "hackgt13", them.ID, json.RawMessage(`{"user_md":"yo"}`), nil)
	now := time.Now().UTC()
	store.talkCreate(ctx, &talkRecord{ID: "tk_mine", Tenant: "hackgt13", A: me.ID, B: them.ID, State: "revealed", Started: now})
	store.talkCreate(ctx, &talkRecord{ID: "tk_theirs", Tenant: "hackgt13", A: them.ID, B: other.ID, State: "revealed", Started: now})
	store.connAdd(ctx, "hackgt13", connMsg{Talk: "tk_mine", From: me.ID, Text: "hey"})

	mux := http.NewServeMux()
	mountAuth(mux, nil, acc, func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	del := func(origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("DELETE", "/api/me", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		v, exp := acc.sess.issue(kindSession, me.ID, time.Hour)
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: v, Expires: exp})
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := del("https://evil.test"); w.Code != http.StatusForbidden {
		t.Fatalf("another site can't delete you: %d", w.Code)
	}
	if w := del(""); w.Code != http.StatusForbidden {
		t.Fatalf("no origin: %d", w.Code)
	}
	w := del("https://site.test")
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if c := w.Result().Cookies(); len(c) == 0 || c[0].Name != sessionCookie || c[0].Value != "" {
		t.Fatalf("signed out: %+v", c)
	}
	if _, err := store.Account(ctx, "hackgt13", me.ID); err == nil {
		t.Fatal("the account is gone")
	}
	if _, err := store.talkGet(ctx, "hackgt13", "tk_mine"); err == nil {
		t.Fatal("their talk together is gone")
	}
	if _, err := store.talkGet(ctx, "hackgt13", "tk_theirs"); err != nil {
		t.Fatalf("other people's talks stay: %v", err)
	}
	if info, err := store.MemoryInfo(ctx, "hackgt13", them.ID); err != nil || info["stored"] != true {
		t.Fatalf("other people's memory stays: %v %v", info, err)
	}
	if len(store.fastT().purges) != 1 {
		t.Fatalf("the memory index copy is queued for erasure: %d", len(store.fastT().purges))
	}
	again, created, err := store.SignIn(ctx, "hackgt13", user{Sub: "g:me", Email: "me@x.test", Name: "Krish", Given: "Krish"})
	if err != nil || !created || again.ID == me.ID {
		t.Fatalf("signing in again starts fresh: created=%v id=%d (was %d) %v", created, again.ID, me.ID, err)
	}
}

// The same against a real Postgres (FASTPG_DSN): the account, its talks and their chat
// messages go; a MAPI erase is queued; other people are untouched.
func TestDeleteMyAccountPostgres(t *testing.T) {
	s, pool := mfScratchPostgres(t)
	ctx := context.Background()
	for _, ensure := range []func(context.Context) error{s.fastEnsureSchema, s.talkEnsureSchema, s.connEnsureSchema} {
		if err := ensure(ctx); err != nil {
			t.Fatal(err)
		}
	}
	me, _, _ := s.SignIn(ctx, "hackgt13", user{Sub: "g:me", Email: "me@x.test", Name: "Krish", Given: "Krish"})
	them, _, _ := s.SignIn(ctx, "hackgt13", user{Sub: "g:them", Email: "them@x.test", Name: "Dana", Given: "Dana"})
	s.SaveMemory(ctx, "hackgt13", me.ID, json.RawMessage(`{"user_md":"hi"}`), nil)
	now := time.Now().UTC()
	if err := s.talkCreate(ctx, &talkRecord{ID: "tk_mine", Tenant: "hackgt13", A: me.ID, B: them.ID, State: "revealed", Started: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.connAdd(ctx, "hackgt13", connMsg{Talk: "tk_mine", From: me.ID, Text: "hey"}); err != nil {
		t.Fatal(err)
	}
	if err := s.deleteAccount(ctx, me.ID); err != nil {
		t.Fatal(err)
	}
	count := func(q string, args ...any) int {
		var n int
		if err := pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(`SELECT count(*) FROM users WHERE id = $1`, me.ID) != 0 || count(`SELECT count(*) FROM talks WHERE id = 'tk_mine'`) != 0 ||
		count(`SELECT count(*) FROM conn_messages`) != 0 || count(`SELECT count(*) FROM agent_memory WHERE user_id = $1`, me.ID) != 0 {
		t.Fatal("the account, its talk, the chat and the memory are gone")
	}
	if count(`SELECT count(*) FROM mapi_purges WHERE user_id = $1`, me.ID) != 1 {
		t.Fatal("a MAPI erase is queued")
	}
	if count(`SELECT count(*) FROM users WHERE id = $1`, them.ID) != 1 {
		t.Fatal("other people stay")
	}
}
