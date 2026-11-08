package hostels

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/maps"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// OpeningRate is one room type's monthly rent on the opening rate card.
type OpeningRate struct {
	RoomType string
	Monthly  int64
}

// TeamRegistration is POST /team/hostels: registerTeamHostelApplication. An agent
// files a hostel with the owner beside them and it publishes on the spot, with
// the money collected recorded in the same request.
type TeamRegistration struct {
	*Registration
	Settler *billing.Settler
	Issuer  *users.Issuer
	Config  *platformconfig.Service
	Maps    *maps.Client
	// SeedRateCard is createFeeSchedule for the opening card (financeadmin imports
	// hostels, so it is passed in).
	SeedRateCard func(ctx context.Context, hostel bson.ObjectID, admission, form, deposit, referral int64, rates []OpeningRate, actor string) error
}

func (t *TeamRegistration) Register(v1 *gin.RouterGroup) {
	v1.POST("/team/hostels", t.register)
	v1.GET("/team/geocode", httpx.ETag(), t.geocode)
	t.registerPrepayments(v1)
}

// geocode is the owner's profile lookup for the registration desk: an agent pins a
// hostel that does not exist yet, so team membership is the guard. One lookup, so
// the agent's pin and the owner's resolve the same way.
func (t *TeamRegistration) geocode(c *gin.Context) {
	if _, err := t.Guards.RequireTeam(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q, err := ParseGeocodeQuery(valid.Query(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	message := "Address lookup complete"
	if q.Q != "" {
		message = "Location search complete"
	}
	httpx.OK(c, (&Geocoder{Maps: t.Maps}).LookupLocation(c, q), message)
}

func (t *TeamRegistration) register(c *gin.Context) {
	p, err := t.Guards.RequireTeam(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := ParseTeamRegistration(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	agent, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var me struct {
		Name string `bson:"name"`
	}
	if err := t.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: agent}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&me); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	out, err := t.file(c, in, p, agent, me.Name)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Hostel registered and published")
}

func conflict(code, msg string) error { return httpx.NewError(http.StatusConflict, code, msg, nil) }

// assertNew is assertTeamRegistrationIsNew: this path publishes on submit, so a
// duplicate is refused before any write.
func (t *TeamRegistration) assertNew(ctx context.Context, in TeamReg) error {
	area := strings.TrimSpace(in.LocArea)
	cur, err := t.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "location.area", Value: bson.Regex{Pattern: "^" + regexp.QuoteMeta(area) + "$", Options: "i"}}},
		options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return err
	}
	var near []struct {
		Name string `bson:"name"`
	}
	if err := cur.All(ctx, &near); err != nil {
		return err
	}
	if key := billing.HostelNameKey(in.Name); key != "" {
		for _, h := range near {
			if billing.HostelNameKey(h.Name) == key {
				return conflict("HOSTEL_ALREADY_LISTED", fmt.Sprintf(`"%s" in %s is already on %s. If this is a different building, give it a name that tells them apart.`, h.Name, in.LocArea, email.PlatformName))
			}
		}
	}
	if in.Applicant.Email != nil && *in.Applicant.Email != "" {
		used, err := t.hostelUsingEmail(ctx, *in.Applicant.Email)
		if err != nil {
			return err
		}
		if used != "" {
			return conflict("OWNER_EMAIL_IN_USE", *in.Applicant.Email+` is already used by "`+used+`". Use a different email for this owner.`)
		}
	}
	if in.ConfirmSecond {
		return nil
	}
	contacts := bson.A{bson.D{{Key: "phone", Value: in.Applicant.Phone}}}
	if in.Applicant.Email != nil && *in.Applicant.Email != "" {
		contacts = append(contacts, bson.D{{Key: "email", Value: strings.ToLower(*in.Applicant.Email)}})
	}
	var owner struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := t.DB.Collection("users").FindOne(ctx, bson.D{{Key: "$or", Value: contacts}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&owner); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return err
	}
	var existing struct {
		Name     string `bson:"name"`
		Location struct {
			Area string `bson:"area"`
		} `bson:"location"`
	}
	if err := t.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "ownerId", Value: owner.ID}}).Decode(&existing); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return err
	}
	where := ""
	if existing.Location.Area != "" {
		where = " in " + existing.Location.Area
	}
	return conflict("OWNER_ALREADY_HAS_HOSTEL", fmt.Sprintf(`This owner already has "%s"%s on %s. Confirm this is a second, separate building to register it.`, existing.Name, where, email.PlatformName))
}

// hostelUsingEmail is findHostelUsingEmail: the live hostel an address already belongs to.
func (t *TeamRegistration) hostelUsingEmail(ctx context.Context, address string) (string, error) {
	address = strings.ToLower(strings.TrimSpace(address))
	if address == "" {
		return "", nil
	}
	var user struct {
		ID        bson.ObjectID   `bson:"_id"`
		HostelIDs []bson.ObjectID `bson:"hostelIds"`
		Role      string          `bson:"role"`
	}
	found := true
	if err := t.DB.Collection("users").FindOne(ctx, bson.D{{Key: "email", Value: address}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&user); err != nil {
		if !errors.Is(err, mongo.ErrNoDocuments) {
			return "", err
		}
		found = false
	}
	or := bson.A{bson.D{{Key: "contact.email", Value: bson.Regex{Pattern: "^" + regexp.QuoteMeta(address) + "$", Options: "i"}}}}
	if found {
		or = append(or, bson.D{{Key: "ownerId", Value: user.ID}})
		if user.Role == "HOSTEL_ADMIN" || user.Role == "WARDEN" || user.Role == "COOK" {
			ids := bson.A{}
			for _, id := range user.HostelIDs {
				ids = append(ids, id)
			}
			or = append(or, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
		}
	}
	var h struct {
		Name *string `bson:"name"`
	}
	if err := t.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "$or", Value: or}}).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return "", nil
		}
		return "", err
	}
	if h.Name == nil {
		return "another hostel", nil
	}
	return *h.Name, nil
}

type teamBilling struct {
	free     *billing.Free
	setupFee any // int64, or nil on the lifetime deal
}

func (t *TeamRegistration) file(ctx context.Context, in TeamReg, p *authz.Principal, agent bson.ObjectID, agentName string) (ordered.Map, error) {
	if err := t.assertNew(ctx, in); err != nil {
		return nil, err
	}
	shortStays, err := t.shortStays(ctx, in.Reg)
	if err != nil {
		return nil, err
	}
	lifetime := in.Plan.Lifetime != nil && *in.Plan.Lifetime
	amount := int64(in.Payment.Amount)
	if lifetime && in.Payment.Method == "CASH" {
		priced, err := t.Settler.PriceLifetime(ctx, in.Plan.PlanID, true)
		if err != nil {
			return nil, err
		}
		if amount > priced.CycleTotal {
			return nil, httpx.NewError(http.StatusUnprocessableEntity, "LIFETIME_AMOUNT", fmt.Sprintf("The lifetime price is Rs %d. Collect that or less — never more.", priced.CycleTotal), nil)
		}
	} else if fee := int64(t.Config.OperationsTyped(ctx).TeamSetupFee); in.Payment.Method == "CASH" && amount > fee {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "SETUP_FEE_TOO_HIGH", fmt.Sprintf("The setup fee is at most Rs %d. Collect no more than that.", fee), nil)
	}
	// Taken before the hostel is written, so two publishes cannot both spend it.
	var prepayment *billing.ClaimedPrepayment
	if in.Payment.PrepaymentID != "" {
		cycle := in.Plan.Cycle
		if prepayment, err = t.Settler.ClaimTeamPrepayment(ctx, in.Payment.PrepaymentID, p, in.Plan.PlanID, cycle, lifetime); err != nil {
			return nil, err
		}
	}
	// Online counts only once Softmato says paid.
	if in.Payment.Method == "SOFTMATO" && (prepayment == nil || !prepayment.Paid) {
		if prepayment != nil {
			t.Settler.ReleaseTeamPrepayment(ctx, prepayment)
		}
		return nil, httpx.NewError(http.StatusPaymentRequired, "PAYMENT_REQUIRED", "The online payment has not arrived. Take the payment before publishing.", nil)
	}
	out, err := t.fileListing(ctx, in, shortStays, lifetime, agent, agentName, prepayment)
	if err != nil && prepayment != nil {
		t.Settler.ReleaseTeamPrepayment(ctx, prepayment)
	}
	return out, err
}

func (t *TeamRegistration) fileListing(ctx context.Context, in TeamReg, shortStays bson.D, lifetime bool, agent bson.ObjectID, agentName string, prepayment *billing.ClaimedPrepayment) (ordered.Map, error) {
	amount := int64(in.Payment.Amount)
	if prepayment != nil && prepayment.Paid {
		amount = prepayment.Charge()
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	ownerID, err := t.findOrCreateOwner(ctx, in.Applicant, now)
	if err != nil {
		return nil, err
	}
	claimed, err := t.Claims.Claim(ctx, t.DB, in.Documents, ownerID)
	if err != nil {
		return nil, err
	}
	slug, err := UniqueSlug(ctx, t.DB, in.Name, in.LocArea)
	if err != nil {
		return nil, err
	}
	hostelID, appID := bson.NewObjectID(), bson.NewObjectID()
	// The listing's rows land together (P7-12): TS wrote them one by one, so a
	// failure part way left a published hostel with no application or verification.
	if err := appmongo.InTx(ctx, t.DB, func(ctx context.Context) error {
		return t.writeListing(ctx, in, hostelID, appID, ownerID, agent, slug, shortStays, claimed, now)
	}); err != nil {
		return nil, err
	}
	if in.FoodRoutine != nil {
		if err := t.saveRoutine(ctx, hostelID, agent, in.FoodRoutine); err != nil {
			return nil, err
		}
	}
	bill, err := t.fileBilling(ctx, hostelID, in, lifetime, agent, agentName, prepayment)
	if err != nil {
		return nil, err
	}
	var tempPassword any
	if in.Applicant.Email != nil && *in.Applicant.Email != "" {
		issued, err := t.Issuer.RegisterOrUpgrade(ctx, users.IssueInput{Email: *in.Applicant.Email, HostelID: hostelID.Hex(), HostelName: in.Name, Name: in.Applicant.Name,
			PerformedBy: agent.Hex(), Role: "HOSTEL_ADMIN"})
		if err != nil {
			slog.WarnContext(ctx, "team_registration_owner_account_failed", "hostelId", hostelID.Hex(), "error", err.Error())
		} else if issued.TemporaryPassword != "" {
			tempPassword = issued.TemporaryPassword
		}
	}
	state, err := t.Settler.State(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	var outstanding int64
	var dueBy *time.Time
	planName := ""
	if state != nil {
		outstanding = state.Outstanding
		if s, ok := state.Subscription.DueBy.(string); ok {
			if d, err := time.Parse(time.RFC3339Nano, s); err == nil {
				dueBy = &d
			}
		}
		if s, ok := state.Subscription.PlanName.(string); ok {
			planName = s
		}
	}
	freeMonths := 0
	if bill.free != nil {
		freeMonths = bill.free.FreeMonths
	}
	if err := t.Audit.Write(ctx, audit.Entry{Action: "TEAM_HOSTEL_REGISTERED", ActorID: agent, EntityID: hostelID.Hex(), EntityType: "Hostel", HostelID: hostelID,
		Metadata: bson.D{{Key: "amountCollected", Value: amount}, {Key: "freeMonths", Value: freeMonths}, {Key: "method", Value: in.Payment.Method}, {Key: "outstanding", Value: outstanding},
			{Key: "setupFee", Value: bill.setupFee}, {Key: "planId", Value: in.Plan.PlanID}, {Key: "submittedFrom", Value: "team-registration"}}}); err != nil {
		return nil, err
	}
	t.tellOwner(ctx, in, agentName, amount, bill, dueBy, hostelID, slug, outstanding, planName)
	t.placeOnMap(ctx, hostelID)
	t.seedRateCard(ctx, hostelID, in.Reg, agent)
	t.savePayout(ctx, hostelID, in.Payout, agent, time.Now().UTC().Truncate(time.Millisecond))

	var h, a bson.Raw
	if err := t.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "isDeleted", Value: false}}).Decode(&h); err != nil {
		return nil, err
	}
	if err := t.DB.Collection("hostelapplications").FindOne(ctx, bson.D{{Key: "_id", Value: appID}}).Decode(&a); err != nil {
		return nil, err
	}
	cache.PublicChangedOn(ctx, t.Cache)
	var billingOut any
	if state != nil {
		billingOut = state
	}
	return ordered.Map{{Key: "application", Value: applicationOut(a)}, {Key: "billing", Value: billingOut}, {Key: "hostel", Value: SerializeHostel(h, time.Now())},
		{Key: "temporaryPassword", Value: tempPassword}}, nil
}

// writeListing is the hostel, its approved application, its verification and its
// documents: published on submit, because the agent's presence is the approval.
func (t *TeamRegistration) writeListing(ctx context.Context, in TeamReg, hostelID, appID, ownerID, agent bson.ObjectID, slug string, shortStays bson.D, claimed []files.Claimed, now time.Time) error {
	fields := hostelFields(in.Reg, ownerID, slug, shortStays, "PUBLISHED", "VERIFIED")
	if _, err := t.DB.Collection("hostels").InsertOne(ctx, NewHostelDoc(hostelID, fields, now)); err != nil {
		return err
	}
	docs := bson.A{}
	for _, d := range claimed {
		docs = append(docs, bson.D{{Key: "documentType", Value: d.DocumentType}, {Key: "fileAssetId", Value: d.FileAssetID}})
	}
	snapshot := bson.D{{Key: "applicant", Value: applicantDoc(in.Applicant)}}
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
	snapshot = append(snapshot, bson.E{Key: "roomConfigurations", Value: roomSnapshot(in.Rooms)}, bson.E{Key: "selectedPlan", Value: in.Plan.PlanID})
	app := bson.D{{Key: "_id", Value: appID}, {Key: "hostelId", Value: hostelID}, {Key: "applicantId", Value: ownerID}, {Key: "submittedBy", Value: ownerID}, {Key: "status", Value: "APPROVED"},
		{Key: "source", Value: "TEAM"}, {Key: "submittedByAgentId", Value: agent}, {Key: "requestedDocuments", Value: bson.A{}}}
	if in.Notes != nil {
		app = append(app, bson.E{Key: "notes", Value: *in.Notes})
	}
	app = append(app, bson.E{Key: "reviewedAt", Value: now}, bson.E{Key: "reviewedBy", Value: agent}, bson.E{Key: "snapshot", Value: snapshot}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := t.DB.Collection("hostelapplications").InsertOne(ctx, app); err != nil {
		return err
	}
	if _, err := t.DB.Collection("hostelverifications").InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "status", Value: "VERIFIED"},
		{Key: "checklist", Value: bson.A{}}, {Key: "verifiedBy", Value: agent}, {Key: "verifiedAt", Value: now}, {Key: "createdBy", Value: agent}, {Key: "updatedBy", Value: agent},
		{Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return err
	}
	if len(claimed) == 0 {
		return nil
	}
	rows := make([]any, 0, len(claimed))
	for _, d := range claimed {
		rows = append(rows, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "ownerId", Value: ownerID}, {Key: "documentType", Value: d.DocumentType},
			{Key: "fileAssetId", Value: d.FileAssetID}, {Key: "status", Value: "APPROVED"}, {Key: "reviewedBy", Value: agent}, {Key: "reviewedAt", Value: now},
			{Key: "createdBy", Value: agent}, {Key: "updatedBy", Value: agent}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	}
	_, err := t.DB.Collection("hosteldocuments").InsertMany(ctx, rows)
	return err
}

// saveRoutine is saveFoodRoutine for a hostel that has no cooks yet: the row and its audit.
func (t *TeamRegistration) saveRoutine(ctx context.Context, hostelID, agent bson.ObjectID, r *FoodRoutine) error {
	var special any
	if len(r.MonthEnd) > 0 {
		special = bson.D{{Key: "items", Value: r.MonthEnd}, {Key: "note", Value: r.MonthNote}}
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := t.DB.Collection("foodroutines").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "meals", Value: r.Meals}, {Key: "monthEndSpecial", Value: special}, {Key: "timings", Value: r.Timings}, {Key: "updatedBy", Value: agent}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return err
	}
	return t.Audit.Write(ctx, audit.Entry{Action: "FOOD_ROUTINE_SAVED", ActorID: agent, EntityID: hostelID.Hex(), EntityType: "FoodRoutine", HostelID: hostelID,
		Metadata: bson.D{{Key: "meals", Value: len(r.Meals)}, {Key: "monthEndSpecial", Value: len(r.MonthEnd) > 0}}})
}

// fileBilling is fileTeamBilling. The plan starts on its free time; the setup fee
// is what the agent collected, in cash or as an online prepayment. The lifetime
// deal takes the lifetime price instead. An older prepayment of kind PLAN paid
// the first invoice itself.
func (t *TeamRegistration) fileBilling(ctx context.Context, hostelID bson.ObjectID, in TeamReg, lifetime bool, agent bson.ObjectID, agentName string, pre *billing.ClaimedPrepayment) (teamBilling, error) {
	s := t.Settler
	if _, err := billing.GetOrCreateSubscription(ctx, t.DB, hostelID, "TEAM", &agent); err != nil {
		return teamBilling{}, err
	}
	amount := int64(in.Payment.Amount)
	if agentName == "" {
		agentName = "Field agent"
	}
	if lifetime {
		var online *billing.ClaimedPrepayment
		if pre != nil && pre.IsLifetime() {
			online = pre
		}
		if err := s.SelectPlan(ctx, hostelID, in.Plan.PlanID, plans.Cycle(in.Plan.Cycle), true, online == nil || !online.Paid, agent); err != nil {
			return teamBilling{}, err
		}
		o := billing.IssueOptions{Agent: &agent, Source: "TEAM"}
		if online != nil {
			o.Prepaid = online.Prepaid(true)
		}
		inv, err := s.IssueSubscriptionInvoice(ctx, hostelID, agent, o)
		if err != nil {
			return teamBilling{}, err
		}
		if online != nil && online.Paid {
			return teamBilling{}, s.SettleTeamPrepayment(ctx, online, inv, agent)
		}
		if err := s.MarkPastDue(ctx, inv); err != nil {
			return teamBilling{}, err
		}
		if online != nil {
			return teamBilling{}, t.reconcile(ctx, inv.ID)
		}
		return teamBilling{}, s.FileFieldCash(ctx, inv, amount, in.Payment.Reference, agent, agentName)
	}
	if err := s.SelectPlan(ctx, hostelID, in.Plan.PlanID, plans.Cycle(in.Plan.Cycle), false, true, agent); err != nil {
		return teamBilling{}, err
	}
	legacy := pre != nil && pre.IsPlan()
	var free *billing.Free
	if !legacy {
		var err error
		if free, err = s.StartFreeMonths(ctx, hostelID, &agent, time.Now()); err != nil {
			return teamBilling{}, err
		}
	}
	if free == nil {
		o := billing.IssueOptions{Agent: &agent, Source: "TEAM"}
		if legacy {
			o.Prepaid = pre.Prepaid(true)
		}
		inv, err := s.IssueSubscriptionInvoice(ctx, hostelID, agent, o)
		if err != nil {
			return teamBilling{}, err
		}
		if err := s.StartPlanPeriod(ctx, inv.SubscriptionID, inv.CycleMonths, inv.PeriodEnd, *inv.IssuedAt); err != nil {
			return teamBilling{}, err
		}
		if legacy && pre.Paid {
			if err := s.SettleTeamPrepayment(ctx, pre, inv, agent); err != nil {
				return teamBilling{}, err
			}
		} else {
			if err := s.MarkPastDue(ctx, inv); err != nil {
				return teamBilling{}, err
			}
			if legacy {
				if err := t.reconcile(ctx, inv.ID); err != nil {
					return teamBilling{}, err
				}
			}
		}
	}
	if legacy {
		return teamBilling{free: free}, nil
	}
	var prepaid *billing.Prepaid
	if pre != nil {
		amount, prepaid = pre.Amount, pre.Prepaid(false)
	}
	fee, err := s.IssueSetupFeeInvoice(ctx, hostelID, amount, agent, prepaid)
	if err != nil {
		return teamBilling{}, err
	}
	switch {
	case pre != nil && pre.Paid:
		err = s.SettleTeamPrepayment(ctx, pre, fee, agent)
	case pre != nil:
		err = t.reconcile(ctx, fee.ID)
	default:
		err = s.FileFieldCash(ctx, fee, amount, in.Payment.Reference, agent, agentName)
	}
	if err != nil {
		return teamBilling{}, err
	}
	return teamBilling{free: free, setupFee: fee.Amount}, nil
}

// reconcile is reconcileInvoiceFromSoftmato(...).catch(() => null): an unpaid
// prepayment's document may be paid any moment; a failed read is the webhook's job.
func (t *TeamRegistration) reconcile(ctx context.Context, invoiceID bson.ObjectID) error {
	if err := t.Settler.Reconcile(ctx, invoiceID); err != nil {
		slog.WarnContext(ctx, "team_prepayment_reconcile_failed", "invoiceId", invoiceID.Hex(), "error", err.Error())
	}
	return nil
}

// tellOwner is onRegisteredByTeam: "you're live", with Pay now for any balance.
func (t *TeamRegistration) tellOwner(ctx context.Context, in TeamReg, agentName string, paid int64, bill teamBilling, dueBy *time.Time, hostelID bson.ObjectID, slug string, outstanding int64, planName string) {
	if in.Applicant.Email == nil || *in.Applicant.Email == "" {
		return
	}
	base := strings.TrimRight(t.Settler.SiteURL, "/")
	listing := base + "/hostels/" + slug
	payURL := t.Settler.PlanPayLink(ctx, hostelID, base+"/"+url.PathEscape(slug)+"/admin/billing")
	due := ""
	if dueBy != nil {
		due = email.EmailDate(*dueBy)
	}
	var free *email.FreeTime
	if bill.free != nil {
		free = &email.FreeTime{Days: bill.free.TrialDays, Months: bill.free.FreeMonths, Until: email.EmailDate(bill.free.FreeUntil)}
	}
	var fee int64
	if v, ok := bill.setupFee.(int64); ok {
		fee = v
	}
	phone := ""
	if raw, err := t.Config.Section(ctx, "identity"); err == nil {
		var id struct {
			SupportPhone string `json:"supportPhone"`
		}
		if platformconfig.Decode(raw, &id) == nil {
			phone = id.SupportPhone
		}
	}
	m := email.HostelRegisteredByTeam(agentName, paid, payURL, due, free, in.Name, listing, outstanding, in.Applicant.Name, planName, fee, phone)
	t.Mail.Notify(ctx, email.Notification{Action: "hostel_registered_by_team", To: *in.Applicant.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
}

// placeOnMap is geocodeAndCacheHostel, best-effort: a hostel publishes whether or
// not the map providers answer.
func (t *TeamRegistration) placeOnMap(ctx context.Context, hostelID bson.ObjectID) {
	var row profileRow
	if err := t.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}}).Decode(&row); err != nil {
		return
	}
	(&Admin{DB: t.DB, Maps: t.Maps}).refreshGeo(ctx, hostelID, &row)
}

// seedRateCard is seedOpeningRateCard: the rents the form collected become the
// rate card, so the hostel can bill its first resident. Non-fatal and logged.
func (t *TeamRegistration) seedRateCard(ctx context.Context, hostelID bson.ObjectID, in Reg, agent bson.ObjectID) {
	if t.SeedRateCard == nil {
		return
	}
	var rates []OpeningRate
	for _, r := range in.Rooms {
		if strings.TrimSpace(r.RoomType) == "" || r.MonthlyRent == nil || *r.MonthlyRent <= 0 {
			continue
		}
		rates = append(rates, OpeningRate{RoomType: strings.TrimSpace(r.RoomType), Monthly: jsRound(*r.MonthlyRent)})
	}
	if len(rates) == 0 {
		return
	}
	num := func(v *float64) int64 {
		if v == nil {
			return 0
		}
		return jsRound(*v)
	}
	var admission, form *float64
	if v, ok := lookup(in.Pricing, "admissionFee"); ok {
		if f, ok := v.(float64); ok {
			admission = &f
		}
	}
	if v, ok := lookup(in.Pricing, "formFee"); ok {
		if f, ok := v.(float64); ok {
			form = &f
		}
	}
	if err := t.SeedRateCard(ctx, hostelID, num(admission), num(form), num(in.Deposit), num(in.RefDisc), rates, agent.Hex()); err != nil {
		slog.WarnContext(ctx, "registration_rate_card_skipped", "hostelId", hostelID.Hex(), "reason", err.Error())
	}
}

func jsRound(x float64) int64 { return int64(math.Floor(x + 0.5)) }
