package finance

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/images"
	"github.com/softmato/hostelpalika/server/internal/platform/pdfin"
)

const (
	visionTokenURL = "https://oauth2.googleapis.com/token"
	geminiEndpoint = "https://generativelanguage.googleapis.com/v1beta/models"
	geminiPrompt   = "Transcribe every line of text visible in this payment receipt image, exactly as printed. Keep each label together with its value on the same line, in the order they appear on the page. Do not summarise, translate, reformat, correct, or explain anything. Output the transcription as plain text and nothing else."
)

// Reader is evidence-ocr's readEvidence: PDF text, or the configured image engine.
type Reader struct {
	DB         *mongo.Database
	Cfg        config.Evidence
	GeminiKeys []string
	HTTP       *http.Client

	mu          sync.Mutex
	token       string
	tokenExpiry time.Time
}

// Enabled is isEvidenceOcrEnabled.
func (r *Reader) Enabled() bool { return r.Cfg.OCR }

// IsPDF is isPdfEvidence.
func IsPDF(mime string) bool { return strings.Contains(strings.ToLower(mime), "pdf") }

func (r *Reader) mode() string {
	switch r.Cfg.Engine {
	case "gemini", "vision", "vision+gemini":
		return r.Cfg.Engine
	}
	vision, gemini := r.Cfg.VisionSAKey != "", len(r.GeminiKeys) > 0
	switch {
	case vision && gemini:
		return "vision+gemini"
	case vision:
		return "vision"
	case gemini:
		return "gemini"
	}
	return "none"
}

// Read returns the text and, when there is none, why ("empty", "timeout", ...).
func (r *Reader) Read(ctx context.Context, b []byte, mime string) (text, failure string) {
	if !r.Enabled() {
		return "", "disabled"
	}
	if IsPDF(mime) {
		t, err := pdfin.Text(ctx, b)
		if err != nil || t == "" {
			return "", "empty"
		}
		return t, ""
	}
	mode := r.mode()
	if mode == "none" {
		return "", "not-configured"
	}
	prepared, preparedMime, err := images.PrepareForVision(b, 2400)
	if err != nil {
		return "", "unknown"
	}
	if mode == "gemini" {
		return r.gemini(ctx, prepared, preparedMime)
	}
	text, failure = r.vision(ctx, prepared)
	if mode == "vision" || failure == "" || failure == "empty" {
		return text, failure
	}
	slog.ErrorContext(ctx, "[evidence-fallback] vision returned nothing — asking gemini", "failure", failure)
	text, failure = r.gemini(ctx, prepared, preparedMime)
	if failure != "" {
		slog.ErrorContext(ctx, "[evidence-fallback] gemini returned nothing either — this file goes to a human", "failure", failure)
	}
	return text, failure
}

// providerClient is a backstop: each call also has its own context deadline.
var providerClient = &http.Client{Timeout: 60 * time.Second}

func (r *Reader) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return providerClient
}

// withinCap counts the call. A counter failure never stops the read.
func (r *Reader) withinCap(ctx context.Context, service string, limit int) bool {
	if limit <= 0 {
		return true
	}
	used, err := audit.CountUsage(ctx, r.DB, service, time.Now())
	if err != nil {
		return true
	}
	if used > int64(limit) {
		slog.ErrorContext(ctx, "evidence monthly cap reached — receipts are no longer being machine-read", "service", service, "used", used, "cap", limit)
		return false
	}
	return true
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (r *Reader) accessToken(ctx context.Context) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.token != "" && r.tokenExpiry.After(time.Now().Add(time.Minute)) {
		return r.token, nil
	}
	var account struct {
		Email string `json:"client_email"`
		Key   string `json:"private_key"`
	}
	if err := json.Unmarshal([]byte(r.Cfg.VisionSAKey), &account); err != nil || account.Email == "" || account.Key == "" {
		return "", errors.New("no service account")
	}
	block, _ := pem.Decode([]byte(strings.ReplaceAll(account.Key, `\n`, "\n")))
	if block == nil {
		return "", errors.New("bad service account key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return "", errors.New("service account key is not RSA")
	}
	now := time.Now().Unix()
	claims, _ := json.Marshal(map[string]any{"aud": visionTokenURL, "exp": now + 3600, "iat": now, "iss": account.Email, "scope": "https://www.googleapis.com/auth/cloud-platform"})
	signing := b64url([]byte(`{"alg":"RS256","typ":"JWT"}`)) + "." + b64url(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	form := url.Values{"assertion": {signing + "." + b64url(sig)}, "grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, visionTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := r.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		Token   string `json:"access_token"`
		Expires int64  `json:"expires_in"`
	}
	if res.StatusCode >= 300 || json.NewDecoder(res.Body).Decode(&body) != nil || body.Token == "" {
		return "", errors.New("no token")
	}
	if body.Expires == 0 {
		body.Expires = 3600
	}
	r.token, r.tokenExpiry = body.Token, time.Now().Add(time.Duration(body.Expires)*time.Second)
	return r.token, nil
}

func timedOut(ctx context.Context, err error) bool {
	return ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded)
}

func (r *Reader) vision(parent context.Context, prepared []byte) (string, string) {
	if r.Cfg.VisionSAKey == "" {
		return "", "not-configured"
	}
	if !r.withinCap(parent, "VISION_OCR", r.Cfg.VisionMonthlyCap) {
		return "", "over-budget"
	}
	ctx, cancel := context.WithTimeout(parent, r.Cfg.VisionTimeout)
	defer cancel()
	bearer, err := r.accessToken(ctx)
	if err != nil {
		return "", "not-configured"
	}
	host := "vision.googleapis.com"
	if r.Cfg.VisionRegion == "eu" || r.Cfg.VisionRegion == "us" {
		host = r.Cfg.VisionRegion + "-vision.googleapis.com"
	}
	payload, _ := json.Marshal(map[string]any{"requests": []any{map[string]any{"features": []any{map[string]string{"type": "DOCUMENT_TEXT_DETECTION"}},
		"image": map[string]string{"content": base64.StdEncoding.EncodeToString(prepared)}, "imageContext": map[string]any{"languageHints": []string{"en", "ne"}}}}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+host+"/v1/images:annotate", bytes.NewReader(payload))
	if err != nil {
		return "", "unknown"
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	res, err := r.client().Do(req)
	if err != nil {
		if timedOut(ctx, err) {
			return "", "timeout"
		}
		return "", "unknown"
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		slog.ErrorContext(ctx, "[evidence-vision] annotate failed", "status", res.StatusCode)
		return "", "provider-error"
	}
	var body struct {
		Responses []struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
			Full struct {
				Text string `json:"text"`
			} `json:"fullTextAnnotation"`
		} `json:"responses"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", "unknown"
	}
	if len(body.Responses) == 0 {
		return "", "empty"
	}
	if e := body.Responses[0].Error; e != nil {
		slog.ErrorContext(ctx, "[evidence-vision] annotate error", "message", e.Message)
		return "", "provider-error"
	}
	text := jsTrim(body.Responses[0].Full.Text)
	if text == "" {
		return "", "empty"
	}
	return text, ""
}

func (r *Reader) gemini(parent context.Context, prepared []byte, mime string) (string, string) {
	if len(r.GeminiKeys) == 0 {
		return "", "not-configured"
	}
	if !r.withinCap(parent, "GEMINI_OCR", r.Cfg.GeminiMonthlyCap) {
		return "", "over-budget"
	}
	ctx, cancel := context.WithTimeout(parent, r.Cfg.GeminiTimeout)
	defer cancel()
	models := r.Cfg.GeminiModels
	if len(models) == 0 {
		models = []string{"gemini-3.1-flash-lite", "gemini-2.5-flash"}
	}
	payload, _ := json.Marshal(map[string]any{"contents": []any{map[string]any{"parts": []any{map[string]string{"text": geminiPrompt},
		map[string]any{"inline_data": map[string]string{"data": base64.StdEncoding.EncodeToString(prepared), "mime_type": mime}}}}},
		"generationConfig": map[string]any{"maxOutputTokens": 2048, "temperature": 0, "thinkingConfig": map[string]int{"thinkingBudget": 0}}})
	last := "provider-error"
	for _, model := range models {
		for _, key := range r.GeminiKeys {
			text, failure, final := r.geminiAttempt(ctx, model, key, payload)
			if final {
				return text, failure
			}
			last = failure
		}
	}
	return "", last
}

// geminiAttempt's final is true when no other key or model could change the answer.
func (r *Reader) geminiAttempt(ctx context.Context, model, key string, payload []byte) (text, failure string, final bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, geminiEndpoint+"/"+model+":generateContent", bytes.NewReader(payload))
	if err != nil {
		return "", "unknown", false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", key)
	res, err := r.client().Do(req)
	if err != nil {
		if timedOut(ctx, err) {
			return "", "timeout", true
		}
		return "", "unknown", false
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return "", "over-budget", false
	}
	if res.StatusCode >= 300 {
		if res.StatusCode != http.StatusNotFound {
			slog.ErrorContext(ctx, "[evidence-gemini] failed", "model", model, "status", strconv.Itoa(res.StatusCode))
		}
		return "", "provider-error", false
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		if timedOut(ctx, err) {
			return "", "timeout", true
		}
		return "", "unknown", true
	}
	var body struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", "unknown", true
	}
	if body.Error != nil {
		slog.ErrorContext(ctx, "[evidence-gemini] error", "model", model, "message", body.Error.Message)
		return "", "provider-error", false
	}
	var b strings.Builder
	if len(body.Candidates) > 0 {
		for _, p := range body.Candidates[0].Content.Parts {
			b.WriteString(p.Text)
		}
	}
	if t := jsTrim(b.String()); t != "" {
		return t, "", true
	}
	return "", "empty", true
}
