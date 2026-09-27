package main

// Voice onboarding without a live call: the page plays each question in the guide's voice
// (ElevenLabs text to speech, made once and cached: every attendee hears the same five
// clips), records the answer on the phone, and sends it here to be written down (ElevenLabs
// speech to text). Nothing waits on a call slot, so any number of people can do it at once.
// Each answer is saved as their memory the moment it's written down (all their answers so
// far, through the same door as a call's), so stopping halfway loses nothing and the end has
// nothing left to wait for. The page runs it hands-free: the next question plays while the
// last answer is still being written down.
//   GET  /api/voice/q/{intro|0..4}          the question, as audio (public: the same for everyone)
//   POST /api/voice/hear?q=N&run=R&secs=S   one recorded answer (the raw audio as the body)
//                                           → {text, saved}: saved = answers in their memory now
// The audio is never stored: it goes to ElevenLabs to be written down and is dropped.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	voiceTTSModel  = "eleven_flash_v2_5"
	voiceSTTModel  = "scribe_v1"
	voiceClipMax   = 6 << 20 // bytes of one recorded answer (a minute of phone audio is ~0.5-1 MB)
	voiceAnswerSec = 90      // seconds: longer answers are cut off by the page
	voiceIntro     = "Hi! I'm the HackGT voice guide. Five quick questions, and you can answer however you like. Tap the button when you're ready."
)

var voiceHears = newKeyLimiter(24, 20*time.Second, 3) // per person: five answers (a few at once while the next plays) and redos

// voiceDrafts: one person's answers in this run (a run is one pass through the questions,
// named by the page), so each save writes all of them. Kept an hour.
type voiceDraft struct {
	mu      sync.Mutex
	run     string
	answers []string
	at      time.Time
}

var (
	draftsMu sync.Mutex
	drafts   = map[fastWho]*voiceDraft{}
)

func draftFor(w fastWho, run string, now time.Time) *voiceDraft {
	draftsMu.Lock()
	defer draftsMu.Unlock()
	for k, d := range drafts {
		if now.Sub(d.at) > time.Hour {
			delete(drafts, k)
		}
	}
	d := drafts[w]
	if d == nil {
		d = &voiceDraft{}
		drafts[w] = d
	}
	d.mu.Lock()
	if d.run != run { // a new pass starts from nothing
		d.run, d.answers = run, make([]string, len(voiceQuestions))
	}
	d.at = now
	d.mu.Unlock()
	return d
}

// voiceClips: the questions as audio, made on first use and kept (the text never changes).
type voiceClips struct {
	mu    sync.Mutex
	clips map[string][]byte
	busy  map[string]chan struct{}
}

var clips = &voiceClips{clips: map[string][]byte{}, busy: map[string]chan struct{}{}}

func clipText(name string) (string, bool) {
	if name == "intro" {
		return voiceIntro, true
	}
	i, err := strconv.Atoi(name)
	if err != nil || i < 0 || i >= len(voiceQuestions) {
		return "", false
	}
	return voiceQuestions[i], true
}

// clip gives the audio for one clip, asking ElevenLabs only the first time (one request per
// clip however many people ask at once).
func (v *voiceGuide) clip(ctx context.Context, name string) ([]byte, error) {
	text, ok := clipText(name)
	if !ok {
		return nil, errors.New("no such clip")
	}
	for {
		clips.mu.Lock()
		if b, ok := clips.clips[name]; ok {
			clips.mu.Unlock()
			return b, nil
		}
		ch, busy := clips.busy[name]
		if !busy {
			ch = make(chan struct{})
			clips.busy[name] = ch
			clips.mu.Unlock()
			break
		}
		clips.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var audio []byte
	_, err := v.withKey(ctx, "speech", func(k *voiceKey) error {
		b, err := v.raw(ctx, k, "/v1/text-to-speech/"+envOr("ELEVENLABS_VOICE_ID", voiceVoiceID)+"?output_format=mp3_44100_64",
			"application/json", mustJSON(map[string]any{"text": text, "model_id": voiceTTSModel}))
		audio = b
		return err
	})
	meter.add("voice", "elevenlabs-tts", err == nil, 0, 0, 0)
	clips.mu.Lock()
	if err == nil && len(audio) > 0 {
		clips.clips[name] = audio
	}
	close(clips.busy[name])
	delete(clips.busy, name)
	clips.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return audio, nil
}

// warmClips makes all six clips in the background at boot, so the first person waits for none.
func (v *voiceGuide) warmClips() {
	for _, name := range []string{"intro", "0", "1", "2", "3", "4"} {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if _, err := v.clip(ctx, name); err != nil {
			log.Printf("voice: clip %s not made yet: %v", name, err)
		}
		cancel()
	}
}

// raw: one request with one key whose answer is not JSON (audio), or a multipart upload.
func (v *voiceGuide) raw(ctx context.Context, k *voiceKey, path, contentType string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.api+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("xi-api-key", k.key)
	req.Header.Set("Content-Type", contentType)
	res, err := v.http.Do(req)
	if err != nil {
		return nil, &upstreamError{0, "unreachable"}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode/100 != 2 {
		msg := string(b)
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return nil, &upstreamError{res.StatusCode, strings.ReplaceAll(msg, k.key, "[key]")}
	}
	return b, nil
}

// hear writes down one recorded answer.
func (v *voiceGuide) hear(ctx context.Context, audio []byte, contentType string) (string, error) {
	ext := "webm"
	switch {
	case strings.Contains(contentType, "mp4"), strings.Contains(contentType, "m4a"), strings.Contains(contentType, "aac"):
		ext = "m4a"
	case strings.Contains(contentType, "ogg"):
		ext = "ogg"
	case strings.Contains(contentType, "wav"):
		ext = "wav"
	case strings.Contains(contentType, "mpeg"):
		ext = "mp3"
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("model_id", voiceSTTModel)
	mw.WriteField("tag_audio_events", "false")
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="answer.`+ext+`"`)
	h.Set("Content-Type", contentType)
	fw, _ := mw.CreatePart(h)
	fw.Write(audio)
	mw.Close()
	var text string
	_, err := v.withKey(ctx, "transcription", func(k *voiceKey) error {
		b, err := v.raw(ctx, k, "/v1/speech-to-text", mw.FormDataContentType(), buf.Bytes())
		if err != nil {
			return err
		}
		var out struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(b, &out); err != nil {
			return &upstreamError{502, "unreadable transcript"}
		}
		text = out.Text
		return nil
	})
	return strings.TrimSpace(text), err
}

// cleanAnswer: what's kept of one answer (text only, capped).
func cleanAnswer(s string) string {
	s = cleanText(s, voiceMaxAnswer)
	if len(s) > voiceMaxAnswer {
		s = s[:voiceMaxAnswer]
	}
	return strings.ToValidUTF8(s, "")
}

// mountVoiceAsk adds the ask-and-record routes (see the top of this file).
func mountVoiceAsk(mux *http.ServeMux, acc *accounts, v *voiceGuide, originOK func(*http.Request) bool) {
	writeJSON := func(w http.ResponseWriter, code int, val any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(val)
	}
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
	busy := func(w http.ResponseWriter, wait time.Duration) {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(wait.Seconds())))))
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "one moment, then try that again"})
	}
	if v != nil {
		go v.warmClips()
	}

	mux.HandleFunc("/api/voice/q/", func(w http.ResponseWriter, r *http.Request) {
		if v == nil {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/api/voice/q/")
		if _, ok := clipText(name); !ok || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			http.NotFound(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		b, err := v.clip(ctx, name)
		if err != nil {
			log.Printf("voice: clip %s: %v", name, err)
			http.Error(w, "the voice guide isn't answering", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		w.Write(b)
	})

	mux.HandleFunc("/api/voice/hear", func(w http.ResponseWriter, r *http.Request) {
		id, ok := who(w, r)
		if !ok {
			return
		}
		release, wait, ok := voiceHears.acquire(fastWho{acc.tenant, id})
		if !ok {
			busy(w, wait)
			return
		}
		defer release()
		q, err := strconv.Atoi(r.URL.Query().Get("q"))
		if err != nil || q < 0 || q >= len(voiceQuestions) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "which question?"})
			return
		}
		run := r.URL.Query().Get("run")
		if len(run) < 8 || len(run) > 64 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "which run?"})
			return
		}
		ct := r.Header.Get("Content-Type")
		if !strings.HasPrefix(ct, "audio/") && !strings.HasPrefix(ct, "video/") { // Safari records audio as video/mp4
			writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "send the recording as audio"})
			return
		}
		audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, voiceClipMax))
		if err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "that answer is too long: try a shorter one"})
			return
		}
		if len(audio) < 1000 {
			writeJSON(w, http.StatusOK, map[string]any{"text": "", "saved": 0})
			return
		}
		secs, _ := strconv.ParseFloat(r.URL.Query().Get("secs"), 64)
		secs = math.Max(0, math.Min(secs, voiceAnswerSec))
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		text, err := v.hear(ctx, audio, ct)
		meter.add("voice", "elevenlabs-stt", err == nil, 0, 0, secs)
		if err != nil {
			log.Printf("voice: #%d answer %d not written down: %v", id, q+1, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "couldn't make that out just now: try again"})
			return
		}
		text = cleanAnswer(text)
		if text == "" {
			writeJSON(w, http.StatusOK, map[string]any{"text": "", "saved": 0})
			return
		}
		// into their memory now, with the answers before it (one save at a time per person)
		d := draftFor(fastWho{acc.tenant, id}, run, time.Now())
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.run != run {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "a newer run started"})
			return
		}
		d.answers[q] = text
		sctx, scancel := context.WithTimeout(context.Background(), 25*time.Second) // finish the save even if the page moves on
		defer scancel()
		res, err := saveVoiceMemory(sctx, acc, acc.tenant, id, func(name, first string) (map[string]any, []voiceAnswer) {
			return voiceMemory(name, first, d.answers, time.Now())
		})
		if err != nil {
			log.Printf("voice: #%d save after answer %d: %v", id, q+1, err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "heard you, but couldn't save that just now: try again"})
			return
		}
		log.Printf("voice: #%d answer %d saved (%d so far, %.1f KB)", id, q+1, len(res.Answers), res.KB)
		writeJSON(w, http.StatusOK, map[string]any{"text": text, "saved": len(res.Answers)})
	})
}
