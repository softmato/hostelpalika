package hostelleave

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Review is /platform/hostel-leaves: the superadmin's queue of hostels asking to leave.
type Review struct {
	*Owner
	// Archive is hostels.Platform.Archive.
	Archive func(ctx context.Context, id bson.ObjectID, reason string, actor bson.ObjectID, graceDays int, keep []bson.ObjectID) (bson.Raw, int64, error)
}

func (r *Review) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/platform/hostel-leaves", authz.Use(r.Guards.RequireSuperadmin))
	g.GET("", r.list)
	g.GET("/:id", r.get)
	g.POST("/:id/approve", r.approve)
	g.POST("/:id/reject", r.reject)
}

func (r *Review) requests() *mongo.Collection { return r.DB.Collection("hostelleaverequests") }

func requestID(raw string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil || !objectIDRe.MatchString(raw) {
		return id, fail(422, "INVALID_HOSTEL_ID", "Invalid hostel id.")
	}
	return id, nil
}

func (r *Review) list(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	status := valid.QueryEnum(q, "status", &is, "PENDING", "APPROVED", "REJECTED", "CANCELLED", "RECLAIMED", "ALL")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "status", Value: "PENDING"}}
	if status != nil {
		filter = bson.D{{Key: "status", Value: *status}}
		if *status == "ALL" {
			filter = bson.D{}
		}
	}
	// ponytail: one unpaged read of at most 200; leaving hostels are rare.
	cur, err := r.requests().Find(c, filter, options.Find().SetSort(bson.D{{Key: "requestedAt", Value: -1}}).SetLimit(200))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []request
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		out[i] = rows[i].serialized()
	}
	httpx.OK(c, ordered.Map{{Key: "requests", Value: out}}, "Leave requests loaded")
}

type leavingHostel struct {
	Owned     ownedHostel `bson:",inline"` // named: an unexported embedded inline struct is skipped
	CreatedAt *time.Time  `bson:"createdAt"`
	IsDeleted bool        `bson:"isDeleted"`
	Slug      *string     `bson:"slug"`
}

func (r *Review) get(c *gin.Context) {
	id, err := requestID(c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var req request
	if err := r.requests().FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&req); errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, fail(404, "LEAVE_NOT_FOUND", "Request was not found."))
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	var h leavingHostel
	found := true
	if err := r.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: req.HostelID}}).Decode(&h); errors.Is(err, mongo.ErrNoDocuments) {
		found = false
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	blockers, branchesOut := []blocker{}, []branchOut{}
	if found && req.Status == "PENDING" {
		branches, buildings, err := r.branchesOf(c, &h.Owned)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		facts, err := r.facts(c, h.Owned.ID, buildings)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		blockers = blockersOf(facts)
		for _, b := range branches {
			branchesOut = append(branchesOut, branchOut{b.ID.Hex(), b.Name})
		}
	}
	hostel := ordered.Map{{Key: "erased", Value: true}}
	if found {
		hostel = ordered.Map{{Key: "erased", Value: false}, {Key: "id", Value: h.Owned.ID.Hex()}, {Key: "isArchived", Value: h.IsDeleted}, {Key: "isBranch", Value: h.Owned.ParentID != nil},
			{Key: "since", Value: isoOf(h.CreatedAt)}, {Key: "slug", Value: strOf(h.Slug)}}
	}
	httpx.OK(c, ordered.Map{{Key: "blockers", Value: blockers}, {Key: "branches", Value: branchesOut}, {Key: "hostel", Value: hostel}, {Key: "request", Value: req.serialized()}}, "Leave request loaded")
}

func notPending() error {
	return fail(409, "LEAVE_NOT_PENDING", "This request is not waiting for review.")
}

func actorOf(c *gin.Context) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	return id
}

// approve is approveHostelLeaveRequest: re-check the bills, email the data, then
// archive. The data goes first: if the email cannot be sent nothing is archived and
// the request goes back to waiting. `reviewedAt` is a claim set before any of it,
// so two superadmins pressing Approve at once send one email and archive once.
func (r *Review) approve(c *gin.Context) {
	id, err := requestID(c.Param("id"))
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
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 1000})
	var sections []string
	if items, ok := f.Array("sections", false, false); ok {
		keys := sectionKeys()
		for i, v := range items {
			sub := valid.NewForm(map[string]any{"k": v})
			if k, ok := sub.Enum("k", false, nil, keys...); ok {
				sections = append(sections, k)
			}
			f.JoinScalar("sections."+strconv.Itoa(i), sub)
		}
		f.Size("sections", len(items), 0, len(keys), "", false)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor := actorOf(c)
	now := time.Now().UTC().Truncate(time.Millisecond)
	var req request
	err = r.requests().FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "reviewedAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&req)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notPending())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := r.approveClaimed(c, &req, actor, now, sections, note, hasNote)
	if err != nil {
		// Released on a context of its own: a cancelled request must not leave the claim stuck.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(c), 10*time.Second)
		if _, undo := r.requests().UpdateOne(ctx, bson.D{{Key: "_id", Value: req.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$unset", Value: bson.D{{Key: "reviewedAt", Value: ""}, {Key: "reviewedBy", Value: ""}}}}); undo != nil {
			slog.ErrorContext(ctx, "leave approval claim not released; the request stays claimed", "request", req.ID.Hex(), "error", undo)
		}
		cancel()
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Approved — the data was emailed and the hostel is off the platform")
}

func (r *Review) approveClaimed(c *gin.Context, req *request, actor bson.ObjectID, now time.Time, sections []string, note string, hasNote bool) (ordered.Map, error) {
	var h leavingHostel
	err := r.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: req.HostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(404, "HOSTEL_NOT_FOUND", "This hostel is already off the platform.")
	}
	if err != nil {
		return nil, err
	}
	branches, buildings, err := r.branchesOf(c, &h.Owned)
	if err != nil {
		return nil, err
	}
	facts, err := r.facts(c, h.Owned.ID, buildings)
	if err != nil {
		return nil, err
	}
	if b := blockersOf(facts); len(b) > 0 {
		return nil, fail(409, b[0].Code, "Not yet: "+b[0].Message)
	}
	var owner struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
		Name  *string       `bson:"name"`
		Role  string        `bson:"role"`
	}
	hasOwner := false
	if h.Owned.OwnerID != nil {
		err := r.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: *h.Owned.OwnerID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}, {Key: "role", Value: 1}})).Decode(&owner)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
		hasOwner = err == nil
	}
	to := owner.Email
	if to == "" {
		to = req.OwnerEmail
	}
	if to == "" {
		return nil, fail(422, "LEAVE_NO_OWNER_EMAIL", "The owner has no email to send the data to.")
	}
	ids := []bson.ObjectID{h.Owned.ID}
	for _, b := range branches {
		ids = append(ids, b.ID)
	}
	var built *exported
	if len(sections) > 0 {
		slug := ""
		if h.Slug != nil {
			slug = *h.Slug
		}
		if built, err = buildExport(c, r.DB, ids, sections, slug); err != nil {
			return nil, err
		}
	}
	day := 24 * time.Hour
	holdUntil := now.Add(time.Duration(req.HoldDays) * day)
	filesUntil := now.Add(time.Duration(max(filesDays, req.HoldDays)) * day)
	ownerName := ""
	if owner.Name != nil {
		ownerName = *owner.Name
	} else if req.OwnerName != nil {
		ownerName = *req.OwnerName
	}
	var files, sheetLabels []string
	var attachments []email.Attachment
	if built != nil {
		attachments = built.attachments
		for _, a := range attachments {
			files = append(files, a.Filename)
		}
		for _, s := range built.sheets {
			sheetLabels = append(sheetLabels, s.label)
		}
	}
	m := email.HostelLeaveApproved(r.AppURL("/hostel-leave"), files, filesUntil, holdUntil, req.HostelName, ownerName, sheetLabels)
	if !r.Mail.Notify(c, email.Notification{Action: "hostel_leave_approved", To: to, Subject: m.Subject, HTML: m.HTML, Category: m.Category, Attachments: attachments}) {
		return nil, fail(502, "LEAVE_EXPORT_NOT_SENT", "Could not email the data to the owner. Nothing was deleted — try again.")
	}
	reason := []rune("Owner asked to leave: " + req.Reason)
	if len(reason) > 1000 {
		reason = reason[:1000]
	}
	// Recorded before archiving, so a retry after a half-finished run still knows
	// every branch it took; the claim-back restores exactly these.
	branchIDs := bson.A{}
	for _, b := range branches {
		branchIDs = append(branchIDs, b.ID)
	}
	if _, err := r.requests().UpdateOne(c, bson.D{{Key: "_id", Value: req.ID}}, bson.D{{Key: "$addToSet", Value: bson.D{{Key: "branchIds", Value: bson.D{{Key: "$each", Value: branchIDs}}}}}}); err != nil {
		return nil, err
	}
	var keep []bson.ObjectID
	if hasOwner {
		keep = []bson.ObjectID{owner.ID}
	}
	// Branches first, the main hostel last: until it is archived the request still
	// reads as waiting on a live hostel, and Approve can be retried.
	for _, b := range append(ids[1:], ids[0]) {
		if _, _, err := r.Archive(c, b, string(reason), actor, req.HoldDays, keep); err != nil {
			return nil, err
		}
	}
	// With no hostel left the owner is a public account again, where the claim-back card lives.
	if hasOwner && owner.Role == "HOSTEL_ADMIN" {
		if _, err := r.DB.Collection("users").UpdateOne(c, bson.D{{Key: "_id", Value: owner.ID}, {Key: "hostelIds", Value: bson.D{{Key: "$size", Value: 0}}}, {Key: "role", Value: "HOSTEL_ADMIN"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "role", Value: "PUBLIC"}}}}); err != nil {
			return nil, err
		}
	}
	if sections == nil {
		sections = []string{}
	}
	set := bson.D{{Key: "exportSections", Value: sections}, {Key: "exportSentAt", Value: time.Now().UTC()}, {Key: "exportSentTo", Value: to}, {Key: "filesUntil", Value: filesUntil}, {Key: "holdUntil", Value: holdUntil}}
	if h.Owned.OwnerID != nil {
		set = append(set, bson.E{Key: "ownerId", Value: *h.Owned.OwnerID})
	}
	if hasNote && note != "" {
		set = append(set, bson.E{Key: "reviewNote", Value: note})
	}
	set = append(set, bson.E{Key: "status", Value: "APPROVED"}, bson.E{Key: "updatedAt", Value: time.Now().UTC()})
	var approved request
	if err := r.requests().FindOneAndUpdate(c, bson.D{{Key: "_id", Value: req.ID}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&approved); err != nil {
		return nil, err
	}
	sheets := []ordered.Map{}
	truncated := []string{}
	if built != nil {
		// Kept for the files page; the email already carried them, so a failure here waits for the backfill.
		all := append(append(append([]email.Attachment{}, built.attachments...), built.csvZip), built.csvFiles...)
		_ = r.storeFiles(c, req.ID, all)
		for _, s := range built.sheets {
			sheets = append(sheets, ordered.Map{{Key: "key", Value: s.key}, {Key: "label", Value: s.label}, {Key: "rows", Value: len(s.rows)}, {Key: "truncated", Value: s.truncated}})
			if s.truncated {
				truncated = append(truncated, s.key)
			}
		}
	}
	r.audited(c, actor, h.Owned.ID, "HOSTEL_LEAVE_APPROVED", bson.D{{Key: "branches", Value: len(branches)}, {Key: "holdUntil", Value: httpx.ISO(holdUntil)}, {Key: "requestId", Value: req.ID.Hex()},
		{Key: "sections", Value: sections}, {Key: "truncated", Value: truncated}})
	return ordered.Map{{Key: "sheets", Value: sheets}, {Key: "request", Value: approved.serialized()}}, nil
}

func (r *Review) reject(c *gin.Context) {
	id, err := requestID(c.Param("id"))
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
	note, _ := f.Str("note", valid.S{Trim: true, Min: 3, MinMsg: "Say why, so the owner knows.", Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor := actorOf(c)
	now := time.Now().UTC().Truncate(time.Millisecond)
	var req request
	err = r.requests().FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "reviewedAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reviewNote", Value: note}, {Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: "REJECTED"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&req)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notPending())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r.audited(c, actor, req.HostelID, "HOSTEL_LEAVE_REJECTED", bson.D{{Key: "requestId", Value: req.ID.Hex()}})
	if req.OwnerEmail != "" {
		name := ""
		if req.OwnerName != nil {
			name = *req.OwnerName
		}
		m := email.HostelLeaveRejected(req.HostelName, note, name)
		r.Mail.Notify(c, email.Notification{Action: "hostel_leave_rejected", To: req.OwnerEmail, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
	}
	if req.RequestedBy != nil {
		_, _ = r.Notify.CreateInApp(c, notifications.Input{ActionURL: "/hostel-admin/leave", Body: note, Category: "GENERAL", Data: ordered.Map{{Key: "hostelId", Value: req.HostelID.Hex()}, {Key: "type", Value: "HOSTEL_LEAVE"}},
			HostelID: req.HostelID.Hex(), Priority: "HIGH", Title: "Request to leave not approved", UserID: req.RequestedBy.Hex()})
	}
	httpx.OK(c, ordered.Map{{Key: "request", Value: req.serialized()}}, "Request not approved — the owner was told")
}
