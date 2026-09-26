package main

// Dressing your bean from what your agent remembers about you. When an attendee's agent
// uploads their memory, jev (TypeSafe's System One decision model: it returns typed
// choices with probabilities, not prose) picks one option per outfit slot from the same
// lists the Bean Studio offers. The Bean Studio then opens with that outfit on, and the
// person can change anything before saving. The memory it sees is the upload after
// redaction (redact.go), trimmed to fit.
//
// API: POST https://api.typesafe.ai/v1/systemone {state, model, questions:{name:{type:"choice",
// instructions, criteria:{option: description}}}} -> {answers:{name:{choice, probabilities,
// confidence}}}. One call answers every slot.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	jevURL       = "https://api.typesafe.ai/v1/systemone"
	jevModel     = "jev-latest"
	jevStateMax  = 24_000 // chars of memory handed to jev (its limit is 32k tokens per question)
	jevTimeout   = 20 * time.Second
	jevNoteCount = 7 // most recent daily notes included
)

type jevOption struct{ value, desc string }

// The Bean Studio's options (client/src/look.ts), each described in plain words so jev
// can match them to a person. Colours map a readable name to the studio's hex value.
var jevSlots = []struct {
	key, code, instructions string
	options                 map[string]jevOption
}{
	{"hat", "h", "Which hat suits this person, from what they're like and what they're into?", map[string]jevOption{
		"none": {"none", "no hat; understated, lets the work speak"}, "cap": {"cap", "sporty, casual, practical builder"},
		"crown": {"crown", "confident, competitive, loves to win"}, "bunny": {"bunny", "playful, cute, whimsical"},
		"bucket": {"bucket", "chill, outdoorsy, laid back"}, "propeller": {"propeller", "curious tinkerer, goofy, kid at heart"},
		"halo": {"halo", "kind, helps others, mentor"}, "party": {"party", "social, loves celebrations and people"},
		"headphones": {"headphones", "focused, heads-down, music while working"},
	}},
	{"item", "i", "What would this person be holding at a hackathon?", map[string]jevOption{
		"none": {"none", "nothing in hand"}, "laptop": {"laptop", "always coding or designing"},
		"coffee": {"coffee", "runs on coffee"}, "boba": {"boba", "loves boba tea, sweet treats"},
		"phone": {"phone", "always connecting with people, on their phone"}, "duck": {"duck", "rubber-duck debugging, playful problem solver"},
		"energy": {"energy", "energy drinks, all-nighters"}, "trophy": {"trophy", "has won things, proud of results"},
	}},
	{"eyes", "e", "Which eyes match this person's usual mood?", map[string]jevOption{
		"dots": {"dots", "calm, neutral, easygoing"}, "happy": {"happy", "cheerful, upbeat, friendly"},
		"sleepy": {"sleepy", "night owl, tired, relaxed"}, "wink": {"wink", "cheeky, jokes a lot"},
		"star": {"star", "ambitious dreamer, starry-eyed about ideas"}, "shades": {"shades", "cool, confident, effortless"},
	}},
	{"pattern", "p", "Which pattern fits this person's style?", map[string]jevOption{
		"solid": {"solid", "clean, minimal, simple"}, "split": {"split", "two sides: e.g. engineer and artist"},
		"stripes": {"stripes", "sporty, organised, structured"}, "dots": {"dots", "playful, fun"},
		"zigzag": {"zigzag", "high energy, a bit chaotic"}, "hearts": {"hearts", "warm, caring, loves people"},
	}},
	{"body", "b", "Which main colour suits this person? Use a favourite colour if they mention one.", map[string]jevOption{
		"orange": {"#ff8a3d", "orange: energetic, bold"}, "coral": {"#ff5d6c", "coral red: passionate, loud"},
		"yellow": {"#ffc93c", "sunny yellow: cheerful, optimistic"}, "green": {"#7ad36b", "green: calm, nature, sustainability"},
		"sky": {"#3fc5f0", "sky blue: friendly, curious"}, "blue": {"#4f7fd6", "deep blue: focused, calm, dependable"},
		"purple": {"#9b6bd1", "purple: creative, artsy, dreamy"}, "pink": {"#ff7eb6", "pink: playful, sweet"},
		"teal": {"#2bb3a6", "teal: balanced, thoughtful"}, "cream": {"#f5f1e6", "cream: minimalist, understated"},
		"charcoal": {"#4a4e57", "charcoal: serious, low-key, night owl"}, "brown": {"#b86b3c", "brown: warm, grounded, coffee lover"},
	}},
	{"accent", "a", "Which second colour (the accent) suits this person?", map[string]jevOption{
		"white": {"#ffffff", "white: clean, simple"}, "gold": {"#ffe066", "gold: optimistic, a winner"},
		"coral": {"#ff5d6c", "coral: bold"}, "sky": {"#3fc5f0", "sky blue: friendly"}, "green": {"#7ad36b", "green: calm"},
		"purple": {"#9b6bd1", "purple: creative"}, "pink": {"#ff7eb6", "pink: playful"}, "ink": {"#1f2430", "near black: serious, sharp"},
		"orange": {"#ff8a3d", "orange: energetic"}, "teal": {"#2bb3a6", "teal: thoughtful"},
	}},
}

type lookPick struct {
	Choice     string  `json:"choice"`
	Confidence float64 `json:"confidence"`
}

type suggestedLook struct {
	Look string              `json:"look"`
	Why  map[string]lookPick `json:"why"`
	At   time.Time           `json:"at"`
	hash string
}

type jevLook struct {
	key  string
	http *http.Client
	sem  chan struct{}

	mu   sync.Mutex
	byID map[string]suggestedLook // "<tenant>/<id>"; also persisted when the store is Postgres
	pg   *pgStore
}

// openJev: on when JEV_API_KEY (or JEV_API_KEY_FILE) is set; nil (off) otherwise.
func openJev(acc *accounts) *jevLook {
	key := strings.TrimSpace(os.Getenv("JEV_API_KEY"))
	if f := os.Getenv("JEV_API_KEY_FILE"); key == "" && f != "" {
		if b, err := os.ReadFile(f); err == nil {
			key = strings.TrimSpace(string(b))
		}
	}
	if key == "" || acc == nil {
		return nil
	}
	j := &jevLook{key: key, http: &http.Client{Timeout: jevTimeout}, sem: make(chan struct{}, 2), byID: map[string]suggestedLook{}}
	if pg, ok := acc.store.(*pgStore); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pg.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS look_suggestions (
			tenant_id text NOT NULL, user_id bigint NOT NULL, look text NOT NULL, why jsonb NOT NULL,
			memory_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (tenant_id, user_id),
			FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE)`); err != nil {
			log.Printf("jev: suggestions table: %v (kept in memory only)", err)
		} else {
			j.pg = pg
		}
	}
	log.Printf("jev: on (%s), outfits picked from agent memory", jevModel)
	return j
}

// jevState: the parts of an upload that say who someone is, most telling first, trimmed.
func jevState(obj map[string]any) string {
	var b strings.Builder
	add := func(label string, v any) {
		s, _ := v.(string)
		if s = strings.TrimSpace(s); s == "" || b.Len() >= jevStateMax {
			return
		}
		b.WriteString(label + ":\n" + s + "\n\n")
	}
	add("About me", obj["user_md"])
	if bank, ok := obj["bank"].(map[string]any); ok {
		for _, k := range []string{"experience", "opinions", "reflections", "world"} {
			add("My "+k, bank[k])
		}
	}
	add("My memory", obj["memory_md"])
	if notes, ok := obj["daily_notes"].([]any); ok {
		sort.SliceStable(notes, func(i, k int) bool { // newest first
			a, _ := notes[i].(map[string]any)
			c, _ := notes[k].(map[string]any)
			return fmt.Sprint(a["date"]) > fmt.Sprint(c["date"])
		})
		for i, n := range notes {
			if i >= jevNoteCount {
				break
			}
			if m, ok := n.(map[string]any); ok {
				add("Note "+fmt.Sprint(m["date"]), m["content"])
			}
		}
	}
	s := b.String()
	if len(s) > jevStateMax {
		s = s[:jevStateMax]
	}
	return s
}

// suggest runs in the background after an upload; a repeat of the same memory is skipped.
func (j *jevLook) suggest(tenant string, id int64, obj map[string]any) {
	if j == nil || id == 0 {
		return
	}
	state := jevState(obj)
	if strings.TrimSpace(state) == "" {
		return
	}
	sum := sha256.Sum256([]byte(state))
	hash := hex.EncodeToString(sum[:])
	if cur, ok := j.get(context.Background(), tenant, id); ok && cur.hash == hash {
		return
	}
	go func() {
		j.sem <- struct{}{}
		defer func() { <-j.sem }()
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), jevTimeout)
		defer cancel()
		look, why, err := j.decide(ctx, state)
		if err != nil {
			log.Printf("jev: #%d outfit: %v", id, err)
			return
		}
		j.put(ctx, tenant, id, suggestedLook{Look: look, Why: why, At: time.Now().UTC(), hash: hash})
		log.Printf("jev: #%d outfit picked in %.0fms", id, float64(time.Since(start).Milliseconds()))
	}()
}

func (j *jevLook) decide(ctx context.Context, state string) (string, map[string]lookPick, error) {
	questions := map[string]any{}
	for _, s := range jevSlots {
		crit := map[string]string{}
		for name, o := range s.options {
			crit[name] = o.desc
		}
		questions[s.key] = map[string]any{"type": "choice", "instructions": s.instructions, "criteria": crit}
	}
	body, _ := json.Marshal(map[string]any{"state": state, "model": jevModel, "questions": questions})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, jevURL, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+j.key)
	req.Header.Set("Content-Type", "application/json")
	res, err := j.http.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer res.Body.Close()
	var out struct {
		Answers map[string]lookPick `json:"answers"`
		Error   any                 `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("jev http %d", res.StatusCode)
	}
	look, err := jevToLook(out.Answers)
	return look, out.Answers, err
}

// jevToLook turns jev's picks into the Bean Studio's look string (look.ts encodeLook).
func jevToLook(ans map[string]lookPick) (string, error) {
	val := map[string]string{}
	for _, s := range jevSlots {
		o, ok := s.options[ans[s.key].Choice]
		if !ok {
			return "", errors.New("jev: no valid choice for " + s.key)
		}
		val[s.code] = o.value
	}
	if val["a"] == val["b"] { // an accent the same as the body disappears
		val["a"] = "#ffffff"
		if val["b"] == "#ffffff" || val["b"] == "#f5f1e6" {
			val["a"] = "#1f2430"
		}
	}
	return fmt.Sprintf("b=%s;a=%s;p=%s;e=%s;h=%s;i=%s", val["b"], val["a"], val["p"], val["e"], val["h"], val["i"]), nil
}

func (j *jevLook) put(ctx context.Context, tenant string, id int64, s suggestedLook) {
	j.mu.Lock()
	j.byID[memKey(tenant, id)] = s
	j.mu.Unlock()
	if j.pg != nil {
		why, _ := json.Marshal(s.Why)
		if _, err := j.pg.pool.Exec(ctx, `INSERT INTO look_suggestions (tenant_id, user_id, look, why, memory_hash, created_at)
			VALUES ($1, $2, $3, $4::jsonb, $5, now())
			ON CONFLICT (tenant_id, user_id) DO UPDATE SET look = EXCLUDED.look, why = EXCLUDED.why,
			  memory_hash = EXCLUDED.memory_hash, created_at = now()`, tenant, id, s.Look, string(why), s.hash); err != nil {
			log.Printf("jev: saving #%d: %v", id, err)
		}
	}
}

func (j *jevLook) get(ctx context.Context, tenant string, id int64) (suggestedLook, bool) {
	j.mu.Lock()
	s, ok := j.byID[memKey(tenant, id)]
	j.mu.Unlock()
	if ok || j.pg == nil {
		return s, ok
	}
	var why []byte
	err := j.pg.pool.QueryRow(ctx, `SELECT look, why, memory_hash, created_at FROM look_suggestions WHERE tenant_id = $1 AND user_id = $2`,
		tenant, id).Scan(&s.Look, &why, &s.hash, &s.At)
	if err != nil {
		return suggestedLook{}, false
	}
	json.Unmarshal(why, &s.Why)
	j.mu.Lock()
	j.byID[memKey(tenant, id)] = s
	j.mu.Unlock()
	return s, true
}

// forget drops a suggestion (when the person deletes their memory).
func (j *jevLook) forget(ctx context.Context, tenant string, id int64) {
	if j == nil {
		return
	}
	j.mu.Lock()
	delete(j.byID, memKey(tenant, id))
	j.mu.Unlock()
	if j.pg != nil {
		j.pg.pool.Exec(ctx, `DELETE FROM look_suggestions WHERE tenant_id = $1 AND user_id = $2`, tenant, id)
	}
}

// mountJev adds GET /api/look/suggested for the signed-in person: {look, why, at} or {look: null}.
func mountJev(mux *http.ServeMux, acc *accounts, j *jevLook) {
	mux.HandleFunc("/api/look/suggested", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		id, ok := acc.sess.read(r)
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "sign in first"})
			return
		}
		if j == nil {
			json.NewEncoder(w).Encode(map[string]any{"look": nil})
			return
		}
		s, ok := j.get(r.Context(), acc.tenant, id)
		if !ok {
			json.NewEncoder(w).Encode(map[string]any{"look": nil})
			return
		}
		json.NewEncoder(w).Encode(s)
	})
}
