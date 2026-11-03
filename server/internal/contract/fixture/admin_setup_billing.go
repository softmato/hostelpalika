package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Plan payment cases, all from gid(4, 70): 70 hostel + 71 owner with an open invoice, a part
// payment and a settled receipt; 80 hostel + 81 owner with nothing open; 90 hostel + 91 owner
// not verified yet; 95 hostel + 96 owner on a lifetime plan.
func init() {
	extendGroup("admin-setup", func(now time.Time) map[string][]any {
		fixed := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		far := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
		hostel := func(id, owner bson.ObjectID, slug, verified string) bson.D {
			return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: "Pay " + slug}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: owner}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "status", Value: "ACTIVE"}, {Key: "verificationStatus", Value: verified}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}
		}
		sub := func(n int, h bson.ObjectID, status string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "hostelId", Value: h}, {Key: "status", Value: status}, {Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"}, {Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1},
				{Key: "source", Value: "PUBLIC"}, {Key: "currentPeriodEnd", Value: far}, {Key: "dueBy", Value: nil}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}
			return append(d, extra...)
		}
		invoice := func(n int, h, s bson.ObjectID, number, status string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "invoiceNumber", Value: number}, {Key: "hostelId", Value: h}, {Key: "subscriptionId", Value: s}, {Key: "kind", Value: "PLAN"}, {Key: "lifetime", Value: false}, {Key: "amount", Value: 4900}, {Key: "currency", Value: "NPR"},
				{Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1}, {Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"}, {Key: "status", Value: status}, {Key: "source", Value: "PUBLIC"}, {Key: "issuedAt", Value: fixed},
				{Key: "billedTo", Value: bson.D{{Key: "email", Value: "pay.owner@contract.test"}, {Key: "hostelName", Value: "Pay Hostel"}, {Key: "name", Value: "Pay Owner"}}}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}
			return append(d, extra...)
		}
		h, o := gid(4, 70), gid(4, 71)
		s := gid(4, 72)
		asset := func(n int, owner bson.ObjectID, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "ownerId", Value: owner}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}, {Key: "kind", Value: "PAYMENT_PROOF"}, {Key: "createdAt", Value: fixed}}
			return append(d, extra...)
		}
		recent := now.Add(-time.Hour)
		done := bson.E{Key: "uploadCompletedAt", Value: recent}
		member := func(n int, hostelID, user bson.ObjectID) bson.D {
			return bson.D{{Key: "_id", Value: gid(4, n)}, {Key: "hostelId", Value: hostelID}, {Key: "userId", Value: user}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}}
		}
		return map[string][]any{
			"hostels": {hostel(h, o, "pay-open", "VERIFIED"), hostel(gid(4, 80), gid(4, 81), "pay-clear", "VERIFIED"), hostel(gid(4, 90), gid(4, 91), "pay-unverified", "PENDING"), hostel(gid(4, 95), gid(4, 96), "pay-lifetime", "VERIFIED")},
			"users": {
				setupUser(o, "pay.open@contract.test", "HOSTEL_ADMIN", bson.A{h}, now), setupUser(gid(4, 81), "pay.clear@contract.test", "HOSTEL_ADMIN", bson.A{gid(4, 80)}, now),
				setupUser(gid(4, 91), "pay.unverified@contract.test", "HOSTEL_ADMIN", bson.A{gid(4, 90)}, now), setupUser(gid(4, 96), "pay.lifetime@contract.test", "HOSTEL_ADMIN", bson.A{gid(4, 95)}, now),
			},
			"hostelmembers":       {member(100, h, o), member(101, gid(4, 80), gid(4, 81)), member(102, gid(4, 90), gid(4, 91)), member(103, gid(4, 95), gid(4, 96))},
			"hostelsubscriptions": {sub(72, h, "ACTIVE"), sub(82, gid(4, 80), "ACTIVE"), sub(92, gid(4, 90), "PENDING_SELECTION"), sub(97, gid(4, 95), "ACTIVE", bson.E{Key: "lifetimeSince", Value: fixed}, bson.E{Key: "lifetime", Value: true})},
			"subscriptioninvoices": {
				invoice(73, h, s, "SUB-0002-0046", "PARTIAL", bson.E{Key: "localInvoiceNo", Value: "HH-INV-2083-84-000007"}, bson.E{Key: "localIssuedAt", Value: fixed}),
				invoice(74, h, s, "SUB-0001-0046", "PAID", bson.E{Key: "createdAt", Value: fixed.Add(-time.Hour)}),
			},
			"subscriptionpayments": {
				bson.D{{Key: "_id", Value: gid(4, 75)}, {Key: "amount", Value: 1000}, {Key: "currency", Value: "NPR"}, {Key: "hostelId", Value: h}, {Key: "invoiceId", Value: gid(4, 73)}, {Key: "method", Value: "MANUAL"}, {Key: "status", Value: "SETTLED"}, {Key: "subscriptionId", Value: s}, {Key: "settledAt", Value: fixed}, {Key: "localTransactionNo", Value: "HH-TXN-2083-84-00000009"}, {Key: "createdAt", Value: fixed}},
				bson.D{{Key: "_id", Value: gid(4, 76)}, {Key: "amount", Value: 4900}, {Key: "currency", Value: "NPR"}, {Key: "hostelId", Value: h}, {Key: "invoiceId", Value: gid(4, 74)}, {Key: "method", Value: "CASH"}, {Key: "status", Value: "SETTLED"}, {Key: "subscriptionId", Value: s}, {Key: "settledAt", Value: fixed}, {Key: "receiptNumber", Value: "SRC-0001-0046"}, {Key: "createdAt", Value: fixed}},
				bson.D{{Key: "_id", Value: gid(4, 77)}, {Key: "amount", Value: 500}, {Key: "hostelId", Value: h}, {Key: "invoiceId", Value: gid(4, 73)}, {Key: "method", Value: "MANUAL"}, {Key: "status", Value: "FAILED"}, {Key: "subscriptionId", Value: s}, {Key: "receiptNumber", Value: "SRC-NOPE"}, {Key: "createdAt", Value: fixed}},
			},
			"fileassets": {
				asset(110, o, done), asset(111, gid(4, 81), done), asset(112, o), asset(113, o, bson.E{Key: "uploadCompletedAt", Value: now.Add(-15 * 24 * time.Hour)}), asset(114, o, done, bson.E{Key: "systemDocumentKind", Value: "RECEIPT"}), asset(115, o, done, bson.E{Key: "hostelId", Value: gid(4, 80)}),
			},
		}
	})
}
