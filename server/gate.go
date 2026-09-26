package main

// Who gets a game socket, and the location-samples endpoint. The socket cap counts only
// players who have joined (said hello with a valid ticket); a socket that stays silent is
// closed after helloTimeout, and one address can hold at most hub.ipCap sockets that
// haven't joined yet, so idle connections can't fill the server.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// serveWS upgrades /ws and runs the connection.
func (h *Hub) serveWS(upgrader websocket.Upgrader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := ipKey(peerIP(r))
		h.mu.Lock()
		switch {
		case h.joinedN >= maxPlayers || len(h.clients) >= maxSockets:
			h.mu.Unlock()
			http.Error(w, "server full", http.StatusServiceUnavailable)
			return
		case h.perIP[ip] >= h.ipCap:
			h.mu.Unlock()
			http.Error(w, "too many connections from your network", http.StatusTooManyRequests)
			return
		}
		h.perIP[ip]++ // held from here until hello (or close), so a slow upgrade still counts
		h.mu.Unlock()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			h.mu.Lock()
			if h.perIP[ip]--; h.perIP[ip] <= 0 {
				delete(h.perIP, ip)
			}
			h.mu.Unlock()
			return
		}
		c := &client{hub: h, conn: conn, send: make(chan []byte, sendQueueSize), state: make(chan stateFrame, 1), ip: ip}
		h.mu.Lock()
		c.p.ID = h.nextID
		h.nextID++
		h.clients[c.p.ID] = c
		h.mu.Unlock()
		go c.writeLoop()
		c.readLoop()
	}
}

// peerIP is the address of whoever connected to our edge. In production the game sits
// behind Caddy on a private Docker network, and Caddy sets X-Forwarded-For to the address
// it accepted the connection from (it trusts no proxy in front of it, so what the caller
// sent is replaced). So behind a loopback or private peer the last X-Forwarded-For hop is
// used, and otherwise the TCP peer itself; a caller can't pick its own address either way.
// The game socket connects straight to the VM, so there this is the player's address;
// for /api/* (which Vercel proxies) it is a Vercel edge shared by many people.
func peerIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			hops := strings.Split(f, ",")
			if last := strings.TrimSpace(hops[len(hops)-1]); net.ParseIP(last) != nil {
				return last
			}
		}
	}
	return host
}

// ipKey groups addresses the way one household or phone holds them: an IPv4 address, or an
// IPv6 /64 (a single device can pick any address in its /64).
func ipKey(addr string) string {
	ip := net.ParseIP(addr)
	if ip == nil {
		return addr
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// Location samples: the atrium's GPS readings, for mapping the building onto the model.
const (
	sampleEvery = 2 * time.Second // per person, after a small burst
	sampleBurst = 3
)

var maxSamplesBytes int64 = 200 << 20 // stop appending past this (a var for tests)

// adminEmailSet is ADMIN_EMAILS (comma-separated), lower-cased.
func adminEmailSet() map[string]bool {
	out := map[string]bool{}
	for _, e := range strings.Split(os.Getenv("ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			out[e] = true
		}
	}
	return out
}

// mountGeoSamples adds /api/geo/samples. POST (signed in, from our pages, rate-limited)
// appends one JSON object per line, without any name in it; GET streams the file to admins.
func mountGeoSamples(mux *http.ServeMux, acc *accounts, file string, originOK func(*http.Request) bool) {
	var mu sync.Mutex // appends are whole lines; GET reads up to the size seen under it
	lim := newKeyLimiter(sampleBurst, sampleEvery, 0)
	admins := adminEmailSet()
	mux.HandleFunc("/api/geo/samples", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if acc == nil {
			http.Error(w, "sign-in is off", http.StatusServiceUnavailable)
			return
		}
		id, ok := acc.sess.read(r)
		if !ok {
			http.Error(w, "sign in first", http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodPost:
			if r.Header.Get("Origin") == "" || !originOK(r) {
				http.Error(w, "bad origin", http.StatusForbidden)
				return
			}
			release, _, ok := lim.acquire(fastWho{acc.tenant, id})
			if !ok {
				http.Error(w, "slow down", http.StatusTooManyRequests)
				return
			}
			release()
			b, err := io.ReadAll(io.LimitReader(r.Body, 2048))
			var sample map[string]any
			d := json.NewDecoder(bytes.NewReader(b))
			d.UseNumber()
			if err != nil || d.Decode(&sample) != nil || sample == nil {
				http.Error(w, "bad sample", http.StatusBadRequest)
				return
			}
			delete(sample, "name") // positions only: never who
			line := append(mustJSON(sample), '\n')
			mu.Lock()
			defer mu.Unlock()
			if fi, err := os.Stat(file); err == nil && fi.Size()+int64(len(line)) > maxSamplesBytes {
				http.Error(w, "sample log is full", http.StatusInsufficientStorage)
				return
			}
			f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			if err != nil {
				http.Error(w, "cannot write", http.StatusInternalServerError)
				return
			}
			defer f.Close()
			f.Write(line)
			w.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			a, err := acc.store.Account(ctx, acc.tenant, id)
			cancel()
			if err != nil || !admins[strings.ToLower(a.User.Email)] {
				http.Error(w, "admins only", http.StatusForbidden)
				return
			}
			mu.Lock()
			f, err := os.Open(file)
			var size int64
			if err == nil {
				if fi, err2 := f.Stat(); err2 == nil {
					size = fi.Size()
				}
			}
			mu.Unlock()
			w.Header().Set("Content-Type", "application/x-ndjson")
			if err != nil {
				return // nothing recorded yet
			}
			defer f.Close()
			io.Copy(w, io.LimitReader(f, size)) // streamed, without the lock
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
