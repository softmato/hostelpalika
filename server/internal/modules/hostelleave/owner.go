package hostelleave

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Owner is the hostel owner's form to leave the platform: /hostel-admin/leave.
type Owner struct {
	*Handler
	Notify *notifications.Service
	RT     *realtime.Client
	Cache  realtime.Bumper
	// HoldBounds is the operations config's leaveHoldMinDays and leaveHoldMaxDays.
	HoldBounds func(context.Context) (min, max int)
}

func (o *Owner) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-admin/leave", authz.Use(o.Guards.RequireHostelAdmin))
	g.GET("", o.overview)
	g.POST("", o.submit)
	g.DELETE("", o.cancel)
}

type blocker struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type leaveFacts struct {
	claimInReview bool
	openOrders    int64
	owed          float64
	pastDue       bool
}

// blockersOf is leaveBlockers: plain words for what stands between the hostel and leaving.
func blockersOf(f leaveFacts) []blocker {
	out := []blocker{}
	switch {
	case f.claimInReview:
		out = append(out, blocker{"PLAN_CLAIM_IN_REVIEW", "We are still checking a plan payment you sent. You can leave once it is confirmed."})
	case f.owed > 0:
		out = append(out, blocker{"PLAN_BILL_OPEN", "Your plan bill of Rs " + money.GroupIN(int64(f.owed)) + " is not paid yet. Pay it on Billing first."})
	case f.pastDue:
		out = append(out, blocker{"PLAN_PAST_DUE", "Your plan is overdue. Pay it on Billing first."})
	}
	if f.openOrders == 1 {
		out = append(out, blocker{"STORE_ORDER_OPEN", "You have a supply store order that is not delivered and paid yet."})
	} else if f.openOrders > 1 {
		out = append(out, blocker{"STORE_ORDER_OPEN", fmt.Sprintf("You have %d supply store orders that are not delivered and paid yet.", f.openOrders)})
	}
	return out
}

type planState struct {
	Status           string     `bson:"status"`
	CurrentPeriodEnd *time.Time `bson:"currentPeriodEnd"`
	LifetimeSince    *time.Time `bson:"lifetimeSince"`
}

type openBill struct {
	ID          bson.ObjectID `bson:"_id"`
	Amount      float64       `bson:"amount"`
	Kind        string        `bson:"kind"`
	Lifetime    bool          `bson:"lifetime"`
	outstanding float64
}

// owedOnPlan: a bill is a debt only when it pays for time the hostel already had. A
// setup fee always is; a plan bill only once the plan has lapsed; a lifetime checkout never.
func owedOnPlan(bills []openBill, plan *planState, now time.Time) float64 {
	lapsed := plan != nil && (plan.Status == "PAST_DUE" ||
		(plan.Status == "ACTIVE" && plan.LifetimeSince == nil && plan.CurrentPeriodEnd != nil && plan.CurrentPeriodEnd.Before(now)))
	owed := 0.0
	for _, b := range bills {
		if b.Kind == "SETUP_FEE" || (lapsed && !b.Lifetime) {
			owed += b.outstanding
		}
	}
	return owed
}

// facts is loadLeaveFacts. Plan bills live on the billing hostel (a branch's are its
// main's); store orders on each building that is leaving.
func (o *Owner) facts(ctx context.Context, hostelID bson.ObjectID, buildings bson.A) (leaveFacts, error) {
	var f leaveFacts
	payer, err := billing.BillingHostelID(ctx, o.DB, hostelID)
	if err != nil {
		return f, err
	}
	cur, err := o.DB.Collection("subscriptioninvoices").Find(ctx, bson.D{{Key: "hostelId", Value: payer}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL"}}}}},
		options.Find().SetProjection(bson.D{{Key: "amount", Value: 1}, {Key: "kind", Value: 1}, {Key: "lifetime", Value: 1}}).SetLimit(500))
	if err != nil {
		return f, err
	}
	var bills []openBill
	if err := cur.All(ctx, &bills); err != nil {
		return f, err
	}
	ids := make(bson.A, 0, len(bills))
	for _, b := range bills {
		ids = append(ids, b.ID)
	}
	if len(ids) > 0 {
		// One aggregate, where TS asked once per invoice.
		cur, err := o.DB.Collection("subscriptionpayments").Aggregate(ctx, bson.A{
			bson.D{{Key: "$match", Value: bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "SETTLED"}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$invoiceId"}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
		})
		if err != nil {
			return f, err
		}
		var settled []struct {
			ID    bson.ObjectID `bson:"_id"`
			Total float64       `bson:"total"`
		}
		if err := cur.All(ctx, &settled); err != nil {
			return f, err
		}
		paid := make(map[bson.ObjectID]float64, len(settled))
		for _, s := range settled {
			paid[s.ID] = s.Total
		}
		for i := range bills {
			if left := bills[i].Amount - paid[bills[i].ID]; left > 0 {
				bills[i].outstanding = left
			}
		}
	}
	var plan *planState
	var row planState
	err = o.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: payer}},
		options.FindOne().SetProjection(bson.D{{Key: "status", Value: 1}, {Key: "currentPeriodEnd", Value: 1}, {Key: "lifetimeSince", Value: 1}})).Decode(&row)
	if err == nil {
		plan = &row
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		return f, err
	}
	f.openOrders, err = o.DB.Collection("storeorders").CountDocuments(ctx, bson.D{
		{Key: "$or", Value: bson.A{bson.D{{Key: "status", Value: bson.D{{Key: "$nin", Value: bson.A{"DELIVERED", "CANCELLED"}}}}}, bson.D{{Key: "paymentStatus", Value: "PENDING"}, {Key: "status", Value: "DELIVERED"}}}},
		{Key: "hostelId", Value: bson.D{{Key: "$in", Value: buildings}}}})
	if err != nil {
		return f, err
	}
	f.owed = owedOnPlan(bills, plan, time.Now())
	f.pastDue = plan != nil && plan.Status == "PAST_DUE"
	if f.owed > 0 {
		err := o.DB.Collection("subscriptionpayments").FindOne(ctx, bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "IN_REVIEW"}},
			options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
		if err == nil {
			f.claimInReview = true
		} else if !errors.Is(err, mongo.ErrNoDocuments) {
			return f, err
		}
	}
	return f, nil
}

type ownedHostel struct {
	ID       bson.ObjectID  `bson:"_id"`
	Name     string         `bson:"name"`
	OwnerID  *bson.ObjectID `bson:"ownerId"`
	ParentID *bson.ObjectID `bson:"parentHostelId"`
}

// ownedHostel: only the owner. A warden runs the hostel, it is not theirs to take away.
func (o *Owner) ownedHostel(ctx context.Context, p *authz.Principal, requested string) (*ownedHostel, error) {
	id, err := hostels.AdminHostel(p, requested)
	if err != nil {
		return nil, err
	}
	if _, err := hostels.ResolveOwned(ctx, o.DB, id.Hex(), p.UserID); err != nil {
		return nil, err
	}
	var h ownedHostel
	err = o.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "ownerId", Value: 1}, {Key: "parentHostelId", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(404, "HOSTEL_NOT_FOUND", "Hostel was not found.")
	}
	return &h, err
}

type branchRow struct {
	ID   bson.ObjectID `bson:"_id" json:"-"`
	Name string        `bson:"name" json:"-"`
}

// branchesOf is liveBranches: they leave with their main hostel. A branch has none.
func (o *Owner) branchesOf(ctx context.Context, h *ownedHostel) ([]branchRow, bson.A, error) {
	buildings := bson.A{h.ID}
	if h.ParentID != nil {
		return nil, buildings, nil
	}
	cur, err := o.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "parentHostelId", Value: h.ID}},
		options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}).SetLimit(200))
	if err != nil {
		return nil, nil, err
	}
	var rows []branchRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, nil, err
	}
	for _, b := range rows {
		buildings = append(buildings, b.ID)
	}
	return rows, buildings, nil
}

type branchOut struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type overviewOut struct {
	Blockers []blocker   `json:"blockers"`
	Branches []branchOut `json:"branches"`
	CanLeave bool        `json:"canLeave"`
	Hold     struct {
		Max int `json:"max"`
		Min int `json:"min"`
	} `json:"hold"`
	Hostel struct {
		ID       string `json:"id"`
		IsBranch bool   `json:"isBranch"`
		Name     string `json:"name"`
	} `json:"hostel"`
	Request any `json:"request"`
}

func (o *Owner) overview(c *gin.Context) {
	h, err := o.ownedHostel(c, authz.From(c), c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	branches, buildings, err := o.branchesOf(c, h)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	facts, err := o.facts(c, h.ID, buildings)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var out overviewOut
	var pending request
	err = o.DB.Collection("hostelleaverequests").FindOne(c, bson.D{{Key: "hostelId", Value: h.ID}, {Key: "status", Value: "PENDING"}}).Decode(&pending)
	switch {
	case err == nil:
		out.Request = pending.serialized()
	case !errors.Is(err, mongo.ErrNoDocuments):
		httpx.Fail(c, err)
		return
	}
	out.Blockers = blockersOf(facts)
	out.Branches = make([]branchOut, 0, len(branches))
	for _, b := range branches {
		out.Branches = append(out.Branches, branchOut{b.ID.Hex(), b.Name})
	}
	out.CanLeave = len(out.Blockers) == 0 && out.Request == nil
	out.Hold.Min, out.Hold.Max = o.HoldBounds(c)
	out.Hostel.ID, out.Hostel.IsBranch, out.Hostel.Name = h.ID.Hex(), h.ParentID != nil, h.Name
	httpx.OK(c, out, "Leave status loaded")
}

type requestWrap struct {
	Request ordered.Map `json:"request"`
}

func (o *Owner) submit(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	if f.M["confirm"] != true {
		f.Is.Add("confirm", "Please confirm you understand.")
	}
	holdDays, _ := f.Num("holdDays", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(60)})
	requested, _ := f.Str("hostelId", valid.S{Opt: true, Re: objectIDRe, ReMsg: "Invalid id."})
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, MinMsg: "Tell us why you are leaving.", Max: 1000})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	h, err := o.ownedHostel(c, p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	_, buildings, err := o.branchesOf(c, h)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	facts, err := o.facts(c, h.ID, buildings)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if blockers := blockersOf(facts); len(blockers) > 0 {
		httpx.Fail(c, fail(409, blockers[0].Code, blockers[0].Message))
		return
	}
	lo, hi := o.HoldBounds(c)
	if int(holdDays) < lo || int(holdDays) > hi {
		httpx.Fail(c, fail(422, "LEAVE_HOLD_OUT_OF_RANGE", "Choose between "+strconv.Itoa(lo)+" and "+strconv.Itoa(hi)+" days."))
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ownerID := actor
	if h.OwnerID != nil {
		ownerID = *h.OwnerID
	}
	var owner struct {
		Email string  `bson:"email"`
		Name  *string `bson:"name"`
	}
	if err := o.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: ownerID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}})).Decode(&owner); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	created := request{ID: bson.NewObjectID(), HoldDays: int(holdDays), HostelID: h.ID, HostelName: h.Name, OwnerEmail: owner.Email, OwnerName: owner.Name, Reason: reason, RequestedAt: now, Status: "PENDING"}
	doc := bson.D{{Key: "_id", Value: created.ID}, {Key: "hostelId", Value: h.ID}, {Key: "requestedBy", Value: actor}, {Key: "reason", Value: reason}, {Key: "holdDays", Value: created.HoldDays}, {Key: "status", Value: "PENDING"},
		{Key: "hostelName", Value: h.Name}, {Key: "requestedAt", Value: now}, {Key: "exportSections", Value: bson.A{}}, {Key: "keptFiles", Value: bson.A{}}, {Key: "exportFiles", Value: bson.A{}}, {Key: "branchIds", Value: bson.A{}}, {Key: "zipDownloads", Value: bson.A{}},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}
	if owner.Email != "" {
		doc = append(doc, bson.E{Key: "ownerEmail", Value: owner.Email})
	}
	if owner.Name != nil {
		doc = append(doc, bson.E{Key: "ownerName", Value: *owner.Name})
	}
	if _, err := o.DB.Collection("hostelleaverequests").InsertOne(c, doc); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			err = fail(409, "LEAVE_ALREADY_PENDING", "A request to leave is already waiting for review.")
		}
		httpx.Fail(c, err)
		return
	}
	o.audited(c, actor, h.ID, "HOSTEL_LEAVE_REQUESTED", bson.D{{Key: "holdDays", Value: created.HoldDays}, {Key: "requestId", Value: created.ID.Hex()}})
	o.notifyPlatform(c, &created)
	if owner.Email != "" {
		name := ""
		if owner.Name != nil {
			name = *owner.Name
		}
		m := email.HostelLeaveRequested(created.HoldDays, h.Name, name, o.AppURL("/hostel-admin/leave"))
		o.Mail.Notify(c, email.Notification{Action: "hostel_leave_requested", To: owner.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
	}
	httpx.OK(c, requestWrap{created.serialized()}, "Request to leave sent")
}

// notifyPlatform is notifyPlatformOfLeave: approving is a superadmin's call alone.
func (o *Owner) notifyPlatform(ctx context.Context, r *request) {
	cur, err := o.DB.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "email", Value: 1}}).SetLimit(100))
	if err != nil {
		return
	}
	var staff []struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
	}
	if cur.All(ctx, &staff) != nil {
		return
	}
	path := "/platform/hostel-leaves?request=" + r.ID.Hex()
	name := ""
	if r.OwnerName != nil {
		name = *r.OwnerName
	}
	m := email.HostelLeavePending(r.HoldDays, r.HostelName, r.OwnerEmail, name, o.AppURL(path), r.Reason)
	for _, s := range staff {
		if s.Email != "" {
			o.Mail.Notify(ctx, email.Notification{Action: "platform_hostel_leave", To: s.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
		}
		_, _ = o.Notify.CreateInApp(ctx, notifications.Input{ActionURL: path, Body: r.HostelName + " asked to leave HostelPalika.", Category: "HOSTEL_APPROVAL",
			Data: ordered.Map{{Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "requestId", Value: r.ID.Hex()}}, Kind: "ACTION", Priority: "HIGH", Title: "Hostel wants to leave", UserID: s.ID.Hex()})
	}
	realtime.PublishResourceChange(ctx, o.RT, o.Cache, realtime.Change{Platform: true, Topics: []realtime.Topic{realtime.Hostels}})
}

func (o *Owner) audited(ctx context.Context, actor, hostelID bson.ObjectID, action string, meta bson.D) {
	_ = o.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: hostelID.Hex(), EntityType: "Hostel", HostelID: hostelID, Metadata: meta})
}

func (o *Owner) cancel(c *gin.Context) {
	p := authz.From(c)
	h, err := o.ownedHostel(c, p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var row request
	err = o.DB.Collection("hostelleaverequests").FindOneAndUpdate(c, bson.D{{Key: "hostelId", Value: h.ID}, {Key: "reviewedAt", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "cancelledAt", Value: now}, {Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		err = fail(409, "LEAVE_NOT_PENDING", "There is no waiting request to cancel.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	o.audited(c, actor, h.ID, "HOSTEL_LEAVE_CANCELLED", bson.D{{Key: "requestId", Value: row.ID.Hex()}})
	realtime.PublishResourceChange(c, o.RT, o.Cache, realtime.Change{Platform: true, Topics: []realtime.Topic{realtime.Hostels}})
	httpx.OK(c, requestWrap{row.serialized()}, "Request cancelled")
}
