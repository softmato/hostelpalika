// Package hostelleave is the signed-in owner's side of a hostel that left: what they
// can still claim back and the files kept for them. Filing and reviewing a request
// land with Phases 6 and 7.
package hostelleave

import (
	"context"
	"io"
	"log/slog"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	filesDays    = 30
	zipPerDay    = 3
	linksPerDay  = 200
	zipPartBytes = 200 * 1024 * 1024
	day          = 24 * time.Hour
)

var (
	objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)
	groups     = []struct {
		kinds []string
		label string
	}{{[]string{"RECORDS"}, "Records"}, {[]string{"REGISTRATION_DOCUMENT"}, "Documents"}, {[]string{"GENERIC", ""}, "Photos and files"}, {[]string{"PAYMENT_PROOF", "BOOKING_PAYMENT_PROOF"}, "Payment proofs"},
		{[]string{"EXPENSE_RECEIPT"}, "Expense receipts"}, {[]string{"STATEMENT"}, "Bank statements"}, {[]string{"PAYMENT_QR"}, "Payment QR codes"}, {[]string{"BOOKING_TRANSFER_PROOF"}, "Booking transfers"},
		{[]string{"COMPLAINT_NOTE"}, "Complaint voice notes"}, {[]string{"MAINTENANCE_NOTE"}, "Repair voice notes"}}
	sections = []struct{ key, label string }{{"residents", "Residents"}, {"rooms", "Rooms and beds"}, {"bills", "Rent bills"}, {"payments", "Payments"}, {"receipts", "Receipts"}, {"deposits", "Deposits"}, {"khata", "Khata"}, {"expenses", "Expenses"}, {"stock", "Stock"}, {"food", "Food menu"}, {"complaints", "Complaints"}, {"repairs", "Repairs"}, {"attendance", "Attendance"}, {"notices", "Notices"}}
	dashRuns = regexp.MustCompile(`\s+`)
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	R2     *storage.R2
	Mail   *email.Sender
	Audit  *audit.Log
	AppURL func(string) string
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/account/hostel-leave")
	g.GET("", h.list)
	g.POST("", h.reclaim)
	g.GET("/:requestId/files", h.files)
	g.GET("/:requestId/files/zip", h.zip)
	g.GET("/:requestId/files/:fileId", h.file)
}

func fail(status int, code, message string) error { return httpx.NewError(status, code, message, nil) }

func oidOf(value string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(value)
	if err != nil {
		return id, fail(422, "INVALID_HOSTEL_ID", "Invalid hostel id.")
	}
	return id, nil
}

type heldFile struct {
	ID        bson.ObjectID `bson:"_id"`
	Bucket    string        `bson:"bucket"`
	CreatedAt *time.Time    `bson:"createdAt"`
	FileName  string        `bson:"fileName"`
	Key       string        `bson:"key"`
	Kind      string        `bson:"kind"`
	SizeBytes int64         `bson:"sizeBytes"`
}

type zipDownload struct {
	At   time.Time `bson:"at"`
	Part int       `bson:"part"`
}

type request struct {
	ID          bson.ObjectID   `bson:"_id"`
	BranchIDs   []bson.ObjectID `bson:"branchIds"`
	ExportFiles []heldFile      `bson:"exportFiles"`
	Sections    []string        `bson:"exportSections"`
	SentAt      *time.Time      `bson:"exportSentAt"`
	SentTo      *string         `bson:"exportSentTo"`
	LinkCount   int             `bson:"fileLinkCount"`
	LinkDay     string          `bson:"fileLinkDay"`
	FilesUntil  *time.Time      `bson:"filesUntil"`
	HoldDays    int             `bson:"holdDays"`
	HoldUntil   *time.Time      `bson:"holdUntil"`
	HostelID    bson.ObjectID   `bson:"hostelId"`
	HostelName  string          `bson:"hostelName"`
	KeptFiles   []heldFile      `bson:"keptFiles"`
	OwnerEmail  string          `bson:"ownerEmail"`
	OwnerName   *string         `bson:"ownerName"`
	Reason      string          `bson:"reason"`
	ReclaimedAt *time.Time      `bson:"reclaimedAt"`
	RequestedAt time.Time       `bson:"requestedAt"`
	ReviewNote  *string         `bson:"reviewNote"`
	ReviewedAt  *time.Time      `bson:"reviewedAt"`
	Status      string          `bson:"status"`
	Zips        []zipDownload   `bson:"zipDownloads"`
}

func isoOf(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func strOf(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// serialized is serializeRequest.
func (r *request) serialized() ordered.Map {
	exported := r.Sections
	if exported == nil {
		exported = []string{}
	}
	var mail any
	if r.OwnerEmail != "" {
		mail = r.OwnerEmail
	}
	return ordered.Map{{Key: "branchCount", Value: len(r.BranchIDs)}, {Key: "exportSections", Value: exported}, {Key: "exportSentAt", Value: isoOf(r.SentAt)}, {Key: "exportSentTo", Value: strOf(r.SentTo)}, {Key: "holdDays", Value: r.HoldDays}, {Key: "holdUntil", Value: isoOf(r.HoldUntil)},
		{Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "hostelName", Value: r.HostelName}, {Key: "id", Value: r.ID.Hex()}, {Key: "ownerEmail", Value: mail}, {Key: "ownerName", Value: strOf(r.OwnerName)}, {Key: "reason", Value: r.Reason}, {Key: "reclaimedAt", Value: isoOf(r.ReclaimedAt)},
		{Key: "requestedAt", Value: httpx.ISO(r.RequestedAt)}, {Key: "reviewNote", Value: strOf(r.ReviewNote)}, {Key: "reviewedAt", Value: isoOf(r.ReviewedAt)}, {Key: "status", Value: r.Status}}
}

// identities is ownerIdentitiesFor: every live account with this user's email or phone.
func (h *Handler) identities(ctx context.Context, userID string) (bson.A, error) {
	me, err := httpx.OID(userID, "user id")
	if err != nil {
		return nil, err
	}
	var user struct {
		Email string `bson:"email"`
		Phone string `bson:"phone"`
	}
	err = h.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: me}}).Decode(&user)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	out := bson.A{me}
	or := bson.A{}
	if user.Email != "" {
		or = append(or, bson.D{{Key: "email", Value: strings.ToLower(user.Email)}})
	}
	if user.Phone != "" {
		or = append(or, bson.D{{Key: "phone", Value: user.Phone}})
	}
	if len(or) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection("users").Find(ctx, bson.D{{Key: "$or", Value: or}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, x := range rows {
		if x.ID != me {
			out = append(out, x.ID)
		}
	}
	return out, nil
}

func (h *Handler) claimable(ctx context.Context, ids bson.A, now time.Time) ([]request, error) {
	cur, err := h.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: true}, {Key: "ownerId", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		return nil, err
	}
	var owned []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &owned); err != nil {
		return nil, err
	}
	if len(owned) == 0 {
		return nil, nil
	}
	hostels := bson.A{}
	for _, x := range owned {
		hostels = append(hostels, x.ID)
	}
	cur, err = h.DB.Collection("hostelleaverequests").Find(ctx, bson.D{{Key: "holdUntil", Value: bson.D{{Key: "$gt", Value: now}}}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: hostels}}}, {Key: "status", Value: "APPROVED"}},
		options.Find().SetSort(bson.D{{Key: "holdUntil", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var out []request
	return out, cur.All(ctx, &out)
}

func (h *Handler) downloadable(ctx context.Context, ids bson.A, now time.Time) ([]request, error) {
	cur, err := h.DB.Collection("hostelleaverequests").Find(ctx, bson.D{{Key: "$and", Value: bson.A{
		bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "ownerId", Value: bson.D{{Key: "$in", Value: ids}}}}, bson.D{{Key: "ownerId", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "requestedBy", Value: bson.D{{Key: "$in", Value: ids}}}}}}},
		bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "filesUntil", Value: bson.D{{Key: "$gt", Value: now}}}}, bson.D{{Key: "filesUntil", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "holdUntil", Value: bson.D{{Key: "$gt", Value: now}}}}}}},
	}}, {Key: "status", Value: "APPROVED"}}, options.Find().SetSort(bson.D{{Key: "filesUntil", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var out []request
	return out, cur.All(ctx, &out)
}

type heldOut struct {
	CanClaim   bool   `json:"canClaim"`
	FilesUntil string `json:"filesUntil"`
	HoldDays   int    `json:"holdDays"`
	HoldUntil  string `json:"holdUntil"`
	HostelName string `json:"hostelName"`
	RequestID  string `json:"requestId"`
}

type heldList struct {
	Hostels []heldOut `json:"hostels"`
}

func (h *Handler) list(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ids, err := h.identities(c, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	claimable, err := h.claimable(c, ids, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows, err := h.downloadable(c, ids, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	can := map[bson.ObjectID]bool{}
	for i := range claimable {
		can[claimable[i].ID] = true
	}
	out := heldList{make([]heldOut, len(rows))}
	for i := range rows {
		r := &rows[i]
		until := r.FilesUntil
		if until == nil {
			until = r.HoldUntil
		}
		out.Hostels[i] = heldOut{can[r.ID], httpx.ISO(*until), r.HoldDays, httpx.ISO(*r.HoldUntil), r.HostelName, r.ID.Hex()}
	}
	sort.SliceStable(out.Hostels, func(i, j int) bool { return out.Hostels[i].CanClaim && !out.Hostels[j].CanClaim })
	httpx.OK(c, out, "Held hostels loaded")
}

type reclaimed struct {
	HostelID string      `json:"hostelId"`
	Request  ordered.Map `json:"request"`
}

func (h *Handler) reclaim(c *gin.Context) {
	p, err := h.Guards.Require(c)
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
	requestID := ""
	if f.M != nil {
		v, present := f.M["requestId"]
		s, ok := v.(string)
		switch {
		case !present || !ok:
			f.Is.Add("requestId", valid.Type("string", valid.Received(v, !present)))
		case !objectIDRe.MatchString(s):
			f.Is.Add("requestId", "Invalid id.")
		}
		requestID = s
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.claimBack(c, p, requestID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Your hostel is back")
}

// restore is restorePlatformHostel.
func (h *Handler) restore(ctx context.Context, p *authz.Principal, me, id bson.ObjectID) error {
	coll := h.DB.Collection("hostels")
	var existing struct {
		DeletedAt *time.Time     `bson:"deletedAt"`
		Owner     *bson.ObjectID `bson:"ownerId"`
		Purge     *time.Time     `bson:"purgeScheduledAt"`
		Prefix    string         `bson:"referencePrefix"`
		Slug      string         `bson:"slug"`
	}
	missing := fail(404, "HOSTEL_NOT_FOUND", "Hostel was not found, or is not archived.")
	err := coll.FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: true}}).Decode(&existing)
	if err == mongo.ErrNoDocuments {
		return missing
	}
	if err != nil {
		return err
	}
	if existing.Purge != nil && !existing.Purge.After(time.Now()) {
		return fail(409, "HOSTEL_PURGE_DUE", "This hostel's grace period has run out and it is queued for erasure. It can no longer be restored.")
	}
	or := bson.A{bson.D{{Key: "slug", Value: existing.Slug}}}
	if existing.Prefix != "" {
		or = append(or, bson.D{{Key: "referencePrefix", Value: existing.Prefix}})
	}
	var clash struct {
		Name *string `bson:"name"`
		Slug string  `bson:"slug"`
	}
	err = coll.FindOne(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: id}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "$or", Value: or}}).Decode(&clash)
	if err == nil {
		name := clash.Slug
		if clash.Name != nil {
			name = *clash.Name
		}
		return fail(409, "HOSTEL_SLUG_TAKEN", `Its address or reference code is now held by "`+name+`". Rename that hostel before restoring this one.`)
	}
	if err != mongo.ErrNoDocuments {
		return err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	res, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: true}}, bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: false}, {Key: "updatedBy", Value: me}, {Key: "updatedAt", Value: now}}},
		{Key: "$unset", Value: bson.D{{Key: "archiveReason", Value: ""}, {Key: "deletedAt", Value: ""}, {Key: "deletedBy", Value: ""}, {Key: "purgeScheduledAt", Value: ""}}}})
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		return missing
	}
	cur, err := h.DB.Collection("hostelmembers").Find(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return err
	}
	var members []struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &members); err != nil {
		return err
	}
	staff := bson.A{}
	if existing.Owner != nil {
		staff = append(staff, *existing.Owner)
	}
	for _, m := range members {
		if m.UserID != nil {
			staff = append(staff, *m.UserID)
		}
	}
	if len(staff) > 0 {
		if _, err := h.DB.Collection("users").UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: staff}}}}, bson.D{{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: id}}}}); err != nil {
			return err
		}
	}
	var archivedAt any
	if existing.DeletedAt != nil {
		archivedAt = httpx.ISO(*existing.DeletedAt)
	}
	return h.Audit.Write(ctx, audit.Entry{ActorID: me, HostelID: id, Action: "HOSTEL_RESTORED", EntityType: "Hostel", EntityID: id.Hex(), Metadata: bson.D{{Key: "archivedAt", Value: archivedAt}}})
}

func (h *Handler) claimBack(ctx context.Context, p *authz.Principal, requestID string) (*reclaimed, error) {
	id, err := oidOf(requestID)
	if err != nil {
		return nil, err
	}
	ids, err := h.identities(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	claimable, err := h.claimable(ctx, ids, now)
	if err != nil {
		return nil, err
	}
	mine := false
	for i := range claimable {
		mine = mine || claimable[i].ID == id
	}
	if !mine {
		return nil, fail(409, "RECLAIM_NOT_AVAILABLE", "This hostel cannot be claimed back — its hold has ended or it is not yours.")
	}
	coll := h.DB.Collection("hostelleaverequests")
	var req request
	err = coll.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "holdUntil", Value: bson.D{{Key: "$gt", Value: now}}}, {Key: "status", Value: "APPROVED"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reclaimedAt", Value: now}, {Key: "status", Value: "RECLAIMED"}, {Key: "updatedAt", Value: now}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&req)
	if err == mongo.ErrNoDocuments {
		return nil, fail(409, "RECLAIM_NOT_AVAILABLE", "This hostel was already claimed back.")
	}
	if err != nil {
		return nil, err
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	for _, building := range append(append([]bson.ObjectID{}, req.BranchIDs...), req.HostelID) {
		var row struct {
			Deleted bool `bson:"isDeleted"`
		}
		err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: building}}).Decode(&row)
		if err == nil && row.Deleted {
			err = h.restore(ctx, p, me, building)
		}
		if err != nil && err != mongo.ErrNoDocuments {
			if _, undo := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: req.ID}, {Key: "status", Value: "RECLAIMED"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "APPROVED"}}}, {Key: "$unset", Value: bson.D{{Key: "reclaimedAt", Value: ""}}}}); undo != nil {
				slog.ErrorContext(ctx, "reclaim undo failed; the request stays RECLAIMED", "request", req.ID.Hex(), "error", undo)
			}
			return nil, err
		}
	}
	users := h.DB.Collection("users")
	if len(req.BranchIDs) > 0 {
		branches := bson.A{}
		for _, b := range req.BranchIDs {
			branches = append(branches, b)
		}
		cur, err := users.Find(ctx, bson.D{{Key: "$and", Value: bson.A{bson.D{{Key: "hostelIds", Value: req.HostelID}}, bson.D{{Key: "hostelIds", Value: bson.D{{Key: "$in", Value: branches}}}}}}})
		if err != nil {
			return nil, err
		}
		var both []struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cur.All(ctx, &both); err != nil {
			return nil, err
		}
		list := bson.A{}
		for _, x := range both {
			list = append(list, x.ID)
		}
		match := bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: list}}}}
		if _, err := users.UpdateMany(ctx, match, bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: req.HostelID}}}}); err != nil {
			return nil, err
		}
		if _, err := users.UpdateMany(ctx, match, bson.D{{Key: "$push", Value: bson.D{{Key: "hostelIds", Value: bson.D{{Key: "$each", Value: bson.A{req.HostelID}}, {Key: "$position", Value: 0}}}}}}); err != nil {
			return nil, err
		}
	}
	var hostel struct {
		Owner *bson.ObjectID `bson:"ownerId"`
		Slug  string         `bson:"slug"`
	}
	if err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: req.HostelID}}).Decode(&hostel); err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	var owner struct {
		Email string  `bson:"email"`
		Name  *string `bson:"name"`
	}
	if hostel.Owner != nil {
		err := users.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: *hostel.Owner}, {Key: "role", Value: "PUBLIC"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "updatedAt", Value: now}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&owner)
		if err != nil && err != mongo.ErrNoDocuments {
			return nil, err
		}
	}
	_ = h.Audit.Write(ctx, audit.Entry{ActorID: me, HostelID: req.HostelID, Action: "HOSTEL_LEAVE_RECLAIMED", EntityType: "Hostel", EntityID: req.HostelID.Hex(), Metadata: bson.D{{Key: "requestId", Value: req.ID.Hex()}}})
	to := owner.Email
	if to == "" {
		to = req.OwnerEmail
	}
	if to != "" {
		name := ""
		if owner.Name != nil {
			name = *owner.Name
		} else if req.OwnerName != nil {
			name = *req.OwnerName
		}
		portal := "/hostel-admin/dashboard"
		if hostel.Slug != "" {
			portal = "/" + hostel.Slug + "/admin/dashboard"
		}
		mail := email.HostelReclaimed(req.HostelName, name, h.AppURL(portal))
		h.Mail.Notify(ctx, email.Notification{Action: "hostel_reclaimed", Category: mail.Category, HTML: mail.HTML, Subject: mail.Subject, To: to})
	}
	return &reclaimed{req.HostelID.Hex(), req.serialized()}, nil
}

// --- files --------------------------------------------------------------------------

func groupOf(kind string) (string, int) {
	for i, g := range groups {
		for _, k := range g.kinds {
			if k == kind {
				return g.label, i
			}
		}
	}
	return "Other", len(groups)
}

func recordType(f *heldFile) any {
	if f.Kind != "RECORDS" {
		return nil
	}
	switch {
	case strings.HasSuffix(f.FileName, ".xlsx"):
		return "excel"
	case strings.HasSuffix(f.FileName, "-csv.zip"):
		return "csv"
	case strings.HasSuffix(f.FileName, ".csv"):
		return "section"
	}
	return "json"
}

func nepalDay(now time.Time) string { return bs.CalendarDay(now).Format("2006-01-02") }

type held struct {
	files   []heldFile
	pending bool
	req     *request
}

// held is heldFiles. A hostel that left before its records were filed asks for them
// to be built; ponytail: Go only reports them pending, because the export is
// platform/hostel-leaves' (Phase 7) and TS still runs the build until then.
func (h *Handler) held(ctx context.Context, userID, requestID string) (*held, error) {
	id, err := oidOf(requestID)
	if err != nil {
		return nil, err
	}
	ids, err := h.identities(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := h.downloadable(ctx, ids, time.Now())
	if err != nil {
		return nil, err
	}
	var req *request
	for i := range rows {
		if rows[i].ID == id {
			req = &rows[i]
		}
	}
	if req == nil {
		return nil, fail(404, "LEAVE_FILES_NOT_AVAILABLE", "These files are no longer available — they are kept for "+strconv.Itoa(filesDays)+" days after leaving.")
	}
	complete := false
	for i := range req.ExportFiles {
		complete = complete || strings.HasSuffix(req.ExportFiles[i].FileName, ".csv")
	}
	pending := false
	if !complete && len(req.Sections) > 0 {
		err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: req.HostelID}}).Err()
		if err != nil && err != mongo.ErrNoDocuments {
			return nil, err
		}
		pending = err == nil
	}
	hostels := bson.A{req.HostelID}
	for _, b := range req.BranchIDs {
		hostels = append(hostels, b)
	}
	cur, err := h.DB.Collection("fileassets").Find(ctx, bson.D{{Key: "bucket", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: ""}}}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: hostels}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "key", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: ""}}}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var live []heldFile
	if err := cur.All(ctx, &live); err != nil {
		return nil, err
	}
	seen := map[bson.ObjectID]bool{}
	for i := range live {
		seen[live[i].ID] = true
	}
	files := make([]heldFile, 0, len(req.ExportFiles)+len(live)+len(req.KeptFiles))
	for _, f := range req.ExportFiles {
		f.Kind = "RECORDS"
		files = append(files, f)
	}
	files = append(files, live...)
	for _, f := range req.KeptFiles {
		if !seen[f.ID] {
			files = append(files, f)
		}
	}
	stamp := func(f *heldFile) int64 {
		if f.CreatedAt == nil {
			return 0
		}
		return f.CreatedAt.UnixMilli()
	}
	sort.SliceStable(files, func(i, j int) bool {
		_, a := groupOf(files[i].Kind)
		_, b := groupOf(files[j].Kind)
		if a != b {
			return a < b
		}
		return stamp(&files[i]) < stamp(&files[j])
	})
	return &held{files, pending, req}, nil
}

// partitions is partitionBySize over what a ZIP carries: the CSV bundle stays out.
func partitions(files []heldFile) [][]heldFile {
	parts := [][]heldFile{}
	var current []heldFile
	var size int64
	for i := range files {
		f := files[i]
		if recordType(&f) == "csv" {
			continue
		}
		if len(current) > 0 && size+f.SizeBytes > zipPartBytes {
			parts = append(parts, current)
			current, size = nil, 0
		}
		current = append(current, f)
		size += f.SizeBytes
	}
	if len(current) > 0 {
		parts = append(parts, current)
	}
	return parts
}

func zipsLeft(log []zipDownload, part int, now time.Time) int {
	used := 0
	for _, e := range log {
		if e.Part == part && e.At.After(now.Add(-day)) {
			used++
		}
	}
	return max(0, zipPerDay-used)
}

type sectionOut struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Order int    `json:"order"`
}

func sectionOf(name string) any {
	for i, s := range sections {
		if strings.HasSuffix(name, "-"+s.key+".csv") {
			return sectionOut{s.key, s.label, i}
		}
	}
	return nil
}

type fileOut struct {
	Group      string `json:"group"`
	ID         string `json:"id"`
	Record     any    `json:"record"`
	Section    any    `json:"section"`
	Kind       any    `json:"kind"`
	Name       string `json:"name"`
	SizeBytes  int64  `json:"sizeBytes"`
	UploadedAt any    `json:"uploadedAt"`
}

type partOut struct {
	Bytes int64 `json:"bytes"`
	Files int   `json:"files"`
	Left  int   `json:"left"`
	Part  int   `json:"part"`
}

type filesOut struct {
	Files          []fileOut `json:"files"`
	FilesUntil     any       `json:"filesUntil"`
	HoldUntil      any       `json:"holdUntil"`
	HostelName     string    `json:"hostelName"`
	FileLinksLeft  int       `json:"fileLinksLeft"`
	Parts          []partOut `json:"parts"`
	RecordsPending bool      `json:"recordsPending"`
	TotalBytes     int64     `json:"totalBytes"`
}

func (h *Handler) files(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	got, err := h.held(c, p.UserID, c.Param("requestId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	req := got.req
	now := time.Now()
	out := filesOut{Files: make([]fileOut, len(got.files)), HoldUntil: isoOf(req.HoldUntil), HostelName: req.HostelName, FileLinksLeft: linksPerDay, Parts: []partOut{}, RecordsPending: got.pending}
	until := req.FilesUntil
	if until == nil {
		until = req.HoldUntil
	}
	out.FilesUntil = isoOf(until)
	if req.LinkDay == nepalDay(now) {
		out.FileLinksLeft = max(0, linksPerDay-req.LinkCount)
	}
	for i := range got.files {
		f := &got.files[i]
		label, _ := groupOf(f.Kind)
		var section, kind any
		record := recordType(f)
		if record == "section" {
			section = sectionOf(f.FileName)
		}
		if f.Kind != "" {
			kind = f.Kind
		}
		name := f.FileName
		if name == "" {
			name = "file"
		}
		out.Files[i] = fileOut{label, f.ID.Hex(), record, section, kind, name, f.SizeBytes, isoOf(f.CreatedAt)}
		out.TotalBytes += f.SizeBytes
	}
	for i, part := range partitions(got.files) {
		var size int64
		for j := range part {
			size += part[j].SizeBytes
		}
		out.Parts = append(out.Parts, partOut{size, len(part), zipsLeft(req.Zips, i+1, now), i + 1})
	}
	httpx.OK(c, out, "Files loaded")
}

type linkOut struct {
	URL string `json:"url"`
}

func (h *Handler) file(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	got, err := h.held(c, p.UserID, c.Param("requestId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var f *heldFile
	for i := range got.files {
		if got.files[i].ID.Hex() == c.Param("fileId") {
			f = &got.files[i]
		}
	}
	if f == nil || f.Bucket == "" || f.Key == "" {
		httpx.Fail(c, fail(404, "FILE_NOT_FOUND", "File not found."))
		return
	}
	today := nepalDay(time.Now())
	res, err := h.DB.Collection("hostelleaverequests").UpdateOne(c, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "fileLinkDay", Value: bson.D{{Key: "$ne", Value: today}}}}, bson.D{{Key: "fileLinkCount", Value: bson.D{{Key: "$lt", Value: linksPerDay}}}}}}, {Key: "_id", Value: got.req.ID}},
		bson.A{bson.D{{Key: "$set", Value: bson.D{{Key: "fileLinkCount", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$fileLinkDay", today}}}, bson.D{{Key: "$add", Value: bson.A{bson.D{{Key: "$ifNull", Value: bson.A{"$fileLinkCount", 0}}}, 1}}}, 1}}}}, {Key: "fileLinkDay", Value: today}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.ModifiedCount == 0 {
		httpx.Fail(c, fail(429, "LEAVE_FILE_LINKS_EXHAUSTED", "That is "+strconv.Itoa(linksPerDay)+" files today. Download the rest tomorrow, or take them all as one ZIP."))
		return
	}
	name := f.FileName
	if name == "" {
		name = "file"
	}
	target, err := h.R2.PresignRead(c, f.Bucket, f.Key, name)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, wantsLink := c.GetQuery("link"); wantsLink {
		httpx.OK(c, linkOut{target}, "File link ready")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Redirect(302, target)
}

func (h *Handler) zip(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	got, err := h.held(c, p.UserID, c.Param("requestId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	part := 1
	if n, err := strconv.ParseFloat(c.Query("part"), 64); err == nil && !math.IsNaN(n) && n != 0 {
		part = max(1, int(n))
	}
	parts := partitions(got.files)
	if part > len(parts) {
		httpx.Fail(c, fail(404, "LEAVE_FILES_PART_NOT_FOUND", "That part does not exist."))
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if zipsLeft(got.req.Zips, part, now) == 0 {
		httpx.Fail(c, fail(429, "LEAVE_ZIP_DOWNLOADS_EXHAUSTED", "You have downloaded this "+strconv.Itoa(zipPerDay)+" times today. You can download it again tomorrow."))
		return
	}
	log := bson.A{}
	for _, e := range got.req.Zips {
		if e.At.After(now.Add(-day)) {
			log = append(log, bson.D{{Key: "at", Value: e.At}, {Key: "part", Value: e.Part}})
		}
	}
	log = append(log, bson.D{{Key: "at", Value: now}, {Key: "part", Value: part}})
	if _, err := h.DB.Collection("hostelleaverequests").UpdateOne(c, bson.D{{Key: "_id", Value: got.req.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "zipDownloads", Value: log}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	slug := dashRuns.ReplaceAllString(strings.ToLower(export.SafeEntryName(got.req.HostelName)), "-")
	filename := slug + "-files.zip"
	if len(parts) > 1 {
		filename = slug + "-files-part-" + strconv.Itoa(part) + "-of-" + strconv.Itoa(len(parts)) + ".zip"
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Header("Content-Type", "application/zip")
	c.Status(200)
	err = export.Zip(c.Writer, func(yield func(export.Entry) bool) {
		used := map[string]bool{}
		missing := []string{}
		for i := range parts[part-1] {
			f := parts[part-1][i]
			base := f.FileName
			if base == "" {
				base = "file"
			}
			base = export.SafeEntryName(base)
			label, _ := groupOf(f.Kind)
			folder := export.SafeEntryName(label)
			name := folder + "/" + base
			for copyN := 2; used[strings.ToLower(name)]; copyN++ {
				if dot := strings.LastIndex(base, "."); dot > 0 {
					name = folder + "/" + base[:dot] + " (" + strconv.Itoa(copyN) + ")" + base[dot:]
				} else {
					name = folder + "/" + base + " (" + strconv.Itoa(copyN) + ")"
				}
			}
			body, err := h.R2.Get(c, f.Bucket, f.Key)
			if err != nil {
				uploaded := "unknown"
				if f.CreatedAt != nil {
					uploaded = f.CreatedAt.UTC().Format("2006-01-02")
				}
				missing = append(missing, name+" (uploaded "+uploaded+")")
				continue
			}
			used[strings.ToLower(name)] = true
			date := time.Now()
			if f.CreatedAt != nil {
				date = *f.CreatedAt
			}
			if !yield(export.Entry{Name: name, Date: date, Open: func() (io.ReadCloser, error) { return body, nil }}) {
				return
			}
		}
		if len(missing) > 0 {
			note := "These files could not be read from storage and are not in this ZIP:\n\n" + strings.Join(missing, "\n") + "\n"
			yield(export.Entry{Name: "missing-files.txt", Date: time.Now(), Open: func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(note)), nil }})
		}
	})
	if err != nil {
		_ = c.Error(err) // the headers have gone; the client sees a cut-off ZIP
	}
}
