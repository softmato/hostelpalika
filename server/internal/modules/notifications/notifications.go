// Package notifications: so far the public doors of modules/notifications —
// the email-preferences form, the one-click unsubscribe and the browser's push
// key. The notification rows and fan-out land with Phase 6.
package notifications

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
)

type Handler struct {
	db     *mongo.Database
	guards *authz.Guards
	mail   *email.Sender
	push   *push.Sender
}

func NewHandler(db *mongo.Database, guards *authz.Guards, mail *email.Sender, p *push.Sender) *Handler {
	return &Handler{db, guards, mail, p}
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.POST("/email-preferences", h.form)
	v1.POST("/email-preferences/unsubscribe", h.unsubscribe)
	v1.GET("/push/public-key", httpx.ETag(), h.publicKey)
}

func norm(addr string) string { return strings.ToLower(strings.TrimSpace(addr)) }

func (h *Handler) muted(ctx context.Context, addr string) ([]string, error) {
	var row struct {
		Muted []string `bson:"mutedTopics"`
	}
	err := h.db.Collection("emailpreferences").FindOne(ctx, bson.D{{Key: "email", Value: norm(addr)}}).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, t := range row.Muted {
		if email.IsTopic(t) {
			out = append(out, t)
		}
	}
	return out, nil
}

// setMuted is setMutedTopics for one address: an upsert of the deduped list.
func (h *Handler) setMuted(ctx context.Context, addr string, topics []string) error {
	seen, muted := map[string]bool{}, bson.A{}
	for _, t := range topics {
		if !seen[t] {
			seen[t] = true
			muted = append(muted, t)
		}
	}
	now := time.Now().UTC()
	_, err := h.db.Collection("emailpreferences").UpdateOne(ctx, bson.D{{Key: "email", Value: norm(addr)}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "email", Value: norm(addr)}, {Key: "mutedTopics", Value: muted}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.UpdateOne().SetUpsert(true))
	return err
}

// mutedAfterForm: topics the form showed follow its checkboxes; the rest keep their state.
func mutedAfterForm(current, shown, receiving []string) []string {
	has := func(l []string, v string) bool {
		for _, x := range l {
			if x == v {
				return true
			}
		}
		return false
	}
	out := []string{}
	for _, t := range current {
		if !has(shown, t) {
			out = append(out, t)
		}
	}
	for _, t := range shown {
		if !has(receiving, t) {
			out = append(out, t)
		}
	}
	return out
}

// formEncode is URLSearchParams' application/x-www-form-urlencoded byte set.
func formEncode(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '*', c == '-', c == '.', c == '_':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			b.WriteString("%" + strings.ToUpper(string("0123456789abcdef"[c>>4])+string("0123456789abcdef"[c&15])))
		}
	}
	return b.String()
}

func origin(c *gin.Context) string {
	scheme := "http"
	if p := c.GetHeader("X-Forwarded-Proto"); p != "" {
		scheme = strings.TrimSpace(strings.Split(p, ",")[0])
	} else if c.Request.TLS != nil {
		scheme = "https"
	}
	host := c.GetHeader("X-Forwarded-Host")
	if host == "" {
		host = c.Request.Host
	}
	return scheme + "://" + host
}

func formValues(c *gin.Context) url.Values {
	if err := c.Request.ParseMultipartForm(32 << 20); err != nil {
		_ = c.Request.ParseForm()
	}
	return c.Request.PostForm
}

func filterTopics(in []string) []string {
	out := []string{}
	for _, t := range in {
		if email.IsTopic(t) {
			out = append(out, t)
		}
	}
	return out
}

// form is the /email-preferences page's plain HTML POST, answered with a 303
// back to the page; the signed token is the whole authorisation.
func (h *Handler) form(c *gin.Context) {
	form := formValues(c)
	token := form.Get("token")
	topic := form.Get("topic")
	back := origin(c) + "/email-preferences?token=" + formEncode(token)
	if email.IsTopic(topic) {
		back += "&topic=" + formEncode(topic)
	}
	addr := h.mail.AddressFromPreferenceToken(token)
	if addr == "" {
		c.Redirect(http.StatusSeeOther, back)
		return
	}
	current, err := h.muted(c, addr)
	if err == nil {
		next := mutedAfterForm(current, filterTopics(form["shown"]), filterTopics(form["receive"]))
		if mute := form.Get("mute"); email.IsTopic(mute) {
			next = append(current, mute)
		}
		err = h.setMuted(c, addr, next)
	}
	if err != nil {
		back += "&error=1"
	} else {
		back += "&saved=1"
	}
	c.Redirect(http.StatusSeeOther, back)
}

type unsubscribed struct {
	Unsubscribed string `json:"unsubscribed"`
}

// unsubscribe is RFC 8058 one-click, POST only: a GET would let a link scanner
// unsubscribe people by prefetching.
func (h *Handler) unsubscribe(c *gin.Context) {
	addr := h.mail.AddressFromPreferenceToken(c.Query("token"))
	topic := c.Query("topic")
	if addr == "" || !email.IsTopic(topic) {
		httpx.Fail(c, httpx.NewError(http.StatusBadRequest, "INVALID_UNSUBSCRIBE_LINK", "This unsubscribe link is not valid.", nil))
		return
	}
	current, err := h.muted(c, addr)
	if err == nil {
		err = h.setMuted(c, addr, append(current, topic))
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, unsubscribed{topic}, "Unsubscribed")
}

type pushKey struct {
	PublicKey string `json:"publicKey"`
}

// publicKey is the VAPID key a browser needs before it can subscribe; 503
// rather than an empty key when VAPID is unset.
func (h *Handler) publicKey(c *gin.Context) {
	if _, err := h.guards.Require(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !h.push.WebPushConfigured() {
		httpx.Fail(c, httpx.NewError(http.StatusServiceUnavailable, "WEB_PUSH_NOT_CONFIGURED", "Browser notifications are not configured on this deployment.", nil))
		return
	}
	httpx.OK(c, pushKey{h.push.VAPID.VAPIDPublicKey}, "Push key loaded")
}
