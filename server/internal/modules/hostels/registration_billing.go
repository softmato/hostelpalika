package hostels

import (
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/team"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// RegistrationBilling is /hostel-registration/*: an owner whose hostel is
// registered but not yet live picks a plan, gets its invoice and pays it, then
// lands back from Softmato's checkout. Also the agent's /team/hostels/:id/checkout.
type RegistrationBilling struct {
	DB      *mongo.Database
	Guards  *authz.Guards
	Settler *billing.Settler
}

func (r *RegistrationBilling) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-registration")
	g.GET("/:hostelId/state", httpx.ETag(), r.state)
	g.POST("/:hostelId/plan", r.plan)
	g.POST("/:hostelId/invoice", r.invoice)
	g.POST("/:hostelId/pay", r.pay)
	g.GET("/return", r.returned)
	v1.POST("/team/hostels/:id/checkout", r.teamCheckout)
}

// owned is requireApiPrincipal + resolveOwnedHostel on :hostelId.
func (r *RegistrationBilling) owned(c *gin.Context) (*authz.Principal, *owned, bool) {
	p, err := r.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return nil, nil, false
	}
	h, err := ResolveOwned(c, r.DB, c.Param("hostelId"), p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return nil, nil, false
	}
	return p, h, true
}

type stateOnly struct {
	State *billing.State `json:"state"`
}

func (r *RegistrationBilling) state(c *gin.Context) {
	_, h, ok := r.owned(c)
	if !ok {
		return
	}
	st, err := r.Settler.State(c, h.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		OnlinePayment bool           `json:"onlinePayment"`
		State         *billing.State `json:"state"`
	}{r.Settler.Softmato != nil, st}, "Registration state loaded")
}

// plan is selectPlan; a hostel already verified starts its free months on the spot.
func (r *RegistrationBilling) plan(c *gin.Context) {
	p, h, ok := r.owned(c)
	if !ok {
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	monthly := "monthly"
	cycle, _ := f.Enum("cycle", true, &monthly, "monthly", "halfYearly", "annual")
	lifetime, _ := f.Bool("lifetime", true, nil)
	planID, _ := f.Str("planId", valid.S{Trim: true, Min: 1, Max: 40})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := r.Settler.SelectPlan(c, h.ID, planID, plans.Cycle(cycle), lifetime, true, actor); err != nil {
		httpx.Fail(c, err)
		return
	}
	if h.VerificationStatus == "VERIFIED" {
		if _, err := r.Settler.StartFreeMonths(c, h.ID, &actor, time.Now()); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	st, err := r.Settler.State(c, h.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, stateOnly{st}, "Plan selected")
}

func (r *RegistrationBilling) invoice(c *gin.Context) {
	p, h, ok := r.owned(c)
	if !ok {
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err == nil {
		_, err = r.Settler.IssueSubscriptionInvoice(c, h.ID, actor, billing.IssueOptions{})
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	st, err := r.Settler.State(c, h.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, stateOnly{st}, "Invoice issued")
}

func (r *RegistrationBilling) pay(c *gin.Context) {
	p, h, ok := r.owned(c)
	if !ok {
		return
	}
	httpx.Progress(c, "Checkout opened", func(step func(string)) (any, error) { return r.Settler.OpenCheckout(c, h.ID, p.UserID, step) })
}

// returned is GET /hostel-registration/return: signed in, or carrying the
// plan checkout's token for an owner who paid without an account.
func (r *RegistrationBilling) returned(c *gin.Context) {
	token := strings.TrimSpace(c.GetHeader("x-checkout-token"))
	p, err := r.Guards.Load(c)
	if err == nil && p == nil && token == "" {
		p, err = r.Guards.Require(c)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	role, userID := "OWNER", ""
	if p != nil {
		role, userID = string(p.Role), p.UserID
	} else if userID, err = r.Settler.CheckoutOwner(token); err != nil {
		httpx.Fail(c, err)
		return
	}
	number := strings.TrimSpace(c.Query("invoice"))
	// The owner, or the agent who filed the hostel (they collect online from
	// their own phone, so they are the one who lands here).
	owns := func(hostelID bson.ObjectID) bool {
		if _, err := ResolveOwned(c, r.DB, hostelID.Hex(), userID); err == nil {
			return true
		}
		if role == string(authz.Superadmin) {
			return true
		}
		agent, err := bson.ObjectIDFromHex(userID)
		if err != nil {
			return false
		}
		n, err := r.DB.Collection("hostelsubscriptions").CountDocuments(c, bson.D{{Key: "agentId", Value: agent}, {Key: "hostelId", Value: hostelID}})
		return err == nil && n > 0
	}
	httpx.Progress(c, "Return state read", func(step func(string)) (any, error) {
		if number == "" {
			return gin.H{"state": gin.H{"kind": "unknown"}}, nil
		}
		st, err := r.Settler.ReadReturnState(c, number, owns, step)
		if err != nil {
			return nil, err
		}
		return gin.H{"state": st}, nil
	})
}

// teamCheckout is the agent collecting a filed hostel's plan online.
func (r *RegistrationBilling) teamCheckout(c *gin.Context) {
	p, id, err := team.Filed(r.DB, r.Guards)(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Progress(c, "Checkout opened", func(step func(string)) (any, error) { return r.Settler.OpenCheckout(c, id, p.UserID, step) })
}
