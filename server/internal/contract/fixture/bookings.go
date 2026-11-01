package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func bkid(n string) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex("6b00000000000000000000" + n)
	return id
}

// Who books. Each owns the booking of the same id, so a case reads like its row.
var (
	BookPending   = bkid("01") // unpaid, in time
	BookLapsed    = bkid("02") // unpaid, window passed; read it
	BookLapsed2   = bkid("03") // unpaid, window passed; cancel it
	BookReview    = bkid("04") // screenshot being checked
	BookWaiting   = bkid("05") // paid, hostel has time
	BookMissed    = bkid("06") // paid, hostel missed; the third strike
	BookConfirmed = bkid("07") // bed held
	BookHoldOver  = bkid("08") // hold passed
	BookEnded     = bkid("09") // refunded, all three papers exist
	BookStay      = bkid("0a") // a short stay, paid
	BookSoftmato  = bkid("0b") // Softmato raised the invoice
	BookNoEmail   = bkid("0c")
	BookStruck1   = bkid("0d")
	BookStruck2   = bkid("0e")
	BookCreator   = bkid("0f") // nothing open: books for real
)

func bookingRow(id bson.ObjectID, status string, now time.Time, extra ...e) d {
	hour := time.Hour
	open := status == "AWAITING_PAYMENT" || status == "PAYMENT_IN_REVIEW" || status == "AWAITING_HOSTEL" || status == "CONFIRMED"
	row := d{{Key: "_id", Value: id}, {Key: "kind", Value: "MONTHLY"}, {Key: "stay", Value: nil}, {Key: "code", Value: "BK-" + id.Hex()[22:] + "TEST"}, {Key: "hostelId", Value: HostelPublished}, {Key: "userId", Value: id}, {Key: "roomType", Value: "Single"},
		{Key: "guest", Value: d{{Key: "email", Value: "guest" + id.Hex()[22:] + "@contract.test"}, {Key: "name", Value: "Guest " + id.Hex()[22:]}, {Key: "phone", Value: "9800000000"}}},
		{Key: "hostelSnapshot", Value: d{{Key: "address", Value: "Ring Road, New Baneshwor, Kathmandu"}, {Key: "name", Value: "Fixture Lakeside Hostel"}, {Key: "phone", Value: "9800000001"}, {Key: "slug", Value: "fixture-lakeside-hostel-baneshwor"}}},
		{Key: "monthlyRent", Value: 15000}, {Key: "fee", Value: 1500}, {Key: "currency", Value: "NPR"},
		{Key: "terms", Value: d{{Key: "cancelSteps", Value: bson.A{d{{Key: "refundPercent", Value: 75}, {Key: "throughDay", Value: 2}}, d{{Key: "refundPercent", Value: 50}, {Key: "throughDay", Value: 5}}, d{{Key: "refundPercent", Value: 25}, {Key: "throughDay", Value: 7}}}},
			{Key: "feePercent", Value: 10}, {Key: "holdDays", Value: 7}, {Key: "hostelAnswerHours", Value: 48}, {Key: "hostelSharePercent", Value: 50}, {Key: "noShowRefundPercent", Value: 0}}},
		{Key: "policy", Value: d{{Key: "acceptedAt", Value: now.Add(-48 * hour)}, {Key: "source", Value: "WEB"}, {Key: "version", Value: "fixture"}}},
		{Key: "refundAccount", Value: d{{Key: "bankName", Value: ""}, {Key: "branch", Value: ""}, {Key: "holderName", Value: "Guest Holder"}, {Key: "method", Value: "ESEWA"}, {Key: "number", Value: d{{Key: "format", Value: "fixture"}}}, {Key: "numberLast4", Value: "4321"}}},
		{Key: "plannedMoveIn", Value: nil}, {Key: "invoiceNumber", Value: "HH-BKI-2083-84-" + id.Hex()[18:]}, {Key: "receiptNumber", Value: nil}, {Key: "softmatoInvoiceNo", Value: nil}, {Key: "status", Value: status}, {Key: "isOpen", Value: open},
		{Key: "paymentDueBy", Value: now.Add(6 * hour)}, {Key: "paymentSubmittedAt", Value: nil}, {Key: "paymentRejection", Value: d{{Key: "at", Value: nil}, {Key: "reason", Value: nil}}}, {Key: "paymentVerifiedAt", Value: nil},
		{Key: "hostelAnswerBy", Value: nil}, {Key: "confirmedAt", Value: nil}, {Key: "holdEndsAt", Value: nil}, {Key: "bedHeld", Value: false}, {Key: "checkedInAt", Value: nil}, {Key: "endedAt", Value: nil}, {Key: "endedBy", Value: nil}, {Key: "endReason", Value: nil}, {Key: "hostelStrike", Value: false},
		{Key: "settlement", Value: d{{Key: "hostelShare", Value: nil}, {Key: "kept", Value: nil}, {Key: "platformShare", Value: nil}, {Key: "refund", Value: nil}, {Key: "refundPercent", Value: nil}}},
		{Key: "createdAt", Value: now.Add(-48 * hour)}, {Key: "updatedAt", Value: now.Add(-48 * hour)}, {Key: "__v", Value: 0}}
	for _, x := range extra {
		for i := range row {
			if row[i].Key == x.Key {
				row[i].Value = x.Value
			}
		}
	}
	return row
}

func bookingDocs(now time.Time) map[string][]any {
	hour, day := time.Hour, 24*time.Hour
	paid := e{Key: "paymentVerifiedAt", Value: now.Add(-24 * hour)}
	ago := func(key string, by time.Duration) e { return e{Key: key, Value: now.Add(-by)} }
	soon := func(key string, by time.Duration) e { return e{Key: key, Value: now.Add(by)} }
	user := func(id bson.ObjectID, suffix string) d {
		return cardUser(id, "guest"+suffix+"@contract.test", "Guest "+suffix, "", now)
	}
	moveIn := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(10 * day)
	noEmail := user(BookNoEmail, "0c")
	for i := range noEmail {
		if noEmail[i].Key == "email" {
			noEmail[i].Value = ""
		}
	}
	return map[string][]any{
		"users": {user(BookPending, "01"), user(BookLapsed, "02"), user(BookLapsed2, "03"), user(BookReview, "04"), user(BookWaiting, "05"), user(BookMissed, "06"), user(BookConfirmed, "07"), user(BookHoldOver, "08"),
			user(BookEnded, "09"), user(BookStay, "0a"), user(BookSoftmato, "0b"), noEmail, user(BookStruck1, "0d"), user(BookStruck2, "0e"), user(BookCreator, "0f")},
		"bookings": {
			bookingRow(BookPending, "AWAITING_PAYMENT", now),
			bookingRow(BookLapsed, "AWAITING_PAYMENT", now, ago("paymentDueBy", hour)),
			bookingRow(BookLapsed2, "AWAITING_PAYMENT", now, ago("paymentDueBy", hour)),
			bookingRow(BookReview, "PAYMENT_IN_REVIEW", now, ago("paymentSubmittedAt", hour)),
			bookingRow(BookWaiting, "AWAITING_HOSTEL", now, paid, soon("hostelAnswerBy", 10*hour)),
			bookingRow(BookMissed, "AWAITING_HOSTEL", now, paid, ago("hostelAnswerBy", hour)),
			bookingRow(BookConfirmed, "CONFIRMED", now, paid, ago("confirmedAt", hour), soon("holdEndsAt", 167*hour), e{Key: "bedHeld", Value: true}, e{Key: "plannedMoveIn", Value: moveIn}),
			bookingRow(BookHoldOver, "CONFIRMED", now, paid, ago("confirmedAt", 8*day), ago("holdEndsAt", day), e{Key: "bedHeld", Value: true}),
			bookingRow(BookEnded, "CANCELLED_BY_USER", now, paid, ago("confirmedAt", 20*hour), e{Key: "receiptNumber", Value: "HH-BKR-2083-84-00000009"}, ago("endedAt", 10*hour), e{Key: "endedBy", Value: BookEnded},
				e{Key: "settlement", Value: d{{Key: "kept", Value: 375}, {Key: "refund", Value: 1125}, {Key: "refundPercent", Value: 75}, {Key: "hostelShare", Value: 188}, {Key: "platformShare", Value: 187}}}),
			bookingRow(BookStay, "AWAITING_HOSTEL", now, paid, soon("hostelAnswerBy", 10*hour), e{Key: "kind", Value: "SHORT_STAY"}, e{Key: "plannedMoveIn", Value: moveIn},
				e{Key: "stay", Value: d{{Key: "amount", Value: 3000}, {Key: "dailyRate", Value: 1000}, {Key: "holdBlocks", Value: 2}, {Key: "hostelSharePercent", Value: 80}, {Key: "moveIn", Value: moveIn}, {Key: "moveOut", Value: moveIn.Add(3 * day)}, {Key: "nights", Value: 3}}}, e{Key: "fee", Value: 3000}),
			bookingRow(BookSoftmato, "AWAITING_HOSTEL", now, paid, soon("hostelAnswerBy", 10*hour), e{Key: "softmatoInvoiceNo", Value: "INV-000123"}, e{Key: "receiptNumber", Value: "TXN-00000456"}),
			bookingRow(BookStruck1, "HOSTEL_NO_RESPONSE", now, paid, ago("endedAt", day), e{Key: "hostelStrike", Value: true}),
			bookingRow(BookStruck2, "HOSTEL_NO_RESPONSE", now, paid, ago("endedAt", 2*day), e{Key: "hostelStrike", Value: true}),
		},
		"bookingtransfers": {
			d{{Key: "_id", Value: bkid("a9")}, {Key: "bookingId", Value: BookEnded}, {Key: "hostelId", Value: HostelPublished}, {Key: "userId", Value: BookEnded}, {Key: "kind", Value: "REFUND"}, {Key: "amount", Value: 1125}, {Key: "status", Value: "SENT"},
				{Key: "sentAt", Value: now.Add(-2 * hour)}, {Key: "transactionId", Value: "TX-555"}, {Key: "documentNumber", Value: "HH-BRF-2083-84-00000009"},
				{Key: "destination", Value: d{{Key: "bankName", Value: ""}, {Key: "holderName", Value: "Guest Holder"}, {Key: "method", Value: "ESEWA"}, {Key: "numberLast4", Value: "4321"}}}},
		},
		"hostelpayoutaccounts": {
			d{{Key: "_id", Value: bkid("b1")}, {Key: "hostelId", Value: HostelPublished}, {Key: "status", Value: "VERIFIED"}},
		},
		"feeschedules": {
			d{{Key: "_id", Value: bkid("c1")}, {Key: "hostelId", Value: HostelPublished}, {Key: "effectiveFrom", Value: now.Add(-400 * day)}, {Key: "effectiveTo", Value: nil},
				{Key: "rates", Value: bson.A{d{{Key: "roomType", Value: "Single"}, {Key: "monthlyAmount", Value: 15000}}, d{{Key: "roomType", Value: "Double"}, {Key: "monthlyAmount", Value: 9000}}}}},
		},
	}
}
