// Package llm is lib/llm/{providers,json}.ts: the free-tier router that walks a
// provider order and, within each provider, a list of keys until one answers;
// a key that reports a quota or rate-limit error is parked until the next UTC
// midnight. Everything is plain HTTP, no SDKs.
//
// Exhaustion state is per-process, as in TS.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var providers = []string{"gemini", "groq", "openrouter", "mistral", "cerebras"}

var models = map[string]string{
	"cerebras": "llama3.1-8b", "gemini": "gemini-2.5-flash", "groq": "llama-3.1-8b-instant",
	"mistral": "mistral-small-latest", "openrouter": "mistralai/mistral-7b-instruct:free",
}

var chatEndpoints = map[string]string{
	"cerebras":   "https://api.cerebras.ai/v1/chat/completions",
	"groq":       "https://api.groq.com/openai/v1/chat/completions",
	"mistral":    "https://api.mistral.ai/v1/chat/completions",
	"openrouter": "https://openrouter.ai/api/v1/chat/completions",
}

const geminiURL = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"

// Options is LLMOptions; zero MaxTokens / nil Temperature take TS's defaults.
type Options struct {
	JSON         bool
	MaxTokens    int
	SystemPrompt string
	Temperature  *float64
}

// Router is the provider sweep. Keys are provider → keys (config.LLM.Keys),
// Order is LLM_PROVIDER_ORDER; Endpoints lets a test point providers at a stub.
type Router struct {
	Keys      map[string][]string
	Order     []string
	HTTP      *http.Client
	Endpoints map[string]string // provider → URL override
	Now       func() time.Time

	mu        sync.Mutex
	exhausted map[string]time.Time
}

func New(keys map[string][]string, order []string) *Router {
	return &Router{Keys: keys, Order: order, HTTP: &http.Client{}, Now: time.Now, exhausted: map[string]time.Time{}}
}

var errExhausted = errors.New("All AI providers and keys are currently exhausted or unconfigured.")

func (r *Router) order() []string {
	var out []string
	for _, n := range r.Order {
		n = strings.ToLower(strings.TrimSpace(n))
		for _, p := range providers {
			if n == p {
				out = append(out, n)
			}
		}
	}
	if len(out) == 0 {
		return providers
	}
	return out
}

func (r *Router) keysFor(p string) []string {
	var out []string
	for _, k := range r.Keys[p] {
		if k = strings.TrimSpace(k); k != "" {
			out = append(out, k)
		}
	}
	return out
}

// Configured is isLLMConfigured: at least one provider has a key.
func (r *Router) Configured() bool {
	for _, p := range r.order() {
		if len(r.keysFor(p)) > 0 {
			return true
		}
	}
	return false
}

func isQuotaError(msg string) bool {
	l := strings.ToLower(msg)
	for _, s := range []string{"429", "403", "quota", "rate limit", "too many requests"} {
		if strings.Contains(l, s) {
			return true
		}
	}
	return false
}

func (r *Router) endpoint(p, def string) string {
	if u := r.Endpoints[p]; u != "" {
		return u
	}
	return def
}

func (r *Router) post(ctx context.Context, url string, headers map[string]string, body any, out any) (int, error) {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := r.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return res.StatusCode, nil
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return res.StatusCode, err
	}
	return res.StatusCode, json.Unmarshal(b, out)
}

func (r *Router) runGemini(ctx context.Context, key, prompt string, o Options) (string, error) {
	var text []string
	if o.SystemPrompt != "" {
		text = append(text, "System Instruction:\n"+o.SystemPrompt)
	}
	text = append(text, "User Request:\n"+prompt)
	if o.JSON {
		text = append(text, "Respond ONLY in valid JSON.")
	}
	max, temp := o.MaxTokens, 0.7
	if max == 0 {
		max = 1024
	}
	if o.Temperature != nil {
		temp = *o.Temperature
	}
	gen := map[string]any{"maxOutputTokens": max, "temperature": temp}
	if o.JSON {
		gen["responseMimeType"] = "application/json"
	}
	body := map[string]any{
		"contents":         []any{map[string]any{"parts": []any{map[string]any{"text": strings.Join(text, "\n\n")}}}},
		"generationConfig": gen,
	}
	var data struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	status, err := r.post(ctx, r.endpoint("gemini", fmt.Sprintf(geminiURL, models["gemini"])), map[string]string{"x-goog-api-key": key}, body, &data)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 {
		return "", fmt.Errorf("Gemini HTTP %d", status)
	}
	var out strings.Builder
	if len(data.Candidates) > 0 {
		for _, p := range data.Candidates[0].Content.Parts {
			out.WriteString(p.Text)
		}
	}
	return out.String(), nil
}

func (r *Router) runChat(ctx context.Context, provider, key, prompt string, o Options) (string, error) {
	max, temp := o.MaxTokens, 0.7
	if max == 0 {
		max = 1024
	}
	if o.Temperature != nil {
		temp = *o.Temperature
	}
	var msgs []map[string]string
	if o.SystemPrompt != "" {
		msgs = append(msgs, map[string]string{"content": o.SystemPrompt, "role": "system"})
	}
	user := prompt
	if o.JSON {
		user = prompt + "\nRespond ONLY in valid JSON."
	}
	msgs = append(msgs, map[string]string{"content": user, "role": "user"})
	body := map[string]any{"max_tokens": max, "messages": msgs, "model": models[provider], "temperature": temp}
	if o.JSON {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	var data struct {
		Choices []struct {
			Message struct {
				Content *string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	status, err := r.post(ctx, r.endpoint(provider, chatEndpoints[provider]), map[string]string{"Authorization": "Bearer " + key}, body, &data)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 {
		return "", fmt.Errorf("%s HTTP %d", provider, status)
	}
	if len(data.Choices) > 0 && data.Choices[0].Message.Content != nil {
		return *data.Choices[0].Message.Content, nil
	}
	return "", nil
}

func nextMidnightUTC(now time.Time) time.Time {
	n := now.UTC()
	return time.Date(n.Year(), n.Month(), n.Day()+1, 0, 0, 0, 0, time.UTC)
}

func (r *Router) attempt(ctx context.Context, prompt string, o Options) (string, error) {
	now := r.Now()
	transient, last := false, ""
	for _, provider := range r.order() {
		for i, key := range r.keysFor(provider) {
			slot := provider + ":" + strconv.Itoa(i)
			r.mu.Lock()
			until, parked := r.exhausted[slot]
			if parked && now.Before(until) {
				r.mu.Unlock()
				continue
			}
			delete(r.exhausted, slot)
			r.mu.Unlock()

			var res string
			var err error
			if provider == "gemini" {
				res, err = r.runGemini(ctx, key, prompt, o)
			} else {
				res, err = r.runChat(ctx, provider, key, prompt, o)
			}
			if err == nil {
				if strings.TrimSpace(res) != "" {
					return res, nil
				}
				// An empty body is not a quota problem — fall through to the next key.
				transient, last = true, provider+" returned an empty response."
				continue
			}
			last = err.Error()
			slog.Error("LLM key failed", "slot", slot, "error", last)
			if isQuotaError(last) {
				r.mu.Lock()
				r.exhausted[slot] = nextMidnightUTC(now)
				r.mu.Unlock()
			} else {
				transient = true
			}
		}
	}
	if transient {
		if last == "" {
			last = "AI providers failed temporarily."
		}
		return "", errors.New(last)
	}
	return "", errExhausted
}

// Generate is llmGenerate: the provider sweep, retried once on a transient
// failure. "" rather than an error when everything is exhausted — callers have
// a non-AI fallback.
func (r *Router) Generate(ctx context.Context, prompt string, o Options) string {
	if !r.Configured() {
		return ""
	}
	out, err := r.attempt(ctx, prompt, o)
	if err == nil {
		return out
	}
	if errors.Is(err, errExhausted) {
		return ""
	}
	out, _ = r.attempt(ctx, prompt, o)
	return out
}

var fence = regexp.MustCompile("(?is)```(?:json)?\\s*([\\s\\S]*?)```")

// ExtractJSONPayload strips markdown fences and any prose around the JSON value.
func ExtractJSONPayload(raw string) string {
	t := strings.TrimSpace(raw)
	if t == "" {
		return ""
	}
	if m := fence.FindStringSubmatch(t); m != nil && strings.TrimSpace(m[1]) != "" {
		return strings.TrimSpace(m[1])
	}
	objStart, arrStart := strings.Index(t, "{"), strings.Index(t, "[")
	useArray := arrStart != -1 && (objStart == -1 || arrStart < objStart)
	start, end := objStart, strings.LastIndex(t, "}")
	if useArray {
		start, end = arrStart, strings.LastIndex(t, "]")
	}
	if start != -1 && end > start {
		return t[start : end+1]
	}
	return t
}

// SanitizeJSONPayload normalises smart quotes and escapes control characters
// left inside strings.
func SanitizeJSONPayload(raw string) string {
	n := strings.NewReplacer("“", `"`, "”", `"`, "‘", "'", "’", "'").Replace(raw)
	var out strings.Builder
	inString, escaping := false, false
	for _, ch := range n {
		if !inString {
			switch {
			case ch == '"':
				inString = true
				out.WriteRune(ch)
			case ch < 0x20 && ch != '\n' && ch != '\r' && ch != '\t':
			default:
				out.WriteRune(ch)
			}
			continue
		}
		if escaping {
			switch {
			case strings.ContainsRune(`"\/bfnrtu`, ch):
				out.WriteRune(ch)
			case ch == '\n':
				out.WriteString("n")
			case ch == '\r':
				out.WriteString("r")
			case ch == '\t':
				out.WriteString("t")
			default:
				out.WriteString(`\` + string(ch))
			}
			escaping = false
			continue
		}
		switch {
		case ch == '\\':
			out.WriteString(`\`)
			escaping = true
		case ch == '"':
			out.WriteRune(ch)
			inString = false
		case ch == '\n':
			out.WriteString(`\n`)
		case ch == '\r':
			out.WriteString(`\r`)
		case ch == '\t':
			out.WriteString(`\t`)
		case ch < 0x20:
			out.WriteString(" ")
		default:
			out.WriteRune(ch)
		}
	}
	return out.String()
}

// ParseModelJSON parses a model response, or returns ok=false when it is
// unsalvageable.
func ParseModelJSON(raw, label string) (any, bool) {
	extracted := ExtractJSONPayload(raw)
	if extracted == "" {
		return nil, false
	}
	var v any
	if json.Unmarshal([]byte(extracted), &v) == nil {
		return v, true
	}
	if err := json.Unmarshal([]byte(SanitizeJSONPayload(extracted)), &v); err != nil {
		slog.Error("Could not parse model JSON", "label", label, "error", err)
		return nil, false
	}
	return v, true
}
