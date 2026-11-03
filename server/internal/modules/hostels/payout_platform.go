package hostels

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// The superadmin's side of payout-account.service.ts: the review queue, the
// audited reveal, the verdict. Mounted under /platform/bookings by bookings.Platform.

// PayoutForReview is PayoutAccountForReview: the masked account, its hostel, and
// the other hostels paid into the same number (a fraud signal).
type PayoutForReview struct {
	PayoutView
	HostelID   string   `json:"hostelId"`
	HostelName string   `json:"hostelName"`
	SharedWith []string `json:"sharedWith"`
}

// ListPayouts is listPayoutAccounts: oldest first, status and hostel optional.
func (a *Admin) ListPayouts(ctx context.Context, status string, hostelID *bson.ObjectID) ([]PayoutForReview, error) {
	filter := bson.D{}
	if status != "" {
		filter = append(filter, bson.E{Key: "status", Value: status})
	}
	if hostelID != nil {
		filter = append(filter, bson.E{Key: "hostelId", Value: *hostelID})
	}
	type row struct {
		Row      payoutRow     `bson:",inline"`
		HostelID bson.ObjectID `bson:"hostelId"`
		Lookup   string        `bson:"numberLookup"`
	}
	accounts := a.DB.Collection("hostelpayoutaccounts")
	var rows []row
	cur, err := accounts.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "submittedAt", Value: 1}}).SetLimit(500))
	if err != nil {
		return nil, err
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]PayoutForReview, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	lookups, ids := bson.A{}, bson.A{}
	for _, r := range rows {
		lookups = append(lookups, r.Lookup)
		ids = append(ids, r.HostelID)
	}
	var twins []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
		Lookup   string        `bson:"numberLookup"`
	}
	cur, err = accounts.Find(ctx, bson.D{{Key: "numberLookup", Value: bson.D{{Key: "$in", Value: lookups}}}},
		options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "numberLookup", Value: 1}}))
	if err != nil {
		return nil, err
	}
	if err := cur.All(ctx, &twins); err != nil {
		return nil, err
	}
	for _, t := range twins {
		ids = append(ids, t.HostelID)
	}
	var hostels []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
	}
	cur, err = a.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	if err := cur.All(ctx, &hostels); err != nil {
		return nil, err
	}
	names := make(map[bson.ObjectID]string, len(hostels))
	for _, h := range hostels {
		names[h.ID] = h.Name
	}
	for _, r := range rows {
		v := PayoutForReview{PayoutView: r.Row.view(), HostelID: r.HostelID.Hex(), HostelName: "—", SharedWith: []string{}}
		if n, ok := names[r.HostelID]; ok {
			v.HostelName = n
		}
		for _, t := range twins {
			if t.Lookup == r.Lookup && t.HostelID != r.HostelID {
				n, ok := names[t.HostelID]
				if !ok {
					n = "another hostel"
				}
				v.SharedWith = append(v.SharedWith, n)
			}
		}
		out = append(out, v)
	}
	return out, nil
}

type payoutHostel struct {
	ID   bson.ObjectID `bson:"_id"`
	Name string        `bson:"name"`
	Slug string        `bson:"slug"`
}

// payoutHostelOf is hostelOrThrow.
func (a *Admin) payoutHostelOf(ctx context.Context, id string) (*payoutHostel, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, errHostelMissing
	}
	var h payoutHostel
	err = a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "slug", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errHostelMissing
	}
	if err != nil {
		return nil, err
	}
	return &h, nil
}

// RevealedPayout is the account with its full number.
type RevealedPayout struct {
	PayoutView
	Number string `json:"number"`
}

// RevealPayout is revealHostelPayoutAccount: the full number for a superadmin
// about to send money. The audit row is written before the number is handed
// back, so a reveal that cannot be recorded is refused.
func (a *Admin) RevealPayout(ctx context.Context, hostelID string, actor bson.ObjectID) (*RevealedPayout, error) {
	h, err := a.payoutHostelOf(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	var row payoutRow
	err = a.DB.Collection("hostelpayoutaccounts").FindOne(ctx, bson.D{{Key: "hostelId", Value: h.ID}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(404, "PAYOUT_ACCOUNT_MISSING", "This hostel has no payout account.", nil)
	}
	if err != nil {
		return nil, err
	}
	keys, err := crypto.MasterKeys(a.FinanceKey, a.FinancePrev)
	if err != nil {
		return nil, err
	}
	number, err := crypto.DecryptSecret(row.Number, crypto.Scope{HostelID: h.ID.Hex(), Purpose: "PAYOUT_ACCOUNT_NUMBER"}, keys)
	if err != nil {
		return nil, err
	}
	if err := a.Audit.Write(ctx, audit.Entry{Action: "PAYOUT_ACCOUNT_REVEALED", ActorID: actor, EntityID: row.ID.Hex(), EntityType: "HostelPayoutAccount", HostelID: h.ID,
		Metadata: bson.D{{Key: "last4", Value: row.Last4}, {Key: "method", Value: row.Method}}}); err != nil {
		return nil, err
	}
	return &RevealedPayout{row.view(), number}, nil
}

// ReviewPayout is reviewHostelPayoutAccount: verify the account waiting for
// review, or send it back with the note; every admin of the hostel hears.
func (a *Admin) ReviewPayout(ctx context.Context, hostelID string, approve bool, note string, actor bson.ObjectID) (PayoutView, error) {
	h, err := a.payoutHostelOf(ctx, hostelID)
	if err != nil {
		return PayoutView{}, err
	}
	if !approve && note == "" {
		return PayoutView{}, httpx.NewError(422, "VALIDATION_ERROR", "Say what is wrong so the hostel can fix it.", nil)
	}
	status, action := "REJECTED", "PAYOUT_ACCOUNT_REJECTED"
	if approve {
		status, action = "VERIFIED", "PAYOUT_ACCOUNT_VERIFIED"
	}
	var noteVal any
	if note != "" {
		noteVal = note
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var row payoutRow
	err = a.DB.Collection("hostelpayoutaccounts").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: h.ID}, {Key: "status", Value: "PENDING_REVIEW"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reviewNote", Value: noteVal}, {Key: "reviewedAt", Value: now}, {Key: "reviewedBy", Value: actor}, {Key: "status", Value: status}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return PayoutView{}, httpx.NewError(409, "PAYOUT_ACCOUNT_NOT_IN_REVIEW", "There is no payout account waiting for review on this hostel.", nil)
	}
	if err != nil {
		return PayoutView{}, err
	}
	// The verdict is saved: an audit or a mail that fails must not report it as failed.
	if err := a.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: row.ID.Hex(), EntityType: "HostelPayoutAccount", HostelID: h.ID,
		Metadata: bson.D{{Key: "last4", Value: row.Last4}, {Key: "method", Value: row.Method}, {Key: "note", Value: noteVal}}}); err != nil {
		slog.WarnContext(ctx, "payout review audit failed", "hostelId", h.ID.Hex(), "error", err)
	}
	contacts, err := residents.HostelAdminContacts(ctx, a.DB, h.ID)
	if err != nil {
		slog.WarnContext(ctx, "payout_account_contacts_failed", "hostelId", h.ID.Hex())
	}
	facts := email.PayoutAccountFacts{MethodLabel: payoutLabels[row.Method], HolderName: row.HolderName, BankName: row.BankName, MaskedNumber: "••••" + row.Last4}
	settings := a.Outbound + "/hostel-admin/bookings?tab=payout"
	if h.Slug != "" {
		settings = a.Outbound + "/" + httpx.EncodeURIComponent(h.Slug) + "/admin/bookings?tab=payout"
	}
	body, title := "Your payout account needs fixing: "+note, "Payout account needs fixing"
	if approve {
		body, title = "Your payout account is verified. Booking payouts will go there.", "Payout account verified"
	}
	for _, ct := range contacts {
		m := email.PayoutAccountReviewed(facts, approve, h.Name, ct.Name, note, settings)
		a.Mail.Notify(ctx, email.Notification{Action: "payout_account_reviewed", To: ct.Email, Subject: m.Subject, HTML: m.HTML, Category: m.Category})
		if ct.UserID != "" {
			_, _ = a.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/bookings?tab=payout", Body: body, Category: "BOOKING",
				Data: ordered.Map{{Key: "hostelId", Value: h.ID.Hex()}, {Key: "type", Value: "PAYOUT_ACCOUNT_REVIEWED"}}, HostelID: h.ID.Hex(), Title: title, UserID: ct.UserID})
		}
	}
	return row.view(), nil
}
