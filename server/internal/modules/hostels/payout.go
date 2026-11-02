package hostels

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var upsert = options.UpdateOne().SetUpsert(true)

var payoutLabels = map[string]string{"BANK": "Bank account", "ESEWA": "eSewa", "KHALTI": "Khalti"}

type payoutRow struct {
	ID          bson.ObjectID   `bson:"_id"`
	BankName    string          `bson:"bankName"`
	Branch      string          `bson:"branch"`
	HolderName  string          `bson:"holderName"`
	Method      string          `bson:"method"`
	Number      crypto.Envelope `bson:"number"`
	Last4       string          `bson:"numberLast4"`
	ReviewNote  *string         `bson:"reviewNote"`
	ReviewedAt  *time.Time      `bson:"reviewedAt"`
	Status      string          `bson:"status"`
	SubmittedAt time.Time       `bson:"submittedAt"`
}

// PayoutView is PayoutAccountView.
type PayoutView struct {
	BankName     string `json:"bankName"`
	Branch       string `json:"branch"`
	HolderName   string `json:"holderName"`
	MaskedNumber string `json:"maskedNumber"`
	Method       string `json:"method"`
	MethodLabel  string `json:"methodLabel"`
	ReviewNote   any    `json:"reviewNote"`
	ReviewedAt   any    `json:"reviewedAt"`
	Status       string `json:"status"`
	SubmittedAt  string `json:"submittedAt"`
}

func (r *payoutRow) view() PayoutView {
	v := PayoutView{r.BankName, r.Branch, r.HolderName, "••••" + r.Last4, r.Method, payoutLabels[r.Method], nil, nil, r.Status, httpx.ISO(r.SubmittedAt)}
	if r.ReviewNote != nil {
		v.ReviewNote = *r.ReviewNote
	}
	if r.ReviewedAt != nil {
		v.ReviewedAt = httpx.ISO(*r.ReviewedAt)
	}
	return v
}

func (a *Admin) payoutGet(c *gin.Context) {
	hostelID, err := AdminHostel(authz.From(c), c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var row payoutRow
	var account any
	switch err := a.DB.Collection("hostelpayoutaccounts").FindOne(c, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&row); {
	case err == nil:
		account = row.view()
	case !errors.Is(err, mongo.ErrNoDocuments):
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Account any `json:"account"`
	}{account}, "Payout account")
}

func (a *Admin) payoutPut(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := AdminHostel(p, optionalHostel(body))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	form := valid.NewForm(body)
	in := parsePayout(form)
	if err := form.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	view, err := a.setPayout(c, hostelID, in, actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Account PayoutView `json:"account"`
	}{view}, "Payout account saved. We will check it before any payout.")
}

// setPayout is setHostelPayoutAccount for a HOSTEL_ADMIN: sealed to the hostel,
// back to review on any change, every admin emailed, staff told.
func (a *Admin) setPayout(c *gin.Context, hostelID bson.ObjectID, in *Payout, actor bson.ObjectID) (PayoutView, error) {
	var hostel struct {
		Name string `bson:"name"`
		Slug string `bson:"slug"`
	}
	if err := a.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: hostelID}}).Decode(&hostel); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return PayoutView{}, errHostelMissing
		}
		return PayoutView{}, err
	}
	keys, err := crypto.MasterKeys(a.FinanceKey, a.FinancePrev)
	if err != nil {
		return PayoutView{}, err
	}
	scope := crypto.Scope{HostelID: hostelID.Hex(), Purpose: "PAYOUT_ACCOUNT_NUMBER"}
	var existing *payoutRow
	var old payoutRow
	switch err := a.DB.Collection("hostelpayoutaccounts").FindOne(c, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&old); {
	case err == nil:
		existing = &old
	case !errors.Is(err, mongo.ErrNoDocuments):
		return PayoutView{}, err
	}
	if existing != nil && existing.Method == in.Method && existing.HolderName == in.Holder && existing.BankName == in.Bank && existing.Branch == in.Branch {
		// Saving the same account again is not a change and must not reset a review.
		if n, err := crypto.DecryptSecret(existing.Number, scope, keys); err == nil && n == in.Number {
			return existing.view(), nil
		}
	}
	env, err := crypto.EncryptSecret(in.Number, scope, keys[0])
	if err != nil {
		return PayoutView{}, err
	}
	last4 := in.Number
	if len(last4) > 4 {
		last4 = last4[len(last4)-4:]
	}
	personal, err := crypto.NewPersonal(a.PersonalKey)
	if err != nil {
		return PayoutView{}, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var saved payoutRow
	err = a.DB.Collection("hostelpayoutaccounts").FindOneAndUpdate(c, bson.D{{Key: "hostelId", Value: hostelID}}, bson.D{
		{Key: "$set", Value: bson.D{{Key: "bankName", Value: in.Bank}, {Key: "branch", Value: in.Branch}, {Key: "holderName", Value: in.Holder}, {Key: "method", Value: in.Method}, {Key: "number", Value: env},
			{Key: "numberLast4", Value: last4}, {Key: "numberLookup", Value: personal.LookupHash("payout:" + in.Method + ":" + in.Number)}, {Key: "reviewNote", Value: nil}, {Key: "reviewedAt", Value: nil},
			{Key: "reviewedBy", Value: nil}, {Key: "status", Value: "PENDING_REVIEW"}, {Key: "submittedAt", Value: now}, {Key: "submittedBy", Value: actor}, {Key: "updatedAt", Value: now}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "hostelId", Value: hostelID}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}},
	}, options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&saved)
	if err != nil {
		return PayoutView{}, err
	}
	action := "PAYOUT_ACCOUNT_SET"
	var previous any
	if existing != nil {
		action = "PAYOUT_ACCOUNT_CHANGED"
		previous = bson.D{{Key: "bankName", Value: existing.BankName}, {Key: "holderName", Value: existing.HolderName}, {Key: "last4", Value: existing.Last4}, {Key: "method", Value: existing.Method}, {Key: "status", Value: existing.Status}}
	}
	if err := a.Audit.Write(c, audit.Entry{Action: action, ActorID: actor, EntityID: saved.ID.Hex(), EntityType: "HostelPayoutAccount", HostelID: hostelID,
		Metadata: bson.D{{Key: "next", Value: bson.D{{Key: "bankName", Value: in.Bank}, {Key: "holderName", Value: in.Holder}, {Key: "last4", Value: saved.Last4}, {Key: "method", Value: in.Method}}},
			{Key: "previous", Value: previous}, {Key: "source", Value: "HOSTEL_ADMIN"}}}); err != nil {
		return PayoutView{}, err
	}
	// Never fails the save: a mail or a bell that does not go must not undo it.
	if contacts, err := residents.HostelAdminContacts(c, a.DB, hostelID); err == nil {
		facts := email.PayoutAccountFacts{MethodLabel: payoutLabels[saved.Method], HolderName: saved.HolderName, BankName: saved.BankName, MaskedNumber: "••••" + saved.Last4}
		settings := a.Outbound + "/hostel-admin/bookings?tab=payout"
		if hostel.Slug != "" {
			settings = a.Outbound + "/" + httpx.EncodeURIComponent(hostel.Slug) + "/admin/bookings?tab=payout"
		}
		for _, ct := range contacts {
			m := email.PayoutAccountChanged(facts, email.EmailDateTime(now), hostel.Name, ct.Name, settings)
			a.Mail.Notify(c, email.Notification{Action: "payout_account_changed", To: ct.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
		}
	} else {
		slog.WarnContext(c, "payout_account_contacts_failed", "hostelId", hostelID.Hex())
	}
	a.notifyPayoutReview(c, hostelID, hostel.Name)
	return saved.view(), nil
}

func (a *Admin) notifyPayoutReview(c *gin.Context, hostelID bson.ObjectID, name string) {
	cur, err := a.DB.Collection("users").Find(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}).SetLimit(200))
	if err != nil {
		return
	}
	var staff []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if cur.All(c, &staff) != nil {
		return
	}
	for _, m := range staff {
		_, _ = a.Notify.CreateInApp(c, notifications.Input{ActionURL: "/platform/bookings?tab=payout-accounts", Body: name + " set a payout account. Check it before any payout.", Category: "BOOKING",
			Data: ordered.Map{{Key: "hostelId", Value: hostelID.Hex()}, {Key: "type", Value: "PAYOUT_ACCOUNT_REVIEW"}}, Title: "Payout account to check", UserID: m.ID.Hex()})
	}
}
