// Package realtime is Pusher, a port of apps/web/src/lib/realtime/*: the same
// channels, events and topic bridge, published over Pusher's HTTP API and
// signed by hand (requests.js / auth.js in the `pusher` npm package), held to
// testdata/vectors/realtime.json.
//
// With PUSHER_* unset every publish is a no-op and portals fall back to polling.
package realtime

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
)

// Events.
const (
	NotificationNew     = "notification:new"
	NotificationUpdated = "notification:updated"
	ResourceChanged     = "resource:changed"
	GlobalAnnouncement  = "global:announcement"
	TrackSheetFocus     = "track-sheet:focus"
	TrackSheetSaved     = "track-sheet:saved"
)

// Channels.
const (
	PlatformChannel   = "private-platform"
	GlobalChannel     = "private-global"
	TrackSheetChannel = "presence-hostel-registration-track-sheet"
)

func UserChannel(userID string) string     { return "private-user-" + userID }
func HostelChannel(hostelID string) string { return "private-hostel-" + hostelID }

// ChannelsFor is every channel a principal may subscribe to (the track sheet aside).
func ChannelsFor(p *authz.Principal) []string {
	channels := []string{UserChannel(p.UserID), GlobalChannel}
	for _, id := range p.HostelIDs {
		channels = append(channels, HostelChannel(id))
	}
	if slices.Contains(authz.PlatformRoles, p.Role) {
		channels = append(channels, PlatformChannel)
	}
	return channels
}

// CanSubscribe is canSubscribeToChannel.
func CanSubscribe(p *authz.Principal, channel string) bool {
	if channel == TrackSheetChannel {
		return slices.Contains(authz.TeamRoles, p.Role)
	}
	return slices.Contains(ChannelsFor(p), channel)
}

// Bumper invalidates hostel read caches before a change is announced (cache.Cache.Bump).
type Bumper interface {
	Bump(ctx context.Context, hostelIDs ...string)
}

// Client publishes; nil-safe methods make "not configured" a no-op.
type Client struct {
	cfg  config.Pusher
	host string // https://api-<cluster>.pusher.com; tests point it at a fake
	http *http.Client
	now  func() time.Time
}

// New returns nil when Pusher is not configured.
func New(cfg config.Pusher) *Client {
	if !cfg.Configured() {
		return nil
	}
	return &Client{cfg: cfg, host: "https://api-" + cfg.Cluster + ".pusher.com",
		http: &http.Client{Timeout: 10 * time.Second}, now: time.Now}
}

func (c *Client) Configured() bool { return c != nil }

func (c *Client) sign(data string) string {
	mac := hmac.New(sha256.New, []byte(c.cfg.Secret))
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

// Auth is the channel-authorization answer the client library expects.
type Auth struct {
	Auth        string `json:"auth"`
	ChannelData string `json:"channel_data,omitempty"`
}

// Authorize signs a subscription; member (presence channels) must marshal in
// TS's key order — pass an ordered struct, not a map. nil when not configured.
func (c *Client) Authorize(socketID, channel string, member any) (*Auth, error) {
	if c == nil {
		return nil, nil
	}
	if err := validSocketID(socketID); err != nil {
		return nil, err
	}
	if channel == "" || len(channel) > 200 || strings.ContainsFunc(channel, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_-=@,.;", r))
	}) {
		return nil, fmt.Errorf("Invalid channel name: '%s'", channel)
	}
	a := &Auth{}
	data := socketID + ":" + channel
	if member != nil {
		b, err := marshal(member)
		if err != nil {
			return nil, err
		}
		a.ChannelData = string(b)
		data += ":" + a.ChannelData
	}
	a.Auth = c.cfg.Key + ":" + c.sign(data)
	return a, nil
}

func validSocketID(id string) error {
	left, right, ok := strings.Cut(id, ".")
	if !ok || left == "" || right == "" || strings.Trim(left, "0123456789") != "" || strings.Trim(right, "0123456789") != "" {
		return fmt.Errorf("Invalid socket id: '%s'", id)
	}
	return nil
}

// marshal is JSON.stringify: no HTML escaping, no trailing newline.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// signedQuery is createSignedQueryString for a POST body.
func (c *Client) signedQuery(path string, body []byte) string {
	sum := md5.Sum(body)
	query := "auth_key=" + c.cfg.Key +
		"&auth_timestamp=" + strconv.FormatInt(c.now().Unix(), 10) +
		"&auth_version=1.0" +
		"&body_md5=" + hex.EncodeToString(sum[:])
	return query + "&auth_signature=" + c.sign("POST\n"+path+"\n"+query)
}

// Event is one batch entry; Data is sent as a JSON string as ensureJSON does.
type Event struct {
	Channel string
	Name    string
	Data    any
}

// Publish sends events ten at a time; failures are logged, never returned.
func (c *Client) Publish(ctx context.Context, events []Event) {
	if c == nil || len(events) == 0 {
		return
	}
	type wire struct {
		Channel string `json:"channel"`
		Name    string `json:"name"`
		Data    string `json:"data"`
	}
	for start := 0; start < len(events); start += 10 {
		batch := make([]wire, 0, 10)
		for _, e := range events[start:min(start+10, len(events))] {
			data, ok := e.Data.(string)
			if !ok {
				b, err := marshal(e.Data)
				if err != nil {
					slog.WarnContext(ctx, "realtime publish failed", "error", err.Error())
					return
				}
				data = string(b)
			}
			batch = append(batch, wire{e.Channel, e.Name, data})
		}
		if err := c.post(ctx, batch); err != nil {
			slog.WarnContext(ctx, "realtime publish failed", "error", err.Error())
			return
		}
	}
}

func (c *Client) post(ctx context.Context, batch any) error {
	body, err := marshal(map[string]any{"batch": batch})
	if err != nil {
		return err
	}
	path := "/apps/" + c.cfg.AppID + "/batch_events"
	req, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodPost, c.host+path+"?"+c.signedQuery(path, body), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("pusher %d: %s", res.StatusCode, b)
	}
	return nil
}

// PublishNotification is a new notification row for one user.
func (c *Client) PublishNotification(ctx context.Context, userID string, notification any) {
	c.Publish(ctx, []Event{{UserChannel(userID), NotificationNew, notification}})
}

func (c *Client) PublishNotificationUpdated(ctx context.Context, userID, notificationID string) {
	c.Publish(ctx, []Event{{UserChannel(userID), NotificationUpdated, struct {
		ID string `json:"id"`
	}{notificationID}}})
}

// Announcement is publishGlobalAnnouncement's input; Category defaults to
// ANNOUNCEMENT and Priority to NORMAL.
type Announcement struct {
	Body       string `json:"body"`
	CampaignID string `json:"campaignId,omitempty"`
	Category   string `json:"category"`
	Priority   string `json:"priority"`
	SentAt     string `json:"sentAt"`
	Title      string `json:"title"`
	URL        string `json:"url,omitempty"`
}

func (c *Client) PublishGlobalAnnouncement(ctx context.Context, a Announcement) {
	if c == nil {
		return
	}
	if a.Category == "" {
		a.Category = "ANNOUNCEMENT"
	}
	if a.Priority == "" {
		a.Priority = "NORMAL"
	}
	a.SentAt = c.now().UTC().Format("2006-01-02T15:04:05.000Z")
	c.Publish(ctx, []Event{{GlobalChannel, GlobalAnnouncement, a}})
}

// Change is publishResourceChange's input.
type Change struct {
	Topics           []Topic
	HostelIDs        []string
	UserIDs          []string
	Platform, Global bool
}

// PublishResourceChange bumps the hostels' read caches, then tells every
// audience channel which topics moved. The bump runs even with Pusher off.
func PublishResourceChange(ctx context.Context, c *Client, cache Bumper, ch Change) {
	if len(ch.Topics) == 0 {
		return
	}
	if cache != nil {
		cache.Bump(ctx, ch.HostelIDs...)
	}
	if c == nil {
		return
	}
	var channels []string
	add := func(name string) {
		if !slices.Contains(channels, name) {
			channels = append(channels, name)
		}
	}
	for _, id := range ch.HostelIDs {
		if id != "" {
			add(HostelChannel(id))
		}
	}
	for _, id := range ch.UserIDs {
		if id != "" {
			add(UserChannel(id))
		}
	}
	if ch.Platform {
		add(PlatformChannel)
	}
	if ch.Global {
		add(GlobalChannel)
	}
	data := struct {
		Topics []Topic `json:"topics"`
	}{ch.Topics}
	events := make([]Event, len(channels))
	for i, name := range channels {
		events[i] = Event{name, ResourceChanged, data}
	}
	c.Publish(ctx, events)
}

func (c *Client) PublishTrackSheet(ctx context.Context, name string, data any) {
	c.Publish(ctx, []Event{{TrackSheetChannel, name, data}})
}
