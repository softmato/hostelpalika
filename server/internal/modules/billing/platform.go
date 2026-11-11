package billing

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// SoftmatoCashQueueURL is SOFTMATO_CASH_QUEUE_URL: where a Softmato admin confirms field cash.
const SoftmatoCashQueueURL = "https://admin.softmato.com/cash"

// Platform is /platform/subscriptions: hostels paying us. Read-only apart from a
// claim's review and a cash row's "check now"; nothing here raises or voids a bill.
type Platform struct {
	Settler *Settler
	Guards  *authz.Guards
	Audit   *audit.Log
}

func (p *Platform) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/platform/subscriptions", authz.Use(p.Guards.RequirePlatform))
	g.GET("", httpx.ETag(), p.ledger)
	g.GET("/cash", httpx.ETag(), p.cash)
	g.GET("/hostels", httpx.ETag(), p.hostelPlans)
	g.POST("/cash/:id/check", p.checkCash)
	g.GET("/claims", httpx.ETag(), p.claims)
	g.POST("/claims/:paymentId/review", p.review)
	g.GET("/documents/:kind/:number", p.document)
}

func (p *Platform) db() *mongo.Database { return p.Settler.Service.DB }

func (p *Platform) documentURL(kind, number string) string {
	return p.Settler.Service.SiteURL + "/api/v1/platform/subscriptions/documents/" + kind + "/" + httpx.EncodeURIComponent(number)
}

func billedName(inv *planInvoice) string {
	if inv == nil {
		return "—"
	}
	if inv.BilledTo.HostelName != "" {
		return inv.BilledTo.HostelName
	}
	if inv.BilledTo.Name != "" {
		return inv.BilledTo.Name
	}
	return "—"
}

func orNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func isoNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func sumOne(ctx context.Context, coll *mongo.Collection, stages bson.A) (int64, error) {
	cur, err := coll.Aggregate(ctx, stages)
	if err != nil {
		return 0, err
	}
	var rows []struct {
		Total float64 `bson:"total"`
	}
	if err := cur.All(ctx, &rows); err != nil || len(rows) == 0 {
		return 0, err
	}
	return int64(math.Round(rows[0].Total)), nil
}

// ledger is getPlatformSubscriptionLedger: built from our rows, never Softmato's,
// so the platform's view of what it is owed cannot go dark with a third party.
func (p *Platform) ledger(c *gin.Context) {
	limit := 200.0
	if raw, ok := c.GetQuery("limit"); ok {
		if n := valid.JSNumber(raw); !math.IsNaN(n) && !math.IsInf(n, 0) {
			limit = n
		}
	}
	limit = math.Min(math.Max(limit, 1), 500)
	scope := bson.D{}
	if h := c.Query("hostelId"); h != "" {
		if id, err := bson.ObjectIDFromHex(h); err == nil {
			scope = bson.D{{Key: "hostelId", Value: id}}
		}
	}
	db := p.db()
	invs, pays := db.Collection("subscriptioninvoices"), db.Collection("subscriptionpayments")
	page := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(int64(limit))
	cur, err := invs.Find(c, scope, page)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var invoices []planInvoice
	if err := cur.All(c, &invoices); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = pays.Find(c, append(append(bson.D{}, scope...), excludeCheckoutAttempts...), page)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var payments []planPayment
	if err := cur.All(c, &payments); err != nil {
		httpx.Fail(c, err)
		return
	}
	payInvoices := map[bson.ObjectID]bson.ObjectID{}
	for _, raw := range payments {
		payInvoices[raw.ID] = raw.InvoiceID
	}
	// Paid per invoice over the whole collection: a balance from this page alone
	// would show an invoice unpaid because its settlement was the 201st row.
	cur, err = pays.Aggregate(c, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "status", Value: "SETTLED"}}}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$invoiceId"}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var settled []struct {
		ID    bson.ObjectID `bson:"_id"`
		Total float64       `bson:"total"`
	}
	if err := cur.All(c, &settled); err != nil {
		httpx.Fail(c, err)
		return
	}
	paidBy := map[bson.ObjectID]float64{}
	for _, s := range settled {
		paidBy[s.ID] = s.Total
	}
	byID := map[bson.ObjectID]*planInvoice{}
	for i := range invoices {
		byID[invoices[i].ID] = &invoices[i]
	}
	// A payment whose invoice is older than this page still names its hostel and
	// invoice; TS read only the page and printed "—" (P7-27).
	missing := bson.A{}
	for _, inv := range payInvoices {
		if byID[inv] == nil {
			missing = append(missing, inv)
		}
	}
	if len(missing) > 0 {
		mc, err := invs.Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: missing}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var more []planInvoice
		if err := mc.All(c, &more); err != nil {
			httpx.Fail(c, err)
			return
		}
		for i := range more {
			byID[more[i].ID] = &more[i]
		}
	}
	billed, err := sumOne(c, invs, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}}}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var collected float64
	for _, s := range settled {
		collected += s.Total
	}
	// Outstanding per invoice, not billed minus collected: money on PAID invoices
	// must not net off the open ones.
	outstanding, err := sumOne(c, invs, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL"}}}}}}},
		bson.D{{Key: "$lookup", Value: bson.D{{Key: "as", Value: "settled"}, {Key: "foreignField", Value: "invoiceId"}, {Key: "from", Value: "subscriptionpayments"}, {Key: "localField", Value: "_id"},
			{Key: "pipeline", Value: bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "status", Value: "SETTLED"}}}}}}}}},
		bson.D{{Key: "$project", Value: bson.D{{Key: "shortfall", Value: bson.D{{Key: "$max", Value: bson.A{0, bson.D{{Key: "$subtract", Value: bson.A{"$amount", bson.D{{Key: "$sum", Value: "$settled.amount"}}}}}}}}}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$shortfall"}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	active, err := db.Collection("hostelsubscriptions").CountDocuments(c, bson.D{{Key: "currentPeriodEnd", Value: bson.D{{Key: "$gt", Value: time.Now()}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PAST_DUE"}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byPlatform, err := invs.CountDocuments(c, bson.D{{Key: "localInvoiceNo", Value: bson.D{{Key: "$type", Value: "string"}}}, {Key: "softmatoInvoiceNo", Value: nil}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	invOut := make([]ordered.Map, len(invoices))
	for i := range invoices {
		inv := &invoices[i]
		paid := paidBy[inv.ID]
		printed := inv.InvoiceNumber
		if inv.LocalNo != nil {
			printed = *inv.LocalNo
		}
		issuedBy := "platform"
		if inv.SoftmatoNo != nil {
			printed, issuedBy = *inv.SoftmatoNo, "softmato"
		}
		owed := 0.0
		if inv.Status != "VOID" {
			owed = math.Max(0, float64(inv.Amount)-paid)
		}
		currency, source, plan := "NPR", "PUBLIC", inv.PlanName
		if inv.Currency != nil {
			currency = *inv.Currency
		}
		if inv.Source != "" {
			source = inv.Source
		}
		if inv.Lifetime {
			plan += " · Lifetime"
		}
		invOut[i] = ordered.Map{{Key: "amount", Value: inv.Amount}, {Key: "currency", Value: currency}, {Key: "cycle", Value: inv.Cycle}, {Key: "documentUrl", Value: p.documentURL("invoice", inv.InvoiceNumber)},
			{Key: "dueAt", Value: isoNil(inv.DueAt)}, {Key: "hostelId", Value: inv.HostelID.Hex()}, {Key: "hostelName", Value: billedName(inv)}, {Key: "invoiceNumber", Value: inv.InvoiceNumber},
			{Key: "issuedAt", Value: isoNil(inv.IssuedAt)}, {Key: "issuedBy", Value: issuedBy}, {Key: "outstanding", Value: owed}, {Key: "paid", Value: paid}, {Key: "planName", Value: plan},
			{Key: "printedNumber", Value: printed}, {Key: "source", Value: source}, {Key: "status", Value: inv.Status}}
	}
	payOut := make([]ordered.Map, len(payments))
	for i := range payments {
		pay := &payments[i]
		inv := byID[pay.InvoiceID]
		printed := pay.TxNo
		if printed == nil {
			printed = pay.LocalNo
		}
		var doc any
		if num := firstOf(printed, pay.ReceiptNo); pay.Status == "SETTLED" && num != "" {
			doc = p.documentURL("receipt", num)
		}
		currency, number := "NPR", "—"
		if pay.Currency != nil {
			currency = *pay.Currency
		}
		if inv != nil {
			number = inv.InvoiceNumber
		}
		payOut[i] = ordered.Map{{Key: "amount", Value: pay.Amount}, {Key: "currency", Value: currency}, {Key: "documentUrl", Value: doc}, {Key: "hostelId", Value: pay.HostelID.Hex()},
			{Key: "hostelName", Value: billedName(inv)}, {Key: "invoiceNumber", Value: number}, {Key: "method", Value: pay.Method}, {Key: "paidAt", Value: isoNil(pay.SettledAt)},
			{Key: "printedNumber", Value: orNil(printed)}, {Key: "provider", Value: orNil(pay.Provider)}, {Key: "receiptNumber", Value: orNil(pay.ReceiptNo)}, {Key: "status", Value: pay.Status}}
	}
	httpx.OK(c, ordered.Map{{Key: "invoices", Value: invOut}, {Key: "payments", Value: payOut}, {Key: "totals", Value: ordered.Map{{Key: "activePlans", Value: active}, {Key: "billed", Value: billed},
		{Key: "collected", Value: collected}, {Key: "issuedByPlatform", Value: byPlatform}, {Key: "outstanding", Value: outstanding}}}}, "Subscription ledger loaded")
}

func firstOf(ss ...*string) string {
	for _, s := range ss {
		if s != nil && *s != "" {
			return *s
		}
	}
	return ""
}

type queuedPayment struct {
	ID          bson.ObjectID  `bson:"_id"`
	Amount      int64          `bson:"amount"`
	ClaimNote   *string        `bson:"claimNote"`
	ClaimedAt   *time.Time     `bson:"claimedAt"`
	CollectedBy *bson.ObjectID `bson:"collectedBy"`
	CreatedAt   time.Time      `bson:"createdAt"`
	Reference   *string        `bson:"gatewayReference"`
	HostelID    bson.ObjectID  `bson:"hostelId"`
	InvoiceID   bson.ObjectID  `bson:"invoiceId"`
	Method      string         `bson:"method"`
	ProofAsset  *bson.ObjectID `bson:"proofAssetId"`
	Status      string         `bson:"status"`
	Subscr      bson.ObjectID  `bson:"subscriptionId"`
	TxNo        *string        `bson:"softmatoTransactionNo"`
}

func (p *Platform) queue(ctx context.Context, filter bson.D, sort string) ([]queuedPayment, map[bson.ObjectID]*planInvoice, error) {
	cur, err := p.db().Collection("subscriptionpayments").Find(ctx, filter, options.Find().SetSort(bson.D{{Key: sort, Value: 1}}).SetLimit(200))
	if err != nil {
		return nil, nil, err
	}
	var rows []queuedPayment
	if err := cur.All(ctx, &rows); err != nil {
		return nil, nil, err
	}
	invoices := map[bson.ObjectID]*planInvoice{}
	if len(rows) == 0 {
		return rows, invoices, nil
	}
	ids := bson.A{}
	for _, r := range rows {
		ids = append(ids, r.InvoiceID)
	}
	ic, err := p.db().Collection("subscriptioninvoices").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		return nil, nil, err
	}
	var list []planInvoice
	if err := ic.All(ctx, &list); err != nil {
		return nil, nil, err
	}
	for i := range list {
		invoices[list[i].ID] = &list[i]
	}
	return rows, invoices, nil
}

// claims is listPlanPaymentClaims: the manual-payment worklist, oldest first.
func (p *Platform) claims(c *gin.Context) {
	rows, invoices, err := p.queue(c, bson.D{{Key: "status", Value: "IN_REVIEW"}}, "claimedAt")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i, r := range rows {
		inv := invoices[r.InvoiceID]
		number, plan := "—", "—"
		if inv != nil {
			number, plan = inv.InvoiceNumber, inv.PlanName
		}
		var proof any
		if r.ProofAsset != nil {
			proof = r.ProofAsset.Hex()
		}
		out[i] = ordered.Map{{Key: "amount", Value: r.Amount}, {Key: "claimedAt", Value: isoNil(r.ClaimedAt)}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "hostelName", Value: billedName(inv)},
			{Key: "id", Value: r.ID.Hex()}, {Key: "invoiceNumber", Value: number}, {Key: "note", Value: orNil(r.ClaimNote)}, {Key: "planName", Value: plan}, {Key: "proofAssetId", Value: proof},
			{Key: "reference", Value: orNil(r.Reference)}}
	}
	httpx.OK(c, ordered.Map{{Key: "claims", Value: out}}, "Payment claims loaded")
}

// review is reviewPlanPaymentClaim, the one route that turns a screenshot into
// money received. Approving goes through SettlePayment, the webhook's own path.
func (p *Platform) review(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	m, _ := body.(map[string]any)
	approve, ok := m["approve"].(bool)
	if !ok {
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Say whether this claim is approved.", nil))
		return
	}
	var note *string
	if s, _ := m["note"].(string); s != "" {
		t := []rune(strings.TrimSpace(s))
		if len(t) > 500 {
			t = t[:500]
		}
		if len(t) > 0 {
			v := string(t)
			note = &v
		}
	}
	notFound := httpx.NewError(http.StatusNotFound, "PAYMENT_NOT_FOUND", "Payment not found.", nil)
	id, err := bson.ObjectIDFromHex(c.Param("paymentId"))
	if err != nil {
		httpx.Fail(c, notFound)
		return
	}
	pays := p.db().Collection("subscriptionpayments")
	var claim queuedPayment
	if err := pays.FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&claim); errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notFound)
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	reviewed := httpx.NewError(http.StatusConflict, "CLAIM_ALREADY_REVIEWED", "This claim has already been reviewed.", nil)
	if claim.Status != "IN_REVIEW" {
		httpx.Fail(c, reviewed)
		return
	}
	var inv planInvoice
	if err := p.db().Collection("subscriptioninvoices").FindOne(c, bson.D{{Key: "_id", Value: claim.InvoiceID}}).Decode(&inv); errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "INVOICE_NOT_FOUND", "Invoice not found.", nil))
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	actorID := authz.From(c).UserID
	actor, _ := bson.ObjectIDFromHex(actorID)
	now := nowMS()
	meta := bson.D{{Key: "amount", Value: claim.Amount}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "note", Value: orNil(note)}}
	if approve {
		// Stamped before settling: SettlePayment claims the row on its status, and a
		// later write would race the receipt and the activation.
		if _, err := pays.UpdateOne(c, bson.D{{Key: "_id", Value: claim.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "reviewNote", Value: orNil(note)}, {Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "updatedAt", Value: now}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		state, err := p.Settler.SettlePayment(c, claim.ID, SettleOptions{ActorID: actorID, ExpectedHostelID: claim.HostelID.Hex()})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		_ = p.Audit.Write(c, audit.Entry{Action: "SUBSCRIPTION_PAYMENT_CLAIM_APPROVED", ActorID: actor, EntityID: claim.ID.Hex(), EntityType: "SubscriptionPayment", HostelID: claim.HostelID, Metadata: meta})
		httpx.OK(c, ordered.Map{{Key: "state", Value: state}}, "Payment confirmed")
		return
	}
	reason := "Could not be matched to a payment we received."
	if note != nil {
		reason = *note
	}
	res, err := pays.UpdateOne(c, bson.D{{Key: "_id", Value: claim.ID}, {Key: "status", Value: "IN_REVIEW"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "failureReason", Value: reason},
		{Key: "reviewNote", Value: orNil(note)}, {Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: "FAILED"}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// A reviewer who approved it a moment earlier won: no "we could not find it" email (P7-26).
	if res.ModifiedCount == 0 {
		httpx.Fail(c, reviewed)
		return
	}
	_ = p.Audit.Write(c, audit.Entry{Action: "SUBSCRIPTION_PAYMENT_CLAIM_REJECTED", ActorID: actor, EntityID: claim.ID.Hex(), EntityType: "SubscriptionPayment", HostelID: claim.HostelID, Metadata: meta})
	svc := p.Settler.Service
	if inv.BilledTo.Email != "" && svc.Mail != nil {
		owed, err := svc.outstanding(c, &inv)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		hostel := inv.BilledTo.HostelName
		if hostel == "" {
			hostel = "your hostel"
		}
		said := ""
		if note != nil {
			said = *note
		}
		m := email.SubscriptionClaimRejected(claim.Amount, hostel, inv.InvoiceNumber, owed, inv.BilledTo.Name, inv.PlanName, said)
		if r := svc.Mail.Send(c, email.Message{Category: m.Category, To: []string{inv.BilledTo.Email}, Subject: m.Subject, HTML: m.HTML}); !r.Sent {
			slog.WarnContext(c, "subscription_claim_rejected_email_failed", "reason", r.Reason, "to", inv.BilledTo.Email)
		}
	}
	state, err := svc.State(c, claim.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "state", Value: state}}, "Claim marked unconfirmed")
}

// cash is listFieldCashToConfirm: cash agents collected that nobody has confirmed, oldest first.
func (p *Platform) cash(c *gin.Context) {
	rows, invoices, err := p.queue(c, bson.D{{Key: "method", Value: "CASH"}, {Key: "status", Value: "PENDING"}}, "createdAt")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostels, agents := bson.A{}, bson.A{}
	for _, r := range rows {
		hostels = append(hostels, r.HostelID)
		if r.CollectedBy != nil {
			agents = append(agents, *r.CollectedBy)
		}
	}
	names := func(coll string, ids bson.A) (map[bson.ObjectID]string, error) {
		out := map[bson.ObjectID]string{}
		if len(ids) == 0 {
			return out, nil
		}
		cur, err := p.db().Collection(coll).Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var list []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name *string       `bson:"name"`
		}
		if err := cur.All(c, &list); err != nil {
			return nil, err
		}
		for _, x := range list {
			if x.Name != nil {
				out[x.ID] = *x.Name
			}
		}
		return out, nil
	}
	hostelName, err := names("hostels", hostels)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	agentName, err := names("users", agents)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i, r := range rows {
		inv := invoices[r.InvoiceID]
		number, plan := "—", ""
		if inv != nil {
			number, plan = inv.InvoiceNumber, inv.PlanName
		}
		by := "Field agent"
		if r.CollectedBy != nil {
			if n, ok := agentName[*r.CollectedBy]; ok {
				by = n
			}
		}
		hostel, ok := hostelName[r.HostelID]
		if !ok {
			hostel = "Hostel"
		}
		out[i] = ordered.Map{{Key: "amount", Value: r.Amount}, {Key: "collectedAt", Value: httpx.ISO(r.CreatedAt)}, {Key: "collectedBy", Value: by}, {Key: "hostelName", Value: hostel},
			{Key: "id", Value: r.ID.Hex()}, {Key: "invoiceNumber", Value: number}, {Key: "planName", Value: plan}, {Key: "reference", Value: orNil(r.Reference)}, {Key: "transactionNo", Value: orNil(r.TxNo)}}
	}
	httpx.OK(c, ordered.Map{{Key: "cash", Value: out}, {Key: "confirmUrl", Value: SoftmatoCashQueueURL}}, "Cash to confirm loaded")
}

// checkCash is checkFieldCash: files a row Softmato never got, otherwise asks where
// it stands and settles it here when confirmed, the webhook's own path.
func (p *Platform) checkCash(c *gin.Context) {
	result, err := p.checkFieldCash(c, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "result", Value: result}}, "Cash checked")
}

func (p *Platform) checkFieldCash(ctx context.Context, raw string) (string, error) {
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		return "", bson.ErrInvalidHex // 404, as TS's CastError
	}
	pays := p.db().Collection("subscriptionpayments")
	var pay queuedPayment
	if err := pays.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&pay); errors.Is(err, mongo.ErrNoDocuments) {
		return "waiting", nil
	} else if err != nil {
		return "", err
	}
	switch {
	case pay.Method != "CASH":
		return "waiting", nil
	case pay.Status == "SETTLED":
		return "settled", nil
	case pay.Status == "FAILED":
		return "rejected", nil
	}
	svc := p.Settler.Service
	if svc.Softmato == nil {
		return "", httpx.NewError(http.StatusServiceUnavailable, "SOFTMATO_NOT_CONFIGURED", "Softmato is not configured.", nil)
	}
	if pay.TxNo == nil || *pay.TxNo == "" {
		var inv planInvoice
		if err := svc.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: pay.InvoiceID}}).Decode(&inv); err != nil {
			return "", err
		}
		agent := ""
		if pay.CollectedBy != nil {
			var u struct {
				Name string `bson:"name"`
			}
			_ = svc.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *pay.CollectedBy}}).Decode(&u)
			agent = u.Name
		}
		ref := ""
		if pay.Reference != nil {
			ref = *pay.Reference
		}
		if err := svc.submitFieldCash(ctx, &inv, pay.ID, pay.Amount, ref, agent); err != nil {
			return "", err
		}
		return "filed", nil
	}
	status, err := svc.Softmato.GetTransactionStatus(ctx, *pay.TxNo)
	if err != nil {
		return "", err
	}
	switch status {
	case "SUCCEEDED":
		if _, err := p.Settler.RecordSoftmatoPayment(ctx, pay.InvoiceID, pay.HostelID, pay.Subscr, *pay.TxNo, pay.Amount); err != nil {
			return "", err
		}
		return "settled", nil
	case "", "CREATED", "PENDING", "RECONCILIATION_REQUIRED":
		return "waiting", nil
	}
	if _, err := pays.UpdateOne(ctx, bson.D{{Key: "_id", Value: pay.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "FAILED"}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		return "", err
	}
	return "rejected", nil
}

// document is the platform's copy of any hostel's invoice or receipt. Its own
// route, so the unscoped read is chosen by the file, never by a flag.
func (p *Platform) document(c *gin.Context) {
	notFound := func() { c.Data(404, "text/plain;charset=UTF-8", []byte("Not found")) }
	kind := c.Param("kind")
	if kind != "invoice" && kind != "receipt" {
		notFound()
		return
	}
	number, err := url.PathUnescape(c.Param("number"))
	if err != nil {
		number = c.Param("number")
	}
	svc := p.Settler.Service
	var doc *resolvedDoc
	if kind == "invoice" {
		doc, err = svc.resolveInvoice(c, number, nil)
	} else {
		doc, err = svc.resolveReceipt(c, number, nil)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if doc == nil {
		notFound()
		return
	}
	c.Header("Content-Disposition", `attachment; filename="`+doc.name+`"`)
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Length", strconv.Itoa(len(doc.data)))
	c.Data(200, doc.contentType, doc.data)
}
