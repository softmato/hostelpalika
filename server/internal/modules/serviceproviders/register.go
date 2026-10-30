package serviceproviders

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type registerInput struct {
	Area, City, FullName, Phone string
	Availability, Description   *string
	Experience, Email           *string
	Categories                  []string
	Documents                   []files.Submitted
	Photo                       *bson.ObjectID
}

// parseRegister is serviceProviderRegisterSchema.
func parseRegister(body any) (registerInput, error) {
	f := valid.NewForm(body)
	var in registerInput
	in.Area, _ = f.Str("area", valid.S{Trim: true, Min: 2, Max: 120})
	opt := func(key string, max int) *string {
		if v, ok := f.Str(key, valid.S{Opt: true, Trim: true, Max: max}); ok {
			return &v
		}
		return nil
	}
	in.Availability = opt("availability", 240)
	var cats []string
	if items, ok := f.Array("categories", true, false); ok {
		for i, raw := range items {
			sub := &valid.Form{M: map[string]any{"v": raw}}
			if v, ok := sub.Enum("v", false, nil, categories...); ok {
				cats = append(cats, v)
			}
			f.JoinScalar("categories."+strconv.Itoa(i), sub)
		}
		f.Size("categories", len(items), 1, 11, "", false)
	}
	single, hasSingle := "", false
	if f.Present("category") {
		single, hasSingle = f.Enum("category", true, nil, categories...)
	}
	in.City = "Kathmandu"
	if v, ok := f.Str("city", valid.S{Opt: true, Trim: true, Min: 2, Max: 120}); ok {
		in.City = v
	}
	in.Description = opt("description", 1200)
	in.Documents = files.ParseSubmittedN(f, "documents", true, 0, "", 80, 8)
	if v, ok := f.Str("email", valid.S{Opt: true, Trim: true}); ok {
		if !valid.IsEmail(v) {
			f.Is.Add("email", valid.Format("email"))
		}
		in.Email = &v
	}
	in.Experience = opt("experience", 240)
	in.FullName, _ = f.Str("fullName", valid.S{Trim: true, Min: 2, Max: 160})
	in.Phone, _ = f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24})
	if f.Present("photoAssetId") {
		if id, ok := valid.ObjectID(f.M["photoAssetId"], "photoAssetId", "", &f.Is, false); ok {
			oid, _ := bson.ObjectIDFromHex(id)
			in.Photo = &oid
		}
	}
	// normalizeProviderCategories: the list, then the single trade, de-duplicated.
	seen := map[string]bool{}
	for _, c := range append(cats, func() []string {
		if hasSingle {
			return []string{single}
		}
		return nil
	}()...) {
		if !seen[c] {
			seen[c] = true
			in.Categories = append(in.Categories, c)
		}
	}
	if !f.Hard && len(in.Categories) == 0 {
		f.Is.Add("categories", "Select at least one trade.")
	}
	return in, f.Err()
}

func (h *Handler) register(c *gin.Context) {
	if err := h.Limiter.PublicForm(c, "public-service-provider-registration"); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseRegister(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.submit(c, in, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Service provider registration submitted")
}

func label(category string) string {
	words := strings.Split(strings.ToLower(category), "_")
	for i, w := range words {
		if i == 0 && w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

func (h *Handler) submit(ctx context.Context, in registerInput, userID string) (ordered.Map, error) {
	existing, err := h.findOwn(ctx, userID, bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING_APPROVAL", "APPROVED", "HIDDEN", "INACTIVE"}}}}})
	if err != nil {
		return nil, err
	}
	if existing != nil {
		msg := "This account is already registered as a service provider."
		if existing.Status == "PENDING_APPROVAL" {
			msg = "You already have an application under review."
		}
		return nil, serErr(msg, "SERVICE_PROVIDER_ALREADY_REGISTERED", http.StatusConflict)
	}
	uid, err := objectID(userID, "user id")
	if err != nil {
		return nil, err
	}
	claimed, err := h.Claims.Claim(ctx, h.DB, in.Documents, uid)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	category := in.Categories[0]
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "fullName", Value: in.FullName}, {Key: "phone", Value: in.Phone}, {Key: "userId", Value: uid}}
	mail := ""
	if in.Email != nil {
		mail = strings.ToLower(strings.TrimSpace(*in.Email))
		doc = append(doc, bson.E{Key: "email", Value: mail})
	}
	doc = append(doc, bson.E{Key: "category", Value: category}, bson.E{Key: "categories", Value: in.Categories}, bson.E{Key: "area", Value: in.Area}, bson.E{Key: "city", Value: in.City})
	for _, e := range []struct {
		k string
		v *string
	}{{"availability", in.Availability}, {"description", in.Description}, {"experience", in.Experience}} {
		if e.v != nil {
			doc = append(doc, bson.E{Key: e.k, Value: *e.v})
		}
	}
	if in.Photo != nil {
		doc = append(doc, bson.E{Key: "photoAssetId", Value: *in.Photo})
	}
	doc = append(doc, bson.E{Key: "ratingSummary", Value: bson.D{{Key: "averageRating", Value: 0}, {Key: "totalReviews", Value: 0}}},
		bson.E{Key: "status", Value: "PENDING_APPROVAL"}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("serviceproviders").InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	appID := bson.NewObjectID()
	if _, err := h.DB.Collection("serviceproviderapplications").InsertOne(ctx, bson.D{{Key: "_id", Value: appID}, {Key: "providerId", Value: id}, {Key: "status", Value: "PENDING"},
		{Key: "snapshot", Value: bson.D{{Key: "area", Value: in.Area}, {Key: "categories", Value: in.Categories}, {Key: "category", Value: category}, {Key: "city", Value: in.City},
			{Key: "fullName", Value: in.FullName}, {Key: "phone", Value: in.Phone}}},
		{Key: "submittedAt", Value: now}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	if len(claimed) > 0 {
		rows := make([]any, 0, len(claimed))
		for _, d := range claimed {
			rows = append(rows, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "providerId", Value: id}, {Key: "documentType", Value: d.DocumentType}, {Key: "fileAssetId", Value: d.FileAssetID},
				{Key: "status", Value: "PENDING"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		}
		if _, err := h.DB.Collection("serviceproviderdocuments").InsertMany(ctx, rows); err != nil {
			return nil, err
		}
	}
	var docRows []bson.Raw
	cur, err := h.DB.Collection("serviceproviderdocuments").Find(ctx, bson.D{{Key: "providerId", Value: id}, {Key: "isDeleted", Value: false}})
	if err != nil {
		return nil, err
	}
	if err := cur.All(ctx, &docRows); err != nil {
		return nil, err
	}
	if mail != "" {
		m := email.ServiceProviderRegistrationReceived(label(category), in.FullName)
		h.Mail.Notify(ctx, email.Notification{Action: "service_provider_registration_received", To: mail, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
	}
	h.notifyPlatform(ctx, id, in.FullName, in.City)

	var stored bson.Raw
	if err := h.DB.Collection("serviceproviders").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&stored); err != nil {
		return nil, err
	}
	var app bson.Raw
	if err := h.DB.Collection("serviceproviderapplications").FindOne(ctx, bson.D{{Key: "_id", Value: appID}}).Decode(&app); err != nil {
		return nil, err
	}
	docs := make([]any, 0, len(docRows))
	for _, r := range docRows {
		docs = append(docs, documentOut(r))
	}
	return ordered.Map{{Key: "application", Value: applicationOut(app)}, {Key: "documents", Value: docs}, {Key: "provider", Value: providerOut(stored)}}, nil
}

func rawStr(r bson.Raw, k, def string) string {
	if s, ok := r.Lookup(k).StringValueOK(); ok {
		return s
	}
	return def
}

func rawDate(r bson.Raw, k string) any {
	if t, ok := r.Lookup(k).TimeOK(); ok {
		return httpx.ISO(t)
	}
	return ordered.Undefined
}

func rawID(r bson.Raw, k string) any {
	if id, ok := r.Lookup(k).ObjectIDOK(); ok {
		return id.Hex()
	}
	return ordered.Undefined
}

func applicationOut(r bson.Raw) ordered.Map {
	return ordered.Map{{Key: "id", Value: rawID(r, "_id")}, {Key: "providerId", Value: rawID(r, "providerId")}, {Key: "rejectionReason", Value: rawStr(r, "rejectionReason", "")},
		{Key: "status", Value: rawStr(r, "status", "")}, {Key: "submittedAt", Value: rawDate(r, "submittedAt")}}
}

func documentOut(r bson.Raw) ordered.Map {
	nullable := func(v any) any {
		if v == ordered.Undefined {
			return nil
		}
		return v
	}
	return ordered.Map{{Key: "createdAt", Value: nullable(rawDate(r, "createdAt"))}, {Key: "documentType", Value: rawStr(r, "documentType", "")},
		{Key: "fileAssetId", Value: nullable(rawID(r, "fileAssetId"))}, {Key: "fileUrl", Value: rawStr(r, "fileUrl", "")}, {Key: "id", Value: rawID(r, "_id")},
		{Key: "providerId", Value: rawID(r, "providerId")}, {Key: "status", Value: rawStr(r, "status", "")}}
}

// providerOut is serializeProvider.
func providerOut(r bson.Raw) ordered.Map {
	var p provider
	_ = bson.Unmarshal(r, &p)
	return ordered.Map{
		{Key: "approvedAt", Value: rawDate(r, "approvedAt")}, {Key: "approvedBy", Value: rawID(r, "approvedBy")}, {Key: "area", Value: p.Area}, {Key: "availability", Value: p.Availability},
		{Key: "categories", Value: p.cats()}, {Key: "category", Value: p.Category}, {Key: "city", Value: p.city()}, {Key: "createdAt", Value: rawDate(r, "createdAt")},
		{Key: "description", Value: p.Description}, {Key: "email", Value: p.Email}, {Key: "experience", Value: p.Experience}, {Key: "fullName", Value: p.FullName},
		{Key: "hiddenAt", Value: rawDate(r, "hiddenAt")}, {Key: "hiddenBy", Value: rawID(r, "hiddenBy")}, {Key: "id", Value: p.ID.Hex()}, {Key: "phone", Value: p.Phone},
		{Key: "photoAssetId", Value: oidOrUndefined(p.PhotoAssetID)}, {Key: "ratingSummary", Value: p.rating()}, {Key: "rejectionReason", Value: p.RejectionReason},
		{Key: "status", Value: p.Status}, {Key: "updatedAt", Value: rawDate(r, "updatedAt")},
	}
}

// notifyPlatform is notifyPlatformOfServiceProviderApplication: best effort.
func (h *Handler) notifyPlatform(ctx context.Context, id bson.ObjectID, name, city string) {
	cur, err := h.DB.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "role", Value: bson.D{{Key: "$in", Value: bson.A{"SUPERADMIN", "PLATFORM_MODERATOR"}}}}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return
	}
	var staff []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if cur.All(ctx, &staff) != nil {
		return
	}
	where := ""
	if city != "" {
		where = " in " + city
	}
	for _, m := range staff {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{
			Actions:   []notifications.Action{{Endpoint: "/api/v1/platform/service-providers/" + id.Hex() + "/approve", Key: "approve", Label: "Approve provider", Method: "PATCH", Payload: ordered.Map{}, Tone: "primary"}},
			ActionURL: "/platform/service-providers", Body: name + where + " applied to join as a service provider.", Category: "SERVICE_PROVIDER",
			Data: ordered.Map{{Key: "providerId", Value: id.Hex()}}, Kind: "ACTION", Title: "Service provider application", UserID: m.ID.Hex(),
		})
	}
	realtime.PublishResourceChange(ctx, h.RT, h.Cache, realtime.Change{Platform: true, Topics: []realtime.Topic{realtime.ServiceProviders}})
}
