package main

// Accounts and saved progress. Multi-tenant: a Google identity is one account across
// every event, and everything about playing (your name, colour, bean, where you were)
// lives per tenant (an event such as hackgt13), so events never see each other's data.
//
// Production: Postgres on Cloud SQL, reached through the Cloud SQL Go connector with IAM
// database auth (the VM's own service account; no password anywhere). Without a
// database configured (local dev, tests) a memory store stands in.

import (
	"context"
	"errors"
	"fmt"
	"net"
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
	// SignIn creates or refreshes the account for a verified Google identity and makes
	// sure it belongs to tenant; created is true the first time we see this identity.
	SignIn(ctx context.Context, tenant string, g user) (a Account, created bool, err error)
	Account(ctx context.Context, tenant string, id int64) (Account, error)
	SaveProfile(ctx context.Context, tenant string, id int64, p Profile) error
	SaveProgress(ctx context.Context, tenant string, id int64, p Progress) error
	Close()
}

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
`

type pgStore struct {
	pool   *pgxpool.Pool
	dialer *cloudsqlconn.Dialer
}

// openPostgres connects to instance ("project:region:name") as the IAM user (a service
// account's email without ".gserviceaccount.com"), creates the tables if needed, and
// registers the tenant.
func openPostgres(ctx context.Context, instance, db, iamUser, tenant, tenantName string) (*pgStore, error) {
	d, err := cloudsqlconn.NewDialer(ctx, cloudsqlconn.WithIAMAuthN())
	if err != nil {
		return nil, fmt.Errorf("cloud sql dialer: %w", err)
	}
	cfg, err := pgxpool.ParseConfig(fmt.Sprintf("user=%s database=%s sslmode=disable", iamUser, db))
	if err != nil {
		d.Close()
		return nil, err
	}
	cfg.MaxConns = 8
	cfg.ConnConfig.DialFunc = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return d.Dial(ctx, instance)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		d.Close()
		return nil, err
	}
	s := &pgStore{pool: pool, dialer: d}
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
	s.dialer.Close()
}

func (s *pgStore) SignIn(ctx context.Context, tenant string, g user) (Account, bool, error) {
	var id int64
	var created bool
	err := s.pool.QueryRow(ctx, `
		INSERT INTO users (google_sub, email, name, given_name, picture) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
		  given_name = EXCLUDED.given_name, picture = EXCLUDED.picture, last_seen = now()
		RETURNING id, (xmax = 0)`, g.Sub, g.Email, g.Name, g.Given, g.Picture).Scan(&id, &created)
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

// ---------- memory (local dev, tests) ----------

type memMember struct {
	profile  Profile
	progress *Progress
}

type memStore struct {
	mu      sync.Mutex
	next    int64
	bySub   map[string]int64
	users   map[int64]user
	members map[string]*memMember // "<tenant>/<id>"
}

func newMemStore() *memStore {
	return &memStore{bySub: map[string]int64{}, users: map[int64]user{}, members: map[string]*memMember{}}
}

func memKey(tenant string, id int64) string { return fmt.Sprintf("%s/%d", tenant, id) }

func (m *memStore) Close() {}

func (m *memStore) SignIn(_ context.Context, tenant string, g user) (Account, bool, error) {
	m.mu.Lock()
	now := time.Now().UTC()
	id, ok := m.bySub[g.Sub]
	if !ok {
		m.next++
		id = m.next
		m.bySub[g.Sub] = id
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
