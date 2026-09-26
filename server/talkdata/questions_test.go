package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The agent-talk question bank. TypeSafe Jev picks the next question in one
// "choice" call (max 255 options), so the bank must stay at or under 250.

type bankSource struct {
	Citation string `json:"citation"`
	UsedFor  string `json:"used_for"`
}

type bankQuestion struct {
	ID         string   `json:"id"`
	Type       string   `json:"type"`
	Text       string   `json:"text"`
	Depth      int      `json:"depth"`
	Consent    string   `json:"consent"`
	Informs    []string `json:"informs"`
	Horizon    string   `json:"horizon"`
	FollowupOK *bool    `json:"followup_ok"`
}

type questionBank struct {
	Version   string            `json:"version"`
	Sources   []bankSource      `json:"sources"`
	Types     map[string]string `json:"types"`
	Questions []bankQuestion    `json:"questions"`
}

var (
	bankTypes = []string{
		"now_at_hackgt", "building_and_craft", "stuck_and_solved", "career_and_path", "where_from",
		"interests_and_rare", "values_and_beliefs", "life_and_personal", "fun_and_play", "future_and_followup",
	}
	bankInforms = map[string]bool{
		"a_fixed_b": true, "b_fixed_a": true, "same_problem": true, "team": true, "going_through": true, "rare": true,
		"one_sided": true, "busy": true, "value": true, "soon": true, "talk_again": true, "depth": true,
	}
	bankSensitive = []string{
		"health", "family", "struggle", "anxiety", "money", "religion", "identity", "faith", "sick", "grief", "divorce",
	}
	// Questions must be open-ended: none may open with an auxiliary verb.
	bankYesNoStarts = []string{
		"is", "are", "do", "does", "did", "has", "have", "can", "could", "would", "will", "should", "was", "were",
	}
	bankDepthTarget = map[int]float64{1: 0.40, 2: 0.40, 3: 0.20}
)

func loadQuestionBank(t *testing.T) questionBank {
	t.Helper()
	raw, err := os.ReadFile("questions.json")
	if err != nil {
		t.Fatalf("read questions.json: %v", err)
	}
	if !json.Valid(raw) {
		t.Fatal("questions.json is not valid JSON")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var b questionBank
	if err := dec.Decode(&b); err != nil {
		t.Fatalf("decode questions.json: %v", err)
	}
	return b
}

func TestQuestionBank(t *testing.T) {
	b := loadQuestionBank(t)

	if b.Version == "" {
		t.Error("missing version")
	}
	if len(b.Sources) == 0 {
		t.Error("missing sources")
	}
	for i, s := range b.Sources {
		if strings.TrimSpace(s.Citation) == "" || strings.TrimSpace(s.UsedFor) == "" {
			t.Errorf("source %d needs citation and used_for", i)
		}
	}

	n := len(b.Questions)
	if n < 240 || n > 250 {
		t.Fatalf("got %d questions, want 240-250", n)
	}

	validType := map[string]bool{}
	for _, ty := range bankTypes {
		validType[ty] = true
		if strings.TrimSpace(b.Types[ty]) == "" {
			t.Errorf("types is missing a description for %q", ty)
		}
	}
	for ty := range b.Types {
		if !validType[ty] {
			t.Errorf("types has unknown type %q", ty)
		}
	}

	ids := map[string]bool{}
	texts := map[string]string{}
	perType := map[string]int{}
	perDepth := map[int]int{}

	for _, q := range b.Questions {
		if q.ID == "" {
			t.Errorf("question with empty id: %q", q.Text)
		}
		if ids[q.ID] {
			t.Errorf("duplicate id %s", q.ID)
		}
		ids[q.ID] = true

		norm := strings.ToLower(strings.Join(strings.Fields(q.Text), " "))
		if prev, ok := texts[norm]; ok {
			t.Errorf("%s duplicates the text of %s", q.ID, prev)
		}
		texts[norm] = q.ID

		if !validType[q.Type] {
			t.Errorf("%s: unknown type %q", q.ID, q.Type)
		}
		perType[q.Type]++

		if q.Depth < 1 || q.Depth > 3 {
			t.Errorf("%s: depth %d not in 1..3", q.ID, q.Depth)
		}
		perDepth[q.Depth]++

		if q.Consent != "none" && q.Consent != "okay_to_share" {
			t.Errorf("%s: bad consent %q", q.ID, q.Consent)
		}
		if q.Horizon != "now" && q.Horizon != "someday" {
			t.Errorf("%s: bad horizon %q", q.ID, q.Horizon)
		}
		if q.FollowupOK == nil {
			t.Errorf("%s: missing followup_ok", q.ID)
		}
		if len(q.Informs) == 0 {
			t.Errorf("%s: informs is empty", q.ID)
		}
		seenInf := map[string]bool{}
		for _, inf := range q.Informs {
			if !bankInforms[inf] {
				t.Errorf("%s: unknown informs %q", q.ID, inf)
			}
			if seenInf[inf] {
				t.Errorf("%s: informs lists %q twice", q.ID, inf)
			}
			seenInf[inf] = true
		}

		text := strings.TrimSpace(q.Text)
		if text == "" {
			t.Errorf("%s: empty text", q.ID)
			continue
		}
		if !strings.HasSuffix(text, "?") {
			t.Errorf("%s: text must end with '?': %q", q.ID, text)
		}
		if strings.Count(text, "?") != 1 {
			t.Errorf("%s: text must be exactly one question: %q", q.ID, text)
		}
		if w := len(strings.Fields(text)); w > 20 {
			t.Errorf("%s: %d words (max 20): %q", q.ID, w, text)
		}
		lower := strings.ToLower(text)
		first := strings.Trim(strings.Fields(lower)[0], ",")
		for _, aux := range bankYesNoStarts {
			if first == aux {
				t.Errorf("%s: reads as a yes/no question: %q", q.ID, text)
			}
		}
		if !strings.Contains(lower, "your human") {
			t.Errorf("%s: must be asked about \"your human\": %q", q.ID, text)
		}
		for _, kw := range bankSensitive {
			if strings.Contains(lower, kw) && q.Consent != "okay_to_share" {
				t.Errorf("%s: mentions %q but consent is %q, want okay_to_share", q.ID, kw, q.Consent)
			}
		}
	}

	for _, ty := range bankTypes {
		if perType[ty] < 20 {
			t.Errorf("type %s has %d questions, want >= 20", ty, perType[ty])
		}
	}

	for d, target := range bankDepthTarget {
		got := float64(perDepth[d]) / float64(n)
		if got < target-0.10 || got > target+0.10 {
			t.Errorf("depth %d is %.0f%% of the bank, want %.0f%% +/- 10%%", d, got*100, target*100)
		}
	}

	t.Logf("%d questions; depth 1/2/3 = %d/%d/%d; per type %v", n, perDepth[1], perDepth[2], perDepth[3], perType)
}
