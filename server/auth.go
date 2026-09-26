package main

// Sign in with Google. The browser gets a signed ID token from Google Identity Services
// and posts it here; we check it against Google's public keys (no client secret needed),
// remember the account, and hand back a session cookie. The client reaches /api through
// the site's own origin (Vercel rewrites it here), so the cookie is first-party.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie = "gtq_session"
	sessionTTL    = 30 * 24 * time.Hour
	googleCerts   = "https://www.googleapis.com/oauth2/v3/certs"
)

type user struct {
	Sub     string    `json:"sub"`
	Email   string    `json:"email"`
	Name    string    `json:"name"`
	Given   string    `json:"given"`
	Picture string    `json:"picture"`
	Created time.Time `json:"created"`
	Seen    time.Time `json:"seen"`
}

// googleKeys caches Google's signing keys for as long as Google says they're good.
type googleKeys struct {
	mu   sync.Mutex
	keys map[string]*rsa.PublicKey
	exp  time.Time
}

func (g *googleKeys) key(kid string) (*rsa.PublicKey, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if k, ok := g.keys[kid]; ok && time.Now().Before(g.exp) {
		return k, nil
	}
	// unknown kid or stale set: refetch (Google rotates keys every few days)
	if err := g.fetch(); err != nil {
		return nil, err
	}
	if k, ok := g.keys[kid]; ok {
		return k, nil
	}
	return nil, errors.New("unknown signing key")
}

func (g *googleKeys) fetch() error {
	c := http.Client{Timeout: 5 * time.Second}
	res, err := c.Get(googleCerts)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var set struct {
		Keys []struct{ Kid, N, E, Kty string }
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&set); err != nil {
		return err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	if len(keys) == 0 {
		return errors.New("no keys")
	}
	ttl := time.Hour
	for _, p := range strings.Split(res.Header.Get("Cache-Control"), ",") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(p), "max-age="); ok {
			if s, err := strconv.Atoi(v); err == nil && s > 60 {
				ttl = time.Duration(s) * time.Second
			}
		}
	}
	g.keys, g.exp = keys, time.Now().Add(ttl)
	return nil
}

// verifyGoogle checks an ID token's signature, issuer, audience and expiry.
func verifyGoogle(tok string, audiences []string, keys *googleKeys) (user, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return user{}, errors.New("malformed token")
	}
	hb, err1 := base64.RawURLEncoding.DecodeString(parts[0])
	pb, err2 := base64.RawURLEncoding.DecodeString(parts[1])
	sig, err3 := base64.RawURLEncoding.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return user{}, errors.New("malformed token")
	}
	var h struct{ Alg, Kid string }
	if json.Unmarshal(hb, &h) != nil || h.Alg != "RS256" {
		return user{}, errors.New("unexpected algorithm")
	}
	k, err := keys.key(h.Kid)
	if err != nil {
		return user{}, err
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(k, crypto.SHA256, sum[:], sig) != nil {
		return user{}, errors.New("bad signature")
	}
	var c struct {
		Iss, Aud, Sub, Email, Name, Picture string
		Given                               string `json:"given_name"`
		Verified                            any    `json:"email_verified"`
		Exp                                 int64
	}
	if json.Unmarshal(pb, &c) != nil {
		return user{}, errors.New("bad claims")
	}
	if c.Iss != "accounts.google.com" && c.Iss != "https://accounts.google.com" {
		return user{}, errors.New("wrong issuer")
	}
	audOK := false
	for _, a := range audiences {
		audOK = audOK || c.Aud == a
	}
	if !audOK {
		return user{}, errors.New("wrong audience")
	}
	if time.Now().Unix() > c.Exp+60 {
		return user{}, errors.New("expired")
	}
	// the email is the account key, so it must be one Google has verified
	if c.Sub == "" || c.Email == "" || (c.Verified != true && c.Verified != "true") {
		return user{}, errors.New("email not verified")
	}
	return user{Sub: c.Sub, Email: c.Email, Name: c.Name, Given: c.Given, Picture: c.Picture}, nil
}

// Tokens are "<account id>.<expiry unix>.<hmac>", stateless so they survive restarts.
// The kind is mixed into the MAC, so a game ticket can't be replayed as a session cookie.
type sessions struct{ secret []byte }

const (
	kindSession = "session"
	kindTicket  = "ws" // handed to the page for the game socket, which lives on another host
	ticketTTL   = 24 * time.Hour
)

// loadSecret reads the signing key from path, creating it the first time.
func loadSecret(path string) []byte {
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b
	}
	b := make([]byte, 32)
	rand.Read(b)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		log.Printf("auth: cannot save session key to %s (sessions end on restart): %v", path, err)
	}
	return b
}

func (s sessions) sign(kind, v string) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(kind + "|" + v))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s sessions) issue(kind string, id int64, ttl time.Duration) (string, time.Time) {
	exp := time.Now().Add(ttl)
	v := strconv.FormatInt(id, 10) + "." + strconv.FormatInt(exp.Unix(), 10)
	return v + "." + s.sign(kind, v), exp
}

func (s sessions) check(kind, tok string) (int64, bool) {
	i := strings.LastIndexByte(tok, '.')
	if i < 0 || !hmac.Equal([]byte(tok[i+1:]), []byte(s.sign(kind, tok[:i]))) {
		return 0, false
	}
	ids, exp, ok := strings.Cut(tok[:i], ".")
	e, err1 := strconv.ParseInt(exp, 10, 64)
	id, err2 := strconv.ParseInt(ids, 10, 64)
	if !ok || err1 != nil || err2 != nil || time.Now().Unix() > e {
		return 0, false
	}
	return id, true
}

func (s sessions) read(r *http.Request) (int64, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return 0, false
	}
	return s.check(kindSession, c.Value)
}

func setSession(w http.ResponseWriter, r *http.Request, val string, exp time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: val, Path: "/", Expires: exp, MaxAge: int(time.Until(exp).Seconds()),
		HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" || !isLocal(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func isLocal(r *http.Request) bool {
	h := r.Host
	return strings.HasPrefix(h, "localhost:") || strings.HasPrefix(h, "127.0.0.1:") || h == "localhost"
}

type publicUser struct {
	Name    string `json:"name"`
	Given   string `json:"given"`
	Email   string `json:"email"`
	Picture string `json:"picture"`
}

func pub(u user) *publicUser {
	return &publicUser{Name: u.Name, Given: u.Given, Email: u.Email, Picture: u.Picture}
}

// accounts is what the game socket needs from sign-in: who a ticket belongs to, and
// where to save them.
type accounts struct {
	store  Store
	tenant string
	sess   sessions
	fast   *memFast    // attendees' memory in MAPI (memfast.go); nil when off
	jev    *jevLook    // outfits picked from agent memory (jevlook.go); nil when off
	talk   *agentTalk  // agents talking when attendees meet (agenttalk.go); nil when off
	voice  *voiceGuide // voice onboarding (voice.go); nil when off
}

// mountAuth adds /api/me, /api/auth/google and /api/auth/logout. With no client IDs
// configured, sign-in is off and /api/me says so (the site then lets everyone straight in).
func mountAuth(mux *http.ServeMux, clientIDs []string, acc *accounts, originOK func(*http.Request) bool) {
	keys := googleKeysOverride
	if keys == nil {
		keys = &googleKeys{}
	}
	clientID := ""
	if len(clientIDs) > 0 {
		clientID = clientIDs[0]
	}
	writeJSON := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(v)
	}
	// posts must come from our own pages (the session cookie is Lax, this is belt and braces)
	sameSite := func(r *http.Request) bool {
		return r.Method == http.MethodPost && originOK(r) && r.Header.Get("Origin") != ""
	}
	// everything the page needs to pick up where you left off
	me := func(a Account) map[string]any {
		tk, _ := acc.sess.issue(kindTicket, a.ID, ticketTTL)
		return map[string]any{"user": pub(a.User), "profile": a.Profile, "progress": a.Progress, "ticket": tk}
	}

	mux.HandleFunc("/api/me", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{"googleClientId": clientID, "tenant": acc.tenant, "user": nil, "voice": acc.voice != nil}
		if id, ok := acc.sess.read(r); ok {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			a, err := acc.store.Account(ctx, acc.tenant, id)
			cancel()
			if err == nil {
				for k, v := range me(a) {
					out[k] = v
				}
			} else if !errors.Is(err, errNoAccount) {
				log.Printf("auth: loading account %d: %v", id, err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable"})
				return
			}
		}
		writeJSON(w, http.StatusOK, out)
	})
	mux.HandleFunc("/api/auth/google", func(w http.ResponseWriter, r *http.Request) {
		if clientID == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "sign-in is not set up"})
			return
		}
		if !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		var body struct{ Credential string }
		b, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
		if json.Unmarshal(bytes.TrimSpace(b), &body) != nil || body.Credential == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing credential"})
			return
		}
		g, err := verifyGoogle(body.Credential, clientIDs, keys)
		if err != nil {
			log.Printf("auth: rejected Google token: %v", err)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign-in failed"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		a, created, err := acc.store.SignIn(ctx, acc.tenant, g)
		cancel()
		if err != nil {
			log.Printf("auth: saving account: %v", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable"})
			return
		}
		if created {
			log.Printf("auth: new account #%d", a.ID)
		}
		val, exp := acc.sess.issue(kindSession, a.ID, sessionTTL)
		setSession(w, r, val, exp)
		out := me(a)
		out["created"] = created
		writeJSON(w, http.StatusOK, out)
	})
	// the Bean Studio saves your bean here (the game socket saves name/colour/bean on join too)
	mux.HandleFunc("/api/profile", func(w http.ResponseWriter, r *http.Request) {
		if !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not signed in"})
			return
		}
		var in struct{ Name, Color, Look *string }
		b, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
		if json.Unmarshal(bytes.TrimSpace(b), &in) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad profile"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		a, err := acc.store.Account(ctx, acc.tenant, id)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable"})
			return
		}
		p := a.Profile
		if in.Name != nil {
			if n := cleanText(*in.Name, maxNameLen); n != "" {
				p.Name = n
			}
		}
		if in.Color != nil && palette[*in.Color] {
			p.Color = *in.Color
		}
		if in.Look != nil {
			p.Look = cleanLook(*in.Look)
		}
		if err := acc.store.SaveProfile(ctx, acc.tenant, id, p); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "accounts unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, p)
	})
	mux.HandleFunc("/api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if !sameSite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return
		}
		setSession(w, r, "", time.Unix(0, 0))
		w.WriteHeader(http.StatusNoContent)
	})
}

// googleKeysOverride lets tests sign their own tokens.
var googleKeysOverride *googleKeys

// mountDevLogin signs in a test account without Google, for trying the signed-in flows
// locally. Off unless the server runs with -dev-login, and even then localhost only.
func mountDevLogin(mux *http.ServeMux, acc *accounts) {
	log.Printf("auth: DEV LOGIN ENABLED (localhost only)")
	mux.HandleFunc("/api/dev/login", func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := strings.Cut(r.Host, ":")
		if host != "localhost" && host != "127.0.0.1" || r.Header.Get("X-Forwarded-For") != "" {
			http.NotFound(w, r)
			return
		}
		email := r.URL.Query().Get("email")
		if email == "" {
			email = "dev@localhost"
		}
		a, _, err := acc.store.SignIn(r.Context(), acc.tenant, user{Sub: "dev:" + email, Email: email, Name: "Dev Tester", Given: "Dev"})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		val, exp := acc.sess.issue(kindSession, a.ID, sessionTTL)
		setSession(w, r, val, exp)
		next := r.URL.Query().Get("next")
		if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
			next = "/"
		}
		http.Redirect(w, r, next, http.StatusFound)
	})
}
