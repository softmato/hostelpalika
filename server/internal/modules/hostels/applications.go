package hostels

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Applications is the owner's side of a registration: the status tab
// (listOwnerHostelApplications) and answering a "documents needed" request.
type Applications struct {
	db     *mongo.Database
	guards *authz.Guards
	claims files.Claims
	log    *audit.Log
}

func NewApplications(db *mongo.Database, guards *authz.Guards, claims files.Claims, log *audit.Log) *Applications {
	return &Applications{db, guards, claims, log}
}

func (a *Applications) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/hostel-applications/my-applications", httpx.ETag(), a.mine)
	v1.POST("/public/hostel-applications/:id/resubmit-documents", a.resubmit)
}

// NormalizeObjectID is normalizeObjectId (a 12-character string is refused too,
// as the recorded TS does).
func NormalizeObjectID(v string) (bson.ObjectID, error) {
	if id, err := bson.ObjectIDFromHex(v); err == nil {
		return id, nil
	}
	return bson.ObjectID{}, httpx.NewError(http.StatusUnprocessableEntity, "INVALID_HOSTEL_ID", "Invalid hostel id.", nil)
}

// applicationOut is serializeApplication over a stored application: the keys in
// the order TS writes them, so callers can spread extras after it.
func applicationOut(raw bson.Raw) ordered.Map {
	get := func(k string) bson.RawValue { return raw.Lookup(k) }
	str := func(k string) string {
		v := get(k)
		if s, ok := v.StringValueOK(); ok {
			return s
		}
		return ""
	}
	date := func(k string) any {
		v := get(k)
		if t, ok := v.TimeOK(); ok {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		return nil
	}
	oid := func(k string) string {
		if id, ok := get(k).ObjectIDOK(); ok {
			return id.Hex()
		}
		return ""
	}
	docs := []any{}
	if arr, ok := get("requestedDocuments").ArrayOK(); ok {
		vals, _ := arr.Values()
		for _, d := range vals {
			if doc, ok := d.DocumentOK(); ok {
				t, _ := doc.Lookup("documentType").StringValueOK()
				n, _ := doc.Lookup("note").StringValueOK()
				docs = append(docs, ordered.Map{{Key: "documentType", Value: t}, {Key: "note", Value: n}})
			}
		}
	}
	var snapshot any = ordered.Map{}
	if v := get("snapshot"); v.Type == bson.TypeEmbeddedDocument {
		snapshot = ordered.FromBSON(v)
	}
	return ordered.Map{
		{Key: "applicantId", Value: oid("applicantId")},
		{Key: "hostelId", Value: oid("hostelId")},
		{Key: "id", Value: oid("_id")},
		{Key: "infoRequestNote", Value: str("infoRequestNote")},
		{Key: "infoRequestedAt", Value: date("infoRequestedAt")},
		{Key: "notes", Value: str("notes")},
		{Key: "rejectionReason", Value: str("rejectionReason")},
		{Key: "requestedDocuments", Value: docs},
		{Key: "reviewedAt", Value: date("reviewedAt")},
		{Key: "snapshot", Value: snapshot},
		{Key: "status", Value: str("status")},
		{Key: "submittedAt", Value: date("createdAt")},
		{Key: "submittedBy", Value: oid("submittedBy")},
	}
}

// ownerIDs is the signed-in user plus every live user sharing their email or
// phone: the public flow files under whichever record the form's contact
// details resolved to.
func (a *Applications) ownerIDs(ctx context.Context, userID bson.ObjectID) ([]bson.ObjectID, error) {
	ids := []bson.ObjectID{userID}
	var me struct {
		Email string `bson:"email"`
		Phone string `bson:"phone"`
	}
	err := a.db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: userID}},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "phone", Value: 1}})).Decode(&me)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	var or bson.A
	if me.Email != "" {
		or = append(or, bson.D{{Key: "email", Value: strings.ToLower(me.Email)}})
	}
	if me.Phone != "" {
		or = append(or, bson.D{{Key: "phone", Value: me.Phone}})
	}
	if len(or) == 0 {
		return ids, nil
	}
	cur, err := a.db.Collection("users").Find(ctx, bson.D{{Key: "$or", Value: or}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		dup := false
		for _, id := range ids {
			dup = dup || id == r.ID
		}
		if !dup {
			ids = append(ids, r.ID)
		}
	}
	return ids, nil
}

func (a *Applications) mine(c *gin.Context) {
	p, err := a.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID, err := NormalizeObjectID(p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	owners, err := a.ownerIDs(c, userID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := a.db.Collection("hostelapplications").Find(c, bson.D{{Key: "applicantId", Value: bson.D{{Key: "$in", Value: owners}}}, {Key: "isDeleted", Value: false}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(20))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var apps []bson.Raw
	if err := cur.All(c, &apps); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelIDs := bson.A{}
	for _, raw := range apps {
		if id, ok := raw.Lookup("hostelId").ObjectIDOK(); ok {
			hostelIDs = append(hostelIDs, id)
		}
	}
	type hostelRow struct {
		ID                 bson.ObjectID `bson:"_id"`
		Name               *string       `bson:"name"`
		Status             *string       `bson:"status"`
		VerificationStatus *string       `bson:"verificationStatus"`
	}
	byID := map[bson.ObjectID]hostelRow{}
	hc, err := a.db.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: hostelIDs}}}},
		options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "status", Value: 1}, {Key: "verificationStatus", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var hostels []hostelRow
	if err := hc.All(c, &hostels); err != nil {
		httpx.Fail(c, err)
		return
	}
	for _, h := range hostels {
		byID[h.ID] = h
	}
	or := func(v *string, d string) string {
		if v != nil {
			return *v
		}
		return d
	}
	out := make([]any, 0, len(apps))
	for _, raw := range apps {
		hid, _ := raw.Lookup("hostelId").ObjectIDOK()
		h := byID[hid]
		snapName, _ := raw.Lookup("snapshot", "name").StringValueOK()
		hasSnap := raw.Lookup("snapshot", "name").Type == bson.TypeString
		name := "Your hostel"
		switch {
		case h.Name != nil:
			name = *h.Name
		case hasSnap:
			name = snapName
		}
		submitted := ""
		if t, ok := raw.Lookup("updatedAt").TimeOK(); ok {
			submitted = t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		m := applicationOut(raw)
		m = m.Set("hostelName", name).Set("hostelStatus", or(h.Status, "PENDING_APPROVAL")).
			Set("submittedAt", submitted).Set("verificationStatus", or(h.VerificationStatus, "PENDING"))
		out = append(out, m)
	}
	httpx.OK(c, ordered.Map{{Key: "applications", Value: out}}, "Applications loaded")
}

// parseResubmit is hostelResubmitDocumentsSchema.
func parseResubmit(body any) ([]files.Submitted, error) {
	f := valid.NewForm(body)
	docs := files.ParseSubmitted(f, "documents", false, 1, "Upload at least one document.")
	return docs, f.Err()
}

func (a *Applications) resubmit(c *gin.Context) {
	p, err := a.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	docs, err := parseResubmit(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	applicant, err := NormalizeObjectID(p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := NormalizeObjectID(c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var app bson.Raw
	err = a.db.Collection("hostelapplications").FindOne(c, bson.D{{Key: "applicantId", Value: applicant}, {Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}},
		options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&app)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "APPLICATION_NOT_FOUND", "No application was found for this hostel.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	claimed, err := a.claims.Claim(c, a.db, docs, applicant)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	rows := make([]any, 0, len(claimed))
	for _, d := range claimed {
		rows = append(rows, bson.D{
			{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "ownerId", Value: applicant},
			{Key: "documentType", Value: d.DocumentType}, {Key: "fileAssetId", Value: d.FileAssetID}, {Key: "status", Value: "PENDING"},
			{Key: "createdBy", Value: applicant}, {Key: "updatedBy", Value: applicant}, {Key: "isDeleted", Value: false},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0},
		})
	}
	if len(rows) > 0 {
		if _, err := a.db.Collection("hosteldocuments").InsertMany(c, rows); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	appID, _ := app.Lookup("_id").ObjectIDOK()
	var after bson.Raw
	err = a.db.Collection("hostelapplications").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: appID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "infoRequestNote", Value: ""}, {Key: "requestedDocuments", Value: bson.A{}}, {Key: "status", Value: "PENDING"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&after)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	types := bson.A{}
	for _, d := range docs {
		types = append(types, d.DocumentType)
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	if err := a.log.Write(c, audit.Entry{ActorID: actor, HostelID: hostelID, Action: "PUBLIC_HOSTEL_DOCUMENTS_RESUBMITTED",
		EntityType: "Hostel", EntityID: hostelID.Hex(), Metadata: bson.D{{Key: "documents", Value: types}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "application", Value: applicationOut(after)}}, "Documents resubmitted")
}
