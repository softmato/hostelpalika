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
		return map[string][]any{
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
