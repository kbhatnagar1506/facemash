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
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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
	chatBurst     = 3           // chat: a burst of this many...
	chatEvery     = time.Second // ...then one message per this long
	writeTimeout  = 5 * time.Second
	pongTimeout   = 30 * time.Second
	pingInterval  = 20 * time.Second
	sendQueueSize = 64

	// Sockets. Only joined players count toward maxPlayers; a socket that hasn't said hello
	// within helloTimeout (below) is closed, and one address can hold at most maxSocketsPerIP
	// sockets that haven't joined yet (or joined as guests, when sign-in is off). Signed-in
	// sockets are capped per account instead, so a campus NAT with hundreds of players behind
	// one address is fine. maxSockets bounds everything open, joined or not.
	maxSocketsPerIP      = 40
	maxSocketsPerAccount = 6 // tabs and devices of one signed-in person
	maxSockets           = maxPlayers + 800

	// close codes for a refused hello (the client re-fetches its ticket on closeSignIn)
	closeSignIn  = 4401
	closeTooMany = 4429
	closeFull    = 1013 // "try again later"
)

// helloTimeout: a socket that hasn't said hello by then is closed (a var for tests).
var helloTimeout = 5 * time.Second

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
	send     chan []byte     // JSON messages (and, with no state channel, frames)
	state    chan stateFrame // the latest position frame only: chat can't crowd it out
	p        Player
	joined   bool
	joinedAt time.Time // hello (usage.go times sessions from it)
	lastMove time.Time

	chatTokens float64 // chat token bucket (chatBurst, one back per chatEvery)
	chatAt     time.Time

	// kmu guards known, lastState and gone, and orders the tick's sends to this client
	// against leave messages (the tick builds frames without the hub lock).
	kmu       sync.Mutex
	known     map[int]bool // players whose name/colour/look this client already has
	lastState []byte       // last state frame sent (identical frames are skipped)
	gone      bool         // disconnected: send is closed
	// epoch goes up when this player changes room or leaves, so frames built from an
	// older snapshot are dropped (by the tick for neighbours, by writeLoop for the client).
	epoch atomic.Int64

	msgWindow time.Time // start of the current rate-limit second
	msgCount  int
	ip        string // address counted in hub.perIP while not yet joined ("" = not counted)
	reject    int    // set by handle when hello is refused: close with this code

	uid   int64    // signed-in account (0 = guest)
	saved Progress // last position written to the database
}

// stateFrame is a position frame and the epoch of the client it was built for.
type stateFrame struct {
	epoch int64
	b     []byte
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

	joinedN int            // clients that have said hello (what maxPlayers caps)
	perIP   map[string]int // sockets per client address that haven't joined yet
	byUID   map[int64]int  // joined sockets per signed-in account
	ipCap   int            // maxSocketsPerIP (a flag can raise it for load tests)
	// requireTicket: hello must carry a valid ticket from /api/me (sign-in is on)
	requireTicket bool

	online  atomic.Pointer[onlineCounts] // worked out once per tick (see counts)
	ticking atomic.Bool
}

type onlineCounts struct{ online, campus, hackgt int }

func (n *onlineCounts) add(room string) {
	n.online++
	switch room {
	case "campus":
		n.campus++
	case "hackgt":
		n.hackgt++
	}
}

func newHub() *Hub {
	return &Hub{clients: map[int]*client{}, nextID: 1, perIP: map[string]int{}, byUID: map[int64]int{}, ipCap: maxSocketsPerIP}
}

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
func (c *client) trySend(msg []byte) bool {
	select {
	case c.send <- msg:
		return true
	default:
		return false
	}
}

// pushState hands the writer the newest position frame, replacing one it hasn't sent yet.
// Called by the tick with c.kmu held.
func (c *client) pushState(b []byte, epoch int64) {
	if c.state == nil {
		c.trySend(b)
		return
	}
	f := stateFrame{epoch, b}
	select {
	case c.state <- f:
		return
	default:
	}
	select {
	case <-c.state: // an older frame the writer hasn't got to: this one supersedes it
	default:
	}
	select {
	case c.state <- f:
	default:
	}
}

// releaseIP stops counting c against its address. Must be called with h.mu held.
func (h *Hub) releaseIP(c *client) {
	if c.ip == "" {
		return
	}
	if h.perIP[c.ip]--; h.perIP[c.ip] <= 0 {
		delete(h.perIP, c.ip)
	}
	c.ip = ""
}

// broadcastLeave tells everyone else in c's room that c has gone, and forgets that they were
// introduced to c (their client drops c's name with the leave), so if c comes back they're
// introduced again. Must be called with h.mu held.
func (h *Hub) broadcastLeave(c *client) {
	msg := mustJSON(map[string]any{"t": "leave", "id": c.p.ID})
	for _, o := range h.clients {
		if o == c || !o.joined || o.p.Room != c.p.Room {
			continue
		}
		o.kmu.Lock()
		delete(o.known, c.p.ID)
		if !o.gone {
			o.trySend(msg)
		}
		o.kmu.Unlock()
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
//
// The hub lock is held only to copy positions out (and count who's online); frames are
// built from that snapshot without it, so moves, chat, joins and /api/online don't wait
// on the tick. Each client's own lock (kmu) orders its intros and frames against the
// leave messages sent to it, and epochs drop anything built from a snapshot that a room
// change or a disconnect has since overtaken.
func (h *Hub) run() {
	t := time.NewTicker(time.Second / tickRate)
	defer t.Stop()
	h.ticking.Store(true)
	defer h.ticking.Store(false)
	type key struct {
		room string
		x, z int
	}
	type snap struct {
		c     *client
		p     Player
		epoch int64
	}
	type cand struct {
		s  *snap
		d2 float64
	}
	cell := func(v float64) int { return int(math.Floor(v / aoiRadius)) }
	grid := map[key][]*snap{}
	var snaps []snap
	var near []cand
	for range t.C {
		retry := false
		h.mu.Lock()
		if !h.dirty {
			h.mu.Unlock()
			continue
		}
		h.dirty = false // a move from here on marks the next tick
		snaps = snaps[:0]
		n := &onlineCounts{}
		for _, c := range h.clients {
			if c.joined {
				snaps = append(snaps, snap{c, c.p, c.epoch.Load()})
				n.add(c.p.Room)
			}
		}
		h.mu.Unlock()
		h.online.Store(n)

		for k := range grid {
			delete(grid, k)
		}
		for i := range snaps {
			s := &snaps[i]
			k := key{s.p.Room, cell(s.p.X), cell(s.p.Z)}
			grid[k] = append(grid[k], s)
		}
		for i := range snaps {
			s := &snaps[i]
			near = near[:0]
			cx, cz := cell(s.p.X), cell(s.p.Z)
			for dx := -1; dx <= 1; dx++ {
				for dz := -1; dz <= 1; dz++ {
					for _, o := range grid[key{s.p.Room, cx + dx, cz + dz}] {
						if o == s {
							continue
						}
						ddx, ddz := o.p.X-s.p.X, o.p.Z-s.p.Z
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
			c := s.c
			c.kmu.Lock()
			if c.gone || c.epoch.Load() != s.epoch {
				c.kmu.Unlock() // left, or changed room since the snapshot: the next tick has them
				continue
			}
			if c.known == nil {
				c.known = map[int]bool{}
			}
			// binary frame: 'S', count u16, then per player
			// id u32 | x i16 dm | z i16 dm | r i16 crad | y i16 dm | moving u8  (13 bytes)
			frame := make([]byte, 3, 3+len(near)*13)
			frame[0] = 'S'
			var intro []map[string]any
			var introduced []int
			count := 0
			for _, nb := range near {
				if nb.s.c.epoch.Load() != nb.s.epoch {
					continue // they changed room or left since the snapshot (c has had the leave)
				}
				q := nb.s.p
				// introduce anyone new in view (once)
				if !c.known[q.ID] {
					intro = append(intro, map[string]any{"id": q.ID, "name": q.Name, "color": q.Color, "look": q.Look})
					introduced = append(introduced, q.ID)
				}
				count++
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
			binary.LittleEndian.PutUint16(frame[1:], uint16(count))
			// an intro that didn't fit in a full queue is tried again next tick
			if len(intro) > 0 {
				if c.trySend(mustJSON(map[string]any{"t": "i", "p": intro})) {
					for _, id := range introduced {
						c.known[id] = true
					}
				} else {
					retry = true
				}
			}
			if !bytes.Equal(frame, c.lastState) {
				c.lastState = frame
				c.pushState(frame, s.epoch)
			}
			c.kmu.Unlock()
		}
		if retry {
			h.mu.Lock()
			h.dirty = true
			h.mu.Unlock()
		}
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

func (c *client) handle(m inbound) {
	h := c.hub
	h.mu.Lock()
	defer h.mu.Unlock()

	switch m.T {
	case "hello":
		if c.joined {
			return
		}
		var uid int64
		if acct != nil && m.Ticket != "" {
			if id, ok := acct.sess.check(kindTicket, m.Ticket); ok {
				uid = id
			}
		}
		switch {
		case h.requireTicket && uid == 0: // sign-in is required: no ticket, no game
			c.reject = closeSignIn
			return
		case h.joinedN >= maxPlayers:
			c.reject = closeFull
			return
		case uid != 0 && h.byUID[uid] >= maxSocketsPerAccount:
			c.reject = closeTooMany
			return
		}
		c.p.Name = cleanText(m.Name, maxNameLen)
		if c.p.Name == "" {
			c.p.Name = "Hacker" // the client sends your first name when it has one
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
		if uid != 0 {
			h.releaseIP(c) // signed in: counted per account from here, not per address (NATs)
			c.uid = uid
			c.saved = Progress{Room: c.p.Room, X: c.p.X, Z: c.p.Z}
			acct.saveProfile(uid, Profile{Name: c.p.Name, Color: c.p.Color, Look: c.p.Look})
			h.byUID[uid]++
		}
		c.joined = true
		h.joinedN++
		c.lastMove = time.Now()
		c.joinedAt = c.lastMove
		c.chatTokens, c.chatAt = chatBurst, c.lastMove

		c.kmu.Lock()
		c.known = map[int]bool{}
		c.lastState = nil
		c.kmu.Unlock()
		c.trySend(mustJSON(map[string]any{"t": "welcome", "id": c.p.ID, "room": c.p.Room, "players": []Player{}}))
		h.dirty = true
		log.Printf("join #%d %q (%d online)", c.p.ID, c.p.Name, h.joinedN)

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
		c.epoch.Add(1) // frames built for the old room are dropped (by the tick and by writeLoop)
		h.broadcastLeave(c)
		c.p.Room = m.Room
		c.p.X = clamp(m.X, bounds[0], bounds[2])
		c.p.Z = clamp(m.Z, bounds[1], bounds[3])
		c.p.M = false
		c.p.Y = 0
		c.lastMove = time.Now()
		c.kmu.Lock()
		c.lastState = nil
		select {
		case <-c.state: // an unsent frame of the old room
		default:
		}
		c.kmu.Unlock()
		c.trySend(mustJSON(map[string]any{"t": "room", "room": c.p.Room, "players": []Player{}}))
		h.dirty = true
		log.Printf("#%d %q -> %s", c.p.ID, c.p.Name, c.p.Room)

	case "chat":
		if !c.joined {
			return
		}
		text := cleanText(m.Text, maxChatLen)
		if text == "" {
			return
		}
		// token bucket: a burst of chatBurst, then one per chatEvery
		now := time.Now()
		c.chatTokens = min(chatBurst, c.chatTokens+float64(now.Sub(c.chatAt))/float64(chatEvery))
		c.chatAt = now
		if c.chatTokens < 1 {
			return
		}
		c.chatTokens--
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
		h.releaseIP(c)
		if c.joined {
			h.joinedN--
			if c.uid != 0 {
				if h.byUID[c.uid]--; h.byUID[c.uid] <= 0 {
					delete(h.byUID, c.uid)
				}
				acct.saveProgress(c.uid, c.progress())
			}
			h.dirty = true // neighbours' frames drop this player
			c.epoch.Add(1)
			h.broadcastLeave(c)
			log.Printf("leave #%d %q (%d online)", c.p.ID, c.p.Name, h.joinedN)
		}
		h.mu.Unlock()
		c.kmu.Lock()
		c.gone = true
		close(c.send)
		c.kmu.Unlock()
		c.conn.Close()
	}()
	c.conn.SetReadLimit(2048)
	// until hello, only helloTimeout: pings don't keep a silent socket open
	c.conn.SetReadDeadline(time.Now().Add(helloTimeout))
	c.conn.SetPongHandler(func(string) error {
		if !c.joined {
			return nil
		}
		return c.conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})
	for {
		var m inbound
		if err := c.conn.ReadJSON(&m); err != nil {
			return
		}
		now := time.Now()
		if now.Sub(c.msgWindow) > time.Second {
			c.msgWindow, c.msgCount = now, 0
		}
		if c.msgCount++; c.msgCount > maxMsgsPerSec {
			continue // flooding: drop until the next second
		}
		c.handle(m)
		if c.reject != 0 {
			reason := map[int]string{closeSignIn: "sign in", closeTooMany: "too many connections", closeFull: "server full"}[c.reject]
			c.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(c.reject, reason), time.Now().Add(writeTimeout))
			return
		}
		if c.joined {
			c.conn.SetReadDeadline(now.Add(pongTimeout))
		}
	}
}

func (c *client) writeLoop() {
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	write := func(msg []byte) bool {
		c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		kind := websocket.TextMessage
		if len(msg) > 0 && msg[0] == 'S' {
			kind = websocket.BinaryMessage // compact position frame
		}
		return c.conn.WriteMessage(kind, msg) == nil
	}
	// text sends one queued message; false means stop (closed, or the write failed)
	text := func(msg []byte, ok bool) bool {
		if !ok {
			c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			c.conn.WriteMessage(websocket.CloseMessage, nil)
			return false
		}
		return write(msg)
	}
	for {
		// queued messages first, so a welcome or room change always precedes the frames after it
		select {
		case msg, ok := <-c.send:
			if !text(msg, ok) {
				return
			}
			continue
		default:
		}
		select {
		case msg, ok := <-c.send:
			if !text(msg, ok) {
				return
			}
		case f := <-c.state:
			for drained := false; !drained; {
				select {
				case msg, ok := <-c.send:
					if !text(msg, ok) {
						return
					}
				default:
					drained = true
				}
			}
			if f.epoch != c.epoch.Load() {
				continue // built for a room this client has since left
			}
			if !write(f.b) {
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
	perIP := flag.Int("ws-per-ip", maxSocketsPerIP, "most not-yet-joined game sockets one client address may hold (raise only for local load tests)")
	sim := talkSimFlags()
	voiceProvision := flag.Bool("voice-provision", false, "create or update the ElevenLabs voice agent ("+voiceAgentName+"), print its id and exit")
	voiceKey := flag.String("voice-key", "", "with -voice-provision: which ElevenLabs key's account, primary or backup (default: the first that works)")
	flag.Parse()
	if *voiceProvision {
		provisionVoice(*voiceKey)
		return
	}
	if sim.on() {
		os.Exit(runTalkSim(sim, *talkConfig))
	}
	base := strings.TrimRight(envOr("PUBLIC_URL", "https://www.fasemash.tech"), "/")
	if *mintFor != "" {
		mintTestToken(*mintFor, *keyFile, base)
		return
	}
	if *sessionFor != "" {
		mintTestSession(*sessionFor, *keyFile)
		return
	}
	if adminCLI(*keyFile) { // -purge-test-accounts (admin.go)
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
	hub.ipCap = *perIP
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
	// The routes are always mounted: with the database down at boot, connect keeps trying in
	// the background and gate answers 503 on the routes that need it until it's up.
	jwks := warmGoogleKeys() // the sign-in keys mountAuth uses, fetched by startWarm (warm.go)
	acct = openAccounts(*keyFile)
	if acct == nil {
		clientIDs = nil // unusable database settings: sign-in off, everyone plays as a guest
	} else {
		defer acct.store.Close()
		go hub.saveLoop()
	}
	if acct != nil {
		acct.fast = openMemFast(acct) // MAPI_READ_URL/MAPI_WRITE_URL + a tenant key; nil (off) otherwise
		acct.jev = openJev(acct)      // JEV_API_KEY(_FILE); nil (off) otherwise
		acct.voice = openVoice()      // ELEVENLABS_API_KEY(_FILE) + ELEVENLABS_AGENT_ID; nil (off) otherwise
		acct.connect()
		mountAuth(mux, clientIDs, acct, originOK)
		mountMuse(mux, acct, hub, *eventFile, base, originOK)
		mountJev(mux, acct, acct.jev)
		acct.talk = openAgentTalk(acct, hubSink{hub}, *talkConfig) // GEMINI_API_KEY(_FILE) + JEV_API_KEY(_FILE)
		mountTalk(mux, acct, acct.talk, originOK, *devTalk)
		if acct.talk != nil {
			acct.talk.watchProximity(hub) // two opted-in players within 3 m for 3 s (talk_config.json)
		}
		mountVoice(mux, acct, acct.voice, originOK)
		mountAdmin(mux, acct, hub) // /api/admin/* for organizers in ADMIN_EMAILS (admin.go)
		startUsage(acct, hub)      // play sessions and the service meter (usage.go)
		if *devLogin {
			mountDevLogin(mux, acct)
		}
		// Sign-in is required to play (no guests): with Google sign-in on (or -dev-login
		// locally), hello must carry the ticket /api/me hands a signed-in page.
		hub.requireTicket = len(clientIDs) > 0 || *devLogin
		log.Printf("game: ticket required at hello: %v", hub.requireTicket)
	} else {
		mountAuth(mux, nil, &accounts{store: newMemStore(), tenant: envOr("TENANT", "hackgt13"), sess: sessions{secret: loadSecret(*keyFile)}}, originOK)
	}
	mux.HandleFunc("/ws", hub.serveWS(upgrader))
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
	mountGeoSamples(mux, acct, *samplesFile, originOK)
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

	var handler http.Handler = mux
	if acct != nil {
		handler = acct.gate(mux)
	}
	// everything loaded and connected before the first request (warm.go): /api/readyz says when
	startWarm(mux, hub, acct, jwks, *eventFile)
	log.Printf("GT campus server on %s (static: %s)", *addr, *static)
	// Headers must arrive promptly (a connection trickling them in holds a goroutine and a
	// socket). No whole-request ReadTimeout: it would cut off the game's websockets; request
	// bodies that matter (memory uploads) set their own deadline and minimum rate.
	srv := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 64 << 10}
	log.Fatal(srv.ListenAndServe())
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
