package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// The reports group. Rows sit at fixed instants inside BS 2083-05, with one invoice
// and one page view in whatever month is current, so the dashboard's figures hold.
func init() {
	extendGroup("admin-reports", func(now time.Time) map[string][]any {
		at := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		later := at.Add(36 * time.Hour)
		hostel := gid(9, 2)
		current, _ := bs.PeriodOf(now)
		stamp := func(n int, d bson.D) bson.D {
			return append(bson.D{{Key: "_id", Value: gid(9, n)}, {Key: "hostelId", Value: hostel}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}, d...)
		}
		resident := func(n int, first, status string, deleted bool) bson.D {
			return stamp(n, bson.D{{Key: "firstName", Value: first}, {Key: "lastName", Value: "Report"}, {Key: "phone", Value: "98000001" + string(rune('0'+n%10)) + "0"}, {Key: "roomType", Value: "Single"}, {Key: "status", Value: status}, {Key: "isDeleted", Value: deleted}, {Key: "moveInDate", Value: at}})
		}
		invoice := func(n, resident int, period any, status string, total int) bson.D {
			return stamp(n, bson.D{{Key: "residentId", Value: gid(9, resident)}, {Key: "period", Value: period}, {Key: "status", Value: status}, {Key: "totalAmount", Value: total}, {Key: "dueDate", Value: later}})
		}
		event := func(n, invoice int, status, source string, amount int) bson.D {
			return stamp(n, bson.D{{Key: "invoiceId", Value: gid(9, invoice)}, {Key: "residentId", Value: gid(9, 10)}, {Key: "direction", Value: "CREDIT"}, {Key: "status", Value: status}, {Key: "source", Value: source}, {Key: "provider", Value: "ESEWA"}, {Key: "amount", Value: amount}, {Key: "occurredAt", Value: at}, {Key: "settledAt", Value: later}})
		}
		balance := func(n, invoice, settled int) bson.D {
			return stamp(n, bson.D{{Key: "invoiceId", Value: gid(9, invoice)}, {Key: "settledAmount", Value: settled}})
		}
		log := func(n int, meal string, minutesAfterMidnightUTC int, device any) bson.D {
			return stamp(n, bson.D{{Key: "mealType", Value: meal}, {Key: "announcedAt", Value: now.Add(-48 * time.Hour).UTC().Truncate(24 * time.Hour).Add(time.Duration(minutesAfterMidnightUTC) * time.Minute)}, {Key: "notifiedCount", Value: 3}, {Key: "deviceInfo", Value: device}})
		}
		zone := func(n, resident, daysAgo int, name string) bson.D {
			return stamp(n, bson.D{{Key: "residentId", Value: gid(9, resident)}, {Key: "zone", Value: name}, {Key: "day", Value: now.Add(-time.Duration(daysAgo) * 24 * time.Hour).UTC().Truncate(24 * time.Hour)}})
		}
		return map[string][]any{
			"hostels": {bson.D{{Key: "_id", Value: hostel}, {Key: "name", Value: "Report Hostel"}, {Key: "slug", Value: "report-hostel"}, {Key: "isDeleted", Value: false}, {Key: "ownerId", Value: UserAdmin}, {Key: "publicViewCount", Value: 9}, {Key: "createdAt", Value: at},
				{Key: "roomConfigurations", Value: bson.A{bson.D{{Key: "roomType", Value: "Single"}, {Key: "rooms", Value: 4}, {Key: "bedsPerRoom", Value: 2}, {Key: "vacantBeds", Value: 3}}, bson.D{{Key: "rooms", Value: 1}, {Key: "bedsPerRoom", Value: 3}, {Key: "vacantBeds", Value: 0}}}}}},
			"users":                    {bson.D{{Key: "_id", Value: gid(9, 5)}, {Key: "name", Value: "Report Warden"}, {Key: "email", Value: "w.report@contract.test"}, {Key: "emailVerified", Value: true}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}, {Key: "hostelIds", Value: bson.A{hostel}}, {Key: "authProvider", Value: "LOCAL"}, {Key: "tokenVersion", Value: 0}, {Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false}, {Key: "mustChangePassword", Value: false}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}},
			"hostelmembers":            {stamp(6, bson.D{{Key: "userId", Value: gid(9, 5)}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}, {Key: "permissions", Value: bson.A{}}, {Key: "isDeleted", Value: false}})},
			"residents":                {resident(10, "Asha", "ACTIVE", false), resident(11, "Bina", "PENDING", false), resident(12, "Gone", "MOVED_OUT", false), resident(13, "Erased", "ACTIVE", true)},
			"invoices":                 {invoice(20, 10, "2083-05", "PARTIAL", 1000), invoice(21, 11, "2083-05", "OPEN", 500), invoice(22, 10, "2083-04", "PAID", 800), invoice(23, 13, "2083-05", "OPEN", 300), invoice(24, 10, nil, "OPEN", 200), invoice(25, 10, current, "OPEN", 700), invoice(26, 10, "2083-05", "VOID", 999)},
			"invoicebalances":          {balance(30, 20, 250), balance(31, 22, 800)},
			"paymentevents":            {event(40, 20, "SETTLED", "ADMIN", 250), event(41, 22, "SETTLED", "ADMIN", 800), event(42, 21, "PENDING", "RESIDENT_CLAIM", 500)},
			"complaints":               {stamp(50, bson.D{{Key: "category", Value: "FOOD"}, {Key: "status", Value: "PENDING"}, {Key: "slaDueAt", Value: at}}), stamp(51, bson.D{{Key: "category", Value: "ROOM"}, {Key: "status", Value: "RESOLVED"}, {Key: "resolvedAt", Value: later}})},
			"maintenancerequests":      {stamp(55, bson.D{{Key: "category", Value: "PLUMBING"}, {Key: "status", Value: "OPEN"}, {Key: "isDeleted", Value: false}}), stamp(56, bson.D{{Key: "category", Value: "ELECTRIC"}, {Key: "status", Value: "COMPLETED"}, {Key: "completedAt", Value: later}, {Key: "isDeleted", Value: false}})},
			"foodfeedbacks":            {stamp(60, bson.D{{Key: "rating", Value: 4}}), stamp(61, bson.D{{Key: "rating", Value: 3}})},
			"foodroutines":             {stamp(62, bson.D{{Key: "timings", Value: bson.D{{Key: "BREAKFAST", Value: "6:00 AM - 7:00 AM"}, {Key: "DINNER", Value: "whenever"}}}})},
			"foodreadylogs":            {log(63, "BREAKFAST", 15, bson.D{{Key: "fingerprint", Value: "phone-a"}}), log(64, "BREAKFAST", 60, nil), log(65, "DINNER", 800, bson.D{{Key: "fingerprint", Value: "phone-a"}})},
			"attendancelogs":           {zone(70, 10, 1, "INSIDE"), zone(71, 10, 2, "NEARBY"), zone(72, 11, 1, "OUTSIDE"), zone(73, 11, 2, "OUTSIDE"), zone(74, 11, 3, "OUTSIDE"), zone(75, 11, 4, "OUTSIDE"), zone(76, 11, 5, "UNKNOWN"), zone(77, 12, 1, "INSIDE")},
			"inquiries":                {stamp(80, bson.D{{Key: "status", Value: "CONVERTED"}, {Key: "isDeleted", Value: false}}), stamp(81, bson.D{{Key: "status", Value: "NEW"}, {Key: "isDeleted", Value: false}})},
			"referrals":                {stamp(82, bson.D{{Key: "status", Value: "JOINED"}, {Key: "isDeleted", Value: false}})},
			"referralrewards":          {stamp(83, bson.D{{Key: "status", Value: "APPROVED"}, {Key: "amount", Value: 150}}), stamp(84, bson.D{{Key: "status", Value: "PAID"}, {Key: "amount", Value: 50}})},
			"nightstatuses":            {stamp(85, bson.D{{Key: "residentId", Value: gid(9, 10)}, {Key: "night", Value: bs.NightKey(now)}, {Key: "status", Value: "INSIDE_HOSTEL"}})},
			"hostelpageviews":          {stamp(86, bson.D{{Key: "visitorKey", Value: "a"}}), stamp(87, bson.D{{Key: "visitorKey", Value: "a"}}), stamp(88, bson.D{{Key: "visitorKey", Value: "b"}})},
			"ratingreviews":            {stamp(89, bson.D{{Key: "status", Value: "VISIBLE"}, {Key: "overallRating", Value: 4.25}})},
			"moveoutchecklists":        {stamp(90, bson.D{{Key: "residentId", Value: gid(9, 10)}, {Key: "completedAt", Value: later}})},
			"hostellistingimpressions": {stamp(91, bson.D{{Key: "day", Value: bs.NepalDayKey(at)}, {Key: "count", Value: 12}})},
			"hostelpaymentprofiles":    {stamp(92, bson.D{{Key: "statementCadenceDays", Value: 7}})},
		}
	})
}
