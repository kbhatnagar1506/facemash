package main

// The memory index's bookkeeping in facemash-db (fast track; see memfast.go):
//   - mapi_spaces: each person's private MAPI space, made on their first sync.
//   - mapi_items: what we last sent per key (its sha256 and MAPI memory id), so an unchanged
//     upload costs nothing and a changed section replaces exactly its old copy.
//   - mapi_purges: deletions still to carry out in MAPI. No foreign key, so the marker
//     outlives the membership, and a restart picks up where the erase left off.
// The DDL matches the full build's (mapistore.go on mapi-integration) column for column, so
// whichever deploys first, the other finds the tables it expects.

import (
	"context"
	"sort"
)

type fastRow struct {
	Key   string
	SHA   []byte
	MemID string
}

type fastStore interface {
	fastEnsureSchema(ctx context.Context) error
	// fastSpace: the person's space id ("" if none yet), and whether a purge is still pending.
	fastSpace(ctx context.Context, tenant string, id int64) (spaceID string, purging bool, err error)
	fastSetSpace(ctx context.Context, tenant string, id int64, spaceID string) error
	fastItems(ctx context.Context, tenant string, id int64) (map[string]fastRow, error)
	fastPutItems(ctx context.Context, tenant string, id int64, rows []fastRow) error
	fastDropItems(ctx context.Context, tenant string, id int64, keys []string) error
	// fastRequestPurge records that everything of this person's in MAPI must go.
	fastRequestPurge(ctx context.Context, tenant string, id int64) error
	// fastPurges: the open purge markers, and every space they (or mapi_spaces) name.
	fastPurges(ctx context.Context, tenant string, id int64) (marks []int64, spaces []string, err error)
	// fastClear forgets the person's space and items, and closes the given markers.
	fastClear(ctx context.Context, tenant string, id int64, marks []int64) error
	fastPurgeFailed(ctx context.Context, marks []int64, why string) error
	fastPendingPurges(ctx context.Context) ([]fastWho, error)
}

// ---------- Postgres ----------

const fastSchema = `
CREATE TABLE IF NOT EXISTS mapi_spaces (
  tenant_id  text   NOT NULL,
  user_id    bigint NOT NULL,
  space_id   text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mapi_items (
  tenant_id  text   NOT NULL,
  user_id    bigint NOT NULL,
  space_kind text   NOT NULL CHECK (space_kind IN ('private', 'directory')),
  key        text   NOT NULL,
  sha256     bytea  NOT NULL,
  memory_id  text,
  synced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, space_kind, key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mapi_purges (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    text   NOT NULL,
  user_id      bigint NOT NULL,
  scope        text   NOT NULL CHECK (scope IN ('private', 'directory', 'all')),
  space_id     text   NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  error        text
);
CREATE INDEX IF NOT EXISTS mapi_purges_due ON mapi_purges(next_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS mapi_purges_open ON mapi_purges(tenant_id, user_id) WHERE done_at IS NULL;
`

func (s *pgStore) fastEnsureSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, fastSchema)
	return err
}

func (s *pgStore) fastSpace(ctx context.Context, tenant string, id int64) (string, bool, error) {
	var sid string
	var purging bool
	err := s.pool.QueryRow(ctx, `SELECT coalesce((SELECT space_id FROM mapi_spaces WHERE tenant_id = $1 AND user_id = $2), ''),
		  EXISTS (SELECT 1 FROM mapi_purges WHERE tenant_id = $1 AND user_id = $2 AND done_at IS NULL)`, tenant, id).Scan(&sid, &purging)
	return sid, purging, err
}

func (s *pgStore) fastSetSpace(ctx context.Context, tenant string, id int64, spaceID string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO mapi_spaces (tenant_id, user_id, space_id) VALUES ($1, $2, $3)
		ON CONFLICT (tenant_id, user_id) DO UPDATE SET space_id = EXCLUDED.space_id, created_at = now()`, tenant, id, spaceID)
	return err
}

func (s *pgStore) fastItems(ctx context.Context, tenant string, id int64) (map[string]fastRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT key, sha256, coalesce(memory_id, '') FROM mapi_items
		WHERE tenant_id = $1 AND user_id = $2 AND space_kind = 'private'`, tenant, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]fastRow{}
	for rows.Next() {
		var r fastRow
		if err := rows.Scan(&r.Key, &r.SHA, &r.MemID); err != nil {
			return nil, err
		}
		out[r.Key] = r
	}
	return out, rows.Err()
}

func (s *pgStore) fastPutItems(ctx context.Context, tenant string, id int64, rows []fastRow) error {
	if len(rows) == 0 {
		return nil
	}
	keys, shas, mids := make([]string, len(rows)), make([][]byte, len(rows)), make([]string, len(rows))
	for i, r := range rows {
		keys[i], shas[i], mids[i] = r.Key, r.SHA, r.MemID
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO mapi_items (tenant_id, user_id, space_kind, key, sha256, memory_id)
		SELECT $1, $2, 'private', k, h, m FROM unnest($3::text[], $4::bytea[], $5::text[]) AS t(k, h, m)
		ON CONFLICT (tenant_id, user_id, space_kind, key) DO UPDATE SET sha256 = EXCLUDED.sha256, memory_id = EXCLUDED.memory_id, synced_at = now()`,
		tenant, id, keys, shas, mids)
	return err
}

func (s *pgStore) fastDropItems(ctx context.Context, tenant string, id int64, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM mapi_items WHERE tenant_id = $1 AND user_id = $2 AND space_kind = 'private' AND key = ANY($3)`, tenant, id, keys)
	return err
}

func (s *pgStore) fastRequestPurge(ctx context.Context, tenant string, id int64) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO mapi_purges (tenant_id, user_id, scope, space_id)
		VALUES ($1, $2, 'private', coalesce((SELECT space_id FROM mapi_spaces WHERE tenant_id = $1 AND user_id = $2), ''))`, tenant, id)
	return err
}

func (s *pgStore) fastPurges(ctx context.Context, tenant string, id int64) ([]int64, []string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, space_id FROM mapi_purges WHERE tenant_id = $1 AND user_id = $2 AND done_at IS NULL
		UNION ALL SELECT 0, space_id FROM mapi_spaces WHERE tenant_id = $1 AND user_id = $2`, tenant, id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var marks []int64
	var spaces []string
	for rows.Next() {
		var mid int64
		var sid string
		if err := rows.Scan(&mid, &sid); err != nil {
			return nil, nil, err
		}
		if mid != 0 {
			marks = append(marks, mid)
		}
		spaces = append(spaces, sid)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(marks) == 0 {
		return nil, nil, nil
	}
	return marks, fastUniqueSpaces(spaces), nil
}

func (s *pgStore) fastClear(ctx context.Context, tenant string, id int64, marks []int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, q := range []string{
		`DELETE FROM mapi_items WHERE tenant_id = $1 AND user_id = $2 AND space_kind = 'private'`,
		`DELETE FROM mapi_spaces WHERE tenant_id = $1 AND user_id = $2`,
	} {
		if _, err := tx.Exec(ctx, q, tenant, id); err != nil {
			return err
		}
	}
	if len(marks) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE mapi_purges SET done_at = now(), error = NULL WHERE id = ANY($1)`, marks); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *pgStore) fastPurgeFailed(ctx context.Context, marks []int64, why string) error {
	if len(why) > 300 {
		why = why[:300]
	}
	_, err := s.pool.Exec(ctx, `UPDATE mapi_purges SET attempts = attempts + 1, error = $2, next_at = now() WHERE id = ANY($1)`, marks, why)
	return err
}

func (s *pgStore) fastPendingPurges(ctx context.Context) ([]fastWho, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT tenant_id, user_id FROM mapi_purges WHERE done_at IS NULL ORDER BY 1, 2 LIMIT 5000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fastWho
	for rows.Next() {
		var w fastWho
		if err := rows.Scan(&w.tenant, &w.id); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// fastUniqueSpaces: the non-empty space ids, each once, in a stable order.
func fastUniqueSpaces(ids []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range ids {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// ---------- memory (local dev, tests) ----------

type memFastTables struct {
	spaces map[string]string             // "<tenant>/<id>" → space id
	items  map[string]map[string]fastRow // "<tenant>/<id>" → key → row
	purges []memFastPurge
	nextID int64
}

type memFastPurge struct {
	id      int64
	who     fastWho
	spaceID string
	done    bool
	tries   int
	why     string
}

// fastT is the memory store's copy of the mapi_* tables; call with m.mu held.
func (m *memStore) fastT() *memFastTables {
	if m.fast == nil {
		m.fast = &memFastTables{spaces: map[string]string{}, items: map[string]map[string]fastRow{}}
	}
	return m.fast
}

func (m *memStore) fastEnsureSchema(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.fastT()
	return nil
}

func (m *memStore) fastSpace(_ context.Context, tenant string, id int64) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.fastT()
	purging := false
	for _, p := range t.purges {
		if !p.done && p.who == (fastWho{tenant, id}) {
			purging = true
		}
	}
	return t.spaces[memKey(tenant, id)], purging, nil
}

func (m *memStore) fastSetSpace(_ context.Context, tenant string, id int64, spaceID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.members[memKey(tenant, id)] == nil {
		return errNoAccount // the foreign key on memberships
	}
	m.fastT().spaces[memKey(tenant, id)] = spaceID
	return nil
}

func (m *memStore) fastItems(_ context.Context, tenant string, id int64) (map[string]fastRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]fastRow{}
	for k, r := range m.fastT().items[memKey(tenant, id)] {
		out[k] = r
	}
	return out, nil
}

func (m *memStore) fastPutItems(_ context.Context, tenant string, id int64, rows []fastRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.members[memKey(tenant, id)] == nil {
		return errNoAccount
	}
	t := m.fastT()
	k := memKey(tenant, id)
	if t.items[k] == nil {
		t.items[k] = map[string]fastRow{}
	}
	for _, r := range rows {
		t.items[k][r.Key] = fastRow{r.Key, append([]byte(nil), r.SHA...), r.MemID}
	}
	return nil
}

func (m *memStore) fastDropItems(_ context.Context, tenant string, id int64, keys []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, key := range keys {
		delete(m.fastT().items[memKey(tenant, id)], key)
	}
	return nil
}

func (m *memStore) fastRequestPurge(_ context.Context, tenant string, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.fastT()
	t.nextID++
	t.purges = append(t.purges, memFastPurge{id: t.nextID, who: fastWho{tenant, id}, spaceID: t.spaces[memKey(tenant, id)]})
	return nil
}

func (m *memStore) fastPurges(_ context.Context, tenant string, id int64) ([]int64, []string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.fastT()
	var marks []int64
	spaces := []string{t.spaces[memKey(tenant, id)]}
	for _, p := range t.purges {
		if !p.done && p.who == (fastWho{tenant, id}) {
			marks = append(marks, p.id)
			spaces = append(spaces, p.spaceID)
		}
	}
	if len(marks) == 0 {
		return nil, nil, nil
	}
	return marks, fastUniqueSpaces(spaces), nil
}

func (m *memStore) fastClear(_ context.Context, tenant string, id int64, marks []int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.fastT()
	delete(t.items, memKey(tenant, id))
	delete(t.spaces, memKey(tenant, id))
	for i := range t.purges {
		for _, mk := range marks {
			if t.purges[i].id == mk {
				t.purges[i].done = true
			}
		}
	}
	return nil
}

func (m *memStore) fastPurgeFailed(_ context.Context, marks []int64, why string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := m.fastT()
	for i := range t.purges {
		for _, mk := range marks {
			if t.purges[i].id == mk {
				t.purges[i].tries++
				t.purges[i].why = why
			}
		}
	}
	return nil
}

func (m *memStore) fastPendingPurges(context.Context) ([]fastWho, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[fastWho]bool{}
	var out []fastWho
	for _, p := range m.fastT().purges {
		if !p.done && !seen[p.who] {
			seen[p.who] = true
			out = append(out, p.who)
		}
	}
	return out, nil
}
