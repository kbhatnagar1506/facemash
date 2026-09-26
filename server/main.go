// Command server runs the multiplayer backend for the Georgia Tech campus game.
//
// It relays player positions and chat over a single WebSocket (/ws), serves
// the HackGT event card (/api/event, read from event.json on each request so
// it can be edited live), and serves the built React client from ../client/dist.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const (
	tickRate      = 15 // state broadcasts per second
	maxPlayers    = 200
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

func (h *Hub) run() {
	t := time.NewTicker(time.Second / tickRate)
	for range t.C {
		h.mu.Lock()
		if h.dirty {
			byRoom := map[string][]Player{}
			for _, c := range h.clients {
				if c.joined {
					byRoom[c.p.Room] = append(byRoom[c.p.Room], c.p)
				}
			}
			for room, ps := range byRoom {
				h.broadcast(room, mustJSON(map[string]any{"t": "state", "p": ps}), 0)
			}
			h.dirty = false
		}
		h.mu.Unlock()
	}
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
		c.p.X = clamp(m.X, bounds[0], bounds[2])
		c.p.Z = clamp(m.Z, bounds[1], bounds[3])
		c.p.Room = m.Room
		if !rooms[c.p.Room] {
			c.p.Room = "campus"
		}
		c.joined = true
		c.lastMove = time.Now()

		c.trySend(mustJSON(map[string]any{"t": "welcome", "id": c.p.ID, "room": c.p.Room, "players": h.roommates(c)}))
		h.broadcast(c.p.Room, mustJSON(map[string]any{"t": "join", "p": c.p}), c.p.ID)
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
		c.trySend(mustJSON(map[string]any{"t": "room", "room": c.p.Room, "players": h.roommates(c)}))
		h.broadcast(c.p.Room, mustJSON(map[string]any{"t": "join", "p": c.p}), c.p.ID)
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
		if c.joined {
			h.broadcast(c.p.Room, mustJSON(map[string]any{"t": "leave", "id": c.p.ID}), 0)
			log.Printf("leave #%d %q (%d online)", c.p.ID, c.p.Name, len(h.clients))
		}
		h.mu.Unlock()
		close(c.send)
		c.conn.Close()
	}()
	c.conn.SetReadLimit(1024)
	c.conn.SetReadDeadline(time.Now().Add(pongTimeout))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})
	for {
		var m inbound
		if err := c.conn.ReadJSON(&m); err != nil {
			return
		}
		c.conn.SetReadDeadline(time.Now().Add(pongTimeout))
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
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
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

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	static := flag.String("static", "../client/dist", "built client to serve")
	eventFile := flag.String("event", "event.json", "HackGT event card")
	geoFile := flag.String("geo", "geo.json", "GPS to Klaus atrium alignment")
	samplesFile := flag.String("samples", "geo_samples.jsonl", "recorded location samples")
	flag.Parse()

	// ALLOWED_ORIGINS=https://gt.example.com,https://other.example.com
	// Unset: same-host requests and localhost dev servers only.
	allowed := map[string]bool{}
	for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" || allowed[origin] {
			return true
		}
		host := strings.TrimPrefix(strings.TrimPrefix(origin, "http://"), "https://")
		return host == r.Host || strings.HasPrefix(host, "localhost:") || strings.HasPrefix(host, "127.0.0.1:")
	}}

	hub := newHub()
	go hub.run()

	mux := http.NewServeMux()
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
		counts := map[string]int{"online": 0}
		hub.mu.Lock()
		for _, c := range hub.clients {
			if c.joined {
				counts["online"]++
				counts[c.p.Room]++
			}
		}
		hub.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(counts)
	})
	mux.Handle("/", http.FileServer(http.Dir(*static)))

	log.Printf("GT campus server on %s (static: %s)", *addr, *static)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
