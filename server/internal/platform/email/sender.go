// Package email is packages/shared/src/email: the Resend sender, the sender
// identity (domain from env, mailboxes and name from site config), the shared
// HTML layout and the templates, ported as each module needs them.
package email

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"golang.org/x/sync/singleflight"
)

// Category picks the mailbox a message comes from.
type Category string

const (
	Info     Category = "info"
	Alert    Category = "alert"
	Billing  Category = "billing"
	Security Category = "security"
	Support  Category = "support"
	NoReply  Category = "noreply"
)

// Shipped local-parts (DEFAULT_MAILBOXES); the local-part equals the category.
var nameSuffix = map[Category]string{Billing: "Billing", Security: "Security", Support: "Support"}

// ShippedDomain is SHIPPED_EMAIL_DOMAIN.
const ShippedDomain = "softmato.com"

// Identity is EmailIdentity.
type Identity struct {
	Domain     string
	Mailboxes  map[Category]string
	ReplyTo    string
	SenderName string
}

// From is fromHeaderFor: "" when there is no domain (email switched off).
func (id Identity) From(cat Category) string {
	domain := strings.TrimPrefix(strings.TrimSpace(id.Domain), "@")
	if domain == "" {
		return ""
	}
	mailbox := id.Mailboxes[cat]
	if mailbox == "" {
		mailbox = string(cat)
	}
	// Strip header-breaking characters before falling back (admin-editable field).
	cleaned := strings.TrimSpace(strings.Map(func(r rune) rune {
		if strings.ContainsRune(`"\,;<>`, r) {
			return -1
		}
		return r
	}, id.SenderName))
	if cleaned == "" {
		cleaned = PlatformName
	}
	name := cleaned
	if s := nameSuffix[cat]; s != "" {
		name += " " + s
	}
	return name + " <" + strings.TrimSpace(mailbox) + "@" + domain + ">"
}

// ReplyToFor is replyToFor: configured, else info@ on the sending domain; never for noreply.
func (id Identity) ReplyToFor(cat Category) string {
	if cat == NoReply {
		return ""
	}
	if r := strings.TrimSpace(id.ReplyTo); r != "" {
		return r
	}
	domain := strings.TrimPrefix(strings.TrimSpace(id.Domain), "@")
	if domain == "" {
		return ""
	}
	mailbox := id.Mailboxes[Info]
	if mailbox == "" {
		mailbox = "info"
	}
	return strings.TrimSpace(mailbox) + "@" + domain
}

// Result is SendEmailResult. Reason: "not_configured" | "send_failed".
type Result struct {
	Sent   bool
	ID     string
	Reason string
	Detail string
}

// Message is SendEmailInput, attachments aside.
type Message struct {
	Category Category // "" = info
	To       []string
	Subject  string
	HTML     string
	ReplyTo  string
	// Unsubscribe is for optional mail only: a footer line (PageURL) and the
	// RFC 8058 List-Unsubscribe headers (OneClickURL).
	Unsubscribe *Unsubscribe
}

type Unsubscribe struct{ OneClickURL, PageURL string }

// WithUnsubscribeLine puts the line in the layout's slot, or appends it to a bare fragment.
func WithUnsubscribeLine(html, pageURL string) string {
	line := `<a href="` + strings.ReplaceAll(pageURL, "&", "&amp;") + `" style="color:inherit;text-decoration:underline;">Unsubscribe or choose which emails you get</a>`
	if strings.Contains(html, UnsubscribeSlot) {
		return strings.Replace(html, UnsubscribeSlot, "<br>"+line, 1)
	}
	return html + `<p style="margin-top:24px;font-size:12px;line-height:18px;color:#71717a;">` + line + `</p>`
}

// body is messageBody: one message as Resend takes it.
func body(m Message, from, replyTo string) map[string]any {
	b := map[string]any{"from": from, "to": m.To, "subject": m.Subject, "html": m.HTML}
	if m.Unsubscribe != nil {
		b["html"] = WithUnsubscribeLine(m.HTML, m.Unsubscribe.PageURL)
		b["headers"] = map[string]string{
			"List-Unsubscribe":      "<" + m.Unsubscribe.OneClickURL + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		}
	}
	if replyTo != "" {
		b["reply_to"] = replyTo
	}
	return b
}

// Sender sends through Resend with the configured identity.
type Sender struct {
	APIKey  string // RESEND_API_KEY
	Domain  string // EMAIL_DOMAIN
	ReplyTo string // EMAIL_REPLY_TO, the fallback identity's reply address
	DB      *mongo.Database
	HTTP    *http.Client
	URL     string // tests point this at a fake; the batch endpoint is URL + "/batch"
	// For opt-out links: JWT_ACCESS_SECRET signs the token, Outbound is OutboundURL().
	PrefSecret, Outbound string

	mu       sync.Mutex
	cached   *Identity
	cachedAt time.Time
	group    singleflight.Group
}

func NewSender(apiKey, domain, replyTo string, db *mongo.Database) *Sender {
	return &Sender{APIKey: apiKey, Domain: domain, ReplyTo: replyTo, DB: db,
		HTTP: &http.Client{Timeout: 15 * time.Second}, URL: "https://api.resend.com/emails"}
}

const identityTTL = time.Minute

var (
	mailboxRe = regexp.MustCompile(`(?i)^$|^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)
	domainRe  = regexp.MustCompile(`(?i)^$|^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$`)
)

// Identity is loadEmailIdentity: site config's `email` section, read at most
// once a minute, concurrent misses sharing one read; any failure → fallback.
func (s *Sender) Identity(ctx context.Context) Identity {
	s.mu.Lock()
	if s.cached != nil && time.Since(s.cachedAt) < identityTTL {
		id := *s.cached
		s.mu.Unlock()
		return id
	}
	s.mu.Unlock()
	v, _, _ := s.group.Do("identity", func() (any, error) {
		id := s.readIdentity(context.WithoutCancel(ctx))
		s.mu.Lock()
		s.cached, s.cachedAt = &id, time.Now()
		s.mu.Unlock()
		return id, nil
	})
	return v.(Identity)
}

func (s *Sender) fallback() Identity {
	d := s.Domain
	if d == "" {
		d = ShippedDomain
	}
	return Identity{Domain: d, Mailboxes: map[Category]string{}, ReplyTo: strings.TrimSpace(s.ReplyTo), SenderName: PlatformName}
}

func (s *Sender) readIdentity(ctx context.Context) Identity {
	fb := s.fallback()
	if s.DB == nil {
		return fb
	}
	var row struct {
		Value bson.Raw `bson:"value"`
	}
	err := s.DB.Collection("platformsettings").FindOne(ctx, bson.D{{Key: "key", Value: "email"}}).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return fb
	}
	cfg := emailSection(row.Value) // nil on no row or a row the schema refuses → defaults
	get := func(k string) string { return cfg[k] }
	domain := s.Domain
	if domain == "" {
		domain = get("domain")
	}
	if domain == "" {
		domain = ShippedDomain
	}
	id := Identity{Domain: domain, Mailboxes: map[Category]string{}, ReplyTo: get("replyTo"), SenderName: get("senderName")}
	for _, c := range []Category{Alert, Billing, Info, NoReply, Security, Support} {
		id.Mailboxes[c] = get(string(c) + "Mailbox")
	}
	if id.ReplyTo == "" {
		id.ReplyTo = fb.ReplyTo
	}
	if id.SenderName == "" {
		id.SenderName = PlatformName // identity.siteName is pinned to the platform name
	}
	return id
}

// emailSection is emailSchema.safeParse: trimmed strings with their limits;
// any failure means the whole section falls back to defaults, as coerceSection does.
func emailSection(raw bson.Raw) map[string]string {
	if raw == nil {
		return nil
	}
	var m map[string]any
	if bson.Unmarshal(raw, &m) != nil {
		return nil
	}
	out := map[string]string{}
	for _, k := range []string{"alertMailbox", "billingMailbox", "domain", "infoMailbox", "noreplyMailbox", "replyTo", "securityMailbox", "senderName", "supportMailbox"} {
		v, present := m[k]
		if !present { // .default(""); a null is not a string and fails the section
			continue
		}
		str, ok := v.(string)
		if !ok {
			return nil
		}
		str = strings.TrimSpace(str)
		switch {
		case strings.HasSuffix(k, "Mailbox"):
			if len([]rune(str)) > 40 || !mailboxRe.MatchString(str) {
				return nil
			}
		case k == "domain":
			if len([]rune(str)) > 120 || !domainRe.MatchString(str) {
				return nil
			}
		case k == "replyTo":
			if str != "" && !ValidEmail(str) {
				return nil
			}
		case k == "senderName":
			if len([]rune(str)) > 60 {
				return nil
			}
		}
		out[k] = str
	}
	return out
}

var emailRe = regexp.MustCompile(`^([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

// ValidEmail is zod v4's email regex; RE2 has no lookahead, so its two
// (?!…) guards are plain string checks.
func ValidEmail(s string) bool {
	return !strings.HasPrefix(s, ".") && !strings.Contains(s, "..") && emailRe.MatchString(s)
}

// Send is sendEmail: never fails the caller; no key or no domain → not_configured.
func (s *Sender) Send(ctx context.Context, m Message) Result {
	cat := m.Category
	if cat == "" {
		cat = Info
	}
	id := s.Identity(ctx)
	from := id.From(cat)
	replyTo := m.ReplyTo
	if replyTo == "" {
		replyTo = id.ReplyToFor(cat)
	}
	if s.APIKey == "" || from == "" {
		slog.InfoContext(ctx, "Resend not configured (RESEND_API_KEY / EMAIL_DOMAIN); email not sent.",
			"action", "email_skipped", "category", cat, "subject", m.Subject)
		return Result{Reason: "not_configured"}
	}
	b, _ := json.Marshal(body(m, from, replyTo))
	res, err := s.post(ctx, s.URL, b, 2)
	if err != nil {
		slog.ErrorContext(ctx, err.Error(), "action", "email_send_failed", "category", cat, "subject", m.Subject)
		return Result{Reason: "send_failed", Detail: err.Error()}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		slog.ErrorContext(ctx, fmt.Sprintf("Resend returned %d", res.StatusCode), "action", "email_send_failed", "category", cat, "from", from, "subject", m.Subject)
		return Result{Reason: "send_failed", Detail: string(raw)}
	}
	var payload struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &payload)
	slog.InfoContext(ctx, "Email dispatched via Resend.", "action", "email_sent", "category", cat, "from", from, "subject", m.Subject, "emailId", payload.ID)
	return Result{Sent: true, ID: payload.ID}
}

// post retries a 429 after its retry-after (capped at 2 s), twice, as postToResend.
func (s *Sender) post(ctx context.Context, url string, body []byte, retries int) (*http.Response, error) {
	req, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.APIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.HTTP.Do(req)
	if err != nil || res.StatusCode != http.StatusTooManyRequests || retries <= 0 {
		return res, err
	}
	_ = res.Body.Close()
	wait := 1.0
	if ra, _ := strconv.ParseFloat(res.Header.Get("retry-after"), 64); ra > 0 {
		wait = min(ra, 2)
	}
	time.Sleep(time.Duration((wait + rand.Float64()*0.5) * float64(time.Second)))
	return s.post(ctx, url, body, retries-1)
}

// batchLimit is Resend's per-request cap.
const batchLimit = 100

// SendBatch is sendEmailBatch: one request per hundred, one Result per message, in order.
func (s *Sender) SendBatch(ctx context.Context, msgs []Message) []Result {
	results := make([]Result, 0, len(msgs))
	if len(msgs) == 0 {
		return results
	}
	id := s.Identity(ctx)
	for start := 0; start < len(msgs); start += batchLimit {
		slice := msgs[start:min(start+batchLimit, len(msgs))]
		fail := func(reason, detail string) {
			for range slice {
				results = append(results, Result{Reason: reason, Detail: detail})
			}
		}
		bodies := make([]map[string]any, 0, len(slice))
		for _, m := range slice {
			cat := m.Category
			if cat == "" {
				cat = Info
			}
			from := id.From(cat)
			if from == "" {
				break
			}
			replyTo := m.ReplyTo
			if replyTo == "" {
				replyTo = id.ReplyToFor(cat)
			}
			bodies = append(bodies, body(m, from, replyTo))
		}
		if s.APIKey == "" || len(bodies) != len(slice) {
			slog.InfoContext(ctx, "Resend not configured (RESEND_API_KEY / EMAIL_DOMAIN); batch not sent.", "action", "email_skipped", "count", len(slice))
			fail("not_configured", "")
			continue
		}
		b, _ := json.Marshal(bodies)
		res, err := s.post(ctx, s.URL+"/batch", b, 2)
		if err != nil {
			slog.ErrorContext(ctx, err.Error(), "action", "email_batch_failed", "count", len(slice))
			fail("send_failed", err.Error())
			continue
		}
		raw, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode > 299 {
			slog.ErrorContext(ctx, fmt.Sprintf("Resend returned %d", res.StatusCode), "action", "email_batch_failed", "count", len(slice))
			fail("send_failed", string(raw))
			continue
		}
		var payload struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		_ = json.Unmarshal(raw, &payload)
		slog.InfoContext(ctx, "Email batch dispatched via Resend.", "action", "email_batch_sent", "count", len(slice))
		for i := range slice {
			r := Result{Sent: true}
			if i < len(payload.Data) {
				r.ID = payload.Data[i].ID
			}
			results = append(results, r)
		}
	}
	return results
}
