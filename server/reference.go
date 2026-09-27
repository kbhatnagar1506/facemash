package main

// The reference point: where an organizer really is in the HackGT hall (their table), set
// live with Shift+R in the game. Every bean that enters the hall walks there first, then
// follows its phone from that spot by compass and steps (no GPS). The client turns the
// point into a path and the steps into movement (App.tsx); the server only keeps it:
//   GET  /api/reference    {"x","z","table","at"} or {} (anyone: it's a spot in a public room)
//   POST /api/reference    {"x","z","table"} (organizers in ADMIN_EMAILS, from our own pages)
// A change goes out to every connected player at once ({"t":"anchor",...} on the socket)
// and is kept in a file next to the location samples, so a restart doesn't lose it.

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type hallRef struct {
	X     float64   `json:"x"`
	Z     float64   `json:"z"`
	Table int       `json:"table,omitempty"`
	At    time.Time `json:"at"`
}

type refStore struct {
	mu   sync.Mutex
	ref  *hallRef
	file string
}

func openRefStore(file string) *refStore {
	s := &refStore{file: file}
	if b, err := os.ReadFile(file); err == nil {
		var r hallRef
		if json.Unmarshal(b, &r) == nil && refOK(r.X, r.Z) {
			s.ref = &r
			log.Printf("reference: table %d at (%.1f, %.1f), set %s", r.Table, r.X, r.Z, r.At.Format(time.RFC3339))
		}
	}
	return s
}

// refOK: inside the hall's floor (with a little slack), and real numbers.
func refOK(x, z float64) bool {
	return !math.IsNaN(x) && !math.IsNaN(z) && x > -20 && x < 30 && z > -30 && z < 30
}

func (s *refStore) get() *hallRef {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ref == nil {
		return nil
	}
	r := *s.ref
	return &r
}

func (s *refStore) set(r hallRef) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ref = &r
	if s.file == "" {
		return nil
	}
	b, _ := json.Marshal(r)
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// announce tells everyone connected where the reference is now.
func (h *Hub) announce(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for room := range rooms {
		h.broadcast(room, msg, 0)
	}
}

var errNotAdmin = errors.New("organizers only")

func mountReference(mux *http.ServeMux, acc *accounts, hub *Hub, admin *adminAPI, originOK func(*http.Request) bool, s *refStore) {
	mux.HandleFunc("/api/reference", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			w.Header().Set("Cache-Control", "no-store")
			if ref := s.get(); ref != nil {
				adminJSON(w, http.StatusOK, ref)
			} else {
				adminJSON(w, http.StatusOK, map[string]any{})
			}
		case http.MethodPost:
			if r.Header.Get("Origin") == "" || !originOK(r) {
				adminJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
				return
			}
			uid, ok := acc.sess.read(r)
			if !ok {
				adminJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
				return
			}
			if admin == nil {
				adminJSON(w, http.StatusForbidden, map[string]string{"error": errNotAdmin.Error()})
				return
			}
			email, isAdmin, err := admin.who(r.Context(), uid)
			if err != nil || !isAdmin {
				adminJSON(w, http.StatusForbidden, map[string]string{"error": errNotAdmin.Error()})
				return
			}
			var in struct {
				X, Z  float64
				Table int
			}
			b, _ := io.ReadAll(io.LimitReader(r.Body, 1024))
			if json.Unmarshal(b, &in) != nil || !refOK(in.X, in.Z) || in.Table < 0 || in.Table > 99 {
				adminJSON(w, http.StatusBadRequest, map[string]string{"error": `send {"x": …, "z": …} inside the hall`})
				return
			}
			ref := hallRef{X: math.Round(in.X*100) / 100, Z: math.Round(in.Z*100) / 100, Table: in.Table, At: time.Now().UTC().Truncate(time.Second)}
			if err := s.set(ref); err != nil {
				log.Printf("reference: not saved to disk (kept in memory): %v", err)
			}
			log.Printf("reference: %s set table %d at (%.1f, %.1f)", email, ref.Table, ref.X, ref.Z)
			if hub != nil {
				hub.announce(mustJSON(map[string]any{"t": "anchor", "x": ref.X, "z": ref.Z, "table": ref.Table, "at": ref.At}))
			}
			adminJSON(w, http.StatusOK, ref)
		default:
			w.Header().Set("Allow", "GET, POST")
			adminJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET or POST"})
		}
	})
}

// refFile: the reference lives next to the location samples (the VM keeps that folder).
func refFile(samples string) string { return filepath.Join(filepath.Dir(samples), "reference.json") }
