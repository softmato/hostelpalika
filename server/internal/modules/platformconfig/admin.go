package platformconfig

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bytedance/sonic"
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

// Admin is the superadmin's config editors: site config sections, operations
// config, and the emailed confirmation a money-touching setting needs
// (site-config.service, operations-config, setting-change.service).
type Admin struct {
	Config  *Service
	DB      *mongo.Database
	Guards  *authz.Guards
	Audit   *audit.Log
	Mail    *email.Sender
	SiteURL string
	Now     func() time.Time
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	super := authz.Use(a.Guards.RequireSuperadmin)
	v1.GET("/platform/site-config", super, httpx.ETag(), a.siteConfig)
	v1.PUT("/platform/site-config/:section", super, a.putSection)
	v1.GET("/platform/operations-config", super, httpx.ETag(), a.operations)
	v1.PUT("/platform/operations-config", super, a.putOperations)
	v1.GET("/platform/setting-changes/confirm", super, httpx.ETag(), a.preview)
	v1.POST("/platform/setting-changes/confirm", super, a.confirm)
	v1.DELETE("/platform/setting-changes/:id", super, a.cancel)
}

func (a *Admin) now() time.Time { return a.Now().UTC().Truncate(time.Millisecond) }

func actor(c *gin.Context) (*authz.Principal, bson.ObjectID) {
	p := authz.From(c)
	id, _ := bson.ObjectIDFromHex(p.UserID)
	return p, id
}

// ValidationOf turns zod issues into the VALIDATION_ERROR response.
func ValidationOf(problems []zschema.Problem) error {
	var is valid.Issues
	for _, p := range problems {
		is.Add(strings.Join(p.Path, "."), p.Message)
	}
	return is.Err()
}

func (a *Admin) siteConfig(c *gin.Context) {
	config, err := a.Config.SiteConfig(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "config", Value: config}}, "Site configuration loaded")
}

func isSiteSection(name string) bool {
	for _, s := range Sections {
		if s == name {
			return true
		}
	}
	return false
}

// save upserts a platformsettings row the way findOneAndUpdate({key}, …, {upsert}) does.
func (a *Admin) save(ctx context.Context, key string, value any, by bson.ObjectID) error {
	now := a.now()
	_, err := a.DB.Collection("platformsettings").UpdateOne(ctx, bson.D{{Key: "key", Value: key}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "key", Value: key}, {Key: "updatedBy", Value: by}, {Key: "value", Value: value}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	a.Config.Invalidate()
	return err
}

func (a *Admin) putSection(c *gin.Context) {
	_, by := actor(c)
	section := c.Param("section")
	body, err := valid.OrderedBody(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !isSiteSection(section) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "UNKNOWN_SECTION", `Unknown site config section "`+section+`".`, nil))
		return
	}
	in := body
	if msg := schemas[section].Issue(in); msg != "" {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "INVALID_SITE_CONFIG", msg, nil))
		return
	}
	value, _ := schemas[section].Parse(in)
	if err := a.save(c, section, value, by); err != nil {
		httpx.Fail(c, err)
		return
	}
	if section == "email" || section == "identity" {
		a.Mail.ResetIdentity()
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_SITE_CONFIG_UPDATED", ActorID: by, EntityID: section, EntityType: "PlatformSetting", Metadata: bson.D{{Key: "section", Value: section}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "section", Value: section}, {Key: "value", Value: value}}, "Site configuration saved")
}

// ---- operations ----

func (a *Admin) operations(c *gin.Context) {
	pending, err := a.pending(c, "collection-qr")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "config", Value: a.Config.Operations(c)}, {Key: "pendingQrChange", Value: pending}}, "Operations configuration loaded")
}

func merge(current ordered.Map, rest ordered.Map) ordered.Map {
	out := append(ordered.Map{}, current...)
	for _, p := range rest {
		out = out.Set(p.Key, p.Value)
	}
	return out
}

func (a *Admin) putOperations(c *gin.Context) {
	p, by := actor(c)
	body, err := valid.OrderedBody(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, ok := body.(ordered.Map)
	if !ok {
		in = ordered.Map{}
	}
	current := a.Config.Operations(c)
	str := func(m ordered.Map, k string) string { v, _ := m.Get(k); s, _ := v.(string); return s }
	qrURL, urlSet := in.Get("collectionQrUrl")
	qrLabel, labelSet := in.Get("collectionQrLabel")
	text := func(v any) string {
		if s, ok := v.(string); ok {
			return strings.TrimSpace(s)
		}
		b, _ := sonic.Marshal(v)
		return strings.TrimSpace(string(b))
	}
	touched := (urlSet && text(qrURL) != str(current, "collectionQrUrl")) || (labelSet && text(qrLabel) != str(current, "collectionQrLabel"))
	rest := in.Delete("collectionQrUrl").Delete("collectionQrLabel")
	merged := merge(current, rest)
	// The rest is checked before any email goes out, so a form that fails sends nothing.
	if problems := schemas["operations"].Issues(merged); len(problems) > 0 {
		httpx.Fail(c, ValidationOf(problems))
		return
	}
	var pending any
	if touched {
		proposed := ordered.Map{{Key: "collectionQrLabel", Value: or(qrLabel, labelSet, str(current, "collectionQrLabel"))}, {Key: "collectionQrUrl", Value: or(qrURL, urlSet, str(current, "collectionQrUrl"))}}
		got, err := a.request(c, "collection-qr", proposed, p)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		pending = got
	} else if pending, err = a.pending(c, "collection-qr"); err != nil {
		httpx.Fail(c, err)
		return
	}
	next, _ := schemas["operations"].Parse(merged)
	if err := a.save(c, "operations", next, by); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_OPERATIONS_CONFIG_UPDATED", ActorID: by, EntityID: "operations", EntityType: "PlatformSetting", Metadata: bson.D{{Key: "config", Value: next}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := "Operations configuration saved"
	if touched {
		to, _ := pending.(ordered.Map).Get("sentTo")
		msg = "Saved. The QR change waits for the confirm link we emailed to " + to.(string) + "."
	}
	httpx.OK(c, ordered.Map{{Key: "config", Value: next}, {Key: "pendingQrChange", Value: pending}}, msg)
}

func or(v any, set bool, fallback string) any {
	if !set || v == nil {
		return fallback
	}
	return v
}

// ---- setting changes ----

// changeDef is one SETTING_CHANGES entry.
type changeDef struct {
	label string
	load  func(ctx context.Context, a *Admin) ordered.Map
	parse func(v any) (ordered.Map, error)
	rows  func(prev, next ordered.Map) []email.ComparisonRow
}

func row(label, from, to string) []email.ComparisonRow {
	if from == to {
		return nil
	}
	return []email.ComparisonRow{{From: from, Label: label, To: to}}
}

func get(m ordered.Map, k string) any { v, _ := m.Get(k); return v }

func numText(v any) string {
	f, _ := v.(float64)
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func unit(v any, one, many string) string {
	if f, _ := v.(float64); f == 1 {
		return numText(v) + " " + one
	}
	return numText(v) + " " + many
}

func pct(v any) string { return numText(v) + "%" }

func hoursList(v any) string {
	list, _ := v.([]any)
	if len(list) == 0 {
		return "None"
	}
	fs := make([]float64, len(list))
	for i, x := range list {
		fs[i], _ = x.(float64)
	}
	sort.Sort(sort.Reverse(sort.Float64Slice(fs)))
	parts := make([]string, len(fs))
	for i, f := range fs {
		parts[i] = strconv.FormatFloat(f, 'f', -1, 64) + " h left"
	}
	return strings.Join(parts, ", ")
}

// DescribeCancelSteps is describeCancelSteps: "Day 1–3: 100% · Day 4: 50%".
func DescribeCancelSteps(v any) string {
	steps, _ := v.([]any)
	from := 1
	parts := make([]string, 0, len(steps))
	for _, s := range steps {
		m, _ := s.(ordered.Map)
		through, _ := get(m, "throughDay").(float64)
		span := "Day " + strconv.Itoa(from) + "–" + strconv.Itoa(int(through))
		if from == int(through) {
			span = "Day " + strconv.Itoa(from)
		}
		from = int(through) + 1
		parts = append(parts, span+": "+pct(get(m, "refundPercent")))
	}
	return strings.Join(parts, " · ")
}

func onOff(v any) string {
	if v == true {
		return "On"
	}
	return "Off"
}

func strictParse(section string) func(v any) (ordered.Map, error) {
	return func(v any) (ordered.Map, error) {
		if problems := schemas[section].Issues(v); len(problems) > 0 {
			return nil, ValidationOf(problems)
		}
		out, _ := schemas[section].Parse(v)
		return out.(ordered.Map), nil
	}
}

var settingChanges = map[string]changeDef{
	"bookings": {
		label: "booking terms",
		load: func(ctx context.Context, a *Admin) ordered.Map {
			m, _ := a.Config.Section(ctx, "bookings")
			out, _ := m.(ordered.Map)
			return out
		},
		parse: strictParse("bookings"),
		rows: func(p, n ordered.Map) []email.ComparisonRow {
			var out []email.ComparisonRow
			add := func(r []email.ComparisonRow) { out = append(out, r...) }
			hours := func(m ordered.Map, k string) string { return unit(get(m, k), "hour", "hours") }
			days := func(m ordered.Map, k string) string { return unit(get(m, k), "day", "days") }
			add(row("Bookings", onOff(get(p, "enabled")), onOff(get(n, "enabled"))))
			add(row("Booking fee", pct(get(p, "feePercent")), pct(get(n, "feePercent"))))
			add(row("Hostel's share of kept money", pct(get(p, "hostelSharePercent")), pct(get(n, "hostelSharePercent"))))
			add(row("Bed hold", days(p, "holdDays"), days(n, "holdDays")))
			add(row("Hostel answer window", hours(p, "hostelAnswerHours"), hours(n, "hostelAnswerHours")))
			add(row("Payment check promise", hours(p, "paymentCheckHours"), hours(n, "paymentCheckHours")))
			add(row("Unpaid booking dropped after", hours(p, "unpaidWindowHours"), hours(n, "unpaidWindowHours")))
			add(row("Refund if the person cancels", DescribeCancelSteps(get(p, "cancelSteps")), DescribeCancelSteps(get(n, "cancelSteps"))))
			add(row("Refund for a no-show", pct(get(p, "noShowRefundPercent")), pct(get(n, "noShowRefundPercent"))))
			add(row("Strikes that pause a hostel", numText(get(p, "strikeLimit"))+" in "+days(p, "strikeWindowDays"), numText(get(n, "strikeLimit"))+" in "+days(n, "strikeWindowDays")))
			add(row("Hostel reminders", hoursList(get(p, "hostelReminderHoursLeft")), hoursList(get(n, "hostelReminderHoursLeft"))))
			add(row("Move-in reminders", hoursList(get(p, "moveInReminderHoursLeft")), hoursList(get(n, "moveInReminderHoursLeft"))))
			add(row("Short stay: daily rate above monthly ÷ 30", pct(get(p, "shortStayMinMarkupPercent")), pct(get(n, "shortStayMinMarkupPercent"))))
			add(row("Short stay: hostel's share of the nights", pct(get(p, "shortStayHostelSharePercent")), pct(get(n, "shortStayHostelSharePercent"))))
			add(row("Short stay: longest stay", numText(get(p, "shortStayMaxNights"))+" nights", numText(get(n, "shortStayMaxNights"))+" nights"))
			add(row("Short stay: booked up to", days(p, "shortStayMaxAdvanceDays")+" ahead", days(n, "shortStayMaxAdvanceDays")+" ahead"))
			return out
		},
	},
	"collection-qr": {
		label: "the collection QR",
		load: func(ctx context.Context, a *Admin) ordered.Map {
			ops := a.Config.Operations(ctx)
			return ordered.Map{{Key: "collectionQrLabel", Value: get(ops, "collectionQrLabel")}, {Key: "collectionQrUrl", Value: get(ops, "collectionQrUrl")}}
		},
		parse: func(v any) (ordered.Map, error) {
			m, _ := v.(ordered.Map)
			clip := func(k string, n int) string {
				s := ""
				switch x := get(m, k).(type) {
				case nil:
				case string:
					s = x
				default:
					s = strings.Trim(jsonText(x), `"`)
				}
				s = strings.TrimSpace(s)
				return valid.JSPrefix(s, n)
			}
			return ordered.Map{{Key: "collectionQrLabel", Value: clip("collectionQrLabel", 120)}, {Key: "collectionQrUrl", Value: clip("collectionQrUrl", 500)}}, nil
		},
		rows: func(p, n ordered.Map) []email.ComparisonRow {
			s := func(m ordered.Map, k string) string { v, _ := get(m, k).(string); return v }
			image := func(url string, word string) string {
				if url != "" {
					return word
				}
				return "None"
			}
			to := "Removed"
			switch {
			case s(n, "collectionQrUrl") == s(p, "collectionQrUrl"):
				to = image(s(p, "collectionQrUrl"), "Current image")
			case s(n, "collectionQrUrl") != "":
				to = "New image"
			}
			label := func(m ordered.Map) string {
				if v := s(m, "collectionQrLabel"); v != "" {
					return v
				}
				return "None"
			}
			return append(row("QR image", image(s(p, "collectionQrUrl"), "Current image"), to), row("Name shown under the QR", label(p), label(n))...)
		},
	},
}

func jsonText(v any) string { b, _ := sonic.Marshal(v); return string(b) }

type changeRow struct {
	ID          bson.ObjectID `bson:"_id"`
	ExpiresAt   time.Time     `bson:"expiresAt"`
	Key         string        `bson:"key"`
	Previous    bson.RawValue `bson:"previousValue"`
	Proposed    bson.RawValue `bson:"proposedValue"`
	RequestedBy bson.ObjectID `bson:"requestedBy"`
	Email       string        `bson:"requestedEmail"`
	Status      string        `bson:"status"`
}

func maskEmail(addr string) string {
	local, domain, _ := strings.Cut(addr, "@")
	return valid.JSPrefix(local, 2) + "•••@" + domain
}

func asMap(v bson.RawValue) ordered.Map { m, _ := ordered.FromBSON(v).(ordered.Map); return m }

func (r *changeRow) pending() ordered.Map {
	def := settingChanges[r.Key]
	rows := def.rows(asMap(r.Previous), asMap(r.Proposed))
	if rows == nil {
		rows = []email.ComparisonRow{}
	}
	return ordered.Map{{Key: "expiresAt", Value: httpx.ISO(r.ExpiresAt)}, {Key: "id", Value: r.ID.Hex()}, {Key: "key", Value: r.Key}, {Key: "label", Value: def.label},
		{Key: "rows", Value: rows}, {Key: "sentTo", Value: maskEmail(r.Email)}}
}

// Pending is getPendingSettingChange: the live request for key, or nil.
func (a *Admin) pending(ctx context.Context, key string) (any, error) {
	var r changeRow
	err := a.DB.Collection("platformsettingchanges").FindOne(ctx, bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: time.Now()}}}, {Key: "key", Value: key}, {Key: "status", Value: "PENDING"}},
		options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r.pending(), nil
}

// PendingChange is Pending for another module (booking settings).
func (a *Admin) PendingChange(ctx context.Context, key string) (any, error) {
	return a.pending(ctx, key)
}

func changeErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// RequestChange is requestSettingChange: the proposal is stored and a one-time
// confirm link emailed to the superadmin who made it; nothing is saved yet.
func (a *Admin) RequestChange(ctx context.Context, key string, proposed any, p *authz.Principal) (ordered.Map, error) {
	return a.request(ctx, key, proposed, p)
}

func (a *Admin) request(ctx context.Context, key string, proposedInput any, p *authz.Principal) (ordered.Map, error) {
	if err := authz.AssertPrimaryCredential(p); err != nil {
		return nil, err
	}
	def, ok := settingChanges[key]
	if !ok {
		return nil, changeErr(http.StatusNotFound, "SETTING_NOT_FOUND", "Unknown setting.")
	}
	previous := def.load(ctx, a)
	proposed, err := def.parse(proposedInput)
	if err != nil {
		return nil, err
	}
	rows := def.rows(previous, proposed)
	if len(rows) == 0 {
		return nil, changeErr(http.StatusUnprocessableEntity, "SETTING_UNCHANGED", "Nothing was changed.")
	}
	by, _ := bson.ObjectIDFromHex(p.UserID)
	var user struct {
		Email string `bson:"email"`
		Name  string `bson:"name"`
	}
	if err := a.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: by}}).Decode(&user); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if user.Email == "" {
		return nil, changeErr(http.StatusUnprocessableEntity, "SETTING_CHANGE_NO_EMAIL", "Your account has no email address, so this change cannot be confirmed.")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	now := a.now()
	expires := now.Add(30 * time.Minute)
	coll := a.DB.Collection("platformsettingchanges")
	id := bson.NewObjectID()
	if _, err := coll.InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "expiresAt", Value: expires}, {Key: "key", Value: key}, {Key: "previousValue", Value: previous}, {Key: "proposedValue", Value: proposed},
		{Key: "requestedBy", Value: by}, {Key: "requestedEmail", Value: user.Email}, {Key: "status", Value: "PENDING"}, {Key: "tokenHash", Value: hashToken(token)},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	m := email.SettingChangeConfirm(a.SiteURL+"/platform/settings/confirm?token="+url.QueryEscape(token), email.EmailDateTime(expires), user.Name, rows, def.label)
	if r := a.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{user.Email}, Subject: m.Subject, HTML: m.HTML}); !r.Sent {
		_, _ = coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "cancelledAt", Value: now}, {Key: "status", Value: "CANCELLED"}}}})
		return nil, changeErr(http.StatusBadGateway, "SETTING_CHANGE_EMAIL_FAILED", "We could not send the confirmation email, so nothing was changed. Try again.")
	}
	// The older request is replaced only once this one's email is out (P7-21): TS
	// superseded it first, so a failed send left neither link usable.
	if _, err := coll.UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: id}}}, {Key: "key", Value: key}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "SUPERSEDED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	if err := a.Audit.Write(ctx, audit.Entry{Action: "PLATFORM_SETTING_CHANGE_REQUESTED", ActorID: by, ActorType: "USER", EntityID: id.Hex(), EntityType: "PlatformSettingChange",
		Metadata: bson.D{{Key: "key", Value: key}, {Key: "rows", Value: rows}}}); err != nil {
		return nil, err
	}
	r := changeRow{ID: id, ExpiresAt: expires, Key: key, RequestedBy: by, Email: user.Email, Status: "PENDING"}
	rowsOut := ordered.Map{{Key: "expiresAt", Value: httpx.ISO(expires)}, {Key: "id", Value: id.Hex()}, {Key: "key", Value: key}, {Key: "label", Value: def.label},
		{Key: "rows", Value: rows}, {Key: "sentTo", Value: maskEmail(r.Email)}}
	return rowsOut, nil
}

func (a *Admin) byToken(ctx context.Context, token string, p *authz.Principal) (*changeRow, error) {
	notFound := changeErr(http.StatusNotFound, "SETTING_CHANGE_NOT_FOUND", "This confirmation link is not valid.")
	if token == "" {
		return nil, notFound
	}
	var r changeRow
	if err := a.DB.Collection("platformsettingchanges").FindOne(ctx, bson.D{{Key: "tokenHash", Value: hashToken(token)}}).Decode(&r); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, notFound
		}
		return nil, err
	}
	if r.RequestedBy.Hex() != p.UserID {
		return nil, changeErr(http.StatusForbidden, "SETTING_CHANGE_WRONG_ACCOUNT", "This link belongs to another superadmin. Sign in as the account that made the change.")
	}
	if _, ok := settingChanges[r.Key]; !ok {
		return nil, changeErr(http.StatusNotFound, "SETTING_NOT_FOUND", "Unknown setting.")
	}
	return &r, nil
}

var closedMessages = map[string]string{
	"APPLIED":    "This change is already saved.",
	"CANCELLED":  "This change was cancelled.",
	"EXPIRED":    "This link has expired. Make the change again.",
	"SUPERSEDED": "A newer change replaced this one. Use the link in the latest email.",
}

func (a *Admin) preview(c *gin.Context) {
	r, err := a.byToken(c, c.Query("token"), authz.From(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	status := r.Status
	if status == "PENDING" && !r.ExpiresAt.After(time.Now()) {
		status = "EXPIRED"
	}
	httpx.OK(c, ordered.Map{{Key: "change", Value: append(r.pending(), ordered.Pair{Key: "status", Value: status})}}, "Change loaded")
}

// canonical is stableJson: keys sorted at every level.
func canonical(v any) string {
	switch x := v.(type) {
	case ordered.Map:
		keys := make([]string, 0, len(x))
		for _, p := range x {
			if p.Value != ordered.Undefined {
				keys = append(keys, p.Key)
			}
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			kb, _ := sonic.Marshal(k)
			parts[i] = string(kb) + ":" + canonical(get(x, k))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, len(x))
		for i, el := range x {
			parts[i] = canonical(el)
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	return jsonText(v)
}

func (a *Admin) confirm(c *gin.Context) {
	p, by := actor(c)
	raw, _ := valid.Body(c)
	body, _ := raw.(map[string]any)
	token, _ := body["token"].(string)
	if token == "" {
		httpx.Fail(c, changeErr(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "The confirmation link is missing its code."))
		return
	}
	if err := authz.AssertPrimaryCredential(p); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := a.byToken(c, token, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	def := settingChanges[r.Key]
	coll := a.DB.Collection("platformsettingchanges")
	if r.Status != "PENDING" {
		msg, ok := closedMessages[r.Status]
		if !ok {
			msg = "This change can no longer be confirmed."
		}
		httpx.Fail(c, changeErr(http.StatusConflict, "SETTING_CHANGE_CLOSED", msg))
		return
	}
	if !r.ExpiresAt.After(time.Now()) {
		_, _ = coll.UpdateOne(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "EXPIRED"}}}})
		httpx.Fail(c, changeErr(http.StatusGone, "SETTING_CHANGE_EXPIRED", closedMessages["EXPIRED"]))
		return
	}
	previous, err := def.parse(asMap(r.Previous))
	if err != nil || canonical(def.load(c, a)) != canonical(previous) {
		_, _ = coll.UpdateOne(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "SUPERSEDED"}}}})
		httpx.Fail(c, changeErr(http.StatusConflict, "SETTING_CHANGE_STALE", "The setting changed after this email was sent, so this link would undo that. Make the change again."))
		return
	}
	res, err := coll.UpdateOne(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "appliedAt", Value: a.now()}, {Key: "status", Value: "APPLIED"}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.ModifiedCount == 0 {
		httpx.Fail(c, changeErr(http.StatusConflict, "SETTING_CHANGE_CLOSED", closedMessages["APPLIED"]))
		return
	}
	proposed, err := def.parse(asMap(r.Proposed))
	if err == nil {
		err = a.apply(c, r.Key, proposed, by)
	}
	if err != nil {
		// Own context: a cancelled request must not leave the change marked APPLIED.
		if _, undo := coll.UpdateOne(context.WithoutCancel(c), bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "PENDING"}}}, {Key: "$unset", Value: bson.D{{Key: "appliedAt", Value: 1}}}}); undo != nil {
			slog.ErrorContext(c, "setting change not reopened; it stays APPLIED but was not applied", "change", r.ID.Hex(), "error", undo)
		}
		httpx.Fail(c, err)
		return
	}
	rows := def.rows(asMap(r.Previous), asMap(r.Proposed))
	if rows == nil {
		rows = []email.ComparisonRow{}
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_SETTING_CHANGE_APPLIED", ActorID: by, ActorType: "USER", EntityID: r.ID.Hex(), EntityType: "PlatformSettingChange",
		Metadata: bson.D{{Key: "key", Value: r.Key}, {Key: "rows", Value: rows}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "key", Value: r.Key}, {Key: "label", Value: def.label}, {Key: "rows", Value: rows}}, "Saved the change to "+def.label+".")
}

// apply writes a confirmed change: booking terms replace the section; the QR
// merges onto operations.
func (a *Admin) apply(ctx context.Context, key string, value ordered.Map, by bson.ObjectID) error {
	if key == "bookings" {
		return a.save(ctx, "bookings", value, by)
	}
	next, _ := schemas["operations"].Parse(merge(a.Config.Operations(ctx), value))
	if problems := schemas["operations"].Issues(merge(a.Config.Operations(ctx), value)); len(problems) > 0 {
		return ValidationOf(problems)
	}
	return a.save(ctx, "operations", next, by)
}

func (a *Admin) cancel(c *gin.Context) {
	_, by := actor(c)
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, changeErr(http.StatusNotFound, "SETTING_CHANGE_NOT_FOUND", "Change not found."))
		return
	}
	var r changeRow
	err = a.DB.Collection("platformsettingchanges").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "cancelledAt", Value: a.now()}, {Key: "cancelledBy", Value: by}, {Key: "status", Value: "CANCELLED"}}}}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, changeErr(http.StatusConflict, "SETTING_CHANGE_CLOSED", "There is no change waiting to be cancelled."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_SETTING_CHANGE_CANCELLED", ActorID: by, ActorType: "USER", EntityID: id.Hex(), EntityType: "PlatformSettingChange", Metadata: bson.D{{Key: "key", Value: r.Key}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "cancelled", Value: true}}, "Change cancelled")
}
