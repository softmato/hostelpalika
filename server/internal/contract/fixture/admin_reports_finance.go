package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// The reports group's finance rows: rate cards, month discounts and rent invoices
// the concession backfill can reach. Ids from 0xA0.
//
//	concession a0 2083-07 · rent invoice a1 2083-06 open · a2 2083-08 paid (balance a3)
//	fee schedules a4 closed · a5 open
//	residents b0 rate card · b1 own fee, same-day cycle · b2 unpriced room · b3 paid before joining
func init() {
	extendGroup("admin-reports", func(now time.Time) map[string][]any {
		at := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		hostel := gid(9, 2)
		stamp := func(n int, d bson.D) bson.D {
			return append(bson.D{{Key: "_id", Value: gid(9, n)}, {Key: "hostelId", Value: hostel}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}, d...)
		}
		rent := func(n int, period, status string) bson.D {
			return stamp(n, bson.D{{Key: "residentId", Value: gid(9, 10)}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "period", Value: period}, {Key: "status", Value: status},
				{Key: "currency", Value: "NPR"}, {Key: "totalAmount", Value: 1000}, {Key: "dueDate", Value: at.Add(240 * time.Hour)},
				{Key: "lines", Value: bson.A{bson.D{{Key: "amount", Value: 1000}, {Key: "basis", Value: "SCHEDULE"}, {Key: "description", Value: "Monthly rent"}}}}})
		}
		start := func(period string) time.Time { b, _ := bs.PeriodBounds(period); return b.Start }
		rates := bson.A{bson.D{{Key: "roomType", Value: "Single"}, {Key: "bedType", Value: "SINGLE"}, {Key: "monthlyAmount", Value: 9000}, {Key: "currency", Value: "NPR"}}}
		person := func(n int, first string, d bson.D) bson.D {
			return stamp(n, append(bson.D{{Key: "firstName", Value: first}, {Key: "lastName", Value: "Ledger"}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}}, d...))
		}
		return map[string][]any{
			"residents": {
				person(0xb0, "Card", bson.D{{Key: "roomType", Value: "Single"}, {Key: "phone", Value: "9800000200"}, {Key: "moveInDate", Value: start("2083-04")}}),
				person(0xb1, "Own", bson.D{{Key: "roomType", Value: "Single"}, {Key: "monthlyFee", Value: 7000}, {Key: "billingCycle", Value: "SAME_DAY"}, {Key: "moveInDate", Value: start("2083-05").Add(9 * 24 * time.Hour)}, {Key: "roomNumber", Value: "101"}}),
				person(0xb2, "Odd", bson.D{{Key: "roomType", Value: "Penthouse"}, {Key: "moveInDate", Value: start("2083-04")}}),
				person(0xb3, "Early", bson.D{{Key: "roomType", Value: "Single"}, {Key: "paidTill", Value: "2083-06"}, {Key: "moveInDate", Value: start("2083-04")}}),
			},
			"rentconcessions": {stamp(0xa0, bson.D{{Key: "period", Value: "2083-07"}, {Key: "percentOff", Value: 50}, {Key: "reason", Value: "Dashain"}})},
			"invoices":        {rent(0xa1, "2083-06", "OPEN"), rent(0xa2, "2083-08", "PAID")},
			"invoicebalances": {stamp(0xa3, bson.D{{Key: "invoiceId", Value: gid(9, 0xa2)}, {Key: "residentId", Value: gid(9, 10)}, {Key: "settledAmount", Value: 1000}, {Key: "totalAmount", Value: 1000}, {Key: "outstandingAmount", Value: 0}})},
			"feeschedules": {
				stamp(0xa4, bson.D{{Key: "effectiveFrom", Value: start("2083-01")}, {Key: "effectiveTo", Value: start("2083-04").Add(-24 * time.Hour)}, {Key: "rates", Value: rates}, {Key: "fees", Value: bson.A{}}}),
				stamp(0xa5, bson.D{{Key: "effectiveFrom", Value: start("2083-04")}, {Key: "effectiveTo", Value: nil}, {Key: "rates", Value: rates}, {Key: "fees", Value: bson.A{}}}),
			},
		}
	})
}
