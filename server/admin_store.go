package main

// Read-side queries for the organizer admin API (admin.go), plus the test-account purge.
// Postgres and memory with the same behaviour. Nothing here changes how the game or agent
// talk store their data; it only reads it (and, for -purge-test-accounts, deletes accounts
// whose email ends in @facemash.test and nothing else).

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const testEmailSuffix = "@facemash.test"

// isTestEmail: the only accounts the purge (and the admin views' default filter) treats as test.
func isTestEmail(email string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(email)), testEmailSuffix)
}

// adminPersonRow: what the admin views may show about one attendee (no email leaves here).
type adminPersonRow struct {
	first string
	look  string
	test  bool
	muse  bool // an agent's memory upload, or a live Muse token
	voice bool // a memory from the voice guide (and no Muse)
}

type adminCountRow struct {
	users, signedInToday, memories, museConnected, voice int
}

type adminTalkStatRow struct {
	total, live, today, matches, approvalsBoth, reveals, worthYes, worthNo, withheldLines int
}

type adminTalkQuery struct {
	states      string // which stored states: all, open (live, awaiting), open_error (and error)
	match       *bool
	includeTest bool
	limit       int
	// cursor: strictly older than (before, beforeID) in (started, id) order
	before   *time.Time
	beforeID string
}

type adminTalkRow struct {
	rec     *talkRecord
	started time.Time // as stored (the cursor's key)
}

type adminPurgeReport struct {
	IDs          []int64 `json:"ids"`
	Accounts     int     `json:"accounts"`
	Memberships  int     `json:"memberships"`
	Talks        int     `json:"talks"`
	Memories     int     `json:"memories"`
	Tokens       int     `json:"tokens"`
	PurgesQueued int     `json:"mapi_purges_queued"`
	DryRun       bool    `json:"dry_run"`
}

type adminStore interface {
	adminPeople(ctx context.Context, tenant string, ids []int64) (map[int64]adminPersonRow, error)
	adminCounts(ctx context.Context, tenant string, day time.Time, includeTest bool) (adminCountRow, error)
	adminTalkStats(ctx context.Context, tenant string, day time.Time, includeTest bool) (adminTalkStatRow, error)
	adminTalks(ctx context.Context, tenant string, q adminTalkQuery) ([]adminTalkRow, error)
	// adminTalksChanged: talks saved since (memory: all of them; the caller diffs).
	adminTalksChanged(ctx context.Context, tenant string, since time.Time) ([]*talkRecord, error)
	purgeTestAccounts(ctx context.Context, dryRun bool) (adminPurgeReport, error)
}

// adminFirstName: a first name only, never anything that looks like an address.
func adminFirstName(given, name, display string) string {
	for _, s := range []string{given, name, display} {
		f := strings.Fields(s)
		if len(f) == 0 || strings.Contains(f[0], "@") {
			continue
		}
		if r := []rune(f[0]); len(r) > 24 {
			return string(r[:24])
		}
		return f[0]
	}
	return ""
}

func talkMatched(state string) bool {
	switch state {
	case "awaiting", "revealed", "skipped", "expired":
		return true
	}
	return false
}

func talkLineWithheld(l talkLine) bool { return l.Dropped > 0 }

// ---------- Postgres ----------

const pgTestUser = `lower(btrim(%s)) LIKE '%%@facemash.test'`

func pgIsTest(col string) string { return fmt.Sprintf(pgTestUser, col) }

func (s *pgStore) adminPeople(ctx context.Context, tenant string, ids []int64) (map[int64]adminPersonRow, error) {
	out := map[int64]adminPersonRow{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT u.id, u.email, u.name, u.given_name, m.display_name, m.look,
		  EXISTS (SELECT 1 FROM agent_memory a WHERE a.tenant_id = m.tenant_id AND a.user_id = u.id AND a.data->>'source' = 'voice'),
		  EXISTS (SELECT 1 FROM agent_memory a WHERE a.tenant_id = m.tenant_id AND a.user_id = u.id AND a.data->>'source' IS DISTINCT FROM 'voice')
		  OR EXISTS (SELECT 1 FROM api_tokens t WHERE t.tenant_id = m.tenant_id AND t.user_id = u.id AND t.label = $3 AND t.revoked_at IS NULL)
		FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
		WHERE u.id = ANY($2)`, tenant, ids, museLabel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var email, name, given, display, look string
		var voice, muse bool
		if err := rows.Scan(&id, &email, &name, &given, &display, &look, &voice, &muse); err != nil {
			return nil, err
		}
		out[id] = adminPersonRow{first: adminFirstName(given, name, display), look: look, test: isTestEmail(email), muse: muse, voice: voice && !muse}
	}
	return out, rows.Err()
}

func (s *pgStore) adminCounts(ctx context.Context, tenant string, day time.Time, includeTest bool) (adminCountRow, error) {
	var c adminCountRow
	notTest := "($3 OR NOT " + pgIsTest("u.email") + ")"
	err := s.pool.QueryRow(ctx, `SELECT
		  (SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND `+notTest+`),
		  (SELECT count(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.last_seen >= $2 AND `+notTest+`),
		  (SELECT count(*) FROM agent_memory a JOIN users u ON u.id = a.user_id WHERE a.tenant_id = $1 AND `+notTest+`),
		  (SELECT count(DISTINCT t.user_id) FROM api_tokens t JOIN users u ON u.id = t.user_id
		     WHERE t.tenant_id = $1 AND t.label = $4 AND t.revoked_at IS NULL AND `+notTest+`),
		  (SELECT count(*) FROM agent_memory a JOIN users u ON u.id = a.user_id WHERE a.tenant_id = $1 AND a.data->>'source' = 'voice' AND `+notTest+`)`,
		tenant, day, includeTest, museLabel).Scan(&c.users, &c.signedInToday, &c.memories, &c.museConnected, &c.voice)
	return c, err
}

// pgTalkNotTest: the talk (alias t) has no test account in it, unless $3 (include_test).
func pgTalkNotTest(t string) string {
	return "($3 OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id IN (" + t + ".a_id, " + t + ".b_id) AND " + pgIsTest("u.email") + "))"
}

func (s *pgStore) adminTalkStats(ctx context.Context, tenant string, day time.Time, includeTest bool) (adminTalkStatRow, error) {
	var r adminTalkStatRow
	err := s.pool.QueryRow(ctx, `SELECT count(*),
		  count(*) FILTER (WHERE state IN ('live', 'awaiting')),
		  count(*) FILTER (WHERE started_at >= $2),
		  count(*) FILTER (WHERE state IN ('awaiting', 'revealed', 'skipped', 'expired')),
		  count(*) FILTER (WHERE record->'approvals'->>'a' = 'approve' AND record->'approvals'->>'b' = 'approve'),
		  count(*) FILTER (WHERE state = 'revealed'),
		  count(*) FILTER (WHERE record->'feedback'->>'a' = 'true') + count(*) FILTER (WHERE record->'feedback'->>'b' = 'true'),
		  count(*) FILTER (WHERE record->'feedback'->>'a' = 'false') + count(*) FILTER (WHERE record->'feedback'->>'b' = 'false'),
		  (SELECT count(*) FROM talks t2 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t2.record->'transcript') = 'array' THEN t2.record->'transcript' ELSE '[]'::jsonb END) l
		     WHERE t2.tenant_id = $1 AND `+pgTalkNotTest("t2")+` AND coalesce((l->>'dropped')::int, 0) > 0)
		FROM talks t WHERE tenant_id = $1 AND `+pgTalkNotTest("t"), tenant, day, includeTest).
		Scan(&r.total, &r.live, &r.today, &r.matches, &r.approvalsBoth, &r.reveals, &r.worthYes, &r.worthNo, &r.withheldLines)
	return r, err
}

func (s *pgStore) adminTalks(ctx context.Context, tenant string, q adminTalkQuery) ([]adminTalkRow, error) {
	var match any
	if q.match != nil {
		match = *q.match
	}
	var before any
	if q.before != nil {
		before = *q.before
	}
	rows, err := s.pool.Query(ctx, `SELECT record::text, started_at FROM talks t WHERE tenant_id = $1
		  AND ($2 = 'all' OR ($2 = 'open' AND state IN ('live', 'awaiting')) OR ($2 = 'open_error' AND state IN ('live', 'awaiting', 'error')))
		  AND `+pgTalkNotTest("t")+`
		  AND ($4::boolean IS NULL OR ($4 AND state IN ('awaiting', 'revealed', 'skipped', 'expired')) OR (NOT $4 AND state = 'no_match'))
		  AND ($5::timestamptz IS NULL OR (started_at, id) < ($5, $6))
		ORDER BY started_at DESC, id DESC LIMIT $7`,
		tenant, q.states, q.includeTest, match, before, q.beforeID, q.limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []adminTalkRow
	for rows.Next() {
		var raw []byte
		var started time.Time
		if err := rows.Scan(&raw, &started); err != nil {
			return nil, err
		}
		rec := &talkRecord{}
		if err := json.Unmarshal(raw, rec); err != nil {
			return nil, err
		}
		out = append(out, adminTalkRow{rec: rec, started: started})
	}
	return out, rows.Err()
}

func (s *pgStore) adminTalksChanged(ctx context.Context, tenant string, since time.Time) ([]*talkRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT record::text FROM talks WHERE tenant_id = $1 AND updated_at > $2 ORDER BY updated_at LIMIT 500`, tenant, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*talkRecord
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		rec := &talkRecord{}
		if json.Unmarshal(raw, rec) == nil {
			out = append(out, rec)
		}
	}
	return out, rows.Err()
}

func (s *pgStore) pgHas(ctx context.Context, q pgx.Tx, table string) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, table).Scan(&ok)
	return ok, err
}

// purgeTestAccounts deletes every account whose email ends in @facemash.test (all their
// memberships, in every tenant, go with them by cascade: progress, tokens, memory, talk prefs,
// briefs and talks, the mapi_* rows), after queueing a MAPI purge per membership in
// mapi_purges (the running server's memfast sweep carries it out). One transaction; the
// email is checked in Go and again in the DELETE.
func (s *pgStore) purgeTestAccounts(ctx context.Context, dryRun bool) (adminPurgeReport, error) {
	rep := adminPurgeReport{DryRun: dryRun}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return rep, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id, email FROM users WHERE `+pgIsTest("email")+` ORDER BY id FOR UPDATE`)
	if err != nil {
		return rep, err
	}
	for rows.Next() {
		var id int64
		var email string
		if err := rows.Scan(&id, &email); err != nil {
			rows.Close()
			return rep, err
		}
		if isTestEmail(email) {
			rep.IDs = append(rep.IDs, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return rep, err
	}
	rep.Accounts = len(rep.IDs)
	if rep.Accounts == 0 {
		return rep, nil
	}
	ids := rep.IDs
	count := func(q string, dst *int) error { return tx.QueryRow(ctx, q, ids).Scan(dst) }
	if err := count(`SELECT count(*) FROM memberships WHERE user_id = ANY($1)`, &rep.Memberships); err != nil {
		return rep, err
	}
	if err := count(`SELECT count(*) FROM agent_memory WHERE user_id = ANY($1)`, &rep.Memories); err != nil {
		return rep, err
	}
	if err := count(`SELECT count(*) FROM api_tokens WHERE user_id = ANY($1)`, &rep.Tokens); err != nil {
		return rep, err
	}
	hasTalks, err := s.pgHas(ctx, tx, "talks")
	if err != nil {
		return rep, err
	}
	if hasTalks {
		if err := count(`SELECT count(*) FROM talks WHERE a_id = ANY($1) OR b_id = ANY($1)`, &rep.Talks); err != nil {
			return rep, err
		}
	}
	hasPurges, err := s.pgHas(ctx, tx, "mapi_purges")
	if err != nil {
		return rep, err
	}
	hasSpaces, err := s.pgHas(ctx, tx, "mapi_spaces")
	if err != nil {
		return rep, err
	}
	if hasPurges {
		rep.PurgesQueued = rep.Memberships
	}
	if dryRun {
		return rep, nil
	}
	if hasPurges {
		space := `''`
		if hasSpaces {
			space = `coalesce((SELECT s.space_id FROM mapi_spaces s WHERE s.tenant_id = m.tenant_id AND s.user_id = m.user_id), '')`
		}
		// the same marker memfast's own "delete my memory" writes (fastRequestPurge)
		if _, err := tx.Exec(ctx, `INSERT INTO mapi_purges (tenant_id, user_id, scope, space_id)
			SELECT m.tenant_id, m.user_id, 'private', `+space+` FROM memberships m WHERE m.user_id = ANY($1)`, ids); err != nil {
			return rep, err
		}
	}
	if hasTalks {
		if _, err := tx.Exec(ctx, `DELETE FROM talks WHERE a_id = ANY($1) OR b_id = ANY($1)`, ids); err != nil {
			return rep, err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM users WHERE id = ANY($1) AND `+pgIsTest("email"), ids)
	if err != nil {
		return rep, err
	}
	if int(tag.RowsAffected()) != rep.Accounts {
		return rep, fmt.Errorf("purge: expected %d accounts, deleting %d; rolled back", rep.Accounts, tag.RowsAffected())
	}
	return rep, tx.Commit(ctx)
}

// ---------- memory ----------

// memKeyID splits a "<tenant>/<id>" key.
func memKeyID(k string) (string, int64, bool) {
	i := strings.LastIndexByte(k, '/')
	if i < 0 {
		return "", 0, false
	}
	id, err := strconv.ParseInt(k[i+1:], 10, 64)
	return k[:i], id, err == nil
}

// memIsVoice: a memory the voice guide made (its "source", voice.go memoryFrom).
func memIsVoice(data []byte) bool {
	var v struct {
		Source string `json:"source"`
	}
	return json.Unmarshal(data, &v) == nil && v.Source == "voice"
}

func (m *memStore) isTestID(id int64) bool { return isTestEmail(m.users[id].Email) }

func (m *memStore) adminPeople(_ context.Context, tenant string, ids []int64) (map[int64]adminPersonRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[int64]adminPersonRow{}
	for _, id := range ids {
		mm := m.members[memKey(tenant, id)]
		if mm == nil {
			continue
		}
		u := m.users[id]
		mem, has := m.memory[memKey(tenant, id)]
		voice := has && memIsVoice(mem.data)
		muse := has && !voice
		for _, t := range m.tokens {
			if t.tenant == tenant && t.id == id && t.label == museLabel {
				muse = true
			}
		}
		out[id] = adminPersonRow{first: adminFirstName(u.Given, u.Name, mm.profile.Name), look: mm.profile.Look, test: isTestEmail(u.Email), muse: muse, voice: voice && !muse}
	}
	return out, nil
}

func (m *memStore) adminCounts(_ context.Context, tenant string, day time.Time, includeTest bool) (adminCountRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var c adminCountRow
	for k := range m.members {
		t, id, ok := memKeyID(k)
		if !ok || t != tenant || (!includeTest && m.isTestID(id)) {
			continue
		}
		c.users++
		if !m.users[id].Seen.Before(day) {
			c.signedInToday++
		}
		if mem, ok := m.memory[k]; ok {
			c.memories++
			if memIsVoice(mem.data) {
				c.voice++
			}
		}
	}
	muse := map[int64]bool{}
	for _, t := range m.tokens {
		if t.tenant == tenant && t.label == museLabel && (includeTest || !m.isTestID(t.id)) {
			muse[t.id] = true
		}
	}
	c.museConnected = len(muse)
	return c, nil
}

func (m *memStore) adminTalkStats(_ context.Context, tenant string, day time.Time, includeTest bool) (adminTalkStatRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var r adminTalkStatRow
	for _, rec := range m.talkTables().talks {
		if rec.Tenant != tenant || (!includeTest && (m.isTestID(rec.A) || m.isTestID(rec.B))) {
			continue
		}
		r.total++
		if rec.State == "live" || rec.State == "awaiting" {
			r.live++
		}
		if !rec.Started.Before(day) {
			r.today++
		}
		if talkMatched(rec.State) {
			r.matches++
		}
		if rec.Approvals["a"] == "approve" && rec.Approvals["b"] == "approve" {
			r.approvalsBoth++
		}
		if rec.State == "revealed" {
			r.reveals++
		}
		for _, side := range []string{"a", "b"} {
			if v, ok := rec.Feedback[side]; ok {
				if v {
					r.worthYes++
				} else {
					r.worthNo++
				}
			}
		}
		for _, l := range rec.Transcript {
			if talkLineWithheld(l) {
				r.withheldLines++
			}
		}
	}
	return r, nil
}

func (m *memStore) adminTalks(_ context.Context, tenant string, q adminTalkQuery) ([]adminTalkRow, error) {
	m.mu.Lock()
	var all []*talkRecord
	for _, rec := range m.talkTables().talks {
		if rec.Tenant != tenant || (!q.includeTest && (m.isTestID(rec.A) || m.isTestID(rec.B))) {
			continue
		}
		open := rec.State == "live" || rec.State == "awaiting"
		if (q.states == "open" && !open) || (q.states == "open_error" && !open && rec.State != "error") {
			continue
		}
		if q.match != nil && ((*q.match && !talkMatched(rec.State)) || (!*q.match && rec.State != "no_match")) {
			continue
		}
		all = append(all, rec.copy())
	}
	m.mu.Unlock()
	sort.Slice(all, func(i, j int) bool {
		if !all[i].Started.Equal(all[j].Started) {
			return all[i].Started.After(all[j].Started)
		}
		return all[i].ID > all[j].ID
	})
	var out []adminTalkRow
	for _, rec := range all {
		if q.before != nil && !(rec.Started.Before(*q.before) || (rec.Started.Equal(*q.before) && rec.ID < q.beforeID)) {
			continue
		}
		if len(out) >= q.limit {
			break
		}
		out = append(out, adminTalkRow{rec: rec, started: rec.Started})
	}
	return out, nil
}

// adminTalksChanged (memory): no save times here, so talks that started or ended since, or
// are still open (the caller skips what it has already seen).
func (m *memStore) adminTalksChanged(_ context.Context, tenant string, since time.Time) ([]*talkRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*talkRecord
	for _, rec := range m.talkTables().talks {
		open := rec.State == "live" || rec.State == "awaiting"
		if rec.Tenant == tenant && (open || rec.Started.After(since) || (rec.Ended != nil && rec.Ended.After(since))) {
			out = append(out, rec.copy())
		}
	}
	return out, nil
}

func (m *memStore) purgeTestAccounts(_ context.Context, dryRun bool) (adminPurgeReport, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rep := adminPurgeReport{DryRun: dryRun}
	gone := map[int64]bool{}
	for id, u := range m.users {
		if isTestEmail(u.Email) {
			gone[id] = true
			rep.IDs = append(rep.IDs, id)
		}
	}
	sort.Slice(rep.IDs, func(i, j int) bool { return rep.IDs[i] < rep.IDs[j] })
	rep.Accounts = len(rep.IDs)
	var memberKeys []string
	for k := range m.members {
		if _, id, ok := memKeyID(k); ok && gone[id] {
			memberKeys = append(memberKeys, k)
		}
	}
	sort.Strings(memberKeys)
	rep.Memberships = len(memberKeys)
	rep.PurgesQueued = len(memberKeys)
	for k := range m.memory {
		if _, id, ok := memKeyID(k); ok && gone[id] {
			rep.Memories++
		}
	}
	for _, t := range m.tokens {
		if gone[t.id] {
			rep.Tokens++
		}
	}
	tt := m.talkTables()
	for _, rec := range tt.talks {
		if gone[rec.A] || gone[rec.B] {
			rep.Talks++
		}
	}
	if dryRun || rep.Accounts == 0 {
		return rep, nil
	}
	ft := m.fastT()
	for _, k := range memberKeys {
		tenant, id, _ := memKeyID(k)
		ft.nextID++
		ft.purges = append(ft.purges, memFastPurge{id: ft.nextID, who: fastWho{tenant, id}, spaceID: ft.spaces[k], at: time.Now().UTC()})
		delete(m.members, k)
		delete(m.memory, k)
		delete(tt.prefs, k)
		delete(tt.briefs, k)
		delete(ft.spaces, k)
		delete(ft.items, k)
		delete(ft.outbox, fastWho{tenant, id})
	}
	for h, t := range m.tokens {
		if gone[t.id] {
			delete(m.tokens, h)
		}
	}
	for key, rec := range tt.talks {
		if gone[rec.A] || gone[rec.B] {
			delete(tt.talks, key)
			delete(tt.pairs, rec.Tenant+"/"+rec.pairKey())
		}
	}
	m.memUsageForget(gone)
	for id := range gone {
		delete(m.byEmail, strings.ToLower(strings.TrimSpace(m.users[id].Email)))
		delete(m.users, id)
	}
	return rep, nil
}
