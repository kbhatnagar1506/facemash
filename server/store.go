package main

// Accounts and saved progress. Multi-tenant: an email address (case-insensitive; Google
// sign-in only accepts verified ones) is one account across every event, and everything about playing (your name, colour, bean, where you were)
// lives per tenant (an event such as hackgt13), so events never see each other's data.
//
// Production: Postgres on Cloud SQL, reached through the Cloud SQL Go connector with IAM
// database auth (the VM's own service account; no password anywhere). Without a
// database configured (local dev, tests) a memory store stands in.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/cloudsqlconn"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var errNoAccount = errors.New("no such account")

type Profile struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	Look  string `json:"look"`
}

type Progress struct {
	Room string    `json:"room"`
	X    float64   `json:"x"`
	Z    float64   `json:"z"`
	Y    float64   `json:"y"`
	R    float64   `json:"r"`
	At   time.Time `json:"at"`
}

type Account struct {
	ID       int64
	User     user
	Profile  Profile
	Progress *Progress
}

type Store interface {
	// SignIn creates or refreshes the account for a verified email address (the unique key,
	// case-insensitive) and makes sure it belongs to tenant; created is true the first time
	// we see this email.
	SignIn(ctx context.Context, tenant string, g user) (a Account, created bool, err error)
	Account(ctx context.Context, tenant string, id int64) (Account, error)
	SaveProfile(ctx context.Context, tenant string, id int64, p Profile) error
	SaveProgress(ctx context.Context, tenant string, id int64, p Progress) error
	// API tokens (e.g. for someone's Muse): only a hash is stored. Creating one replaces
	// any earlier token with the same label; TokenOwner also records the use.
	CreateToken(ctx context.Context, tenant string, id int64, label string, hash []byte) error
	TokenOwner(ctx context.Context, hash []byte) (tenant string, id int64, err error)
	RevokeTokens(ctx context.Context, tenant string, id int64, label string) error
	// TokenStatus: is there a live token with this label, and when was it made and last used
	TokenStatus(ctx context.Context, tenant string, id int64, label string) (map[string]any, error)
	// What someone's own agent remembers about them (sent by the agent, by their choice):
	// the latest copy per person per tenant, as JSON. MemoryInfo never returns the content.
	SaveMemory(ctx context.Context, tenant string, id int64, data []byte, exportedAt *time.Time) error
	MemoryInfo(ctx context.Context, tenant string, id int64) (map[string]any, error)
	DeleteMemory(ctx context.Context, tenant string, id int64) error
	Close()
}

var errBadToken = errors.New("unknown or revoked token")

// ---------- Postgres ----------

const schema = `
CREATE TABLE IF NOT EXISTS tenants (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  google_sub text NOT NULL UNIQUE,
  email      text NOT NULL,
  name       text NOT NULL DEFAULT '',
  given_name text NOT NULL DEFAULT '',
  picture    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id    text   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text   NOT NULL DEFAULT '',
  color        text   NOT NULL DEFAULT '',
  look         text   NOT NULL DEFAULT '',
  joined_at    timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS progress (
  tenant_id  text   NOT NULL,
  user_id    bigint NOT NULL,
  room       text   NOT NULL,
  x          double precision NOT NULL,
  z          double precision NOT NULL,
  y          double precision NOT NULL DEFAULT 0,
  r          double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);
-- the email is the account's key; the Google subject is kept for reference only
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_google_sub_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_google_sub ON users (google_sub);
CREATE TABLE IF NOT EXISTS api_tokens (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  text   NOT NULL,
  user_id    bigint NOT NULL,
  label      text   NOT NULL,
  token_hash bytea  NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used  timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS api_tokens_owner ON api_tokens(tenant_id, user_id);
CREATE TABLE IF NOT EXISTS agent_memory (
  tenant_id   text   NOT NULL,
  user_id     bigint NOT NULL,
  data        jsonb  NOT NULL,
  bytes       integer NOT NULL,
  exported_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
`

type pgStore struct {
	pool   *pgxpool.Pool
	dialer *cloudsqlconn.Dialer // nil for a direct connection
}

// dbTarget says how to reach Postgres: through the Cloud SQL connector as an IAM user
// (Instance + IAMUser: a service account's email without ".gserviceaccount.com"), or
// directly (Host + User + Password, TLS required).
type dbTarget struct {
	Instance, IAMUser        string
	Host, User, Password, DB string
}

// openPostgres connects, creates the tables if needed, and registers the tenant.
func openPostgres(ctx context.Context, t dbTarget, tenant, tenantName string) (*pgStore, error) {
	s := &pgStore{}
	var cfg *pgxpool.Config
	var err error
	if t.Host != "" {
		cfg, err = pgxpool.ParseConfig(fmt.Sprintf("host=%s user=%s database=%s sslmode=require connect_timeout=10", t.Host, t.User, t.DB))
		if err != nil {
			return nil, err
		}
		cfg.ConnConfig.Password = t.Password
	} else {
		d, err := cloudsqlconn.NewDialer(ctx, cloudsqlconn.WithIAMAuthN())
		if err != nil {
			return nil, fmt.Errorf("cloud sql dialer: %w", err)
		}
		s.dialer = d
		cfg, err = pgxpool.ParseConfig(fmt.Sprintf("user=%s database=%s sslmode=disable", t.IAMUser, t.DB))
		if err != nil {
			d.Close()
			return nil, err
		}
		cfg.ConnConfig.DialFunc = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return d.Dial(ctx, t.Instance)
		}
	}
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		if s.dialer != nil {
			s.dialer.Close()
		}
		return nil, err
	}
	s.pool = pool
	if _, err := pool.Exec(ctx, schema); err != nil {
		s.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, tenant, tenantName); err != nil {
		s.Close()
		return nil, fmt.Errorf("tenant: %w", err)
	}
	return s, nil
}

func (s *pgStore) Close() {
	s.pool.Close()
	if s.dialer != nil {
		s.dialer.Close()
	}
}

func (s *pgStore) SignIn(ctx context.Context, tenant string, g user) (Account, bool, error) {
	var id int64
	var created bool
	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (google_sub, email, name, given_name, picture) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT ((lower(email))) DO UPDATE SET google_sub = EXCLUDED.google_sub, name = EXCLUDED.name,
		  given_name = EXCLUDED.given_name, picture = EXCLUDED.picture, last_seen = now()
		RETURNING id, (xmax = 0)`, g.Sub, strings.TrimSpace(g.Email), g.Name, g.Given, g.Picture).Scan(&id, &created)
	if err != nil {
		return Account{}, false, err
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, tenant, id); err != nil {
		return Account{}, false, err
	}
	a, err := s.Account(ctx, tenant, id)
	return a, created, err
}

func (s *pgStore) Account(ctx context.Context, tenant string, id int64) (Account, error) {
	a := Account{ID: id}
	var room *string
	var x, z, y, r *float64
	var at *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT u.google_sub, u.email, u.name, u.given_name, u.picture, u.created_at, u.last_seen,
		       m.display_name, m.color, m.look, p.room, p.x, p.z, p.y, p.r, p.updated_at
		FROM users u
		JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
		LEFT JOIN progress p ON p.user_id = u.id AND p.tenant_id = $1
		WHERE u.id = $2`, tenant, id).Scan(
		&a.User.Sub, &a.User.Email, &a.User.Name, &a.User.Given, &a.User.Picture, &a.User.Created, &a.User.Seen,
		&a.Profile.Name, &a.Profile.Color, &a.Profile.Look, &room, &x, &z, &y, &r, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, errNoAccount
	}
	if err != nil {
		return Account{}, err
	}
	if room != nil {
		a.Progress = &Progress{Room: *room, X: *x, Z: *z, Y: *y, R: *r, At: *at}
	}
	return a, nil
}

func (s *pgStore) SaveProfile(ctx context.Context, tenant string, id int64, p Profile) error {
	_, err := s.pool.Exec(ctx, `UPDATE memberships SET display_name = $3, color = $4, look = $5, updated_at = now()
		WHERE tenant_id = $1 AND user_id = $2`, tenant, id, p.Name, p.Color, p.Look)
	return err
}

func (s *pgStore) SaveProgress(ctx context.Context, tenant string, id int64, p Progress) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO progress (tenant_id, user_id, room, x, z, y, r, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET room = EXCLUDED.room, x = EXCLUDED.x, z = EXCLUDED.z,
		  y = EXCLUDED.y, r = EXCLUDED.r, updated_at = now()`, tenant, id, p.Room, p.X, p.Z, p.Y, p.R)
	return err
}

func (s *pgStore) CreateToken(ctx context.Context, tenant string, id int64, label string, hash []byte) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND label = $3 AND revoked_at IS NULL`, tenant, id, label); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO api_tokens (tenant_id, user_id, label, token_hash) VALUES ($1, $2, $3, $4)`, tenant, id, label, hash); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *pgStore) TokenOwner(ctx context.Context, hash []byte) (string, int64, error) {
	var tenant string
	var id int64
	err := s.pool.QueryRow(ctx, `UPDATE api_tokens SET last_used = now() WHERE token_hash = $1 AND revoked_at IS NULL
		RETURNING tenant_id, user_id`, hash).Scan(&tenant, &id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, errBadToken
	}
	return tenant, id, err
}

func (s *pgStore) RevokeTokens(ctx context.Context, tenant string, id int64, label string) error {
	_, err := s.pool.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND label = $3 AND revoked_at IS NULL`, tenant, id, label)
	return err
}

func (s *pgStore) SaveMemory(ctx context.Context, tenant string, id int64, data []byte, exportedAt *time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO agent_memory (tenant_id, user_id, data, bytes, exported_at, received_at) VALUES ($1, $2, $3::jsonb, $4, $5, now())
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET data = EXCLUDED.data, bytes = EXCLUDED.bytes,
		  exported_at = EXCLUDED.exported_at, received_at = now()`, tenant, id, string(data), len(data), exportedAt)
	return err
}

func (s *pgStore) MemoryInfo(ctx context.Context, tenant string, id int64) (map[string]any, error) {
	var bytes int
	var exported *time.Time
	var received time.Time
	var keys []string
	err := s.pool.QueryRow(ctx, `SELECT bytes, exported_at, received_at,
		  ARRAY(SELECT jsonb_object_keys(data) ORDER BY 1)
		FROM agent_memory WHERE tenant_id = $1 AND user_id = $2`, tenant, id).Scan(&bytes, &exported, &received, &keys)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]any{"stored": false}, nil
	}
	if err != nil {
		return nil, err
	}
	return memoryInfo(bytes, exported, received, keys), nil
}

func (s *pgStore) DeleteMemory(ctx context.Context, tenant string, id int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM agent_memory WHERE tenant_id = $1 AND user_id = $2`, tenant, id)
	return err
}

func memoryInfo(bytes int, exported *time.Time, received time.Time, keys []string) map[string]any {
	out := map[string]any{"stored": true, "kb": float64(bytes*10/1024) / 10, "received_at": received.UTC().Format(time.RFC3339), "sections": keys, "exported_at": nil}
	if exported != nil {
		out["exported_at"] = exported.UTC().Format(time.RFC3339)
	}
	return out
}

func (s *pgStore) TokenStatus(ctx context.Context, tenant string, id int64, label string) (map[string]any, error) {
	var created time.Time
	var used *time.Time
	err := s.pool.QueryRow(ctx, `SELECT created_at, last_used FROM api_tokens
		WHERE tenant_id = $1 AND user_id = $2 AND label = $3 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, tenant, id, label).Scan(&created, &used)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]any{"connected": false}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]any{"connected": true, "since": created.UTC().Format(time.RFC3339), "last_used": nil}
	if used != nil {
		out["last_used"] = used.UTC().Format(time.RFC3339)
	}
	return out, nil
}

// ---------- memory (local dev, tests) ----------

type memMember struct {
	profile  Profile
	progress *Progress
}

type memStore struct {
	mu      sync.Mutex
	next    int64
	byEmail map[string]int64 // lower(email) → id
	users   map[int64]user
	members map[string]*memMember // "<tenant>/<id>"
	tokens  map[string]memToken   // hash → owner
	memory  map[string]memMemory  // "<tenant>/<id>"
	fast    *memFastTables        // the mapi_* tables (memfast_store.go), made on first use
}

type memMemory struct {
	data     []byte
	exported *time.Time
	received time.Time
}

type memToken struct {
	tenant, label string
	id            int64
	created       time.Time
	used          *time.Time
}

func newMemStore() *memStore {
	return &memStore{byEmail: map[string]int64{}, users: map[int64]user{}, members: map[string]*memMember{}, tokens: map[string]memToken{}, memory: map[string]memMemory{}}
}

func memKey(tenant string, id int64) string { return fmt.Sprintf("%s/%d", tenant, id) }

func (m *memStore) Close() {}

func (m *memStore) SignIn(_ context.Context, tenant string, g user) (Account, bool, error) {
	m.mu.Lock()
	now := time.Now().UTC()
	key := strings.ToLower(strings.TrimSpace(g.Email))
	id, ok := m.byEmail[key]
	if !ok {
		m.next++
		id = m.next
		m.byEmail[key] = id
		g.Created = now
	} else {
		g.Created = m.users[id].Created
	}
	g.Seen = now
	m.users[id] = g
	if m.members[memKey(tenant, id)] == nil {
		m.members[memKey(tenant, id)] = &memMember{}
	}
	m.mu.Unlock()
	a, err := m.Account(context.Background(), tenant, id)
	return a, !ok, err
}

func (m *memStore) Account(_ context.Context, tenant string, id int64) (Account, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mm := m.members[memKey(tenant, id)]
	if mm == nil {
		return Account{}, errNoAccount
	}
	a := Account{ID: id, User: m.users[id], Profile: mm.profile}
	if mm.progress != nil {
		p := *mm.progress
		a.Progress = &p
	}
	return a, nil
}

func (m *memStore) SaveProfile(_ context.Context, tenant string, id int64, p Profile) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if mm := m.members[memKey(tenant, id)]; mm != nil {
		mm.profile = p
		return nil
	}
	return errNoAccount
}

func (m *memStore) SaveProgress(_ context.Context, tenant string, id int64, p Progress) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if mm := m.members[memKey(tenant, id)]; mm != nil {
		p.At = time.Now().UTC()
		mm.progress = &p
		return nil
	}
	return errNoAccount
}

func (m *memStore) CreateToken(_ context.Context, tenant string, id int64, label string, hash []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.members[memKey(tenant, id)] == nil {
		return errNoAccount
	}
	for h, t := range m.tokens {
		if t.tenant == tenant && t.id == id && t.label == label {
			delete(m.tokens, h)
		}
	}
	m.tokens[string(hash)] = memToken{tenant: tenant, id: id, label: label, created: time.Now().UTC()}
	return nil
}

func (m *memStore) TokenOwner(_ context.Context, hash []byte) (string, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tokens[string(hash)]
	if !ok {
		return "", 0, errBadToken
	}
	now := time.Now().UTC()
	t.used = &now
	m.tokens[string(hash)] = t
	return t.tenant, t.id, nil
}

func (m *memStore) RevokeTokens(_ context.Context, tenant string, id int64, label string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for h, t := range m.tokens {
		if t.tenant == tenant && t.id == id && t.label == label {
			delete(m.tokens, h)
		}
	}
	return nil
}

func (m *memStore) TokenStatus(_ context.Context, tenant string, id int64, label string) (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tokens {
		if t.tenant == tenant && t.id == id && t.label == label {
			out := map[string]any{"connected": true, "since": t.created.Format(time.RFC3339), "last_used": nil}
			if t.used != nil {
				out["last_used"] = t.used.Format(time.RFC3339)
			}
			return out, nil
		}
	}
	return map[string]any{"connected": false}, nil
}

func (m *memStore) SaveMemory(_ context.Context, tenant string, id int64, data []byte, exportedAt *time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.members[memKey(tenant, id)] == nil {
		return errNoAccount
	}
	m.memory[memKey(tenant, id)] = memMemory{append([]byte(nil), data...), exportedAt, time.Now().UTC()}
	return nil
}

func (m *memStore) MemoryInfo(_ context.Context, tenant string, id int64) (map[string]any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mm, ok := m.memory[memKey(tenant, id)]
	if !ok {
		return map[string]any{"stored": false}, nil
	}
	var obj map[string]json.RawMessage
	json.Unmarshal(mm.data, &obj)
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return memoryInfo(len(mm.data), mm.exported, mm.received, keys), nil
}

func (m *memStore) DeleteMemory(_ context.Context, tenant string, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.memory, memKey(tenant, id))
	return nil
}
