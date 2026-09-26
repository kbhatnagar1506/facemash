// Command server runs the multiplayer backend for the Georgia Tech campus game.
//
// It relays player positions and chat over a single WebSocket (/ws), serves
// the HackGT event card (/api/event, read from event.json on each request so
// it can be edited live), and serves the built React client from ../client/dist.
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"flag"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	tickRate      = 15 // state broadcasts per second
	maxPlayers    = 1200
	aoiRadius     = 90.0 // metres: you only hear about players this close...
	maxVisible    = 60   // ...and at most this many of the nearest
	maxMsgsPerSec = 40   // inbound flood guard per client
	maxSpeed      = 30.0 // m/s, a little above the client's sprint speed
	maxNameLen    = 16
	maxChatLen    = 140
	chatCooldown  = 800 * time.Millisecond
	writeTimeout  = 5 * time.Second
	pongTimeout   = 30 * time.Second
	pingInterval  = 20 * time.Second
	sendQueueSize = 64
)

// World bounds in meters, matching client/public/campus.json with some slack.
var bounds = [4]float64{-1100, -1100, 1100, 1100}

var palette = map[string]bool{
	"#e0564f": true, "#4f7fd6": true, "#e89a3c": true, "#5aa56a": true,
	"#9b6bd1": true, "#d9c24a": true, "#3fa7b3": true, "#f06ba8": true,
}

type Player struct {
	ID    int     `json:"id"`
	Name  string  `json:"name"`
	Color string  `json:"color"`
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
	Y     float64 `json:"y"` // floor height (stairs/balcony inside Klaus)
	R     float64 `json:"r"` // facing, radians
	M     bool    `json:"m"` // moving (drives the walk animation)
	Room  string  `json:"room"`
	Look  string  `json:"look,omitempty"` // bean avatar from /avatar (see cleanLook)
}

// Rooms: the outdoor campus, and the HackGT hall you enter by registering at Klaus.
var rooms = map[string]bool{"campus": true, "hackgt": true}

type client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan []byte
	p        Player
	joined   bool
	lastMove time.Time
	lastChat time.Time

	known     map[int]bool // players whose name/colour/look this client already has
	lastState []byte       // last state frame sent (identical frames are skipped)
	msgWindow time.Time    // start of the current rate-limit second
	msgCount  int

	uid   int64    // signed-in account (0 = guest)
	saved Progress // last position written to the database
}

type inbound struct {
	T     string  `json:"t"`
	Name  string  `json:"name"`
	Color string  `json:"color"`
	X     float64 `json:"x"`
	Z     float64 `json:"z"`
	Y     float64 `json:"y"`
	R     float64 `json:"r"`
	M     bool    `json:"m"`
	Text  string  `json:"text"`
	Room  string  `json:"room"`
	Look  string  `json:"look"`
	// signed-in players: the ticket from /api/me (their progress is saved as they play)
	Ticket string `json:"ticket"`
}

type Hub struct {
	mu      sync.Mutex
	clients map[int]*client
	nextID  int
	dirty   bool
}

func newHub() *Hub { return &Hub{clients: map[int]*client{}, nextID: 1} }

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// broadcast sends msg to every joined client in room. Must be called with h.mu held.
func (h *Hub) broadcast(room string, msg []byte, except int) {
	for id, c := range h.clients {
		if id == except || !c.joined || c.p.Room != room {
			continue
		}
		c.trySend(msg) // a slow client drops frames rather than blocking everyone
	}
}

// trySend queues msg without blocking; a full queue means a stalled client.
func (c *client) trySend(msg []byte) {
	select {
	case c.send <- msg:
	default:
	}
}

// run is the 15 Hz broadcaster. Interest management keeps it scalable: players are
// bucketed into a grid of aoiRadius-sized cells per room, and each client gets only
// the (up to maxVisible) nearest players within aoiRadius, as a compact binary frame
// (13 bytes a player: see below) instead of JSON.
//
// Names, colours and looks go out once per player per client ({"t":"i"}), the first
// time that player comes into view. Unchanged frames aren't resent, so an idle
// room costs almost nothing. Work per tick is ~O(players × neighbours), not O(n²).
func (h *Hub) run() {
	t := time.NewTicker(time.Second / tickRate)
	type key struct {
		room string
		x, z int
	}
	type cand struct {
		c  *client
		d2 float64
	}
	grid := map[key][]*client{}
	var near []cand
	for range t.C {
		h.mu.Lock()
		if !h.dirty {
			h.mu.Unlock()
			continue
		}
		for k := range grid {
			delete(grid, k)
		}
		cell := func(v float64) int { return int(math.Floor(v / aoiRadius)) }
		for _, c := range h.clients {
			if c.joined {
				k := key{c.p.Room, cell(c.p.X), cell(c.p.Z)}
				grid[k] = append(grid[k], c)
			}
		}
		for _, c := range h.clients {
			if !c.joined {
				continue
			}
			near = near[:0]
			cx, cz := cell(c.p.X), cell(c.p.Z)
			for dx := -1; dx <= 1; dx++ {
				for dz := -1; dz <= 1; dz++ {
					for _, o := range grid[key{c.p.Room, cx + dx, cz + dz}] {
						if o == c {
							continue
						}
						ddx, ddz := o.p.X-c.p.X, o.p.Z-c.p.Z
						if d2 := ddx*ddx + ddz*ddz; d2 <= aoiRadius*aoiRadius {
							near = append(near, cand{o, d2})
						}
					}
				}
			}
			if len(near) > maxVisible {
				sort.Slice(near, func(i, j int) bool { return near[i].d2 < near[j].d2 })
				near = near[:maxVisible]
			}
			// introduce anyone new in view (once)
			var intro []map[string]any
			for _, n := range near {
				if !c.known[n.c.p.ID] {
					c.known[n.c.p.ID] = true
					intro = append(intro, map[string]any{"id": n.c.p.ID, "name": n.c.p.Name, "color": n.c.p.Color, "look": n.c.p.Look})
				}
			}
			if len(intro) > 0 {
				c.trySend(mustJSON(map[string]any{"t": "i", "p": intro}))
			}
			// binary frame: 'S', count u16, then per player
			// id u32 | x i16 dm | z i16 dm | r i16 crad | y i16 dm | moving u8  (13 bytes)
			frame := make([]byte, 3, 3+len(near)*13)
			frame[0] = 'S'
			binary.LittleEndian.PutUint16(frame[1:], uint16(len(near)))
			for _, n := range near {
				q := n.c.p
				frame = binary.LittleEndian.AppendUint32(frame, uint32(q.ID))
				frame = binary.LittleEndian.AppendUint16(frame, uint16(int16(math.Round(q.X*10))))
				frame = binary.LittleEndian.AppendUint16(frame, uint16(int16(math.Round(q.Z*10))))
				frame = binary.LittleEndian.AppendUint16(frame, uint16(int16(math.Round(q.R*100))))
				frame = binary.LittleEndian.AppendUint16(frame, uint16(int16(math.Round(q.Y*10))))
				if q.M {
					frame = append(frame, 1)
				} else {
					frame = append(frame, 0)
				}
			}
			if !bytes.Equal(frame, c.lastState) {
				c.lastState = frame
				c.trySend(frame)
			}
		}
		h.dirty = false
		h.mu.Unlock()
	}
}

// cleanLook keeps an avatar description like "b=#ff8a3d;a=#ffffff;p=split;e=dots;h=crown"
// to a short string of safe characters (it is only ever parsed by clients).
func cleanLook(s string) string {
	if len(s) > 160 {
		return ""
	}
	for _, r := range s {
		ok := r == '#' || r == '=' || r == ';' || r == '-' || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r >= 'A' && r <= 'F')
		if !ok {
			return ""
		}
	}
	return s
}

func cleanText(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// roommates lists the other joined players in c's room. Must be called with h.mu held.
func (h *Hub) roommates(c *client) []Player {
	ps := make([]Player, 0, len(h.clients))
	for _, o := range h.clients {
		if o.joined && o != c && o.p.Room == c.p.Room {
			ps = append(ps, o.p)
		}
	}
	return ps
}

func (c *client) handle(m inbound) {
	h := c.hub
	h.mu.Lock()
	defer h.mu.Unlock()

	switch m.T {
	case "hello":
		if c.joined {
			return
		}
		c.p.Name = cleanText(m.Name, maxNameLen)
		if c.p.Name == "" {
			c.p.Name = "Trainer"
		}
		c.p.Color = m.Color
		if !palette[c.p.Color] {
			c.p.Color = "#e0564f"
		}
		c.p.Look = cleanLook(m.Look)
		c.p.X = clamp(m.X, bounds[0], bounds[2])
		c.p.Z = clamp(m.Z, bounds[1], bounds[3])
		c.p.Room = m.Room
		if !rooms[c.p.Room] {
			c.p.Room = "campus"
		}
		if acct != nil && m.Ticket != "" {
			if id, ok := acct.sess.check(kindTicket, m.Ticket); ok {
				c.uid = id
				c.saved = Progress{Room: c.p.Room, X: c.p.X, Z: c.p.Z}
				acct.saveProfile(id, Profile{Name: c.p.Name, Color: c.p.Color, Look: c.p.Look})
			}
		}
		c.joined = true
		c.lastMove = time.Now()

		c.known = map[int]bool{}
		c.lastState = nil
		c.trySend(mustJSON(map[string]any{"t": "welcome", "id": c.p.ID, "room": c.p.Room, "players": []Player{}}))
		h.dirty = true
		log.Printf("join #%d %q (%d online)", c.p.ID, c.p.Name, len(h.clients))

	case "move":
		if !c.joined || math.IsNaN(m.X) || math.IsNaN(m.Z) || math.IsNaN(m.R) {
			return
		}
		// Reject teleports: allow at most maxSpeed over the elapsed time (+1s slack).
		now := time.Now()
		dt := now.Sub(c.lastMove).Seconds()
		if math.Hypot(m.X-c.p.X, m.Z-c.p.Z) > maxSpeed*(dt+1) {
			c.trySend(mustJSON(map[string]any{"t": "correct", "x": c.p.X, "z": c.p.Z}))
			return
		}
		c.lastMove = now
		c.p.X = clamp(m.X, bounds[0], bounds[2])
		c.p.Z = clamp(m.Z, bounds[1], bounds[3])
		c.p.Y = clamp(m.Y, 0, 20)
		c.p.R = m.R
		c.p.M = m.M
		h.dirty = true

	case "room":
		// Doors between rooms are client-side; the server just re-homes the player.
		if !c.joined || !rooms[m.Room] || m.Room == c.p.Room || math.IsNaN(m.X) || math.IsNaN(m.Z) {
			return
		}
		h.broadcast(c.p.Room, mustJSON(map[string]any{"t": "leave", "id": c.p.ID}), c.p.ID)
		c.p.Room = m.Room
		c.p.X = clamp(m.X, bounds[0], bounds[2])
		c.p.Z = clamp(m.Z, bounds[1], bounds[3])
		c.p.M = false
		c.p.Y = 0
		c.lastMove = time.Now()
		c.lastState = nil
		c.trySend(mustJSON(map[string]any{"t": "room", "room": c.p.Room, "players": []Player{}}))
		h.dirty = true
		log.Printf("#%d %q -> %s", c.p.ID, c.p.Name, c.p.Room)

	case "chat":
		if !c.joined || time.Since(c.lastChat) < chatCooldown {
			return
		}
		text := cleanText(m.Text, maxChatLen)
		if text == "" {
			return
		}
		c.lastChat = time.Now()
		h.broadcast(c.p.Room, mustJSON(map[string]any{
			"t": "chat", "id": c.p.ID, "name": c.p.Name, "text": text,
		}), 0)
	}
}

func (c *client) readLoop() {
	defer func() {
		h := c.hub
		h.mu.Lock()
		delete(h.clients, c.p.ID)
		h.dirty = true // neighbours' frames drop this player
		if c.joined && c.uid != 0 {
			acct.saveProgress(c.uid, c.progress())
		}
		if c.joined {
			h.broadcast(c.p.Room, mustJSON(map[string]any{"t": "leave", "id": c.p.ID}), 0)
			log.Printf("leave #%d %q (%d online)", c.p.ID, c.p.Name, len(h.clients))
		}
		h.mu.Unlock()
		close(c.send)
		c.conn.Close()
	}()
	c.conn.SetReadLimit(2048)
	c.conn.SetReadDeadline(time.Now().Add(pongTimeout))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})
	for {
		var m inbound
		if err := c.conn.ReadJSON(&m); err != nil {
			return
		}
		now := time.Now()
		c.conn.SetReadDeadline(now.Add(pongTimeout))
		if now.Sub(c.msgWindow) > time.Second {
			c.msgWindow, c.msgCount = now, 0
		}
		if c.msgCount++; c.msgCount > maxMsgsPerSec {
			continue // flooding: drop until the next second
		}
		c.handle(m)
	}
}

func (c *client) writeLoop() {
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			kind := websocket.TextMessage
			if len(msg) > 0 && msg[0] == 'S' {
				kind = websocket.BinaryMessage // compact position frame
			}
			if err := c.conn.WriteMessage(kind, msg); err != nil {
				return
			}
		case <-ping.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// acct is set when sign-in is on (see accounts.go); nil means everyone plays as a guest.
var acct *accounts

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	static := flag.String("static", "../client/dist", "built client to serve")
	eventFile := flag.String("event", "event.json", "HackGT event card")
	geoFile := flag.String("geo", "geo.json", "GPS to Klaus atrium alignment")
	samplesFile := flag.String("samples", "geo_samples.jsonl", "recorded location samples")
	keyFile := flag.String("session-key", "session.key", "session signing key (created if missing)")
	mintFor := flag.String("muse-token", "", "print a connector token for this email (a test account is made if needed) and exit")
	sessionFor := flag.String("session-for", "", "print a session cookie value for this email's test account and exit (for testing signed-in flows before Google sign-in is on)")
	devLogin := flag.Bool("dev-login", false, "local testing only: /api/dev/login?email= signs in a test account (localhost requests only)")
	devTalk := flag.Bool("dev-talk", false, "local testing only: POST /api/talk/encounter {a_uid, b_uid} starts an agent talk (localhost requests only)")
	talkConfig := flag.String("talk-config", "", "agent talk config file (default: the built-in talkdata/talk_config.json)")
	sim := talkSimFlags()
	flag.Parse()
	if sim.on() {
		os.Exit(runTalkSim(sim, *talkConfig))
	}
	base := strings.TrimRight(envOr("PUBLIC_URL", "https://gt-campus-quest.vercel.app"), "/")
	if *mintFor != "" {
		mintTestToken(*mintFor, *keyFile, base)
		return
	}
	if *sessionFor != "" {
		mintTestSession(*sessionFor, *keyFile)
		return
	}

	// ALLOWED_ORIGINS=https://gt.example.com,https://gt-campus-quest*.vercel.app
	// (a * matches anything, e.g. Vercel preview deploys). Unset: same-host requests
	// and localhost dev servers only.
	allowed := map[string]bool{}
	var patterns [][2]string
	for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o == "" {
			continue
		}
		if i := strings.Index(o, "*"); i >= 0 {
			patterns = append(patterns, [2]string{o[:i], o[i+1:]})
		} else {
			allowed[o] = true
		}
	}
	originOK := func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" || allowed[origin] {
			return true
		}
		for _, p := range patterns {
			if strings.HasPrefix(origin, p[0]) && strings.HasSuffix(origin, p[1]) && len(origin) >= len(p[0])+len(p[1]) {
				return true
			}
		}
		host := strings.TrimPrefix(strings.TrimPrefix(origin, "http://"), "https://")
		return host == r.Host || strings.HasPrefix(host, "localhost:") || strings.HasPrefix(host, "127.0.0.1:")
	}
	upgrader := websocket.Upgrader{CheckOrigin: originOK}

	hub := newHub()
	go hub.run()

	mux := http.NewServeMux()
	// GOOGLE_CLIENT_ID=<web client id>[,<another>]: turns on Sign in with Google.
	// DB_INSTANCE=project:region:instance (+ DB_NAME, DB_IAM_USER): accounts live in Cloud SQL;
	// otherwise in memory. TENANT names the event this server hosts (default hackgt13).
	var clientIDs []string
	for _, id := range strings.Split(os.Getenv("GOOGLE_CLIENT_ID"), ",") {
		if id = strings.TrimSpace(id); id != "" {
			clientIDs = append(clientIDs, id)
		}
	}
	acct = openAccounts(*keyFile)
	if acct == nil {
		clientIDs = nil // no database: sign-in off, everyone plays as a guest
	} else {
		defer acct.store.Close()
		go hub.saveLoop()
	}
	if acct != nil {
		acct.fast = openMemFast(acct) // MAPI_READ_URL/MAPI_WRITE_URL + a tenant key; nil (off) otherwise
		acct.jev = openJev(acct)      // JEV_API_KEY(_FILE); nil (off) otherwise
		mountAuth(mux, clientIDs, acct, originOK)
		mountMuse(mux, acct, hub, *eventFile, base, originOK)
		mountJev(mux, acct, acct.jev)
		acct.talk = openAgentTalk(acct, hubSink{hub}, *talkConfig) // GEMINI_API_KEY(_FILE) + JEV_API_KEY(_FILE)
		mountTalk(mux, acct, acct.talk, originOK, *devTalk)
		if *devLogin {
			mountDevLogin(mux, acct)
		}
	} else {
		mountAuth(mux, nil, &accounts{store: newMemStore(), tenant: envOr("TENANT", "hackgt13"), sess: sessions{secret: loadSecret(*keyFile)}}, originOK)
	}
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		hub.mu.Lock()
		full := len(hub.clients) >= maxPlayers
		hub.mu.Unlock()
		if full {
			http.Error(w, "server full", http.StatusServiceUnavailable)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		hub.mu.Lock()
		c := &client{hub: hub, conn: conn, send: make(chan []byte, sendQueueSize)}
		c.p.ID = hub.nextID
		hub.nextID++
		hub.clients[c.p.ID] = c
		hub.mu.Unlock()
		go c.writeLoop()
		c.readLoop()
	})
	mux.HandleFunc("/api/event", func(w http.ResponseWriter, r *http.Request) {
		b, err := os.ReadFile(*eventFile)
		if err != nil || !json.Valid(b) {
			http.Error(w, "event.json missing or invalid", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	})
	// GPS → Klaus atrium alignment (see client/src/geo.ts). Re-read each request so an
	// on-site calibration (?calibrate) can be pasted in without restarting.
	mux.HandleFunc("/api/geo", func(w http.ResponseWriter, r *http.Request) {
		b, err := os.ReadFile(*geoFile)
		if err != nil || !json.Valid(b) {
			http.Error(w, "geo.json missing or invalid", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	})
	// Location samples from players in the atrium (for mapping GPS onto the model).
	// POST appends one JSON object per line; GET returns the file.
	var samplesMu sync.Mutex
	mux.HandleFunc("/api/geo/samples", func(w http.ResponseWriter, r *http.Request) {
		samplesMu.Lock()
		defer samplesMu.Unlock()
		if r.Method == http.MethodPost {
			b, err := io.ReadAll(io.LimitReader(r.Body, 2048))
			if err != nil || !json.Valid(b) {
				http.Error(w, "bad sample", http.StatusBadRequest)
				return
			}
			f, err := os.OpenFile(*samplesFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if err != nil {
				http.Error(w, "cannot write", http.StatusInternalServerError)
				return
			}
			defer f.Close()
			f.Write(append(bytes.TrimSpace(b), '\n'))
			w.WriteHeader(http.StatusNoContent)
			return
		}
		b, _ := os.ReadFile(*samplesFile)
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Write(b)
	})
	mux.HandleFunc("/api/online", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(hub.counts())
	})
	// Serve the client; unknown extension-less paths (like /avatar) get the app itself.
	// Hashed build assets are cached for a year; JS/CSS/JSON are gzipped (≈3× smaller).
	files := gzipFiles(http.FileServer(http.Dir(*static)))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache") // index.html, campus.json: revalidate
		}
		p := filepath.Clean(r.URL.Path)
		if p != "/" && filepath.Ext(p) == "" {
			if _, err := os.Stat(filepath.Join(*static, p)); err != nil {
				http.ServeFile(w, r, filepath.Join(*static, "index.html"))
				return
			}
		}
		files.ServeHTTP(w, r)
	})

	log.Printf("GT campus server on %s (static: %s)", *addr, *static)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

// gzipFiles compresses text assets on the fly (compressed once per file, then cached).
type gzEntry struct {
	mod  time.Time
	body []byte
}

var (
	gzMu    sync.Mutex
	gzCache = map[string]gzEntry{}
)

func gzipFiles(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ext := filepath.Ext(r.URL.Path)
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || (ext != ".js" && ext != ".css" && ext != ".json" && ext != ".svg") {
			next.ServeHTTP(w, r)
			return
		}
		rec := &captureWriter{header: http.Header{}, code: 200}
		next.ServeHTTP(rec, r)
		if rec.code != 200 {
			for k, v := range rec.header {
				w.Header()[k] = v
			}
			w.WriteHeader(rec.code)
			w.Write(rec.buf.Bytes())
			return
		}
		key := r.URL.Path
		gzMu.Lock()
		e, ok := gzCache[key]
		mod, _ := http.ParseTime(rec.header.Get("Last-Modified"))
		if !ok || !e.mod.Equal(mod) {
			var b bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
			zw.Write(rec.buf.Bytes())
			zw.Close()
			e = gzEntry{mod: mod, body: b.Bytes()}
			gzCache[key] = e
		}
		gzMu.Unlock()
		for k, v := range rec.header {
			if k != "Content-Length" {
				w.Header()[k] = v
			}
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		w.Header().Set("Content-Length", strconv.Itoa(len(e.body)))
		w.WriteHeader(200)
		w.Write(e.body)
	})
}

type captureWriter struct {
	header http.Header
	code   int
	buf    bytes.Buffer
}

func (c *captureWriter) Header() http.Header         { return c.header }
func (c *captureWriter) WriteHeader(code int)        { c.code = code }
func (c *captureWriter) Write(b []byte) (int, error) { return c.buf.Write(b) }
