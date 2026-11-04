package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The admin-finance group: the claim review queue, cash, void, reversal and the
// receipt PDF. Ids from group 16.
//
//	hostel 2 (owner UserAdmin) · resident 10 Asha
//	invoices 20 approve · 21 reject · 22 bulk (two claims) · 23 cash · 24 void
//	claims   40 on 20 · 41 on 21 · 42 + 43 on 22
func init() {
	extendGroup("admin-finance", func(now time.Time) map[string][]any {
		at := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		hostel := gid(16, 2)
		stamp := func(n int, d bson.D) bson.D {
			return append(bson.D{{Key: "_id", Value: gid(16, n)}, {Key: "hostelId", Value: hostel}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}, d...)
		}
		invoice := func(n int, total int) bson.D {
			return stamp(n, bson.D{{Key: "residentId", Value: gid(16, 10)}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "period", Value: "2083-05"}, {Key: "status", Value: "OPEN"},
				{Key: "currency", Value: "NPR"}, {Key: "totalAmount", Value: total}, {Key: "dueDate", Value: at.Add(240 * time.Hour)}, {Key: "referenceCode", Value: "FIN-" + string(rune('A'+n-20))},
				{Key: "lines", Value: bson.A{bson.D{{Key: "amount", Value: total}, {Key: "basis", Value: "SCHEDULE"}, {Key: "bedType", Value: nil}, {Key: "description", Value: "Monthly rent"}}}}})
		}
		claim := func(n, inv, amount int, txn string) bson.D {
			return stamp(n, bson.D{{Key: "invoiceId", Value: gid(16, inv)}, {Key: "residentId", Value: gid(16, 10)}, {Key: "amount", Value: amount}, {Key: "currency", Value: "NPR"}, {Key: "direction", Value: "CREDIT"},
				{Key: "source", Value: "RESIDENT_CLAIM"}, {Key: "provider", Value: "ESEWA"}, {Key: "providerTxnId", Value: txn}, {Key: "confirmation", Value: "UNCONFIRMED"}, {Key: "status", Value: "PENDING"},
				{Key: "occurredAt", Value: at}, {Key: "idempotencyKey", Value: "claim:" + txn}, {Key: "rawPayload", Value: bson.D{{Key: "transactionCode", Value: txn}}}})
		}
		return map[string][]any{
			"hostels": {bson.D{{Key: "_id", Value: hostel}, {Key: "name", Value: "Finance Hostel"}, {Key: "slug", Value: "finance-hostel"}, {Key: "isDeleted", Value: false}, {Key: "ownerId", Value: UserAdmin}, {Key: "createdAt", Value: at}}},
			"residents": {stamp(10, bson.D{{Key: "firstName", Value: "Asha"}, {Key: "lastName", Value: "Finance"}, {Key: "phone", Value: "9800000160"}, {Key: "roomType", Value: "Single"},
				{Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "moveInDate", Value: at}})},
			"invoices":      {invoice(20, 1000), invoice(21, 500), invoice(22, 800), invoice(23, 600), invoice(24, 300)},
			"paymentevents": {claim(40, 20, 500, "FIN-T40"), claim(41, 21, 500, "FIN-T41"), claim(42, 22, 300, "FIN-T42"), claim(43, 22, 200, "FIN-T43")},
		}
	})
}
