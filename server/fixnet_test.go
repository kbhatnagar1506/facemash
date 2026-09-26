package main

// Regression tests for the network / hub / auth review (each failed before its fix).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ---- sockets: idle connections can't lock players out ----

type wsEnv struct {
	hub   *Hub
	srv   *httptest.Server
	url   string
	store *memStore
}

func newWSEnv(t *testing.T, requireTicket bool) *wsEnv {
	t.Helper()
	store := newMemStore()
	acct = &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	oldHello := helloTimeout
	helloTimeout = 400 * time.Millisecond
	h := newHub()
	h.requireTicket = requireTicket
	go h.run()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.serveWS(websocket.Upgrader{}))
	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
		// hijacked sockets outlive Close: wait for their readLoops (which use acct) to finish
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			h.mu.Lock()
			n := len(h.clients)
			h.mu.Unlock()
			if n == 0 {
				break
			}
		}
		helloTimeout = oldHello
		acct = nil
	})
	return &wsEnv{hub: h, srv: srv, url: "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws", store: store}
}

func (e *wsEnv) ticket(t *testing.T, email string) string {
	a, _, err := e.store.SignIn(context.Background(), "hackgt13", user{Sub: email, Email: email})
	if err != nil {
		t.Fatal(err)
	}
	tk, _ := acct.sess.issue(kindTicket, a.ID, time.Hour)
	return tk
}

func (e *wsEnv) sockets() (all, joined int) {
	e.hub.mu.Lock()
	defer e.hub.mu.Unlock()
	return len(e.hub.clients), e.hub.joinedN
}

// join says hello and returns the first message back (or the close error).
func join(t *testing.T, url, ticket string) (*websocket.Conn, map[string]any, error) {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return nil, nil, err
	}
	c.WriteJSON(map[string]any{"t": "hello", "name": "Buzz", "color": "#4f7fd6", "x": 10, "z": 10, "room": "campus", "ticket": ticket})
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		mt, b, err := c.ReadMessage()
		if err != nil {
			c.Close()
			return nil, nil, err
		}
		if mt == websocket.TextMessage {
			var m map[string]any
			json.Unmarshal(b, &m)
			return c, m, nil
		}
	}
}

func TestIdleSocketsDontLockOutPlayers(t *testing.T) {
	e := newWSEnv(t, true)
	e.hub.ipCap = 5000              // this test's sockets all come from 127.0.0.1
	helloTimeout = 10 * time.Second // long enough to open them all first, even under -race
	const idle = maxPlayers
	var conns []*websocket.Conn
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	for i := 0; i < idle; i++ {
		c, _, err := websocket.DefaultDialer.Dial(e.url, nil)
		if err != nil {
			t.Fatalf("idle socket %d: %v", i, err)
		}
		conns = append(conns, c)
		go func() { // answer pings, never say hello
			for {
				if _, _, err := c.ReadMessage(); err != nil {
					return
				}
			}
		}()
	}
	if all, joined := e.sockets(); all != idle || joined != 0 {
		t.Fatalf("after %d idle sockets: %d open, %d joined", idle, all, joined)
	}
	// a real player gets in while they're all still open
	c, m, err := join(t, e.url, e.ticket(t, "real@x.y"))
	if err != nil || m["t"] != "welcome" {
		t.Fatalf("real player with %d idle sockets open: %v %v", idle, m, err)
	}
	defer c.Close()
	// and the idle ones are closed once helloTimeout passes
	deadline := time.Now().Add(10 * time.Second)
	for {
		all, joined := e.sockets()
		if all == 1 && joined == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("idle sockets not closed: %d open, %d joined", all, joined)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if n := e.hub.counts()["online"]; n != 1 {
		t.Fatalf("online count %d, want 1", n)
	}
}

func TestSocketsPerAddressAreCapped(t *testing.T) {
	e := newWSEnv(t, true)
	var conns []*websocket.Conn
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	for i := 0; i < maxSocketsPerIP; i++ {
		c, _, err := websocket.DefaultDialer.Dial(e.url, nil)
		if err != nil {
			t.Fatalf("socket %d: %v", i, err)
		}
		conns = append(conns, c)
	}
	_, res, err := websocket.DefaultDialer.Dial(e.url, nil)
	if err == nil || res == nil || res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("idle socket %d from one address: %v %v", maxSocketsPerIP+1, res, err)
	}
	for _, c := range conns { // closing them frees the address again
		c.Close()
	}
	conns = nil
	deadline := time.Now().Add(3 * time.Second)
	for {
		all, _ := e.sockets()
		if all == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sockets not released")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// players who have joined don't count against their address (a campus NAT)
	for i := 0; i < maxSocketsPerIP+10; i++ {
		c, m, err := join(t, e.url, e.ticket(t, fmt.Sprintf("nat%d@x.y", i)))
		if err != nil || m["t"] != "welcome" {
			t.Fatalf("player %d behind one address: %v %v", i, m, err)
		}
		conns = append(conns, c)
	}
}

func TestHelloNeedsTicket(t *testing.T) {
	e := newWSEnv(t, true)
	for name, tk := range map[string]string{"none": "", "forged": "1.9999999999.bad"} {
		_, m, err := join(t, e.url, tk)
		if !websocket.IsCloseError(err, closeSignIn) {
			t.Fatalf("%s ticket: got %v %v, want close %d", name, m, err, closeSignIn)
		}
	}
	tk := e.ticket(t, "me@x.y")
	var conns []*websocket.Conn
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	for i := 0; i < maxSocketsPerAccount; i++ {
		c, m, err := join(t, e.url, tk)
		if err != nil || m["t"] != "welcome" {
			t.Fatalf("tab %d: %v %v", i, m, err)
		}
		conns = append(conns, c)
	}
	if _, m, err := join(t, e.url, tk); !websocket.IsCloseError(err, closeTooMany) {
		t.Fatalf("one account, socket %d: %v %v", maxSocketsPerAccount+1, m, err)
	}
}

func TestPeerIP(t *testing.T) {
	for _, c := range []struct{ remote, xff, want string }{
		{"203.0.113.9:5555", "", "203.0.113.9"},
		{"203.0.113.9:5555", "1.2.3.4", "203.0.113.9"},               // a public caller can't pick its address
		{"172.18.0.3:4444", "198.51.100.7", "198.51.100.7"},          // behind Caddy
		{"172.18.0.3:4444", "6.6.6.6, 198.51.100.7", "198.51.100.7"}, // the hop our proxy added
		{"127.0.0.1:1", "", "127.0.0.1"},
	} {
		r := httptest.NewRequest("GET", "/ws", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := peerIP(r); got != c.want {
			t.Errorf("%s via %q: %s, want %s", c.remote, c.xff, got, c.want)
		}
	}
	if a, b := ipKey("2001:db8:1:2:aaaa::1"), ipKey("2001:db8:1:2:bbbb::9"); a != b {
		t.Errorf("one /64 counted as two addresses: %s %s", a, b)
	}
}

// ---- the tick builds frames without the hub lock ----

func TestTickDoesNotHoldHubLock(t *testing.T) {
	h := newHub()
	stop := make(chan struct{})
	defer close(stop)
	for i := 1; i <= maxPlayers; i++ { // everyone crowded together: the worst case
		c := &client{hub: h, send: make(chan []byte, 64), p: Player{ID: i}}
		h.clients[i] = c
		c.handle(inbound{T: "hello", Name: "b", Color: "#4f7fd6", X: 137 + (rand.Float64()-.5)*20, Z: -107 + (rand.Float64()-.5)*20, Room: "campus"})
		go func() {
			for {
				select {
				case <-c.send:
				case <-stop:
					return
				}
			}
		}()
	}
	go h.run()
	var waits []time.Duration
	warm := time.Now().Add(500 * time.Millisecond)
	end := warm.Add(1500 * time.Millisecond)
	for time.Now().Before(end) {
		t0 := time.Now()
		h.mu.Lock()
		if t0.After(warm) {
			waits = append(waits, time.Since(t0))
		}
		for _, c := range h.clients {
			c.p.X += (rand.Float64() - .5) * .3
			c.p.Z += (rand.Float64() - .5) * .3
		}
		h.dirty = true
		h.mu.Unlock()
		time.Sleep(time.Millisecond)
	}
	h.mu.Lock()
	h.clients = map[int]*client{}
	h.mu.Unlock()
	sort.Slice(waits, func(i, j int) bool { return waits[i] < waits[j] })
	p99 := waits[len(waits)*99/100]
	t.Logf("%d crowded players: hub lock wait p50 %v p99 %v max %v", maxPlayers, waits[len(waits)/2], p99, waits[len(waits)-1])
	if p99 > 10*time.Millisecond { // it was ~140 ms while the tick built every frame under the lock
		t.Fatalf("hub lock wait p99 %v: the tick is holding the lock", p99)
	}
}

func TestOnlineCountsDontTakeHubLock(t *testing.T) {
	h := newHub()
	c := &client{hub: h, send: make(chan []byte, 64), p: Player{ID: 1}}
	h.clients[1] = c
	c.handle(inbound{T: "hello", Name: "b", Room: "hackgt"})
	go h.run()
	deadline := time.Now().Add(2 * time.Second)
	for h.online.Load() == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	h.mu.Lock() // someone holds the hub: /api/online still answers
	done := make(chan map[string]int, 1)
	go func() { done <- h.counts() }()
	select {
	case n := <-done:
		h.mu.Unlock()
		if n["online"] != 1 || n["hackgt"] != 1 || n["campus"] != 0 {
			t.Fatalf("counts %v", n)
		}
	case <-time.After(time.Second):
		h.mu.Unlock()
		t.Fatal("counts() waited on the hub lock")
	}
	h.mu.Lock()
	h.clients = map[int]*client{}
	h.mu.Unlock()
}

// ---- introductions after a room round trip ----

func TestIntroducedAgainAfterRoomRoundTrip(t *testing.T) {
	h := newHub()
	go h.run()
	mk := func(id int, name string) *client {
		c := &client{hub: h, send: make(chan []byte, 256), p: Player{ID: id}}
		h.mu.Lock()
		h.clients[id] = c
		h.mu.Unlock()
		c.handle(inbound{T: "hello", Name: name, Color: "#4f7fd6", X: 10, Z: 10, Room: "campus"})
		return c
	}
	a := mk(1, "Alice")
	b := mk(2, "Bob")
	intros := func(c *client, d time.Duration) (intro, leave bool) {
		deadline := time.After(d)
		for {
			select {
			case m := <-c.send:
				s := string(m)
				intro = intro || (strings.Contains(s, `"t":"i"`) && strings.Contains(s, `"Bob"`))
				leave = leave || (strings.Contains(s, `"t":"leave"`) && strings.Contains(s, `"id":2`))
			case <-deadline:
				return
			}
		}
	}
	i1, _ := intros(a, 300*time.Millisecond)
	b.handle(inbound{T: "room", Room: "hackgt", X: 0, Z: 0}) // Bob steps into the hall...
	_, left := intros(a, 300*time.Millisecond)               // (Alice's client forgets his name)
	b.lastMove = time.Now().Add(-time.Minute)
	b.handle(inbound{T: "room", Room: "campus", X: 11, Z: 11}) // ...and comes back
	i2, _ := intros(a, 400*time.Millisecond)
	if !i1 || !left || !i2 {
		t.Fatalf("intro %v, leave %v, intro again after coming back %v", i1, left, i2)
	}
	h.mu.Lock()
	h.clients = map[int]*client{}
	h.mu.Unlock()
}

// ---- chat: rate-limited per player, and it can't crowd out position frames ----

func TestChatIsRateLimited(t *testing.T) {
	h := newHub()
	a := &client{hub: h, send: make(chan []byte, 64), p: Player{ID: 1}}
	b := &client{hub: h, send: make(chan []byte, 64), p: Player{ID: 2}}
	h.clients[1], h.clients[2] = a, b
	a.handle(inbound{T: "hello", Name: "A", Room: "campus"})
	b.handle(inbound{T: "hello", Name: "B", Room: "campus"})
	<-a.send
	<-b.send // welcomes
	for i := 0; i < 10; i++ {
		a.handle(inbound{T: "chat", Text: fmt.Sprint("hi ", i)})
	}
	if n := len(b.send); n != chatBurst {
		t.Fatalf("10 chats at once reached B %d times, want %d", n, chatBurst)
	}
	a.chatAt = a.chatAt.Add(-chatEvery) // a second later: one more
	a.handle(inbound{T: "chat", Text: "again"})
	a.handle(inbound{T: "chat", Text: "and again"})
	if n := len(b.send); n != chatBurst+1 {
		t.Fatalf("after a second, %d chats in all, want %d", n, chatBurst+1)
	}
}

func TestPositionFramesSurviveAFullQueue(t *testing.T) {
	h := newHub()
	mk := func(id int, x float64) *client {
		c := &client{hub: h, send: make(chan []byte, sendQueueSize), state: make(chan stateFrame, 1), p: Player{ID: id}}
		h.clients[id] = c
		c.handle(inbound{T: "hello", Name: "p", X: x, Z: 0, Room: "campus"})
		return c
	}
	me := mk(1, 0)
	mk(2, 5)
	for len(me.send) < cap(me.send) { // a chat burst fills my queue
		me.trySend([]byte(`{"t":"chat"}`))
	}
	go h.run()
	defer func() {
		h.mu.Lock()
		h.clients = map[int]*client{}
		h.mu.Unlock()
	}()
	select {
	case f := <-me.state:
		if len(f.b) != 3+13 || f.b[0] != 'S' {
			t.Fatalf("frame % x", f.b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no position frame while the message queue was full")
	}
}

// ---- Google keys: an unknown key ID can't stall sign-in ----

type jwksRT struct {
	n     int64
	delay time.Duration
}

func (c *jwksRT) RoundTrip(r *http.Request) (*http.Response, error) {
	atomic.AddInt64(&c.n, 1)
	time.Sleep(c.delay)
	body := `{"keys":[{"kid":"other","kty":"RSA","n":"AQAB","e":"AQAB"}]}`
	return &http.Response{StatusCode: 200, Header: http.Header{"Cache-Control": {"max-age=3600"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
}

func TestUnknownKidCantStallSignIn(t *testing.T) {
	k, keys := testKeys(t)
	rt := &jwksRT{delay: 100 * time.Millisecond}
	old := http.DefaultTransport
	http.DefaultTransport = rt
	defer func() { http.DefaultTransport = old }()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ { // 20 junk tokens, each naming a fresh key ID
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			verifyGoogle(token(t, k, fmt.Sprintf("junk-%d", i), claims(nil)), []string{testAud}, keys)
		}(i)
	}
	time.Sleep(20 * time.Millisecond)
	start := time.Now()
	_, err := verifyGoogle(token(t, k, "k1", claims(nil)), []string{testAud}, keys) // a real user, cached key
	legit := time.Since(start)
	wg.Wait()
	if err != nil || legit > 50*time.Millisecond {
		t.Fatalf("real sign-in waited %v (err %v) behind junk tokens", legit, err)
	}
	if n := atomic.LoadInt64(&rt.n); n != 1 {
		t.Fatalf("20 junk tokens caused %d fetches, want 1", n)
	}
	// more junk within the minute: no more fetches
	for i := 0; i < 5; i++ {
		verifyGoogle(token(t, k, fmt.Sprintf("more-%d", i), claims(nil)), []string{testAud}, keys)
	}
	if n := atomic.LoadInt64(&rt.n); n != 1 {
		t.Fatalf("unknown key IDs refetched %d times within a minute", n)
	}
	// a stale set is still refetched
	keys.mu.Lock()
	keys.exp = time.Now().Add(-time.Second)
	keys.mu.Unlock()
	verifyGoogle(token(t, k, "other", claims(nil)), []string{testAud}, keys)
	if n := atomic.LoadInt64(&rt.n); n != 2 {
		t.Fatalf("stale key set: %d fetches, want 2", n)
	}
}

// ---- pairing claims: limited per code, not per shared proxy address ----

func TestClaimLimitPerCodeNotPerProxy(t *testing.T) {
	srv, acc, store, _, _ := museServer(t)
	pair := func(i int) string {
		a, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: fmt.Sprint("p", i), Email: fmt.Sprintf("p%d@x.y", i)})
		cookie, _ := acc.sess.issue(kindSession, a.ID, time.Hour)
		req, _ := http.NewRequest("POST", srv.URL+"/api/muse/pair", nil)
		req.Header.Set("Origin", "https://site.test")
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var p map[string]any
		json.NewDecoder(res.Body).Decode(&p)
		return p["code"].(string)
	}
	claim := func(code string) int {
		req, _ := http.NewRequest("POST", srv.URL+"/api/muse/claim", strings.NewReader(`{"code":"`+code+`"}`))
		req.Header.Set("X-Forwarded-For", "76.76.21.21") // everyone arrives through the same proxy
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for i := 0; i < 25; i++ {
		if code := claim(pair(i)); code != http.StatusOK {
			t.Fatalf("attendee %d of 25 through one proxy: %d", i, code)
		}
	}
	// one code hammered: used once, then gone, then limited
	c := pair(100)
	got := []int{}
	for i := 0; i < claimsPerCode+1; i++ {
		got = append(got, claim(c))
	}
	if got[0] != http.StatusOK || got[1] != http.StatusGone || got[claimsPerCode] != http.StatusTooManyRequests {
		t.Fatalf("one code %d times: %v", claimsPerCode+1, got)
	}
}

// ---- MCP method names can't forge log lines ----

func TestMCPMethodNamesEscapedInLog(t *testing.T) {
	var buf bytes.Buffer
	var mu sync.Mutex
	log.SetOutput(writerFunc(func(p []byte) (int, error) { mu.Lock(); defer mu.Unlock(); return buf.Write(p) }))
	defer log.SetOutput(os.Stderr)
	srv, _, _, _, tok := museServer(t)
	rpc(t, srv.URL, tok, `{"jsonrpc":"2.0","id":1,"method":"ping\n2026/09/26 12:00:00 auth: new account #1 (FORGED)"}`)
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	out := buf.String()
	mu.Unlock()
	if strings.Contains(out, "\n2026/09/26 12:00:00 auth: new account #1 (FORGED)") {
		t.Fatalf("forged log line:\n%s", out)
	}
	if !strings.Contains(out, `ping\n2026`) {
		t.Fatalf("method not logged (escaped):\n%s", out)
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// ---- location samples ----

func TestGeoSamples(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "Boss@X.y, other@x.y")
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	file := filepath.Join(t.TempDir(), "samples.jsonl")
	mux := http.NewServeMux()
	mountGeoSamples(mux, acc, file, func(r *http.Request) bool { return r.Header.Get("Origin") == "https://site.test" })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cookie := func(email string) string {
		a, _, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: email, Email: email})
		v, _ := acc.sess.issue(kindSession, a.ID, time.Hour)
		return v
	}
	do := func(method, cookie, body string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+"/api/geo/samples", strings.NewReader(body))
		req.Header.Set("Origin", "https://site.test")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	me, boss := cookie("me@x.y"), cookie("boss@x.y")
	sample := `{"name":"Buzz Bee","lat":33.7771234567,"lon":-84.3963,"acc":5}`
	if code, _ := do("POST", "", sample); code != http.StatusUnauthorized {
		t.Fatalf("anonymous POST: %d", code)
	}
	if code, _ := do("POST", me, sample); code != http.StatusNoContent {
		t.Fatalf("signed-in POST: %d", code)
	}
	if code, _ := do("GET", "", ""); code != http.StatusUnauthorized {
		t.Fatalf("anonymous GET: %d", code)
	}
	if code, _ := do("GET", me, ""); code != http.StatusForbidden {
		t.Fatalf("non-admin GET: %d", code)
	}
	code, body := do("GET", boss, "")
	if code != http.StatusOK || strings.Contains(body, "Buzz") || !strings.Contains(body, "33.7771234567") {
		t.Fatalf("admin GET: %d %q", code, body)
	}
	// per person: a small burst, then about one per 2 s
	codes := []int{}
	for i := 0; i < sampleBurst+1; i++ {
		c, _ := do("POST", me, `{"lat":1}`)
		codes = append(codes, c)
	}
	if codes[len(codes)-1] != http.StatusTooManyRequests {
		t.Fatalf("rapid POSTs: %v", codes)
	}
	// the file stops growing at the cap
	old := maxSamplesBytes
	maxSamplesBytes = 64
	defer func() { maxSamplesBytes = old }()
	if code, _ := do("POST", cookie("third@x.y"), `{"pad":"`+strings.Repeat("A", 100)+`"}`); code != http.StatusInsufficientStorage {
		t.Fatalf("POST past the size cap: %d", code)
	}
}
