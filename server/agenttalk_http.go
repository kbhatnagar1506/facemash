package main

// Agent talk over HTTP (agenttalk.go has the design):
//   GET/POST /api/talk/optin          {"on": true|false}: the game's switch ("Let my agent talk
//                                     to people nearby"), and how many talks you have left
//                                     today. Same rules as prefs: session cookie + same-origin.
//   GET/POST /api/talk/prefs          your own switches (opt_in defaults to off). Session
//                                     cookie + same-origin POST only: an agent's bearer token
//                                     can't turn this on.
//   POST /api/talk/<id>/approve|skip  after a match verdict; names come out only when both approve
//   POST /api/talk/<id>/feedback      {"worth_it": true|false}, afterwards
//   GET  /api/talk/<id>               your view of a talk (for a phone that reconnects)
//   POST /api/talk/encounter          {"a_uid","b_uid"}: the test trigger until Bluetooth
//                                     exists. Only with -dev-talk (and from localhost), or for a
//                                     signed-in admin (ADMIN_EMAILS). Never public.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// ---------- approvals, feedback, views ----------

// runFor: the live run, or one rebuilt from the database (a restart between the verdict
// and the approvals).
func (t *agentTalk) runFor(ctx context.Context, tenant, id string) (*talkRun, error) {
	t.mu.Lock()
	r := t.live[id]
	t.mu.Unlock()
	if r != nil {
		if r.rec.Tenant != tenant {
			return nil, errNoTalk
		}
		return r, nil
	}
	rec, err := t.ts.talkGet(ctx, tenant, id)
	if err != nil {
		return nil, err
	}
	r = &talkRun{t: t, rec: rec, start: rec.Started, iceReady: make(chan struct{})}
	for i, uid := range []int64{rec.A, rec.B} {
		p, err := t.person(ctx, tenant, uid)
		if err != nil {
			return nil, err
		}
		pr, _ := t.ts.talkPrefs(ctx, tenant, uid)
		r.sides[i] = &talkSide{person: p, prefs: pr}
	}
	r.iceOnce.Do(func() { close(r.iceReady) }) // whatever was written before is all there is
	if rec.State == "awaiting" {
		t.mu.Lock()
		if cur := t.live[id]; cur != nil {
			r = cur
		} else {
			t.live[id] = r
		}
		t.mu.Unlock()
	}
	return r, nil
}

func (r *talkRun) sideOf(uid int64) int {
	switch uid {
	case r.rec.A:
		return 0
	case r.rec.B:
		return 1
	}
	return -1
}

// decide records one human's approve or skip. Both approve: the reveal goes to both phones.
func (t *agentTalk) decide(ctx context.Context, tenant string, uid int64, id string, approve bool) (string, error) {
	r, err := t.runFor(ctx, tenant, id)
	if err != nil {
		return "", err
	}
	side := r.sideOf(uid)
	if side < 0 {
		return "", errNoTalk // not yours: as if it didn't exist
	}
	r.mu.Lock()
	if r.rec.State != "awaiting" {
		st := r.rec.State
		r.mu.Unlock()
		return st, errTalkState
	}
	if r.rec.Approvals == nil {
		r.rec.Approvals = map[string]string{}
	}
	if _, done := r.rec.Approvals[sideName(side)]; done {
		st := r.rec.State
		r.mu.Unlock()
		return st, nil
	}
	if !approve {
		r.rec.Approvals[sideName(side)] = "skip"
		if r.expiry != nil {
			r.expiry.Stop()
		}
		r.mu.Unlock()
		r.pushBoth(map[string]any{"t": "closed", "id": r.rec.ID})
		r.finish("skipped")
		return "skipped", nil
	}
	r.rec.Approvals[sideName(side)] = "approve"
	both := r.rec.Approvals["a"] == "approve" && r.rec.Approvals["b"] == "approve"
	if both {
		r.rec.State = "revealed"
		if r.expiry != nil {
			r.expiry.Stop()
		}
	}
	r.mu.Unlock()
	if !both {
		r.save()
		return "awaiting", nil
	}
	select { // the icebreaker is normally long done (the humans took seconds to tap)
	case <-r.iceReady:
	case <-time.After(t.cfg.ms(t.cfg.Models.WriterTimeoutMS)):
	}
	r.mu.Lock()
	ice := t.cfg.Lines.IcebreakerFallback
	if r.rec.Icebreaker != nil {
		ice = *r.rec.Icebreaker
	} else {
		r.rec.Icebreaker = &ice
	}
	r.rec.Timings["revealed"] = r.sinceMS()
	r.mu.Unlock()
	for i, s := range r.sides {
		o := r.sides[1-i]
		t.sink.send(s.person.id, map[string]any{"t": "reveal", "id": r.rec.ID,
			"other":      map[string]any{"name": o.person.name, "where": t.sink.where(o.person.id)},
			"icebreaker": ice})
	}
	r.finish("revealed")
	return "revealed", nil
}

// expire: nobody (or only one) approved in time.
func (t *agentTalk) expire(r *talkRun) {
	r.mu.Lock()
	if r.rec.State != "awaiting" {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()
	r.pushBoth(map[string]any{"t": "closed", "id": r.rec.ID})
	r.finish("expired")
}

func (t *agentTalk) feedback(ctx context.Context, tenant string, uid int64, id string, worth bool) error {
	r, err := t.runFor(ctx, tenant, id)
	if err != nil {
		return err
	}
	side := r.sideOf(uid)
	if side < 0 {
		return errNoTalk
	}
	r.mu.Lock()
	if r.rec.State == "live" {
		r.mu.Unlock()
		return errTalkState
	}
	if r.rec.Feedback == nil {
		r.rec.Feedback = map[string]bool{}
	}
	r.rec.Feedback[sideName(side)] = worth
	r.mu.Unlock()
	r.save()
	return nil
}

// view: a talk from one participant's side: bubbles with relative "from", the verdict, and
// the reveal only once it happened.
func (t *agentTalk) view(ctx context.Context, tenant string, uid int64, id string) (map[string]any, error) {
	r, err := t.runFor(ctx, tenant, id)
	if err != nil {
		return nil, err
	}
	side := r.sideOf(uid)
	if side < 0 {
		return nil, errNoTalk
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	lines := []map[string]any{}
	for _, l := range r.rec.Transcript {
		from := "their_agent"
		if l.Side == sideName(side) {
			from = "your_agent"
		}
		lines = append(lines, map[string]any{"n": l.N, "from": from, "text": l.Text})
	}
	out := map[string]any{"id": r.rec.ID, "state": r.rec.State, "lines": lines, "other": map[string]any{"bean": r.sides[1-side].person.look}}
	switch r.rec.State {
	case "no_match":
		out["match"] = false
	case "awaiting", "revealed", "skipped", "expired":
		reason, _ := r.rec.Verdict["reason"].(string)
		rel := talkRelReason(reason, side)
		out["match"], out["reason"], out["why"] = true, rel, t.cfg.Lines.Why[rel]
		out["approved"] = r.rec.Approvals[sideName(side)]
	}
	if r.rec.State == "revealed" {
		o := r.sides[1-side]
		out["other"] = map[string]any{"bean": o.person.look, "name": o.person.name, "where": t.sink.where(o.person.id)}
		out["icebreaker"] = r.rec.Icebreaker
	}
	return out, nil
}

// nearOpted tells the proximity scan about a switch at once (it also reloads every few s).
func (t *agentTalk) nearOpted(id int64, p talkPrefs) {
	if t == nil {
		return
	}
	t.mu.Lock()
	n := t.near
	t.mu.Unlock()
	n.setOpted(id, p.OptIn && !p.Busy)
}

// prefsChanged: consent for going_through changes what the brief may hold.
func (t *agentTalk) prefsChanged(tenant string, id int64, old, cur talkPrefs) {
	if t == nil || old.OkayToShare == cur.OkayToShare {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !cur.OkayToShare { // take it out now
		if b, err := t.ts.talkBrief(ctx, tenant, id); err == nil && b != nil && len(b.GoingThrough) > 0 {
			b.GoingThrough = nil
			t.ts.talkSaveBrief(ctx, tenant, id, *b)
		}
		return
	}
	t.memoryArrived(tenant, id) // rebuild with it allowed
}

// ---------- HTTP ----------

func talkAdmins() map[string]bool {
	out := map[string]bool{}
	for _, e := range strings.Split(os.Getenv("ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			out[e] = true
		}
	}
	return out
}

func mountTalk(mux *http.ServeMux, acc *accounts, t *agentTalk, originOK func(*http.Request) bool, devTalk bool) {
	if acc == nil {
		return
	}
	ts, _ := acc.store.(talkStore)
	admins := talkAdmins()
	writeJSON := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(v)
	}
	sameSite := func(r *http.Request) bool {
		return r.Method == http.MethodPost && r.Header.Get("Origin") != "" && originOK(r)
	}
	if devTalk {
		log.Printf("talk: DEV TRIGGER ENABLED (/api/talk/encounter from localhost)")
	}

	mux.HandleFunc("/api/talk/prefs", func(w http.ResponseWriter, r *http.Request) {
		if ts == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent talk is not available"})
			return
		}
		if r.Method == http.MethodPost && !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET, POST")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET or POST"})
			return
		}
		id, ok := acc.sess.read(r) // the session cookie only: never an agent's token
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		p, err := ts.talkPrefs(ctx, acc.tenant, id)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
		if r.Method == http.MethodPost {
			var in struct {
				OptIn       *bool `json:"opt_in"`
				Busy        *bool `json:"busy"`
				OkayToShare *bool `json:"okay_to_share"`
			}
			b, _ := io.ReadAll(io.LimitReader(r.Body, 1024))
			if json.Unmarshal(bytes.TrimSpace(b), &in) != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "send JSON {opt_in, busy, okay_to_share}"})
				return
			}
			old := p
			if in.OptIn != nil {
				p.OptIn = *in.OptIn
			}
			if in.Busy != nil {
				p.Busy = *in.Busy
			}
			if in.OkayToShare != nil {
				p.OkayToShare = *in.OkayToShare
			}
			if err := ts.talkSavePrefs(ctx, acc.tenant, id, p); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
				return
			}
			t.nearOpted(id, p)
			go t.prefsChanged(acc.tenant, id, old, p)
		}
		writeJSON(w, http.StatusOK, p)
	})

	mux.HandleFunc("/api/talk/optin", func(w http.ResponseWriter, r *http.Request) {
		if ts == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent talk is not available"})
			return
		}
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET, POST")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET or POST"})
			return
		}
		if r.Method == http.MethodPost && !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		id, ok := acc.sess.read(r) // the session cookie only: an agent's token can never switch this on
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		p, err := ts.talkPrefs(ctx, acc.tenant, id)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
		if r.Method == http.MethodPost {
			var in struct {
				On *bool `json:"on"`
			}
			b, _ := io.ReadAll(io.LimitReader(r.Body, 256))
			if json.Unmarshal(bytes.TrimSpace(b), &in) != nil || in.On == nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "send JSON {\"on\": true|false}"})
				return
			}
			old := p
			p.OptIn = *in.On
			if err := ts.talkSavePrefs(ctx, acc.tenant, id, p); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
				return
			}
			t.nearOpted(id, p)
			go t.prefsChanged(acc.tenant, id, old, p)
		}
		out := map[string]any{"on": p.OptIn, "busy": p.Busy, "live": t.on()}
		if t != nil {
			if left, lim, err := t.talksLeft(ctx, acc.tenant, id); err == nil && lim > 0 {
				out["left"], out["limit"] = left, lim
			}
		}
		writeJSON(w, http.StatusOK, out)
	})

	mux.HandleFunc("/api/talk/encounter", func(w http.ResponseWriter, r *http.Request) {
		allowed := false
		if devTalk && isLoopback(r) {
			allowed = true
		} else if len(admins) > 0 && sameSite(r) {
			if id, ok := acc.sess.read(r); ok {
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				a, err := acc.store.Account(ctx, acc.tenant, id)
				cancel()
				allowed = err == nil && admins[strings.ToLower(a.User.Email)]
			}
		}
		if !allowed {
			http.NotFound(w, r) // not a public endpoint: don't even say it exists
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST {a_uid, b_uid}"})
			return
		}
		var in struct {
			A     int64 `json:"a_uid"`
			B     int64 `json:"b_uid"`
			Force bool  `json:"force"` // rerun a pair for a demo (skips the cooldown and daily caps)
		}
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1024))
		if json.Unmarshal(bytes.TrimSpace(b), &in) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "send JSON {a_uid, b_uid}"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		id, err := t.encounter(ctx, acc.tenant, in.A, in.B, in.Force)
		if err != nil {
			writeJSON(w, talkStatus(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id})
	})

	mux.HandleFunc("/api/talk/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/talk/")
		id, action, _ := strings.Cut(rest, "/")
		if t == nil || !strings.HasPrefix(id, "tk_") {
			http.NotFound(w, r)
			return
		}
		uid, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		if action == "" && r.Method == http.MethodGet {
			v, err := t.view(ctx, acc.tenant, uid, id)
			if err != nil {
				writeJSON(w, talkStatus(err), map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, v)
			return
		}
		if !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		switch action {
		case "approve", "skip":
			st, err := t.decide(ctx, acc.tenant, uid, id, action == "approve")
			if err != nil {
				writeJSON(w, talkStatus(err), map[string]string{"error": err.Error(), "state": st})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"state": st})
		case "feedback":
			var in struct {
				WorthIt *bool `json:"worth_it"`
			}
			b, _ := io.ReadAll(io.LimitReader(r.Body, 1024))
			if json.Unmarshal(bytes.TrimSpace(b), &in) != nil || in.WorthIt == nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "send JSON {\"worth_it\": true|false}"})
				return
			}
			if err := t.feedback(ctx, acc.tenant, uid, id, *in.WorthIt); err != nil {
				writeJSON(w, talkStatus(err), map[string]string{"error": err.Error()})
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	})
}

func isLoopback(r *http.Request) bool {
	host, _, _ := strings.Cut(r.Host, ":")
	return (host == "localhost" || host == "127.0.0.1") && r.Header.Get("X-Forwarded-For") == ""
}

func talkStatus(err error) int {
	switch {
	case errors.Is(err, errNoTalk), errors.Is(err, errTalkNotYour):
		return http.StatusNotFound
	case errors.Is(err, errTalkPair), errors.Is(err, errTalkState), errors.Is(err, errTalkBusy):
		return http.StatusConflict
	case errors.Is(err, errTalkOptIn), errors.Is(err, errTalkWho):
		return http.StatusForbidden
	case errors.Is(err, errTalkCap), errors.Is(err, errTalkFull):
		return http.StatusTooManyRequests
	case errors.Is(err, errTalkOffline):
		return http.StatusPreconditionFailed
	case errors.Is(err, errTalkOff):
		return http.StatusServiceUnavailable
	}
	return http.StatusServiceUnavailable
}
