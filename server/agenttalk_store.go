package main

// Agent talk's tables (see agenttalk.go), Postgres and memory with the same behaviour:
//   - talk_prefs: each person's own switches, set only from the app with their session:
//     opt_in (default off), busy, okay_to_share (lets "going through" come up at all).
//   - talk_briefs: the short brief their agent talks from, made from their memory.
//   - talks: every talk, with everything needed to retune later (config version,
//     transcript, jev's answers, verdict, approvals, timings, feedback). pair_key is unique
//     per tenant, which is the "a pair talks once per event" cooldown.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

type talkPrefs struct {
	OptIn       bool `json:"opt_in"`
	Busy        bool `json:"busy"`
	OkayToShare bool `json:"okay_to_share"`
}

type talkBrief struct {
	StuckOn      []string  `json:"stuck_on"`
	Solved       []string  `json:"solved"`
	LookingFor   []string  `json:"looking_for"`
	Rare         []string  `json:"rare"`
	GoingThrough []string  `json:"going_through,omitempty"`
	InterruptOK  bool      `json:"interrupt_ok"`
	OneLine      string    `json:"one_line"`
	At           time.Time `json:"at"`
	Hash         string    `json:"hash,omitempty"` // of the memory it was made from
}

type talkLine struct {
	N           int      `json:"n"`
	Side        string   `json:"side"` // "a" or "b": whose agent said it
	Kind        string   `json:"kind"` // greet, question, answer, close
	QID         string   `json:"qid,omitempty"`
	Text        string   `json:"text"`
	Cites       []string `json:"cites,omitempty"`
	NotInMemory bool     `json:"not_in_memory,omitempty"`
	Dropped     int      `json:"dropped,omitempty"` // sentences the guard took out
	DroppedText []string `json:"dropped_text,omitempty"` // (scrubbed) for retuning the guard; never shown
	Model       string   `json:"model,omitempty"`
	AtMS        float64  `json:"at_ms"`              // when it went out, from the start of the talk
	FirstMS     float64  `json:"first_ms,omitempty"` // answers: model start to first words
	TookMS      float64  `json:"took_ms,omitempty"`  // answers: model start to the whole answer
}

type talkJevCall struct {
	What    string            `json:"what"` // pick, checkpoint1, checkpoint2
	N       int               `json:"n,omitempty"`
	TookMS  float64           `json:"took_ms"`
	Options int               `json:"options,omitempty"`
	State   int               `json:"state_chars"`
	Answers map[string]jevAns `json:"answers,omitempty"`
	Err     string            `json:"err,omitempty"`
}

type talkIcebreaker struct {
	Line     string `json:"line"`
	Question string `json:"question"`
}

type talkRecord struct {
	ID            string             `json:"id"`
	Tenant        string             `json:"tenant"`
	A             int64              `json:"a"`
	B             int64              `json:"b"`
	ConfigVersion string             `json:"config_version"`
	BankVersion   string             `json:"bank_version"`
	State         string             `json:"state"` // live, no_match, awaiting, revealed, skipped, expired, error
	Started       time.Time          `json:"started"`
	Ended         *time.Time         `json:"ended,omitempty"`
	HotTopics     []string           `json:"hot_topics,omitempty"`
	Transcript    []talkLine         `json:"transcript"`
	Jev           []talkJevCall      `json:"jev"`
	Gates         map[string]float64 `json:"gates,omitempty"`
	Verdict       map[string]any     `json:"verdict,omitempty"`
	Fired         bool               `json:"fired"`
	Icebreaker    *talkIcebreaker    `json:"icebreaker,omitempty"`
	Approvals     map[string]string  `json:"approvals,omitempty"` // "a"/"b" → approve/skip
	Timings       map[string]float64 `json:"timings"`
	Feedback      map[string]bool    `json:"feedback,omitempty"` // "a"/"b" → worth it
	Forced        bool               `json:"forced,omitempty"`
}

func (r *talkRecord) pairKey() string {
	lo, hi := r.A, r.B
	if lo > hi {
		lo, hi = hi, lo
	}
	if r.Forced { // a demo rerun: doesn't use up (or hit) the pair's once-per-event slot
		return fmt.Sprintf("%d-%d-%s", lo, hi, r.ID)
	}
	return fmt.Sprintf("%d-%d", lo, hi)
}

func (r *talkRecord) copy() *talkRecord {
	b, _ := json.Marshal(r)
	out := &talkRecord{}
	json.Unmarshal(b, out)
	return out
}

var errTalkPair = errors.New("this pair already talked at this event")

type talkStore interface {
	talkEnsureSchema(ctx context.Context) error
	// talkMemory: what the person's own agent uploaded (already redacted), nil if nothing.
	talkMemory(ctx context.Context, tenant string, id int64) ([]byte, error)
	talkPrefs(ctx context.Context, tenant string, id int64) (talkPrefs, error)
	talkSavePrefs(ctx context.Context, tenant string, id int64, p talkPrefs) error
	talkBrief(ctx context.Context, tenant string, id int64) (*talkBrief, error)
	talkSaveBrief(ctx context.Context, tenant string, id int64, b talkBrief) error
	talkDeleteBrief(ctx context.Context, tenant string, id int64) error
	// talkRareTags: every brief's rare list in the tenant (for rarity).
	talkRareTags(ctx context.Context, tenant string) ([][]string, error)
	// talkCreate inserts a new talk; errTalkPair if the pair already has one.
	talkCreate(ctx context.Context, r *talkRecord) error
	talkSave(ctx context.Context, r *talkRecord) error
	talkGet(ctx context.Context, tenant, id string) (*talkRecord, error)
	// talkCount: talks (or only fired ones) this person was in since.
	talkCount(ctx context.Context, tenant string, id int64, since time.Time, firedOnly bool) (int, error)
}

var errNoTalk = errors.New("no such talk")

// ---------- Postgres ----------

const talkSchema = `
CREATE TABLE IF NOT EXISTS talk_prefs (
  tenant_id     text    NOT NULL,
  user_id       bigint  NOT NULL,
  opt_in        boolean NOT NULL DEFAULT false,
  busy          boolean NOT NULL DEFAULT false,
  okay_to_share boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS talk_briefs (
  tenant_id  text   NOT NULL,
  user_id    bigint NOT NULL,
  brief      jsonb  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS talks (
  id             text    PRIMARY KEY,
  tenant_id      text    NOT NULL,
  a_id           bigint  NOT NULL,
  b_id           bigint  NOT NULL,
  pair_key       text    NOT NULL,
  config_version text    NOT NULL,
  state          text    NOT NULL,
  fired          boolean NOT NULL DEFAULT false,
  started_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  record         jsonb   NOT NULL,
  FOREIGN KEY (tenant_id, a_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, b_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS talks_pair ON talks(tenant_id, pair_key);
CREATE INDEX IF NOT EXISTS talks_a ON talks(tenant_id, a_id, started_at);
CREATE INDEX IF NOT EXISTS talks_b ON talks(tenant_id, b_id, started_at);
`

func (s *pgStore) talkEnsureSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, talkSchema)
	return err
}

func (s *pgStore) talkMemory(ctx context.Context, tenant string, id int64) ([]byte, error) {
	var data []byte
	err := s.pool.QueryRow(ctx, `SELECT data::text FROM agent_memory WHERE tenant_id = $1 AND user_id = $2`, tenant, id).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return data, err
}

func (s *pgStore) talkPrefs(ctx context.Context, tenant string, id int64) (talkPrefs, error) {
	var p talkPrefs
	err := s.pool.QueryRow(ctx, `SELECT opt_in, busy, okay_to_share FROM talk_prefs WHERE tenant_id = $1 AND user_id = $2`, tenant, id).
		Scan(&p.OptIn, &p.Busy, &p.OkayToShare)
	if errors.Is(err, pgx.ErrNoRows) {
		return talkPrefs{}, nil // default: everything off
	}
	return p, err
}

func (s *pgStore) talkSavePrefs(ctx context.Context, tenant string, id int64, p talkPrefs) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO talk_prefs (tenant_id, user_id, opt_in, busy, okay_to_share, updated_at) VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET opt_in = EXCLUDED.opt_in, busy = EXCLUDED.busy,
		  okay_to_share = EXCLUDED.okay_to_share, updated_at = now()`, tenant, id, p.OptIn, p.Busy, p.OkayToShare)
	return err
}

func (s *pgStore) talkBrief(ctx context.Context, tenant string, id int64) (*talkBrief, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT brief::text FROM talk_briefs WHERE tenant_id = $1 AND user_id = $2`, tenant, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b := &talkBrief{}
	return b, json.Unmarshal(raw, b)
}

func (s *pgStore) talkSaveBrief(ctx context.Context, tenant string, id int64, b talkBrief) error {
	raw, _ := json.Marshal(b)
	_, err := s.pool.Exec(ctx, `INSERT INTO talk_briefs (tenant_id, user_id, brief, created_at) VALUES ($1, $2, $3::jsonb, now())
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET brief = EXCLUDED.brief, created_at = now()`, tenant, id, string(raw))
	return err
}

func (s *pgStore) talkDeleteBrief(ctx context.Context, tenant string, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM talk_briefs WHERE tenant_id = $1 AND user_id = $2`, tenant, id)
	return err
}

func (s *pgStore) talkRareTags(ctx context.Context, tenant string) ([][]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT coalesce(brief->'rare', '[]'::jsonb)::text FROM talk_briefs WHERE tenant_id = $1`, tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var tags []string
		json.Unmarshal(raw, &tags)
		out = append(out, tags)
	}
	return out, rows.Err()
}

func (s *pgStore) talkCreate(ctx context.Context, r *talkRecord) error {
	raw, _ := json.Marshal(r)
	tag, err := s.pool.Exec(ctx, `INSERT INTO talks (id, tenant_id, a_id, b_id, pair_key, config_version, state, fired, started_at, record)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) ON CONFLICT (tenant_id, pair_key) DO NOTHING`,
		r.ID, r.Tenant, r.A, r.B, r.pairKey(), r.ConfigVersion, r.State, r.Fired, r.Started, string(raw))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errTalkPair
	}
	return nil
}

func (s *pgStore) talkSave(ctx context.Context, r *talkRecord) error {
	raw, _ := json.Marshal(r)
	_, err := s.pool.Exec(ctx, `UPDATE talks SET state = $3, fired = $4, record = $5::jsonb, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
		r.ID, r.Tenant, r.State, r.Fired, string(raw))
	return err
}

func (s *pgStore) talkGet(ctx context.Context, tenant, id string) (*talkRecord, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT record::text FROM talks WHERE id = $1 AND tenant_id = $2`, id, tenant).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNoTalk
	}
	if err != nil {
		return nil, err
	}
	r := &talkRecord{}
	return r, json.Unmarshal(raw, r)
}

func (s *pgStore) talkCount(ctx context.Context, tenant string, id int64, since time.Time, firedOnly bool) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM talks WHERE tenant_id = $1 AND (a_id = $2 OR b_id = $2)
		AND started_at >= $3 AND (fired OR NOT $4)`, tenant, id, since, firedOnly).Scan(&n)
	return n, err
}

// ---------- memory (local dev, tests) ----------

type memTalkTables struct {
	prefs  map[string]talkPrefs
	briefs map[string]talkBrief
	talks  map[string]*talkRecord // "<tenant>/<id>"
	pairs  map[string]string      // "<tenant>/<pair key>" → talk id
}

// talkTables must be called with m.mu held.
func (m *memStore) talkTables() *memTalkTables {
	if m.talk == nil {
		m.talk = &memTalkTables{prefs: map[string]talkPrefs{}, briefs: map[string]talkBrief{}, talks: map[string]*talkRecord{}, pairs: map[string]string{}}
	}
	return m.talk
}

func (m *memStore) talkEnsureSchema(context.Context) error { return nil }

func (m *memStore) talkMemory(_ context.Context, tenant string, id int64) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mm, ok := m.memory[memKey(tenant, id)]
	if !ok {
		return nil, nil
	}
	return append([]byte(nil), mm.data...), nil
}

func (m *memStore) talkPrefs(_ context.Context, tenant string, id int64) (talkPrefs, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.talkTables().prefs[memKey(tenant, id)], nil
}

func (m *memStore) talkSavePrefs(_ context.Context, tenant string, id int64, p talkPrefs) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.members[memKey(tenant, id)] == nil {
		return errNoAccount
	}
	m.talkTables().prefs[memKey(tenant, id)] = p
	return nil
}

func (m *memStore) talkBrief(_ context.Context, tenant string, id int64) (*talkBrief, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.talkTables().briefs[memKey(tenant, id)]
	if !ok {
		return nil, nil
	}
	cp := b
	return &cp, nil
}

func (m *memStore) talkSaveBrief(_ context.Context, tenant string, id int64, b talkBrief) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.members[memKey(tenant, id)] == nil {
		return errNoAccount
	}
	m.talkTables().briefs[memKey(tenant, id)] = b
	return nil
}

func (m *memStore) talkDeleteBrief(_ context.Context, tenant string, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.talkTables().briefs, memKey(tenant, id))
	return nil
}

func (m *memStore) talkRareTags(_ context.Context, tenant string) ([][]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var keys []string
	for k := range m.talkTables().briefs {
		if len(k) > len(tenant) && k[:len(tenant)+1] == tenant+"/" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var out [][]string
	for _, k := range keys {
		out = append(out, append([]string(nil), m.talk.briefs[k].Rare...))
	}
	return out, nil
}

func (m *memStore) talkCreate(_ context.Context, r *talkRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.talkTables()
	if m.members[memKey(r.Tenant, r.A)] == nil || m.members[memKey(r.Tenant, r.B)] == nil {
		return errNoAccount
	}
	pk := r.Tenant + "/" + r.pairKey()
	if _, ok := t.pairs[pk]; ok {
		return errTalkPair
	}
	t.pairs[pk] = r.ID
	t.talks[r.Tenant+"/"+r.ID] = r.copy()
	return nil
}

func (m *memStore) talkSave(_ context.Context, r *talkRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.talkTables()
	if _, ok := t.talks[r.Tenant+"/"+r.ID]; !ok {
		return errNoTalk
	}
	t.talks[r.Tenant+"/"+r.ID] = r.copy()
	return nil
}

func (m *memStore) talkGet(_ context.Context, tenant, id string) (*talkRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.talkTables().talks[tenant+"/"+id]
	if !ok {
		return nil, errNoTalk
	}
	return r.copy(), nil
}

func (m *memStore) talkCount(_ context.Context, tenant string, id int64, since time.Time, firedOnly bool) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, r := range m.talkTables().talks {
		if r.Tenant == tenant && (r.A == id || r.B == id) && !r.Started.Before(since) && (r.Fired || !firedOnly) {
			n++
		}
	}
	return n, nil
}
