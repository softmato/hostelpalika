package hostels

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelreferrals"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Registration is registerPublicHostelApplication: the owner fills the form
// themselves, the hostel waits in the approval queue.
type Registration struct {
	DB      *mongo.Database
	Guards  *authz.Guards
	Limiter *ratelimit.Limiter
	Refs    *hostelreferrals.Service
	Claims  files.Claims
	// ShortStayLimits is the booking config: the minimum markup percent and the most nights.
	ShortStayLimits func(context.Context) (minMarkupPercent, maxNights float64)
	Mail            *email.Sender
	Notify          *notifications.Service
	Audit           *audit.Log
	RT              *realtime.Client
	Cache           realtime.Bumper
	Outbound        string
	FinanceKey      string
	FinancePrev     string
	PersonalKey     string
}

func (r *Registration) Register(v1 *gin.RouterGroup) {
	v1.POST("/public/hostels/register", r.register)
	v1.GET("/public/hostels/register", methodNotAllowed)
}

func (r *Registration) register(c *gin.Context) {
	if err := r.Limiter.PublicForm(c, "public-hostel-registration"); err != nil {
		httpx.Fail(c, err)
		return
	}
	principal, err := r.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := ParseRegistration(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	authID := ""
	if principal != nil {
		authID = principal.UserID
	}
	out, err := r.submit(c, in, authID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Hostel registration submitted")
}

type owner struct {
	ID    bson.ObjectID `bson:"_id"`
	Email string        `bson:"email"`
	Role  string        `bson:"role"`
}

func (r *Registration) authenticatedOwner(ctx context.Context, userID string) (*owner, error) {
	id, err := NormalizeObjectID(userID)
	if err != nil {
		return nil, err
	}
	var u owner
	err = r.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, hostelErr(http.StatusUnauthorized, "HOSTEL_OWNER_NOT_FOUND", "Your account could not be found. Sign in again and retry.")
	}
	if err != nil {
		return nil, err
	}
	if u.Role != "HOSTEL_ADMIN" && u.Role != "PUBLIC" {
		return nil, hostelErr(http.StatusConflict, "HOSTEL_OWNER_CONTACT_CONFLICT", "This account role cannot register a hostel.")
	}
	return &u, nil
}

// findOrCreateOwner resolves the owner from the contact details typed in the form.
func (r *Registration) findOrCreateOwner(ctx context.Context, a Applicant, now time.Time) (bson.ObjectID, error) {
	or := bson.A{bson.D{{Key: "phone", Value: a.Phone}}}
	if a.Email != nil && *a.Email != "" {
		or = append(or, bson.D{{Key: "email", Value: strings.ToLower(*a.Email)}})
	}
	var u owner
	err := r.DB.Collection("users").FindOne(ctx, bson.D{{Key: "$or", Value: or}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u)
	if err == nil {
		if u.Role != "HOSTEL_ADMIN" && u.Role != "PUBLIC" {
			return bson.ObjectID{}, hostelErr(http.StatusConflict, "HOSTEL_OWNER_CONTACT_CONFLICT", "This contact already belongs to another account role.")
		}
		return u.ID, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return bson.ObjectID{}, err
	}
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: valid.Trim(a.Name)}}
	if a.Email != nil && *a.Email != "" {
		doc = append(doc, bson.E{Key: "email", Value: strings.ToLower(valid.Trim(*a.Email))})
	}
	doc = append(doc, bson.E{Key: "image", Value: nil}, bson.E{Key: "emailVerified", Value: false}, bson.E{Key: "phone", Value: valid.Trim(a.Phone)},
		bson.E{Key: "authProvider", Value: "LOCAL"}, bson.E{Key: "role", Value: "PUBLIC"}, bson.E{Key: "mustChangePassword", Value: false},
		bson.E{Key: "lockPinSetAt", Value: nil}, bson.E{Key: "lockPinFailures", Value: 0}, bson.E{Key: "tokenVersion", Value: 0}, bson.E{Key: "hostelIds", Value: bson.A{}},
		bson.E{Key: "status", Value: "INVITED"}, bson.E{Key: "isDemoData", Value: false}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := r.DB.Collection("users").InsertOne(ctx, doc); err != nil {
		return bson.ObjectID{}, err
	}
	return id, nil
}

// shortStays is registrationShortStays + checkShortStays: a daily rate under its
// room's floor refuses the whole form.
func (r *Registration) shortStays(ctx context.Context, in Reg) (bson.D, error) {
	if in.ShortStays == nil || !in.ShortStays.Enabled {
		return nil, nil
	}
	minMarkup, maxNights := r.ShortStayLimits(ctx)
	type room struct {
		floor    *int64
		rent     *float64
		roomType string
	}
	rooms := make([]room, 0, len(in.Rooms))
	for _, rc := range in.Rooms {
		rm := room{roomType: rc.RoomType}
		if rc.MonthlyRent != nil && *rc.MonthlyRent > 0 {
			rm.rent = rc.MonthlyRent
			floor := int64(math.Max(1, math.Ceil(*rc.MonthlyRent*(100+minMarkup)/3000)))
			rm.floor = &floor
		}
		rooms = append(rooms, rm)
	}
	if in.ShortStays.MinNights > maxNights {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "SHORT_STAY_MIN_NIGHTS_TOO_HIGH",
			fmt.Sprintf("The minimum stay can be at most %v nights. Longer stays are monthly.", maxNights), nil)
	}
	rates := bson.A{}
	var seen []string
	for _, rate := range in.ShortStays.Rates {
		var found *room
		for i := range rooms {
			if residents.SameRoomType(rooms[i].roomType, rate.RoomType) {
				found = &rooms[i]
				break
			}
		}
		if found == nil {
			return nil, httpx.NewError(http.StatusUnprocessableEntity, "ROOM_NOT_FOUND", `This hostel has no "`+rate.RoomType+`" room type.`, nil)
		}
		label := residents.RoomTypeLabel(found.roomType)
		if found.floor == nil {
			return nil, httpx.NewError(http.StatusUnprocessableEntity, "SHORT_STAY_ROOM_NOT_PRICED",
				"Set a monthly rent for "+label+" on the rate card first. The daily rate is checked against it.", nil)
		}
		if rate.Daily < float64(*found.floor) {
			return nil, httpx.NewError(http.StatusUnprocessableEntity, "SHORT_STAY_RATE_TOO_LOW",
				label+" must be at least Rs "+money.GroupIN(*found.floor)+" a night.", ordered.Map{{Key: "floor", Value: float64(*found.floor)}, {Key: "roomType", Value: found.roomType}})
		}
		dup := false
		for _, s := range seen {
			dup = dup || residents.SameRoomType(s, found.roomType)
		}
		if !dup {
			seen = append(seen, found.roomType)
			rates = append(rates, bson.D{{Key: "dailyRate", Value: rate.Daily}, {Key: "roomType", Value: found.roomType}})
		}
	}
	if in.ShortStays.Enabled && len(rates) == 0 {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "SHORT_STAY_NO_RATES", "Give at least one room type a daily rate to take short stays.", nil)
	}
	return bson.D{{Key: "enabled", Value: in.ShortStays.Enabled}, {Key: "minNights", Value: in.ShortStays.MinNights}, {Key: "rates", Value: rates}}, nil
}

func strOrNil(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func (r *Registration) submit(ctx context.Context, in Reg, authUserID string) (ordered.Map, error) {
	shortStays, err := r.shortStays(ctx, in)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var auth *owner
	if authUserID != "" {
		if auth, err = r.authenticatedOwner(ctx, authUserID); err != nil {
			return nil, err
		}
	}
	applicant := in.Applicant
	if auth != nil && auth.Email != "" {
		e := auth.Email
		applicant.Email = &e
	}
	var referral *hostelreferrals.Resolved
	if in.RefCode != "" {
		res, err := r.Refs.Resolve(ctx, in.RefCode)
		if err != nil {
			return nil, err
		}
		referral = &res
	}
	var ownerID bson.ObjectID
	if auth != nil {
		ownerID = auth.ID
	} else if ownerID, err = r.findOrCreateOwner(ctx, applicant, now); err != nil {
		return nil, err
	}
	if referral != nil && referral.ReferrerOwnerID != nil && *referral.ReferrerOwnerID == ownerID {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "REFERRAL_OWN_CODE", "That is your own hostel's referral code. Share it with other hostels instead.", nil)
	}
	claimed, err := r.Claims.Claim(ctx, r.DB, in.Documents, ownerID)
	if err != nil {
		return nil, err
	}
	slug, err := UniqueSlug(ctx, r.DB, in.Name, in.LocArea)
	if err != nil {
		return nil, err
	}
	hostelID := bson.NewObjectID()
	fields := hostelFields(in, ownerID, slug, shortStays)
	if _, err := r.DB.Collection("hostels").InsertOne(ctx, NewHostelDoc(hostelID, fields, now)); err != nil {
		return nil, err
	}
	docs := bson.A{}
	for _, d := range claimed {
		docs = append(docs, bson.D{{Key: "documentType", Value: d.DocumentType}, {Key: "fileAssetId", Value: d.FileAssetID}})
	}
	snapshot := bson.D{{Key: "applicant", Value: applicantDoc(applicant)}}
	if len(in.Capacity) > 0 {
		snapshot = append(snapshot, bson.E{Key: "capacitySummary", Value: in.Capacity})
	}
	if len(in.Contact) > 0 {
		snapshot = append(snapshot, bson.E{Key: "contact", Value: in.Contact})
	}
	snapshot = append(snapshot, bson.E{Key: "documents", Value: docs}, bson.E{Key: "location", Value: in.Location}, bson.E{Key: "name", Value: in.Name})
	if len(in.Pricing) > 0 {
		snapshot = append(snapshot, bson.E{Key: "pricing", Value: in.Pricing})
	}
	snapshot = append(snapshot, bson.E{Key: "roomConfigurations", Value: roomSnapshot(in.Rooms)})
	var selected any
	if in.Plan != nil {
		selected = in.Plan.PlanID
	}
	snapshot = append(snapshot, bson.E{Key: "selectedPlan", Value: selected})
	appID := bson.NewObjectID()
	app := bson.D{{Key: "_id", Value: appID}, {Key: "hostelId", Value: hostelID}, {Key: "applicantId", Value: ownerID}, {Key: "submittedBy", Value: ownerID}, {Key: "status", Value: "PENDING"},
		{Key: "source", Value: "PUBLIC"}, {Key: "submittedByAgentId", Value: nil}, {Key: "requestedDocuments", Value: bson.A{}}}
	if in.Notes != nil {
		app = append(app, bson.E{Key: "notes", Value: *in.Notes})
	}
	app = append(app, bson.E{Key: "snapshot", Value: snapshot}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := r.DB.Collection("hostelapplications").InsertOne(ctx, app); err != nil {
		return nil, err
	}
	if _, err := billing.GetOrCreateSubscription(ctx, r.DB, hostelID, "PUBLIC", nil); err != nil {
		return nil, err
	}
	if referral != nil {
		if err := r.Refs.Record(ctx, *referral, hostelID); err != nil {
			return nil, err
		}
	}
	if _, err := r.DB.Collection("hostelverifications").InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "status", Value: "PENDING"},
		{Key: "checklist", Value: bson.A{}}, {Key: "createdBy", Value: ownerID}, {Key: "updatedBy", Value: ownerID}, {Key: "isDeleted", Value: false},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	if len(claimed) > 0 {
		rows := make([]any, 0, len(claimed))
		for _, d := range claimed {
			rows = append(rows, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "ownerId", Value: ownerID}, {Key: "documentType", Value: d.DocumentType},
				{Key: "fileAssetId", Value: d.FileAssetID}, {Key: "status", Value: "PENDING"}, {Key: "createdBy", Value: ownerID}, {Key: "updatedBy", Value: ownerID},
				{Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		}
		if _, err := r.DB.Collection("hosteldocuments").InsertMany(ctx, rows); err != nil {
			return nil, err
		}
	}
	var code, plan any
	if referral != nil {
		code = referral.Code
	}
	if in.Plan != nil {
		plan = in.Plan.PlanID
	}
	if err := r.Audit.Write(ctx, audit.Entry{ActorID: ownerID, HostelID: hostelID, Action: "PUBLIC_HOSTEL_APPLICATION_SUBMITTED", EntityType: "Hostel", EntityID: hostelID.Hex(),
		Metadata: bson.D{{Key: "referralCode", Value: code}, {Key: "selectedPlan", Value: plan}, {Key: "submittedFrom", Value: "public-registration"}}}); err != nil {
		return nil, err
	}
	if applicant.Email != nil && *applicant.Email != "" {
		mail := email.HostelSubmissionReceived(in.Name, in.Applicant.Name)
		r.Mail.Notify(ctx, email.Notification{Action: "hostel_submission_received", To: *applicant.Email, Subject: mail.Subject, HTML: mail.HTML, Category: mail.Category})
	}
	r.notifyPlatform(ctx, hostelID, in.Name, in.LocCity, in.Applicant)
	r.savePayout(ctx, hostelID, in.Payout, ownerID, now)

	var h, a bson.Raw
	if err := r.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "isDeleted", Value: false}}).Decode(&h); err != nil {
		return nil, err
	}
	if err := r.DB.Collection("hostelapplications").FindOne(ctx, bson.D{{Key: "_id", Value: appID}}).Decode(&a); err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "application", Value: applicationOut(a)}, {Key: "hostel", Value: SerializeHostel(h, time.Now())}}, nil
}

func applicantDoc(a Applicant) bson.D {
	var d bson.D
	add := func(k string, p *string) {
		if p != nil {
			d = append(d, bson.E{Key: k, Value: *p})
		}
	}
	add("age", a.Age)
	add("email", a.Email)
	add("gender", a.Gender)
	add("idProofType", a.IDProof)
	return append(d, bson.E{Key: "name", Value: a.Name}, bson.E{Key: "phone", Value: a.Phone})
}

func roomDoc(rc RoomCfg, deposit *float64, withDefault bool) bson.D {
	d := bson.D{{Key: "bedsPerRoom", Value: rc.Beds}, {Key: "mealInclusion", Value: rc.Meal}}
	if rc.MonthlyRent != nil {
		d = append(d, bson.E{Key: "monthlyRent", Value: *rc.MonthlyRent})
	}
	dep := rc.Deposit
	if dep == nil && withDefault {
		dep = deposit
	}
	if dep != nil {
		d = append(d, bson.E{Key: "securityDeposit", Value: *dep})
	}
	return append(d, bson.E{Key: "rooms", Value: rc.Rooms}, bson.E{Key: "roomType", Value: rc.RoomType}, bson.E{Key: "vacantBeds", Value: rc.Vacant})
}

func roomSnapshot(rooms []RoomCfg) bson.A {
	out := bson.A{}
	for _, rc := range rooms {
		out = append(out, roomDoc(rc, nil, false))
	}
	return out
}

// hostelFields is hostelDocumentFrom: the hostel document both desks write.
func hostelFields(in Reg, ownerID bson.ObjectID, slug string, shortStays bson.D) bson.D {
	capacity := append(bson.D{}, in.Capacity...)
	if in.TotalCap != nil && *in.TotalCap != 0 {
		if v, ok := lookup(capacity, "totalBeds"); !ok || v == nil || v == float64(0) {
			capacity = setKey(capacity, "totalBeds", *in.TotalCap)
		}
	}
	contact := append(bson.D{}, in.Contact...)
	if in.AltPhone != nil {
		contact = append(contact, bson.E{Key: "alternatePhone", Value: *in.AltPhone})
	}
	location := append(bson.D{}, in.Location...)
	if in.Landmark != nil {
		location = append(location, bson.E{Key: "landmark", Value: *in.Landmark})
	}
	if in.MapLink != nil {
		location = append(location, bson.E{Key: "mapLink", Value: *in.MapLink})
	}
	rooms := bson.A{}
	for _, rc := range in.Rooms {
		rooms = append(rooms, append(bson.D{{Key: "_id", Value: bson.NewObjectID()}}, roomDoc(rc, in.Deposit, true)...))
	}
	f := bson.D{{Key: "capacitySummary", Value: capacity}, {Key: "contact", Value: contact}}
	if in.Desc != nil {
		f = append(f, bson.E{Key: "description", Value: *in.Desc})
	}
	f = append(f, bson.E{Key: "facilities", Value: strArray(in.Facilities)})
	if in.FoodSet {
		f = append(f, bson.E{Key: "food", Value: in.Food})
	}
	f = append(f, bson.E{Key: "hostelType", Value: in.HostelType}, bson.E{Key: "location", Value: location}, bson.E{Key: "name", Value: in.Name}, bson.E{Key: "ownerId", Value: ownerID})
	if in.PAN != nil {
		f = append(f, bson.E{Key: "panNumber", Value: *in.PAN})
	}
	withIDs := bson.A{}
	for _, p := range in.Photos {
		withIDs = append(withIDs, append(bson.D{{Key: "_id", Value: bson.NewObjectID()}}, p.(bson.D)...))
	}
	f = append(f, bson.E{Key: "photos", Value: withIDs})
	if in.PricingSet {
		f = append(f, bson.E{Key: "pricing", Value: in.Pricing})
	}
	if in.Deposit != nil {
		f = append(f, bson.E{Key: "securityDeposit", Value: *in.Deposit})
	}
	f = append(f, bson.E{Key: "roomConfigurations", Value: rooms}, bson.E{Key: "roomTypes", Value: strArray(in.RoomTypes)}, bson.E{Key: "rules", Value: strArray(in.Rules)},
		bson.E{Key: "slug", Value: slug}, bson.E{Key: "status", Value: "PENDING_APPROVAL"})
	if in.Floors != nil {
		f = append(f, bson.E{Key: "totalFloors", Value: *in.Floors})
	}
	f = append(f, bson.E{Key: "createdBy", Value: ownerID}, bson.E{Key: "updatedBy", Value: ownerID}, bson.E{Key: "verificationStatus", Value: "PENDING"})
	if in.Year != nil {
		f = append(f, bson.E{Key: "yearEstablished", Value: *in.Year})
	}
	if shortStays != nil {
		f = append(f, bson.E{Key: "shortStays", Value: shortStays})
	}
	return f
}

func strArray(in []string) bson.A {
	out := bson.A{}
	for _, s := range in {
		out = append(out, s)
	}
	return out
}

func setKey(d bson.D, key string, v any) bson.D {
	for i := range d {
		if d[i].Key == key {
			d[i].Value = v
			return d
		}
	}
	return append(d, bson.E{Key: key, Value: v})
}

// notifyPlatform is notifyPlatformOfPendingHostel: mail and bell for the staff
// who approve hostels. Best-effort.
func (r *Registration) notifyPlatform(ctx context.Context, hostelID bson.ObjectID, name, city string, owner Applicant) {
	cur, err := r.DB.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "role", Value: bson.D{{Key: "$in", Value: bson.A{"SUPERADMIN", "PLATFORM_MODERATOR"}}}}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "email", Value: 1}, {Key: "name", Value: 1}}))
	if err != nil {
		return
	}
	var staff []struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
	}
	if cur.All(ctx, &staff) != nil || len(staff) == 0 {
		return
	}
	ownerEmail := ""
	if owner.Email != nil {
		ownerEmail = *owner.Email
	}
	mail := email.NewHostelPending(city, name, ownerEmail, owner.Name, residents.AppURL(r.Outbound, "/platform/hostels"))
	body := name
	if city != "" {
		body += " (" + city + ")"
	}
	body += " was submitted and is waiting for approval."
	for _, m := range staff {
		if m.Email != "" {
			r.Mail.Notify(ctx, email.Notification{Action: "platform_hostel_pending", To: m.Email, Subject: mail.Subject, HTML: mail.HTML, Category: mail.Category})
		}
		_, _ = r.Notify.CreateInApp(ctx, notifications.Input{
			Actions:   []notifications.Action{{Endpoint: "/api/v1/platform/hostels/" + hostelID.Hex() + "/approve", Key: "approve", Label: "Approve hostel", Method: "PATCH", Payload: ordered.Map{}, Tone: "primary"}},
			ActionURL: "/platform/hostels", Body: body, Category: "HOSTEL_APPROVAL", Data: ordered.Map{{Key: "hostelId", Value: hostelID.Hex()}},
			Kind: "ACTION", Title: "Hostel awaiting approval", UserID: m.ID.Hex(),
		})
	}
	realtime.PublishResourceChange(ctx, r.RT, r.Cache, realtime.Change{Platform: true, Topics: []realtime.Topic{realtime.Hostels}})
}

// savePayout is savePayoutAccountFromRegistration: sealed and queued for review;
// any failure is logged and the application carries on.
func (r *Registration) savePayout(ctx context.Context, hostelID bson.ObjectID, p *Payout, actor bson.ObjectID, now time.Time) {
	if p == nil {
		return
	}
	fail := func(err error) {
		slog.WarnContext(ctx, "registration_payout_account_skipped", "hostelId", hostelID.Hex(), "reason", err.Error())
	}
	keys, err := crypto.MasterKeys(r.FinanceKey, r.FinancePrev)
	if err != nil {
		fail(err)
		return
	}
	env, err := crypto.EncryptSecret(p.Number, crypto.Scope{HostelID: hostelID.Hex(), Purpose: "PAYOUT_ACCOUNT_NUMBER"}, keys[0])
	if err != nil {
		fail(err)
		return
	}
	last4 := p.Number
	if len(last4) > 4 {
		last4 = last4[len(last4)-4:]
	}
	lookup := ""
	if pk, perr := crypto.NewPersonal(r.personalKey()); perr == nil {
		lookup = pk.LookupHash("payout:" + p.Method + ":" + p.Number)
	}
	id := bson.NewObjectID()
	_, err = r.DB.Collection("hostelpayoutaccounts").InsertOne(ctx, bson.D{
		{Key: "_id", Value: id}, {Key: "hostelId", Value: hostelID}, {Key: "method", Value: p.Method}, {Key: "holderName", Value: p.Holder}, {Key: "bankName", Value: p.Bank}, {Key: "branch", Value: p.Branch},
		{Key: "number", Value: env}, {Key: "numberLast4", Value: last4}, {Key: "numberLookup", Value: lookup}, {Key: "status", Value: "PENDING_REVIEW"}, {Key: "reviewNote", Value: nil},
		{Key: "reviewedAt", Value: nil}, {Key: "reviewedBy", Value: nil}, {Key: "submittedAt", Value: now}, {Key: "submittedBy", Value: actor}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	if err != nil {
		fail(err)
		return
	}
	_ = r.Audit.Write(ctx, audit.Entry{ActorID: actor, HostelID: hostelID, Action: "PAYOUT_ACCOUNT_SET", EntityType: "HostelPayoutAccount", EntityID: id.Hex(),
		Metadata: bson.D{{Key: "next", Value: bson.D{{Key: "bankName", Value: p.Bank}, {Key: "holderName", Value: p.Holder}, {Key: "last4", Value: last4}, {Key: "method", Value: p.Method}}},
			{Key: "previous", Value: nil}, {Key: "source", Value: "REGISTRATION"}}})
	// Staff who review payout accounts hear of it, as in setHostelPayoutAccount.
	r.notifyPayoutReview(ctx, hostelID)
}

func (r *Registration) personalKey() string { return r.PersonalKey }

func (r *Registration) notifyPayoutReview(ctx context.Context, hostelID bson.ObjectID) {
	var h struct {
		Name string `bson:"name"`
	}
	if r.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}}).Decode(&h) != nil {
		return
	}
	cur, err := r.DB.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return
	}
	var staff []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if cur.All(ctx, &staff) != nil {
		return
	}
	for _, m := range staff {
		_, _ = r.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/platform/bookings?tab=payout-accounts", Body: h.Name + " set a payout account. Check it before any payout.", Category: "BOOKING",
			Data: ordered.Map{{Key: "hostelId", Value: hostelID.Hex()}, {Key: "type", Value: "PAYOUT_ACCOUNT_REVIEW"}}, Title: "Payout account to check", UserID: m.ID.Hex()})
	}
}
