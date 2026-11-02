package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The reports group's statement rows. Ids from 0xC0.
//
//	imports c0 ready · c1 failed · c2 parsing
//	events on c0: c3 reference match for invoice 21 · c4 orphan · c5 suggested · c6 claim-matched (claim 42)
//	c7 a claim by resident b4, who has an account
func init() {
	extendGroup("admin-reports", func(now time.Time) map[string][]any {
		at := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		hostel := gid(9, 2)
		stamp := func(n int, d bson.D) bson.D {
			return append(bson.D{{Key: "_id", Value: gid(9, n)}, {Key: "hostelId", Value: hostel}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}, d...)
		}
		imp := func(n int, status string, d bson.D) bson.D {
			return stamp(n, append(bson.D{{Key: "uploadedBy", Value: UserAdmin}, {Key: "uploadedAt", Value: at.Add(time.Duration(n) * time.Hour)}, {Key: "fileName", Value: "statement.csv"}, {Key: "provider", Value: "ESEWA"},
				{Key: "parserVersion", Value: "esewa@2"}, {Key: "status", Value: status}}, d...))
		}
		sugg := bson.A{bson.D{{Key: "confidence", Value: "HIGH"}, {Key: "invoiceId", Value: gid(9, 20).Hex()}, {Key: "residentId", Value: gid(9, 10).Hex()}, {Key: "residentName", Value: "Asha Report"}, {Key: "score", Value: 64}, {Key: "why", Value: "matches Asha Report — name matches"}}}
		ev := func(n int, amount int, txn string, tier, why string, d bson.D, raw bson.D) bson.D {
			return stamp(n, append(bson.D{{Key: "amount", Value: amount}, {Key: "currency", Value: "NPR"}, {Key: "direction", Value: "CREDIT"}, {Key: "source", Value: "STATEMENT_IMPORT"}, {Key: "provider", Value: "ESEWA"},
				{Key: "providerTxnId", Value: txn}, {Key: "statementImportId", Value: gid(9, 0xc0)}, {Key: "confirmation", Value: "UNCONFIRMED"}, {Key: "status", Value: "PENDING"}, {Key: "occurredAt", Value: at.Add(time.Duration(n) * time.Minute)},
				{Key: "idempotencyKey", Value: "statement:c0:" + txn}, {Key: "rawPayload", Value: append(bson.D{{Key: "counterpartyName", Value: "Payer " + txn}, {Key: "ladderTier", Value: tier}, {Key: "ladderWhy", Value: why}, {Key: "remarks", Value: "rent " + txn}}, raw...)}}, d...))
		}
		return map[string][]any{
			"residents": {stamp(0xb4, bson.D{{Key: "firstName", Value: "Account"}, {Key: "lastName", Value: "Holder"}, {Key: "userId", Value: UserAdmin}, {Key: "status", Value: "MOVED_OUT"}, {Key: "isDeleted", Value: false}, {Key: "moveInDate", Value: at}})},
			"statementimports": {
				imp(0xc0, "READY", bson.D{{Key: "periodStart", Value: at}, {Key: "periodEnd", Value: now.Add(24 * time.Hour)}, {Key: "rowCount", Value: 5}, {Key: "creditCount", Value: 4}, {Key: "matchedCount", Value: 2}, {Key: "suggestedCount", Value: 1}, {Key: "orphanCount", Value: 1}, {Key: "completedAt", Value: at}}),
				imp(0xc1, "FAILED", bson.D{{Key: "errorDetail", Value: "No recognisable column header was found in this file. The statement format may have changed."}}),
				imp(0xc2, "PARSING", bson.D{}),
			},
			"paymentevents": {
				ev(0xc3, 500, "TXN-B1", "B", "reference HP-TEST — Bina Report, 2083-05", bson.D{{Key: "invoiceId", Value: gid(9, 21)}, {Key: "residentId", Value: gid(9, 11)}, {Key: "referenceCode", Value: "HP-TEST"}}, nil),
				ev(0xc4, 777, "TXN-D1", "D", "no reference, no claim, no close match", nil, bson.D{{Key: "row", Value: bson.D{{Key: "Reference Code", Value: "TXN-D1"}}}, {Key: "rowNumber", Value: 3}, {Key: "suggestions", Value: bson.A{}}}),
				ev(0xc5, 300, "TXN-C1", "C", "matches Asha Report — name matches", nil, bson.D{{Key: "suggestions", Value: sugg}}),
				ev(0xc6, 500, "TXN-M1", "C", "Asha Report claimed this exact transaction", bson.D{{Key: "invoiceId", Value: gid(9, 21)}, {Key: "residentId", Value: gid(9, 10)}}, bson.D{{Key: "claimEventId", Value: gid(9, 42).Hex()}}),
				stamp(0xc7, bson.D{{Key: "invoiceId", Value: nil}, {Key: "residentId", Value: gid(9, 0xb4)}, {Key: "amount", Value: 410}, {Key: "currency", Value: "NPR"}, {Key: "direction", Value: "CREDIT"}, {Key: "source", Value: "RESIDENT_CLAIM"},
					{Key: "provider", Value: "ESEWA"}, {Key: "providerTxnId", Value: "CLAIM-77"}, {Key: "confirmation", Value: "UNCONFIRMED"}, {Key: "status", Value: "PENDING"}, {Key: "occurredAt", Value: at}, {Key: "idempotencyKey", Value: "claim:c7"},
					{Key: "rawPayload", Value: bson.D{{Key: "transactionCode", Value: "CLAIM-77"}}}}),
			},
		}
	})
}
