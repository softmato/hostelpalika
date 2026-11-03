package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
)

// The superadmin's booking desk (group 11): a screenshot to check, money due
// out both ways, payout accounts (one verified, one waiting with the same
// number), a paused hostel and a transfer screenshot the superadmin uploaded.
var (
	PlatformPayment      = gid(11, 1) // BookReview's screenshot
	PlatformRefundDue    = gid(11, 2) // BookStruck1's full refund
	PlatformPayoutDue    = gid(11, 3) // BookEnded's hostel share, to a verified account
	PlatformProofAsset   = gid(11, 5)
	PlatformTwinAccount  = gid(11, 6)
	PlatformStrangeProof = gid(11, 7) // someone else's upload
)

// sealed is a finance secret under the contract FINANCE_MASTER_KEY.
func sealed(plain, hostelID, purpose string) crypto.Envelope {
	keys, err := crypto.MasterKeys("0000000000000000000000000000000000000000000000000000000000000002", "")
	if err != nil {
		panic(err)
	}
	env, err := crypto.EncryptSecret(plain, crypto.Scope{HostelID: hostelID, Purpose: purpose}, keys[0])
	if err != nil {
		panic(err)
	}
	return env
}

func init() {
	groupSeeds["platform-bookings"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		hour := time.Hour
		at := func(by time.Duration) time.Time { return now.Add(-by).UTC().Truncate(time.Millisecond) }
		if err := insertAll(ctx, db, map[string][]any{
			"users": platformStaff(fixedAt),
			"bookingpayments": {d{{Key: "_id", Value: PlatformPayment}, {Key: "bookingId", Value: BookReview}, {Key: "userId", Value: BookReview}, {Key: "hostelId", Value: HostelPublished},
				{Key: "amount", Value: 1500}, {Key: "proofAssetId", Value: gid(11, 9)}, {Key: "reference", Value: "BK-04TEST"}, {Key: "note", Value: "Paid from my sister's eSewa"},
				{Key: "status", Value: "IN_REVIEW"}, {Key: "submittedAt", Value: at(hour)}, {Key: "createdAt", Value: at(hour)}, {Key: "updatedAt", Value: at(hour)}, {Key: "__v", Value: 0}}},
			"bookingtransfers": {
				transferRow(PlatformRefundDue, BookStruck1, "REFUND", 1500, at(20*hour)),
				transferRow(PlatformPayoutDue, BookEnded, "PAYOUT", 188, at(10*hour)),
			},
			"fileassets": {
				d{{Key: "_id", Value: PlatformProofAsset}, {Key: "ownerId", Value: UserSuperadmin}, {Key: "hostelId", Value: nil}, {Key: "kind", Value: "BOOKING_TRANSFER_PROOF"}, {Key: "isDeleted", Value: false},
					{Key: "createdAt", Value: at(hour)}, {Key: "updatedAt", Value: at(hour)}},
				d{{Key: "_id", Value: PlatformStrangeProof}, {Key: "ownerId", Value: UserAdmin}, {Key: "hostelId", Value: nil}, {Key: "kind", Value: "BOOKING_TRANSFER_PROOF"}, {Key: "isDeleted", Value: false},
					{Key: "createdAt", Value: at(hour)}, {Key: "updatedAt", Value: at(hour)}},
			},
			"hostelpayoutaccounts": {
				d{{Key: "_id", Value: PlatformTwinAccount}, {Key: "hostelId", Value: HostelKyc}, {Key: "method", Value: "ESEWA"}, {Key: "bankName", Value: ""}, {Key: "branch", Value: ""},
					{Key: "holderName", Value: "Kyc Owner"}, {Key: "number", Value: sealed("9812345678", HostelKyc.Hex(), "PAYOUT_ACCOUNT_NUMBER")}, {Key: "numberLast4", Value: "5678"},
					{Key: "numberLookup", Value: "lookup-esewa-9812345678"}, {Key: "status", Value: "PENDING_REVIEW"}, {Key: "reviewNote", Value: nil}, {Key: "reviewedAt", Value: nil},
					{Key: "submittedAt", Value: at(30 * hour)}, {Key: "createdAt", Value: at(30 * hour)}, {Key: "updatedAt", Value: at(30 * hour)}, {Key: "__v", Value: 0}},
			},
		}); err != nil {
			return err
		}
		// The base fixture's verified account gets a real number, the same one the KYC hostel just sent.
		if _, err := db.Collection("hostelpayoutaccounts").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: HostelPublished}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "method", Value: "ESEWA"}, {Key: "bankName", Value: ""}, {Key: "branch", Value: ""}, {Key: "holderName", Value: "Lakeside Owner"},
			{Key: "number", Value: sealed("9812345678", HostelPublished.Hex(), "PAYOUT_ACCOUNT_NUMBER")}, {Key: "numberLast4", Value: "5678"}, {Key: "numberLookup", Value: "lookup-esewa-9812345678"},
			{Key: "reviewNote", Value: nil}, {Key: "reviewedAt", Value: at(200 * hour)}, {Key: "submittedAt", Value: at(300 * hour)}}}}); err != nil {
			return err
		}
		// BookStruck1's refund account can be opened.
		if _, err := db.Collection("bookings").UpdateOne(ctx, bson.D{{Key: "_id", Value: BookStruck1}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "refundAccount.number", Value: sealed("9800001111", BookStruck1.Hex(), "BOOKING_REFUND_ACCOUNT")}, {Key: "refundAccount.numberLast4", Value: "1111"},
			{Key: "settlement", Value: d{{Key: "hostelShare", Value: 0}, {Key: "kept", Value: 0}, {Key: "platformShare", Value: 0}, {Key: "refund", Value: 1500}, {Key: "refundPercent", Value: 100}}}}}}); err != nil {
			return err
		}
		_, err := db.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: HostelKyc}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "bookingPause", Value: d{{Key: "pausedAt", Value: at(5 * hour)}, {Key: "pausedBy", Value: nil}, {Key: "reason", Value: "Three missed bookings in 30 days."}, {Key: "resumedAt", Value: nil}}}}}})
		return err
	}
}

func transferRow(id, booking bson.ObjectID, kind string, amount int64, created time.Time) d {
	return d{{Key: "_id", Value: id}, {Key: "bookingId", Value: booking}, {Key: "hostelId", Value: HostelPublished}, {Key: "userId", Value: booking}, {Key: "kind", Value: kind},
		{Key: "amount", Value: amount}, {Key: "status", Value: "DUE"}, {Key: "sentAt", Value: nil}, {Key: "sentBy", Value: nil}, {Key: "transactionId", Value: nil},
		{Key: "proofAssetId", Value: nil}, {Key: "note", Value: nil}, {Key: "documentNumber", Value: nil},
		{Key: "destination", Value: d{{Key: "bankName", Value: ""}, {Key: "holderName", Value: ""}, {Key: "method", Value: nil}, {Key: "numberLast4", Value: ""}}},
		{Key: "createdAt", Value: created}, {Key: "updatedAt", Value: created}, {Key: "__v", Value: 0}}
}
