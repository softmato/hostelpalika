package billing

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// PlanCheckout is POST /public/plan-checkout: a hostel pays for its plan with no
// account, proven by a code to the hostel's email (or a signed pay link), then a
// short-lived token carries it through choosing, paying and claiming.
type PlanCheckout struct {
	Settler *Settler
	Limiter *ratelimit.Limiter
	// RequestOTP / VerifyOTP / Cooldown are the auth service's challenge.
	RequestOTP func(ctx context.Context, email, ip, userAgent string) (id, expiresAt, devCode string, err error)
	VerifyOTP  func(ctx context.Context, challengeID, code string) (string, error)
	Cooldown   func() time.Duration
	// ClaimValid is isValidDocumentClaimToken: the upload the anonymous payer may attach.
	ClaimValid func(assetID, token string) bool
}

func (p *PlanCheckout) Register(v1 *gin.RouterGroup) { v1.POST("/public/plan-checkout", p.run) }

const (
	checkoutTokenType  = "plan-checkout"
	payLinkType        = "plan-pay-link"
	checkoutNotMatched = "This email and Hostel ID don't match. Please check both."
)

var (
	sixDigits     = regexp.MustCompile(`^\d{6}$`)
	nonHex        = regexp.MustCompile(`[^0-9A-F]`)
	checkoutSteps = []string{"start", "verify", "invoice", "pay", "link", "months", "resume", "claim"}
)

// normalizeHostelCode: "H" is not a hex digit, so stripping non-hex drops the prefix too.
func normalizeHostelCode(in string) string {
	bare := nonHex.ReplaceAllString(strings.ToUpper(in), "")
	if len(bare) != 8 {
		return ""
	}
	return "HH-" + bare
}

func (p *PlanCheckout) run(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	step, _ := f.M["step"].(string)
	known := false
	for _, s := range checkoutSteps {
		known = known || s == step
	}
	if !known {
		f.Is.Add("step", "Invalid discriminator value. Expected '"+strings.Join(checkoutSteps, "' | '")+"'")
		httpx.Fail(c, f.Err())
		return
	}
	in := p.parse(f, step)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if step == "start" || step == "verify" {
		if err := p.Limiter.PublicForm(c, "plan-checkout-"+step); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if step == "pay" {
		httpx.Progress(c, "OK", func(stepFn func(string)) (any, error) {
			t, err := p.Settler.readToken(in.token)
			if err != nil {
				return nil, err
			}
			return p.Settler.openCheckout(c, t.hostel, t.owner.Hex(), stepFn)
		})
		return
	}
	out, err := p.step(c, step, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "OK")
}

type checkoutIn struct {
	email, hostelCode, challengeID, code, token, link, planID, claimToken, fileAssetID, reference string
	cycle                                                                                         plans.Cycle
	lifetime                                                                                      bool
	months                                                                                        int
}

func (p *PlanCheckout) parse(f *valid.Form, step string) checkoutIn {
	var in checkoutIn
	token := func() { in.token, _ = f.Str("token", valid.S{Min: 1}) }
	planID := func() { in.planID, _ = f.Str("planId", valid.S{Opt: true, Trim: true, Min: 1}) }
	switch step {
	case "start":
		msg := ""
		if _, isStr := f.M["email"].(string); isStr {
			msg = "Enter the hostel's email address."
		}
		in.email, _ = f.Email("email", false, msg)
		in.hostelCode, _ = f.Str("hostelCode", valid.S{Trim: true, Min: 1, MinMsg: "Enter your Hostel ID."})
	case "verify":
		in.challengeID, _ = f.Str("challengeId", valid.S{Trim: true, Min: 1})
		in.code, _ = f.Str("code", valid.S{Trim: true, Re: sixDigits, ReMsg: "Enter the 6-digit code."})
		in.hostelCode, _ = f.Str("hostelCode", valid.S{Trim: true, Min: 1})
	case "invoice":
		cycle, _ := f.Enum("cycle", false, nil, "monthly", "halfYearly", "annual")
		in.cycle = plans.Cycle(cycle)
		in.lifetime, _ = f.Bool("lifetime", true, nil)
		planID()
		token()
	case "link":
		in.link, _ = f.Str("link", valid.S{Min: 1})
	case "months":
		months, _ := f.Num("months", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(12)})
		in.months = int(months)
		planID()
		token()
	case "claim":
		in.claimToken, _ = f.Str("claimToken", valid.S{Min: 1})
		in.fileAssetID, _ = f.Str("fileAssetId", valid.S{Min: 1})
		in.reference, _ = f.Str("reference", valid.S{Opt: true, Trim: true, Max: 120})
		token()
	default: // pay, resume
		token()
	}
	return in
}

func (p *PlanCheckout) step(c *gin.Context, step string, in checkoutIn) (any, error) {
	s := p.Settler
	switch step {
	case "start":
		hostel, err := s.findHostelForCheckout(c, in.email, in.hostelCode)
		if err != nil {
			return nil, err
		}
		if hostel == nil {
			return nil, payErr(404, "HOSTEL_NOT_MATCHED", checkoutNotMatched)
		}
		return p.start(c, in.email)
	case "verify":
		identifier, err := p.VerifyOTP(c, in.challengeID, in.code)
		if err != nil {
			return nil, err
		}
		challenge, _ := bson.ObjectIDFromHex(in.challengeID)
		var ch struct {
			Purpose string `bson:"purpose"`
		}
		if err := s.DB.Collection("otpchallenges").FindOne(c, bson.D{{Key: "_id", Value: challenge}}, options.FindOne().SetProjection(bson.D{{Key: "purpose", Value: 1}})).Decode(&ch); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
		if ch.Purpose != checkoutTokenType {
			return nil, payErr(400, "OTP_INVALID", "That code is not for a plan checkout.")
		}
		hostel, err := s.findHostelForCheckout(c, identifier, in.hostelCode)
		if err != nil {
			return nil, err
		}
		if hostel == nil {
			return nil, payErr(404, "HOSTEL_NOT_MATCHED", checkoutNotMatched)
		}
		if _, err := s.DB.Collection("otpchallenges").UpdateOne(c, bson.D{{Key: "_id", Value: challenge}}, bson.D{{Key: "$set", Value: bson.D{{Key: "consumedAt", Value: nowMS()}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
			return nil, err
		}
		return p.opened(c, hostel.ID, hostel.OwnerID, hostel.Name)
	case "link":
		linked := p.readPayLink(c, in.link)
		if linked == nil {
			return nil, payErr(401, "CHECKOUT_EXPIRED", "This payment link has expired. Enter your hostel's email and ID to get a fresh one.")
		}
		name, err := s.hostelName(c, linked.ID)
		if err != nil {
			return nil, err
		}
		return p.opened(c, linked.ID, linked.OwnerID, name)
	}
	t, err := p.Settler.readToken(in.token)
	if err != nil {
		return nil, err
	}
	switch step {
	case "invoice":
		planID := in.planID
		if in.lifetime {
			if planID == "" {
				planID, err = s.currentPlanID(c, t.hostel)
			}
		} else {
			planID, err = s.notBelowRunningPlan(c, t.hostel, in.planID)
		}
		if err != nil {
			return nil, err
		}
		inv, reused, err := s.RaiseRenewalInvoice(c, t.hostel, RenewalIn{Cycle: in.cycle, Lifetime: in.lifetime, PlanID: planID}, &t.owner, RenewalOptions{DeferDocument: true, Reshape: in.planID != ""})
		if err != nil {
			return nil, err
		}
		view, err := s.checkoutView(c, t.hostel, inv)
		if err != nil {
			return nil, err
		}
		return append(ordered.Map{{Key: "reused", Value: reused}}, view...), nil
	case "months":
		planID := ""
		if in.planID != "" {
			if planID, err = s.notBelowRunningPlan(c, t.hostel, in.planID); err != nil {
				return nil, err
			}
		}
		inv, err := s.ChangeOpenInvoiceMonths(c, t.hostel, in.months, t.owner, planID)
		if err != nil {
			return nil, err
		}
		return s.checkoutView(c, t.hostel, inv)
	case "resume":
		name, err := s.hostelName(c, t.hostel)
		if err != nil {
			return nil, err
		}
		var open *planInvoice
		var row planInvoice
		err = s.DB.Collection("subscriptioninvoices").FindOne(c, bson.D{{Key: "hostelId", Value: t.hostel}, {Key: "kind", Value: bson.D{{Key: "$ne", Value: "SETUP_FEE"}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL"}}}}},
			options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&row)
		if err == nil {
			open = &row
		} else if !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
		hostel, err := s.checkoutHostel(c, t.hostel, name)
		if err != nil {
			return nil, err
		}
		view, err := s.checkoutView(c, t.hostel, open)
		if err != nil {
			return nil, err
		}
		return append(ordered.Map{{Key: "hostel", Value: hostel}}, view...), nil
	}
	// claim
	asset, err := bson.ObjectIDFromHex(in.fileAssetID)
	if err != nil || p.ClaimValid == nil || !p.ClaimValid(in.fileAssetID, in.claimToken) {
		return nil, payErr(403, "PROOF_NOT_OWNED", "Attach the payment screenshot again.")
	}
	if _, err := s.DB.Collection("fileassets").UpdateOne(c, bson.D{{Key: "_id", Value: asset}, {Key: "ownerId", Value: nil}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "hostelId", Value: t.hostel}, {Key: "kind", Value: "PAYMENT_PROOF"}, {Key: "ownerId", Value: t.owner}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		return nil, err
	}
	return s.SubmitClaim(c, t.hostel, t.owner.Hex(), in.fileAssetID, in.reference, "")
}

// start sends the code; a second ask inside the resend cooldown resumes the live
// challenge instead of failing, so a reload does not strand the owner.
func (p *PlanCheckout) start(ctx context.Context, email string) (ordered.Map, error) {
	ip, ua := "", ""
	if c, ok := ctx.(*gin.Context); ok {
		ip, ua = c.ClientIP(), c.GetHeader("User-Agent")
	}
	cooldown := p.Cooldown()
	id, expiresAt, devCode, err := p.RequestOTP(ctx, email, ip, ua)
	if err == nil {
		if devCode != "" {
			slog.InfoContext(ctx, "[plan-checkout] code for "+email+": "+devCode)
		}
		return ordered.Map{{Key: "challengeId", Value: id}, {Key: "expiresAt", Value: expiresAt}, {Key: "resendInSeconds", Value: ceilSeconds(cooldown)}, {Key: "resumed", Value: false}}, nil
	}
	var he *httpx.Error
	if !errors.As(err, &he) || he.ErrorCode != "OTP_RESEND_COOLDOWN" {
		return nil, err
	}
	var live struct {
		ID             bson.ObjectID `bson:"_id"`
		CodeLastSentAt time.Time     `bson:"codeLastSentAt"`
		ExpiresAt      time.Time     `bson:"expiresAt"`
	}
	if ferr := p.Settler.DB.Collection("otpchallenges").FindOne(ctx, bson.D{{Key: "channel", Value: "email"}, {Key: "consumedAt", Value: nil}, {Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: time.Now()}}},
		{Key: "identifier", Value: email}, {Key: "purpose", Value: checkoutTokenType}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&live); ferr != nil {
		if errors.Is(ferr, mongo.ErrNoDocuments) {
			return nil, err
		}
		return nil, ferr
	}
	return ordered.Map{{Key: "challengeId", Value: live.ID.Hex()}, {Key: "expiresAt", Value: httpx.ISO(live.ExpiresAt)}, {Key: "resendInSeconds", Value: ceilSeconds(max(0, cooldown-time.Since(live.CodeLastSentAt)))}, {Key: "resumed", Value: true}}, nil
}

func ceilSeconds(d time.Duration) int64 { return int64((d + time.Second - 1) / time.Second) }

// opened is verify's and link's answer: the hostel, a fresh token, and how it can pay.
func (p *PlanCheckout) opened(ctx context.Context, hostelID, ownerID bson.ObjectID, name string) (ordered.Map, error) {
	s := p.Settler
	hostel, err := s.checkoutHostel(ctx, hostelID, name)
	if err != nil {
		return nil, err
	}
	token, err := p.signToken(hostelID, ownerID)
	if err != nil {
		return nil, err
	}
	state, err := s.paymentState(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	return append(ordered.Map{{Key: "hostel", Value: hostel}, {Key: "token", Value: token}}, state...), nil
}

type checkoutToken struct{ hostel, owner bson.ObjectID }

// CheckoutOwner is readCheckoutToken's ownerId: the owner a plan checkout was opened for.
func (s *Service) CheckoutOwner(raw string) (string, error) {
	t, err := s.readToken(raw)
	return t.owner.Hex(), err
}

// OpenCheckout is openSubscriptionCheckout for the hostel's payable invoice.
func (s *Service) OpenCheckout(ctx context.Context, hostelID bson.ObjectID, userID string, step func(string)) (any, error) {
	return s.openCheckout(ctx, hostelID, userID, step)
}

func (p *PlanCheckout) signToken(hostelID, ownerID bson.ObjectID) (string, error) {
	now := time.Now()
	return jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"ownerId": ownerID.Hex(), "tokenType": checkoutTokenType, "sub": hostelID.Hex(), "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}).
		SignedString([]byte(p.Settler.PayLinkSecret))
}

// claimsOf verifies an HS256 token of one type: its subject and ownerId.
func (s *Service) claimsOf(raw, tokenType string) (bson.ObjectID, bson.ObjectID, bool) {
	claims := jwt.MapClaims{}
	t, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) { return []byte(s.PayLinkSecret), nil }, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !t.Valid || claims["tokenType"] != tokenType {
		return bson.ObjectID{}, bson.ObjectID{}, false
	}
	sub, _ := claims["sub"].(string)
	owner, _ := claims["ownerId"].(string)
	hostelID, err1 := bson.ObjectIDFromHex(sub)
	ownerID, err2 := bson.ObjectIDFromHex(owner)
	return hostelID, ownerID, err1 == nil && err2 == nil
}

func (s *Service) readToken(raw string) (checkoutToken, error) {
	hostel, owner, ok := s.claimsOf(raw, checkoutTokenType)
	if !ok {
		return checkoutToken{}, payErr(401, "CHECKOUT_EXPIRED", "This checkout has expired. Start again with your hostel's email and ID.")
	}
	return checkoutToken{hostel, owner}, nil
}

type checkoutMatch struct {
	ID       bson.ObjectID  `bson:"_id"`
	Name     string         `bson:"name"`
	OwnerID  bson.ObjectID  `bson:"ownerId"`
	ParentID *bson.ObjectID `bson:"parentHostelId"`
}

// readPayLink is readPlanPayLink: valid only while the link's owner still owns
// the hostel that pays.
func (p *PlanCheckout) readPayLink(ctx context.Context, raw string) *checkoutMatch {
	hostelID, ownerID, ok := p.Settler.claimsOf(raw, payLinkType)
	if !ok {
		return nil
	}
	row, err := p.Settler.billedHostel(ctx, bson.D{{Key: "_id", Value: hostelID}})
	if err != nil || row == nil || row.OwnerID != ownerID {
		return nil
	}
	return row
}

var live = bson.E{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}

// billedHostel is the hostel that pays for the match: a branch's main hostel.
func (s *Service) billedHostel(ctx context.Context, filter bson.D) (*checkoutMatch, error) {
	var h checkoutMatch
	if err := s.DB.Collection("hostels").FindOne(ctx, append(filter, live)).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	if h.ParentID == nil {
		return &h, nil
	}
	return s.billedHostel(ctx, bson.D{{Key: "_id", Value: *h.ParentID}})
}

// findHostelForCheckout is the email+Hostel ID match: the email is an owner
// account's or the hostel's own contact address, and the ID names one of those.
func (s *Service) findHostelForCheckout(ctx context.Context, email, code string) (*checkoutMatch, error) {
	hostels := s.DB.Collection("hostels")
	cur, err := s.DB.Collection("users").Find(ctx, bson.D{{Key: "email", Value: email}, live}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var accounts []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &accounts); err != nil {
		return nil, err
	}
	var bound []checkoutMatch
	cur, err = hostels.Find(ctx, bson.D{{Key: "contact.email", Value: bson.Regex{Pattern: "^" + regexp.QuoteMeta(email) + "$", Options: "i"}}, live})
	if err != nil {
		return nil, err
	}
	if err := cur.All(ctx, &bound); err != nil {
		return nil, err
	}
	if len(accounts) > 0 {
		ids := make(bson.A, len(accounts))
		for i, a := range accounts {
			ids[i] = a.ID
		}
		var owned []checkoutMatch
		cur, err = hostels.Find(ctx, bson.D{live, {Key: "ownerId", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err != nil {
			return nil, err
		}
		if err := cur.All(ctx, &owned); err != nil {
			return nil, err
		}
		bound = append(owned, bound...)
	}
	wanted := normalizeHostelCode(code)
	if wanted == "" {
		return nil, nil
	}
	for i := range bound {
		if HostelCode(bound[i].ID.Hex()) == wanted {
			if bound[i].ParentID == nil {
				return &bound[i], nil
			}
			return s.billedHostel(ctx, bson.D{{Key: "_id", Value: *bound[i].ParentID}})
		}
	}
	return nil, nil
}

func (s *Service) hostelName(ctx context.Context, id bson.ObjectID) (string, error) {
	var h struct {
		Name string `bson:"name"`
	}
	err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		err = nil
	}
	return h.Name, err
}

func (s *Service) checkoutHostel(ctx context.Context, id bson.ObjectID, name string) (ordered.Map, error) {
	n, err := s.DB.Collection("hostels").CountDocuments(ctx, bson.D{live, {Key: "parentHostelId", Value: id}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "REJECTED"}}}})
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "branches", Value: n}, {Key: "code", Value: HostelCode(id.Hex())}, {Key: "name", Value: name}}, nil
}

// paymentState is how the hostel can pay and what it is on now.
func (s *Service) paymentState(ctx context.Context, hostelID bson.ObjectID) (ordered.Map, error) {
	state, err := s.State(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	ins, err := s.Instructions(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	var plan any
	if state != nil {
		end := state.Subscription.CurrentPeriodEnd
		if state.Subscription.LifetimeSince != nil {
			end = nil
		}
		plan = ordered.Map{{Key: "currentPeriodEnd", Value: end}, {Key: "name", Value: state.Subscription.PlanName}, {Key: "status", Value: state.Subscription.Status}}
	}
	return ordered.Map{{Key: "instructions", Value: ins}, {Key: "online", Value: s.Softmato != nil}, {Key: "plan", Value: plan}}, nil
}

func isoOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

// checkoutView is what the checkout shows around an invoice: the plan the
// hostel will be on once it is paid, its history, and how to pay.
func (s *Service) checkoutView(ctx context.Context, hostelID bson.ObjectID, inv *planInvoice) (ordered.Map, error) {
	history, err := s.History(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	hist := ordered.Map{{Key: "invoices", Value: history.Invoices}, {Key: "payments", Value: history.Payments}, {Key: "plan", Value: history.Plan}}
	state, err := s.paymentState(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	if inv != nil && inv.Lifetime {
		return append(ordered.Map{
			{Key: "afterPayment", Value: ordered.Map{{Key: "cycleLabel", Value: "Lifetime"}, {Key: "daysRemaining", Value: nil}, {Key: "note", Value: "Paid once. No renewals, and no free months — it starts the day it is paid."},
				{Key: "planName", Value: inv.PlanName}, {Key: "runsUntil", Value: nil}}},
			{Key: "history", Value: hist},
			{Key: "invoice", Value: ordered.Map{{Key: "amount", Value: inv.Amount}, {Key: "cycle", Value: inv.Cycle}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "lifetime", Value: true}, {Key: "monthsLocked", Value: true},
				{Key: "months", Value: nil}, {Key: "periodEnd", Value: nil}, {Key: "planId", Value: inv.PlanID}, {Key: "planName", Value: inv.PlanName}}},
		}, state...), nil
	}
	if inv == nil {
		return append(ordered.Map{{Key: "afterPayment", Value: nil}, {Key: "history", Value: hist}, {Key: "invoice", Value: nil}}, state...), nil
	}
	// The plan runs to whichever is later: the running period, or the one this invoice buys.
	var runningEnd *time.Time
	held := history.Plan
	if held != nil {
		if v, ok := held.CurrentPeriodEnd.(string); ok {
			if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
				runningEnd = &t
			}
		}
	}
	runsUntil := inv.PeriodEnd
	if runningEnd != nil && (inv.PeriodEnd == nil || !runningEnd.Before(*inv.PeriodEnd)) {
		runsUntil = runningEnd
	}
	keeps := false
	if held != nil {
		if planID, ok := held.PlanID.(string); ok && planID != "" {
			catalog, err := s.catalog(ctx)
			if err != nil {
				return nil, err
			}
			months := 0
			switch m := held.CycleMonths.(type) {
			case int64:
				months = int(m)
			case int:
				months = m
			}
			keeps = PlanAfterPayment(catalog, planID, months, inv) == "current"
		}
	}
	var cycleLabel, note, planName any = inv.Cycle, nil, inv.PlanName
	if keeps {
		label, _ := held.CycleLabel.(string)
		cycleLabel, planName = label, held.PlanName
		if held.PlanName == nil {
			planName = inv.PlanName
		}
		unit := "months"
		if inv.CycleMonths == 1 {
			unit = "month"
		}
		heldName, _ := held.PlanName.(string)
		note = itoa(int64(inv.CycleMonths)) + " " + unit + " of " + inv.PlanName + " added to your " + heldName + " · " + label + " plan."
	} else {
		for _, row := range history.Invoices {
			if row.InvoiceNumber == inv.InvoiceNumber {
				cycleLabel = row.CycleLabel
				break
			}
		}
	}
	locked, err := s.InvoiceMonthsLocked(ctx, inv)
	if err != nil {
		return nil, err
	}
	var months any
	if inv.CycleMonths > 0 {
		months = inv.CycleMonths
	}
	return append(ordered.Map{
		{Key: "afterPayment", Value: ordered.Map{{Key: "cycleLabel", Value: cycleLabel}, {Key: "daysRemaining", Value: daysLeftThrough(runsUntil, time.Now())}, {Key: "note", Value: note}, {Key: "planName", Value: planName}, {Key: "runsUntil", Value: isoOrNil(runsUntil)}}},
		{Key: "history", Value: hist},
		{Key: "invoice", Value: ordered.Map{{Key: "amount", Value: inv.Amount}, {Key: "cycle", Value: inv.Cycle}, {Key: "invoiceNumber", Value: inv.InvoiceNumber}, {Key: "lifetime", Value: false}, {Key: "monthsLocked", Value: locked},
			{Key: "months", Value: months}, {Key: "periodEnd", Value: isoOrNil(inv.PeriodEnd)}, {Key: "planId", Value: inv.PlanID}, {Key: "planName", Value: inv.PlanName}}},
	}, state...), nil
}

// notBelowRunningPlan: a checkout may move a running plan up, never down; no
// pick keeps the running plan.
func (s *Service) notBelowRunningPlan(ctx context.Context, hostelID bson.ObjectID, picked string) (string, error) {
	var sub struct {
		PlanID *string `bson:"planId"`
		Status string  `bson:"status"`
	}
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&sub); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return "", err
	}
	held := ""
	if sub.Status == "ACTIVE" && sub.PlanID != nil {
		held = *sub.PlanID
	}
	if picked == "" {
		if held != "" {
			return held, nil
		}
		return s.currentPlanID(ctx, hostelID)
	}
	if held == "" {
		return picked, nil
	}
	catalog, err := s.catalog(ctx)
	if err != nil {
		return "", err
	}
	if plans.PlanRank(catalog, picked) < plans.PlanRank(catalog, held) {
		return held, nil
	}
	return picked, nil
}

// currentPlanID is the subscription's plan, else the featured (or first) one.
func (s *Service) currentPlanID(ctx context.Context, hostelID bson.ObjectID) (string, error) {
	var sub struct {
		PlanID *string `bson:"planId"`
	}
	if err := s.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&sub); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return "", err
	}
	if sub.PlanID != nil && *sub.PlanID != "" {
		return *sub.PlanID, nil
	}
	catalog, err := s.catalog(ctx)
	if err != nil || len(catalog.Plans) == 0 {
		return "", err
	}
	for _, p := range catalog.Plans {
		if p.Featured {
			return p.ID, nil
		}
	}
	return catalog.Plans[0].ID, nil
}
