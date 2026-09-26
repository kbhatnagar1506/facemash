package main

// Voice onboarding, for attendees without a Muse: a short call with an ElevenLabs voice
// agent (Agents Platform) that asks five questions. What they say becomes their memory,
// through the same door as an agent's upload (ingestMemory in muse.go): the same redaction,
// storage, private index and outfit. Deleting it on /muse deletes this too.
//
// The agent is private (signed URLs only), so the browser never sees an API key:
//   POST /api/voice/start  → a signed URL for one call, bound to (tenant, person)
//   POST /api/voice/finish → we fetch that call's transcript from ElevenLabs ourselves,
//                            check it's theirs, and keep only what they said
// No audio is kept here; the agent is set not to record it either.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	voiceAgentName = "facemash-hackgt13-voice"
	voiceAPI       = "https://api.elevenlabs.io"
	voiceMaxCall   = 180 * time.Second // the agent hangs up by then
	voiceSilentFor = 30 * time.Second  // and hangs up this long after the person last spoke, so a dead mic can't run the clock
	// a started call counts against the cap until it's finished or this old
	voiceLiveFor = voiceMaxCall + time.Minute
	// pending calls are forgotten after this (finish then says "start again"); by then the
	// transcript sweep may have deleted the call at ElevenLabs anyway
	voicePendingFor = voiceSweepAge
	voiceStarts     = 3                      // calls per person...
	voiceStartEvery = 20 * time.Minute       // ...one back every 20 minutes: 3 an hour
	voiceMaxAnswer  = 2000                   // bytes of one answer
	voiceMaxDone    = 5000                   // finished calls remembered (for idempotent finish)
	voiceVoiceID    = "cgSgspJ2msm6clMCkdW9" // "Jessica": bright, warm, conversational American English
	// transcripts don't stay at ElevenLabs: each is deleted once its answers are saved, and a sweep
	// deletes any this old (calls nobody finished) every voiceSweepEvery
	voiceSweepAge   = 15 * time.Minute
	voiceSweepEvery = 10 * time.Minute
	// the agent's own retention, the backstop (0 would delete a transcript before we can read it)
	voiceRetentionDays = 1
)

// the five questions, in order; the agent asks exactly these
var voiceQuestions = []string{
	"What are you building this weekend, and what's the part you're most excited about?",
	"What's the one thing you're stuck on right now, the bug or problem you'd love help with?",
	"What's something you're really good at that you could help someone else with here?",
	"What's a niche thing you're into that almost nobody else here shares?",
	"Who would be your dream person to meet this weekend, and why?",
}

// a phrase from each question that marks the agent asking it (the page uses the same ones)
var voiceMarks = [][]string{
	{"building this weekend", "what are you building"},
	{"stuck on", "love help with"},
	{"really good at", "help someone else"},
	{"niche", "nobody else here"},
	{"dream person", "meet this weekend"},
}

var errVoiceKey = errors.New("elevenlabs: no key worked")

// voiceKey is one ElevenLabs account: its key, and the agent that lives in it.
type voiceKey struct {
	name  string // "primary" or "backup", for logs (never the key)
	key   string
	agent string

	mu      sync.Mutex
	skipTil time.Time // after an auth or quota error, the other key goes first until then
}

func (k *voiceKey) skipped(now time.Time) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return now.Before(k.skipTil)
}

func (k *voiceKey) skip(d time.Duration) {
	k.mu.Lock()
	k.skipTil = time.Now().Add(d)
	k.mu.Unlock()
}

type voiceCall struct {
	tenant  string
	id      int64
	nonce   string // secret to this call; the page passes it to the agent as a dynamic variable
	convID  string // when ElevenLabs puts it in the signed URL
	key     *voiceKey
	started time.Time
	done    bool
}

type voiceGuide struct {
	keys []*voiceKey
	api  string
	http *http.Client
	cap  int // calls in progress at once, everyone together

	starts   *keyLimiter
	finishes *keyLimiter

	mu       sync.Mutex
	calls    []*voiceCall           // pending and recent, oldest first
	finished map[string]voiceResult // conversation id → what was saved
	saving   map[string]bool        // conversation ids being saved right now
	order    []string               // finished, oldest first (to bound the map)
	pollWait time.Duration          // between transcript polls
	pollFor  time.Duration          // how long finish waits for ElevenLabs to wrap up
	now      func() time.Time       // read under mu

	forgetWaits []time.Duration // before each retry of deleting a transcript at ElevenLabs
	bg          sync.WaitGroup  // those deletions (tests wait on it)
}

type voiceAnswer struct {
	Q string `json:"q"`
	A string `json:"a"`
}

type voiceResult struct {
	tenant   string
	id       int64
	KB       float64       `json:"kb"`
	Redacted int           `json:"redacted"`
	Answers  []voiceAnswer `json:"answers"`
}

// secretEnv reads NAME, or the file named by NAME_FILE.
func secretEnv(name string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	if f := os.Getenv(name + "_FILE"); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

// voiceKeys: ELEVENLABS_API_KEY(_FILE) with ELEVENLABS_AGENT_ID, then
// ELEVENLABS_API_KEY_BACKUP(_FILE) with ELEVENLABS_AGENT_ID_BACKUP (default: the same agent,
// for a second key on the same account).
func voiceKeys() []*voiceKey {
	var ks []*voiceKey
	agent := strings.TrimSpace(os.Getenv("ELEVENLABS_AGENT_ID"))
	if k := secretEnv("ELEVENLABS_API_KEY"); k != "" {
		ks = append(ks, &voiceKey{name: "primary", key: k, agent: agent})
	}
	if k := secretEnv("ELEVENLABS_API_KEY_BACKUP"); k != "" {
		ks = append(ks, &voiceKey{name: "backup", key: k, agent: envOr("ELEVENLABS_AGENT_ID_BACKUP", agent)})
	}
	return ks
}

// openVoice turns voice onboarding on when there's a key with an agent; nil (off) otherwise.
func openVoice() *voiceGuide {
	var ks []*voiceKey
	for _, k := range voiceKeys() {
		if k.agent != "" {
			ks = append(ks, k)
		}
	}
	if len(ks) == 0 {
		return nil
	}
	cp, _ := strconv.Atoi(os.Getenv("VOICE_MAX_CALLS"))
	if cp <= 0 {
		cp = 12
	}
	names := []string{}
	for _, k := range ks {
		names = append(names, k.name)
	}
	log.Printf("voice: on (%s key%s), at most %d calls at once", strings.Join(names, " + "), map[bool]string{true: "s"}[len(ks) > 1], cp)
	v := newVoiceGuide(ks, voiceAPI, cp)
	go v.sweepEvery(voiceSweepEvery)
	return v
}

func newVoiceGuide(keys []*voiceKey, api string, cap int) *voiceGuide {
	return &voiceGuide{
		keys: keys, api: strings.TrimRight(api, "/"), http: &http.Client{Timeout: 10 * time.Second}, cap: cap,
		starts:   newKeyLimiter(voiceStarts, voiceStartEvery, 0),
		finishes: newKeyLimiter(10, 30*time.Second, 1),
		finished: map[string]voiceResult{}, saving: map[string]bool{},
		pollWait: 1500 * time.Millisecond, pollFor: 15 * time.Second, now: time.Now,
		forgetWaits: []time.Duration{2 * time.Second, 10 * time.Second, 30 * time.Second, 2 * time.Minute},
	}
}

// upstreamError is ElevenLabs saying no; code 0 means we never got an answer.
type upstreamError struct {
	code int
	msg  string
}

func (e *upstreamError) Error() string { return fmt.Sprintf("elevenlabs %d: %s", e.code, e.msg) }

// call makes one request with one key. Error bodies are kept short and never carry the key.
func (v *voiceGuide) call(ctx context.Context, k *voiceKey, method, path string, body, out any) error {
	_, err := v.do(ctx, k, method, path, body, out)
	return err
}

// do is call, also giving the HTTP status (0 when there was no answer).
func (v *voiceGuide) do(ctx context.Context, k *voiceKey, method, path string, body, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, v.api+path, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("xi-api-key", k.key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := v.http.Do(req)
	if err != nil {
		return 0, &upstreamError{0, "unreachable"}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode/100 != 2 {
		msg := string(b)
		if len(msg) > 200 {
			msg = msg[:200]
		}
		msg = strings.ReplaceAll(msg, k.key, "[key]")
		return res.StatusCode, &upstreamError{res.StatusCode, msg}
	}
	if out != nil {
		return res.StatusCode, json.Unmarshal(b, out)
	}
	return res.StatusCode, nil
}

// deleteConv deletes one conversation (its transcript) in k's account. Gone already counts as
// done. It gives the status only: the body could quote the conversation.
func (v *voiceGuide) deleteConv(ctx context.Context, k *voiceKey, convID string) (int, bool) {
	code, _ := v.do(ctx, k, http.MethodDelete, "/v1/convai/conversations/"+url.PathEscape(convID), nil, nil)
	return code, code/100 == 2 || code == http.StatusNotFound
}

// forget deletes a saved call's transcript at ElevenLabs, in the background, retrying on
// failure (the sweep and the agent's retention setting catch anything still left).
func (v *voiceGuide) forget(k *voiceKey, convID string, id int64) {
	v.bg.Add(1)
	go func() {
		defer v.bg.Done()
		for try := 0; ; try++ {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			code, ok := v.deleteConv(ctx, k, convID)
			cancel()
			if ok {
				log.Printf("voice: #%d transcript deleted at ElevenLabs: %d", id, code)
				return
			}
			if try >= len(v.forgetWaits) {
				log.Printf("voice: #%d transcript not deleted at ElevenLabs: %d (the sweep will retry)", id, code)
				return
			}
			time.Sleep(v.forgetWaits[try])
		}
	}()
}

// sweepTranscripts deletes this agent's conversations that started over voiceSweepAge ago: calls that
// were never finished (a closed tab, a dropped connection), so never forgotten by finish.
// It returns how many it deleted.
func (v *voiceGuide) sweepTranscripts(ctx context.Context) int {
	v.mu.Lock()
	now := v.now()
	v.mu.Unlock()
	cutoff := now.Add(-voiceSweepAge)
	deleted, failed := 0, map[int]int{}
	seen := map[string]bool{} // agents already swept (both keys can share one)
	for _, k := range v.keys {
		if k.agent == "" || seen[k.agent] {
			continue
		}
		var old []string
		cursor, listed := "", false
		for page := 0; page < 20; page++ {
			q := url.Values{"agent_id": {k.agent}, "page_size": {"100"}, "call_start_before_unix": {strconv.FormatInt(cutoff.Unix(), 10)}}
			if cursor != "" {
				q.Set("cursor", cursor)
			}
			var list struct {
				Conversations []struct {
					ConversationID string `json:"conversation_id"`
					AgentID        string `json:"agent_id"`
					StartTime      int64  `json:"start_time_unix_secs"`
					Status         string `json:"status"`
				} `json:"conversations"`
				HasMore    bool   `json:"has_more"`
				NextCursor string `json:"next_cursor"`
			}
			code, err := v.do(ctx, k, http.MethodGet, "/v1/convai/conversations?"+q.Encode(), nil, &list)
			if err != nil {
				log.Printf("voice: sweep: listing on the %s key: %d", k.name, code)
				break
			}
			listed = true
			for _, c := range list.Conversations {
				// only ours, only old, and never one being saved right now
				if c.AgentID != k.agent || c.StartTime == 0 || !time.Unix(c.StartTime, 0).Before(cutoff) || c.Status == "in-progress" || c.Status == "initiated" {
					continue
				}
				v.mu.Lock()
				busy := v.saving[c.ConversationID]
				v.mu.Unlock()
				if !busy {
					old = append(old, c.ConversationID)
				}
			}
			if !list.HasMore || list.NextCursor == "" {
				break
			}
			cursor = list.NextCursor
		}
		if listed {
			seen[k.agent] = true
		}
		for _, id := range old {
			if code, ok := v.deleteConv(ctx, k, id); ok {
				deleted++
			} else {
				failed[code]++
			}
		}
	}
	if deleted > 0 || len(failed) > 0 {
		log.Printf("voice: sweep deleted %d old transcript(s) at ElevenLabs; failed: %v", deleted, failed)
	}
	return deleted
}

// sweepEvery runs sweepTranscripts now and then every d, for as long as the server runs.
func (v *voiceGuide) sweepEvery(d time.Duration) {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		v.sweepTranscripts(ctx)
		cancel()
		time.Sleep(d)
	}
}

// failover says whether an error from one key means "try the other one", and for how long
// to put this one to the back.
func failover(err error) (bool, time.Duration) {
	var ue *upstreamError
	if !errors.As(err, &ue) {
		return false, 0
	}
	low := strings.ToLower(ue.msg)
	quota := strings.Contains(low, "quota") || strings.Contains(low, "limit_exceeded") || strings.Contains(low, "too_many_concurrent")
	// a bad key can also come back as a 400 ("authentication_error" / "invalid_api_key")
	auth := strings.Contains(low, "authentication_error") || strings.Contains(low, "invalid_api_key")
	switch {
	case ue.code == http.StatusUnauthorized || auth:
		return true, time.Hour // a bad key stays bad
	case ue.code == http.StatusForbidden || ue.code == http.StatusTooManyRequests || ue.code == http.StatusPaymentRequired || quota:
		return true, 2 * time.Minute
	case ue.code == 0 || ue.code >= 500:
		return true, 0
	}
	return false, 0
}

// withKey runs f with each usable key in turn, healthy ones first, until one works.
func (v *voiceGuide) withKey(ctx context.Context, what string, f func(*voiceKey) error) (*voiceKey, error) {
	now := time.Now()
	order := make([]*voiceKey, 0, len(v.keys))
	for _, k := range v.keys {
		if !k.skipped(now) {
			order = append(order, k)
		}
	}
	for _, k := range v.keys {
		if k.skipped(now) { // all bad: try them anyway, last resort
			order = append(order, k)
		}
	}
	err := errVoiceKey
	for i, k := range order {
		if err = f(k); err == nil {
			if i > 0 {
				log.Printf("voice: %s worked on the %s key", what, k.name)
			}
			return k, nil
		}
		next, d := failover(err)
		if d > 0 {
			k.skip(d)
		}
		log.Printf("voice: %s on the %s key: %v", what, k.name, err)
		if !next {
			return nil, err
		}
	}
	return nil, err
}

func voiceNonce() string {
	b := make([]byte, 18)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// sweep forgets old pending calls. Must hold v.mu.
func (v *voiceGuide) sweep(now time.Time) {
	i := 0
	for i < len(v.calls) && now.Sub(v.calls[i].started) > voicePendingFor {
		i++
	}
	v.calls = v.calls[i:]
}

// live counts calls that may still be going. Must hold v.mu.
func (v *voiceGuide) live(now time.Time) int {
	n := 0
	for _, c := range v.calls {
		if !c.done && now.Sub(c.started) < voiceLiveFor {
			n++
		}
	}
	return n
}

type voiceStart struct {
	SignedURL string   `json:"signed_url"`
	Session   string   `json:"session"`
	FirstName string   `json:"first_name"`
	Questions []string `json:"questions"`
	MaxSecs   int      `json:"max_seconds"`
}

// start mints a signed URL for one call and remembers it as (tenant, id)'s.
func (v *voiceGuide) start(ctx context.Context, tenant string, id int64, first string) (voiceStart, error) {
	v.mu.Lock()
	now := v.now()
	v.sweep(now)
	if v.live(now) >= v.cap {
		v.mu.Unlock()
		return voiceStart{}, errVoiceBusy
	}
	c := &voiceCall{tenant: tenant, id: id, nonce: voiceNonce(), started: now}
	v.calls = append(v.calls, c) // holds its place under the cap while we ask
	v.mu.Unlock()

	var signed string
	k, err := v.withKey(ctx, "signed URL", func(k *voiceKey) error {
		var out struct {
			SignedURL string `json:"signed_url"`
		}
		q := url.Values{"agent_id": {k.agent}, "include_conversation_id": {"true"}}
		if err := v.call(ctx, k, http.MethodGet, "/v1/convai/conversation/get-signed-url?"+q.Encode(), nil, &out); err != nil {
			return err
		}
		if !strings.HasPrefix(out.SignedURL, "wss://") && !strings.HasPrefix(out.SignedURL, "ws://") {
			return &upstreamError{502, "no signed url"}
		}
		signed = out.SignedURL
		return nil
	})
	v.mu.Lock()
	defer v.mu.Unlock()
	if err != nil {
		c.done = true
		return voiceStart{}, err
	}
	c.key = k
	if u, err := url.Parse(signed); err == nil {
		c.convID = u.Query().Get("conversation_id")
	}
	return voiceStart{SignedURL: signed, Session: c.nonce, FirstName: first, Questions: voiceQuestions, MaxSecs: int(voiceMaxCall / time.Second)}, nil
}

var (
	errVoiceBusy     = errors.New("voice: at capacity")
	errVoiceNotYours = errors.New("voice: not this person's call")
	errVoiceNotDone  = errors.New("voice: call still wrapping up")
)

// conversation is the part of GET /v1/convai/conversations/{id} we use.
type conversation struct {
	AgentID        string `json:"agent_id"`
	ConversationID string `json:"conversation_id"`
	Status         string `json:"status"`
	Transcript     []struct {
		Role    string  `json:"role"`
		Message *string `json:"message"`
	} `json:"transcript"`
	Metadata struct {
		StartTime int64   `json:"start_time_unix_secs"`
		Duration  float64 `json:"call_duration_secs"`
	} `json:"metadata"`
	ClientData struct {
		Vars map[string]any `json:"dynamic_variables"`
	} `json:"conversation_initiation_client_data"`
}

// owns: is conv the call c started? The agent must match, and either the conversation id
// ElevenLabs gave us with the signed URL, or the secret the page passed in at the start.
func (c *voiceCall) owns(convID string, conv conversation) bool {
	if c.key == nil || conv.AgentID != c.key.agent {
		return false
	}
	if conv.Metadata.StartTime != 0 && time.Unix(conv.Metadata.StartTime, 0).Before(c.started.Add(-time.Minute)) {
		return false
	}
	if c.convID != "" && c.convID == convID {
		return true
	}
	s, _ := conv.ClientData.Vars["fm_session"].(string)
	return s != "" && s == c.nonce
}

// fetch polls a conversation until ElevenLabs has finished it (or we stop waiting).
func (v *voiceGuide) fetch(ctx context.Context, k *voiceKey, convID string) (conversation, error) {
	deadline := time.Now().Add(v.pollFor)
	for {
		var conv conversation
		err := v.call(ctx, k, http.MethodGet, "/v1/convai/conversations/"+url.PathEscape(convID), nil, &conv)
		if err != nil {
			var ue *upstreamError
			if errors.As(err, &ue) && (ue.code == 0 || ue.code >= 500) && time.Now().Before(deadline) {
				// a blip: try again below
			} else {
				return conv, err
			}
		} else if conv.Status == "done" || conv.Status == "failed" {
			return conv, nil
		} else if !time.Now().Before(deadline) {
			if conv.Status == "processing" { // the call is over; only the analysis is left
				return conv, nil
			}
			return conv, errVoiceNotDone
		}
		select {
		case <-ctx.Done():
			return conv, ctx.Err()
		case <-time.After(v.pollWait):
		}
	}
}

// memoryFrom turns a transcript into a memory: only what the person said, filed under the
// question they were answering. The agent's own lines are used only to tell which that is.
func memoryFrom(name, first string, conv conversation, now time.Time) (map[string]any, []voiceAnswer) {
	answers := make([]strings.Builder, len(voiceQuestions))
	cur := -1
	for _, t := range conv.Transcript {
		if t.Message == nil {
			continue
		}
		msg := strings.TrimSpace(*t.Message)
		switch t.Role {
		case "agent":
			if q := whichQuestion(msg, cur); q >= 0 {
				cur = q
			}
		case "user":
			if cur < 0 || msg == "" || msg == "..." {
				continue // hellos before the first question
			}
			b := &answers[cur]
			if b.Len()+len(msg) > voiceMaxAnswer {
				continue
			}
			if b.Len() > 0 {
				b.WriteString(" ")
			}
			b.WriteString(msg)
		}
	}
	if first == "" {
		first = name
	}
	var md strings.Builder
	md.WriteString("# What " + first + " told the HackGT voice guide\n")
	var out []voiceAnswer
	for i, b := range answers {
		if a := strings.TrimSpace(b.String()); a != "" && utf8.ValidString(a) {
			md.WriteString("\n## " + voiceQuestions[i] + "\n" + a + "\n")
			out = append(out, voiceAnswer{Q: voiceQuestions[i], A: a})
		}
	}
	return map[string]any{
		"user_id":     name,
		"exported_at": now.UTC().Format(time.RFC3339),
		"user_md":     md.String(),
		"source":      "voice",
	}, out
}

// whichQuestion: the question an agent line asks, if any. Only a later question than the
// current one counts, so a follow-up or a recap doesn't send answers backwards.
func whichQuestion(msg string, cur int) int {
	m := strings.ToLower(strings.ReplaceAll(msg, "’", "'"))
	for q := cur + 1; q < len(voiceMarks); q++ {
		for _, mark := range voiceMarks[q] {
			if strings.Contains(m, mark) {
				return q
			}
		}
	}
	return -1
}

// finish saves a finished call as (tenant, id)'s memory. Calling it again for the same
// call gives the same answer; someone else's call is refused.
func (v *voiceGuide) finish(ctx context.Context, acc *accounts, tenant string, id int64, convID string) (voiceResult, error) {
	v.mu.Lock()
	if r, ok := v.finished[convID]; ok {
		v.mu.Unlock()
		if r.tenant != tenant || r.id != id {
			return voiceResult{}, errVoiceNotYours
		}
		return r, nil
	}
	if v.saving[convID] {
		v.mu.Unlock()
		return voiceResult{}, errVoiceNotDone
	}
	// this person's calls, newest first; with a conversation id from the signed URL, only that one
	var mine []*voiceCall
	for i := len(v.calls) - 1; i >= 0; i-- {
		c := v.calls[i]
		if c.tenant == tenant && c.id == id && c.key != nil && (c.convID == "" || c.convID == convID) {
			mine = append(mine, c)
		}
	}
	if len(mine) == 0 {
		v.mu.Unlock()
		return voiceResult{}, errVoiceNotYours
	}
	v.saving[convID] = true
	v.mu.Unlock()
	defer func() {
		v.mu.Lock()
		delete(v.saving, convID)
		v.mu.Unlock()
	}()

	// the conversation lives in the account whose key started it: ask each of those once
	var (
		conv  conversation
		owner *voiceCall
	)
	asked := map[*voiceKey]bool{}
	for _, c := range mine {
		if asked[c.key] {
			continue
		}
		asked[c.key] = true
		got, err := v.fetch(ctx, c.key, convID)
		if err != nil {
			var ue *upstreamError
			if errors.As(err, &ue) && (ue.code == http.StatusNotFound || ue.code == http.StatusUnprocessableEntity || ue.code == http.StatusBadRequest) {
				continue // not in this account
			}
			return voiceResult{}, err
		}
		for _, cc := range mine {
			if cc.key == c.key && cc.owns(convID, got) {
				conv, owner = got, cc
				break
			}
		}
		if owner != nil {
			break
		}
	}
	if owner == nil {
		log.Printf("voice: #%d finish refused: conversation isn't theirs", id)
		return voiceResult{}, errVoiceNotYours
	}

	// the call happened whatever comes next: count it once (a retried finish is answered above)
	secs := conv.Metadata.Duration
	if secs <= 0 || secs > voiceLiveFor.Seconds() {
		secs = math.Min(time.Since(owner.started).Seconds(), voiceMaxCall.Seconds()) // not reported: at most the cap
	}
	meter.add("voice", "elevenlabs", true, 0, 0, secs)

	a, err := acc.store.Account(ctx, tenant, id)
	if err != nil {
		return voiceResult{}, err
	}
	name := a.User.Name
	if name == "" {
		name = a.Profile.Name
	}
	first := a.User.Given
	if first == "" {
		first, _, _ = strings.Cut(name, " ")
	}
	obj, answers := memoryFrom(name, first, conv, time.Now())
	res := voiceResult{tenant: tenant, id: id, Answers: []voiceAnswer{}}
	if len(answers) > 0 {
		body, redacted, err := ingestMemory(ctx, acc, tenant, id, obj, nil, "voice memory")
		if err != nil {
			return voiceResult{}, err
		}
		res.KB, res.Redacted = float64(len(body)*10/1024)/10, redacted
		// show them what was kept: the answers as stored, credentials scrubbed
		scratch := map[string]int{}
		for _, an := range answers {
			res.Answers = append(res.Answers, voiceAnswer{Q: an.Q, A: redactText(an.A, scratch)})
		}
	}
	log.Printf("voice: #%d saved %d answer(s), %.1f KB, %d redacted", id, len(res.Answers), res.KB, res.Redacted)
	// saved: ElevenLabs doesn't need its copy any more
	v.forget(owner.key, convID, id)

	v.mu.Lock()
	owner.done = true
	v.finished[convID] = res
	v.order = append(v.order, convID)
	if len(v.order) > voiceMaxDone {
		delete(v.finished, v.order[0])
		v.order = v.order[1:]
	}
	v.mu.Unlock()
	return res, nil
}

// mountVoice adds /api/voice/start and /api/voice/finish (signed-in people, from our own
// pages). With voice off they say so, and /api/me tells the page not to offer it.
func mountVoice(mux *http.ServeMux, acc *accounts, v *voiceGuide, originOK func(*http.Request) bool) {
	writeJSON := func(w http.ResponseWriter, code int, val any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(val)
	}
	// who: from the session only, and only for posts from our own pages
	who := func(w http.ResponseWriter, r *http.Request) (int64, bool) {
		if v == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice isn't switched on"})
			return 0, false
		}
		if r.Method != http.MethodPost || r.Header.Get("Origin") == "" || !originOK(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad origin"})
			return 0, false
		}
		id, ok := acc.sess.read(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in first"})
			return 0, false
		}
		return id, true
	}
	retry := func(w http.ResponseWriter, wait time.Duration) {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(wait.Seconds())))))
	}

	mux.HandleFunc("/api/voice/start", func(w http.ResponseWriter, r *http.Request) {
		id, ok := who(w, r)
		if !ok {
			return
		}
		release, wait, ok := v.starts.acquire(fastWho{acc.tenant, id})
		if !ok {
			retry(w, wait)
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "that's a few calls already: try again in a little while"})
			return
		}
		release() // a token per call; nothing in flight to hold
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		first := ""
		if a, err := acc.store.Account(ctx, acc.tenant, id); err == nil {
			first = a.User.Given
			if first == "" {
				first, _, _ = strings.Cut(a.User.Name, " ")
			}
		}
		out, err := v.start(ctx, acc.tenant, id, cleanText(first, 40))
		switch {
		case errors.Is(err, errVoiceBusy):
			retry(w, 30*time.Second)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lots of people are talking right now: try again in a minute"})
		case err != nil:
			log.Printf("voice: #%d start: %v", id, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the voice guide isn't answering: try again in a moment"})
		default:
			log.Printf("voice: #%d call started", id)
			writeJSON(w, http.StatusOK, out)
		}
	})

	mux.HandleFunc("/api/voice/finish", func(w http.ResponseWriter, r *http.Request) {
		id, ok := who(w, r)
		if !ok {
			return
		}
		release, wait, ok := v.finishes.acquire(fastWho{acc.tenant, id})
		if !ok {
			retry(w, wait)
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "one moment"})
			return
		}
		defer release()
		var in struct {
			ConversationID string `json:"conversation_id"`
		}
		b, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
		if json.Unmarshal(bytes.TrimSpace(b), &in) != nil || !convIDOK(in.ConversationID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing conversation_id"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		res, err := v.finish(ctx, acc, acc.tenant, id, in.ConversationID)
		switch {
		case errors.Is(err, errVoiceNotYours):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "that call isn't yours (or it's too old): start a new one"})
		case errors.Is(err, errVoiceNotDone):
			retry(w, 3*time.Second)
			writeJSON(w, http.StatusConflict, map[string]string{"error": "still wrapping up the call"})
		case err != nil:
			log.Printf("voice: #%d finish: %v", id, err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "couldn't save it just now: try again in a moment"})
		default:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "kb": res.KB, "redacted": res.Redacted, "answers": res.Answers})
		}
	})
}

// convIDOK: ElevenLabs conversation ids are short and URL-safe ("conv_…").
func convIDOK(s string) bool {
	if s == "" || len(s) > 100 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// voiceAgentConfig is the agent, as ElevenLabs stores it (see provisionVoice).
func voiceAgentConfig() map[string]any {
	var qs strings.Builder
	for i, q := range voiceQuestions {
		fmt.Fprintf(&qs, "%d. %s\n", i+1, q)
	}
	prompt := `You are the HackGT 13 voice guide for facemash, the virtual campus for HackGT 13 (Georgia Tech's hackathon, September 25-27 2026). You are talking with {{first_name}}, an attendee, on their phone. Your only job is to ask them these five questions, so their bean (their avatar) and the event can get to know them:

` + qs.String() + `
How to run the call:
- Your first message already asked question 1. Ask the rest one at a time, in this order, word for word, each only once the person has answered the one before.
- Be warm, natural and brief: at most a few words of acknowledgement between questions ("Love that." / "Nice."), then the next question. Don't give advice, don't summarize, don't answer your own questions.
- If an answer is very short (a word or two), ask one short, friendly follow-up, then move on. Never more than one follow-up per question. If they'd rather skip a question, that's fine: move on.
- After the fifth answer, thank them and say, in one sentence ending with "your bean is getting dressed": for example "Thanks {{first_name}}, that's everything, your bean is getting dressed." Then call end_call right away, in that same turn: don't wait for a reply and don't say anything else.
- Never ask for contact details, phone numbers, emails, addresses, passwords, codes, or anything sensitive. If they say a password, key, code or number like that, don't repeat it back; just move on.
- Before the fifth answer, if they go quiet, check in once, briefly ("Still there?"). If there's still no answer, say "No worries, you can come back to this any time on the Muse page." and end the call. Don't keep asking.
- If they ask what this is: their answers become the memory facemash uses to dress their bean and help them find people at HackGT; they can delete it on the Muse page.
- Keep the whole call under three minutes. Speak English.`
	return map[string]any{
		"name": voiceAgentName,
		"tags": []string{"facemash", "hackgt13"},
		"conversation_config": map[string]any{
			"agent": map[string]any{
				"first_message": "Hi {{first_name}}, I'm the HackGT 13 voice guide for facemash, and I've got five quick questions so your bean can get to know you. First: " + voiceQuestions[0],
				"language":      "en",
				"prompt": map[string]any{
					"prompt": prompt,
					"llm":    envOr("ELEVENLABS_LLM", "gpt-4o-mini"), // quick, and follows a script
					"tools":  []any{map[string]any{"type": "system", "name": "end_call", "description": "End the call after the thank-you."}},
				},
				"dynamic_variables": map[string]any{
					"dynamic_variable_placeholders": map[string]any{"first_name": "there", "fm_session": "none"},
				},
			},
			"tts": map[string]any{
				"voice_id": envOr("ELEVENLABS_VOICE_ID", voiceVoiceID),
				"model_id": "eleven_flash_v2",
			},
			"conversation": map[string]any{
				"max_duration_seconds": int(voiceMaxCall / time.Second),
			},
			"turn": map[string]any{
				"silence_end_call_timeout": int(voiceSilentFor / time.Second),
			},
		},
		"platform_settings": map[string]any{
			"auth": map[string]any{"enable_auth": true}, // signed URLs only: our server decides who talks
			// we keep no audio, and ask them not to record it; transcripts are deleted by us once
			// saved (forget, sweep), and this is the backstop: anything left goes after a day
			"privacy": map[string]any{"record_voice": false, "retention_days": voiceRetentionDays, "delete_transcript_and_pii": true, "delete_audio": true},
		},
	}
}

// provisionVoice creates the agent (or updates the one named voiceAgentName) in the account
// of the chosen key ("primary", "backup", or "" for the first that works) and prints its id.
func provisionVoice(which string) {
	ks := voiceKeys()
	if which != "" {
		var only []*voiceKey
		for _, k := range ks {
			if k.name == which {
				only = append(only, k)
			}
		}
		ks = only
	}
	if len(ks) == 0 {
		log.Fatalf("voice: no ElevenLabs key (set ELEVENLABS_API_KEY or ELEVENLABS_API_KEY_BACKUP, or their _FILE)")
	}
	v := newVoiceGuide(ks, envOr("ELEVENLABS_API", voiceAPI), 1)
	v.http.Timeout = 30 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cfg := voiceAgentConfig()
	var agentID string
	k, err := v.withKey(ctx, "provision", func(k *voiceKey) error {
		var list struct {
			Agents []struct {
				AgentID string `json:"agent_id"`
				Name    string `json:"name"`
			} `json:"agents"`
		}
		if err := v.call(ctx, k, http.MethodGet, "/v1/convai/agents?page_size=100&search="+url.QueryEscape(voiceAgentName), nil, &list); err != nil {
			return err
		}
		for _, a := range list.Agents {
			if a.Name == voiceAgentName {
				agentID = a.AgentID
				return v.call(ctx, k, http.MethodPatch, "/v1/convai/agents/"+url.PathEscape(a.AgentID), cfg, nil)
			}
		}
		var out struct {
			AgentID string `json:"agent_id"`
		}
		if err := v.call(ctx, k, http.MethodPost, "/v1/convai/agents/create", cfg, &out); err != nil {
			return err
		}
		agentID = out.AgentID
		return nil
	})
	if err != nil {
		log.Fatalf("voice: provisioning failed: %v", err)
	}
	// read it back: ElevenLabs drops fields it doesn't know without saying so
	var got struct {
		ConversationConfig struct {
			Conversation struct {
				MaxDurationSeconds float64 `json:"max_duration_seconds"`
			} `json:"conversation"`
			Turn struct {
				SilenceEndCallTimeout float64 `json:"silence_end_call_timeout"`
			} `json:"turn"`
		} `json:"conversation_config"`
		PlatformSettings struct {
			Privacy struct {
				RecordVoice            bool `json:"record_voice"`
				RetentionDays          int  `json:"retention_days"`
				DeleteTranscriptAndPII bool `json:"delete_transcript_and_pii"`
			} `json:"privacy"`
		} `json:"platform_settings"`
	}
	readErr := v.call(ctx, k, http.MethodGet, "/v1/convai/agents/"+url.PathEscape(agentID), nil, &got)
	if readErr != nil {
		log.Printf("voice: couldn't read the agent back: %v", readErr)
	} else if cc := got.ConversationConfig; cc.Conversation.MaxDurationSeconds != voiceMaxCall.Seconds() || cc.Turn.SilenceEndCallTimeout != voiceSilentFor.Seconds() {
		log.Printf("voice: WARNING the agent didn't keep its limits: max_duration_seconds %v (want %v), silence_end_call_timeout %v (want %v)",
			cc.Conversation.MaxDurationSeconds, voiceMaxCall.Seconds(), cc.Turn.SilenceEndCallTimeout, voiceSilentFor.Seconds())
	} else {
		log.Printf("voice: agent limits confirmed: %v s per call, hangs up after %v s of silence", cc.Conversation.MaxDurationSeconds, cc.Turn.SilenceEndCallTimeout)
	}
	if readErr == nil {
		if p := got.PlatformSettings.Privacy; p.RecordVoice || p.RetentionDays != voiceRetentionDays || !p.DeleteTranscriptAndPII {
			log.Printf("voice: WARNING the agent didn't keep its privacy settings: record_voice %v, retention_days %d (want %d), delete_transcript_and_pii %v",
				p.RecordVoice, p.RetentionDays, voiceRetentionDays, p.DeleteTranscriptAndPII)
		} else {
			log.Printf("voice: agent privacy confirmed: no audio recorded, transcripts kept at most %d day(s)", p.RetentionDays)
		}
	}
	fmt.Fprintf(os.Stderr, "voice agent on the %s key (set ELEVENLABS_AGENT_ID%s):\n", k.name, map[bool]string{true: "_BACKUP"}[k.name == "backup"])
	fmt.Println(agentID)
}
