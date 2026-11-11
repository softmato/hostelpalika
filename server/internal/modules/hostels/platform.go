package hostels

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Platform is /platform/hostels: the approval queue and a platform admin's hand
// on a hostel (hostel.service.ts, hostel-suspension.service.ts, hostel-purge).
type Platform struct {
	*Admin
	Settler *billing.Settler
	Issuer  *users.Issuer
	// SiteURL is APP_URL without a trailing slash: login, listing and billing links.
	SiteURL       string
	ProvisionCook func(ctx context.Context, hostel, actor bson.ObjectID) (*email.CookLogin, error)
	SendIDCard    func(ctx context.Context, user bson.ObjectID, cardType string)
	SeedRateCard  func(ctx context.Context, hostel bson.ObjectID, admission, form, deposit, referral int64, rates []OpeningRate, actor string) error
	// DuplicateCheck is runDuplicateCheck (listing-flags).
	DuplicateCheck func(ctx context.Context, hostel bson.ObjectID, actorID string) (any, error)
	Now            func() time.Time
}

func (p *Platform) Register(v1 *gin.RouterGroup) {
	e := httpx.ETag()
	staff := authz.Use(p.Guards.RequirePlatform)
	super := authz.Use(p.Guards.RequireSuperadmin)
	v1.GET("/platform/hostels", staff, e, p.list)
	v1.POST("/platform/hostels", staff, p.create)
	v1.POST("/platform/hostels/notice", super, p.notice)
	v1.GET("/platform/hostels/:id", staff, e, p.get)
	v1.DELETE("/platform/hostels/:id", super, p.purge)
	v1.PATCH("/platform/hostels/:id/approve", staff, p.approve)
	v1.PATCH("/platform/hostels/:id/reject", staff, p.reject)
	v1.PATCH("/platform/hostels/:id/request-documents", staff, p.requestDocuments)
	v1.PATCH("/platform/hostels/:id/publish", staff, p.publish)
	v1.PATCH("/platform/hostels/:id/unpublish", staff, p.unpublish)
	v1.PATCH("/platform/hostels/:id/archive", super, p.archive)
	v1.PATCH("/platform/hostels/:id/restore", super, p.restore)
	v1.PATCH("/platform/hostels/:id/suspend", super, p.suspend)
	v1.DELETE("/platform/hostels/:id/suspend", super, p.liftSuspension)
	v1.PATCH("/platform/hostels/:id/owner-email", super, p.ownerEmail)
	v1.PATCH("/platform/hostels/:id/owner-invite", super, p.ownerInvite)
	v1.POST("/platform/hostels/:id/recharge", super, p.recharge)
	v1.GET("/platform/hostels/:id/billing", staff, e, p.billingHistory)
	v1.GET("/platform/hostels/:id/agreement", super, p.agreement)
	v1.POST("/platform/hostels/:id/run-duplicate-check", staff, p.duplicateCheck)
}

func hostelErr404() error {
	return httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
}

func (p *Platform) now() time.Time { return p.Now().UTC().Truncate(time.Millisecond) }

func actorOf(c *gin.Context) (*authz.Principal, bson.ObjectID) {
	pr := authz.From(c)
	id, _ := bson.ObjectIDFromHex(pr.UserID)
	return pr, id
}

// auditHostel is auditHostelAction.
func (p *Platform) auditHostel(ctx context.Context, actor, hostel bson.ObjectID, action string, meta bson.D) error {
	if meta == nil {
		meta = bson.D{}
	}
	return p.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: hostel.Hex(), EntityType: "Hostel", HostelID: hostel, Metadata: meta})
}

// findHostel is findHostelByIdOrThrow.
func (p *Platform) findHostel(ctx context.Context, id bson.ObjectID, archived bool) (bson.Raw, error) {
	filter := bson.D{{Key: "_id", Value: id}}
	if !archived {
		filter = append(filter, bson.E{Key: "isDeleted", Value: false})
	}
	raw, err := p.DB.Collection("hostels").FindOne(ctx, filter).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, hostelErr404()
	}
	return raw, err
}

func (p *Platform) hostelID(c *gin.Context) (bson.ObjectID, bool) {
	id, err := NormalizeObjectID(c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return id, false
	}
	return id, true
}

func (p *Platform) serialize(raw bson.Raw) ordered.Map { return SerializeHostel(raw, time.Now()) }

// ---- the list and the review page ----

func (p *Platform) list(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	page := valid.Page(q, &is)
	archived := valid.QueryEnum(q, "archived", &is, "exclude", "only")
	status := valid.QueryEnum(q, "status", &is, "DRAFT", "PENDING_APPROVAL", "APPROVED", "PUBLISHED", "REJECTED", "SUSPENDED")
	verification := valid.QueryEnum(q, "verificationStatus", &is, "UNVERIFIED", "PENDING", "VERIFIED", "REJECTED")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "isDeleted", Value: archived != nil && *archived == "only"}}
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	if verification != nil {
		filter = append(filter, bson.E{Key: "verificationStatus", Value: *verification})
	}
	r := pagination.RangeOf(page)
	cur, err := p.DB.Collection("hostels").Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []bson.Raw
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := p.DB.Collection("hostels").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ids, owners, parents := bson.A{}, bson.A{}, bson.A{}
	oids := make([]bson.ObjectID, 0, len(rows))
	for _, h := range rows {
		d := hostelDoc{h}
		id, _ := d.oid("_id")
		ids, oids = append(ids, id), append(oids, id)
		if o, ok := d.oid("ownerId"); ok {
			owners = append(owners, o)
		}
		if pid, ok := d.oid("parentHostelId"); ok {
			parents = append(parents, pid)
		}
	}
	ownerBy, err := p.contacts(c, owners, "Unnamed owner")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	apps, err := p.latestApplications(c, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	parentBy := map[bson.ObjectID]bson.Raw{}
	if len(parents) > 0 {
		cur, err := p.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: parents}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "panNumber", Value: 1}, {Key: "slug", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var ps []bson.Raw
		if err := cur.All(c, &ps); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, pr := range ps {
			id, _ := hostelDoc{pr}.oid("_id")
			parentBy[id] = pr
		}
	}
	portals, err := p.portalActivity(c, oids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, 0, len(rows))
	for i, h := range rows {
		d := hostelDoc{h}
		row := p.serialize(h)
		app := apps[oids[i]]
		appStatus, submitted := "", any(nil)
		if app != nil {
			appStatus, submitted = app.status, app.submittedAt
		} else if t, ok := d.val("createdAt").TimeOK(); ok {
			submitted = httpx.ISO(t)
		}
		var branchOf any
		if pid, ok := d.oid("parentHostelId"); ok {
			if pr, ok := parentBy[pid]; ok {
				pd := hostelDoc{pr}
				var pan any
				if v := pd.val("panNumber"); !nullish(v) {
					pan = pd.str("panNumber")
				}
				branchOf = ordered.Map{{Key: "id", Value: pid.Hex()}, {Key: "name", Value: pd.str("name")}, {Key: "panNumber", Value: pan}, {Key: "slug", Value: pd.str("slug")}}
			}
		}
		var owner any
		if o, ok := d.oid("ownerId"); ok {
			if m, ok := ownerBy[o]; ok {
				owner = ordered.Map{{Key: "email", Value: m.Email}, {Key: "name", Value: m.Name}, {Key: "phone", Value: m.Phone}}
			}
		}
		row = append(row, ordered.Map{{Key: "applicationStatus", Value: appStatus}, {Key: "branchOf", Value: branchOf}, {Key: "owner", Value: owner},
			{Key: "portals", Value: portals[oids[i]]}, {Key: "submittedAt", Value: submitted}}...)
		out = append(out, row)
	}
	httpx.OK(c, ordered.Map{{Key: "hostels", Value: out}, {Key: "pagination", Value: pagination.MetaOf(page, int(total))}}, "Hostel applications loaded")
}

type contact struct {
	ID           bson.ObjectID
	Email, Name  string
	Phone, Role  string
	RegisteredAt any
}

func (p *Platform) contacts(ctx context.Context, ids bson.A, unnamed string) (map[bson.ObjectID]contact, error) {
	out := map[bson.ObjectID]contact{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := p.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}},
		options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "email", Value: 1}, {Key: "phone", Value: 1}, {Key: "role", Value: 1}, {Key: "createdAt", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID        bson.ObjectID `bson:"_id"`
		Email     *string       `bson:"email"`
		Name      *string       `bson:"name"`
		Phone     *string       `bson:"phone"`
		Role      *string       `bson:"role"`
		CreatedAt *time.Time    `bson:"createdAt"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	or := func(s *string, d string) string {
		if s == nil {
			return d
		}
		return *s
	}
	for _, r := range rows {
		var at any
		if r.CreatedAt != nil {
			at = httpx.ISO(*r.CreatedAt)
		}
		out[r.ID] = contact{ID: r.ID, Email: or(r.Email, ""), Name: or(r.Name, unnamed), Phone: or(r.Phone, ""), Role: or(r.Role, "PUBLIC"), RegisteredAt: at}
	}
	return out, nil
}

type appSummary struct {
	status      string
	submittedAt any
}

func (p *Platform) latestApplications(ctx context.Context, ids bson.A) (map[bson.ObjectID]*appSummary, error) {
	out := map[bson.ObjectID]*appSummary{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := p.DB.Collection("hostelapplications").Find(ctx, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: false}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "status", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		HostelID  bson.ObjectID `bson:"hostelId"`
		CreatedAt *time.Time    `bson:"createdAt"`
		Status    string        `bson:"status"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		if out[r.HostelID] != nil {
			continue
		}
		var at any
		if r.CreatedAt != nil {
			at = httpx.ISO(*r.CreatedAt)
		}
		out[r.HostelID] = &appSummary{r.Status, at}
	}
	return out, nil
}

var portalRoles = []string{"HOSTEL_ADMIN", "WARDEN", "COOK", "RESIDENT", "GUARDIAN"}

// portalActivity is hostelPortalActivity: per hostel and portal, the logins and how
// many have been opened. Two queries for a whole page.
func (p *Platform) portalActivity(ctx context.Context, hostels []bson.ObjectID) (map[bson.ObjectID][]ordered.Map, error) {
	out := map[bson.ObjectID][]ordered.Map{}
	if len(hostels) == 0 {
		return out, nil
	}
	cur, err := p.DB.Collection("users").Find(ctx, bson.D{{Key: "hostelIds", Value: bson.D{{Key: "$in", Value: hostels}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "role", Value: bson.D{{Key: "$in", Value: portalRoles}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}},
		options.Find().SetProjection(bson.D{{Key: "hostelIds", Value: 1}, {Key: "lastLoginAt", Value: 1}, {Key: "role", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var us []struct {
		ID          bson.ObjectID   `bson:"_id"`
		HostelIDs   []bson.ObjectID `bson:"hostelIds"`
		LastLoginAt *time.Time      `bson:"lastLoginAt"`
		Role        string          `bson:"role"`
	}
	if err := cur.All(ctx, &us); err != nil {
		return nil, err
	}
	sessionAt := map[bson.ObjectID]int64{}
	if len(us) > 0 {
		ids := bson.A{}
		for _, u := range us {
			ids = append(ids, u.ID)
		}
		cur, err := p.DB.Collection("sessions").Aggregate(ctx, bson.A{
			bson.D{{Key: "$match", Value: bson.D{{Key: "userId", Value: bson.D{{Key: "$in", Value: ids}}}}}},
			bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$userId"}, {Key: "at", Value: bson.D{{Key: "$max", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$lastSeenAt", "$createdAt"}}}}}}}}},
		})
		if err != nil {
			return nil, err
		}
		var rows []struct {
			ID bson.ObjectID `bson:"_id"`
			At *time.Time    `bson:"at"`
		}
		if err := cur.All(ctx, &rows); err != nil {
			return nil, err
		}
		for _, r := range rows {
			if r.At != nil {
				sessionAt[r.ID] = r.At.UnixMilli()
			}
		}
	}
	for _, h := range hostels {
		list := make([]ordered.Map, 0, len(portalRoles))
		for _, role := range portalRoles {
			accounts, opened := 0, 0
			var last int64
			for _, u := range us {
				if u.Role != role || !containsID(u.HostelIDs, h) {
					continue
				}
				accounts++
				at := sessionAt[u.ID]
				if u.LastLoginAt != nil && u.LastLoginAt.UnixMilli() > at {
					at = u.LastLoginAt.UnixMilli()
				}
				if at > 0 {
					opened++
					last = max(last, at)
				}
			}
			var lastAt any
			if opened > 0 {
				lastAt = httpx.ISO(time.UnixMilli(last))
			}
			list = append(list, ordered.Map{{Key: "accounts", Value: accounts}, {Key: "lastOpenedAt", Value: lastAt}, {Key: "opened", Value: opened}, {Key: "role", Value: role}})
		}
		out[h] = list
	}
	return out, nil
}

func containsID(list []bson.ObjectID, id bson.ObjectID) bool {
	for _, x := range list {
		if x == id {
			return true
		}
	}
	return false
}

func (p *Platform) get(c *gin.Context) {
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	h, err := p.findHostel(c, id, true)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var app bson.Raw
	if err := p.DB.Collection("hostelapplications").FindOne(c, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&app); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	cur, err := p.DB.Collection("hosteldocuments").Find(c, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var docs []bson.Raw
	if err := cur.All(c, &docs); err != nil {
		httpx.Fail(c, err)
		return
	}
	assetIDs := bson.A{}
	for _, d := range docs {
		if a, ok := (hostelDoc{d}).oid("fileAssetId"); ok {
			assetIDs = append(assetIDs, a)
		}
	}
	type asset struct {
		ID       bson.ObjectID `bson:"_id"`
		FileName string        `bson:"fileName"`
		MimeType string        `bson:"mimeType"`
	}
	assetBy := map[bson.ObjectID]asset{}
	if len(assetIDs) > 0 {
		cur, err := p.DB.Collection("fileassets").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: assetIDs}}}}, options.Find().SetProjection(bson.D{{Key: "fileName", Value: 1}, {Key: "mimeType", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var as []asset
		if err := cur.All(c, &as); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, a := range as {
			assetBy[a.ID] = a
		}
	}
	hd := hostelDoc{h}
	ownerID, _ := hd.oid("ownerId")
	ids := bson.A{ownerID}
	var applicant, submitter bson.ObjectID
	if app != nil {
		ad := hostelDoc{app}
		applicant, _ = ad.oid("applicantId")
		submitter, _ = ad.oid("submittedBy")
		ids = append(ids, applicant, submitter)
	}
	who, err := p.contacts(c, ids, "Unnamed user")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	contactOut := func(id bson.ObjectID) any {
		m, ok := who[id]
		if !ok {
			return nil
		}
		return ordered.Map{{Key: "email", Value: m.Email}, {Key: "id", Value: m.ID.Hex()}, {Key: "name", Value: m.Name}, {Key: "phone", Value: m.Phone}, {Key: "registeredAt", Value: m.RegisteredAt}, {Key: "role", Value: m.Role}}
	}
	docsOut := make([]ordered.Map, 0, len(docs))
	for _, d := range docs {
		row := documentOut(d)
		name, mime := "", ""
		if a, ok := (hostelDoc{d}).oid("fileAssetId"); ok {
			name, mime = assetBy[a].FileName, assetBy[a].MimeType
		}
		docsOut = append(docsOut, append(row, ordered.Map{{Key: "fileName", Value: name}, {Key: "mimeType", Value: mime}}...))
	}
	var branchOf any
	if pid, ok := hd.oid("parentHostelId"); ok {
		if branchOf, err = p.parentSummary(c, pid); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	portals, err := p.portalActivity(c, []bson.ObjectID{id})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var appOut, applicantOut, submitterOut any
	if app != nil {
		appOut, applicantOut, submitterOut = applicationOut(app), contactOut(applicant), contactOut(submitter)
	}
	httpx.OK(c, ordered.Map{{Key: "application", Value: appOut}, {Key: "applicant", Value: applicantOut}, {Key: "documents", Value: docsOut}, {Key: "branchOf", Value: branchOf},
		{Key: "hostel", Value: p.serialize(h)}, {Key: "owner", Value: contactOut(ownerID)}, {Key: "portals", Value: portals[id]}, {Key: "submitter", Value: submitterOut}}, "Hostel application loaded")
}

// documentOut is serializeHostelDocument.
func documentOut(raw bson.Raw) ordered.Map {
	d := hostelDoc{raw}
	var created, asset any
	if t, ok := d.val("createdAt").TimeOK(); ok {
		created = httpx.ISO(t)
	}
	if a, ok := d.oid("fileAssetId"); ok {
		asset = a.Hex()
	}
	return ordered.Map{{Key: "createdAt", Value: created}, {Key: "documentType", Value: d.str("documentType")}, {Key: "fileAssetId", Value: asset}, {Key: "fileUrl", Value: d.str("fileUrl")},
		{Key: "id", Value: d.id()}, {Key: "rejectionReason", Value: d.str("rejectionReason")}, {Key: "status", Value: d.str("status")}}
}

// parentSummary is branchParentSummary: the main hostel a branch is reviewed against.
func (p *Platform) parentSummary(ctx context.Context, parent bson.ObjectID) (any, error) {
	var h struct {
		Contact struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
		Name string  `bson:"name"`
		PAN  *string `bson:"panNumber"`
		Slug string  `bson:"slug"`
	}
	if err := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: parent}}).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	var payout struct {
		Holder *string `bson:"holderName"`
		Status string  `bson:"status"`
	}
	if err := p.DB.Collection("hostelpayoutaccounts").FindOne(ctx, bson.D{{Key: "hostelId", Value: parent}}).Decode(&payout); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var pan, holder any
	if h.PAN != nil {
		pan = *h.PAN
	}
	if payout.Holder != nil {
		holder = *payout.Holder
	}
	return ordered.Map{{Key: "id", Value: parent.Hex()}, {Key: "name", Value: h.Name}, {Key: "panNumber", Value: pan}, {Key: "payoutHolder", Value: holder},
		{Key: "payoutVerified", Value: payout.Status == "VERIFIED"}, {Key: "phone", Value: h.Contact.Phone}, {Key: "slug", Value: h.Slug}}, nil
}

// ---- owner contact ----

type ownerInfo struct {
	ID         bson.ObjectID
	Email      string
	Name       string
	Role       string
	HostelIDs  []bson.ObjectID
	HostelName string
}

// resolveOwner is resolveHostelOwner: nil when the owner has no email to write to.
func (p *Platform) resolveOwner(ctx context.Context, hostel bson.ObjectID) (*ownerInfo, error) {
	var h struct {
		OwnerID *bson.ObjectID `bson:"ownerId"`
		Name    *string        `bson:"name"`
	}
	if err := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}).Decode(&h); err != nil || h.OwnerID == nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = nil
		}
		return nil, err
	}
	var u struct {
		Email     string          `bson:"email"`
		Name      string          `bson:"name"`
		Role      string          `bson:"role"`
		HostelIDs []bson.ObjectID `bson:"hostelIds"`
	}
	if err := p.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *h.OwnerID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u); err != nil || u.Email == "" {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = nil
		}
		return nil, err
	}
	name := "your hostel"
	if h.Name != nil {
		name = *h.Name
	}
	return &ownerInfo{ID: *h.OwnerID, Email: u.Email, Name: u.Name, Role: u.Role, HostelIDs: u.HostelIDs, HostelName: name}, nil
}

// notifyOwner is notifyHostelOwner: the owner's email, and what happened to it
// (the response carries it so the admin knows whether the owner was told).
func (p *Platform) notifyOwner(ctx context.Context, hostel bson.ObjectID, action string, build func(o *ownerInfo) email.Content) (ordered.Map, error) {
	o, err := p.resolveOwner(ctx, hostel)
	if err != nil {
		return nil, err
	}
	if o == nil {
		slog.WarnContext(ctx, action+"_email_skipped", "hostelId", hostel.Hex(), "message", "Hostel has no resolvable owner email; owner was not notified.")
		return ordered.Map{{Key: "reason", Value: "no_owner_email"}, {Key: "sent", Value: false}}, nil
	}
	m := build(o)
	r := p.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{o.Email}, Subject: m.Subject, HTML: m.HTML})
	if r.Sent {
		return ordered.Map{{Key: "sent", Value: true}, {Key: "to", Value: o.Email}}, nil
	}
	slog.WarnContext(ctx, action+"_email_failed", "hostelId", hostel.Hex(), "reason", r.Reason, "to", o.Email)
	return ordered.Map{{Key: "reason", Value: r.Reason}, {Key: "sent", Value: false}, {Key: "to", Value: o.Email}}, nil
}

// bell is notifyHostelOwnerOf: a HIGH in-app notice for the owner. Never fails the caller.
func (p *Platform) bell(ctx context.Context, user, hostel bson.ObjectID, actionURL, body, title, kind string) {
	_, _ = p.Notify.CreateInApp(ctx, notifications.Input{ActionURL: actionURL, Body: body, Category: "GENERAL", Data: ordered.Map{{Key: "hostelId", Value: hostel.Hex()}, {Key: "type", Value: kind}},
		HostelID: hostel.Hex(), Priority: "HIGH", Title: title, UserID: user.Hex()})
}

func (p *Platform) loginURL() string  { return p.SiteURL + "/login" }
func (p *Platform) statusURL() string { return p.SiteURL + "/register-hostel/form" }
func (p *Platform) listing(slug string) string {
	return p.SiteURL + "/hostels/" + slug
}
func (p *Platform) billingURL(slug string) string {
	return p.SiteURL + "/" + url.PathEscape(slug) + "/admin/billing"
}
