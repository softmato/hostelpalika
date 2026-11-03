package team

import (
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// platformTeam is GET /platform/team: listTeamRoster + listTeamRegistrations + listTeamInvites.
func (h *Handler) platformTeam(c *gin.Context) {
	members, err := findAll[struct {
		ID           bson.ObjectID `bson:"_id"`
		CreatedAt    *time.Time    `bson:"createdAt"`
		Email        *string       `bson:"email"`
		LastLoginAt  *time.Time    `bson:"lastLoginAt"`
		Name         *string       `bson:"name"`
		Phone        *string       `bson:"phone"`
		PreviousRole *string       `bson:"previousRole"`
		Status       *string       `bson:"status"`
	}](c, h.col("users"), bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "PLATFORM_AGENT"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := bson.A{}
	for _, m := range members {
		ids = append(ids, m.ID)
	}
	type keyed struct {
		ID    bson.ObjectID `bson:"_id"`
		Total int64         `bson:"total"`
	}
	agg := func(coll string, pipe mongo.Pipeline, into any) error {
		cur, err := h.col(coll).Aggregate(c, pipe)
		if err != nil {
			return err
		}
		return cur.All(c, into)
	}
	var regs, payCounts []keyed
	var cash []struct {
		ID struct {
			CollectedBy bson.ObjectID `bson:"collectedBy"`
			Method      string        `bson:"method"`
		} `bson:"_id"`
		Total int64 `bson:"total"`
	}
	if err := agg("hostelsubscriptions", mongo.Pipeline{{{Key: "$match", Value: bson.D{{Key: "agentId", Value: bson.D{{Key: "$in", Value: ids}}}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$agentId"}, {Key: "total", Value: bson.D{{Key: "$sum", Value: 1}}}}}}}, &regs); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := agg("subscriptionpayments", mongo.Pipeline{{{Key: "$match", Value: bson.D{{Key: "collectedBy", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "SETTLED"}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "collectedBy", Value: "$collectedBy"}, {Key: "method", Value: "$method"}}}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}}, &cash); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := agg("subscriptionpayments", mongo.Pipeline{{{Key: "$match", Value: bson.D{{Key: "collectedBy", Value: bson.D{{Key: "$in", Value: ids}}}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$collectedBy"}, {Key: "total", Value: bson.D{{Key: "$sum", Value: 1}}}}}}}, &payCounts); err != nil {
		httpx.Fail(c, err)
		return
	}
	regBy, payBy, cashBy := map[bson.ObjectID]int64{}, map[bson.ObjectID]int64{}, map[bson.ObjectID]int64{}
	for _, r := range regs {
		regBy[r.ID] = r.Total
	}
	for _, r := range payCounts {
		payBy[r.ID] = r.Total
	}
	for _, r := range cash {
		if r.ID.Method == "CASH" {
			cashBy[r.ID.CollectedBy] += r.Total
		}
	}
	roster := make([]ordered.Map, len(members))
	for i, m := range members {
		var prev any
		if m.PreviousRole != nil {
			prev = *m.PreviousRole
		}
		roster[i] = ordered.Map{{Key: "cashCollected", Value: cashBy[m.ID]}, {Key: "deletable", Value: payBy[m.ID] == 0 && regBy[m.ID] == 0 && m.PreviousRole == nil},
			{Key: "email", Value: str(m.Email, "")}, {Key: "hostelsRegistered", Value: regBy[m.ID]}, {Key: "id", Value: m.ID.Hex()}, {Key: "joinedAt", Value: iso(m.CreatedAt)},
			{Key: "lastLoginAt", Value: iso(m.LastLoginAt)}, {Key: "name", Value: str(m.Name, "Unnamed")}, {Key: "phone", Value: str(m.Phone, "")}, {Key: "previousRole", Value: prev},
			{Key: "status", Value: str(m.Status, "ACTIVE")}}
	}

	subs, err := findAll[subscriptionRow](c, h.col("hostelsubscriptions"), bson.D{{Key: "agentId", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "source", Value: "TEAM"}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(200))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelIDs, agentIDs, subIDs := bson.A{}, bson.A{}, bson.A{}
	for _, s := range subs {
		hostelIDs, subIDs = append(hostelIDs, s.HostelID), append(subIDs, s.ID)
		if s.AgentID != nil {
			agentIDs = append(agentIDs, *s.AgentID)
		}
	}
	hostels, err := findAll[struct {
		ID     bson.ObjectID `bson:"_id"`
		Name   *string       `bson:"name"`
		Status *string       `bson:"status"`
	}](c, h.col("hostels"), bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: hostelIDs}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	agents, err := findAll[struct {
		ID    bson.ObjectID `bson:"_id"`
		Email *string       `bson:"email"`
		Name  *string       `bson:"name"`
	}](c, h.col("users"), bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: agentIDs}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	money, err := h.ledgers(c, subs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	invs, err := findAll[struct {
		InvoiceNumber  string        `bson:"invoiceNumber"`
		SubscriptionID bson.ObjectID `bson:"subscriptionId"`
	}](c, h.col("subscriptioninvoices"), bson.D{{Key: "kind", Value: bson.D{{Key: "$ne", Value: "SETUP_FEE"}}}, {Key: "subscriptionId", Value: bson.D{{Key: "$in", Value: subIDs}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	invBy := map[bson.ObjectID]string{}
	for _, inv := range invs {
		invBy[inv.SubscriptionID] = inv.InvoiceNumber // the last one wins, as a Map built from the list does
	}
	registrations := make([]ordered.Map, len(subs))
	for i, s := range subs {
		l := money[s.ID]
		if l == nil {
			l = &ledger{}
		}
		agentName, agentEmail := "Unknown", ""
		if s.AgentID != nil {
			for _, a := range agents {
				if a.ID == *s.AgentID {
					agentName, agentEmail = str(a.Name, "Unknown"), str(a.Email, "")
				}
			}
		}
		hostelName, hostelStatus := "Unnamed hostel", ""
		for _, hs := range hostels {
			if hs.ID == s.HostelID {
				hostelName, hostelStatus = str(hs.Name, "Unnamed hostel"), str(hs.Status, "")
			}
		}
		var price int64
		if s.CycleTotal != nil {
			price = *s.CycleTotal
		}
		registrations[i] = ordered.Map{{Key: "agentEmail", Value: agentEmail}, {Key: "agentName", Value: agentName}, {Key: "cashCollected", Value: l.cash}, {Key: "dueBy", Value: iso(s.DueBy)},
			{Key: "hostelId", Value: s.HostelID.Hex()}, {Key: "hostelName", Value: hostelName}, {Key: "hostelStatus", Value: hostelStatus}, {Key: "invoiceNumber", Value: invBy[s.ID]},
			{Key: "onlineCollected", Value: l.online}, {Key: "outstanding", Value: l.outstanding}, {Key: "paid", Value: l.total}, {Key: "planName", Value: str(s.PlanName, "")},
			{Key: "price", Value: price}, {Key: "registeredAt", Value: iso(s.CreatedAt)}, {Key: "setupFee", Value: l.setupFee}, {Key: "subscriptionStatus", Value: s.Status}}
	}

	invites, err := findAll[struct {
		ID        bson.ObjectID `bson:"_id"`
		CreatedAt *time.Time    `bson:"createdAt"`
		Email     string        `bson:"email"`
		ExpiresAt time.Time     `bson:"expiresAt"`
		Name      *string       `bson:"name"`
	}](c, h.col("platformadmininvites"), bson.D{{Key: "role", Value: "PLATFORM_AGENT"}, {Key: "status", Value: "PENDING"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := h.Now()
	inv := make([]ordered.Map, len(invites))
	for i, v := range invites {
		inv[i] = ordered.Map{{Key: "email", Value: v.Email}, {Key: "expired", Value: v.ExpiresAt.Before(now)}, {Key: "expiresAt", Value: httpx.ISO(v.ExpiresAt)}, {Key: "id", Value: v.ID.Hex()},
			{Key: "invitedAt", Value: iso(v.CreatedAt)}, {Key: "name", Value: str(v.Name, "")}}
	}
	httpx.OK(c, ordered.Map{{Key: "members", Value: roster}, {Key: "registrations", Value: registrations}, {Key: "invites", Value: inv}}, "Team loaded")
}
