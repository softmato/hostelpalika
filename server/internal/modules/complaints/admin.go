package complaints

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// RegisterAdmin is the staff side of modules/complaints/complaint.service.ts.
func (s *Service) RegisterAdmin(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/complaints", s.adminList)
	v1.POST("/hostel-admin/complaints/:id/reply", s.adminReply)
	v1.PATCH("/hostel-admin/complaints/:id/status", s.adminStatus)
}

var statuses = []string{"PENDING", "IN_PROGRESS", "RESOLVED", "REJECTED"}

func openStatuses() bson.A { return bson.A{"PENDING", "IN_PROGRESS"} }

// serializeAdmin is serializeComplaint with hideResidentIdentity: an anonymous
// complaint shows staff no resident id.
func serializeAdmin(r *Row, atts []attachment, ups []update) ordered.Map {
	m := serialize(r, atts, ups)
	if r.IsAnonymous {
		m = m.Set("residentId", nil)
	}
	return m
}

type adminSummary struct {
	InProgress int64 `json:"inProgress"`
	Overdue    int64 `json:"overdue"`
	Pending    int64 `json:"pending"`
	Rejected   int64 `json:"rejected"`
	Resolved   int64 `json:"resolved"`
	Total      int64 `json:"total"`
}

type adminListOut struct {
	Complaints []ordered.Map   `json:"complaints"`
	Pagination pagination.Meta `json:"pagination"`
	Summary    adminSummary    `json:"summary"`
}

// summaryFor is complaintSummaryForFilter: tallies for the whole filter, not the page.
func (s *Service) summaryFor(ctx context.Context, filter bson.D) (adminSummary, error) {
	coll := s.DB.Collection("complaints")
	cur, err := coll.Aggregate(ctx, mongo.Pipeline{{{Key: "$match", Value: filter}}, {{Key: "$group", Value: bson.D{{Key: "_id", Value: "$status"}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
	if err != nil {
		return adminSummary{}, err
	}
	var rows []struct {
		ID    string `bson:"_id"`
		Count int64  `bson:"count"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return adminSummary{}, err
	}
	overdue, err := coll.CountDocuments(ctx, append(append(bson.D{}, filter...), bson.E{Key: "slaDueAt", Value: bson.D{{Key: "$lt", Value: time.Now()}}},
		bson.E{Key: "status", Value: bson.D{{Key: "$in", Value: openStatuses()}}}))
	if err != nil {
		return adminSummary{}, err
	}
	out := adminSummary{Overdue: overdue}
	for _, r := range rows {
		switch r.ID {
		case "IN_PROGRESS":
			out.InProgress = r.Count
		case "PENDING":
			out.Pending = r.Count
		case "REJECTED":
			out.Rejected = r.Count
		case "RESOLVED":
			out.Resolved = r.Count
		}
		out.Total += r.Count
	}
	return out, nil
}

func (s *Service) adminList(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "viewComplaints")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	category := valid.QueryEnum(q, "category", &is, "FOOD", "ROOM", "MAINTENANCE", "SAFETY", "PAYMENT", "STAFF", "NOISE", "OTHER")
	requested := opsscope.Hostel(q, &is)
	sla := valid.QueryEnum(q, "sla", &is, "overdue", "on_track")
	status := valid.QueryEnum(q, "status", &is, statuses...)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter, err := opsscope.Filter(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if category != nil {
		filter = append(filter, bson.E{Key: "category", Value: *category})
	}
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	now := time.Now()
	switch {
	case sla != nil && *sla == "overdue":
		filter = filterSet(filter, "slaDueAt", bson.D{{Key: "$lt", Value: now}})
		if status == nil {
			filter = filterSet(filter, "status", bson.D{{Key: "$in", Value: openStatuses()}})
		}
	case sla != nil:
		filter = append(filter, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "slaDueAt", Value: bson.D{{Key: "$gte", Value: now}}}},
			bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"RESOLVED", "REJECTED"}}}}}}})
	}
	key := "complaints"
	if c.Request.URL.RawQuery != "" {
		key += "?" + c.Request.URL.RawQuery
	}
	ch, _ := s.Cache.(*cache.Cache)
	cache.Respond(c, ch, p.HostelIDs, p.UserID, key, "Complaints loaded", func() (adminListOut, error) {
		rng := pagination.RangeOf(page)
		coll := s.DB.Collection("complaints")
		cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "status", Value: 1}, {Key: "createdAt", Value: -1}}).SetSkip(int64(rng.Skip)).SetLimit(int64(rng.Limit)))
		if err != nil {
			return adminListOut{}, err
		}
		var rows []Row
		if err := cur.All(c, &rows); err != nil {
			return adminListOut{}, err
		}
		total, err := coll.CountDocuments(c, filter)
		if err != nil {
			return adminListOut{}, err
		}
		atts, ups, err := s.children(c, rows)
		if err != nil {
			return adminListOut{}, err
		}
		sum, err := s.summaryFor(c, filter)
		if err != nil {
			return adminListOut{}, err
		}
		out := adminListOut{Complaints: make([]ordered.Map, len(rows)), Pagination: pagination.MetaOf(page, int(total)), Summary: sum}
		for i := range rows {
			id := rows[i].ID.Hex()
			out.Complaints[i] = serializeAdmin(&rows[i], atts[id], ups[id])
		}
		return out, nil
	})
}

// filterSet replaces key's condition, as an object spread would.
func filterSet(f bson.D, key string, v any) bson.D {
	for i := range f {
		if f[i].Key == key {
			f[i].Value = v
			return f
		}
	}
	return append(f, bson.E{Key: key, Value: v})
}

// children is complaintChildren: attachments newest first, updates oldest first.
func (s *Service) children(ctx context.Context, rows []Row) (map[string][]attachment, map[string][]update, error) {
	atts, ups := map[string][]attachment{}, map[string][]update{}
	if len(rows) == 0 {
		return atts, ups, nil
	}
	ids := bson.A{}
	for _, x := range rows {
		ids = append(ids, x.ID)
	}
	match := bson.D{{Key: "complaintId", Value: bson.D{{Key: "$in", Value: ids}}}}
	cur, err := s.DB.Collection("complaintattachments").Find(ctx, match, options.Find().SetSort(bson.D{{Key: "uploadedAt", Value: -1}}))
	if err != nil {
		return nil, nil, err
	}
	var as []attachment
	if err := cur.All(ctx, &as); err != nil {
		return nil, nil, err
	}
	for _, a := range as {
		atts[a.ComplaintID.Hex()] = append(atts[a.ComplaintID.Hex()], a)
	}
	cur, err = s.DB.Collection("complaintupdates").Find(ctx, match, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, nil, err
	}
	var us []update
	if err := cur.All(ctx, &us); err != nil {
		return nil, nil, err
	}
	for _, u := range us {
		ups[u.ComplaintID.Hex()] = append(ups[u.ComplaintID.Hex()], u)
	}
	return atts, ups, nil
}

func complaintMissing() error {
	return httpx.NewError(http.StatusNotFound, "COMPLAINT_NOT_FOUND", "Complaint was not found.", nil)
}

func (s *Service) findAdmin(ctx context.Context, rawID string, p *authz.Principal, hostelID string) (*Row, error) {
	id, err := opsscope.Param(rawID, "complaint id")
	if err != nil {
		return nil, err
	}
	scope, err := opsscope.Filter(p, hostelID)
	if err != nil {
		return nil, err
	}
	var row Row
	err = s.DB.Collection("complaints").FindOne(ctx, append(bson.D{{Key: "_id", Value: id}}, scope...)).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return nil, complaintMissing()
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// addAdminUpdate writes a timeline row, with the previous status the resident-side helper lacks.
func (s *Service) addAdminUpdate(ctx context.Context, row *Row, p *authz.Principal, uid bson.ObjectID, kind, message, prev, next string) (update, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	u := update{bson.NewObjectID(), uid, string(p.Role), row.ID, &now, row.HostelID, message, next, prev, kind}
	doc := bson.D{{Key: "_id", Value: u.ID}, {Key: "hostelId", Value: row.HostelID}, {Key: "complaintId", Value: row.ID}, {Key: "actorId", Value: uid}, {Key: "actorRole", Value: string(p.Role)}, {Key: "type", Value: kind}}
	if message != "" {
		doc = append(doc, bson.E{Key: "message", Value: message})
	}
	if prev != "" {
		doc = append(doc, bson.E{Key: "previousStatus", Value: prev})
	}
	if next != "" {
		doc = append(doc, bson.E{Key: "nextStatus", Value: next})
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	_, err := s.DB.Collection("complaintupdates").InsertOne(ctx, doc)
	return u, err
}

type complaintOut struct {
	Complaint ordered.Map `json:"complaint"`
}

func (s *Service) adminStatus(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "updateComplaints")
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
	var hostelID string
	if raw, present := f.M["hostelId"]; present {
		hostelID, _ = valid.ObjectID(raw, "hostelId", "", &f.Is, false)
	}
	response, _ := f.Str("response", valid.S{Opt: true, Trim: true, Min: 2, Max: 2000})
	status, _ := f.Enum("status", false, nil, statuses...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := s.findAdmin(c, c.Param("id"), p, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "status", Value: status}, {Key: "updatedBy", Value: uid}}
	if response != "" {
		set = append(set, bson.E{Key: "adminResponse", Value: response})
	}
	unset := bson.D{}
	switch status {
	case "RESOLVED":
		set = append(set, bson.E{Key: "resolvedAt", Value: now})
		unset = bson.D{{Key: "rejectedAt", Value: ""}, {Key: "confirmedAt", Value: ""}}
	case "REJECTED":
		set = append(set, bson.E{Key: "rejectedAt", Value: now})
		unset = bson.D{{Key: "resolvedAt", Value: ""}, {Key: "confirmedAt", Value: ""}}
	default:
		unset = bson.D{{Key: "resolvedAt", Value: ""}, {Key: "rejectedAt", Value: ""}, {Key: "confirmedAt", Value: ""}}
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	var updated Row
	err = s.DB.Collection("complaints").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: set}, {Key: "$unset", Value: unset}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, complaintMissing())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	up, err := s.addAdminUpdate(c, &updated, p, uid, "STATUS_CHANGE", response, row.Status, updated.Status)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "COMPLAINT_STATUS_UPDATED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "Complaint", HostelID: row.HostelID,
		Metadata: bson.D{{Key: "nextStatus", Value: updated.Status}, {Key: "previousStatus", Value: row.Status}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.tellResident(c.Request.Context(), &updated, response, true)
	httpx.OK(c, complaintOut{serializeAdmin(&updated, nil, []update{up})}, "Complaint status updated")
}

func (s *Service) adminReply(c *gin.Context) {
	p, err := s.Guards.RequireHostelCapability(c, "updateComplaints")
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
	var hostelID string
	if raw, present := f.M["hostelId"]; present {
		hostelID, _ = valid.ObjectID(raw, "hostelId", "", &f.Is, false)
	}
	message, _ := f.Str("message", valid.S{Trim: true, Min: 2, Max: 2000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := s.findAdmin(c, c.Param("id"), p, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var updated Row
	err = s.DB.Collection("complaints").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: row.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "adminResponse", Value: message}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, complaintMissing())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	up, err := s.addAdminUpdate(c, &updated, p, uid, "ADMIN_REPLY", message, "", "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "COMPLAINT_REPLIED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "Complaint", HostelID: row.HostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	// A reply is in-app only: mailing every line of a thread would flood the resident.
	s.tellResident(c.Request.Context(), &updated, "", false)
	httpx.Write(c, http.StatusCreated, complaintOut{serializeAdmin(&updated, nil, []update{up})}, "Complaint reply saved")
}

// tellResident is notifyResidentOfComplaintStatus (status) or ...Reply: wholly best-effort.
func (s *Service) tellResident(ctx context.Context, row *Row, response string, status bool) {
	var r struct {
		Email     string         `bson:"email"`
		FirstName string         `bson:"firstName"`
		LastName  string         `bson:"lastName"`
		UserID    *bson.ObjectID `bson:"userId"`
	}
	err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: row.ResidentID}}).Decode(&r)
	if err != nil {
		if err != mongo.ErrNoDocuments {
			slog.WarnContext(ctx, "complaint_notify_failed", "error", err)
		}
		return
	}
	if !status {
		if r.UserID != nil {
			_, _ = s.Notify.CreateInApp(ctx, notifications.Input{Body: "The hostel replied to “" + row.Title + "”.", Category: "COMPLAINT", HostelID: row.HostelID.Hex(), Title: "Complaint reply", UserID: r.UserID.Hex()})
		}
		return
	}
	// Email only once the complaint is settled; "in progress" is a bell row.
	settled := row.Status == "RESOLVED" || row.Status == "REJECTED"
	to := r.Email
	if to == "" && r.UserID != nil {
		var u struct {
			Email string `bson:"email"`
		}
		if err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *r.UserID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u); err == nil {
			to = u.Email
		}
	}
	if to != "" && settled && s.Config.OperationsTyped(ctx).SendComplaintEmails {
		hostelName, _ := hostelNameOf(ctx, s.DB, row.HostelID)
		url := s.AppURL("/resident/complaints")
		mail := email.ComplaintStatusUpdated(url, hostelName, response, row.Status, row.Title)
		if row.Status == "RESOLVED" {
			mail = email.ComplaintResolved(url, hostelName, response, row.Title)
		}
		s.Mail.Notify(ctx, email.Notification{Action: "complaint_status_updated", HTML: mail.HTML, Subject: mail.Subject, To: to, Category: mail.Category, Topic: "COMPLAINT_UPDATES"})
	}
	if r.UserID != nil {
		_, _ = s.Notify.CreateInApp(ctx, notifications.Input{Body: "“" + row.Title + "” is now " + strings.Replace(strings.ToLower(row.Status), "_", " ", 1) + ".", Category: "COMPLAINT",
			Data: ordered.Map{{Key: "status", Value: row.Status}}, HostelID: row.HostelID.Hex(), Title: "Complaint update", UserID: r.UserID.Hex()})
	}
}

func hostelNameOf(ctx context.Context, db *mongo.Database, id bson.ObjectID) (string, error) {
	var h struct {
		Name string `bson:"name"`
	}
	err := db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h)
	if err != nil || h.Name == "" {
		return "your hostel", err
	}
	return h.Name, nil
}
