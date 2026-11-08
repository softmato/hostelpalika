package hostels

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// ---- suspension ----

type suspensionRow struct {
	GraceEndsAt *time.Time     `bson:"graceEndsAt"`
	Reason      *string        `bson:"reason"`
	StartedAt   *time.Time     `bson:"startedAt"`
	StartedBy   *bson.ObjectID `bson:"startedBy"`
}

// suspensionOut is serializeSuspension: nil until it has started.
func suspensionOut(s *suspensionRow, now time.Time) ordered.Map {
	if s == nil || s.StartedAt == nil || s.GraceEndsAt == nil || s.StartedAt.After(now) {
		return nil
	}
	stage := "SUSPENDED"
	if now.Before(*s.GraceEndsAt) {
		stage = "PRE_SUSPENSION"
	}
	reason := "PLAN_PAYMENT"
	if s.Reason != nil {
		reason = *s.Reason
	}
	return ordered.Map{{Key: "graceEndsAt", Value: httpx.ISO(*s.GraceEndsAt)}, {Key: "reason", Value: reason}, {Key: "stage", Value: stage}, {Key: "startedAt", Value: httpx.ISO(*s.StartedAt)}}
}

func suspendErr(code, msg string) error { return httpx.NewError(http.StatusConflict, code, msg, nil) }

// suspend is startHostelSuspension: the plan's invoice is raised, the owner gets
// SUSPENSION_GRACE_DAYS to pay, then every portal tied to the hostel stops.
func (p *Platform) suspend(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	reason, _ := f.Enum("reason", false, nil, "PLAN_PAYMENT")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	var h struct {
		Contact struct {
			Email string `bson:"email"`
		} `bson:"contact"`
		Name       *string        `bson:"name"`
		OwnerID    *bson.ObjectID `bson:"ownerId"`
		Parent     *bson.ObjectID `bson:"parentHostelId"`
		Slug       *string        `bson:"slug"`
		Suspension *suspensionRow `bson:"suspension"`
	}
	if err := p.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel not found.", nil)
		}
		httpx.Fail(c, err)
		return
	}
	if h.Parent != nil {
		httpx.Fail(c, suspendErr("BRANCH_FOLLOWS_MAIN", "This is a branch, billed with its main hostel. Suspend the main hostel — its branches follow it."))
		return
	}
	now := p.now()
	if running := suspensionOut(h.Suspension, now); running != nil {
		msg := "This hostel is already in pre-suspension."
		if stage, _ := running.Get("stage"); stage == "SUSPENDED" {
			msg = "This hostel is already suspended."
		}
		httpx.Fail(c, suspendErr("ALREADY_SUSPENDED", msg))
		return
	}
	var sub struct {
		CurrentPeriodEnd *time.Time `bson:"currentPeriodEnd"`
		PlanID           *string    `bson:"planId"`
		Status           string     `bson:"status"`
	}
	if err := p.DB.Collection("hostelsubscriptions").FindOne(c, bson.D{{Key: "hostelId", Value: id}}).Decode(&sub); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	if sub.PlanID == nil || *sub.PlanID == "" {
		httpx.Fail(c, suspendErr("NO_PLAN_SELECTED", "This hostel has not chosen a plan, so there is no plan price to collect."))
		return
	}
	if sub.Status == "ACTIVE" && sub.CurrentPeriodEnd != nil && sub.CurrentPeriodEnd.After(now) {
		httpx.Fail(c, suspendErr("PLAN_PAID", "This hostel's plan is paid for the period it is in. There is nothing to collect."))
		return
	}
	owed, err := p.Settler.PlanOwed(c, id, actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if owed.Outstanding <= 0 {
		httpx.Fail(c, suspendErr("NOTHING_OWED", "Nothing is owed on this hostel's plan."))
		return
	}
	grace := bs.DayEnd(now, suspensionGraceDays)
	record := bson.D{{Key: "graceEndsAt", Value: grace}, {Key: "reason", Value: reason}, {Key: "startedAt", Value: now}, {Key: "startedBy", Value: actor}}
	res, err := p.DB.Collection("hostels").UpdateOne(c, bson.D{{Key: "_id", Value: id}, {Key: "$or", Value: bson.A{bson.D{{Key: "suspension.startedAt", Value: nil}}, bson.D{{Key: "suspension.startedAt", Value: bson.D{{Key: "$gt", Value: now}}}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "suspension", Value: record}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MatchedCount == 0 {
		httpx.Fail(c, suspendErr("ALREADY_SUSPENDED", "This hostel is already in pre-suspension."))
		return
	}
	if _, err := p.DB.Collection("hostels").UpdateMany(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "parentHostelId", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "suspension", Value: record}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	var owner struct {
		Email string `bson:"email"`
		Name  string `bson:"name"`
	}
	if h.OwnerID != nil {
		_ = p.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: *h.OwnerID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&owner)
	}
	to := owner.Email
	if to == "" {
		to = h.Contact.Email
	}
	hostelName, slug := "your hostel", ""
	if h.Name != nil {
		hostelName = *h.Name
	}
	if h.Slug != nil {
		slug = *h.Slug
	}
	// A bill raised a moment ago already went out with its own email and PDF.
	justRaised := !owed.IssuedAt.IsZero() && now.Sub(owed.IssuedAt).Abs() < time.Minute
	notification := ordered.Map{{Key: "reason", Value: "No owner email on file"}, {Key: "sent", Value: false}, {Key: "to", Value: ""}}
	if to != "" {
		var files []email.Attachment
		if !justRaised {
			files = p.Settler.InvoiceAttachment(c, owed.InvoiceNumber, owed.HostelID)
		}
		payURL := p.statusURL()
		if slug != "" {
			payURL = p.Settler.PlanPayLink(c, id, p.billingURL(slug))
		}
		m := email.PlanSuspensionNotice(owed.Outstanding, hostelName, len(files) > 0, owed.InvoiceNumber, owner.Name, email.EmailDate(grace), payURL, owed.PlanName)
		r := p.Mail.Send(c, email.Message{Category: m.Category, To: []string{to}, Subject: m.Subject, HTML: m.HTML, Attachments: files})
		notification = ordered.Map{{Key: "sent", Value: r.Sent}, {Key: "to", Value: to}}
		if !r.Sent {
			notification = ordered.Map{{Key: "reason", Value: r.Reason}, {Key: "sent", Value: false}, {Key: "to", Value: to}}
		}
	}
	sent, _ := notification.Get("sent")
	if err := p.Audit.Write(c, audit.Entry{Action: "HOSTEL_SUSPENSION_STARTED", ActorID: actor, EntityID: id.Hex(), EntityType: "Hostel", HostelID: id,
		Metadata: bson.D{{Key: "emailed", Value: sent}, {Key: "graceEndsAt", Value: grace}, {Key: "invoiceNumber", Value: owed.InvoiceNumber}, {Key: "outstanding", Value: owed.Outstanding}, {Key: "reason", Value: reason}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	p.Cache.PublicChanged(c)
	msg := "Pre-suspension started"
	if sent != true {
		msg = "Pre-suspension started, but the owner could not be emailed"
	}
	httpx.OK(c, ordered.Map{{Key: "notification", Value: notification}, {Key: "suspension", Value: suspensionOut(&suspensionRow{GraceEndsAt: &grace, Reason: &reason, StartedAt: &now, StartedBy: &actor}, now)}}, msg)
}

// liftHostelSuspension: the hostel and its branches open again. False when none was running.
func (p *Platform) liftHostelSuspension(ctx context.Context, id bson.ObjectID, actor *bson.ObjectID, cause string) (bool, error) {
	now := p.now()
	clear := bson.D{{Key: "$set", Value: bson.D{{Key: "suspension.graceEndsAt", Value: nil}, {Key: "suspension.reason", Value: nil}, {Key: "suspension.startedAt", Value: nil}, {Key: "suspension.startedBy", Value: nil}, {Key: "updatedAt", Value: now}}}}
	var before struct {
		Suspension *suspensionRow `bson:"suspension"`
	}
	err := p.DB.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "suspension.startedAt", Value: bson.D{{Key: "$ne", Value: nil}}}}, clear,
		options.FindOneAndUpdate().SetProjection(bson.D{{Key: "suspension", Value: 1}})).Decode(&before)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := p.DB.Collection("hostels").UpdateMany(ctx, bson.D{{Key: "parentHostelId", Value: id}}, clear); err != nil {
		return false, err
	}
	s := before.Suspension
	var grace, reason, started any
	stage := any(nil)
	if s != nil {
		if s.GraceEndsAt != nil {
			grace = *s.GraceEndsAt
		}
		if s.Reason != nil {
			reason = *s.Reason
		}
		if s.StartedAt != nil {
			started = *s.StartedAt
		}
		if out := suspensionOut(s, now); out != nil {
			stage, _ = out.Get("stage")
		}
	}
	entry := audit.Entry{Action: "HOSTEL_SUSPENSION_LIFTED", ActorType: "SYSTEM", EntityID: id.Hex(), EntityType: "Hostel", HostelID: id,
		Metadata: bson.D{{Key: "cause", Value: cause}, {Key: "graceEndsAt", Value: grace}, {Key: "reason", Value: reason}, {Key: "stage", Value: stage}, {Key: "startedAt", Value: started}}}
	if actor != nil {
		entry.ActorID, entry.ActorType = *actor, "USER"
	}
	p.Cache.PublicChanged(ctx)
	return true, p.Audit.Write(ctx, entry)
}

func (p *Platform) liftSuspension(c *gin.Context) {
	_, actor := actorOf(c)
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel not found.", nil))
		return
	}
	lifted, err := p.liftHostelSuspension(c, id, &actor, "LIFTED")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !lifted {
		httpx.Fail(c, suspendErr("NOT_SUSPENDED", "This hostel is not suspended."))
		return
	}
	httpx.OK(c, ordered.Map{{Key: "lifted", Value: true}}, "Suspension lifted")
}

// ---- recharge, billing, agreement, duplicate check ----

func (p *Platform) recharge(c *gin.Context) {
	_, actor := actorOf(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	months, _ := f.Num("months", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(12)})
	planID, _ := f.Str("planId", valid.S{Trim: true, Min: 1})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	end, name, err := p.Settler.Recharge(c, id, planID, int(months), actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// Recharged means paid up, so a running suspension has no reason left.
	if _, err := p.liftHostelSuspension(c, id, &actor, "LIFTED"); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "currentPeriodEnd", Value: httpx.ISO(end)}, {Key: "planName", Value: name}}, "Plan recharged")
}

func (p *Platform) billingHistory(c *gin.Context) {
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	h, err := p.Settler.History(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, h, "Hostel billing loaded")
}

func (p *Platform) agreement(c *gin.Context) {
	id, idErr := bson.ObjectIDFromHex(c.Param("id"))
	if c.Query("format") != "pdf" {
		if idErr != nil {
			httpx.Fail(c, hostelErr404())
			return
		}
		r, err := p.signatureOf(c, id)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if r == nil {
			httpx.OK(c, ordered.Map{{Key: "agreement", Value: nil}}, "Agreement")
			return
		}
		var sent struct {
			SentTo string `bson:"sentTo"`
		}
		_ = p.DB.Collection("hostelagreementsignatures").FindOne(c, bson.D{{Key: "hostelId", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "sentTo", Value: 1}})).Decode(&sent)
		var issued, ref, sentAt any
		if r.IssuedAt != nil {
			issued = httpx.ISO(*r.IssuedAt)
		}
		if r.RefCode != nil {
			ref = *r.RefCode
		}
		if r.SentAt != nil {
			sentAt = httpx.ISO(*r.SentAt)
		}
		httpx.OK(c, ordered.Map{{Key: "agreement", Value: ordered.Map{{Key: "issuedAt", Value: issued}, {Key: "refCode", Value: ref}, {Key: "sentAt", Value: sentAt}, {Key: "sentTo", Value: sent.SentTo},
			{Key: "signature", Value: r.Signature}, {Key: "signedAt", Value: httpx.ISO(r.SignedAt)}, {Key: "signerName", Value: r.SignerName}}}}, "Agreement")
		return
	}
	var r *signatureRecord
	if idErr == nil {
		var err error
		if r, err = p.signatureOf(c, id); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if r == nil {
		c.JSON(http.StatusNotFound, ordered.Map{{Key: "message", Value: "This hostel has not signed the agreement yet."}, {Key: "success", Value: false}})
		return
	}
	pdf, err := p.renderSignature(c, r)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Disposition", `inline; filename="`+pdf.Filename+`"`)
	c.Data(http.StatusOK, "application/pdf", pdf.Content)
}

func (p *Platform) duplicateCheck(c *gin.Context) {
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "INVALID_OBJECT_ID", "Invalid hostel id.", nil))
		return
	}
	out, err := p.DuplicateCheck(c, id, authz.From(c).UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Duplicate check completed")
}

// ---- owner email and invite ----

var googleMail = regexp.MustCompile(`@(gmail|googlemail)\.com$`)

func (p *Platform) ownerEmail(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	addr, _ := f.Email("email", false, "Enter a valid email address.")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	addr = strings.ToLower(strings.TrimSpace(addr))
	h, err := p.findHostel(c, id, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hd := hostelDoc{h}
	ownerID, _ := hd.oid("ownerId")
	var owner struct {
		ID         bson.ObjectID `bson:"_id"`
		Email      string        `bson:"email"`
		MustChange bool          `bson:"mustChangePassword"`
		Name       string        `bson:"name"`
	}
	if err := p.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: ownerID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&owner); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = httpx.NewError(http.StatusNotFound, "HOSTEL_OWNER_NOT_FOUND", "This hostel has no owner account.", nil)
		}
		httpx.Fail(c, err)
		return
	}
	if owner.Email == addr {
		httpx.OK(c, ordered.Map{{Key: "changed", Value: false}, {Key: "email", Value: addr}, {Key: "ownerId", Value: owner.ID.Hex()}}, "Owner email unchanged")
		return
	}
	var holder struct {
		ID   bson.ObjectID `bson:"_id"`
		Role string        `bson:"role"`
	}
	err = p.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: owner.ID}}}, {Key: "email", Value: addr}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&holder)
	if err == nil {
		out, err := p.handOwnership(c, id, hd.str("name"), owner.ID, holder.ID, holder.Role, addr, actor)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out, "Owner email updated")
		return
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	now := p.now()
	unset := bson.D{{Key: "googleId", Value: ""}}
	if owner.MustChange {
		unset = append(unset, bson.E{Key: "passwordHash", Value: ""})
	}
	if _, err := p.DB.Collection("users").UpdateOne(c, bson.D{{Key: "_id", Value: owner.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}},
		{Key: "$set", Value: bson.D{{Key: "email", Value: addr}, {Key: "emailVerified", Value: false}, {Key: "updatedAt", Value: now}}}, {Key: "$unset", Value: unset}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := p.endOwnerSessions(c, owner.ID, now); err != nil {
		httpx.Fail(c, err)
		return
	}
	if owner.Email != "" {
		if _, err := p.DB.Collection("hostels").UpdateMany(c, bson.D{{Key: "contact.email", Value: owner.Email}, {Key: "ownerId", Value: owner.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "contact.email", Value: addr}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if err := p.auditHostel(c, actor, id, "HOSTEL_OWNER_EMAIL_CHANGED", bson.D{{Key: "from", Value: owner.Email}, {Key: "ownerId", Value: owner.ID.Hex()}, {Key: "to", Value: addr}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	notification, err := p.mailEmailChange(c, hd.str("name"), owner.Email, addr, owner.ID, "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "changed", Value: true}, {Key: "email", Value: addr}, {Key: "notification", Value: notification}, {Key: "ownerId", Value: owner.ID.Hex()}}, "Owner email updated")
}

// endOwnerSessions: the old inbox may hold a link or a password, so every way in goes.
func (p *Platform) endOwnerSessions(ctx context.Context, user bson.ObjectID, now time.Time) error {
	if _, err := p.DB.Collection("oauthaccounts").DeleteMany(ctx, bson.D{{Key: "userId", Value: user}}); err != nil {
		return err
	}
	_, err := p.DB.Collection("sessions").UpdateMany(ctx, bson.D{{Key: "revokedAt", Value: nil}, {Key: "userId", Value: user}}, bson.D{{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: now}, {Key: "updatedAt", Value: now}}}})
	return err
}

// mailEmailChange is mailOwnerEmailChange: a login for the new inbox, a notice for the old one.
func (p *Platform) mailEmailChange(ctx context.Context, hostelName, previous, next string, user bson.ObjectID, rotated string) (ordered.Map, error) {
	var acct struct {
		GoogleID string `bson:"googleId"`
	}
	_ = p.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: user}}, options.FindOne().SetProjection(bson.D{{Key: "googleId", Value: 1}})).Decode(&acct)
	google := googleMail.MatchString(next) || acct.GoogleID != ""
	pass := ""
	if !google {
		pass = rotated
		if pass == "" {
			_, issued, _, err := users.TemporaryPasswordIfMissing(ctx, p.DB, user)
			if err != nil {
				return nil, err
			}
			pass = issued
		}
	}
	m := email.OwnerEmailChanged(hostelName, p.loginURL(), next, previous, false, google, pass)
	r := p.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{next}, Subject: m.Subject, HTML: m.HTML})
	if previous != "" {
		old := email.OwnerEmailChanged(hostelName, p.loginURL(), next, previous, true, false, "")
		p.Mail.Send(ctx, email.Message{Category: old.Category, To: []string{previous}, Subject: old.Subject, HTML: old.HTML})
	}
	out := ordered.Map{{Key: "google", Value: google}, {Key: "loginIssued", Value: pass != ""}}
	if !r.Sent {
		out = append(out, ordered.Pair{Key: "reason", Value: r.Reason})
	}
	return append(out, ordered.Pair{Key: "sent", Value: r.Sent}, ordered.Pair{Key: "to", Value: next}), nil
}

// handOwnership is handOwnershipToExistingAccount: the address already has an
// account, so the hostels move to it and the placeholder owner is retired.
func (p *Platform) handOwnership(ctx context.Context, hostelID bson.ObjectID, hostelName string, previousID, holderID bson.ObjectID, holderRole, addr string, actor bson.ObjectID) (ordered.Map, error) {
	if holderRole != "PUBLIC" && holderRole != "HOSTEL_ADMIN" {
		return nil, httpx.NewError(http.StatusConflict, "HOSTEL_OWNER_CONTACT_CONFLICT",
			"This email already signs in as a "+strings.ReplaceAll(strings.ToLower(holderRole), "_", " ")+", so it can't own a hostel. Use another email.", nil)
	}
	var prev struct {
		Email       string          `bson:"email"`
		HostelIDs   []bson.ObjectID `bson:"hostelIds"`
		LastLoginAt *time.Time      `bson:"lastLoginAt"`
		Role        string          `bson:"role"`
	}
	if err := p.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: previousID}}).Decode(&prev); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	cur, err := p.DB.Collection("hostels").Find(ctx, bson.D{{Key: "ownerId", Value: previousID}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var owned []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
	}
	if err := cur.All(ctx, &owned); err != nil {
		return nil, err
	}
	ids, names := bson.A{}, []string{}
	for _, h := range owned {
		ids, names = append(ids, h.ID), append(names, h.Name)
	}
	rotated := ""
	if prev.Role == "HOSTEL_ADMIN" && len(prev.HostelIDs) > 0 {
		issued, err := p.Issuer.RegisterOrUpgrade(ctx, users.IssueInput{Email: addr, HostelID: prev.HostelIDs[0].Hex(), PerformedBy: actor.Hex(), Role: "HOSTEL_ADMIN", NoEmail: true, UserID: holderID.Hex()})
		if err != nil {
			return nil, err
		}
		rotated = issued.TemporaryPassword
		each := bson.A{}
		for _, h := range prev.HostelIDs {
			each = append(each, h)
		}
		if _, err := p.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: holderID}}, bson.D{{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: bson.D{{Key: "$each", Value: each}}}}}}); err != nil {
			return nil, err
		}
	}
	if _, err := p.DB.Collection("hostels").UpdateMany(ctx, bson.D{{Key: "ownerId", Value: previousID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "ownerId", Value: holderID}}}}); err != nil {
		return nil, err
	}
	if prev.Email != "" {
		if _, err := p.DB.Collection("hostels").UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "contact.email", Value: prev.Email}}, bson.D{{Key: "$set", Value: bson.D{{Key: "contact.email", Value: addr}}}}); err != nil {
			return nil, err
		}
	}
	if _, err := p.DB.Collection("hostelapplications").UpdateMany(ctx, bson.D{{Key: "applicantId", Value: previousID}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "applicantId", Value: holderID}}}}); err != nil {
		return nil, err
	}
	dcur, err := p.DB.Collection("hosteldocuments").Find(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "ownerId", Value: previousID}}, options.Find().SetProjection(bson.D{{Key: "fileAssetId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var docs []struct {
		Asset *bson.ObjectID `bson:"fileAssetId"`
	}
	if err := dcur.All(ctx, &docs); err != nil {
		return nil, err
	}
	assets := bson.A{}
	for _, d := range docs {
		if d.Asset != nil {
			assets = append(assets, *d.Asset)
		}
	}
	if _, err := p.DB.Collection("hosteldocuments").UpdateMany(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "ownerId", Value: previousID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "ownerId", Value: holderID}}}}); err != nil {
		return nil, err
	}
	if len(assets) > 0 {
		if _, err := p.DB.Collection("fileassets").UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: assets}}}, {Key: "ownerId", Value: previousID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "ownerId", Value: holderID}}}}); err != nil {
			return nil, err
		}
	}
	sessions, err := p.DB.Collection("sessions").CountDocuments(ctx, bson.D{{Key: "userId", Value: previousID}}, options.Count().SetLimit(1))
	if err != nil {
		return nil, err
	}
	neverUsed := prev.LastLoginAt == nil && sessions == 0
	now := p.now()
	set := bson.D{{Key: "hostelIds", Value: bson.A{}}, {Key: "role", Value: "PUBLIC"}}
	if neverUsed {
		set = append(set, bson.E{Key: "deletedAt", Value: now}, bson.E{Key: "deletedBy", Value: actor}, bson.E{Key: "isDeleted", Value: true})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	if _, err := p.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: previousID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}}, {Key: "$set", Value: set},
		{Key: "$unset", Value: bson.D{{Key: "googleId", Value: ""}, {Key: "mustChangePassword", Value: ""}, {Key: "passwordHash", Value: ""}}}}); err != nil {
		return nil, err
	}
	if err := p.endOwnerSessions(ctx, previousID, now); err != nil {
		return nil, err
	}
	if err := p.auditHostel(ctx, actor, hostelID, "HOSTEL_OWNER_EMAIL_CHANGED", bson.D{{Key: "from", Value: prev.Email}, {Key: "hostels", Value: names}, {Key: "movedToExistingAccount", Value: holderID.Hex()},
		{Key: "ownerId", Value: previousID.Hex()}, {Key: "previousAccountRetired", Value: neverUsed}, {Key: "to", Value: addr}}); err != nil {
		return nil, err
	}
	notification, err := p.mailEmailChange(ctx, hostelName, prev.Email, addr, holderID, rotated)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "changed", Value: true}, {Key: "email", Value: addr}, {Key: "notification", Value: notification}, {Key: "ownerId", Value: holderID.Hex()}}, nil
}

func (p *Platform) ownerInvite(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	h, err := p.findHostel(c, id, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hd := hostelDoc{h}
	ownerID, _ := hd.oid("ownerId")
	var owner struct {
		ID           bson.ObjectID `bson:"_id"`
		Email        string        `bson:"email"`
		MustChange   bool          `bson:"mustChangePassword"`
		PasswordHash string        `bson:"passwordHash"`
	}
	err = p.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: ownerID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&owner)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	if owner.Email == "" {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "HOSTEL_OWNER_NOT_FOUND", "The owner has no email yet. Add one first.", nil))
		return
	}
	if owner.PasswordHash != "" && !owner.MustChange {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "HOSTEL_OWNER_ALREADY_CLAIMED", "The owner has already set their own password. They can sign in, or use Forgot password.", nil))
		return
	}
	if _, err := p.DB.Collection("users").UpdateOne(c, bson.D{{Key: "_id", Value: owner.ID}}, bson.D{{Key: "$unset", Value: bson.D{{Key: "passwordHash", Value: ""}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	_, pass, ok2, err := users.TemporaryPasswordIfMissing(c, p.DB, owner.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !ok2 || pass == "" {
		httpx.Fail(c, httpx.NewError(http.StatusInternalServerError, "HOSTEL_ERROR", "Could not issue a login.", nil))
		return
	}
	m := email.HostelApproved(hd.str("name"), p.loginURL(), &email.Credentials{Email: owner.Email, TemporaryPassword: pass}, nil)
	r := p.Mail.Send(c, email.Message{Category: m.Category, To: []string{owner.Email}, Subject: m.Subject, HTML: m.HTML})
	if err := p.auditHostel(c, actor, id, "HOSTEL_OWNER_INVITE_SENT", bson.D{{Key: "ownerId", Value: owner.ID.Hex()}, {Key: "sent", Value: r.Sent}, {Key: "to", Value: owner.Email}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	notification := ordered.Map{{Key: "sent", Value: r.Sent}, {Key: "to", Value: owner.Email}}
	if !r.Sent {
		notification = ordered.Map{{Key: "reason", Value: r.Reason}, {Key: "sent", Value: false}, {Key: "to", Value: owner.Email}}
	}
	httpx.OK(c, ordered.Map{{Key: "notification", Value: notification}}, "Owner invite sent")
}
