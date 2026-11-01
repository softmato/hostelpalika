// Package residentfinance is the resident's money screens: their bills, how to pay
// one, the proof they send and the PDFs. Checkout through a gateway is Phase 8.
package residentfinance

import (
	"context"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

type Handler struct {
	DB         *mongo.Database
	Guards     *authz.Guards
	Production bool
	Limiter    *ratelimit.Limiter
	Notify     *notifications.Service
	Audit      *audit.Log
	RT         *realtime.Client
	Bump       realtime.Bumper
	R2         *storage.R2
	Reader     *finance.Reader
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/resident/finance")
	g.GET("/invoices", httpx.ETag(), h.invoices)
	g.GET("/invoices/:id/pay-instructions", httpx.ETag(), h.payInstructions)
	g.POST("/invoices/:id/claims", h.claim)
	g.POST("/evidence/:assetId/read", h.evidenceRead)
	g.GET("/receipts/:id/pdf", h.receiptPDF)
	g.GET("/statement/pdf", h.statementPDF)
}

func (h *Handler) current(c *gin.Context) (*authz.Principal, *residents.Record, error) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		return nil, nil, err
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		return nil, nil, err
	}
	return p, r, nil
}

type lineOut struct {
	Amount         int64  `json:"amount" bson:"amount"`
	Basis          string `json:"basis" bson:"basis"`
	BedType        any    `json:"bedType" bson:"bedType"`
	Description    string `json:"description" bson:"description"`
	ProrationBasis any    `json:"prorationBasis" bson:"prorationBasis"`
}

type receiptOut struct {
	Amount            int64  `json:"amount"`
	CertificationCode any    `json:"certificationCode"`
	ID                string `json:"id"`
	IssuedAt          any    `json:"issuedAt"`
	Number            string `json:"number"`
}

type financeView struct {
	Claims   []finance.ReviewRow `json:"claims"`
	Credit   int64               `json:"credit"`
	Invoices []ordered.Map       `json:"invoices"`
}

func (h *Handler) invoices(c *gin.Context) {
	_, r, err := h.current(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows, err := finance.ListResidentInvoices(c, h.DB, finance.LedgerScope{HostelID: r.HostelID, ResidentID: r.ID})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	claims, err := finance.ListResidentClaims(c, h.DB, r.HostelID, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	credit, err := finance.CreditAmount(c, h.DB, r.HostelID, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := bson.A{}
	for i := range rows {
		id, err := httpx.OID(rows[i].ID, "invoice id")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		ids = append(ids, id)
	}
	lines := map[string][]lineOut{}
	codes := map[string]any{}
	receipts := map[string][]receiptOut{}
	if len(ids) > 0 {
		cur, err := h.DB.Collection("invoices").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "residentId", Value: r.ID}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var details []struct {
			ID    bson.ObjectID `bson:"_id"`
			Lines []struct {
				Amount      int64   `bson:"amount"`
				Basis       string  `bson:"basis"`
				BedType     *string `bson:"bedType"`
				Description string  `bson:"description"`
				Proration   *string `bson:"prorationBasis"`
			} `bson:"lines"`
			Reference *string `bson:"referenceCode"`
		}
		if err := cur.All(c, &details); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, d := range details {
			key := d.ID.Hex()
			list := make([]lineOut, len(d.Lines))
			for i, l := range d.Lines {
				list[i] = lineOut{l.Amount, l.Basis, nilable(l.BedType), l.Description, nilable(l.Proration)}
			}
			lines[key] = list
			codes[key] = nilable(d.Reference)
		}
		cur, err = h.DB.Collection("receipts").Find(c, bson.D{{Key: "invoiceId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "residentId", Value: r.ID}, {Key: "voidedAt", Value: nil}}, options.Find().SetSort(bson.D{{Key: "issuedAt", Value: -1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var rs []struct {
			ID      bson.ObjectID  `bson:"_id"`
			Amount  int64          `bson:"amount"`
			Cert    *string        `bson:"certificationCode"`
			Invoice *bson.ObjectID `bson:"invoiceId"`
			Issued  *bson.DateTime `bson:"issuedAt"`
			Number  string         `bson:"receiptNumber"`
		}
		if err := cur.All(c, &rs); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, x := range rs {
			if x.Invoice == nil {
				continue
			}
			var issued any
			if x.Issued != nil {
				issued = httpx.ISO(x.Issued.Time())
			}
			key := x.Invoice.Hex()
			receipts[key] = append(receipts[key], receiptOut{x.Amount, nilable(x.Cert), x.ID.Hex(), issued, x.Number})
		}
	}
	out := financeView{claims, credit, make([]ordered.Map, len(rows))}
	for i := range rows {
		x := &rows[i]
		due, paid, method := any(ordered.Undefined), any(ordered.Undefined), any(ordered.Undefined)
		if x.DueDate != nil {
			due = httpx.ISO(*x.DueDate)
		}
		if x.PaidDate != nil {
			paid = httpx.ISO(*x.PaidDate)
		}
		if x.Method != "" {
			method = x.Method
		}
		var month any
		if x.Period != nil {
			month = *x.Period
		}
		list, code := lines[x.ID], codes[x.ID]
		if list == nil {
			list = []lineOut{}
		}
		got := receipts[x.ID]
		if got == nil {
			got = []receiptOut{}
		}
		out.Invoices[i] = ordered.Map{{Key: "dueAmount", Value: x.DueAmount}, {Key: "dueDate", Value: due}, {Key: "id", Value: x.ID}, {Key: "method", Value: method}, {Key: "month", Value: month}, {Key: "paidAmount", Value: x.PaidAmount}, {Key: "paidDate", Value: paid}, {Key: "status", Value: x.Status},
			{Key: "lines", Value: list}, {Key: "receipts", Value: got}, {Key: "referenceCode", Value: code}}
	}
	httpx.OK(c, out, "Payments")
}

func nilable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// --- pay instructions -------------------------------------------------------------

type gatewayEntry struct {
	AccountKind string         `bson:"accountKind"`
	EnabledAt   *bson.DateTime `bson:"enabledAt"`
	Merchant    string         `bson:"merchantCode"`
	Mode        string         `bson:"mode"`
	Provider    string         `bson:"provider"`
}

func (g *gatewayEntry) eligible() bool {
	if g == nil || g.AccountKind == "PERSONAL" {
		return false
	}
	return g.Provider == "KHALTI" || g.Merchant != ""
}

type extraAccount struct {
	AccountName *string `bson:"accountName"`
	BankName    *string `bson:"bankName"`
	Kind        string  `bson:"kind"`
	Number      string  `bson:"number"`
}

type profile struct {
	BankAccountName   *string        `bson:"bankAccountName"`
	BankAccountNumber string         `bson:"bankAccountNumber"`
	BankName          *string        `bson:"bankName"`
	DisplayName       *string        `bson:"displayName"`
	EsewaID           string         `bson:"esewaId"`
	Extra             []extraAccount `bson:"extraAccounts"`
	Gateways          []gatewayEntry `bson:"gateways"`
	KhaltiID          string         `bson:"khaltiId"`
	Instructions      *string        `bson:"paymentInstructions"`
	StaticQR          *bson.ObjectID `bson:"staticQrAssetId"`
}

func (p *profile) gateway(name string) *gatewayEntry {
	for i := range p.Gateways {
		if p.Gateways[i].Provider == name {
			return &p.Gateways[i]
		}
	}
	return nil
}

func (p *profile) enabled() int {
	if p == nil {
		return 0
	}
	n := 0
	for i := range p.Gateways {
		if p.Gateways[i].EnabledAt != nil && p.Gateways[i].eligible() {
			n++
		}
	}
	return n
}

func (p *profile) tier() string {
	if p.enabled() > 0 {
		return "TIER_1"
	}
	return "TIER_0"
}

func (p *profile) usable() bool {
	return p != nil && (p.StaticQR != nil || p.EsewaID != "" || p.KhaltiID != "" || p.BankAccountNumber != "" || len(p.Extra) > 0 || p.enabled() > 0)
}

const fonepayPersonalDailyLimit = 5000

// methods is methodsFrom. Only the shipped adapters can be live: FONEPAY has none yet.
func (h *Handler) methods(p *profile, amountDue int64) []ordered.Map {
	out := []ordered.Map{}
	live := map[string]bool{}
	for _, name := range []string{"ESEWA", "KHALTI", "FONEPAY"} {
		g := p.gateway(name)
		if g == nil || g.EnabledAt == nil || !g.eligible() || (g.Mode != "LIVE" && h.Production) || name == "FONEPAY" {
			continue
		}
		live[name] = true
		out = append(out, ordered.Map{{Key: "kind", Value: "GATEWAY"}, {Key: "provider", Value: name}, {Key: "sandbox", Value: g.Mode != "LIVE"}})
	}
	if p.StaticQR != nil {
		var notice any
		if g := p.gateway("FONEPAY"); g != nil && g.AccountKind == "PERSONAL" && amountDue > fonepayPersonalDailyLimit {
			notice = "This QR is a personal Fonepay account, which can receive at most NPR " + money.GroupIN(fonepayPersonalDailyLimit) + " per day. Pay in parts across days, or use the bank transfer below."
		}
		out = append(out, ordered.Map{{Key: "kind", Value: "QR"}, {Key: "assetId", Value: p.StaticQR.Hex()}, {Key: "notice", Value: notice}})
	}
	wallet := func(kind, id string) {
		out = append(out, ordered.Map{{Key: "kind", Value: kind}, {Key: "id", Value: id}})
	}
	if p.EsewaID != "" && !live["ESEWA"] {
		wallet("ESEWA", p.EsewaID)
	}
	if p.KhaltiID != "" && !live["KHALTI"] {
		wallet("KHALTI", p.KhaltiID)
	}
	for _, x := range p.Extra {
		if (x.Kind == "ESEWA" || x.Kind == "KHALTI") && !live[x.Kind] {
			wallet(x.Kind, x.Number)
		}
	}
	bank := func(name any, number string, bankName any) {
		out = append(out, ordered.Map{{Key: "kind", Value: "BANK"}, {Key: "accountName", Value: name}, {Key: "accountNumber", Value: number}, {Key: "bankName", Value: bankName}})
	}
	if p.BankAccountNumber != "" {
		bank(nilable(p.BankAccountName), p.BankAccountNumber, nilable(p.BankName))
	}
	for _, x := range p.Extra {
		if x.Kind == "BANK" {
			bank(nilable(x.AccountName), x.Number, nilable(x.BankName))
		}
	}
	return out
}

func (h *Handler) readProfile(ctx context.Context, hostel bson.ObjectID) (*profile, error) {
	var p profile
	err := h.DB.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&p)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

var bedLabels = map[string]string{"SINGLE": "Single Sitter Room", "DOUBLE_SHARING": "Double Sharing Room", "TRIPLE_SHARING": "Triple Sharing Room", "FOUR_SHARING": "Four Sharing Room", "DORMITORY": "Dormitory"}

type extraLine struct {
	Amount      int64  `json:"amount"`
	Basis       string `json:"basis"`
	Description string `json:"description"`
}

type payOut struct {
	AmountDue     int64         `json:"amountDue"`
	BedLabel      any           `json:"bedLabel"`
	Extras        []extraLine   `json:"extras"`
	Credit        int64         `json:"credit"`
	DisplayName   any           `json:"displayName"`
	DueDate       any           `json:"dueDate"`
	Instructions  any           `json:"instructions"`
	InvoiceID     string        `json:"invoiceId"`
	Methods       []ordered.Map `json:"methods"`
	Period        any           `json:"period"`
	ReferenceCode any           `json:"referenceCode"`
	Status        string        `json:"status"`
	Tier          string        `json:"tier"`
	Usable        bool          `json:"usable"`
}

func (h *Handler) payInstructions(c *gin.Context) {
	_, r, err := h.current(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, bad := bson.ObjectIDFromHex(c.Param("id"))
	if bad != nil {
		id = bson.NewObjectID()
	}
	var inv struct {
		ID      bson.ObjectID  `bson:"_id"`
		BedType *string        `bson:"bedType"`
		DueDate *bson.DateTime `bson:"dueDate"`
		Lines   []struct {
			Amount      int64  `bson:"amount"`
			Basis       string `bson:"basis"`
			Description string `bson:"description"`
		} `bson:"lines"`
		Period    *string `bson:"period"`
		Reference *string `bson:"referenceCode"`
		Status    string  `bson:"status"`
		Total     int64   `bson:"totalAmount"`
	}
	err = h.DB.Collection("invoices").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&inv)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	if err != nil || inv.Status == "VOID" {
		httpx.Fail(c, finance.Err("INVOICE_NOT_FOUND", "Invoice was not found."))
		return
	}
	var balance struct {
		Settled int64 `bson:"settledAmount"`
	}
	if err := h.DB.Collection("invoicebalances").FindOne(c, bson.D{{Key: "invoiceId", Value: inv.ID}}).Decode(&balance); err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	p, err := h.readProfile(c, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	credit, err := finance.CreditAmount(c, h.DB, r.HostelID, r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	due := max(0, inv.Total-balance.Settled)
	out := payOut{AmountDue: due, Extras: []extraLine{}, Credit: credit, InvoiceID: inv.ID.Hex(), Methods: []ordered.Map{}, Period: nilable(inv.Period), ReferenceCode: nilable(inv.Reference), Status: inv.Status, Tier: p.tier(), Usable: p.usable()}
	if inv.BedType != nil {
		if label, ok := bedLabels[*inv.BedType]; ok {
			out.BedLabel = label
		}
	}
	for _, l := range inv.Lines {
		if l.Basis == "FINE" || l.Basis == "KHATA" {
			out.Extras = append(out.Extras, extraLine{l.Amount, l.Basis, l.Description})
		}
	}
	if inv.DueDate != nil {
		out.DueDate = httpx.ISO(inv.DueDate.Time())
	}
	if p != nil {
		out.DisplayName, out.Instructions = nilable(p.DisplayName), nilable(p.Instructions)
		out.Methods = h.methods(p, due)
	}
	httpx.OK(c, out, "Payment instructions")
}

func sendPDF(c *gin.Context, name string, b []byte) {
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Disposition", `attachment; filename="`+name+`"`)
	c.Data(200, "application/pdf", b)
}

func (h *Handler) receiptPDF(c *gin.Context) {
	_, r, err := h.current(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	b, number, err := finance.RenderReceiptByID(c, h.DB, c.Param("id"), r.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sendPDF(c, number+".pdf", b)
}

func (h *Handler) statementPDF(c *gin.Context) {
	_, r, err := h.current(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := residents.HostelName(c, h.DB, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if hostel == "" {
		hostel = "Hostel"
	}
	rows, err := finance.ListResidentInvoices(c, h.DB, finance.LedgerScope{HostelID: r.HostelID, ResidentID: r.ID})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	lines := make([]finance.StatementRow, len(rows))
	for i := range rows {
		period := "One-off"
		if rows[i].Period != nil && *rows[i].Period != "" {
			period = finance.MonthLabel(*rows[i].Period)
		}
		lines[i] = finance.StatementRow{DueAmount: rows[i].DueAmount, PaidAmount: rows[i].PaidAmount, Period: period, Status: rows[i].Status}
	}
	name := strings.Join(strings.Fields(r.FirstName+" "+r.LastName), " ")
	if name == "" {
		name = "Resident"
	}
	b, err := finance.RenderStatementPDF(time.Now(), hostel, name, lines)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sendPDF(c, "statement.pdf", b)
}
