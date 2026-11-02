package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Group admin-residents-roll (testdata/contract/admin-residents-roll): the
// admin-residents seed with the admin's hostel KYC-approved, so the
// registerResidents writes open (HostelKyc is locked by default), and the base
// seed's desk-intake row (no moveInDate: the TS serializer throws on it)
// soft-deleted, because these cases read whole rolls.
func init() {
	groupSeeds["admin-residents-roll"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := groupSeeds["admin-residents"](ctx, db, now); err != nil {
			return err
		}
		if _, err := db.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: HostelKyc}}, bson.D{{Key: "$set", Value: bson.D{{Key: "kyc.status", Value: "APPROVED"}}}}); err != nil {
			return err
		}
		form := func(n int, h bson.ObjectID, first, status string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(1, n)}, {Key: "hostelId", Value: h}, {Key: "firstName", Value: first}, {Key: "lastName", Value: "Applicant"}, {Key: "phone", Value: "98500000" + string(rune('0'+n%10)) + "0"},
				{Key: "email", Value: first + "@contract.test"}, {Key: "residentType", Value: "STUDENT"}, {Key: "status", Value: status}, {Key: "submittedAt", Value: now.Add(-time.Duration(n) * time.Hour)}}
			d = withOverrides(d, extra)
			return append(d, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		}
		if err := insertAll(ctx, db, map[string][]any{"admissionforms": {
			form(100, HostelKyc, "form1", "PENDING", bson.E{Key: "photoAssetId", Value: gid(1, 91)}, bson.E{Key: "documents", Value: bson.A{bson.D{{Key: "fileAssetId", Value: gid(1, 92)}, {Key: "kind", Value: "APPLICANT_ID"}}}}),
			form(101, HostelKyc, "form2", "PENDING"), form(102, HostelKyc, "form3", "DECLINED"), form(103, gid(1, 1), "form4", "PENDING"),
		}}); err != nil {
			return err
		}
		if err := insertAll(ctx, db, rollBookings(now)); err != nil {
			return err
		}
		_, err := db.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: oid("c2")}}, bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}}}})
		return err
	}
}

// rollBookings seeds the hostel-admin bookings queue in HostelKyc (ids 6b..d1 on):
// d1-d3 awaiting an answer, d4 whose answer time passed, d5 held on a scanned card,
// d6 whose hold ended, d7 ended with a sent payout, d8 the outsider's, d9 a short stay.
func rollBookings(now time.Time) map[string][]any {
	hour, day := time.Hour, 24*time.Hour
	paid := e{Key: "paymentVerifiedAt", Value: now.Add(-24 * hour)}
	ago := func(key string, by time.Duration) e { return e{Key: key, Value: now.Add(-by)} }
	soon := func(key string, by time.Duration) e { return e{Key: key, Value: now.Add(by)} }
	at := func(id bson.ObjectID, status string, extra ...e) any {
		return bookingRow(id, status, now, append([]e{{Key: "hostelId", Value: HostelKyc}, paid}, extra...)...)
	}
	ids := []bson.ObjectID{bkid("d1"), bkid("d2"), bkid("d3"), bkid("d4"), bkid("d5"), bkid("d6"), bkid("d7"), bkid("d8"), bkid("d9")}
	users := make([]any, 0, len(ids))
	for i, id := range ids {
		u := cardUser(id, "roll"+id.Hex()[22:]+"@contract.test", "Roll "+id.Hex()[22:], "", now)
		if i == 4 {
			u = cardUser(id, "roll"+id.Hex()[22:]+"@contract.test", "Roll "+id.Hex()[22:], "HH-ABCD-1234", now)
		}
		users = append(users, u)
	}
	held := e{Key: "bedHeld", Value: true}
	moveIn := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(10 * day)
	return map[string][]any{
		"users": users,
		"bookings": {
			at(ids[0], "AWAITING_HOSTEL", soon("hostelAnswerBy", 10*hour), e{Key: "plannedMoveIn", Value: moveIn}),
			at(ids[1], "AWAITING_HOSTEL", soon("hostelAnswerBy", 20*hour)),
			at(ids[2], "AWAITING_HOSTEL", soon("hostelAnswerBy", 30*hour)),
			at(ids[3], "AWAITING_HOSTEL", ago("hostelAnswerBy", hour)),
			at(ids[4], "CONFIRMED", ago("confirmedAt", hour), soon("holdEndsAt", 100*hour), held),
			at(ids[5], "CONFIRMED", ago("confirmedAt", 8*day), ago("holdEndsAt", day), held),
			at(ids[6], "CANCELLED_BY_USER", ago("confirmedAt", 20*hour), ago("endedAt", 10*hour), e{Key: "endedBy", Value: ids[6]},
				e{Key: "settlement", Value: d{{Key: "kept", Value: 375}, {Key: "refund", Value: 1125}, {Key: "refundPercent", Value: 75}, {Key: "hostelShare", Value: 188}, {Key: "platformShare", Value: 187}}}),
			bookingRow(ids[7], "AWAITING_HOSTEL", now, e{Key: "hostelId", Value: gid(1, 1)}, paid, soon("hostelAnswerBy", 10*hour)),
			at(ids[8], "AWAITING_HOSTEL", soon("hostelAnswerBy", 15*hour), e{Key: "kind", Value: "SHORT_STAY"}, e{Key: "plannedMoveIn", Value: moveIn}, e{Key: "fee", Value: 3000},
				e{Key: "stay", Value: d{{Key: "amount", Value: 3000}, {Key: "dailyRate", Value: 1000}, {Key: "holdBlocks", Value: 2}, {Key: "hostelSharePercent", Value: 80}, {Key: "moveIn", Value: moveIn}, {Key: "moveOut", Value: moveIn.Add(3 * day)}, {Key: "nights", Value: 3}}}),
		},
		"bookingtransfers": {
			d{{Key: "_id", Value: bkid("e1")}, {Key: "bookingId", Value: ids[6]}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: ids[6]}, {Key: "kind", Value: "PAYOUT"}, {Key: "amount", Value: 188}, {Key: "status", Value: "SENT"},
				{Key: "sentAt", Value: now.Add(-2 * hour)}, {Key: "transactionId", Value: "TX-777"}, {Key: "documentNumber", Value: "HH-BPO-2083-84-00000007"},
				{Key: "destination", Value: d{{Key: "bankName", Value: "Contract Bank"}, {Key: "holderName", Value: "Roll Hostel"}, {Key: "method", Value: "BANK"}, {Key: "numberLast4", Value: "9999"}}}},
		},
	}
}
