package notifications

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerInbox(v1 *gin.RouterGroup) {
	v1.GET("/notifications", httpx.ETag(), h.list)
	v1.PATCH("/notifications/read-all", h.readAll)
	v1.PATCH("/notifications/:id/read", h.read)
	v1.PATCH("/notifications/:id/resolve", h.resolve)
	v1.GET("/push/status", httpx.ETag(), h.pushStatus)
	v1.POST("/push/subscribe", h.pushSubscribe)
	v1.POST("/push/unsubscribe", h.pushUnsubscribe)
	v1.POST("/mobile/device-token", h.saveDevice)
	v1.DELETE("/mobile/device-token", h.revokeDevice)
	v1.POST("/realtime/auth", h.realtimeAuth)
	v1.GET("/realtime/config", httpx.ETag(), h.realtimeConfig)
	v1.GET("/account/email-preferences", httpx.ETag(), h.getEmailPref)
	v1.PATCH("/account/email-preferences", h.patchEmailPref)
	v1.GET("/account/notification-preferences", httpx.ETag(), h.getNotifPref)
	v1.PATCH("/account/notification-preferences", h.patchNotifPref)
}

// wrote stores a handler's answer or its failure.
func wrote(c *gin.Context, status int, data any, message string, err error) {
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, status, data, message)
}

// serializeStored is serializeNotification over a stored row.
func serializeStored(raw bson.Raw) ordered.Map {
	str := func(k string) any {
		if s, ok := raw.Lookup(k).StringValueOK(); ok {
			return s
		}
		return ordered.Undefined
	}
	date := func(k string) any {
		if t, ok := raw.Lookup(k).TimeOK(); ok {
			return httpx.ISO(t)
		}
		return ordered.Undefined
	}
	strOr := func(k, def string) string {
		if s, ok := raw.Lookup(k).StringValueOK(); ok {
			return s
		}
		return def
	}
	kind := strOr("kind", "NORMAL")
	state := strOr("actionState", "PENDING")
	var actions any = []any{}
	if v, err := raw.LookupErr("actions"); err == nil && kind == "ACTION" && v.Type != bson.TypeNull {
		actions = ordered.FromBSON(v)
	}
	var data any = ordered.Map{}
	if v, err := raw.LookupErr("data"); err == nil && v.Type != bson.TypeNull {
		data = ordered.FromBSON(v)
	}
	hostel := any(ordered.Undefined)
	if id, ok := raw.Lookup("hostelId").ObjectIDOK(); ok {
		hostel = id.Hex()
	}
	id, _ := raw.Lookup("_id").ObjectIDOK()
	uid, _ := raw.Lookup("userId").ObjectIDOK()
	_, read := raw.Lookup("readAt").TimeOK()
	return ordered.Map{{Key: "actions", Value: actions}, {Key: "actionState", Value: state},
		{Key: "actionTakenAt", Value: date("actionTakenAt")}, {Key: "actionTakenKey", Value: str("actionTakenKey")},
		{Key: "actionUrl", Value: str("actionUrl")}, {Key: "body", Value: str("body")}, {Key: "category", Value: str("category")},
		{Key: "channel", Value: str("channel")}, {Key: "createdAt", Value: date("createdAt")}, {Key: "data", Value: data},
		{Key: "hostelId", Value: hostel}, {Key: "id", Value: id.Hex()}, {Key: "isRead", Value: read}, {Key: "kind", Value: kind},
		{Key: "needsAction", Value: kind == "ACTION" && state == "PENDING"}, {Key: "priority", Value: strOr("priority", "NORMAL")},
		{Key: "readAt", Value: date("readAt")}, {Key: "status", Value: str("status")}, {Key: "title", Value: str("title")},
		{Key: "userId", Value: uid.Hex()}}
}

type notificationList struct {
	ActionCount   int64           `json:"actionCount"`
	Notifications []ordered.Map   `json:"notifications"`
	Pagination    pagination.Meta `json:"pagination"`
	UnreadCount   int64           `json:"unreadCount"`
}

func (h *Handler) list(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	mine := bson.D{{Key: "userId", Value: uid}}
	unread := append(bson.D{}, append(mine, bson.E{Key: "readAt", Value: bson.D{{Key: "$exists", Value: false}}})...)
	action := append(bson.D{}, append(mine, bson.E{Key: "actionState", Value: "PENDING"}, bson.E{Key: "kind", Value: "ACTION"})...)
	filter := mine
	switch c.Query("filter") {
	case "unread":
		filter = unread
	case "action":
		filter = action
	}
	if s := c.Query("since"); s != "" {
		if t, ok := valid.CoerceDate(s); ok {
			filter = append(append(bson.D{}, filter...), bson.E{Key: "createdAt", Value: bson.D{{Key: "$gt", Value: t}}})
		}
	}
	size := pagination.MaxPageSize
	q := pagination.Query{PageSize: &size}
	rng := pagination.RangeOf(q)
	coll := h.db.Collection("notifications")
	cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(rng.Skip)).SetLimit(int64(rng.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	defer func() { _ = cur.Close(c) }()
	out := notificationList{Notifications: []ordered.Map{}}
	for cur.Next(c) {
		out.Notifications = append(out.Notifications, serializeStored(cur.Current))
	}
	if err = cur.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := coll.CountDocuments(c, filter)
	if err == nil {
		out.UnreadCount, err = coll.CountDocuments(c, unread)
	}
	if err == nil {
		out.ActionCount, err = coll.CountDocuments(c, action)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out.Pagination = pagination.MetaOf(q, int(total))
	httpx.OK(c, out, "Notifications loaded")
}

type oneNotification struct {
	Notification ordered.Map `json:"notification"`
}

func notFound() error {
	return httpx.NewError(http.StatusNotFound, "NOTIFICATION_NOT_FOUND", "Notification was not found.", nil)
}

// updateOwn is the shared findOneAndUpdate of read and resolve: only ever the caller's own row.
func (h *Handler) updateOwn(c *gin.Context, p *authz.Principal, extra bson.D, set bson.D) (oneNotification, error) {
	id, err := httpx.OID(c.Param("id"), "notification id")
	if err != nil {
		return oneNotification{}, err
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return oneNotification{}, err
	}
	filter := append(bson.D{{Key: "_id", Value: id}}, extra...)
	filter = append(filter, bson.E{Key: "userId", Value: uid})
	var raw bson.Raw
	err = h.db.Collection("notifications").FindOneAndUpdate(c, filter,
		bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedBy", Value: uid}, bson.E{Key: "updatedAt", Value: time.Now().UTC()})}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return oneNotification{}, notFound()
	}
	if err != nil {
		return oneNotification{}, err
	}
	h.rt.PublishNotificationUpdated(c, p.UserID, c.Param("id"))
	return oneNotification{serializeStored(raw)}, nil
}

func (h *Handler) read(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.updateOwn(c, p, nil, bson.D{{Key: "readAt", Value: time.Now().UTC()}})
	wrote(c, http.StatusOK, out, "Notification marked read", err)
}

func (h *Handler) resolve(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c) // request.json().catch(() => ({}))
	if err != nil {
		body = map[string]any{}
	}
	f := valid.NewForm(body)
	key, hasKey := f.Str("actionKey", valid.S{Opt: true, Max: 64})
	state, hasState := f.Enum("state", true, nil, "COMPLETED", "DISMISSED")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasState {
		state = "COMPLETED"
	}
	now := time.Now().UTC()
	set := bson.D{{Key: "actionState", Value: state}, {Key: "actionTakenAt", Value: now}}
	if hasKey {
		set = append(set, bson.E{Key: "actionTakenKey", Value: key})
	}
	set = append(set, bson.E{Key: "readAt", Value: now})
	out, err := h.updateOwn(c, p, bson.D{{Key: "kind", Value: "ACTION"}}, set)
	wrote(c, http.StatusOK, out, "Notification resolved", err)
}

type markedRead struct {
	MarkedRead int64 `json:"markedRead"`
}

func (h *Handler) readAll(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC()
	res, err := h.db.Collection("notifications").UpdateMany(c,
		bson.D{{Key: "readAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "userId", Value: uid}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "readAt", Value: now}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.rt.PublishNotificationUpdated(c, p.UserID, "all")
	httpx.OK(c, markedRead{res.ModifiedCount}, "Notifications marked as read")
}

// --- browser push + device tokens (one DeviceToken collection for both) -----

type pushStatus struct {
	Configured    bool  `json:"configured"`
	Enabled       bool  `json:"enabled"`
	Subscriptions int64 `json:"subscriptions"`
}

func (h *Handler) pushStatus(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	n, err := h.db.Collection("devicetokens").CountDocuments(c, bson.D{{Key: "platform", Value: "WEB"}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: uid}})
	wrote(c, http.StatusOK, pushStatus{h.push.WebPushConfigured(), n > 0, n}, "Browser notification status loaded", err)
}

type subscribed struct {
	Subscribed bool `json:"subscribed"`
}

func (h *Handler) pushSubscribe(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !h.push.WebPushConfigured() {
		httpx.Fail(c, httpx.NewError(http.StatusServiceUnavailable, "WEB_PUSH_NOT_CONFIGURED", "Browser notifications are not configured on this deployment.", nil))
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var endpoint, auth, p256dh string
	expiration := any(nil)
	f.Nest("subscription", false, func(s *valid.Form) {
		endpoint, _ = s.Str("endpoint", valid.S{Trim: true, Min: 12, Max: 2048})
		if endpoint != "" && len(endpoint) >= 12 && (len(endpoint) < 8 || endpoint[:8] != "https://") {
			s.Is.Add("endpoint", "A push endpoint has to be an https URL.")
		}
		if v, present := s.M["expirationTime"]; present && v != nil {
			if n, ok := s.Num("expirationTime", valid.N{Opt: true, Int: true}); ok {
				expiration = n
			}
		}
		s.Nest("keys", false, func(k *valid.Form) {
			auth, _ = k.Str("auth", valid.S{Trim: true, Min: 8, Max: 256})
			p256dh, _ = k.Str("p256dh", valid.S{Trim: true, Min: 8, Max: 256})
		})
	})
	app, _ := f.Bool("app", true, nil)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	caps := bson.A{}
	if app {
		caps = append(caps, push.PWAPush)
	}
	now := time.Now().UTC()
	set := bson.D{{Key: "capabilities", Value: caps}, {Key: "expirationTime", Value: expiration},
		{Key: "keys", Value: bson.D{{Key: "auth", Value: auth}, {Key: "p256dh", Value: p256dh}}}, {Key: "lastSeenAt", Value: now},
		{Key: "platform", Value: "WEB"}, {Key: "status", Value: "ACTIVE"}}
	if ua, ok := c.Request.Header["User-Agent"]; ok && len(ua) > 0 {
		set = append(set, bson.E{Key: "userAgent", Value: valid.Trim(valid.JSPrefix(ua[0], 400))})
	}
	set = append(set, bson.E{Key: "userId", Value: uid}, bson.E{Key: "updatedAt", Value: now})
	_, err = h.db.Collection("devicetokens").UpdateOne(c, bson.D{{Key: "token", Value: endpoint}},
		bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.UpdateOne().SetUpsert(true))
	wrote(c, http.StatusCreated, subscribed{true}, "Browser notifications are on", err)
}

type revoked struct {
	Revoked int64 `json:"revoked"`
}

// revokeToken is scoped to the caller: an address is not a secret, so quoting
// someone else's must do nothing. Never an error when it matches nothing.
func (h *Handler) revokeToken(ctx context.Context, userID, token string) (revoked, error) {
	uid, err := httpx.OID(userID, "user id")
	if err != nil {
		return revoked{}, err
	}
	res, err := h.db.Collection("devicetokens").UpdateMany(ctx, bson.D{{Key: "token", Value: token}, {Key: "userId", Value: uid}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: time.Now().UTC()}}}})
	if err != nil {
		return revoked{}, err
	}
	return revoked{res.ModifiedCount}, nil
}

func (h *Handler) pushUnsubscribe(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	endpoint, _ := f.Str("endpoint", valid.S{Trim: true, Min: 12, Max: 2048})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.revokeToken(c, p.UserID, endpoint)
	wrote(c, http.StatusOK, out, "Browser notifications are off", err)
}

type deviceToken struct {
	DeviceID   string `json:"deviceId"`
	ID         string `json:"id"`
	LastSeenAt string `json:"lastSeenAt"`
	Platform   string `json:"platform"`
	Status     string `json:"status"`
	Token      string `json:"token"`
	UserID     string `json:"userId"`
}

type savedDevice struct {
	DeviceToken deviceToken `json:"deviceToken"`
}

func (h *Handler) saveDevice(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	caps := bson.A{}
	if list, ok := f.Array("capabilities", true, false); ok {
		for i, raw := range list {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if s, ok := sub.Str("v", valid.S{Trim: true, Min: 1, Max: 64}); ok {
				caps = append(caps, s)
			}
			f.JoinScalar("capabilities."+strconv.Itoa(i), sub)
		}
		f.Size("capabilities", len(list), 0, 20, "", false)
	}
	deviceID, hasDevice := f.Str("deviceId", valid.S{Opt: true, Trim: true, Max: 160})
	platform, _ := f.Enum("platform", false, nil, "IOS", "ANDROID", "WEB")
	token, _ := f.Str("token", valid.S{Trim: true, Min: 8, Max: 4096})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC()
	set := bson.D{{Key: "capabilities", Value: caps}}
	if hasDevice {
		set = append(set, bson.E{Key: "deviceId", Value: deviceID})
	}
	set = append(set, bson.E{Key: "lastSeenAt", Value: now}, bson.E{Key: "platform", Value: platform}, bson.E{Key: "status", Value: "ACTIVE"},
		bson.E{Key: "userId", Value: uid}, bson.E{Key: "updatedAt", Value: now})
	var row struct {
		ID         bson.ObjectID `bson:"_id"`
		DeviceID   string        `bson:"deviceId"`
		LastSeenAt time.Time     `bson:"lastSeenAt"`
		Platform   string        `bson:"platform"`
		Status     string        `bson:"status"`
		Token      string        `bson:"token"`
		UserID     bson.ObjectID `bson:"userId"`
	}
	err = h.db.Collection("devicetokens").FindOneAndUpdate(c, bson.D{{Key: "token", Value: token}},
		bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: bson.D{{Key: "expirationTime", Value: nil}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, savedDevice{deviceToken{row.DeviceID, row.ID.Hex(), httpx.ISO(row.LastSeenAt), row.Platform, row.Status, row.Token, row.UserID.Hex()}}, "Device token saved")
}

func (h *Handler) revokeDevice(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	token, _ := f.Str("token", valid.S{Trim: true, Min: 8, Max: 4096})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.revokeToken(c, p.UserID, token)
	wrote(c, http.StatusOK, out, "Device token revoked", err)
}

// --- realtime ----------------------------------------------------------------

type realtimeConfig struct {
	Channels []string `json:"channels"`
	Cluster  string   `json:"cluster"`
	Enabled  bool     `json:"enabled"`
	Key      string   `json:"key"`
}

func (h *Handler) realtimeConfig(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !h.rt.Configured() {
		httpx.OK(c, realtimeConfig{Channels: []string{}}, "Realtime is not configured")
		return
	}
	httpx.OK(c, realtimeConfig{realtime.ChannelsFor(p), h.pusher.Cluster, true, h.pusher.Key}, "Realtime configuration loaded")
}

type bareError struct {
	Error string `json:"error"`
}

type memberInfo struct {
	Email string  `json:"email"`
	Image *string `json:"image"`
	Name  string  `json:"name"`
}

type member struct {
	UserID   string     `json:"user_id"`
	UserInfo memberInfo `json:"user_info"`
}

// realtimeAuth answers Pusher's subscribe: form fields in, the bare {auth} out,
// no envelope. A body that is not a form throws in request.formData() → 500.
func (h *Handler) realtimeAuth(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := c.Request.ParseMultipartForm(1 << 16); err != nil {
		if err != http.ErrNotMultipart {
			httpx.Fail(c, err)
			return
		}
		ct := c.ContentType()
		if ct != "application/x-www-form-urlencoded" {
			httpx.Fail(c, errNotForm)
			return
		}
		_ = c.Request.ParseForm()
	}
	socketID, channel := c.Request.PostForm.Get("socket_id"), c.Request.PostForm.Get("channel_name")
	if socketID == "" || channel == "" {
		httpx.Bare(c, http.StatusBadRequest, bareError{"Missing socket_id or channel_name"})
		return
	}
	if !realtime.CanSubscribe(p, channel) {
		httpx.Bare(c, http.StatusForbidden, bareError{"Forbidden channel"})
		return
	}
	var m any
	if len(channel) > 9 && channel[:9] == "presence-" {
		uid, err := httpx.OID(p.UserID, "user id")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var u struct {
			Email string  `bson:"email"`
			Image *string `bson:"image"`
			Name  *string `bson:"name"`
		}
		if err := h.db.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: uid}}).Decode(&u); err != nil && err != mongo.ErrNoDocuments {
			httpx.Fail(c, err)
			return
		}
		name := "Team member"
		if u.Name != nil && *u.Name != "" {
			name = *u.Name
		}
		m = member{p.UserID, memberInfo{u.Email, u.Image, name}}
	}
	a, err := h.rt.Authorize(socketID, channel, m)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if a == nil {
		httpx.Bare(c, http.StatusServiceUnavailable, bareError{"Realtime is not configured"})
		return
	}
	httpx.Bare(c, http.StatusOK, a)
}

var errNotForm = httpx.ErrBadForm

// --- preferences -------------------------------------------------------------

type emailPref struct {
	HasEmail    bool     `json:"hasEmail"`
	MutedTopics []string `json:"mutedTopics"`
}

type wrappedEmailPref struct {
	Preference emailPref `json:"preference"`
}

// accountAddresses is every address this account is mailed at: its own and the
// one on its resident record.
func (h *Handler) accountAddresses(ctx context.Context, userID string) ([]string, error) {
	uid, err := httpx.OID(userID, "user id")
	if err != nil {
		return nil, err
	}
	var u struct {
		Email string `bson:"email"`
	}
	err = h.db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: uid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}})).Decode(&u)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	cur, err := h.db.Collection("residents").Find(ctx, bson.D{{Key: "isDeleted", Value: false}, {Key: "userId", Value: uid}},
		options.Find().SetProjection(bson.D{{Key: "email", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Email string `bson:"email"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	seen, out := map[string]bool{}, []string{}
	add := func(a string) {
		if a != "" && !seen[norm(a)] {
			seen[norm(a)] = true
			out = append(out, norm(a))
		}
	}
	add(u.Email)
	for _, r := range rows {
		add(r.Email)
	}
	return out, nil
}

func (h *Handler) getEmailPref(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	addrs, err := h.accountAddresses(c, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.db.Collection("emailpreferences").Find(c, bson.D{{Key: "email", Value: bson.D{{Key: "$in", Value: addrs}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		Muted []string `bson:"mutedTopics"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	seen, muted := map[string]bool{}, []string{}
	for _, r := range rows {
		for _, t := range r.Muted {
			if !seen[t] && email.IsTopic(t) {
				seen[t] = true
				muted = append(muted, t)
			}
		}
	}
	httpx.OK(c, wrappedEmailPref{emailPref{len(addrs) > 0, muted}}, "Email preferences loaded")
}

func (h *Handler) patchEmailPref(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	topicValues := make([]string, len(email.Topics))
	for i, t := range email.Topics {
		topicValues[i] = string(t.Value)
	}
	topics := []string{}
	if list, ok := f.Array("mutedTopics", false, false); ok {
		for i, raw := range list {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if s, ok := sub.Enum("v", false, nil, topicValues...); ok {
				topics = append(topics, s)
			}
			f.JoinScalar("mutedTopics."+strconv.Itoa(i), sub)
		}
		f.Size("mutedTopics", len(list), 0, len(topicValues), "", false)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	addrs, err := h.accountAddresses(c, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	seen, muted := map[string]bool{}, []string{}
	if len(addrs) > 0 {
		for _, t := range topics {
			if !seen[t] {
				seen[t] = true
				muted = append(muted, t)
			}
		}
		for _, a := range addrs {
			if err := h.setMuted(c, a, muted); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
	}
	httpx.OK(c, wrappedEmailPref{emailPref{len(addrs) > 0, muted}}, "Email preferences saved")
}

type notifPref struct {
	MutedCategories   []string `json:"mutedCategories" bson:"mutedCategories"`
	PushEnabled       bool     `json:"pushEnabled" bson:"pushEnabled"`
	QuietHoursEnabled bool     `json:"quietHoursEnabled" bson:"quietHoursEnabled"`
	QuietHoursEnd     int      `json:"quietHoursEnd" bson:"quietHoursEnd"`
	QuietHoursStart   int      `json:"quietHoursStart" bson:"quietHoursStart"`
	TimeZone          string   `json:"timeZone" bson:"timeZone"`
}

type wrappedNotifPref struct {
	Preference notifPref `json:"preference"`
}

func defaultNotifPref() notifPref {
	return notifPref{[]string{}, true, false, 7 * 60, 22 * 60, "Asia/Kathmandu"}
}

func (h *Handler) getNotifPref(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := defaultNotifPref()
	err = h.db.Collection("notificationpreferences").FindOne(c, bson.D{{Key: "userId", Value: uid}}).Decode(&out)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, wrappedNotifPref{normalPref(out)}, "Notification preferences loaded")
}

func normalPref(p notifPref) notifPref {
	if p.MutedCategories == nil {
		p.MutedCategories = []string{}
	}
	if p.TimeZone == "" {
		p.TimeZone = "Asia/Kathmandu"
	}
	return p
}

func (h *Handler) patchNotifPref(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	set := bson.D{}
	if list, ok := f.Array("mutedCategories", true, false); ok {
		muted := bson.A{}
		for i, raw := range list {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if s, ok := sub.Str("v", valid.S{Trim: true, Min: 1, Max: 40}); ok {
				muted = append(muted, s)
			}
			f.JoinScalar("mutedCategories."+strconv.Itoa(i), sub)
		}
		f.Size("mutedCategories", len(list), 0, 40, "", false)
		set = append(set, bson.E{Key: "mutedCategories", Value: muted})
	}
	if v, ok := f.Bool("pushEnabled", true, nil); ok {
		set = append(set, bson.E{Key: "pushEnabled", Value: v})
	}
	if v, ok := f.Bool("quietHoursEnabled", true, nil); ok {
		set = append(set, bson.E{Key: "quietHoursEnabled", Value: v})
	}
	minute := valid.N{Opt: true, Int: true, Min: valid.P(0), Max: valid.P(1439)}
	if v, ok := f.Num("quietHoursEnd", minute); ok {
		set = append(set, bson.E{Key: "quietHoursEnd", Value: int32(v)})
	}
	if v, ok := f.Num("quietHoursStart", minute); ok {
		set = append(set, bson.E{Key: "quietHoursStart", Value: int32(v)})
	}
	if v, ok := f.Str("timeZone", valid.S{Opt: true, Trim: true, Min: 1, Max: 64}); ok {
		set = append(set, bson.E{Key: "timeZone", Value: v})
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC()
	set = append(set, bson.E{Key: "userId", Value: uid}, bson.E{Key: "updatedAt", Value: now})
	// setDefaultsOnInsert: every default the patch didn't set lands on insert.
	onInsert := bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}
	has := func(k string) bool {
		for _, e := range set {
			if e.Key == k {
				return true
			}
		}
		return false
	}
	for _, d := range []bson.E{{Key: "pushEnabled", Value: true}, {Key: "quietHoursEnabled", Value: false}, {Key: "quietHoursStart", Value: int32(22 * 60)},
		{Key: "quietHoursEnd", Value: int32(7 * 60)}, {Key: "timeZone", Value: "Asia/Kathmandu"}, {Key: "mutedCategories", Value: bson.A{}}} {
		if !has(d.Key) {
			onInsert = append(onInsert, d)
		}
	}
	out := defaultNotifPref()
	err = h.db.Collection("notificationpreferences").FindOneAndUpdate(c, bson.D{{Key: "userId", Value: uid}},
		bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: onInsert}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&out)
	wrote(c, http.StatusOK, wrappedNotifPref{normalPref(out)}, "Notification preferences saved", err)
}
