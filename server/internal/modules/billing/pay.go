package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	evidenceMaxAge    = 14 * 24 * time.Hour
	claimNoteMax      = 500
	claimReferenceMax = 64
	softmatoDownMsg   = "Our parent company's server is not responding right now. We have saved this and will email you to complete it as soon as the server is back. Thank you for your patience."
)

func payErr(status int, code, message string) error {
	return httpx.NewError(status, code, message, nil)
}

// planInvoice is an InvoiceRecord: the whole row the pay paths read.
type planInvoice struct {
	ID       bson.ObjectID `bson:"_id"`
	Amount   int64         `bson:"amount"`
	BilledTo struct {
		Email      string `bson:"email"`
		HostelName string `bson:"hostelName"`
		Name       string `bson:"name"`
	} `bson:"billedTo"`
	BalanceDocs []struct {
		Amount int64  `bson:"amount"`
		ID     string `bson:"id"`
		No     string `bson:"no"`
	} `bson:"softmatoBalanceInvoices"`
	Currency       *string       `bson:"currency"`
	Cycle          string        `bson:"cycle"`
	CycleMonths    int           `bson:"cycleMonths"`
	DueAt          *time.Time    `bson:"dueAt"`
	HostelID       bson.ObjectID `bson:"hostelId"`
	InvoiceNumber  string        `bson:"invoiceNumber"`
	IssuedAt       *time.Time    `bson:"issuedAt"`
	Kind           string        `bson:"kind"`
	Lifetime       bool          `bson:"lifetime"`
	LocalNo        *string       `bson:"localInvoiceNo"`
	LocalIssuedAt  *time.Time    `bson:"localIssuedAt"`
	PeriodEnd      *time.Time    `bson:"periodEnd"`
	PeriodStart    *time.Time    `bson:"periodStart"`
	PlanID         string        `bson:"planId"`
	PlanName       string        `bson:"planName"`
	SoftmatoID     *string       `bson:"softmatoInvoiceId"`
	SoftmatoNo     *string       `bson:"softmatoInvoiceNo"`
	Status         string        `bson:"status"`
	SubscriptionID bson.ObjectID `bson:"subscriptionId"`
}

func (s *Service) catalog(ctx context.Context) (plans.Catalog, error) {
	var c plans.Catalog
	raw, err := s.Config.Section(ctx, "plans")
	if err != nil {
		return c, err
	}
	return c, platformconfig.Decode(raw, &c)
}

func (s *Service) openPlanInvoice(ctx context.Context, subscriptionID bson.ObjectID) (*planInvoice, error) {
	var inv planInvoice
	err := s.DB.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "kind", Value: bson.D{{Key: "$ne", Value: "SETUP_FEE"}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL"}}}}, {Key: "subscriptionId", Value: subscriptionID}},
		options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &inv, err
}

// payableInvoice is invoiceIdFor + loadInvoice: "nothing to pay" is what a payer needs told.
func (s *Service) payableInvoice(ctx context.Context, hostelID bson.ObjectID) (*planInvoice, error) {
	id, err := BillingHostelID(ctx, s.DB, hostelID)
	if err != nil {
		return nil, err
	}
	var sub subscription
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&sub); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, payErr(404, "NO_SUBSCRIPTION", "This hostel has no plan yet.")
		}
		return nil, err
	}
	inv, err := s.openPlanInvoice(ctx, sub.ID)
	if err != nil {
		return nil, err
	}
	if inv == nil {
		return nil, payErr(409, "NO_OPEN_INVOICE", "There is no outstanding invoice to pay.")
	}
	return inv, nil
}

func (s *Service) outstanding(ctx context.Context, inv *planInvoice) (int64, error) {
	paid, err := s.settledTotal(ctx, bson.D{{Key: "invoiceId", Value: inv.ID}})
	if err != nil {
		return 0, err
	}
	return max(0, inv.Amount-paid), nil
}

// ---- presentation ----

var (
	presentTags   = regexp.MustCompile(`<[^>]*>`)
	presentMarks  = regexp.MustCompile("[*_`#]+")
	presentSpaces = regexp.MustCompile(`\s+`)
	presentDenied = []*regexp.Regexp{regexp.MustCompile(`(?i)\b(?:npr|nrs|inr|rs)\b\.?`), regexp.MustCompile(`[₹﷼]|रु|रू`), regexp.MustCompile(`\d\s*/-`), regexp.MustCompile(`\d{1,3}(?:,\d{3})+`),
		regexp.MustCompile(`(?i)\bper\s+(?:month|year|bed)\b`), regexp.MustCompile(`(?i)\brefund`), regexp.MustCompile(`(?i)\bmoney[-\s]?back\b`), regexp.MustCompile(`(?i)\bsoftmato\b`), regexp.MustCompile(`(?i)\bfree\s+trial\b`)}
)

// presentFit is fit: Softmato refuses a block quoting a price, and a dropped bullet beats a 422.
func presentFit(value string, limit int) string {
	text := strings.TrimSpace(presentSpaces.ReplaceAllString(presentMarks.ReplaceAllString(presentTags.ReplaceAllString(value, " "), ""), " "))
	if text == "" {
		return ""
	}
	for _, re := range presentDenied {
		if re.MatchString(text) {
			return ""
		}
	}
	units := []rune(text)
	if len(units) <= limit {
		return text
	}
	cut := string(units[:limit])
	if i := strings.LastIndex(cut, " "); float64(len([]rune(cut[:max(i, 0)]))) > float64(limit)*0.6 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut)
}

func planFeatures(p *plans.Plan) []string {
	count := func(n *int, noun string) string {
		if n == nil {
			return "Unlimited " + noun + " accounts"
		}
		if *n == 1 {
			return "1 " + noun + " account"
		}
		return strconv.Itoa(*n) + " " + noun + " accounts"
	}
	residents := "Unlimited residents"
	if p.MaxResidents != nil {
		residents = "Up to " + strconv.Itoa(*p.MaxResidents) + " residents"
	}
	lines := []string{residents, count(p.PortalAccess.Wardens, "warden"), count(p.PortalAccess.Cooks, "cook")}
	if p.ListingTier != nil {
		lines = append(lines, p.ListingTier.Label+" badge in the public directory")
	}
	return lines
}

// buildPresentation is nil when even the plan's name will not pass.
func buildPresentation(billingPeriod, cycleLabel string, months int, plan *plans.Plan, planName string) *softmato.Presentation {
	name := presentFit(planName+" — "+cycleLabel, 80)
	if name == "" {
		return nil
	}
	out := &softmato.Presentation{PlanName: name}
	if plan != nil {
		for _, line := range planFeatures(plan) {
			if f := presentFit(line, 120); f != "" && len(out.Features) < 8 {
				out.Features = append(out.Features, f)
			}
		}
		if plan.ListingTier != nil && plan.ListingTier.Note != "" {
			if h := presentFit(plan.ListingTier.Note, 60); h != "" {
				out.Highlights = []string{h}
			}
		}
		out.Tagline = presentFit(plan.Description, 140)
	}
	if billingPeriod == "" {
		unit := " months"
		if months == 1 {
			unit = " month"
		}
		billingPeriod = strconv.Itoa(months) + unit
	}
	out.BillingPeriod = presentFit(billingPeriod, 60)
	return out
}

// documentInput is invoiceDocumentInput, ready for Softmato.
func (s *Service) documentInput(ctx context.Context, inv *planInvoice, amount int64, invoiceNumber, descPrefix string) (softmato.CreateInvoice, error) {
	name := inv.BilledTo.HostelName
	if name == "" {
		name = inv.BilledTo.Name
	}
	if name == "" {
		name = "Hostel"
	}
	in := softmato.CreateInvoice{Customer: softmato.Customer{ExternalRef: "hh-hostel:" + inv.HostelID.Hex(), Name: name, Email: inv.BilledTo.Email}, ExternalRef: "hh-sub:" + invoiceNumber}
	description := ""
	if inv.DueAt != nil && inv.DueAt.After(time.Now()) && inv.Kind != "SETUP_FEE" {
		in.DueAt = httpx.ISO(*inv.DueAt)
	}
	switch {
	case inv.Kind == "SETUP_FEE":
		hostel := inv.BilledTo.HostelName
		if hostel == "" {
			hostel = "hostel registration"
		}
		description = "Setup fee — " + hostel
	default:
		catalog, err := s.catalog(ctx)
		if err != nil {
			return in, err
		}
		plan := plans.GetPlan(catalog, inv.PlanID)
		if inv.Lifetime {
			description = inv.PlanName + " — Lifetime"
			in.Presentation = buildPresentation("Lifetime", "Lifetime", inv.CycleMonths, plan, inv.PlanName)
			break
		}
		months := inv.CycleMonths
		if months == 0 {
			months = plans.CycleMonths(plans.Cycle(inv.Cycle))
		}
		label := plans.MonthsLabel(catalog, months)
		description = inv.PlanName + " — " + label
		in.Presentation = buildPresentation("", label, inv.CycleMonths, plan, inv.PlanName)
		start, end := inv.PeriodStart, inv.PeriodEnd
		if start == nil || end == nil {
			var sub subscription
			if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "_id", Value: inv.SubscriptionID}}).Decode(&sub); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
				return in, err
			}
			from := time.Now()
			if inv.IssuedAt != nil {
				from = *inv.IssuedAt
			}
			a, b, err := servicePeriod(inv.CycleMonths, sub.CurrentPeriodEnd, from)
			if err != nil {
				return in, err
			}
			start, end = &a, &b
		}
		in.ServiceStartsAt, in.ServiceEndsAt = httpx.ISO(*start), httpx.ISO(*end)
	}
	in.Lines = []softmato.InvoiceLine{{Description: descPrefix + description, Quantity: 1, UnitPriceMinor: amount * 100}}
	return in, nil
}

// servicePeriod: from the end of what is running, else from now, counted in BS months.
func servicePeriod(months int, currentEnd *time.Time, now time.Time) (start, end time.Time, err error) {
	start = now
	if currentEnd != nil && currentEnd.After(now) {
		start = currentEnd.Add(time.Millisecond)
	}
	end, err = bs.MonthsEnd(start, months)
	return start, end, err
}

func (s *Service) documentURL(kind, number string) string {
	return s.SiteURL + "/api/v1/hostel-admin/billing/documents/" + kind + "/" + url.PathEscape(number)
}

// rememberTask is the row softmato/retry works through once Softmato is back.
func (s *Service) rememberTask(ctx context.Context, email, name, ref string) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	nullable := func(v string) any {
		if v == "" {
			return nil
		}
		return v
	}
	_, err := s.DB.Collection("softmatotasks").UpdateOne(ctx, bson.D{{Key: "doneAt", Value: nil}, {Key: "kind", Value: "PLAN_PAYMENT"}, {Key: "ref", Value: ref}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "email", Value: nullable(email)}, {Key: "link", Value: s.SiteURL + "/hostel-admin/billing"}, {Key: "name", Value: nullable(name)},
			{Key: "attempts", Value: 0}, {Key: "lastError", Value: nil}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return nil
	}
	return err
}

// billingContact is resolveBillingContact: the hostel's owner.
func (s *Service) billingContact(ctx context.Context, hostelID bson.ObjectID) (email, name, hostelName string, err error) {
	var h struct {
		Contact struct {
			Email string `bson:"email"`
		} `bson:"contact"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	if err = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}}, options.FindOne().SetProjection(bson.D{{Key: "ownerId", Value: 1}, {Key: "contact", Value: 1}, {Key: "name", Value: 1}})).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return "", "", "", nil
		}
		return "", "", "", err
	}
	email = h.Contact.Email
	if h.OwnerID != nil {
		var o struct {
			Email string `bson:"email"`
			Name  string `bson:"name"`
		}
		if err = s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *h.OwnerID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}})).Decode(&o); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return "", "", "", err
		}
		if o.Email != "" {
			email = o.Email
		}
		name = o.Name
	}
	return email, name, h.Name, nil
}

var errSoftmatoOff = errors.New("softmato is not configured")

// ensureRaised is ensureInvoiceRaised: idempotent, since external_ref comes from the
// number. When not required a failure leaves the invoice waiting; there is no stand-in.
func (s *Service) ensureRaised(ctx context.Context, inv *planInvoice, required bool) (*planInvoice, error) {
	if inv.SoftmatoID != nil && inv.SoftmatoNo != nil {
		return inv, nil
	}
	raise := func() error {
		if s.Softmato == nil {
			return errSoftmatoOff
		}
		in, err := s.documentInput(ctx, inv, inv.Amount, inv.InvoiceNumber, "")
		if err != nil {
			return err
		}
		out, err := s.Softmato.CreateInvoice(ctx, in)
		if err != nil {
			return err
		}
		number := out.InvoiceID
		if out.InvoiceNo != nil {
			number = *out.InvoiceNo
		}
		if _, err := s.DB.Collection("subscriptioninvoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: inv.ID}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "documentUrl", Value: s.documentURL("invoice", inv.InvoiceNumber)}, {Key: "softmatoInvoiceId", Value: out.InvoiceID}, {Key: "softmatoInvoiceNo", Value: number}}}}); err != nil {
			return err
		}
		inv.SoftmatoID, inv.SoftmatoNo = &out.InvoiceID, &number
		return nil
	}
	err := raise()
	if err == nil {
		return inv, nil
	}
	if required {
		return nil, err
	}
	slog.ErrorContext(ctx, "subscription_invoice_document_deferred", "invoiceNumber", inv.InvoiceNumber, "error", err.Error())
	if softmato.IsDown(err) {
		mail, name, _, cerr := s.billingContact(ctx, inv.HostelID)
		if cerr == nil {
			cerr = s.rememberTask(ctx, mail, name, inv.ID.Hex())
		}
		if cerr != nil {
			return nil, cerr
		}
	}
	return inv, nil
}

// checkoutDocument: Softmato charges a document's own due, so a part-paid invoice
// finishes on a balance document unless their due is already ours.
func (s *Service) checkoutDocument(ctx context.Context, inv *planInvoice, outstanding int64) (string, error) {
	detail, err := s.Softmato.GetInvoice(ctx, *inv.SoftmatoNo)
	if err != nil {
		return "", err
	}
	if detail != nil && detail.DueMinor == outstanding*100 {
		return *inv.SoftmatoID, nil
	}
	for _, doc := range inv.BalanceDocs {
		if doc.Amount == outstanding {
			return doc.ID, nil
		}
	}
	in, err := s.documentInput(ctx, inv, outstanding, inv.InvoiceNumber+"-B"+strconv.FormatInt(outstanding, 10), "Balance of "+inv.InvoiceNumber+" — ")
	if err != nil {
		return "", err
	}
	out, err := s.Softmato.CreateInvoice(ctx, in)
	if err != nil {
		return "", err
	}
	number := out.InvoiceID
	if out.InvoiceNo != nil {
		number = *out.InvoiceNo
	}
	_, err = s.DB.Collection("subscriptioninvoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: inv.ID}},
		bson.D{{Key: "$addToSet", Value: bson.D{{Key: "softmatoBalanceInvoices", Value: bson.D{{Key: "amount", Value: outstanding}, {Key: "id", Value: out.InvoiceID}, {Key: "no", Value: number}}}}}})
	return out.InvoiceID, err
}

// ---- routes ----

type checkoutPaymentOut struct {
	Amount int64  `json:"amount"`
	ID     string `json:"id"`
}

type checkoutOut struct {
	AllowedProviders []string           `json:"allowedProviders"`
	CheckoutURL      string             `json:"checkoutUrl"`
	ExpiresAt        string             `json:"expiresAt"`
	Payment          checkoutPaymentOut `json:"payment"`
}

// openCheckout is openSubscriptionCheckout: no amount from the caller, a session per attempt.
func (s *Service) openCheckout(ctx context.Context, hostelID bson.ObjectID, userID string, step func(string)) (*checkoutOut, error) {
	inv, err := s.payableInvoice(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	if s.Softmato == nil {
		return nil, payErr(503, "ONLINE_PAYMENT_UNAVAILABLE", "Online payment is not set up on this deployment yet.")
	}
	step("invoice")
	outstanding, err := s.outstanding(ctx, inv)
	if err != nil {
		return nil, err
	}
	if outstanding <= 0 {
		return nil, payErr(409, "ALREADY_SETTLED", "This invoice is already settled in full.")
	}
	var session *softmato.CheckoutSession
	err = func() error {
		raised, err := s.ensureRaised(ctx, inv, true)
		if err != nil {
			return err
		}
		step("session")
		doc, err := s.checkoutDocument(ctx, raised, outstanding)
		if err != nil {
			return err
		}
		session, err = s.Softmato.CreateCheckout(ctx, doc, s.Outbound+"/checkout/return?invoice="+url.QueryEscape(raised.InvoiceNumber))
		return err
	}()
	if err != nil {
		return nil, s.softmatoFailure(ctx, inv, err)
	}
	actor, err := httpx.OID(userID, "user id")
	if err != nil {
		return nil, err
	}
	id := bson.NewObjectID()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := s.DB.Collection("subscriptionpayments").InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "amount", Value: outstanding}, {Key: "currency", Value: "NPR"}, {Key: "hostelId", Value: inv.HostelID}, {Key: "invoiceId", Value: inv.ID},
		{Key: "isMocked", Value: false}, {Key: "method", Value: "SOFTMATO"}, {Key: "recordedBy", Value: actor}, {Key: "softmatoSessionId", Value: session.SessionID}, {Key: "status", Value: "PENDING"}, {Key: "subscriptionId", Value: inv.SubscriptionID},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	return &checkoutOut{session.AllowedProviders, session.CheckoutURL, session.ExpiresAt, checkoutPaymentOut{outstanding, id.Hex()}}, nil
}

// softmatoFailure is unlessSoftmatoDown: down is remembered and said plainly; a refusal is said as one.
func (s *Service) softmatoFailure(ctx context.Context, inv *planInvoice, err error) error {
	var api *softmato.APIError
	if errors.As(err, &api) && !softmato.IsDown(err) {
		slog.ErrorContext(ctx, "softmato_request_rejected", "code", api.Code, "status", api.Status, "error", api.Message)
		msg := api.Message
		if msg == "" {
			msg = "the request was refused."
		}
		return payErr(502, "SOFTMATO_REJECTED", "Our payment server could not accept this: "+msg)
	}
	if !softmato.IsDown(err) {
		return err
	}
	mail, _, hostelName, cerr := s.billingContact(ctx, inv.HostelID)
	if cerr == nil {
		cerr = s.rememberTask(ctx, mail, hostelName, inv.ID.Hex())
	}
	if cerr != nil {
		return cerr
	}
	return payErr(503, "SOFTMATO_UNAVAILABLE", softmatoDownMsg)
}

func noHostel() error { return payErr(400, "NO_HOSTEL", "No hostel in scope.") }

func (a *Admin) checkout(c *gin.Context) {
	p := authz.From(c)
	id, ok, err := firstHostel(p)
	if err == nil && !ok {
		err = noHostel()
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !strings.Contains(c.GetHeader("accept"), "application/x-ndjson") {
		out, err := a.Service.openCheckout(c, id, p.UserID, func(string) {})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out, "Checkout opened")
		return
	}
	// progressResponse: each stage as it starts, for the hand-off screen.
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Type", "application/x-ndjson; charset=utf-8")
	c.Header("X-Accel-Buffering", "no")
	c.Status(200)
	send := func(v any) {
		line, err := json.Marshal(v)
		if err == nil {
			_, _ = c.Writer.Write(append(line, '\n'))
			c.Writer.Flush()
		}
	}
	out, err := a.Service.openCheckout(c, id, p.UserID, func(name string) { send(gin.H{"step": name}) })
	if err != nil {
		code, message := "INTERNAL_SERVER_ERROR", "Something went wrong."
		var he *httpx.Error
		if errors.As(err, &he) {
			code, message = he.ErrorCode, he.Message
		} else {
			slog.ErrorContext(c, "billing_checkout_failed", "error", err.Error())
		}
		send(gin.H{"error": gin.H{"errorCode": code, "message": message}})
		return
	}
	send(gin.H{"data": out})
}

type claimOut struct {
	Amount    int64  `json:"amount"`
	ClaimedAt string `json:"claimedAt"`
	ID        string `json:"id"`
	Number    string `json:"invoiceNumber"`
}

func stringField(body any, key string) string {
	if m, ok := body.(map[string]any); ok {
		if v, ok := m[key].(string); ok {
			return v
		}
	}
	return ""
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func optionalText(s string, n int) any {
	if s = clipRunes(strings.TrimSpace(s), n); s != "" {
		return s
	}
	return nil
}

// loadProof: ownership, tenancy, a finished recent upload, and not one of our own documents.
// A missing asset and somebody else's answer identically.
func (s *Service) loadProof(ctx context.Context, assetID, hostelID, actorID string) (bson.ObjectID, error) {
	notOwned := payErr(403, "PROOF_NOT_OWNED", "That file is not yours to submit. Please attach the screenshot again.")
	id, err := bson.ObjectIDFromHex(assetID)
	if err != nil {
		return id, notOwned
	}
	var asset struct {
		HostelID  *bson.ObjectID `bson:"hostelId"`
		OwnerID   *bson.ObjectID `bson:"ownerId"`
		SystemDoc *string        `bson:"systemDocumentKind"`
		Completed *time.Time     `bson:"uploadCompletedAt"`
	}
	err = s.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&asset)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return id, notOwned
	}
	if err != nil {
		return id, err
	}
	if asset.OwnerID == nil || asset.OwnerID.Hex() != actorID || (asset.HostelID != nil && asset.HostelID.Hex() != hostelID) {
		return id, notOwned
	}
	if asset.Completed == nil {
		return id, payErr(422, "PROOF_UPLOAD_INCOMPLETE", "That file did not finish uploading. Please attach the screenshot again.")
	}
	if asset.Completed.Before(time.Now().Add(-evidenceMaxAge)) {
		return id, payErr(422, "PROOF_UPLOAD_INCOMPLETE", "That upload has expired. Please attach the screenshot again.")
	}
	if asset.SystemDoc != nil && *asset.SystemDoc != "" {
		return id, payErr(422, "PROOF_IS_OUR_DOCUMENT", "That is a document we issued, not proof of a payment you made. Attach the screenshot from your banking app.")
	}
	return id, nil
}

// claim is submitPlanPaymentClaim: a statement by the payer, written IN_REVIEW, which
// moves no balance. The amount is the server's.
func (a *Admin) claim(c *gin.Context) {
	p := authz.From(c)
	hostelID, ok, err := firstHostel(p)
	if err == nil && !ok {
		err = payErr(403, "HOSTEL_SCOPE_REQUIRED", "No hostel in scope")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	proofID := stringField(body, "proofAssetId")
	if proofID == "" {
		httpx.Fail(c, payErr(422, "PROOF_REQUIRED", "Attach a screenshot of your payment before submitting."))
		return
	}
	s := a.Service
	inv, err := s.payableInvoice(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	outstanding, err := s.outstanding(c, inv)
	if err == nil && outstanding <= 0 {
		err = payErr(409, "ALREADY_SETTLED", "This invoice is already settled in full.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	err = s.DB.Collection("subscriptionpayments").FindOne(c, bson.D{{Key: "invoiceId", Value: inv.ID}, {Key: "status", Value: "IN_REVIEW"}}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == nil {
		httpx.Fail(c, payErr(409, "CLAIM_ALREADY_IN_REVIEW", "You have already sent us proof for this invoice and our team is checking it. We will email you as soon as it is verified."))
		return
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	proof, err := s.loadProof(c, proofID, hostelID.Hex(), p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	reference := stringField(body, "reference")
	id := bson.NewObjectID()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := s.DB.Collection("subscriptionpayments").InsertOne(c, bson.D{{Key: "_id", Value: id}, {Key: "amount", Value: outstanding}, {Key: "currency", Value: "NPR"}, {Key: "claimNote", Value: optionalText(stringField(body, "note"), claimNoteMax)}, {Key: "claimedAt", Value: now},
		{Key: "gatewayReference", Value: optionalText(reference, claimReferenceMax)}, {Key: "hostelId", Value: inv.HostelID}, {Key: "invoiceId", Value: inv.ID}, {Key: "isMocked", Value: false}, {Key: "method", Value: "MANUAL"}, {Key: "proofAssetId", Value: proof},
		{Key: "recordedBy", Value: actor}, {Key: "status", Value: "IN_REVIEW"}, {Key: "subscriptionId", Value: inv.SubscriptionID}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "SUBSCRIPTION_PAYMENT_CLAIM_SUBMITTED", ActorID: actor, ActorType: "USER", EntityID: id.Hex(), EntityType: "SubscriptionPayment", HostelID: inv.HostelID,
		Metadata: bson.D{{Key: "amount", Value: outstanding}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "proofAssetId", Value: proof.Hex()}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	var sub struct {
		CurrentPeriodEnd *time.Time `bson:"currentPeriodEnd"`
		DueBy            *time.Time `bson:"dueBy"`
	}
	if err := s.DB.Collection("hostelsubscriptions").FindOne(c, bson.D{{Key: "_id", Value: inv.SubscriptionID}}).Decode(&sub); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	// A claim that was accepted was accepted, mail or no mail.
	if inv.BilledTo.Email != "" {
		until := ""
		if sub.DueBy != nil {
			until = email.EmailDate(*sub.DueBy)
		} else if sub.CurrentPeriodEnd != nil {
			until = email.EmailDate(*sub.CurrentPeriodEnd)
		}
		hostel := inv.BilledTo.HostelName
		if hostel == "" {
			hostel = "your hostel"
		}
		m := email.SubscriptionClaimReceived(outstanding, hostel, inv.InvoiceNumber, inv.BilledTo.Name, inv.PlanName, strings.TrimSpace(reference), until)
		if r := a.Mail.Send(c, email.Message{Category: m.Category, To: []string{inv.BilledTo.Email}, Subject: m.Subject, HTML: m.HTML}); !r.Sent {
			slog.WarnContext(c, "subscription_claim_received_email_failed", "reason", r.Reason)
		}
	}
	httpx.OK(c, struct {
		Claim claimOut `json:"claim"`
	}{claimOut{outstanding, httpx.ISO(now), id.Hex(), inv.InvoiceNumber}}, "Payment proof submitted")
}

type instructionsClaim struct {
	Amount    int64   `json:"amount"`
	ClaimedAt any     `json:"claimedAt"`
	Reference *string `json:"reference"`
}

type instructionsInvoice struct {
	ID       string `json:"id"`
	Number   string `json:"invoiceNumber"`
	PlanName string `json:"planName"`
}

type instructionsQR struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type instructions struct {
	AmountDue int64                `json:"amountDue"`
	Claim     *instructionsClaim   `json:"claim"`
	DueBy     any                  `json:"dueBy"`
	Invoice   *instructionsInvoice `json:"invoice"`
	Overdue   bool                 `json:"overdue"`
	QR        *instructionsQR      `json:"qr"`
	Reference *string              `json:"reference"`
}

type instructionsWrap struct {
	Instructions instructions `json:"instructions"`
}

func (a *Admin) payInstructions(c *gin.Context) {
	id, ok, err := firstHostel(authz.From(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !ok {
		httpx.OK(c, instructionsWrap{}, "No hostel in scope")
		return
	}
	s := a.Service
	state, err := s.State(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var out instructions
	ops := s.Config.OperationsTyped(c)
	if ops.CollectionQrURL != "" {
		label := ops.CollectionQrLabel
		if label == "" {
			label = "Scan to pay"
		}
		out.QR = &instructionsQR{label, ops.CollectionQrURL}
	}
	if state != nil {
		out.DueBy = state.Subscription.DueBy
	}
	if state == nil || state.Invoice == nil {
		httpx.OK(c, instructionsWrap{out}, "Payment instructions loaded")
		return
	}
	invoiceID, err := bson.ObjectIDFromHex(state.Invoice.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var pending struct {
		Amount    int64      `bson:"amount"`
		ClaimedAt *time.Time `bson:"claimedAt"`
		Reference *string    `bson:"gatewayReference"`
	}
	err = s.DB.Collection("subscriptionpayments").FindOne(c, bson.D{{Key: "invoiceId", Value: invoiceID}, {Key: "status", Value: "IN_REVIEW"}}, options.FindOne().SetSort(bson.D{{Key: "claimedAt", Value: -1}})).Decode(&pending)
	if err == nil {
		out.Claim = &instructionsClaim{pending.Amount, iso(pending.ClaimedAt), pending.Reference}
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	out.AmountDue = state.Outstanding
	out.Invoice = &instructionsInvoice{state.Invoice.ID, state.Invoice.Number, state.Invoice.PlanName}
	out.Reference = &state.Invoice.Number
	if due, isStr := state.Subscription.DueBy.(string); isStr {
		if t, err := time.Parse(time.RFC3339Nano, due); err == nil {
			out.Overdue = t.Before(time.Now())
		}
	}
	httpx.OK(c, instructionsWrap{out}, "Payment instructions loaded")
}

func (a *Admin) renew(c *gin.Context) {
	p := authz.From(c)
	id, ok, err := firstHostel(p)
	if err == nil && !ok {
		err = noHostel()
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	cycle, _ := f.Enum("cycle", false, nil, "monthly", "halfYearly", "annual")
	planID, _ := f.Str("planId", valid.S{Trim: true, Min: 1})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	reused, err := a.Service.raiseRenewal(c, id, plans.Cycle(cycle), planID, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	message := "Invoice raised"
	if reused {
		message = "Invoice already open"
	}
	httpx.Write(c, 201, struct {
		Reused bool `json:"reused"`
	}{reused}, message)
}

// raiseRenewal is raiseRenewalInvoice for the portal's own button: extends the running
// plan, on the same plan or a bigger one.
func (s *Service) raiseRenewal(ctx context.Context, hostelID bson.ObjectID, cycle plans.Cycle, planID, userID string) (bool, error) {
	got, err := GetOrCreateSubscription(ctx, s.DB, hostelID, "PUBLIC", nil)
	if err != nil {
		return false, err
	}
	if got.LifetimeSince != nil {
		return false, payErr(409, "LIFETIME_PLAN", "This hostel is on a lifetime plan. There is nothing to renew or change.")
	}
	var sub struct {
		ID               bson.ObjectID  `bson:"_id"`
		HostelID         bson.ObjectID  `bson:"hostelId"`
		AgentID          *bson.ObjectID `bson:"agentId"`
		CurrentPeriodEnd *time.Time     `bson:"currentPeriodEnd"`
		Status           string         `bson:"status"`
	}
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "_id", Value: got.ID}}).Decode(&sub); err != nil {
		return false, err
	}
	open, err := s.openPlanInvoice(ctx, sub.ID)
	if err != nil {
		return false, err
	}
	if open != nil {
		_, err := s.ensureRaised(ctx, open, false)
		return true, err
	}
	var hostel struct {
		Name     string `bson:"name"`
		Verified string `bson:"verificationStatus"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: sub.HostelID}}).Decode(&hostel); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return false, payErr(404, "HOSTEL_NOT_FOUND", "Hostel not found.")
		}
		return false, err
	}
	if hostel.Verified != "VERIFIED" {
		return false, payErr(409, "NOT_VERIFIED", "This hostel is still being verified, so it cannot buy a plan yet. You will be emailed the moment it is.")
	}
	stored, err := s.catalog(ctx)
	if err != nil {
		return false, err
	}
	period, err := bs.CurrentPeriod(time.Now())
	if err != nil {
		return false, err
	}
	plan := plans.GetPlan(plans.SellingCatalog(stored, period), planID)
	if plan == nil {
		return false, payErr(404, "PLAN_NOT_FOUND", "That plan is no longer available. Choose another one.")
	}
	total := plans.CycleTotal(*plan, cycle)
	if total <= 0 {
		return false, payErr(409, "PLAN_NOT_PRICED", "That plan has no price set, so it cannot be invoiced. Ask the platform team to price it.")
	}
	if err := s.assertBranchesFit(ctx, sub.HostelID, stored, plan.ID); err != nil {
		return false, err
	}
	months := plans.CycleMonths(cycle)
	now := time.Now().UTC().Truncate(time.Millisecond)
	start, end, err := servicePeriod(months, sub.CurrentPeriodEnd, now)
	if err != nil {
		return false, err
	}
	mail, ownerName, _, err := s.billingContact(ctx, sub.HostelID)
	if err != nil {
		return false, err
	}
	number, err := s.allocateInvoiceNumber(ctx, sub.HostelID)
	if err != nil {
		return false, err
	}
	amount := int64(total)
	inv := &planInvoice{ID: bson.NewObjectID(), Amount: amount, Cycle: string(cycle), CycleMonths: months, HostelID: sub.HostelID, InvoiceNumber: number, IssuedAt: &now, Kind: "PLAN", PeriodEnd: &end, PeriodStart: &start, PlanID: plan.ID, PlanName: plan.Name, Status: "OPEN", SubscriptionID: sub.ID}
	inv.BilledTo.Email, inv.BilledTo.HostelName, inv.BilledTo.Name = mail, hostel.Name, ownerName
	due := bs.DayEnd(now, s.Config.OperationsTyped(ctx).SubscriptionDueGraceDays)
	inv.DueAt = &due
	if _, err := s.DB.Collection("subscriptioninvoices").InsertOne(ctx, bson.D{{Key: "_id", Value: inv.ID}, {Key: "agentId", Value: sub.AgentID}, {Key: "amount", Value: amount}, {Key: "billedTo", Value: bson.D{{Key: "email", Value: mail}, {Key: "hostelName", Value: hostel.Name}, {Key: "name", Value: ownerName}}},
		{Key: "currency", Value: "NPR"}, {Key: "cycle", Value: string(cycle)}, {Key: "cycleMonths", Value: months}, {Key: "dueAt", Value: due}, {Key: "hostelId", Value: sub.HostelID}, {Key: "invoiceNumber", Value: number}, {Key: "issuedAt", Value: now}, {Key: "kind", Value: "PLAN"}, {Key: "lifetime", Value: false},
		{Key: "periodEnd", Value: end}, {Key: "periodStart", Value: start}, {Key: "planId", Value: plan.ID}, {Key: "planName", Value: plan.Name}, {Key: "source", Value: "PUBLIC"}, {Key: "status", Value: "OPEN"}, {Key: "subscriptionId", Value: sub.ID},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return false, err
	}
	if _, err := s.ensureRaised(ctx, inv, false); err != nil {
		return false, err
	}
	// A running plan stays ACTIVE while its renewal is open: that is paying early, not owing.
	if sub.Status != "ACTIVE" {
		if _, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: sub.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "AWAITING_PAYMENT"}, {Key: "updatedAt", Value: now}}}}); err != nil {
			return false, err
		}
	}
	actor, err := httpx.OID(userID, "user id")
	if err != nil {
		return false, err
	}
	return false, s.Audit.Write(ctx, audit.Entry{Action: "SUBSCRIPTION_RENEWAL_INVOICE_ISSUED", ActorID: actor, ActorType: "USER", EntityID: inv.ID.Hex(), EntityType: "SubscriptionInvoice", HostelID: sub.HostelID,
		Metadata: bson.D{{Key: "amount", Value: amount}, {Key: "cycle", Value: string(cycle)}, {Key: "invoiceNumber", Value: number}, {Key: "lifetime", Value: false}, {Key: "planId", Value: plan.ID}}})
}

// allocateInvoiceNumber is allocateNumber: per hostel for life, with a hostel suffix, so
// no global counter leaks the platform's volume.
func (s *Service) allocateInvoiceNumber(ctx context.Context, hostelID bson.ObjectID) (string, error) {
	var counter struct {
		Sequence int `bson:"sequence"`
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := s.DB.Collection("receiptcounters").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "kind", Value: "SUBSCRIPTION_INVOICE"}, {Key: "period", Value: "LIFETIME"}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&counter); err != nil {
		return "", err
	}
	hex := hostelID.Hex()
	return fmt.Sprintf("SUB-%04d-%s", counter.Sequence, strings.ToUpper(hex[len(hex)-4:])), nil
}

// assertBranchesFit: a plan may not leave the hostel with more branches than it allows.
func (s *Service) assertBranchesFit(ctx context.Context, hostelID bson.ObjectID, catalog plans.Catalog, planID string) error {
	n, err := s.DB.Collection("hostels").CountDocuments(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "parentHostelId", Value: hostelID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "REJECTED"}}}})
	if err != nil || n == 0 {
		return err
	}
	plan := plans.GetPlan(catalog, planID)
	limit, name := 0, "that plan"
	if plan != nil {
		limit, name = plan.MaxBranches, plan.Name
	}
	if int(n) <= limit {
		return nil
	}
	noun := "branches"
	if n == 1 {
		noun = "branch"
	}
	return payErr(409, "PLAN_HAS_TOO_FEW_BRANCHES", fmt.Sprintf("This hostel has %d %s, and %s allows %d. Keep a plan with branches, or remove branches first.", n, noun, name, limit))
}
