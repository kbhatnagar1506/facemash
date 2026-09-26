package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testAud = "test-client.apps.googleusercontent.com"

func testKeys(t *testing.T) (*rsa.PrivateKey, *googleKeys) {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k, &googleKeys{keys: map[string]*rsa.PublicKey{"k1": &k.PublicKey}, exp: time.Now().Add(time.Hour)}
}

func token(t *testing.T, k *rsa.PrivateKey, kid string, claims map[string]any) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	head := enc(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"}) + "." + enc(claims)
	sum := sha256.Sum256([]byte(head))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return head + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func claims(mod func(map[string]any)) map[string]any {
	c := map[string]any{
		"iss": "https://accounts.google.com", "aud": testAud, "sub": "1234",
		"email": "buzz@gatech.edu", "email_verified": true, "name": "Buzz Bee", "given_name": "Buzz",
		"picture": "https://example.com/p.png", "exp": time.Now().Add(time.Hour).Unix(),
	}
	if mod != nil {
		mod(c)
	}
	return c
}

func TestVerifyGoogle(t *testing.T) {
	k, keys := testKeys(t)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	u, err := verifyGoogle(token(t, k, "k1", claims(nil)), []string{testAud}, keys)
	if err != nil || u.Sub != "1234" || u.Given != "Buzz" || u.Email != "buzz@gatech.edu" {
		t.Fatalf("valid token: %+v %v", u, err)
	}
	bad := map[string]string{
		"wrong audience": token(t, k, "k1", claims(func(c map[string]any) { c["aud"] = "someone-else" })),
		"wrong issuer":   token(t, k, "k1", claims(func(c map[string]any) { c["iss"] = "https://evil.example" })),
		"expired":        token(t, k, "k1", claims(func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() })),
		"unverified":     token(t, k, "k1", claims(func(c map[string]any) { c["email_verified"] = false })),
		"other key":      token(t, other, "k1", claims(nil)),
		"garbage":        "a.b.c",
	}
	for name, tok := range bad {
		if _, err := verifyGoogle(tok, []string{testAud}, keys); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// a tampered payload keeps the old signature
	good := strings.Split(token(t, k, "k1", claims(nil)), ".")
	evil := strings.Split(token(t, k, "k1", claims(func(c map[string]any) { c["sub"] = "9999" })), ".")
	if _, err := verifyGoogle(good[0]+"."+evil[1]+"."+good[2], []string{testAud}, keys); err == nil {
		t.Error("tampered payload accepted")
	}
}

func TestSessions(t *testing.T) {
	s := sessions{secret: []byte("0123456789abcdef0123456789abcdef")}
	val, _ := s.issue(kindSession, 42, time.Hour)
	req := func(v string) *http.Request {
		r := httptest.NewRequest("GET", "/api/me", nil)
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: v})
		return r
	}
	if id, ok := s.read(req(val)); !ok || id != 42 {
		t.Fatalf("read back: %d %v", id, ok)
	}
	if _, ok := s.read(req("43" + val[2:])); ok {
		t.Error("forged id accepted")
	}
	if _, ok := (sessions{secret: []byte("another-secret-another-secret-00")}).read(req(val)); ok {
		t.Error("cookie from another key accepted")
	}
	// a game ticket is not a session, and the other way round
	tk, _ := s.issue(kindTicket, 42, time.Hour)
	if _, ok := s.read(req(tk)); ok {
		t.Error("ticket accepted as a session")
	}
	if _, ok := s.check(kindTicket, val); ok {
		t.Error("session accepted as a ticket")
	}
	if id, ok := s.check(kindTicket, tk); !ok || id != 42 {
		t.Error("ticket rejected")
	}
	old, _ := s.issue(kindSession, 42, -time.Minute)
	if _, ok := s.read(req(old)); ok {
		t.Error("expired session accepted")
	}
}

func TestSignInFlow(t *testing.T) {
	k, keys := testKeys(t)
	googleKeysOverride = keys
	defer func() { googleKeysOverride = nil }()
	store := newMemStore()
	acc := &accounts{store: store, tenant: "hackgt13", sess: sessions{secret: []byte("0123456789abcdef0123456789abcdef")}}
	mux := http.NewServeMux()
	mountAuth(mux, []string{testAud}, acc, func(r *http.Request) bool {
		return r.Header.Get("Origin") == "https://site.test"
	})

	post := func(origin, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/auth/google", strings.NewReader(body))
		r.Host = "site.test"
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	tok := token(t, k, "k1", claims(nil))
	if w := post("https://evil.test", `{"credential":"`+tok+`"}`); w.Code != http.StatusForbidden {
		t.Fatalf("cross-site post: %d", w.Code)
	}
	if w := post("", `{"credential":"`+tok+`"}`); w.Code != http.StatusForbidden {
		t.Fatalf("post without origin: %d", w.Code)
	}
	w := post("https://site.test", `{"credential":"`+tok+`"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"created":true`) {
		t.Fatalf("sign in: %d %s", w.Code, w.Body)
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("cookie flags: %+v", cookie)
	}
	me := func() map[string]any {
		r := httptest.NewRequest("GET", "/api/me", nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	out := me()
	if u, _ := out["user"].(map[string]any); u == nil || u["given"] != "Buzz" || out["googleClientId"] != testAud || out["progress"] != nil {
		t.Fatalf("me: %v", out)
	}
	// the ticket identifies the account to the game socket; progress saved there comes back
	id, ok := acc.sess.check(kindTicket, out["ticket"].(string))
	if !ok {
		t.Fatal("ticket from /api/me rejected")
	}
	store.SaveProgress(context.Background(), "hackgt13", id, Progress{Room: "hackgt", X: 3.5, Z: -2})
	store.SaveProfile(context.Background(), "hackgt13", id, Profile{Name: "Buzz", Color: "#4f7fd6", Look: "abc"})
	out = me()
	if p, _ := out["progress"].(map[string]any); p == nil || p["room"] != "hackgt" || p["x"] != 3.5 {
		t.Fatalf("progress: %v", out["progress"])
	}
	if p, _ := out["profile"].(map[string]any); p == nil || p["name"] != "Buzz" {
		t.Fatalf("profile: %v", out["profile"])
	}
	if w := post("https://site.test", `{"credential":"`+tok+`"}`); !strings.Contains(w.Body.String(), `"created":false`) {
		t.Fatalf("second sign in should reuse the account: %s", w.Body)
	}
	// the email is the key: a new Google subject or different capitals, same account
	if a, created, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "other-sub", Email: "BUZZ@gatech.edu"}); created || a.ID != id {
		t.Fatalf("same email should be the same account: #%d created=%v (want #%d)", a.ID, created, id)
	}
	if a, created, _ := store.SignIn(context.Background(), "hackgt13", user{Sub: "1234", Email: "someone.else@gatech.edu"}); !created || a.ID == id {
		t.Fatalf("a different email must be a different account: #%d created=%v", a.ID, created)
	}
	// tenants are separate: the same person has no progress at another event
	if _, err := store.Account(context.Background(), "other-event", id); err == nil {
		t.Error("account visible in a tenant it never joined")
	}
	store.SignIn(context.Background(), "other-event", user{Sub: "1234", Email: "buzz@gatech.edu"})
	if a, _ := store.Account(context.Background(), "other-event", id); a.Progress != nil || a.Profile.Name != "" {
		t.Errorf("progress leaked across tenants: %+v", a)
	}
}
