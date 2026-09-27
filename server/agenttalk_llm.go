package main

// Agent talk (agenttalk.go): its config, its question bank, and the two models it talks to.
//   - Gemini writes: each agent's lines (streamed over SSE so a bubble starts at once), the
//     briefs, and the icebreaker. Key: GEMINI_API_KEY or GEMINI_API_KEY_FILE.
//   - jev (TypeSafe System One) decides: which question comes next, the checkpoint gates, the
//     final scores. Key: JEV_API_KEY or JEV_API_KEY_FILE (the same key jevlook.go uses).
// Everything tunable lives in talkdata/talk_config.json (versioned; every talk records the
// version it ran with), or in a file named by -talk-config / TALK_CONFIG_FILE.

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

//go:embed talkdata/*.json
var talkFS embed.FS

// ---------- config ----------

type talkModel struct {
	Model    string `json:"model"`
	Thinking string `json:"thinking"` // Gemini thinkingLevel; "" leaves it to the model
}

type talkPhase struct {
	Questions    int    `json:"questions"`
	MinQuestions int    `json:"min_questions"`
	MaxDepth     int    `json:"max_depth"`
	Objective    string `json:"objective"`
	GenericSteer string `json:"generic_steer"`
	Enough       struct {
		Instructions string  `json:"instructions"`
		Threshold    float64 `json:"threshold"`
	} `json:"enough"`
}

type talkGate struct {
	Key             string `json:"key"`
	Instructions    string `json:"instructions"`
	Negative        bool   `json:"negative"`
	RequiresConsent bool   `json:"requires_consent"`
}

type talkScoreQ struct {
	Instructions string   `json:"instructions"`
	Criteria     []string `json:"criteria"`
}

type talkChoiceQ struct {
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

type talkConfig struct {
	Version string `json:"version"`
	Models  struct {
		Agent           talkModel `json:"agent"`
		AgentFallback   talkModel `json:"agent_fallback"`
		Writer          talkModel `json:"writer"`
		WriterFallback  talkModel `json:"writer_fallback"`
		HedgeMS         int       `json:"hedge_ms"`
		AgentTimeoutMS  int       `json:"agent_timeout_ms"`
		WriterTimeoutMS int       `json:"writer_timeout_ms"`
		JevModel        string    `json:"jev_model"`
		PickTimeoutMS   int       `json:"pick_timeout_ms"`
		JudgeTimeoutMS  int       `json:"judge_timeout_ms"`
	} `json:"models"`
	Limits struct {
		IntrosPerDay   int  `json:"intros_per_day"`
		TalksPerDay    int  `json:"talks_per_day"`
		MaxConcurrent  int  `json:"max_concurrent"`
		ApproveTTLS    int  `json:"approve_ttl_s"`
		AnswerMaxWords int  `json:"answer_max_words"`
		MinGapMS       int  `json:"min_gap_ms"`
		RequireOnline  bool `json:"require_online"`
		// MaxMisses: this many "don't know" answers in a row ends the questions early (0: never)
		MaxMisses int `json:"max_misses"`
	} `json:"limits"`
	// Proximity: the web trigger (agenttalk_near.go).
	Proximity struct {
		RadiusM        float64 `json:"radius_m"`         // within this many metres...
		DwellMS        int     `json:"dwell_ms"`         // ...for this long starts a talk
		FloorGapM      float64 `json:"floor_gap_m"`      // more height apart than this: different floors
		ScanMS         int     `json:"scan_ms"`          // how often positions are checked
		OptinRefreshMS int     `json:"optin_refresh_ms"` // how often who opted in is reloaded
		RetryMS        int     `json:"retry_ms"`         // a pair that couldn't start (busy, offline) waits this long
	} `json:"proximity"`
	Phase1 talkPhase `json:"phase1"`
	Phase2 talkPhase `json:"phase2"`
	Pick   struct {
		Instructions string `json:"instructions"`
		MaxOptions   int    `json:"max_options"`
		TypeCooldown int    `json:"type_cooldown"` // the last N questions' types are left out (variety)
		// question types about the project; after MaxWorkStreak of them in a row, the next
		// question is about the person (0: no limit)
		WorkTypes     []string `json:"work_types"`
		MaxWorkStreak int      `json:"max_work_streak"`
	} `json:"pick"`
	Memory struct {
		Use                   bool     `json:"use"`
		MaxHotTopics          int      `json:"max_hot_topics"`
		SnippetsPerSide       int      `json:"snippets_per_side"`
		StateBudgetChars      int      `json:"state_budget_chars"`
		SnippetChars          int      `json:"snippet_chars"`
		SnippetTimeoutMS      int      `json:"snippet_timeout_ms"`
		OverlapTimeoutMS      int      `json:"overlap_timeout_ms"`
		OverlapQueriesPerSide int      `json:"overlap_queries_per_side"`
		OverlapMinScore       float64  `json:"overlap_min_score"`
		BriefInputChars       int      `json:"brief_input_chars"`
		BriefQueries          []string `json:"brief_queries"`
	} `json:"memory"`
	Gates             []talkGate `json:"gates"`
	GateThreshold     float64    `json:"gate_threshold"`
	NegativeThreshold float64    `json:"negative_threshold"`
	Checkpoint2       struct {
		Scores map[string]talkScoreQ `json:"scores"`
		Reason talkChoiceQ           `json:"reason"`
		Opener talkChoiceQ           `json:"opener"`
	} `json:"checkpoint2"`
	Fire struct {
		ValueMin       float64 `json:"value_min"`
		SoonOrAgainMin float64 `json:"soon_or_again_min"`
	} `json:"fire"`
	Prompts struct {
		Agent         string `json:"agent"`
		Brief         string `json:"brief"`
		BriefGoingYes string `json:"brief_going_through_yes"`
		BriefGoingNo  string `json:"brief_going_through_no"`
		Icebreaker    string `json:"icebreaker"`
	} `json:"prompts"`
	Lines struct {
		Greet              [][2]string       `json:"greet"`
		Close              [][2]string       `json:"close"`
		NotInMemory        string            `json:"not_in_memory"`
		NotInMemoryAlts    []string          `json:"not_in_memory_alts"` // said in turn, so "don't know" doesn't sound canned
		Ask                string            `json:"ask"`
		Why                map[string]string `json:"why"`
		IcebreakerFallback talkIcebreaker    `json:"icebreaker_fallback"`
	} `json:"lines"`
	Guard struct {
		GroundMin    float64  `json:"ground_min"`
		GenericWords []string `json:"generic_words"`
	} `json:"guard"`

	generic map[string]bool
}

func (c *talkConfig) ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

// loadTalkConfig reads path, or the embedded talkdata/talk_config.json when path is "".
func loadTalkConfig(path string) (*talkConfig, error) {
	var b []byte
	var err error
	if path == "" {
		b, err = talkFS.ReadFile("talkdata/talk_config.json")
	} else {
		b, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, err
	}
	c := &talkConfig{}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields() // a typo in a knob should fail loudly, not silently keep the default
	if err := dec.Decode(c); err != nil {
		return nil, fmt.Errorf("talk config: %w", err)
	}
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("talk config %s: %w", c.Version, err)
	}
	c.generic = map[string]bool{}
	for _, w := range c.Guard.GenericWords {
		c.generic[strings.ToLower(w)] = true
	}
	return c, nil
}

func (c *talkConfig) validate() error {
	switch {
	case c.Version == "":
		return errors.New("version is required")
	case c.Models.Agent.Model == "" || c.Models.Writer.Model == "" || c.Models.JevModel == "":
		return errors.New("models.agent, models.writer and models.jev_model are required")
	case c.Phase1.Questions < 1 || c.Phase2.Questions < 0:
		return errors.New("phase1.questions must be at least 1")
	case len(c.Gates) == 0:
		return errors.New("gates are required")
	case c.GateThreshold <= 0 || c.GateThreshold > 1 || c.NegativeThreshold <= 0 || c.NegativeThreshold > 1:
		return errors.New("gate thresholds must be in (0, 1]")
	case c.Prompts.Agent == "" || c.Prompts.Brief == "" || c.Prompts.Icebreaker == "":
		return errors.New("prompts.agent, prompts.brief and prompts.icebreaker are required")
	case len(c.Lines.Close) == 0 || c.Lines.NotInMemory == "":
		return errors.New("lines.close and lines.not_in_memory are required")
	case c.Proximity.RadiusM < 0 || c.Proximity.DwellMS < 0 || c.Proximity.FloorGapM < 0 || c.Proximity.ScanMS < 0:
		return errors.New("proximity values can't be negative")
	case c.Pick.MaxOptions < 1 || c.Pick.MaxOptions > 255:
		return errors.New("pick.max_options must be 1..255 (jev's limit)")
	}
	for _, k := range []string{"value_a", "value_b", "soon", "talk_again"} {
		s, ok := c.Checkpoint2.Scores[k]
		if !ok || len(s.Criteria) < 2 || len(s.Criteria) > 10 {
			return fmt.Errorf("checkpoint2.scores.%s needs 2-10 criteria", k)
		}
	}
	if _, ok := c.Checkpoint2.Reason.Criteria["none"]; !ok {
		return errors.New("checkpoint2.reason needs a none option")
	}
	if len(c.Checkpoint2.Opener.Criteria) == 0 {
		return errors.New("checkpoint2.opener needs options")
	}
	return nil
}

// ---------- the question bank (talkdata/questions.json) ----------

type talkQuestion struct {
	ID         string   `json:"id"`
	Type       string   `json:"type"`
	Text       string   `json:"text"`
	Depth      int      `json:"depth"`
	Consent    string   `json:"consent"` // "none", or the consent both humans must have given (okay_to_share)
	Informs    []string `json:"informs"`
	Horizon    string   `json:"horizon"`
	FollowupOK bool     `json:"followup_ok"`
	// Say: how the asking agent puts it in the chat (talkdata/questions_say.json); Text is
	// what jev picks from and what the answering agent is asked
	Say string `json:"-"`
}

// said: the question as it appears in the chat.
func (q talkQuestion) said() string {
	if q.Say != "" {
		return q.Say
	}
	return q.Text
}

func (q talkQuestion) gated() bool { return q.Consent != "" && q.Consent != "none" }

// loadTalkBank reads the embedded bank; without it (a build before the file existed) the
// small fixture below stands in.
func loadTalkBank() ([]talkQuestion, string) {
	b, err := talkFS.ReadFile("talkdata/questions.json")
	if err != nil {
		return talkFixtureBank, "fixture"
	}
	var f struct {
		Version   string         `json:"version"`
		Questions []talkQuestion `json:"questions"`
	}
	if json.Unmarshal(b, &f) != nil || len(f.Questions) == 0 {
		return talkFixtureBank, "fixture"
	}
	// the casual wording of each question, when there is one
	say := map[string]string{}
	if sb, err := talkFS.ReadFile("talkdata/questions_say.json"); err == nil {
		json.Unmarshal(sb, &say)
	}
	var out []talkQuestion
	seen := map[string]bool{}
	for _, q := range f.Questions {
		if q.ID == "" || q.Text == "" || seen[q.ID] {
			continue
		}
		seen[q.ID] = true
		q.Say = strings.TrimSpace(say[q.ID])
		out = append(out, q)
	}
	return out, f.Version
}

// talkFixtureBank: a dozen questions covering every gate, for tests and as a fallback.
var talkFixtureBank = []talkQuestion{
	{ID: "f01", Type: "now_at_hackgt", Text: "What is your human building at HackGT 13?", Depth: 1, Consent: "none", Informs: []string{"team", "same_problem", "soon"}},
	{ID: "f02", Type: "stuck_and_solved", Text: "What is your human stuck on right now?", Depth: 1, Consent: "none", Informs: []string{"same_problem", "a_fixed_b", "b_fixed_a"}},
	{ID: "f03", Type: "stuck_and_solved", Text: "What has your human already solved that others keep asking about?", Depth: 1, Consent: "none", Informs: []string{"a_fixed_b", "b_fixed_a"}},
	{ID: "f04", Type: "interests_and_rare", Text: "What does your human do outside tech that few people share?", Depth: 1, Consent: "none", Informs: []string{"rare"}},
	{ID: "f05", Type: "career_and_path", Text: "What kind of teammate is your human looking for?", Depth: 1, Consent: "none", Informs: []string{"team", "one_sided"}},
	{ID: "f06", Type: "building_and_craft", Text: "Which tool or stack does your human reach for first?", Depth: 1, Consent: "none", Informs: []string{"team"}},
	{ID: "f07", Type: "life_and_personal", Text: "What is your human going through right now that others might relate to?", Depth: 3, Consent: "okay_to_share", Informs: []string{"going_through"}},
	{ID: "f08", Type: "life_and_personal", Text: "What has made this weekend harder for your human?", Depth: 3, Consent: "okay_to_share", Informs: []string{"going_through", "busy"}},
	{ID: "f09", Type: "stuck_and_solved", Text: "How did your human fix the hardest bug they have hit this year?", Depth: 2, Consent: "none", Informs: []string{"a_fixed_b", "b_fixed_a"}},
	{ID: "f10", Type: "now_at_hackgt", Text: "Is your human heads-down right now or happy to be interrupted?", Depth: 1, Consent: "none", Informs: []string{"busy"}},
	{ID: "f11", Type: "future_and_followup", Text: "What would your human want to keep working on after HackGT?", Depth: 2, Consent: "none", Informs: []string{"talk_again"}},
	{ID: "f12", Type: "fun_and_play", Text: "What absurd side quest would your human go on if HackGT had no judging?", Depth: 1, Consent: "none", Informs: []string{"rare"}},
	{ID: "f13", Type: "stuck_and_solved", Text: "What would your human trade an hour of help for right now?", Depth: 2, Consent: "none", Informs: []string{"soon", "value"}},
	{ID: "f14", Type: "building_and_craft", Text: "What is the part of your human's project they are proudest of?", Depth: 2, Consent: "none", Informs: []string{"value"}},
}

// ---------- keys ----------

// talkKey reads an API key from env (NAME) or a file (NAME_FILE). Never logged.
func talkKey(name string) string {
	k := strings.TrimSpace(os.Getenv(name))
	if f := os.Getenv(name + "_FILE"); k == "" && f != "" {
		if b, err := os.ReadFile(f); err == nil {
			k = strings.TrimSpace(string(b))
		}
	}
	return k
}

// talkTransport: Gemini and jev go through the shared, tuned transport (warm.go), so the
// connections the warmers keep open are the ones the talks use. Every call has a deadline.
func talkTransport() *http.Client {
	return &http.Client{Transport: http.DefaultTransport}
}

// ---------- Gemini ----------

type talkGemini struct {
	key  string
	base string // https://generativelanguage.googleapis.com/v1beta/models/
	hc   *http.Client
}

const geminiBase = "https://generativelanguage.googleapis.com/v1beta/models/"

func newTalkGemini(key string) *talkGemini {
	return &talkGemini{key: key, base: geminiBase, hc: talkTransport()}
}

// geminiErr never carries the request (which holds people's briefs) or the key.
type geminiErr struct {
	status int
	msg    string
}

func (e *geminiErr) Error() string { return fmt.Sprintf("gemini %d %s", e.status, e.msg) }

func (g *talkGemini) body(m talkModel, system, user string, schema any) []byte {
	gc := map[string]any{"responseMimeType": "application/json"}
	if schema != nil {
		gc["responseSchema"] = schema
	}
	if m.Thinking != "" {
		gc["thinkingConfig"] = map[string]any{"thinkingLevel": m.Thinking}
	}
	b, _ := json.Marshal(map[string]any{
		"systemInstruction": map[string]any{"parts": []any{map[string]any{"text": system}}},
		"contents":          []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": user}}}},
		"generationConfig":  gc,
	})
	return b
}

func (g *talkGemini) post(ctx context.Context, m talkModel, stream bool, body []byte) (*http.Response, error) {
	u := g.base + m.Model + ":generateContent"
	if stream {
		u = g.base + m.Model + ":streamGenerateContent?alt=sse"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-goog-api-key", g.key)
	req.Header.Set("Content-Type", "application/json")
	res, err := g.hc.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		var e struct {
			Error struct {
				Status string `json:"status"`
			} `json:"error"`
		}
		json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&e)
		return nil, &geminiErr{res.StatusCode, e.Error.Status}
	}
	return res, nil
}

type geminiChunk struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text    string `json:"text"`
				Thought bool   `json:"thought"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	// streamed: each chunk carries the running totals, so the last one counts (usage.go)
	Usage *struct {
		Prompt   int64 `json:"promptTokenCount"`
		Output   int64 `json:"candidatesTokenCount"`
		Thoughts int64 `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
}

func (c geminiChunk) text() string {
	var b strings.Builder
	for _, cand := range c.Candidates {
		for _, p := range cand.Content.Parts {
			if !p.Thought {
				b.WriteString(p.Text)
			}
		}
	}
	return b.String()
}

// once: one attempt, streamed or not; onText (streaming only) sees each piece as it lands.
func (g *talkGemini) once(ctx context.Context, m talkModel, body []byte, onText func(string)) (text string, err error) {
	var in, out int64 // tokens, when Gemini says (a call cancelled mid-stream may not)
	defer func() { meter.add("gemini", m.Model, err == nil, in, out, 0) }()
	count := func(c geminiChunk) {
		if c.Usage != nil {
			in, out = c.Usage.Prompt, c.Usage.Output+c.Usage.Thoughts
		}
	}
	res, err := g.post(ctx, m, onText != nil, body)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if onText == nil {
		var c geminiChunk
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&c); err != nil {
			return "", err
		}
		count(c)
		return c.text(), nil
	}
	var all strings.Builder
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		var c geminiChunk
		if json.Unmarshal([]byte(strings.TrimSpace(line)), &c) != nil {
			continue
		}
		count(c)
		if t := c.text(); t != "" {
			all.WriteString(t)
			onText(t)
		}
	}
	if err := sc.Err(); err != nil {
		return all.String(), err
	}
	return all.String(), nil
}

// hedged runs the primary model; if it hasn't produced anything within hedge (or fails
// first), the fallback starts too, and whichever speaks first wins (the other is cancelled).
// Streaming (onText set): the first to send text wins, and only its text reaches onText.
// Returns the text and the model that produced it.
func (g *talkGemini) hedged(ctx context.Context, prim, fb talkModel, hedge time.Duration, system, user string, schema any, onText func(string)) (string, string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		i    int32
		text string
		err  error
	}
	models := []talkModel{prim, fb}
	var winner atomic.Int32
	winner.Store(-1)
	done := make(chan result, len(models))
	pending := 0
	launch := func(i int32) {
		if int(i) >= len(models) || models[i].Model == "" {
			return
		}
		pending++
		body := g.body(models[i], system, user, schema)
		go func() {
			var cb func(string)
			if onText != nil {
				cb = func(t string) {
					if winner.CompareAndSwap(-1, i) || winner.Load() == i {
						onText(t)
					}
				}
			}
			text, err := g.once(ctx, models[i], body, cb)
			done <- result{i, text, err}
		}()
	}
	fallback := false
	startFallback := func() {
		if !fallback {
			fallback = true
			launch(1)
		}
	}
	launch(0)
	t := time.NewTimer(hedge)
	defer t.Stop()
	var lastErr error = errors.New("no model configured")
	for pending > 0 {
		select {
		case <-t.C:
			if winner.Load() == -1 {
				startFallback()
			}
		case r := <-done:
			pending--
			ok := r.err == nil && strings.TrimSpace(r.text) != ""
			if ok && onText == nil && winner.CompareAndSwap(-1, r.i) {
				return r.text, models[r.i].Model, nil
			}
			if ok && onText != nil && winner.Load() == r.i {
				return r.text, models[r.i].Model, nil
			}
			if ok {
				continue // it lost the race
			}
			lastErr = r.err
			if lastErr == nil {
				lastErr = errors.New("empty answer")
			}
			if winner.Load() == r.i {
				return "", models[r.i].Model, lastErr // died mid-stream: its words already went out
			}
			startFallback()
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
	}
	return "", "", lastErr
}

// warm opens a connection to Gemini ahead of the first real call (TLS costs ~100-200 ms).
func (g *talkGemini) warm(m talkModel) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, g.base+m.Model, nil)
	req.Header.Set("x-goog-api-key", g.key)
	if res, err := g.hc.Do(req); err == nil {
		io.Copy(io.Discard, io.LimitReader(res.Body, 64*1024))
		res.Body.Close()
	}
}

// talkPartialString decodes the string value of field from a JSON object that may still be
// arriving: the text so far, and whether its closing quote has been seen.
func talkPartialString(buf, field string) (string, bool) {
	i := strings.Index(buf, `"`+field+`"`)
	if i < 0 {
		return "", false
	}
	rest := buf[i+len(field)+2:]
	rest = strings.TrimLeft(rest, " \t\r\n")
	if !strings.HasPrefix(rest, ":") {
		return "", false
	}
	rest = strings.TrimLeft(rest[1:], " \t\r\n")
	if !strings.HasPrefix(rest, `"`) {
		return "", false
	}
	rest = rest[1:]
	var out strings.Builder
	for j := 0; j < len(rest); j++ {
		c := rest[j]
		switch {
		case c == '"':
			return out.String(), true
		case c == '\\':
			if j+1 >= len(rest) {
				return out.String(), false
			}
			j++
			switch rest[j] {
			case 'n':
				out.WriteByte('\n')
			case 't':
				out.WriteByte('\t')
			case 'r':
			case 'u':
				if j+4 >= len(rest) {
					return out.String(), false
				}
				var r rune
				if _, err := fmt.Sscanf(rest[j+1:j+5], "%04x", &r); err == nil {
					out.WriteRune(r)
				}
				j += 4
			default:
				out.WriteByte(rest[j])
			}
		default:
			out.WriteByte(c)
		}
	}
	return out.String(), false
}

// ---------- jev ----------

type talkJev struct {
	key   string
	url   string
	model string
	hc    *http.Client
}

type jevAns struct {
	Choice        string             `json:"choice"`
	Noul          *float64           `json:"noul"`
	Score         *float64           `json:"score"`
	Confidence    float64            `json:"confidence"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
}

func newTalkJev(key, model string) *talkJev {
	return &talkJev{key: key, url: jevURL, model: model, hc: talkTransport()}
}

// ask sends one call with any number of questions (choice / noul / score).
func (j *talkJev) ask(ctx context.Context, state string, questions map[string]any) (ans map[string]jevAns, err error) {
	defer func() { meter.add("jev", j.model, err == nil, 0, 0, 0) }()
	body, _ := json.Marshal(map[string]any{"state": state, "model": j.model, "questions": questions})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+j.key)
	req.Header.Set("Content-Type", "application/json")
	res, err := j.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out struct {
		Answers map[string]jevAns `json:"answers"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil || res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jev http %d", res.StatusCode)
	}
	return out.Answers, nil
}
