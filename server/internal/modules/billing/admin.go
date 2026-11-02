package billing

import (
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Admin is the hostel's own plan billing under /hostel-admin: subscription,
// billing history, the pay and renew actions and the documents.
type Admin struct {
	Service *Service
	Guards  *authz.Guards
	Cache   *cache.Cache
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/hostel-admin")
	staff := authz.Use(a.Guards.RequireHostelStaff)
	g.GET("/subscription", staff, a.subscription)
	g.GET("/billing", staff, httpx.ETag(), a.history)
}

// firstHostel is `principal.hostelIds?.[0]`.
func firstHostel(p *authz.Principal) (id bson.ObjectID, ok bool, err error) {
	if len(p.HostelIDs) == 0 {
		return id, false, nil
	}
	id, err = httpx.OID(p.HostelIDs[0], "hostel id")
	return id, err == nil, err
}

type stateOut struct {
	State *State `json:"state"`
}

func (a *Admin) subscription(c *gin.Context) {
	p := authz.From(c)
	id, ok, err := firstHostel(p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !ok {
		cache.Respond(c, a.Cache, nil, p.UserID, "subscription", "No hostel in scope", func() (stateOut, error) { return stateOut{}, nil })
		return
	}
	cache.Respond(c, a.Cache, p.HostelIDs, p.UserID, "subscription", "Subscription loaded", func() (stateOut, error) {
		st, err := a.Service.State(c, id)
		return stateOut{st}, err
	})
}

type historyOut struct {
	History    History `json:"history"`
	HostelCode string  `json:"hostelCode"`
	State      *State  `json:"state"`
}

func (a *Admin) history(c *gin.Context) {
	p := authz.From(c)
	id, ok, err := firstHostel(p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !ok {
		httpx.OK(c, struct {
			History History `json:"history"`
			State   *State  `json:"state"`
		}{EmptyHistory(), nil}, "No hostel in scope")
		return
	}
	h, err := a.Service.History(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	st, err := a.Service.State(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, historyOut{h, HostelCode(p.HostelIDs[0]), st}, "Billing loaded")
}
