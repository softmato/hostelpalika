package users

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// GraceDays is DELETION_GRACE_PERIOD_DAYS (ARCHITECTURE.md §13.1).
const GraceDays = 60

// Deletion serves account-deletion.service.ts: the account's own status and
// request, and the superadmin's review queue.
type Deletion struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Tokens *auth.Tokens
	Mail   *email.Sender
	Audit  *audit.Log
	Notify *notifications.Service
	AppURL func(path string) string
	Now    func() time.Time
}

func (d *Deletion) Register(v1 *gin.RouterGroup) {
	v1.GET("/users/account-deletion", httpx.ETag(), d.status)
	v1.POST("/users/account-deletion", d.request)
	v1.GET("/platform/account-deletions", httpx.ETag(), d.list)
	v1.POST("/platform/account-deletions/:id/review", d.review)
}

func deletionErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

type accountRow struct {
	ID        bson.ObjectID   `bson:"_id"`
	Email     string          `bson:"email"`
	HostelIDs []bson.ObjectID `bson:"hostelIds"`
	Name      *string         `bson:"name"`
	Role      string          `bson:"role"`
}

func (d *Deletion) loadUser(ctx context.Context, userID string) (accountRow, error) {
	var u accountRow
	id, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return u, deletionErr(422, "INVALID_OBJECT_ID", "Invalid user id.")
	}
	err = d.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return u, deletionErr(404, "NOT_FOUND", "Account was not found.")
	}
	return u, err
}

// pathway is resolvePathway: what "Delete account" may do for this account.
func (d *Deletion) pathway(ctx context.Context, u accountRow) (path string, blocked *string, hostelNames []string, err error) {
	hostelNames = []string{}
	block := func(msg string) (string, *string, []string, error) { return "BLOCKED", &msg, hostelNames, nil }
	switch authz.Role(u.Role) {
	case authz.Guardian:
		return "GUARDIAN_RELEASE", nil, hostelNames, nil
	case authz.HostelAdmin:
		cur, err := d.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: nonNil(u.HostelIDs)}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
			options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			return "", nil, nil, err
		}
		var hs []struct {
			Name string `bson:"name"`
		}
		if err := cur.All(ctx, &hs); err != nil {
			return "", nil, nil, err
		}
		for _, h := range hs {
			hostelNames = append(hostelNames, h.Name)
		}
		return "PLATFORM_REVIEW", nil, hostelNames, nil
	case authz.Warden, authz.Cook:
		return block("Staff accounts are created and closed by your hostel administrator. Ask them to remove your account.")
	case authz.Superadmin, authz.PlatformModerator:
		return block("Platform accounts cannot be deleted from here. Another platform owner must remove the account.")
	}
	n, err := d.DB.Collection("residents").CountDocuments(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: u.ID}}, options.Count().SetLimit(1))
	if err != nil {
		return "", nil, nil, err
	}
	if n > 0 {
		return block("You are currently registered as a resident. Your hostel needs this record while you are living there — you can delete your account once you have moved out.")
	}
	return "SELF_SERVICE", nil, hostelNames, nil
}

func nonNil(ids []bson.ObjectID) []bson.ObjectID {
	if ids == nil {
		return []bson.ObjectID{}
	}
	return ids
}

func (d *Deletion) openRequest(ctx context.Context, userID bson.ObjectID) (*deletionRow, error) {
	var row deletionRow
	err := d.DB.Collection("accountdeletionrequests").FindOne(ctx, bson.D{{Key: "cancelled", Value: false}, {Key: "executed", Value: false}, {Key: "userId", Value: userID}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &row, err
}

type statusOut struct {
	BlockedReason   *string          `json:"blockedReason,omitempty"`
	GraceperiodDays int              `json:"graceperiodDays"`
	HostelNames     []string         `json:"hostelNames"`
	Pathway         string           `json:"pathway"`
	Request         *DeletionRequest `json:"request"`
}

func (d *Deletion) status(c *gin.Context) {
	p, err := d.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	u, err := d.loadUser(c, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	path, blocked, names, err := d.pathway(c, u)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	open, err := d.openRequest(c, u.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := statusOut{BlockedReason: blocked, GraceperiodDays: GraceDays, HostelNames: names, Pathway: path}
	if open != nil {
		s := serialize(*open)
		out.Request = &s
	}
	httpx.OK(c, out, "Account deletion status loaded")
}

type requestOut struct {
	Pathway string           `json:"pathway"`
	Request *DeletionRequest `json:"request"`
	Message string           `json:"message"`
}

func (d *Deletion) request(c *gin.Context) {
	p, err := d.Guards.Require(c)
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
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 10, MinMsg: "Tell us briefly why, in a sentence or two.", Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := d.submit(c, p, reason)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, out.Message)
}

// submit is requestAccountDeletion. The row and the account's closing are one
// transaction: TS wrote them apart, so a failure between left an open request
// on a live account (or a closed account with no request to cancel).
func (d *Deletion) submit(ctx context.Context, p *authz.Principal, reason string) (requestOut, error) {
	u, err := d.loadUser(ctx, p.UserID)
	if err != nil {
		return requestOut{}, err
	}
	path, blocked, names, err := d.pathway(ctx, u)
	if err != nil {
		return requestOut{}, err
	}
	switch path {
	case "BLOCKED":
		return requestOut{}, deletionErr(409, "DELETION_NOT_ALLOWED", *blocked)
	case "GUARDIAN_RELEASE":
		return d.releaseGuardian(ctx, u.ID)
	}
	if open, err := d.openRequest(ctx, u.ID); err != nil {
		return requestOut{}, err
	} else if open != nil {
		return requestOut{}, deletionErr(409, "DELETION_ALREADY_REQUESTED", "A deletion request is already open on this account.")
	}
	now := d.Now().UTC().Truncate(time.Millisecond)
	review := path == "PLATFORM_REVIEW"
	set := bson.D{{Key: "cancelled", Value: false}, {Key: "executed", Value: false}, {Key: "hostelIds", Value: nonNil(u.HostelIDs)},
		{Key: "kind", Value: path}, {Key: "reason", Value: reason}, {Key: "requestedAt", Value: now}, {Key: "requestedEmail", Value: u.Email},
		{Key: "requestedRole", Value: u.Role}, {Key: "updatedAt", Value: now}}
	if u.Name != nil {
		set = append(set, bson.E{Key: "requestedName", Value: *u.Name})
	}
	// A reopened row (cancelled or rejected before) must not carry the old
	// review or cancellation; TS's undefined values left them in place.
	unset := bson.D{{Key: "cancelledAt", Value: ""}, {Key: "executedAt", Value: ""}, {Key: "reviewNote", Value: ""}, {Key: "reviewedAt", Value: ""}, {Key: "reviewedBy", Value: ""}}
	var scheduled time.Time
	if review {
		set = append(set, bson.E{Key: "reviewStatus", Value: "PENDING"})
		unset = append(unset, bson.E{Key: "scheduledDeletionAt", Value: ""})
	} else {
		scheduled = now.Add(GraceDays * 24 * time.Hour)
		set = append(set, bson.E{Key: "scheduledDeletionAt", Value: scheduled})
		unset = append(unset, bson.E{Key: "reviewStatus", Value: ""})
	}
	var row deletionRow
	err = appmongo.InTx(ctx, d.DB, func(ctx context.Context) error {
		err := d.DB.Collection("accountdeletionrequests").FindOneAndUpdate(ctx, bson.D{{Key: "userId", Value: u.ID}},
			bson.D{{Key: "$set", Value: set}, {Key: "$unset", Value: unset}, {Key: "$setOnInsert", Value: bson.D{{Key: "userId", Value: u.ID}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
			options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
		if err != nil || review {
			return err
		}
		return d.closeAccount(ctx, u.ID, now)
	})
	if err != nil {
		return requestOut{}, err
	}
	action := "ACCOUNT_DELETION_REQUESTED"
	if review {
		action = "ACCOUNT_DELETION_SUBMITTED"
	}
	_ = d.Audit.Write(ctx, audit.Entry{ActorID: u.ID, Action: action, EntityType: "User", EntityID: u.ID.Hex()}) // the request stands without its trail, as in TS
	s := serialize(row)
	if review {
		d.notifyPlatform(ctx, u, reason, names)
		return requestOut{path, &s, "Your request has been sent to the platform owner. Your account and hostel stay active until they review it."}, nil
	}
	d.mailScheduled(ctx, u.ID, u.Email, u.Name, scheduled)
	return requestOut{path, &s, "Your account is closed. It will be permanently deleted in 60 days — use the link in your email if you change your mind."}, nil
}

// closeAccount is applyImmediateEffects: login suspended, live tokens and
// sessions dead, phones forgotten.
func (d *Deletion) closeAccount(ctx context.Context, id bson.ObjectID, now time.Time) error {
	if _, err := d.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "status", Value: "SUSPENDED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return err
	}
	if _, err := d.DB.Collection("sessions").UpdateMany(ctx, bson.D{{Key: "revokedAt", Value: nil}, {Key: "userId", Value: id}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: now}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return err
	}
	_, err := d.DB.Collection("devicetokens").DeleteMany(ctx, bson.D{{Key: "userId", Value: id}})
	return err
}

func (d *Deletion) mailScheduled(ctx context.Context, id bson.ObjectID, to string, name *string, at time.Time) {
	if to == "" {
		return
	}
	token, err := d.Tokens.SignPurpose(auth.PurposeInput{UserID: id.Hex(), Purpose: auth.CancelAccountDeletion, TTL: GraceDays * 24 * time.Hour})
	if err != nil {
		return // the account is closed already; a missing mail must not undo it
	}
	n := ""
	if name != nil {
		n = *name
	}
	content := email.AccountDeletionRequested(d.AppURL("/cancel-deletion?token="+httpx.EncodeURIComponent(token)), at.Format("2006-01-02"), n)
	d.Mail.Send(ctx, email.Message{To: []string{to}, Subject: content.Subject, HTML: content.HTML})
}

// releaseGuardian is releaseGuardianRole: the link goes, the person stays.
func (d *Deletion) releaseGuardian(ctx context.Context, id bson.ObjectID) (requestOut, error) {
	now := d.Now().UTC()
	err := appmongo.InTx(ctx, d.DB, func(ctx context.Context) error {
		if _, err := d.DB.Collection("guardianaccesses").UpdateMany(ctx, bson.D{{Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: id}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return err
		}
		_, err := d.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "hostelIds", Value: bson.A{}}, {Key: "role", Value: "PUBLIC"}, {Key: "updatedAt", Value: now}}}})
		return err
	})
	if err != nil {
		return requestOut{}, err
	}
	_ = d.Audit.Write(ctx, audit.Entry{ActorID: id, Action: "GUARDIAN_ACCESS_RELEASED", EntityType: "User", EntityID: id.Hex()})
	return requestOut{Pathway: "GUARDIAN_RELEASE", Message: "Your guardian access has been removed and you no longer see your resident's information. Your account itself is still here as a regular account — you can delete it from this page if you want it gone entirely."}, nil
}

// notifyPlatform tells every active superadmin; failures only cost the
// heads-up, the request is in the queue either way.
func (d *Deletion) notifyPlatform(ctx context.Context, u accountRow, reason string, hostelNames []string) {
	cur, err := d.DB.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "email", Value: 1}}))
	if err != nil {
		return
	}
	var owners []struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
	}
	if cur.All(ctx, &owners) != nil {
		return
	}
	name, who := "", u.Email
	if u.Name != nil {
		name = *u.Name
		if name != "" {
			who = name
		}
	}
	content := email.AccountDeletionReview(hostelNames, d.AppURL("/platform/account-deletions"), reason, u.Email, name, u.Role)
	for _, o := range owners {
		if o.Email != "" {
			d.Mail.Send(ctx, email.Message{To: []string{o.Email}, Subject: content.Subject, HTML: content.HTML})
		}
		_, _ = d.Notify.CreateInApp(ctx, notifications.Input{UserID: o.ID.Hex(), Category: "ACCOUNT_DELETION", Title: "Account deletion request",
			Body: who + " asked for their account to be deleted.", Data: ordered.Map{{Key: "userId", Value: u.ID.Hex()}}})
	}
}

type listOut struct {
	Pagination   pagination.Meta   `json:"pagination"`
	PendingCount int64             `json:"pendingCount"`
	Requests     []DeletionRequest `json:"requests"`
}

func (d *Deletion) list(c *gin.Context) {
	if _, err := d.Guards.RequireSuperadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := valid.Page(q, &is)
	status := valid.QueryEnum(q, "reviewStatus", &is, "PENDING", "APPROVED", "REJECTED")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "kind", Value: "PLATFORM_REVIEW"}}
	if status != nil {
		filter = append(filter, bson.E{Key: "reviewStatus", Value: *status})
	}
	r := pagination.RangeOf(page)
	coll := d.DB.Collection("accountdeletionrequests")
	cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "requestedAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []deletionRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := coll.CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	pending, err := coll.CountDocuments(c, bson.D{{Key: "kind", Value: "PLATFORM_REVIEW"}, {Key: "reviewStatus", Value: "PENDING"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := listOut{Pagination: pagination.MetaOf(page, int(total)), PendingCount: pending, Requests: make([]DeletionRequest, len(rows))}
	for i, row := range rows {
		out.Requests[i] = serialize(row)
	}
	httpx.OK(c, out, "Account deletion requests loaded")
}

func (d *Deletion) review(c *gin.Context) {
	p, err := d.Guards.RequireSuperadmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, deletionErr(422, "INVALID_OBJECT_ID", "Invalid request id."))
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	decision, _ := f.Enum("decision", false, nil, "APPROVED", "REJECTED")
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	reviewer, _ := bson.ObjectIDFromHex(p.UserID)
	approved := decision == "APPROVED"
	now := d.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "cancelled", Value: !approved}, {Key: "reviewStatus", Value: decision}, {Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: reviewer}, {Key: "updatedAt", Value: now}}
	unset := bson.D{}
	if hasNote {
		set = append(set, bson.E{Key: "reviewNote", Value: note})
	} else {
		unset = append(unset, bson.E{Key: "reviewNote", Value: ""})
	}
	var scheduled time.Time
	if approved {
		scheduled = now.Add(GraceDays * 24 * time.Hour)
		set = append(set, bson.E{Key: "scheduledDeletionAt", Value: scheduled})
		unset = append(unset, bson.E{Key: "cancelledAt", Value: ""})
	} else {
		set = append(set, bson.E{Key: "cancelledAt", Value: now})
		unset = append(unset, bson.E{Key: "scheduledDeletionAt", Value: ""})
	}
	update := bson.D{{Key: "$set", Value: set}}
	if len(unset) > 0 {
		update = append(update, bson.E{Key: "$unset", Value: unset})
	}
	coll := d.DB.Collection("accountdeletionrequests")
	var row deletionRow
	err = appmongo.InTx(c, d.DB, func(ctx context.Context) error {
		// PENDING is in the filter, not just checked first: two superadmins
		// answering at once must not both act (TS read, then wrote).
		err := coll.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "kind", Value: "PLATFORM_REVIEW"}, {Key: "reviewStatus", Value: "PENDING"}}, update,
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
		if errors.Is(err, mongo.ErrNoDocuments) {
			n, cerr := coll.CountDocuments(ctx, bson.D{{Key: "_id", Value: id}, {Key: "kind", Value: "PLATFORM_REVIEW"}})
			if cerr != nil {
				return cerr
			}
			if n > 0 {
				return deletionErr(409, "ALREADY_REVIEWED", "This request has already been reviewed.")
			}
			return deletionErr(404, "NOT_FOUND", "Request was not found.")
		}
		if err != nil || !approved {
			return err
		}
		return d.closeAccount(ctx, row.UserID, now)
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	action := "ACCOUNT_DELETION_REJECTED"
	if approved {
		action = "ACCOUNT_DELETION_APPROVED"
	}
	_ = d.Audit.Write(c, audit.Entry{ActorID: reviewer, Action: action, EntityType: "User", EntityID: row.UserID.Hex()})
	if approved {
		var u struct {
			Email string  `bson:"email"`
			Name  *string `bson:"name"`
		}
		if d.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: row.UserID}}).Decode(&u) == nil {
			d.mailScheduled(c, row.UserID, u.Email, u.Name, scheduled)
		}
	}
	msg := "Deletion request declined"
	if approved {
		msg = "Deletion approved — the account is closed and will be erased in 60 days"
	}
	httpx.OK(c, ordered.Map{{Key: "request", Value: serialize(row)}}, msg)
}
