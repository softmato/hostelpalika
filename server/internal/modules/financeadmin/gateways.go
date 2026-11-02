package financeadmin

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/images"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerGateways(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/payment-gateways", httpx.ETag(), h.listGateways)
	v1.PUT("/hostel-admin/finance/payment-gateways", h.saveGateway)
	v1.DELETE("/hostel-admin/finance/payment-gateways", h.deleteGateway)
	v1.GET("/hostel-admin/finance/payment-profile", httpx.ETag(), h.getProfile)
	v1.PATCH("/hostel-admin/finance/payment-profile", h.patchProfile)
}

var gatewayProviders = []string{"ESEWA", "FONEPAY", "KHALTI"}

var gatewayRequirements = map[string][2]string{ // merchant code label, secret label
	"ESEWA":   {"Product code (eSewa calls it the merchant/service code)", "Secret key"},
	"FONEPAY": {"Merchant code (issued by your bank, not by Fonepay)", "Shared secret"},
	"KHALTI":  {"", "Live secret key (from the Khalti merchant dashboard)"},
}

// FONEPAY_PERSONAL_DAILY_LIMIT (5000), as "en-IN" prints it.
const personalAccountMessage = "A personal wallet can only receive about NPR 5,000 per day, so rent payments would start failing partway through the month. Use a registered merchant account for online payments, or collect this one through your bank account instead."

type gatewayDoc struct {
	AccountKind  string     `bson:"accountKind"`
	EnabledAt    *time.Time `bson:"enabledAt"`
	HealthStatus *string    `bson:"healthStatus"`
	HealthDetail *string    `bson:"healthDetail"`
	LastEventAt  *time.Time `bson:"lastEventAt"`
	LastVerified *time.Time `bson:"lastVerifiedAt"`
	MerchantCode *string    `bson:"merchantCode"`
	Mode         string     `bson:"mode"`
	Provider     string     `bson:"provider"`
}

func (g *gatewayDoc) eligible() bool {
	return g != nil && g.AccountKind != "PERSONAL" && (g.Provider == "KHALTI" || (g.MerchantCode != nil && *g.MerchantCode != ""))
}

func (h *Handler) payable(g *gatewayDoc) bool {
	return g != nil && g.EnabledAt != nil && g.eligible() && (g.Mode == "LIVE" || !h.Production)
}

func (h *Handler) blockedReason(g *gatewayDoc) any {
	switch {
	case g == nil:
		return nil
	case g.AccountKind == "PERSONAL":
		return personalAccountMessage
	case !g.eligible():
		label := gatewayRequirements[g.Provider][0]
		if label == "" {
			label = "merchant code"
		}
		return "Add the " + label + " first."
	case g.Mode == "SANDBOX" && h.Production:
		return "This is still in test mode, so it is not shown to residents. Switch it to live once your merchant account is approved."
	}
	return nil
}

func (h *Handler) gatewayDocs(ctx context.Context, hostel bson.ObjectID) ([]gatewayDoc, error) {
	var p struct {
		Gateways []gatewayDoc `bson:"gateways"`
	}
	err := h.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "gateways", Value: 1}})).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return p.Gateways, err
}

func findGateway(list []gatewayDoc, provider string) *gatewayDoc {
	for i := range list {
		if list[i].Provider == provider {
			return &list[i]
		}
	}
	return nil
}

type secretView struct {
	Configured  bool    `json:"configured"`
	Fingerprint *string `json:"fingerprint"`
	RotatedAt   any     `json:"rotatedAt"`
}

func (h *Handler) describeSecret(ctx context.Context, hostel bson.ObjectID, provider, purpose string) (secretView, error) {
	var row struct {
		Fingerprint *string    `bson:"fingerprint"`
		RotatedAt   *time.Time `bson:"rotatedAt"`
	}
	err := h.DB.Collection("encryptedsecrets").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "provider", Value: provider}, {Key: "purpose", Value: purpose}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return secretView{}, nil
	}
	if err != nil {
		return secretView{}, err
	}
	return secretView{true, row.Fingerprint, isoOrNil(row.RotatedAt)}, nil
}

// gatewayViews is listGatewayConfigs: one row per provider, configured or not.
func (h *Handler) gatewayViews(ctx context.Context, hostel bson.ObjectID) ([]ordered.Map, error) {
	list, err := h.gatewayDocs(ctx, hostel)
	if err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(gatewayProviders))
	for _, provider := range gatewayProviders {
		g := findGateway(list, provider)
		secret, err := h.describeSecret(ctx, hostel, provider, "GATEWAY_SECRET")
		if err != nil {
			return nil, err
		}
		webhook, err := h.describeSecret(ctx, hostel, provider, "GATEWAY_WEBHOOK_SECRET")
		if err != nil {
			return nil, err
		}
		kind, mode := "MERCHANT", "SANDBOX"
		var enabledAt, health, lastEvent, lastVerified, merchant any
		enabled := false
		if g != nil {
			if g.AccountKind != "" {
				kind = g.AccountKind
			}
			if g.Mode != "" {
				mode = g.Mode
			}
			enabled, enabledAt = g.EnabledAt != nil, isoOrNil(g.EnabledAt)
			if g.HealthStatus != nil && *g.HealthStatus != "" && *g.HealthStatus != "UNKNOWN" {
				health = ordered.Map{{Key: "detail", Value: strOrNil(g.HealthDetail)}, {Key: "status", Value: *g.HealthStatus}}
			}
			lastEvent, lastVerified, merchant = isoOrNil(g.LastEventAt), isoOrNil(g.LastVerified), strOrNil(g.MerchantCode)
		}
		out = append(out, ordered.Map{{Key: "accountKind", Value: kind}, {Key: "blockedReason", Value: h.blockedReason(g)}, {Key: "enabled", Value: enabled}, {Key: "enabledAt", Value: enabledAt},
			{Key: "health", Value: health}, {Key: "lastEventAt", Value: lastEvent}, {Key: "lastVerifiedAt", Value: lastVerified}, {Key: "merchantCode", Value: merchant}, {Key: "mode", Value: mode},
			{Key: "payable", Value: h.payable(g)}, {Key: "provider", Value: provider}, {Key: "secret", Value: secret}, {Key: "webhookSecret", Value: webhook}})
	}
	return out, nil
}

func (h *Handler) listGateways(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "managePaymentProfile")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	views, err := h.gatewayViews(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "gateways", Value: views}}, "Payment gateways")
}

func (h *Handler) auditProfile(ctx context.Context, p *authz.Principal, hostel bson.ObjectID, f audit.Finance) error {
	f.HostelID, f.EntityID = hostel, hostel.Hex()
	if f.EntityType == "" {
		f.EntityType = "HostelPaymentProfile"
	}
	return h.auditSchedule(ctx, p, f)
}

// putSecret is putSecret: the gateway key, sealed under the finance master key.
func (h *Handler) putSecret(ctx context.Context, p *authz.Principal, hostel bson.ObjectID, provider, purpose, plaintext string) error {
	trimmed := strings.TrimSpace(plaintext)
	if trimmed == "" {
		return finance.Err("GATEWAY_NOT_CONFIGURED", "A gateway secret cannot be blank.")
	}
	keys, err := crypto.MasterKeys(h.FinanceKey, h.FinancePrev)
	if err != nil {
		return err
	}
	env, err := crypto.EncryptSecret(trimmed, crypto.Scope{HostelID: hostel.Hex(), Purpose: provider + ":" + purpose}, keys[0])
	if err != nil {
		return err
	}
	key := bson.D{{Key: "hostelId", Value: hostel}, {Key: "provider", Value: provider}, {Key: "purpose", Value: purpose}}
	col := h.DB.Collection("encryptedsecrets")
	existing := col.FindOne(ctx, key).Err() == nil
	at := nowMS()
	set := bson.D{{Key: "authTag", Value: env.AuthTag}, {Key: "ciphertext", Value: env.Ciphertext}, {Key: "fingerprint", Value: env.Fingerprint}, {Key: "format", Value: env.Format}, {Key: "iv", Value: env.IV},
		{Key: "keyId", Value: env.KeyID}, {Key: "wrappedKey", Value: env.WrappedKey}, {Key: "wrappedKeyIv", Value: env.WrappedKeyIV}, {Key: "wrappedKeyTag", Value: env.WrappedKeyTag}, {Key: "updatedAt", Value: at}}
	if existing {
		set = append(set, bson.E{Key: "rotatedAt", Value: at})
	}
	insert := append(key, bson.E{Key: "createdAt", Value: at}, bson.E{Key: "__v", Value: 0})
	if me, err := bson.ObjectIDFromHex(p.UserID); err == nil {
		insert = append(insert, bson.E{Key: "createdBy", Value: me})
	}
	if _, err := col.UpdateOne(ctx, key, bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: insert}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return err
	}
	action := "GATEWAY_SECRET_STORED"
	if existing {
		action = "GATEWAY_SECRET_ROTATED"
	}
	return h.auditProfile(ctx, p, hostel, audit.Finance{Action: action, EntityType: "EncryptedSecret", Reason: provider + " " + purpose + " fingerprint " + env.Fingerprint, Source: "SECRET_STORE"})
}

func (h *Handler) saveGateway(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "managePaymentProfile")
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
	merchantDef, sandbox := "MERCHANT", "SANDBOX"
	kind, _ := f.Enum("accountKind", true, &merchantDef, "MERCHANT", "PERSONAL")
	var enabled *bool
	if v, ok := f.Bool("enabled", true, nil); ok {
		enabled = &v
	}
	merchant, hasMerchant := f.Str("merchantCode", valid.S{Opt: true, Trim: true, Max: 64})
	mode, _ := f.Enum("mode", true, &sandbox, "LIVE", "SANDBOX")
	provider, _ := f.Enum("provider", false, nil, gatewayProviders...)
	secret, _ := f.Str("secret", valid.S{Opt: true, Min: 1, Max: 512})
	webhook, _ := f.Str("webhookSecret", valid.S{Opt: true, Min: 1, Max: 512})
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	list, err := h.gatewayDocs(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	existing := findGateway(list, provider)
	for purpose, plain := range map[string]string{"GATEWAY_SECRET": secret, "GATEWAY_WEBHOOK_SECRET": webhook} {
		if plain != "" {
			if err := h.putSecret(c, p, hostel, provider, purpose, plain); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
	}
	next := gatewayDoc{AccountKind: kind, Mode: mode, Provider: provider}
	if hasMerchant {
		if merchant != "" {
			next.MerchantCode = &merchant
		}
	} else if existing != nil {
		next.MerchantCode = existing.MerchantCode
	}
	if existing != nil {
		next.EnabledAt = existing.EnabledAt
	}
	if enabled != nil {
		if !*enabled {
			next.EnabledAt = nil
		} else if next.EnabledAt == nil {
			at := nowMS()
			next.EnabledAt = &at
		}
	}
	if next.EnabledAt != nil {
		if err := h.assertEnablable(c, hostel, &next); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if err := h.writeGateway(c, hostel, &next, p); err != nil {
		httpx.Fail(c, err)
		return
	}
	state := " disabled"
	if next.EnabledAt != nil {
		state = " enabled"
	}
	if secret != "" {
		state += " (secret written)"
	}
	if err := h.auditProfile(c, p, hostel, audit.Finance{Action: "GATEWAY_CONFIG_UPDATED", Reason: provider + " " + kind + " " + mode + state, Source: "GATEWAY_CONFIG_EDITOR"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	views, err := h.gatewayViews(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "gateways", Value: views}}, "Payment gateway saved")
}

func (h *Handler) assertEnablable(ctx context.Context, hostel bson.ObjectID, g *gatewayDoc) error {
	if g.AccountKind == "PERSONAL" {
		return finance.Err("GATEWAY_NOT_ELIGIBLE", personalAccountMessage)
	}
	if !g.eligible() {
		return finance.Err("GATEWAY_NOT_CONFIGURED", g.Provider+" needs a merchant code before it can take payments.")
	}
	if g.Mode != "LIVE" {
		return nil
	}
	s, err := h.describeSecret(ctx, hostel, g.Provider, "GATEWAY_SECRET")
	if err != nil {
		return err
	}
	if !s.Configured {
		return finance.Err("GATEWAY_NOT_CONFIGURED", "Enter the "+strings.ToLower(gatewayRequirements[g.Provider][1])+" before going live.")
	}
	return nil
}

// writeGateway is writeEntry: update the provider's slot in place, else push one.
// TS fell through to the push whenever the in-place update changed nothing, so
// saving a gateway unchanged tried to upsert a second profile for the hostel and
// failed on its unique index (FIN-10). A matched slot is enough here.
func (h *Handler) writeGateway(ctx context.Context, hostel bson.ObjectID, g *gatewayDoc, p *authz.Principal) error {
	var enabled, merchant any
	if g.EnabledAt != nil {
		enabled = *g.EnabledAt
	}
	if g.MerchantCode != nil {
		merchant = *g.MerchantCode
	}
	var me any
	if id, err := bson.ObjectIDFromHex(p.UserID); err == nil {
		me = id
	}
	col := h.DB.Collection("hostelpaymentprofiles")
	at := nowMS()
	res, err := col.UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "gateways.provider", Value: g.Provider}}, bson.D{{Key: "$set", Value: bson.D{{Key: "gateways.$.accountKind", Value: g.AccountKind},
		{Key: "gateways.$.enabledAt", Value: enabled}, {Key: "gateways.$.merchantCode", Value: merchant}, {Key: "gateways.$.mode", Value: g.Mode},
		{Key: "gateways.$.updatedBy", Value: me}, {Key: "updatedAt", Value: at}}}})
	if err != nil || res.MatchedCount > 0 {
		return err
	}
	entry := bson.D{{Key: "provider", Value: g.Provider}, {Key: "accountKind", Value: g.AccountKind}, {Key: "merchantCode", Value: merchant}, {Key: "mode", Value: g.Mode}, {Key: "enabledAt", Value: enabled},
		{Key: "healthStatus", Value: "UNKNOWN"}, {Key: "updatedBy", Value: me}}
	_, err = col.UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "gateways.provider", Value: bson.D{{Key: "$ne", Value: g.Provider}}}},
		bson.D{{Key: "$push", Value: bson.D{{Key: "gateways", Value: entry}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: at}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: me}, {Key: "hostelId", Value: hostel}, {Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	return err
}

func (h *Handler) deleteGateway(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "managePaymentProfile")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	provider := valid.QueryEnum(q, "provider", &is, gatewayProviders...)
	if provider == nil && len(is) == 0 {
		is.Add("provider", valid.OneOf("ESEWA", "FONEPAY", "KHALTI"))
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, q["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.DB.Collection("hostelpaymentprofiles").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "gateways", Value: bson.D{{Key: "provider", Value: *provider}}}}},
		{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.DB.Collection("encryptedsecrets").DeleteMany(c, bson.D{{Key: "hostelId", Value: hostel}, {Key: "provider", Value: *provider}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.auditProfile(c, p, hostel, audit.Finance{Action: "GATEWAY_CONFIG_REMOVED", Reason: *provider + " removed, stored keys deleted", Source: "GATEWAY_CONFIG_EDITOR"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	views, err := h.gatewayViews(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "gateways", Value: views}}, "Payment gateway removed")
}

// --- payment profile (payment-profile.service.ts) ---

type profileDoc struct {
	finance.PayeeProfile `bson:",inline"`
	BankName             *string        `bson:"bankName"`
	CashThreshold        *float64       `bson:"cashApprovalThreshold"`
	ExtraAccounts        []extraAccount `bson:"extraAccounts"`
	Gateways             []gatewayDoc   `bson:"gateways"`
	LastStatement        *time.Time     `bson:"lastStatementUploadAt"`
	Instructions         *string        `bson:"paymentInstructions"`
	QRPayeeSource        *string        `bson:"qrPayeeSource"`
	StaticQR             *bson.ObjectID `bson:"staticQrAssetId"`
	Cadence              *float64       `bson:"statementCadenceDays"`
}

type extraAccount struct {
	AccountName *string `bson:"accountName"`
	BankName    *string `bson:"bankName"`
	Kind        string  `bson:"kind"`
	Number      string  `bson:"number"`
}

func (h *Handler) loadProfile(ctx context.Context, hostel bson.ObjectID) (*profileDoc, error) {
	var p profileDoc
	err := h.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &p, err
}

func numOr(v *float64, def float64) any {
	if v == nil {
		return def
	}
	return *v
}

// profileView is toView.
func profileView(p *profileDoc) ordered.Map {
	if p == nil {
		p = &profileDoc{}
	}
	enabled := []string{}
	for i := range p.Gateways {
		if p.Gateways[i].EnabledAt != nil && p.Gateways[i].eligible() {
			enabled = append(enabled, p.Gateways[i].Provider)
		}
	}
	extras := make([]ordered.Map, len(p.ExtraAccounts))
	for i, a := range p.ExtraAccounts {
		extras[i] = ordered.Map{{Key: "accountName", Value: strOrNil(a.AccountName)}, {Key: "bankName", Value: strOrNil(a.BankName)}, {Key: "kind", Value: a.Kind}, {Key: "number", Value: a.Number}}
	}
	str := func(s *string) any {
		if s == nil {
			return nil
		}
		return *s
	}
	var qr any
	if p.StaticQR != nil {
		qr = p.StaticQR.Hex()
	}
	tier := "TIER_0"
	if len(enabled) > 0 {
		tier = "TIER_1"
	}
	usable := p.StaticQR != nil || nonEmpty(p.EsewaID) || nonEmpty(p.KhaltiID) || nonEmpty(p.BankAccountNumber) || len(p.ExtraAccounts) > 0 || len(enabled) > 0
	return ordered.Map{{Key: "bankAccountName", Value: str(p.BankAccountName)}, {Key: "bankAccountNumber", Value: str(p.BankAccountNumber)}, {Key: "bankName", Value: str(p.BankName)},
		{Key: "cashApprovalThreshold", Value: numOr(p.CashThreshold, 20000)}, {Key: "displayName", Value: str(p.DisplayName)}, {Key: "enabledProviders", Value: enabled},
		{Key: "esewaId", Value: str(p.EsewaID)}, {Key: "extraAccounts", Value: extras}, {Key: "khaltiId", Value: str(p.KhaltiID)}, {Key: "lastStatementUploadAt", Value: isoOrNil(p.LastStatement)},
		{Key: "payeeVerifiable", Value: len(finance.HostelPayeeIdentity(&p.PayeeProfile, "").AccountIDs) > 0}, {Key: "paymentInstructions", Value: str(p.Instructions)},
		{Key: "qrPayeeName", Value: str(p.QRPayeeName)}, {Key: "qrPayeeNumber", Value: str(p.QRPayeeNumber)}, {Key: "qrPayeeSource", Value: str(p.QRPayeeSource)},
		{Key: "staticQrAssetId", Value: qr}, {Key: "statementCadenceDays", Value: numOr(p.Cadence, 7)}, {Key: "tier", Value: tier}, {Key: "usable", Value: usable}}
}

func nonEmpty(s *string) bool { return s != nil && *s != "" }

func (h *Handler) getProfile(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	doc, err := h.loadProfile(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "profile", Value: profileView(doc)}}, "Payment profile")
}

// optionalText is optionalText(max): trimmed, "" → null, null kept, absent skipped.
func optionalText(f *valid.Form, key string, max int) (any, bool) {
	v, present := f.M[key]
	if !present {
		return nil, false
	}
	if v == nil {
		return nil, true
	}
	s, ok := f.Str(key, valid.S{Trim: true, Max: max})
	if !ok {
		return nil, false
	}
	if s == "" {
		return nil, true
	}
	return s, true
}

func (h *Handler) patchProfile(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "managePaymentProfile")
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
	set := bson.D{}
	if me, err := bson.ObjectIDFromHex(p.UserID); err == nil {
		set = append(set, bson.E{Key: "updatedBy", Value: me})
	}
	text := map[string]any{}
	has := map[string]bool{}
	for _, k := range []struct {
		key string
		max int
	}{{"bankAccountName", 120}, {"bankAccountNumber", 64}, {"bankName", 120}} {
		text[k.key], has[k.key] = optionalText(f, k.key, k.max)
	}
	threshold, hasThreshold := f.Num("cashApprovalThreshold", valid.N{Opt: true, Int: true, Min: valid.P(0)})
	text["displayName"], has["displayName"] = optionalText(f, "displayName", 120)
	text["esewaId"], has["esewaId"] = optionalText(f, "esewaId", 64)
	var extras bson.A
	list, hasExtras := f.Array("extraAccounts", true, false)
	for i, raw := range list {
		sub := valid.NewForm(raw)
		if sub.M == nil {
			f.Hard = true
			f.Is.Add("extraAccounts."+itoa(i), valid.Type("object", valid.Received(raw, false)))
			continue
		}
		name, _ := sub.Str("accountName", valid.S{Opt: true, Trim: true, Max: 120})
		bank, _ := sub.Str("bankName", valid.S{Opt: true, Trim: true, Max: 120})
		kind, _ := sub.Enum("kind", false, nil, "BANK", "ESEWA", "KHALTI")
		number, _ := sub.Str("number", valid.S{Trim: true, Min: 1, Max: 64})
		f.Join("extraAccounts."+itoa(i), sub)
		d := bson.D{}
		if name != "" {
			d = append(d, bson.E{Key: "accountName", Value: name})
		}
		if kind == "BANK" && bank != "" {
			d = append(d, bson.E{Key: "bankName", Value: bank})
		}
		extras = append(extras, append(d, bson.E{Key: "kind", Value: kind}, bson.E{Key: "number", Value: number}))
	}
	if hasExtras {
		f.Size("extraAccounts", len(list), 0, 6, "", false)
	}
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	text["khaltiId"], has["khaltiId"] = optionalText(f, "khaltiId", 64)
	text["paymentInstructions"], has["paymentInstructions"] = optionalText(f, "paymentInstructions", 600)
	qrName, hasQRName := optionalText(f, "qrPayeeName", 120)
	qrNumber, hasQRNumber := optionalText(f, "qrPayeeNumber", 64)
	var qrAsset *string
	_, hasQR := f.M["staticQrAssetId"]
	if hasQR && f.M["staticQrAssetId"] != nil {
		s, ok := f.Str("staticQrAssetId", valid.S{})
		if ok {
			qrAsset = &s
		}
	}
	cadence, hasCadence := f.Num("statementCadenceDays", valid.N{Opt: true, Int: true, Min: valid.P(1), Max: valid.P(90)})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	before, err := h.loadProfile(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	for _, k := range []string{"bankAccountName", "bankAccountNumber", "bankName", "displayName", "esewaId", "khaltiId", "paymentInstructions"} {
		if has[k] {
			set = append(set, bson.E{Key: k, Value: text[k]})
		}
	}
	if hasThreshold {
		set = append(set, bson.E{Key: "cashApprovalThreshold", Value: jsNumber(threshold)})
	}
	if hasCadence {
		set = append(set, bson.E{Key: "statementCadenceDays", Value: jsNumber(cadence)})
	}
	if hasExtras {
		if extras == nil {
			extras = bson.A{}
		}
		set = append(set, bson.E{Key: "extraAccounts", Value: extras})
	}
	manual := false
	if hasQRName || hasQRNumber {
		if hasQRName {
			set = append(set, bson.E{Key: "qrPayeeName", Value: qrName})
		}
		if hasQRNumber {
			set = append(set, bson.E{Key: "qrPayeeNumber", Value: qrNumber})
		}
		set = append(set, bson.E{Key: "qrPayeeSource", Value: "MANUAL"})
		manual = true
	}
	if hasQR {
		if qrAsset != nil && *qrAsset != "" {
			asset, err := h.qrAsset(c, *qrAsset, hostel)
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			set = append(set, bson.E{Key: "staticQrAssetId", Value: asset.ID})
			isNew := before == nil || before.StaticQR == nil || *before.StaticQR != asset.ID
			if !manual {
				set = append(set, h.readQrPayee(c, asset, before, isNew)...)
			}
		} else {
			set = append(set, bson.E{Key: "staticQrAssetId", Value: nil})
			if before != nil && before.QRPayeeSource != nil && *before.QRPayeeSource == "OCR" {
				set = append(set, bson.E{Key: "qrPayeeName", Value: nil}, bson.E{Key: "qrPayeeNumber", Value: nil}, bson.E{Key: "qrPayeeSource", Value: nil})
			}
		}
	}
	at := nowMS()
	insert := bson.D{{Key: "hostelId", Value: hostel}, {Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}
	if me, err := bson.ObjectIDFromHex(p.UserID); err == nil {
		insert = append(insert, bson.E{Key: "createdBy", Value: me})
	}
	var saved profileDoc
	err = h.DB.Collection("hostelpaymentprofiles").FindOneAndUpdate(c, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$set", Value: append(dedupe(set), bson.E{Key: "updatedAt", Value: at})},
		{Key: "$setOnInsert", Value: insert}}, options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&saved)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	amount := func(d *profileDoc) int64 {
		if d == nil || d.CashThreshold == nil {
			return 20000
		}
		return int64(*d.CashThreshold)
	}
	if err := h.auditProfile(c, p, hostel, audit.Finance{Action: "PAYMENT_PROFILE_UPDATED", AmountAfter: amount(&saved), AmountBefore: amount(before), Source: "PAYMENT_PROFILE_EDITOR"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "profile", Value: profileView(&saved)}}, "Payment profile saved")
}

// dedupe keeps the last value of each key, as Object.assign does on the update.
func dedupe(d bson.D) bson.D {
	out := bson.D{}
	for _, e := range d {
		replaced := false
		for i := range out {
			if out[i].Key == e.Key {
				out[i].Value, replaced = e.Value, true
			}
		}
		if !replaced {
			out = append(out, e)
		}
	}
	return out
}

type qrAssetDoc struct {
	ID       bson.ObjectID  `bson:"_id"`
	Bucket   string         `bson:"bucket"`
	HostelID *bson.ObjectID `bson:"hostelId"`
	Key      string         `bson:"key"`
	Mime     string         `bson:"mimeType"`
	Done     *time.Time     `bson:"uploadCompletedAt"`
}

func (h *Handler) qrAsset(ctx context.Context, raw string, hostel bson.ObjectID) (*qrAssetDoc, error) {
	notOwned := finance.Err("ASSET_NOT_OWNED", "That image does not belong to this hostel. Upload the QR again.")
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		return nil, notOwned
	}
	var a qrAssetDoc
	err = h.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&a)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && (a.HostelID == nil || *a.HostelID != hostel)) {
		return nil, notOwned
	}
	if err != nil {
		return nil, err
	}
	if a.Done == nil {
		return nil, finance.Err("ASSET_UPLOAD_INCOMPLETE", "That image did not finish uploading. Please upload the QR again.")
	}
	return &a, nil
}

// readQrPayee is readQrPayeeFields: the payee printed on a new QR, by OCR, never
// over a payee the owner typed. Any failure leaves the fields alone.
func (h *Handler) readQrPayee(ctx context.Context, a *qrAssetDoc, before *profileDoc, isNew bool) bson.D {
	if !isNew && before != nil && before.QRPayeeSource != nil && *before.QRPayeeSource == "MANUAL" {
		return nil
	}
	if a.Bucket == "" || a.Key == "" || h.R2 == nil || h.Reader == nil || !h.Reader.Enabled() {
		return nil
	}
	b := h.R2.ReadStoredObject(ctx, a.Bucket, a.Key)
	if b == nil {
		return nil
	}
	text, _ := h.Reader.Read(ctx, b, a.Mime)
	read := finance.ReadQRPayee(text)
	if !read.Found() {
		if inv, err := images.InvertGrey(b); err == nil {
			second, _ := h.Reader.Read(ctx, inv, "image/png")
			if r := finance.ReadQRPayee(second); r.Found() {
				read = r
			}
		}
	}
	if !read.Found() {
		if isNew {
			return bson.D{{Key: "qrPayeeName", Value: nil}, {Key: "qrPayeeNumber", Value: nil}, {Key: "qrPayeeSource", Value: nil}}
		}
		return nil
	}
	return bson.D{{Key: "qrPayeeName", Value: strOrNil(read.Name)}, {Key: "qrPayeeNumber", Value: strOrNil(read.AccountNumber)}, {Key: "qrPayeeSource", Value: "OCR"}}
}
