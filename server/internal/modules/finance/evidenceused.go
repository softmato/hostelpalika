package finance

import (
	"context"
	"errors"
	"regexp"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
)

// ContentHashRe is FileAsset.contentHash's shape: hex sha256.
var ContentHashRe = regexp.MustCompile(`^[a-f0-9]{64}$`)

// EvidenceUsed refuses receipt bytes a payment at this hostel already carries,
// and says which payment. Asked at presign, before a byte moves: the second send
// of one receipt sat at "Uploading… 100%" and then read as a dropped connection,
// with nothing telling the resident it had been used (ch 35). resident is the
// sender; only their own payment is described.
func EvidenceUsed(ctx context.Context, db *mongo.Database, hostel bson.ObjectID, hash string, resident *bson.ObjectID) error {
	var prior struct {
		Amount   int64          `bson:"amount"`
		Invoice  *bson.ObjectID `bson:"invoiceId"`
		Occurred *time.Time     `bson:"occurredAt"`
		Resident *bson.ObjectID `bson:"residentId"`
	}
	err := db.Collection("paymentevents").FindOne(ctx, bson.D{{Key: "evidenceHash", Value: hash}, {Key: "hostelId", Value: hostel}}).Decode(&prior)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil {
		return err
	}
	if resident == nil || prior.Resident == nil || *prior.Resident != *resident {
		return Err("EVIDENCE_ALREADY_USED", "This receipt was already sent for another payment at this hostel. Upload the receipt for this payment.")
	}
	msg := "You already sent this receipt for Rs " + money.GroupUS(prior.Amount)
	var period, at any
	if prior.Invoice != nil {
		var inv struct {
			Period *string `bson:"period"`
		}
		if db.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: *prior.Invoice}}).Decode(&inv) == nil && inv.Period != nil {
			period = *inv.Period
			if name := bs.FormatPeriod(*inv.Period); name != "" {
				msg += " for " + name
			}
		}
	}
	if prior.Occurred != nil {
		at = httpx.ISO(*prior.Occurred)
	}
	return Err("EVIDENCE_ALREADY_USED", msg+". Upload the receipt for this payment.",
		map[string]any{"priorPeriod": period, "priorSubmittedAt": at})
}
