// Package push is the one fan-out to phones and browsers, a port of
// modules/notifications/{push,web-push}.service.ts (sendPushToUsers).
//
// Both transports live in DeviceToken (platform "WEB" for browsers). The
// per-user preference filter and the two routing tables (Expo paths are
// role-relative, web URLs are per portal) belong to the notifications module,
// so they are injected; with none set every recipient is kept and links are "".
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

const (
	expoEndpoint   = "https://exp.host/--/api/v2/push/send"
	maxPerRequest  = 100
	webTTLSeconds  = 60 * 60 * 24
	maxWebInFlight = 50
	appSound       = "water_drop.wav"
	// AppDrawsCategoryPushes is the DeviceToken capability of an Android build
	// that draws category pushes itself (data-only message).
	AppDrawsCategoryPushes = "draws-category-pushes"
	// PWAPush marks a browser subscription that belongs to the installed PWA.
	PWAPush = "pwa"
)

// Payload is PushPayload.
type Payload struct {
	ActionURL      string
	Body           string
	Category       string
	CategoryID     string
	Data           map[string]any
	DataByUser     map[string]map[string]any
	HostelID       string
	ImageURL       string
	NotificationID string
	Priority       string // LOW | NORMAL | HIGH | URGENT
	Title          string
}

// Result is PushResult.
type Result struct {
	Revoked int  `json:"revoked"`
	Sent    int  `json:"sent"`
	Skipped bool `json:"skipped"`
}

// Hooks are the notifications module's rules.
type Hooks struct {
	// Filter keeps the users who want this category (filterPushRecipients).
	Filter func(ctx context.Context, userIDs []string, category string, urgent bool) []string
	// DeepLink is the app path a tap opens (deepLinkForNotification).
	DeepLink func(p Payload) string
	// WebLink is the portal URL for a role (webLinkForNotification).
	WebLink func(p Payload, role string) string
}

// Sender is safe for concurrent use.
type Sender struct {
	DB        *mongo.Database
	ExpoToken string
	Endpoint  string // tests point this at a fake
	HTTP      *http.Client
	VAPID     config.Push
	Hooks     Hooks
}

func New(db *mongo.Database, cfg config.Push, hooks Hooks) *Sender {
	return &Sender{DB: db, ExpoToken: cfg.ExpoAccessToken, Endpoint: expoEndpoint,
		HTTP: &http.Client{Timeout: 10 * time.Second}, VAPID: cfg, Hooks: hooks}
}

// WebPushConfigured is whether all three VAPID values are set.
func (s *Sender) WebPushConfigured() bool {
	return s.VAPID.VAPIDPrivateKey != "" && s.VAPID.VAPIDPublicKey != "" && s.VAPID.VAPIDSubject != ""
}

func androidChannel(category, priority string) string {
	switch {
	case category == "SOS" || category == "URGENT" || priority == "URGENT":
		return "urgent"
	case category == "FOOD":
		return "food_v2"
	case category == "NOTICE" || category == "ANNOUNCEMENT" || category == "PLATFORM":
		return "notices_v1"
	}
	return "default_v2"
}

func highPriority(p Payload) bool {
	return p.Priority == "HIGH" || p.Priority == "URGENT" || p.Category == "SOS" || p.Category == "URGENT"
}

type device struct {
	Capabilities   []string `bson:"capabilities"`
	ExpirationTime *int64   `bson:"expirationTime"`
	Keys           *struct {
		Auth   string `bson:"auth"`
		P256dh string `bson:"p256dh"`
	} `bson:"keys"`
	Platform string        `bson:"platform"`
	Token    string        `bson:"token"`
	UserID   bson.ObjectID `bson:"userId"`
}

func objectIDs(ids []string) []bson.ObjectID {
	out := make([]bson.ObjectID, 0, len(ids))
	for _, id := range ids {
		if oid, err := bson.ObjectIDFromHex(id); err == nil {
			out = append(out, oid)
		}
	}
	return out
}

func (s *Sender) activeDevices(ctx context.Context, userIDs []string) (expo, web []device, err error) {
	cur, err := s.DB.Collection("devicetokens").Find(ctx, bson.D{
		{Key: "status", Value: "ACTIVE"},
		{Key: "userId", Value: bson.D{{Key: "$in", Value: objectIDs(userIDs)}}},
	})
	if err != nil {
		return nil, nil, err
	}
	var rows []device
	if err := cur.All(ctx, &rows); err != nil {
		return nil, nil, err
	}
	seen := map[string]bool{}
	for _, d := range rows {
		if d.Token == "" || seen[d.Token] {
			continue
		}
		seen[d.Token] = true
		if d.Platform == "WEB" {
			web = append(web, d)
		} else {
			expo = append(expo, d)
		}
	}
	return expo, web, nil
}

// ToUsers is sendPushToUsers: never fails the caller.
func (s *Sender) ToUsers(ctx context.Context, userIDs []string, p Payload) Result {
	var everyone []string
	for _, id := range userIDs {
		if id != "" && !slices.Contains(everyone, id) {
			everyone = append(everyone, id)
		}
	}
	empty := Result{Skipped: true}
	if len(everyone) == 0 {
		return empty
	}
	high := highPriority(p)
	recipients := everyone
	if s.Hooks.Filter != nil {
		recipients = s.Hooks.Filter(ctx, everyone, p.Category, high)
	}
	if len(recipients) == 0 {
		return empty
	}
	expo, web, err := s.activeDevices(ctx, recipients)
	if err != nil {
		slog.ErrorContext(ctx, "push device lookup failed", "action", "push_devices_failed", "error", err.Error())
		return empty
	}
	if len(expo) == 0 && len(web) == 0 {
		return empty
	}

	channelID := androidChannel(p.Category, p.Priority)
	deepLink := ""
	if s.Hooks.DeepLink != nil {
		deepLink = s.Hooks.DeepLink(p)
	}
	base := map[string]any{}
	for k, v := range p.Data {
		base[k] = v
	}
	base["category"] = p.Category
	base["hostelId"] = optional(p.HostelID)
	base["notificationId"] = optional(p.NotificationID)
	base["path"] = deepLink
	base["urgent"] = channelID == "urgent"

	messages := make([]map[string]any, 0, len(expo))
	for _, d := range expo {
		data := map[string]any{}
		for k, v := range base {
			data[k] = v
		}
		for k, v := range p.DataByUser[d.UserID.Hex()] {
			data[k] = v
		}
		if p.CategoryID != "" && d.Platform == "ANDROID" && slices.Contains(d.Capabilities, AppDrawsCategoryPushes) {
			data["draw"] = map[string]any{"body": p.Body, "categoryId": p.CategoryID, "channelId": channelID, "title": p.Title}
			messages = append(messages, map[string]any{"data": data, "priority": "high", "to": d.Token})
			continue
		}
		m := map[string]any{"body": p.Body, "channelId": channelID, "data": data, "title": p.Title, "to": d.Token}
		if p.CategoryID != "" {
			m["categoryId"] = p.CategoryID
		}
		m["priority"] = "default"
		if high || channelID != "default_v2" {
			m["priority"] = "high"
		}
		if p.ImageURL != "" {
			m["richContent"] = map[string]string{"image": p.ImageURL}
		}
		m["sound"] = appSound
		if channelID == "urgent" {
			m["sound"] = "default"
		}
		messages = append(messages, m)
	}

	sent := 0
	var dead []string
	var accepted []any
	ticketErrors := map[string]int{}
	now := time.Now().UTC()
	for start := 0; start < len(messages); start += maxPerRequest {
		batch := messages[start:min(start+maxPerRequest, len(messages))]
		for i, t := range s.postBatch(ctx, batch) {
			if i >= len(batch) {
				break
			}
			to := batch[i]["to"].(string)
			if t.Status == "ok" {
				sent++
				if t.ID != "" {
					accepted = append(accepted, bson.D{
						{Key: "ticketId", Value: t.ID}, {Key: "token", Value: to}, {Key: "category", Value: p.Category},
						{Key: "status", Value: "PENDING"}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0},
					})
				}
				continue
			}
			code := "Unknown"
			if t.Details.Error != "" {
				code = t.Details.Error
			}
			ticketErrors[code]++
			if code == "DeviceNotRegistered" {
				dead = append(dead, to)
			}
		}
	}
	if len(ticketErrors) > 0 {
		slog.ErrorContext(ctx, "Expo refused push messages", "action", "push_ticket_errors", "category", p.Category, "codes", ticketErrors)
	}
	if len(accepted) > 0 {
		_, _ = s.DB.Collection("pushtickets").InsertMany(ctx, accepted, options.InsertMany().SetOrdered(false))
	}

	webSent, webDead := s.toBrowsers(ctx, web, p, high, deepLink)
	sent += webSent
	dead = append(dead, webDead...)
	revoked := 0
	if len(dead) > 0 {
		if r, err := s.DB.Collection("devicetokens").UpdateMany(ctx,
			bson.D{{Key: "token", Value: bson.D{{Key: "$in", Value: dead}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REVOKED"}}}}); err == nil {
			revoked = int(r.ModifiedCount)
		}
	}
	return Result{Revoked: revoked, Sent: sent}
}

// optional mirrors a JS undefined, which JSON.stringify drops.
func optional(s string) any {
	if s == "" {
		return nil
	}
	return s
}

type ticket struct {
	Status  string `json:"status"`
	ID      string `json:"id"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

func (s *Sender) postBatch(ctx context.Context, batch []map[string]any) []ticket {
	for _, m := range batch {
		if d, ok := m["data"].(map[string]any); ok {
			for k, v := range d {
				if v == nil {
					delete(d, k) // undefined, not null
				}
			}
		}
	}
	body, _ := json.Marshal(batch)
	req, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodPost, s.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("content-type", "application/json")
	if s.ExpoToken != "" {
		req.Header.Set("authorization", "Bearer "+s.ExpoToken)
	}
	res, err := s.HTTP.Do(req)
	if err != nil {
		slog.ErrorContext(ctx, "Expo push request failed", "action", "push_batch_request_failed", "count", len(batch), "error", err.Error())
		return nil
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		slog.ErrorContext(ctx, "Expo rejected a push batch", "action", "push_batch_http_error", "body", string(raw[:min(len(raw), 400)]), "count", len(batch), "status", res.StatusCode)
		return nil
	}
	var payload struct {
		Data []ticket `json:"data"`
	}
	_ = json.Unmarshal(raw, &payload)
	return payload.Data
}

// webPayload is WebPushPayload, in TS's key order.
type webPayload struct {
	Badge          string `json:"badge"`
	Body           string `json:"body"`
	Category       string `json:"category"`
	Icon           string `json:"icon"`
	Image          string `json:"image,omitempty"`
	NotificationID string `json:"notificationId,omitempty"`
	Tag            string `json:"tag"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	Urgent         bool   `json:"urgent"`
}

func (s *Sender) roles(ctx context.Context, userIDs []string) map[string]string {
	out := map[string]string{}
	cur, err := s.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: objectIDs(userIDs)}}}})
	if err != nil {
		return out
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Role string        `bson:"role"`
	}
	if cur.All(ctx, &rows) == nil {
		for _, r := range rows {
			out[r.ID.Hex()] = r.Role
		}
	}
	return out
}

// toBrowsers groups subscriptions by the portal a click should open, then sends.
func (s *Sender) toBrowsers(ctx context.Context, targets []device, p Payload, high bool, deepLink string) (int, []string) {
	if len(targets) == 0 || !s.WebPushConfigured() {
		return 0, nil
	}
	var ids []string
	for _, t := range targets {
		ids = append(ids, t.UserID.Hex())
	}
	roles := s.roles(ctx, ids)
	var order []string
	groups := map[string][]device{}
	for _, t := range targets {
		role := roles[t.UserID.Hex()]
		if slices.Contains(t.Capabilities, PWAPush) {
			role = PWAPush
		}
		if _, ok := groups[role]; !ok {
			order = append(order, role)
		}
		groups[role] = append(groups[role], t)
	}
	tag := p.NotificationID
	if tag == "" {
		tag = p.Category + ":" + p.HostelID
	}
	sent := 0
	var dead []string
	for _, role := range order {
		link := "/app?push=" + httpx.EncodeURIComponent(deepLink)
		if role != PWAPush {
			link = ""
			if s.Hooks.WebLink != nil {
				link = s.Hooks.WebLink(p, role)
			}
		}
		body, _ := json.Marshal(webPayload{"/notification-badge.png", p.Body, p.Category, "/notification-icon.png",
			p.ImageURL, p.NotificationID, tag, p.Title, link, high})
		n, gone := s.sendWeb(groups[role], body, high)
		sent += n
		dead = append(dead, gone...)
	}
	return sent, dead
}

// sendWeb is sendWebPush: fifty at a time; 404/410 mark a subscription dead.
func (s *Sender) sendWeb(targets []device, body []byte, urgent bool) (int, []string) {
	urgency := webpush.UrgencyNormal
	if urgent {
		urgency = webpush.UrgencyHigh
	}
	var mu sync.Mutex
	sent := 0
	var dead []string
	for start := 0; start < len(targets); start += maxWebInFlight {
		var wg sync.WaitGroup
		for _, t := range targets[start:min(start+maxWebInFlight, len(targets))] {
			if t.Keys == nil || t.Keys.Auth == "" || t.Keys.P256dh == "" {
				continue
			}
			wg.Add(1)
			go func(t device) {
				defer wg.Done()
				res, err := webpush.SendNotification(body, &webpush.Subscription{
					Endpoint: t.Token, Keys: webpush.Keys{Auth: t.Keys.Auth, P256dh: t.Keys.P256dh},
				}, &webpush.Options{
					HTTPClient: s.HTTP, Subscriber: s.VAPID.VAPIDSubject, TTL: webTTLSeconds, Urgency: urgency,
					VAPIDPublicKey: s.VAPID.VAPIDPublicKey, VAPIDPrivateKey: s.VAPID.VAPIDPrivateKey,
				})
				if err != nil {
					return
				}
				res.Body.Close()
				mu.Lock()
				defer mu.Unlock()
				switch {
				case res.StatusCode == 404 || res.StatusCode == 410:
					dead = append(dead, t.Token)
				case res.StatusCode >= 200 && res.StatusCode < 300:
					sent++
				}
			}(t)
		}
		wg.Wait()
	}
	return sent, dead
}
