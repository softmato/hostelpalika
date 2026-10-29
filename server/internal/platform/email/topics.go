package email

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"log/slog"
	"net/url"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Optional mail, per address (modules/notifications/email-{topics,preference.service}.ts).
// A topic makes a send skippable for an address that turned it off and adds the
// unsubscribe line + headers. Mail a person cannot refuse (credentials, receipts,
// SOS) has no topic. "≤1 routine email a day" is the jobs' cadence, not a cap here.

// Topic is an EmailTopic.
type Topic string

// TopicInfo is one EMAIL_TOPICS entry; Topics keeps TS's order.
type TopicInfo struct {
	Audience    string `json:"audience"`
	Description string `json:"description"`
	Label       string `json:"label"`
	Value       Topic  `json:"value"`
}

var Topics = []TopicInfo{
	{"resident", "Before and after your hostel fee is due", "Rent reminders", "RENT_REMINDERS"},
	{"resident", "Urgent notices from your hostel", "Notices", "NOTICES"},
	{"resident", "When a complaint you raised is resolved or rejected", "Complaint updates", "COMPLAINT_UPDATES"},
	{"staff", "Morning summary of payments to verify and received, and unpaid fees", "Payment summaries", "PAYMENT_SUMMARY"},
	{"staff", "New complaints, and ones past their deadline", "Complaint alerts", "COMPLAINT_ALERTS"},
	{"staff", "Residents away longer than your alert limit", "Attendance alerts", "ATTENDANCE_ALERTS"},
}

func IsTopic(v string) bool {
	for _, t := range Topics {
		if string(t.Value) == v {
			return true
		}
	}
	return false
}

func normalize(addr string) string { return strings.ToLower(strings.TrimSpace(addr)) }

func (s *Sender) sign(addr string) string {
	secret := s.PrefSecret
	if secret == "" {
		secret = "development-email-preference-secret"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("email-preferences:" + addr))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// PreferenceToken is base64url(address).signature — the key to /email-preferences.
func (s *Sender) PreferenceToken(addr string) string {
	addr = normalize(addr)
	return base64.RawURLEncoding.EncodeToString([]byte(addr)) + "." + s.sign(addr)
}

// AddressFromPreferenceToken is the address a token was signed for, or "".
func (s *Sender) AddressFromPreferenceToken(token string) string {
	encoded, signature, _ := strings.Cut(token, ".")
	if encoded == "" || signature == "" {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(encoded, "="))
	if err != nil {
		return ""
	}
	if !hmac.Equal([]byte(signature), []byte(s.sign(string(raw)))) {
		return ""
	}
	return string(raw)
}

// PreferenceLinks is emailPreferenceLinks.
func (s *Sender) PreferenceLinks(addr string, topic Topic) *Unsubscribe {
	query := "token=" + url.QueryEscape(s.PreferenceToken(addr)) + "&topic=" + string(topic)
	return &Unsubscribe{
		OneClickURL: s.Outbound + "/api/v1/email-preferences/unsubscribe?" + query,
		PageURL:     s.Outbound + "/email-preferences?" + query,
	}
}

// TopicMuted is whether an address turned a topic off; a read failure is "not muted".
func (s *Sender) TopicMuted(ctx context.Context, addr string, topic Topic) bool {
	if s.DB == nil {
		return false
	}
	n, err := s.DB.Collection("emailpreferences").CountDocuments(ctx,
		bson.D{{Key: "email", Value: normalize(addr)}, {Key: "mutedTopics", Value: string(topic)}})
	return err == nil && n > 0
}

// Notification is one sendNotificationEmail input.
type Notification struct {
	Action, To, Subject, HTML string
	Category                  Category
	Topic                     Topic // "" = mail the person cannot refuse
}

func (s *Sender) message(n Notification) Message {
	m := Message{Category: n.Category, To: []string{n.To}, Subject: n.Subject, HTML: n.HTML}
	if n.Topic != "" {
		m.Unsubscribe = s.PreferenceLinks(n.To, n.Topic)
	}
	return m
}

func warnUnsent(ctx context.Context, n Notification, reason string) {
	slog.WarnContext(ctx, "Recipient was not notified ("+reason+").", "action", n.Action+"_email_failed", "to", n.To)
}

// Notify is sendNotificationEmail: never fails the caller; false when muted or unsent.
func (s *Sender) Notify(ctx context.Context, n Notification) bool {
	if n.Topic != "" && s.TopicMuted(ctx, n.To, n.Topic) {
		return false
	}
	r := s.Send(ctx, s.message(n))
	if !r.Sent {
		warnUnsent(ctx, n, r.Reason)
	}
	return r.Sent
}

// NotifyBatch is sendNotificationEmailBatch: same opt-out rules, one result per input.
func (s *Sender) NotifyBatch(ctx context.Context, ns []Notification) []bool {
	out := make([]bool, len(ns))
	var msgs []Message
	var idx []int
	for i, n := range ns {
		if n.Topic != "" && s.TopicMuted(ctx, n.To, n.Topic) {
			continue
		}
		msgs = append(msgs, s.message(n))
		idx = append(idx, i)
	}
	for j, r := range s.SendBatch(ctx, msgs) {
		out[idx[j]] = r.Sent
		if !r.Sent {
			warnUnsent(ctx, ns[idx[j]], r.Reason)
		}
	}
	return out
}
