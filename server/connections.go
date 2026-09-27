package main

// Connections: every match (a talk both people approved, state "revealed") becomes a chat
// thread for the two of them, and their agents keep it going:
//   - the icebreaker from their talk opens the thread;
//   - when one of them changes their memory (their agent sends notes, or they edit them on
//     /settings), their agent posts one line about what's new that the other would care about
//     (at most once an hour per thread);
//   - when both are in the HackGT hall at the same time, a nudge to go say hi (every 2 hours
//     at most);
//   - an NPC answers for itself, from its own memory.
//   GET  /api/connections                    your threads, most recent first
//   GET  /api/connections/<talk>/messages    ?after=<id>: the thread (only yours)
//   POST /api/connections/<talk>/messages    {"text": "..."}: say something (same-site)
// A new message pings the other person's game socket ({"t":"conn","id":...}).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	connMaxText     = 600
	connUpdateEvery = time.Hour
	connNudgeEvery  = 2 * time.Hour
)

type connMsg struct {
	ID    int64     `json:"id"`
	Talk  string    `json:"-"`
	From  int64     `json:"-"` // a person, or 0 for an agent's line
	Agent int64     `json:"-"` // whose agent wrote it (0: both agents / the system)
	Text  string    `json:"text"`
	At    time.Time `json:"at"`
}

type connRow struct {
	rec  *talkRecord
	last *connMsg
}

type connStore interface {
	connEnsureSchema(ctx context.Context) error
	connList(ctx context.Context, tenant string, uid int64) ([]connRow, error)
	connMsgs(ctx context.Context, tenant, talk string, after int64, limit int) ([]connMsg, error)
	connAdd(ctx context.Context, tenant string, m connMsg) (connMsg, error)
}

var errNoConn = errors.New("no such connection")

// ---------- Postgres ----------

func (s *pgStore) connEnsureSchema(ctx context.Context) error {
	if err := s.talkEnsureSchema(ctx); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS conn_messages (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text   NOT NULL,
  talk_id   text   NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
  from_id   bigint NOT NULL DEFAULT 0,
  agent_of  bigint NOT NULL DEFAULT 0,
  text      text   NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conn_messages_talk ON conn_messages(tenant_id, talk_id, id);`)
	return err
}

func (s *pgStore) connList(ctx context.Context, tenant string, uid int64) ([]connRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT t.record::text, m.id, m.from_id, m.agent_of, m.text, m.at
		FROM talks t LEFT JOIN LATERAL (SELECT * FROM conn_messages c WHERE c.tenant_id = t.tenant_id AND c.talk_id = t.id ORDER BY c.id DESC LIMIT 1) m ON true
		WHERE t.tenant_id = $1 AND t.state = 'revealed' AND (t.a_id = $2 OR t.b_id = $2)`, tenant, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []connRow
	for rows.Next() {
		var raw []byte
		var id, from, agent *int64
		var text *string
		var at *time.Time
		if err := rows.Scan(&raw, &id, &from, &agent, &text, &at); err != nil {
			return nil, err
		}
		rec := &talkRecord{}
		if json.Unmarshal(raw, rec) != nil {
			continue
		}
		row := connRow{rec: rec}
		if id != nil {
			row.last = &connMsg{ID: *id, Talk: rec.ID, From: *from, Agent: *agent, Text: *text, At: *at}
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *pgStore) connMsgs(ctx context.Context, tenant, talk string, after int64, limit int) ([]connMsg, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, from_id, agent_of, text, at FROM conn_messages
		WHERE tenant_id = $1 AND talk_id = $2 AND id > $3 ORDER BY id LIMIT $4`, tenant, talk, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []connMsg
	for rows.Next() {
		m := connMsg{Talk: talk}
		if err := rows.Scan(&m.ID, &m.From, &m.Agent, &m.Text, &m.At); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *pgStore) connAdd(ctx context.Context, tenant string, m connMsg) (connMsg, error) {
	err := s.pool.QueryRow(ctx, `INSERT INTO conn_messages (tenant_id, talk_id, from_id, agent_of, text) VALUES ($1, $2, $3, $4, $5)
		RETURNING id, at`, tenant, m.Talk, m.From, m.Agent, m.Text).Scan(&m.ID, &m.At)
	return m, err
}

// ---------- memory ----------

type memConnTables struct {
	next int64
	msgs map[string][]connMsg // "<tenant>/<talk>"
}

func (m *memStore) connT() *memConnTables {
	if m.conn == nil {
		m.conn = &memConnTables{msgs: map[string][]connMsg{}}
	}
	return m.conn
}

func (m *memStore) connEnsureSchema(context.Context) error { return nil }

func (m *memStore) connList(_ context.Context, tenant string, uid int64) ([]connRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []connRow
	for _, rec := range m.talkTables().talks {
		if rec.Tenant != tenant || rec.State != "revealed" || (rec.A != uid && rec.B != uid) {
			continue
		}
		row := connRow{rec: rec.copy()}
		if ms := m.connT().msgs[tenant+"/"+rec.ID]; len(ms) > 0 {
			last := ms[len(ms)-1]
			row.last = &last
		}
		out = append(out, row)
	}
	return out, nil
}

func (m *memStore) connMsgs(_ context.Context, tenant, talk string, after int64, limit int) ([]connMsg, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []connMsg
	for _, x := range m.connT().msgs[tenant+"/"+talk] {
		if x.ID > after && len(out) < limit {
			out = append(out, x)
		}
	}
	return out, nil
}

func (m *memStore) connAdd(_ context.Context, tenant string, x connMsg) (connMsg, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.talkTables().talks[tenant+"/"+x.Talk]; !ok {
		return x, errNoConn
	}
	t := m.connT()
	t.next++
	x.ID, x.At = t.next, time.Now().UTC()
	k := tenant + "/" + x.Talk
	t.msgs[k] = append(t.msgs[k], x)
	return x, nil
}

// ---------- the service ----------

type connections struct {
	acc   *accounts
	st    connStore
	hub   *Hub
	mu    sync.Mutex
	lastU map[string]time.Time // "<talk>/<uid>": the last memory update posted
	lastN map[string]time.Time // talk: the last "you're both here" nudge
}

// the one instance the reveal and memory hooks reach (nil: connections are off)
var conns *connections

func (c *connections) post(ctx context.Context, tenant string, m connMsg, rec *talkRecord) (connMsg, error) {
	m.Text = strings.TrimSpace(m.Text)
	if len([]rune(m.Text)) > connMaxText {
		m.Text = string([]rune(m.Text)[:connMaxText])
	}
	m.Text = talkScrub(m.Text)
	saved, err := c.st.connAdd(ctx, tenant, m)
	if err != nil {
		return saved, err
	}
	if c.hub != nil {
		ping := mustJSON(map[string]any{"t": "conn", "id": rec.ID})
		c.hub.sendUID(rec.A, ping)
		c.hub.sendUID(rec.B, ping)
	}
	return saved, nil
}

// revealed: the thread opens with the icebreaker their agents wrote.
func (c *connections) revealed(rec *talkRecord) {
	if c == nil || rec == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	text := "Your agents think you two should meet."
	if ice := rec.Icebreaker; ice != nil && ice.Line != "" {
		text = ice.Line
		if ice.Question != "" {
			text += " Try asking: " + ice.Question
		}
	}
	if _, err := c.post(ctx, rec.Tenant, connMsg{Talk: rec.ID, Text: text}, rec); err != nil {
		log.Printf("connections: %s: opening line: %v", rec.ID, err)
	}
}

// memoryChanged: uid's memory is new; their agent tells each connection what's worth knowing.
func (c *connections) memoryChanged(tenant string, uid int64) {
	if c == nil || c.acc.talk == nil || c.acc.talk.gem == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		rows, err := c.st.connList(ctx, tenant, uid)
		if err != nil || len(rows) == 0 {
			return
		}
		ts, _ := c.acc.store.(talkStore)
		if ts == nil {
			return
		}
		raw, err := ts.talkMemory(ctx, tenant, uid)
		if err != nil || len(raw) == 0 {
			return
		}
		var obj map[string]any
		if json.Unmarshal(raw, &obj) != nil {
			return
		}
		notes := jevState(obj)
		me, err := c.acc.talk.person(ctx, tenant, uid)
		if err != nil {
			return
		}
		for _, row := range rows {
			key := fmt.Sprintf("%s/%d", row.rec.ID, uid)
			c.mu.Lock()
			recent := time.Since(c.lastU[key]) < connUpdateEvery
			if !recent {
				c.lastU[key] = time.Now()
			}
			c.mu.Unlock()
			if recent {
				continue
			}
			other := row.rec.A
			if other == uid {
				other = row.rec.B
			}
			them, err := c.acc.talk.person(ctx, tenant, other)
			if err != nil {
				continue
			}
			why := ""
			if ice := row.rec.Icebreaker; ice != nil {
				why = ice.Line
			}
			sys := "You are " + me.name + "'s AI agent at HackGT 13. " + me.name + " and " + them.name + " met through their agents (why: " + why + "). " +
				"From " + me.name + "'s latest notes below, write ONE short, warm, specific update for " + them.name + " (at most 30 words) about something new that would keep their connection going: progress, a question, an invite. " +
				"Refer to " + me.name + " by first name. No contact details, health, money or anything about other people. If nothing is worth sharing, reply exactly SKIP."
			text, _, err := c.acc.talk.gem.hedged(ctx, c.acc.talk.cfg.Models.Writer, c.acc.talk.cfg.Models.WriterFallback, c.acc.talk.cfg.ms(c.acc.talk.cfg.Models.WriterTimeoutMS/2), sys, "NOTES:\n"+notes, nil, nil)
			text = strings.TrimSpace(text)
			if err != nil || text == "" || strings.EqualFold(strings.Trim(text, ". "), "skip") {
				continue
			}
			c.post(ctx, tenant, connMsg{Talk: row.rec.ID, Agent: uid, Text: text}, row.rec)
		}
	}()
}

// npcReply: someone wrote to an NPC; the NPC answers from its own memory, like a person would.
func (c *connections) npcReply(tenant string, rec *talkRecord, npc, human int64) {
	t := c.acc.talk
	if t == nil || t.gem == nil {
		return
	}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ts, _ := c.acc.store.(talkStore)
		me, err1 := t.person(ctx, tenant, npc)
		them, err2 := t.person(ctx, tenant, human)
		if ts == nil || err1 != nil || err2 != nil {
			return
		}
		raw, _ := ts.talkMemory(ctx, tenant, npc)
		var obj map[string]any
		json.Unmarshal(raw, &obj)
		msgs, _ := c.st.connMsgs(ctx, tenant, rec.ID, 0, 200)
		var thread strings.Builder
		for _, m := range msgs[max(0, len(msgs)-12):] {
			who := "agents"
			switch m.From {
			case npc:
				who = me.name
			case human:
				who = them.name
			}
			thread.WriteString(who + ": " + m.Text + "\n")
		}
		sys := "You are " + me.name + ", an attendee at HackGT 13, chatting with " + them.name + ", whom your agents just introduced you to. " +
			"Reply in one or two short, warm, casual sentences, like texting someone you just met; ask something back sometimes. " +
			"Speak only from YOUR NOTES; if they don't cover it, say so lightly. No contact details, no links."
		text, _, err := t.gem.hedged(ctx, t.cfg.Models.Agent, t.cfg.Models.AgentFallback, t.cfg.ms(t.cfg.Models.WriterTimeoutMS/2), sys,
			"YOUR NOTES:\n"+jevState(obj)+"\n\nTHE CHAT SO FAR:\n"+thread.String()+"\nYour reply:", nil, nil)
		if text = strings.TrimSpace(strings.Trim(strings.TrimSpace(text), "\"")); err == nil && text != "" {
			c.post(ctx, tenant, connMsg{Talk: rec.ID, From: npc, Text: text}, rec)
		}
	}()
}

// nudgeLoop: both people of a connection in the HackGT hall right now: tell them.
func (c *connections) nudgeLoop(tenant string) {
	for range time.Tick(time.Minute) {
		in := map[int64]bool{}
		c.hub.mu.Lock()
		for _, cl := range c.hub.clients {
			if cl.joined && cl.uid != 0 && !cl.npc && cl.p.Room == "hackgt" {
				in[cl.uid] = true
			}
		}
		c.hub.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		for uid := range in {
			rows, err := c.st.connList(ctx, tenant, uid)
			if err != nil {
				continue
			}
			for _, row := range rows {
				other := row.rec.A
				if other == uid {
					other = row.rec.B
				}
				if !in[other] || uid > other { // each pair once per sweep
					continue
				}
				c.mu.Lock()
				due := time.Since(c.lastN[row.rec.ID]) >= connNudgeEvery
				if due {
					c.lastN[row.rec.ID] = time.Now()
				}
				c.mu.Unlock()
				if due {
					c.post(ctx, tenant, connMsg{Talk: row.rec.ID, Text: "You're both in the Klaus atrium right now. Perfect moment to say hi in person!"}, row.rec)
				}
			}
		}
		cancel()
	}
}

// ---------- the API ----------

func mountConnections(mux *http.ServeMux, acc *accounts, hub *Hub, originOK func(*http.Request) bool) {
	st, ok := acc.store.(connStore)
	if !ok {
		return
	}
	c := &connections{acc: acc, st: st, hub: hub, lastU: map[string]time.Time{}, lastN: map[string]time.Time{}}
	conns = c
	if hub != nil {
		go c.nudgeLoop(acc.tenant)
	}
	people := func(ctx context.Context, id int64) (string, string) {
		a, err := acc.store.Account(ctx, acc.tenant, id)
		if err != nil {
			return "someone", ""
		}
		return adminFirstName(a.User.Given, a.User.Name, a.Profile.Name), a.Profile.Look
	}
	// who: from the session; the talk must be a revealed one of theirs
	mine := func(ctx context.Context, uid int64, talk string) (*talkRecord, error) {
		ts, _ := acc.store.(talkStore)
		if ts == nil {
			return nil, errNoConn
		}
		rec, err := ts.talkGet(ctx, acc.tenant, talk)
		if err != nil || rec.State != "revealed" || (rec.A != uid && rec.B != uid) {
			return nil, errNoConn
		}
		return rec, nil
	}
	view := func(m connMsg, me, other int64) map[string]any {
		from := "agents"
		switch {
		case m.From == me:
			from = "you"
		case m.From == other:
			from = "them"
		case m.Agent == me:
			from = "your_agent"
		case m.Agent == other:
			from = "their_agent"
		}
		return map[string]any{"id": m.ID, "from": from, "text": m.Text, "at": m.At}
	}

	mux.HandleFunc("/api/connections", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := acc.sess.read(r)
		if !ok {
			adminJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		rows, err := st.connList(ctx, acc.tenant, uid)
		if err != nil {
			adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
			return
		}
		out := []map[string]any{}
		for _, row := range rows {
			other := row.rec.A
			if other == uid {
				other = row.rec.B
			}
			name, look := people(ctx, other)
			at := row.rec.Started
			if row.rec.Ended != nil {
				at = *row.rec.Ended
			}
			item := map[string]any{"id": row.rec.ID, "other": map[string]any{"first_name": name, "bean": look}, "at": at}
			if row.rec.Icebreaker != nil {
				item["icebreaker"] = row.rec.Icebreaker
			}
			if row.last != nil {
				item["last"] = view(*row.last, uid, other)
				item["at"] = row.last.At
			}
			out = append(out, item)
		}
		sort.Slice(out, func(i, j int) bool { return out[i]["at"].(time.Time).After(out[j]["at"].(time.Time)) })
		adminJSON(w, http.StatusOK, map[string]any{"connections": out})
	})

	mux.HandleFunc("/api/connections/", func(w http.ResponseWriter, r *http.Request) {
		uid, ok := acc.sess.read(r)
		if !ok {
			adminJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return
		}
		talk, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/api/connections/"), "/")
		if rest != "messages" || talk == "" {
			adminJSON(w, http.StatusNotFound, map[string]string{"error": "no such thing"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		rec, err := mine(ctx, uid, talk)
		if err != nil {
			adminJSON(w, http.StatusNotFound, map[string]string{"error": "no such connection"})
			return
		}
		other := rec.A
		if other == uid {
			other = rec.B
		}
		switch r.Method {
		case http.MethodGet:
			after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
			msgs, err := st.connMsgs(ctx, acc.tenant, talk, after, 200)
			if err != nil {
				adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "try again in a moment"})
				return
			}
			out := []map[string]any{}
			for _, m := range msgs {
				out = append(out, view(m, uid, other))
			}
			name, look := people(ctx, other)
			adminJSON(w, http.StatusOK, map[string]any{"other": map[string]any{"first_name": name, "bean": look}, "messages": out})
		case http.MethodPost:
			if r.Header.Get("Origin") == "" || !originOK(r) {
				adminJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
				return
			}
			var in struct{ Text string }
			b, _ := io.ReadAll(io.LimitReader(r.Body, 8<<10))
			if json.Unmarshal(b, &in) != nil || strings.TrimSpace(in.Text) == "" {
				adminJSON(w, http.StatusBadRequest, map[string]string{"error": `send {"text": "..."}`})
				return
			}
			m, err := c.post(ctx, acc.tenant, connMsg{Talk: talk, From: uid, Text: in.Text}, rec)
			if err != nil {
				adminJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "couldn't send that just now"})
				return
			}
			if acc.talk.isNPC(other) {
				c.npcReply(acc.tenant, rec, other, uid)
			}
			adminJSON(w, http.StatusOK, view(m, uid, other))
		default:
			w.Header().Set("Allow", "GET, POST")
			adminJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET or POST"})
		}
	})
}
