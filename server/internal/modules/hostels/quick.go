package hostels

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelreferrals"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Quick is the quick sign-up (hostel-quick-registration.service.ts): owner name,
// phone and hostel name from a signed-in account, and the portal opens on the
// trial.
type Quick struct {
	DB      *mongo.Database
	Guards  *authz.Guards
	Limiter *ratelimit.Limiter
	Refs    *hostelreferrals.Service
	Config  *platformconfig.Service
	Mail    *email.Sender
	Notify  *notifications.Service
	Audit   *audit.Log
	// SiteURL is siteUrl(): where the KYC link in the welcome mail points.
	SiteURL string
}

func (q *Quick) Register(v1 *gin.RouterGroup) {
	v1.POST("/public/hostels/quick-register", q.register)
	v1.GET("/public/hostels/quick-register", methodNotAllowed)
}

var phoneChars = regexp.MustCompile(`^[+\d\s-]+$`)

type quickIn struct {
	hostelName, ownerName, phone, referralCode string
}

// parseQuick is quickHostelRegistrationSchema.
func parseQuick(body any) (quickIn, error) {
	f := valid.NewForm(body)
	var in quickIn
	in.hostelName, _ = f.Str("hostelName", valid.S{Trim: true, Min: 2, MinMsg: "Enter your hostel's name.", Max: 120})
	in.ownerName, _ = f.Str("ownerName", valid.S{Trim: true, Min: 2, MinMsg: "Enter the owner's name.", Max: 80})
	in.phone, _ = f.Str("phone", valid.S{Trim: true, Min: 7, Max: 20, Re: phoneChars, ReMsg: "Expected a valid phone number."})
	in.referralCode, _ = f.Str("referralCode", valid.S{Opt: true, Trim: true, Max: 40})
	return in, f.Err()
}

func hostelErr(status int, code, msg string) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

func (q *Quick) register(c *gin.Context) {
	if err := q.Limiter.PublicForm(c, "quick-hostel-registration"); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, err := q.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseQuick(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := q.quickRegister(c, in, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Your hostel portal is open")
}

func (q *Quick) quickRegister(ctx context.Context, in quickIn, userID string) (ordered.Map, error) {
	uid, err := NormalizeObjectID(userID)
	if err != nil {
		return nil, err
	}
	users := q.DB.Collection("users")
	var user struct {
		ID              bson.ObjectID `bson:"_id"`
		Email           string        `bson:"email"`
		EmailVerified   bool          `bson:"emailVerified"`
		EmailVerifiedAt *time.Time    `bson:"emailVerifiedAt"`
		Phone           string        `bson:"phone"`
		Role            string        `bson:"role"`
	}
	err = users.FindOne(ctx, bson.D{{Key: "_id", Value: uid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "emailVerified", Value: 1}, {Key: "emailVerifiedAt", Value: 1}, {Key: "name", Value: 1}, {Key: "phone", Value: 1}, {Key: "role", Value: 1}})).Decode(&user)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, hostelErr(http.StatusNotFound, "USER_NOT_FOUND", "Sign in again to register your hostel.")
	}
	if err != nil {
		return nil, err
	}
	if user.Role != "PUBLIC" {
		msg := "This account is already used for another role. Sign in with a different account to register a hostel."
		if user.Role == "HOSTEL_ADMIN" {
			msg = "You already run a hostel portal. Add another building from it as a branch."
		}
		return nil, hostelErr(http.StatusConflict, "ACCOUNT_HAS_ROLE", msg)
	}
	if user.Email == "" || !(user.EmailVerified || user.EmailVerifiedAt != nil) {
		return nil, hostelErr(http.StatusConflict, "EMAIL_NOT_VERIFIED", "Verify your email first, then register your hostel.")
	}
	hostels := q.DB.Collection("hostels")
	var filed struct {
		Name *string `bson:"name"`
	}
	err = hostels.FindOne(ctx, bson.D{{Key: "kyc.required", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "ownerId", Value: user.ID}},
		options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&filed)
	if err == nil {
		name := "a hostel"
		if filed.Name != nil {
			name = *filed.Name
		}
		return nil, hostelErr(http.StatusConflict, "ALREADY_REGISTERED", "You already registered "+name+". Our team will email you about it.")
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var referral *hostelreferrals.Resolved
	if in.referralCode != "" {
		r, err := q.Refs.Resolve(ctx, in.referralCode)
		if err != nil {
			return nil, err
		}
		referral = &r
	}
	if user.Phone == "" {
		n, err := users.CountDocuments(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: user.ID}}}, {Key: "phone", Value: in.phone}}, options.Count().SetLimit(1))
		if err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, hostelErr(http.StatusConflict, "PHONE_IN_USE", in.phone+" is already on another HostelPalika account. Use a different phone number.")
		}
	}
	// A retry after a half-finished attempt picks the same hostel up.
	var hostel struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
		Slug string        `bson:"slug"`
	}
	err = hostels.FindOne(ctx, bson.D{{Key: "kyc.required", Value: true}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "ownerId", Value: user.ID}},
		options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "slug", Value: 1}})).Decode(&hostel)
	existing := err == nil
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if !existing {
		slug, err := UniqueSlug(ctx, q.DB, in.hostelName, "")
		if err != nil {
			return nil, err
		}
		hostel.ID, hostel.Name, hostel.Slug = bson.NewObjectID(), in.hostelName, slug
		doc := NewHostelDoc(hostel.ID, bson.D{
			{Key: "name", Value: in.hostelName}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: user.ID},
			{Key: "contact", Value: bson.D{{Key: "phone", Value: in.phone}, {Key: "email", Value: user.Email}}},
			{Key: "status", Value: "DRAFT"}, {Key: "verificationStatus", Value: "UNVERIFIED"}, {Key: "createdBy", Value: user.ID}, {Key: "updatedBy", Value: user.ID},
			{Key: "kyc", Value: bson.D{{Key: "required", Value: true}, {Key: "status", Value: "DRAFT"}}},
		}, now)
		if _, err := hostels.InsertOne(ctx, doc); err != nil {
			return nil, err
		}
	}
	sub, err := billing.GetOrCreateSubscription(ctx, q.DB, hostel.ID, "PUBLIC", nil)
	if err != nil {
		return nil, err
	}
	trialDays := 0
	if sub.TrialDays != nil {
		trialDays = *sub.TrialDays
	}
	trialEnds := sub.TrialEndsAt
	if sub.TrialEndsAt == nil {
		days := q.Config.OperationsTyped(ctx).TrialDays
		ends := bs.DayEnd(now, days)
		_, err := q.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "activatedAt", Value: now}, {Key: "currentPeriodEnd", Value: ends}, {Key: "freeMonths", Value: 0}, {Key: "freeUntil", Value: ends},
			{Key: "status", Value: "ACTIVE"}, {Key: "trialDays", Value: days}, {Key: "trialEndsAt", Value: ends}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			return nil, err
		}
		if _, err := hostels.UpdateOne(ctx, bson.D{{Key: "_id", Value: hostel.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "kyc.trialEndsAt", Value: ends}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return nil, err
		}
		trialDays, trialEnds = days, &ends
	}
	if referral != nil && !existing {
		if err := q.Refs.Record(ctx, *referral, hostel.ID); err != nil {
			return nil, err
		}
	}
	set := bson.D{{Key: "name", Value: in.ownerName}, {Key: "role", Value: "HOSTEL_ADMIN"}}
	if user.Phone == "" {
		set = append(set, bson.E{Key: "phone", Value: in.phone})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	raised, err := users.UpdateOne(ctx, bson.D{{Key: "_id", Value: user.ID}, {Key: "role", Value: "PUBLIC"}},
		bson.D{{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: hostel.ID}}}, {Key: "$set", Value: set}})
	if err != nil {
		return nil, err
	}
	var code any
	if referral != nil {
		code = referral.Code
	}
	if !existing {
		if err := q.Audit.Write(ctx, audit.Entry{ActorID: user.ID, HostelID: hostel.ID, Action: "HOSTEL_QUICK_REGISTERED", EntityType: "Hostel", EntityID: hostel.ID.Hex(),
			Metadata: bson.D{{Key: "referralCode", Value: code}, {Key: "trialDays", Value: trialDays}}}); err != nil {
			return nil, err
		}
	}
	if raised.ModifiedCount > 0 {
		if err := q.Audit.Write(ctx, audit.Entry{ActorID: user.ID, HostelID: hostel.ID, Action: "USER_ROLE_UPGRADED", EntityType: "User", EntityID: user.ID.Hex(),
			Metadata: bson.D{{Key: "previousRole", Value: "PUBLIC"}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "via", Value: "quick-registration"}}}); err != nil {
			return nil, err
		}
		trialEndsOn := ""
		if trialEnds != nil {
			trialEndsOn = email.EmailDate(*trialEnds)
		}
		mail := email.HostelPortalOpen(hostel.Name, q.SiteURL+"/"+url.PathEscape(hostel.Slug)+"/admin/kyc", in.ownerName, trialDays, trialEndsOn)
		q.Mail.Send(ctx, email.Message{Category: mail.Category, To: []string{user.Email}, Subject: mail.Subject, HTML: mail.HTML})
		q.tellOwner(ctx, user.ID, hostel.ID, "/hostel-admin", fmt.Sprintf("You got %d days free — enjoy and explore.", trialDays), "Congratulations! "+hostel.Name+" is on HostelPalika", "HOSTEL_PORTAL_OPEN")
		q.tellOwner(ctx, user.ID, hostel.ID, "/hostel-admin/kyc", "Complete your hostel KYC now. Our team checks it within 24 hours, then every feature opens.", "Please complete your KYC", "HOSTEL_KYC")
	}
	var endsAt any
	if trialEnds != nil {
		endsAt = httpx.ISO(*trialEnds)
	}
	return ordered.Map{{Key: "hostelId", Value: hostel.ID.Hex()}, {Key: "name", Value: hostel.Name}, {Key: "slug", Value: hostel.Slug},
		{Key: "trialDays", Value: float64(trialDays)}, {Key: "trialEndsAt", Value: endsAt}}, nil
}

// tellOwner is notifyHostelOwnerOf: a failure is swallowed.
func (q *Quick) tellOwner(ctx context.Context, userID, hostelID bson.ObjectID, actionURL, body, title, kind string) {
	_, _ = q.Notify.CreateInApp(ctx, notifications.Input{ActionURL: actionURL, Body: body, Category: "GENERAL",
		Data: ordered.Map{{Key: "hostelId", Value: hostelID.Hex()}, {Key: "type", Value: kind}}, HostelID: hostelID.Hex(), Priority: "HIGH", Title: title, UserID: userID.Hex()})
}
