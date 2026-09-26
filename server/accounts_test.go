package main

import (
	"context"
	"testing"
	"time"
)

func TestGameSavesProgress(t *testing.T) {
	store := newMemStore()
	acct = &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	defer func() { acct = nil }()
	a, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "g-1", Email: "b@gatech.edu"})
	tk, _ := acct.sess.issue(kindTicket, a.ID, time.Hour)

	h := newHub()
	join := func(id int, ticket string) *client {
		c := &client{hub: h, send: make(chan []byte, 64), p: Player{ID: id}}
		h.clients[id] = c
		c.handle(inbound{T: "hello", Name: "Buzz", Color: "#4f7fd6", X: 10, Z: 5, Room: "campus", Ticket: ticket})
		return c
	}
	me := join(1, tk)
	guest := join(2, "")
	forged := join(3, "1.9999999999.bad")
	if me.uid != a.ID || guest.uid != 0 || forged.uid != 0 {
		t.Fatalf("uids: me %d guest %d forged %d", me.uid, guest.uid, forged.uid)
	}
	session, _ := acct.sess.issue(kindSession, a.ID, time.Hour)
	if join(4, session).uid != 0 {
		t.Fatal("a session cookie value was accepted as a game ticket")
	}

	wait := func(ok func(Account) bool) Account {
		for i := 0; i < 100; i++ {
			got, _ := store.Account(context.Background(), "hackgt13", a.ID)
			if ok(got) {
				return got
			}
			time.Sleep(10 * time.Millisecond)
		}
		got, _ := store.Account(context.Background(), "hackgt13", a.ID)
		t.Fatalf("timed out; account now %+v (progress %+v)", got, got.Progress)
		return got
	}
	wait(func(x Account) bool { return x.Profile.Name == "Buzz" && x.Profile.Color == "#4f7fd6" })

	// walk a few metres: the next save picks it up; standing still writes nothing new
	me.lastMove = time.Now().Add(-2 * time.Second)
	me.handle(inbound{T: "move", X: 14, Z: 5, R: 1})
	h.saveMoved()
	wait(func(x Account) bool { return x.Progress != nil && x.Progress.X == 14 })

	// into the hall, then leave the game: the last spot is kept
	me.handle(inbound{T: "room", Room: "hackgt", X: 2, Z: -3})
	h.saveMoved()
	got := wait(func(x Account) bool { return x.Progress != nil && x.Progress.Room == "hackgt" && x.Progress.X == 2 })
	if got.Progress.Z != -3 {
		t.Fatalf("hall progress: %+v", got.Progress)
	}
}
