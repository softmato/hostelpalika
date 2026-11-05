// Package residentportal is the resident's home: the dashboard and the profile,
// which read across hostels, finance, notices, complaints, safety and food.
package residentportal

import (
	"context"
	"golang.org/x/sync/errgroup"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/complaints"
	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/food"
	"github.com/softmato/hostelpalika/server/internal/modules/notices"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/safety"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Cache  *cache.Cache
	Safety *safety.Service
	Notify *notifications.Service
	Audit  *audit.Log
	Config *platformconfig.Service
	RT     *realtime.Client
	Bump   realtime.Bumper
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/resident/dashboard", h.dashboard)
	v1.GET("/resident/me", httpx.ETag(), h.profile)
	v1.GET("/resident/profile", httpx.ETag(), h.profile)
	h.registerExtras(v1)
}

func (h *Handler) hostel(ctx context.Context, id bson.ObjectID) (any, error) {
	var raw bson.Raw
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	or := func(key string) any {
		if v, err := raw.LookupErr(key); err == nil && v.Type != bson.TypeNull {
			return ordered.FromBSON(v)
		}
		return ordered.Map{}
	}
	photo := ""
	if arr, ok := raw.Lookup("photos").ArrayOK(); ok {
		vals, _ := arr.Values()
		first := ""
		for i, v := range vals {
			d, ok := v.DocumentOK()
			if !ok {
				continue
			}
			url, _ := d.Lookup("url").StringValueOK()
			kind, _ := d.Lookup("kind").StringValueOK()
			if i == 0 {
				first = url
			}
			if kind == "EXTERIOR" && url != "" {
				photo = url
				break
			}
		}
		if photo == "" {
			photo = first
		}
	}
	name, _ := raw.Lookup("name").StringValueOK()
	slug, _ := raw.Lookup("slug").StringValueOK()
	return ordered.Map{{Key: "contact", Value: or("contact")}, {Key: "id", Value: id.Hex()}, {Key: "location", Value: or("location")}, {Key: "name", Value: name},
		{Key: "photoUrl", Value: photo}, {Key: "slug", Value: slug}}, nil
}

type accommodation struct {
	RoomType string `json:"roomType"`
}

func serializePayment(p *finance.LedgerInvoice) ordered.Map {
	due := any(ordered.Undefined)
	if p.DueDate != nil {
		due = httpx.ISO(*p.DueDate)
	}
	var month any
	if p.Period != nil {
		month = *p.Period
	}
	return ordered.Map{{Key: "dueAmount", Value: p.DueAmount}, {Key: "dueDate", Value: due}, {Key: "id", Value: p.ID}, {Key: "month", Value: month}, {Key: "paidAmount", Value: p.PaidAmount}, {Key: "status", Value: p.Status}}
}

func pickNextDue(unsettled []finance.LedgerInvoice) *finance.LedgerInvoice {
	var best *finance.LedgerInvoice
	for i := range unsettled {
		x := &unsettled[i]
		if x.DueDate != nil && (best == nil || x.DueDate.Before(*best.DueDate)) {
			best = x
		}
	}
	if best != nil {
		return best
	}
	millis := func(t *time.Time) int64 {
		if t == nil {
			return 0
		}
		return t.UnixMilli()
	}
	for i := range unsettled {
		x := &unsettled[i]
		if best == nil || millis(x.CreatedAt) < millis(best.CreatedAt) {
			best = x
		}
	}
	return best
}

func feeSummary(payments, unsettled []finance.LedgerInvoice) ordered.Map {
	var due int64
	pending := 0
	for _, x := range unsettled {
		if d := x.DueAmount - x.PaidAmount; d > 0 {
			due += d
		}
		if x.Status == "PENDING_PROOF" {
			pending++
		}
	}
	var latest, next any
	if len(payments) > 0 {
		latest = serializePayment(&payments[0])
	}
	if n := pickNextDue(unsettled); n != nil {
		next = serializePayment(n)
	}
	return ordered.Map{{Key: "dueAmount", Value: due}, {Key: "latestPayment", Value: latest}, {Key: "nextDue", Value: next}, {Key: "pendingProofs", Value: pending}, {Key: "unpaidCount", Value: len(unsettled)}}
}

type noticeOut struct {
	Category    string `json:"category"`
	Content     string `json:"content"`
	ID          string `json:"id"`
	IsRead      bool   `json:"isRead"`
	IsUrgent    bool   `json:"isUrgent"`
	PublishedAt any    `json:"publishedAt,omitempty"`
	Title       string `json:"title"`
}

type dashboardBody struct {
	Accommodation accommodation      `json:"accommodation"`
	Complaints    complaints.Summary `json:"complaints"`
	FeeStatus     ordered.Map        `json:"feeStatus"`
	FoodMenu      []any              `json:"foodMenu"`
	Hostel        any                `json:"hostel"`
	NightStatus   ordered.Map        `json:"nightStatus"`
	Notices       []noticeOut        `json:"notices"`
	Resident      ordered.Map        `json:"resident"`
	SOS           any                `json:"sos"`
}

type dashboardOut struct {
	Dashboard dashboardBody `json:"dashboard"`
}

func (h *Handler) dashboard(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, "resident-dashboard", "Resident dashboard loaded", func() (dashboardOut, error) {
		return h.loadDashboard(c, p)
	})
}

func (h *Handler) loadDashboard(c *gin.Context, p *authz.Principal) (dashboardOut, error) {
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		return dashboardOut{}, err
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return dashboardOut{}, err
	}
	// Every read below needs only the resident: one parallel wave, so a cache
	// miss pays about two Mongo round trips instead of ten (P11-11).
	var (
		hostel              any
		payments, unsettled []finance.LedgerInvoice
		rows                []notices.Row
		reads               map[string]time.Time
		menu                []any
		night               ordered.Map
		sos                 any
		summary             complaints.Summary
	)
	g, ctx := errgroup.WithContext(c.Request.Context())
	g.Go(func() (err error) { hostel, err = h.hostel(ctx, r.HostelID); return })
	g.Go(func() (err error) {
		payments, err = finance.ListResidentInvoices(ctx, h.DB, finance.LedgerScope{HostelID: r.HostelID, ResidentID: r.ID, Limit: 6})
		return
	})
	g.Go(func() (err error) {
		unsettled, err = finance.ListResidentInvoices(ctx, h.DB, finance.LedgerScope{HostelID: r.HostelID, ResidentID: r.ID, UnsettledOnly: true})
		return
	})
	g.Go(func() error {
		cur, err := h.DB.Collection("notices").Find(ctx, notices.ResidentFilter(r.HostelID), options.Find().SetSort(bson.D{{Key: "isUrgent", Value: -1}, {Key: "publishedAt", Value: -1}}).SetLimit(5))
		if err != nil {
			return err
		}
		if err := cur.All(ctx, &rows); err != nil {
			return err
		}
		ids := bson.A{}
		for _, n := range rows {
			ids = append(ids, n.ID)
		}
		reads, err = notices.ReadAts(ctx, h.DB, ids, uid)
		return err
	})
	g.Go(func() (err error) { menu, err = food.MealsToday(ctx, h.DB, r.HostelID, time.Now()); return })
	g.Go(func() (err error) { night, err = h.Safety.NightFor(ctx, r.ID); return })
	g.Go(func() (err error) { sos, err = h.Safety.LatestSOS(ctx, r.ID); return })
	g.Go(func() (err error) { summary, err = complaints.Summarize(ctx, h.DB, r); return })
	if err := g.Wait(); err != nil {
		return dashboardOut{}, err
	}
	noticeList := []noticeOut{}
	for _, n := range rows {
		_, read := reads[n.ID.Hex()]
		out := noticeOut{Category: n.Category, Content: n.Content, ID: n.ID.Hex(), IsRead: read, IsUrgent: n.IsUrgent, Title: n.Title}
		if n.PublishedAt != nil {
			out.PublishedAt = httpx.ISO(*n.PublishedAt)
		}
		noticeList = append(noticeList, out)
	}
	return dashboardOut{dashboardBody{accommodation{r.RoomType}, summary, feeSummary(payments, unsettled), menu, hostel, night, noticeList, residents.Summary(r), sos}}, nil
}

type guardianOut struct {
	Email     string `json:"email" bson:"email"`
	FirstName string `json:"firstName" bson:"firstName"`
	ID        string `json:"id" bson:"-"`
	IsPrimary bool   `json:"isPrimary" bson:"isPrimary"`
	LastName  string `json:"lastName" bson:"lastName"`
	Phone     string `json:"phone" bson:"phone"`
	Relation  string `json:"relation" bson:"relation"`
}

type profileBody struct {
	Accommodation     accommodation `json:"accommodation"`
	EmergencyContacts any           `json:"emergencyContacts"`
	Guardians         []guardianOut `json:"guardians"`
	Hostel            any           `json:"hostel"`
	Resident          ordered.Map   `json:"resident"`
}

type profileOut struct {
	Profile profileBody `json:"profile"`
}

func (h *Handler) profile(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.DB.Collection("guardians").Find(c, bson.D{{Key: "residentId", Value: r.ID}, {Key: "hostelId", Value: r.HostelID}}, options.Find().SetSort(bson.D{{Key: "isPrimary", Value: -1}, {Key: "createdAt", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	defer func() { _ = cur.Close(c) }()
	guardians := []guardianOut{}
	for cur.Next(c) {
		var g guardianOut
		if err := cur.Decode(&g); err != nil {
			httpx.Fail(c, err)
			return
		}
		id, _ := cur.Current.Lookup("_id").ObjectIDOK()
		g.ID = id.Hex()
		guardians = append(guardians, g)
	}
	contacts, err := safety.EmergencyContacts(c, h.DB, r)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := h.hostel(c, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, profileOut{profileBody{accommodation{r.RoomType}, contacts, guardians, hostel, residents.Summary(r)}}, "Resident profile loaded")
}
