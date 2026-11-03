package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// billing-online: Phase 8's plan payments with no Softmato behind them. A
// verified hostel owned by UserPublic (its contact address another owner email),
// a second hostel owned by someone else, and the field team's prepayments.
var (
	HostelOwned   = gid(15, 1)
	HostelForeign = gid(15, 2)
	PrepayOpen    = gid(15, 10)
	PrepayPaid    = gid(15, 11)
	PrepayClaimed = gid(15, 12)
	PrepayOther   = gid(15, 13)
)

func init() {
	groupSeeds["billing-online"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := groupSeeds["team"](ctx, db, now); err != nil {
			return err
		}
		hostel := func(id, owner bson.ObjectID, name, slug, contact string) bson.D {
			return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: owner}, {Key: "parentHostelId", Value: nil},
				{Key: "isDeleted", Value: false}, {Key: "status", Value: "PENDING_REVIEW"}, {Key: "verificationStatus", Value: "VERIFIED"},
				{Key: "contact", Value: bson.D{{Key: "email", Value: contact}, {Key: "phone", Value: "9801000150"}}},
				{Key: "location", Value: bson.D{{Key: "area", Value: "Baneshwor"}, {Key: "city", Value: "Kathmandu"}}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}
		}
		prepay := func(id, agent bson.ObjectID, status, kind, number string, amount int64) bson.D {
			var paidAt, tx any
			if status != "OPEN" {
				paidAt, tx = now.Add(-time.Hour), "TX-"+number
			}
			return bson.D{{Key: "_id", Value: id}, {Key: "agentId", Value: agent}, {Key: "hostelId", Value: bson.NewObjectIDFromTimestamp(now)}, {Key: "invoiceNumber", Value: number}, {Key: "kind", Value: kind},
				{Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"}, {Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1}, {Key: "amount", Value: amount}, {Key: "chargeAmount", Value: nil},
				{Key: "billedTo", Value: bson.D{{Key: "email", Value: nil}, {Key: "hostelName", Value: "Prepaid " + number}, {Key: "name", Value: "Owner " + number}}},
				{Key: "softmatoInvoiceId", Value: "sm-" + number}, {Key: "softmatoInvoiceNo", Value: "SM-" + number}, {Key: "status", Value: status}, {Key: "paidAt", Value: paidAt},
				{Key: "transactionNo", Value: tx}, {Key: "provider", Value: nil}, {Key: "claimedAt", Value: nil},
				{Key: "draft", Value: bson.D{{Key: "name", Value: "Draft " + number}, {Key: "step", Value: 3}}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}
		}
		return insertAll(ctx, db, map[string][]any{
			"hostels": {hostel(HostelOwned, UserPublic, "Owned Hostel", "owned-hostel", "front@owned.test"), hostel(HostelForeign, UserAdmin, "Foreign Hostel", "foreign-hostel", "front@foreign.test")},
			"teamprepayments": {prepay(PrepayOpen, UserAgent, "OPEN", "SETUP_FEE", "SUB-0001-PRE1", 1000), prepay(PrepayPaid, UserAgent, "PAID", "SETUP_FEE", "SUB-0002-PRE2", 1000),
				prepay(PrepayClaimed, UserAgent, "CLAIMED", "SETUP_FEE", "SUB-0003-PRE3", 1000), prepay(PrepayOther, UserAgentOther, "PAID", "SETUP_FEE", "SUB-0004-PRE4", 1000)},
		})
	}
}
