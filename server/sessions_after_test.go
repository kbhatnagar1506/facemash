package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Signing out ends that session, the same person's sessions elsewhere and their game
// tickets; a fresh sign-in afterwards works, and other people are untouched.
func TestLogoutEndsSessions(t *testing.T) {
	store := newMemStore()
	ctx := context.Background()
	a, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "1", Email: "buzz@gatech.edu", Given: "Buzz"})
	b, _, _ := store.SignIn(ctx, "hackgt13", user{Sub: "2", Email: "other@gatech.edu"})
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	acc.sess.rev = newRevocations(store)
	mux := http.NewServeMux()
	mountAuth(mux, []string{testAud}, acc, func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })

	// tokens a second old, as if issued before the sign-out
	back := func(kind string, id int64) string {
		v, _ := acc.sess.issue(kind, id, ttlFor(kind)-time.Second)
		return v
	}
	phone, laptop, ticket := back(kindSession, a.ID), back(kindSession, a.ID), back(kindTicket, a.ID)
	otherSess, otherTicket := back(kindSession, b.ID), back(kindTicket, b.ID)

	if _, ok := acc.sess.check(kindSession, laptop); !ok {
		t.Fatal("session rejected before signing out")
	}

	r := httptest.NewRequest("POST", "/api/auth/logout", nil)
	r.Host = "site.test"
	r.Header.Set("Origin", "https://site.test")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: phone})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("logout: %d", w.Code)
	}
	for name, v := range map[string]string{"phone": phone, "laptop": laptop} {
		if _, ok := acc.sess.check(kindSession, v); ok {
			t.Errorf("%s session still works after signing out", name)
		}
	}
	if _, ok := acc.sess.check(kindTicket, ticket); ok {
		t.Error("game ticket issued before signing out still works")
	}
	if _, ok := acc.sess.check(kindSession, otherSess); !ok {
		t.Error("someone else's session ended")
	}
	if _, ok := acc.sess.check(kindTicket, otherTicket); !ok {
		t.Error("someone else's ticket ended")
	}
	// signing back in works straight away
	fresh, _ := acc.sess.issue(kindSession, a.ID, sessionTTL)
	if _, ok := acc.sess.check(kindSession, fresh); !ok {
		t.Error("new session after signing out rejected")
	}
	tk, _ := acc.sess.issue(kindTicket, a.ID, ticketTTL)
	if _, ok := acc.sess.check(kindTicket, tk); !ok {
		t.Error("new ticket after signing out rejected")
	}

	// it's stored: a restarted server (a new list from the same store) still refuses them
	after := &accounts{store: store, sess: sessions{secret: acc.sess.secret, rev: newRevocations(store)}}
	if _, ok := after.sess.check(kindSession, laptop); ok {
		t.Error("sign-out forgotten on restart")
	}
	if _, ok := after.sess.check(kindSession, fresh); !ok {
		t.Error("new session rejected after restart")
	}
}
