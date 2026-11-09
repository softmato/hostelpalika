package hostels

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// suspensionGraceDays is SUSPENSION_GRACE_DAYS: the pre-suspension countdown.
const suspensionGraceDays = 3

// ---- create ----

// create is createPlatformHostelApplication: a platform admin files a hostel for
// an existing owner account; it waits in the queue like a public one.
func (p *Platform) create(c *gin.Context) {
	_, actor := actorOf(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var in Reg
	parseCreateBase(f, &in, false, true)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	owner, _ := bson.ObjectIDFromHex(in.OwnerHex)
	// TS created the hostel for any id, owner or not (P7-17).
	if n, err := p.DB.Collection("users").CountDocuments(c, bson.D{{Key: "_id", Value: owner}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}); err != nil {
		httpx.Fail(c, err)
		return
	} else if n == 0 {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "OWNER_NOT_FOUND", "That owner account was not found.", nil))
		return
	}
	claimed, err := p.Claims.Claim(c, p.DB, in.Documents, owner)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	slug, err := UniqueSlug(c, p.DB, in.Name, in.LocArea)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := p.now()
	hostelID, appID := bson.NewObjectID(), bson.NewObjectID()
	fields := hostelFields(in, owner, slug, nil, "PENDING_APPROVAL", "PENDING")
	for i := range fields {
		if fields[i].Key == "createdBy" || fields[i].Key == "updatedBy" {
			fields[i].Value = actor
		}
	}
	err = appmongo.InTx(c, p.DB, func(ctx context.Context) error {
		if _, err := p.DB.Collection("hostels").InsertOne(ctx, NewHostelDoc(hostelID, fields, now)); err != nil {
			return err
		}
		snapshot := bson.D{}
		if len(in.Contact) > 0 {
			snapshot = append(snapshot, bson.E{Key: "contact", Value: in.Contact})
		}
		snapshot = append(snapshot, bson.E{Key: "location", Value: in.Location}, bson.E{Key: "name", Value: in.Name})
		app := bson.D{{Key: "_id", Value: appID}, {Key: "hostelId", Value: hostelID}, {Key: "applicantId", Value: owner}, {Key: "submittedBy", Value: actor}, {Key: "status", Value: "PENDING"},
			{Key: "source", Value: "PUBLIC"}, {Key: "submittedByAgentId", Value: nil}, {Key: "requestedDocuments", Value: bson.A{}}}
		if in.Notes != nil {
			app = append(app, bson.E{Key: "notes", Value: *in.Notes})
		}
		app = append(app, bson.E{Key: "snapshot", Value: snapshot}, bson.E{Key: "isDeleted", Value: false}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		if _, err := p.DB.Collection("hostelapplications").InsertOne(ctx, app); err != nil {
			return err
		}
		if _, err := p.DB.Collection("hostelverifications").InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "status", Value: "PENDING"},
			{Key: "checklist", Value: bson.A{}}, {Key: "createdBy", Value: actor}, {Key: "updatedBy", Value: actor}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
			return err
		}
		if len(claimed) == 0 {
			return nil
		}
		rows := make([]any, 0, len(claimed))
		for _, d := range claimed {
			rows = append(rows, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "ownerId", Value: owner}, {Key: "documentType", Value: d.DocumentType},
				{Key: "fileAssetId", Value: d.FileAssetID}, {Key: "status", Value: "PENDING"}, {Key: "createdBy", Value: actor}, {Key: "updatedBy", Value: actor},
				{Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		}
		_, err := p.DB.Collection("hosteldocuments").InsertMany(ctx, rows)
		return err
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := p.auditHostel(c, actor, hostelID, "HOSTEL_APPLICATION_CREATED", bson.D{{Key: "ownerId", Value: owner.Hex()}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	h, err := p.findHostel(c, hostelID, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a, err := p.DB.Collection("hostelapplications").FindOne(c, bson.D{{Key: "_id", Value: appID}}).Raw()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, ordered.Map{{Key: "application", Value: applicationOut(a)}, {Key: "hostel", Value: p.serialize(h)}}, "Hostel application created")
}

// setStatus is updateHostelStatus.
func (p *Platform) setStatus(ctx context.Context, id, actor bson.ObjectID, status, action, verification string, meta bson.D) (ordered.Map, error) {
	set := bson.D{{Key: "status", Value: status}, {Key: "updatedBy", Value: actor}}
	if verification != "" {
		set = append(set, bson.E{Key: "verificationStatus", Value: verification})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: p.now()})
	h, err := p.DB.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}, bson.D{{Key: "$set", Value: set}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, hostelErr404()
	}
	if err != nil {
		return nil, err
	}
	if err := p.auditHostel(ctx, actor, id, action, meta); err != nil {
		return nil, err
	}
	p.Cache.PublicChanged(ctx)
	return ordered.Map{{Key: "hostel", Value: p.serialize(h)}}, nil
}

// ---- approve ----

func (p *Platform) approve(c *gin.Context) {
	pr, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	out, err := p.approveHostel(c, id, actor, string(pr.Role))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Hostel approved")
}

func (p *Platform) approveHostel(ctx context.Context, id, actor bson.ObjectID, role string) (ordered.Map, error) {
	var branch struct {
		Parent *bson.ObjectID `bson:"parentHostelId"`
		KYC    *struct {
			Required bool    `bson:"required"`
			Status   *string `bson:"status"`
		} `bson:"kyc"`
		Pricing bson.Raw `bson:"pricing"`
		Rooms   []struct {
			RoomType    *string  `bson:"roomType"`
			MonthlyRent *float64 `bson:"monthlyRent"`
		} `bson:"roomConfigurations"`
	}
	if err := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&branch); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if branch.Parent != nil && role != "SUPERADMIN" {
		return nil, httpx.NewError(http.StatusForbidden, "BRANCH_NEEDS_SUPERADMIN", "Only a superadmin approves a branch, after calling it.", nil)
	}
	kycRequired := branch.KYC != nil && branch.KYC.Required
	if kycRequired && (branch.KYC.Status == nil || *branch.KYC.Status != "APPROVED") {
		n, err := p.DB.Collection("hostelagreementsignatures").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: id}}, options.Count().SetLimit(1))
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, httpx.NewError(http.StatusConflict, "AGREEMENT_NOT_SIGNED", "The owner has not signed the service agreement yet. It is the last step of their KYC.", nil)
		}
	}
	result, err := p.setStatus(ctx, id, actor, "APPROVED", "HOSTEL_APPROVED", "VERIFIED", nil)
	if err != nil {
		return nil, err
	}
	now := p.now()
	if _, err := p.DB.Collection("hostelapplications").UpdateMany(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: "APPROVED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	if _, err := p.DB.Collection("hostelverifications").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: id}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VERIFIED"}, {Key: "updatedBy", Value: actor}, {Key: "verifiedAt", Value: now}, {Key: "verifiedBy", Value: actor}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "checklist", Value: bson.A{}}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return nil, err
	}
	if _, err := p.DB.Collection("hosteldocuments").UpdateMany(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: "APPROVED"}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	p.placeOnMap(ctx, id)
	if kycRequired {
		if err := p.completeKyc(ctx, id, actor); err != nil {
			return nil, err
		}
		h, err := p.findHostel(ctx, id, false)
		if err != nil {
			return nil, err
		}
		return ordered.Map{{Key: "hostel", Value: p.serialize(h)}}, nil
	}
	if branch.Parent != nil {
		if _, err := p.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "PUBLISHED"}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: p.now()}}}}); err != nil {
			return nil, err
		}
		if err := p.GrantOwnerAccess(ctx, id, actor.Hex()); err != nil {
			return nil, err
		}
		var admission, form *float64
		if branch.Pricing != nil {
			if v, ok := branch.Pricing.Lookup("admissionFee").AsFloat64OK(); ok {
				admission = &v
			}
			if v, ok := branch.Pricing.Lookup("formFee").AsFloat64OK(); ok {
				form = &v
			}
		}
		var rates []OpeningRate
		for _, r := range branch.Rooms {
			if r.RoomType != nil && strings.TrimSpace(*r.RoomType) != "" && r.MonthlyRent != nil && *r.MonthlyRent > 0 {
				rates = append(rates, OpeningRate{RoomType: strings.TrimSpace(*r.RoomType), Monthly: jsRound(*r.MonthlyRent)})
			}
		}
		if len(rates) > 0 && p.SeedRateCard != nil {
			num := func(v *float64) int64 {
				if v == nil {
					return 0
				}
				return jsRound(*v)
			}
			if err := p.SeedRateCard(ctx, id, num(admission), num(form), 0, 0, rates, actor.Hex()); err != nil {
				slog.WarnContext(ctx, "registration_rate_card_skipped", "hostelId", id.Hex(), "reason", err.Error())
			}
		}
		return result, nil
	}
	free, err := p.Settler.StartFreeMonths(ctx, id, &actor, time.Now())
	if err != nil {
		return nil, err
	}
	var sub struct {
		PlanName *string `bson:"planName"`
		Source   string  `bson:"source"`
		Status   string  `bson:"status"`
	}
	if err := p.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}).Decode(&sub); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	portalNow := sub.Source == "TEAM" || sub.Status == "ACTIVE"
	if portalNow {
		if err := p.GrantOwnerAccess(ctx, id, actor.Hex()); err != nil {
			return nil, err
		}
	}
	o, err := p.resolveOwner(ctx, id)
	if err != nil {
		return nil, err
	}
	if o != nil {
		var creds *email.Credentials
		if !portalNow {
			_, pass, ok, err := users.TemporaryPasswordIfMissing(ctx, p.DB, o.ID)
			if err != nil {
				return nil, err
			}
			if ok && pass != "" {
				creds = &email.Credentials{Email: o.Email, TemporaryPassword: pass}
			}
		}
		var ft *email.FreeTime
		if free != nil {
			ft = &email.FreeTime{Days: free.TrialDays, Months: free.FreeMonths, Until: email.EmailDate(free.FreeUntil)}
		}
		m := email.HostelVerified(creds, ft, p.supportPhone(ctx), o.HostelName, o.Name, !portalNow, sub.PlanName, p.statusURL())
		p.Mail.Notify(ctx, email.Notification{Action: "hostel_verified", To: o.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
	}
	p.Cache.PublicChanged(ctx)
	return result, nil
}

func (p *Platform) supportPhone(ctx context.Context) string {
	raw, err := p.Config.Section(ctx, "identity")
	if err != nil {
		return ""
	}
	var id struct {
		SupportPhone string `json:"supportPhone"`
	}
	_ = platformconfig.Decode(raw, &id)
	return id.SupportPhone
}

func (p *Platform) placeOnMap(ctx context.Context, id bson.ObjectID) {
	var row profileRow
	if err := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&row); err == nil {
		p.refreshGeo(ctx, id, &row)
	}
}

// completeKyc is completeKycApproval: the hostel goes live with the Verified badge,
// the agreement is issued and mailed, and the kitchen gets its login.
func (p *Platform) completeKyc(ctx context.Context, id, actor bson.ObjectID) error {
	now := p.now()
	if _, err := p.DB.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "kyc.note", Value: nil}, {Key: "kyc.reviewedAt", Value: now},
		{Key: "kyc.reviewedBy", Value: actor}, {Key: "kyc.status", Value: "APPROVED"}, {Key: "status", Value: "PUBLISHED"}, {Key: "updatedBy", Value: actor}, {Key: "verificationStatus", Value: "VERIFIED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return err
	}
	var sub struct {
		PlanID      *string    `bson:"planId"`
		TrialEndsAt *time.Time `bson:"trialEndsAt"`
	}
	if err := p.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}).Decode(&sub); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	trialEnded := sub.TrialEndsAt != nil && sub.TrialEndsAt.Before(now)
	// An unpaid trial ends on the free tier's caps (billing.capsFor), never a suspension.
	if p.Settler.GoLive != nil {
		if err := p.Settler.GoLive(ctx, id); err != nil {
			slog.ErrorContext(ctx, "hostel_referral_settle_failed", "hostelId", id.Hex(), "message", err.Error())
		}
	}
	cook := p.provisionCook(ctx, id, actor)
	o, err := p.resolveOwner(ctx, id)
	if err != nil || o == nil {
		return err
	}
	slug := hostelDoc{p.rawHostel(ctx, id)}.str("slug")
	attachment, ref, err := p.IssueAgreement(ctx, id, actor.Hex())
	if err != nil {
		slog.ErrorContext(ctx, "hostel_agreement_issue_failed", "hostelId", id.Hex(), "message", err.Error())
		attachment, ref = nil, ""
	}
	trialOn := ""
	if sub.TrialEndsAt != nil {
		trialOn = email.EmailDate(*sub.TrialEndsAt)
	}
	var cookCreds *email.Credentials
	if cook != nil {
		cookCreds = &email.Credentials{Email: cook.Email, TemporaryPassword: cook.TemporaryPassword}
	}
	m := email.HostelKycApproved(ref, cookCreds, o.HostelName, p.listing(slug), o.Name, p.Settler.PlanPayLink(ctx, id, p.billingURL(slug)), p.supportPhone(ctx), trialEnded, trialOn)
	msg := email.Message{Category: m.Category, To: []string{o.Email}, Subject: m.Subject, HTML: m.HTML}
	if attachment != nil {
		msg.Attachments = []email.Attachment{*attachment}
	}
	if r := p.Mail.Send(ctx, msg); attachment != nil && r.Sent {
		if _, err := p.DB.Collection("hostelagreementsignatures").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: id}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "sentAt", Value: p.now()}, {Key: "sentTo", Value: o.Email}, {Key: "updatedAt", Value: p.now()}}}}); err != nil {
			return err
		}
	}
	body := "Every feature of the app is open now, and your hostel is live with the Verified badge."
	if trialEnded {
		body = "Every feature is open and your hostel is live. Your free trial has ended — check your email to choose your plan."
	}
	p.bell(ctx, o.ID, id, "/hostel-admin", body, "Your KYC is verified", "HOSTEL_KYC_APPROVED")
	p.Cache.PublicChanged(ctx)
	if p.SendIDCard != nil {
		p.SendIDCard(ctx, o.ID, "HOSTEL_OWNER")
	}
	return nil
}

func (p *Platform) rawHostel(ctx context.Context, id bson.ObjectID) bson.Raw {
	raw, _ := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Raw()
	return raw
}

// provisionCook is provisionApprovalCookAccount: never fails the approval.
func (p *Platform) provisionCook(ctx context.Context, id, actor bson.ObjectID) *email.CookLogin {
	if p.ProvisionCook == nil {
		return nil
	}
	cook, err := p.ProvisionCook(ctx, id, actor)
	if err != nil {
		slog.WarnContext(ctx, "approval_cook_provisioning_failed", "hostelId", id.Hex(), "message", err.Error())
		return nil
	}
	if err := p.auditHostelEntity(ctx, actor, id, "COOK_PORTAL_ENABLED", "HostelSettings", bson.D{{Key: "cookName", Value: cook.CookName}, {Key: "issuedAt", Value: "hostel_approval"}}); err != nil {
		slog.WarnContext(ctx, "approval_cook_provisioning_failed", "hostelId", id.Hex(), "message", err.Error())
	}
	return cook
}

// GrantOwnerAccess is grantHostelOwnerAccess: a PUBLIC owner becomes the hostel's
// admin, with credentials (and the kitchen's) by email, and their ID card reissued.
func (p *Platform) GrantOwnerAccess(ctx context.Context, hostel bson.ObjectID, actorID string) error {
	o, err := p.resolveOwner(ctx, hostel)
	if err != nil || o == nil {
		return err
	}
	if o.Role == "HOSTEL_ADMIN" && containsID(o.HostelIDs, hostel) {
		return nil
	}
	actor, err := bson.ObjectIDFromHex(actorID)
	if err != nil {
		actor = o.ID
	}
	cook := p.provisionCook(ctx, hostel, actor)
	issued, err := p.Issuer.RegisterOrUpgrade(ctx, users.IssueInput{Email: o.Email, HostelID: hostel.Hex(), HostelName: o.HostelName, Name: o.Name, PerformedBy: actor.Hex(), Role: "HOSTEL_ADMIN", NoEmail: true})
	if err != nil {
		return err
	}
	if _, err := p.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: o.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "emailVerified", Value: true}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedAt", Value: p.now()}}}}); err != nil {
		return err
	}
	var creds *email.Credentials
	if issued.TemporaryPassword != "" {
		creds = &email.Credentials{Email: o.Email, TemporaryPassword: issued.TemporaryPassword}
	}
	m := email.HostelApproved(o.HostelName, p.loginURL(), creds, cook)
	p.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{o.Email}, Subject: m.Subject, HTML: m.HTML})
	if p.SendIDCard != nil {
		p.SendIDCard(ctx, o.ID, "HOSTEL_OWNER")
	}
	return nil
}

func (p *Platform) auditHostelEntity(ctx context.Context, actor, hostel bson.ObjectID, action, entity string, meta bson.D) error {
	return p.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: hostel.Hex(), EntityType: entity, HostelID: hostel, Metadata: meta})
}

// ---- reject, request documents ----

func reasonBody(c *gin.Context) (string, bool) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return "", false
	}
	f := valid.NewForm(body)
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return "", false
	}
	return reason, true
}

func (p *Platform) reject(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	reason, ok := reasonBody(c)
	if !ok {
		return
	}
	if back, err := p.sendBackKyc(c, id, reason, actor); err != nil || back != nil {
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		hostel, _ := back.Get("hostel")
		httpx.OK(c, ordered.Map{{Key: "hostel", Value: hostel}}, "Hostel rejected")
		return
	}
	result, err := p.setStatus(c, id, actor, "REJECTED", "HOSTEL_REJECTED", "REJECTED", bson.D{{Key: "reason", Value: reason}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := p.now()
	if _, err := p.DB.Collection("hostelapplications").UpdateMany(c, bson.D{{Key: "hostelId", Value: id}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "rejectionReason", Value: reason}, {Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: "REJECTED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := p.upsertVerification(c, id, bson.D{{Key: "notes", Value: reason}, {Key: "status", Value: "REJECTED"}, {Key: "updatedBy", Value: actor}, {Key: "verifiedBy", Value: actor}}, actor); err != nil {
		httpx.Fail(c, err)
		return
	}
	if o, err := p.resolveOwner(c, id); err == nil && o != nil {
		m := email.HostelRejected(o.HostelName, reason)
		p.Mail.Send(c, email.Message{Category: m.Category, To: []string{o.Email}, Subject: m.Subject, HTML: m.HTML})
	}
	httpx.OK(c, result, "Hostel rejected")
}

func (p *Platform) upsertVerification(ctx context.Context, id bson.ObjectID, set bson.D, actor bson.ObjectID) error {
	now := p.now()
	_, err := p.DB.Collection("hostelverifications").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: id}}, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: now})},
		{Key: "$setOnInsert", Value: bson.D{{Key: "checklist", Value: bson.A{}}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	return err
}

// sendBackKyc is sendBackHostelKyc: a quick sign-up's KYC goes back to the owner to
// fix, instead of the listing being refused. Nil when the hostel has no KYC open.
func (p *Platform) sendBackKyc(ctx context.Context, id bson.ObjectID, note string, actor bson.ObjectID) (ordered.Map, error) {
	now := p.now()
	h, err := p.DB.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "kyc.required", Value: true}, {Key: "kyc.status", Value: bson.D{{Key: "$ne", Value: "APPROVED"}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "kyc.note", Value: note}, {Key: "kyc.reviewedAt", Value: now}, {Key: "kyc.reviewedBy", Value: actor}, {Key: "kyc.status", Value: "REJECTED"},
			{Key: "status", Value: "DRAFT"}, {Key: "updatedBy", Value: actor}, {Key: "verificationStatus", Value: "UNVERIFIED"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := p.DB.Collection("hostelapplications").UpdateMany(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "NEEDS_MORE_INFO"}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "rejectionReason", Value: note}, {Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: "REJECTED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	if err := p.upsertVerification(ctx, id, bson.D{{Key: "notes", Value: note}, {Key: "status", Value: "REJECTED"}, {Key: "updatedBy", Value: actor}}, actor); err != nil {
		return nil, err
	}
	if err := p.auditHostel(ctx, actor, id, "HOSTEL_KYC_SENT_BACK", bson.D{{Key: "note", Value: note}}); err != nil {
		return nil, err
	}
	d := hostelDoc{h}
	notification, err := p.notifyOwner(ctx, id, "hostel_kyc_sent_back", func(o *ownerInfo) email.Content {
		return email.HostelKycSentBack(o.HostelName, p.SiteURL+"/"+url.PathEscape(d.str("slug"))+"/admin/kyc", note, o.Name)
	})
	if err != nil {
		return nil, err
	}
	if owner, ok := d.oid("ownerId"); ok {
		p.bell(ctx, owner, id, "/hostel-admin/kyc", note, "Your KYC needs a change", "HOSTEL_KYC")
	}
	return ordered.Map{{Key: "hostel", Value: p.serialize(h)}, {Key: "notification", Value: notification}}, nil
}

func (p *Platform) requestDocuments(c *gin.Context) {
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
	var docs []email.RequestedDocument
	if list, ok := f.Array("documents", false, false); ok {
		each(f, "documents", list, func(_ int, s *valid.Form) {
			var d email.RequestedDocument
			d.DocumentType, _ = s.Str("documentType", valid.S{Trim: true, Min: 2, Max: 120})
			d.Note, _ = s.Str("note", valid.S{Opt: true, Trim: true, Max: 400})
			docs = append(docs, d)
		})
		f.Size("documents", len(list), 1, 12, "Request at least one document.", false)
	}
	note, _ := f.Str("note", valid.S{Opt: true, Trim: true, Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	types := make([]string, len(docs))
	for i, d := range docs {
		types[i] = d.DocumentType
	}
	parts := []string{}
	if note != "" {
		parts = append(parts, note)
	}
	if len(docs) > 0 {
		parts = append(parts, "Please add: "+strings.Join(types, ", ")+".")
	}
	backNote := strings.Join(parts, " ")
	if backNote == "" {
		backNote = "Please check your documents."
	}
	if back, err := p.sendBackKyc(c, id, backNote, actor); err != nil || back != nil {
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		n, _ := back.Get("notification")
		httpx.OK(c, back, emailedMsg(n, "Documents requested from owner", "Documents requested, but the owner could not be emailed"))
		return
	}
	h, err := p.DB.Collection("hostels").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "updatedBy", Value: actor}, {Key: "verificationStatus", Value: "PENDING"}, {Key: "updatedAt", Value: p.now()}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, hostelErr404())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	requested := bson.A{}
	for _, d := range docs {
		row := bson.D{{Key: "documentType", Value: d.DocumentType}}
		if d.Note != "" {
			row = append(row, bson.E{Key: "note", Value: d.Note})
		}
		requested = append(requested, row)
	}
	now := p.now()
	if _, err := p.DB.Collection("hostelapplications").UpdateMany(c, bson.D{{Key: "hostelId", Value: id}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "NEEDS_MORE_INFO"}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "infoRequestNote", Value: note}, {Key: "infoRequestedAt", Value: now}, {Key: "infoRequestedBy", Value: actor}, {Key: "requestedDocuments", Value: requested},
			{Key: "reviewedBy", Value: actor}, {Key: "status", Value: "NEEDS_MORE_INFO"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := p.auditHostel(c, actor, id, "HOSTEL_DOCUMENTS_REQUESTED", bson.D{{Key: "documents", Value: types}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	notification, err := p.notifyOwner(c, id, "hostel_documents_requested", func(o *ownerInfo) email.Content {
		return email.HostelDocumentsRequested(docs, o.HostelName, note, o.Name, p.statusURL())
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "hostel", Value: p.serialize(h)}, {Key: "notification", Value: notification}},
		emailedMsg(notification, "Documents requested from owner", "Documents requested, but the owner could not be emailed"))
}

// ---- publish, unpublish ----

func (p *Platform) publish(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	h, err := p.findHostel(c, id, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if (hostelDoc{h}).str("verificationStatus") != "VERIFIED" {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "HOSTEL_NOT_VERIFIED", "Only verified hostels can be published.", nil))
		return
	}
	result, err := p.setStatus(c, id, actor, "PUBLISHED", "HOSTEL_PUBLISHED", "", nil)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	slug := hostelDoc{h}.str("slug")
	notification, err := p.notifyOwner(c, id, "hostel_published", func(o *ownerInfo) email.Content { return email.HostelPublished(o.HostelName, p.listing(slug)) })
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, append(result, ordered.Pair{Key: "notification", Value: notification}), emailedMsg(notification, "Hostel published", "Hostel published, but the owner could not be emailed"))
}

// emailedMsg is the route's message: ok when the owner's email went out, else failed.
func emailedMsg(notification any, ok, failed string) string {
	if n, isMap := notification.(ordered.Map); isMap {
		if sent, _ := n.Get("sent"); sent == true {
			return ok
		}
	}
	return failed
}

func (p *Platform) unpublish(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	reason, ok := reasonBody(c)
	if !ok {
		return
	}
	result, err := p.setStatus(c, id, actor, "APPROVED", "HOSTEL_UNPUBLISHED", "", bson.D{{Key: "reason", Value: reason}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	notification, err := p.notifyOwner(c, id, "hostel_unpublished", func(o *ownerInfo) email.Content { return email.HostelUnpublished(o.HostelName, p.loginURL(), reason) })
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, append(result, ordered.Pair{Key: "notification", Value: notification}), emailedMsg(notification, "Hostel unpublished", "Hostel unpublished, but the owner could not be emailed"))
}
