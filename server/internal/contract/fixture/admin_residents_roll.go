package fixture

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
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
	moveIn := time.Date(2030, 1, 10, 0, 0, 0, 0, time.UTC) // fixed: the recorded answers carry this date
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

// Group admin-residents-intake (testdata/contract/admin-residents-intake): the roll
// group plus the people the status and intake cases act on. Kept apart because the
// roll cases read whole rolls.
func init() {
	groupSeeds["admin-residents-intake"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := groupSeeds["admin-residents-roll"](ctx, db, now); err != nil {
			return err
		}
		// Room for the intake cases to book beds in: the base seed has one vacant Single.
		if _, err := db.Collection("hostels").UpdateOne(ctx, bson.D{{Key: "_id", Value: HostelKyc}}, bson.D{{Key: "$set", Value: bson.D{{Key: "roomConfigurations.0.rooms", Value: 20}, {Key: "roomConfigurations.0.vacantBeds", Value: 20}}}}); err != nil {
			return err
		}
		return insertAll(ctx, db, rollStatus(now))
	}
}

// rollStatus seeds the status cases: 48 Hari (pending, a public account on their
// address, moves in today), 49 Indu (pending, no address), 51 Jay (moved out, still
// linked to his login), 57 Clash (shares the phone of moved-out Gita, 47).
func rollStatus(now time.Time) map[string][]any {
	row := func(n int, first, status, phone, addr string, moveIn time.Time, extra ...bson.E) bson.D {
		d := bson.D{{Key: "_id", Value: gid(1, n)}, {Key: "hostelId", Value: HostelKyc}, {Key: "firstName", Value: first}, {Key: "lastName", Value: "Status"}, {Key: "phone", Value: phone},
			{Key: "roomType", Value: "Single"}, {Key: "moveInDate", Value: moveIn}, {Key: "status", Value: status}, {Key: "isDeleted", Value: false}, {Key: "depositAmount", Value: 0}}
		if addr != "" {
			d = append(d, bson.E{Key: "email", Value: addr})
		}
		d = append(d, extra...)
		return append(d, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	}
	// Admitting raises a first-month invoice only when the move-in falls in the current BS
	// month. Hari's must (his recording has one: amount and period masked), Indu's and
	// Jay's must not. Fixed dates and "20 days ago" both crossed a month boundary and
	// turned CI red on 2026-11-09 (P11-28).
	today := bs.Today(now)
	old := now.Add(-20 * 24 * time.Hour)
	if start, err := bs.MonthStart(now); err == nil && !old.Before(start) {
		old = start.Add(-24 * time.Hour)
	}
	return map[string][]any{
		"users": {cardUser(gid(1, 60), "hari@contract.test", "Hari Status", "", now), cardUser(gid(1, 61), "jay@contract.test", "Jay Status", "", now), cardUser(gid(1, 62), "newbie@contract.test", "Newbie Public", "", now),
			cardUser(gid(1, 64), "scan1@contract.test", "Scan One", "HH-SCAN-0001", now), cardUser(gid(1, 65), "scan2@contract.test", "Scan Two", "HH-SCAN-0002", now),
			cardUser(gid(1, 66), "scan3@contract.test", "Scan Three", "HH-SCAN-0003", now), cardUser(gid(1, 67), "scan4@contract.test", "Scan Four", "HH-SCAN-0004", now)},
		"userresidentprofiles": {fullProfile(gid(1, 64), "Scan One", "scan1@contract.test", "9800000010", now), fullProfile(gid(1, 65), "Scan Two", "scan2@contract.test", "9877777777", now),
			cardProfile(gid(1, 66), "Scan Three", "scan3@contract.test", "9866666666", false, now)},
		"referralcodes": {bson.D{{Key: "_id", Value: gid(1, 63)}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: gid(1, 40)}, {Key: "code", Value: "REFASHA1"}, {Key: "status", Value: "ACTIVE"}, {Key: "joinedCount", Value: 0},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}},
		"residents": {
			row(48, "Hari", "PENDING", "9800000080", "hari@contract.test", today),
			row(49, "Indu", "PENDING", "9800000090", "", old),
			row(51, "Jay", "MOVED_OUT", "9800099991", "jay@contract.test", old, bson.E{Key: "userId", Value: gid(1, 61)}),
			row(57, "Clash", "ACTIVE", "9800000070", "", old),
		},
	}
}

// fullProfile is a completed, shared ID-card profile with every field the lookup reads.
func fullProfile(user bson.ObjectID, name, mail, phone string, now time.Time) bson.D {
	raw, _ := json.Marshal(map[string]any{"fullName": name, "dateOfBirth": "2000-05-01", "gender": "MALE", "bloodGroup": "O_POSITIVE", "primaryPhone": phone, "primaryEmail": mail,
		"permanentAddress": "Tole 4", "city": "Lalitpur", "district": "Lalitpur", "wardNo": "5", "occupation": "STUDENT", "institution": "Campus", "courseOrDesignation": "BBA",
		"guardianName": "Gita Parent", "guardianRelation": "Mother", "guardianPhone": "9811100000", "secondGuardianName": "Hari Parent", "secondGuardianPhone": "9811100001",
		"emergencyContactName": "Uncle Ram", "emergencyContactPhone": "9811100002", "dietaryPreference": "VEGETARIAN", "interests": []string{"chess"}, "governmentIdNumber": "12-34", "governmentIdType": "CITIZENSHIP"})
	p, _ := crypto.NewPersonal(PersonalKey)
	blob, _ := p.Encrypt(raw)
	return bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "userId", Value: user}, {Key: "encryptedData", Value: blob}, {Key: "payloadVersion", Value: 1}, {Key: "completedAt", Value: now},
		{Key: "photoAssetId", Value: nil}, {Key: "photoUpdatedAt", Value: nil}, {Key: "shareCount", Value: 0}, {Key: "sharingEnabled", Value: true}, {Key: "isDeleted", Value: false},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}
}

// Group admin-residents-existing (testdata/contract/admin-residents-existing): the
// intake group plus join requests waiting at HostelKyc. Rent is always paid far
// ahead, so no case depends on which BS month it is run in.
func init() {
	groupSeeds["admin-residents-existing"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := groupSeeds["admin-residents-intake"](ctx, db, now); err != nil {
			return err
		}
		app := func(n, user int, card, name, phone, status string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(1, n)}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: gid(1, user)}, {Key: "cardId", Value: card}, {Key: "fullName", Value: name},
				{Key: "phone", Value: phone}, {Key: "email", Value: name[:4] + "@contract.test"}, {Key: "roomType", Value: "Single"}, {Key: "paidTill", Value: "2084-06"}, {Key: "partPaid", Value: 0},
				{Key: "depositPaid", Value: 1000}, {Key: "joinedDate", Value: nil}, {Key: "note", Value: ""}, {Key: "status", Value: status}, {Key: "rejectReason", Value: ""}, {Key: "sends", Value: 1},
				{Key: "sentAt", Value: now.Add(-3 * time.Hour)}, {Key: "decidedAt", Value: nil}, {Key: "residentId", Value: nil}}
			d = withOverrides(d, extra)
			return append(d, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		}
		rooms := make([]any, 0, 12)
		for i := 1; i <= 12; i++ {
			rooms = append(rooms, bson.D{{Key: "_id", Value: gid(1, 100+i)}, {Key: "hostelId", Value: HostelKyc}, {Key: "floor", Value: 3}, {Key: "number", Value: "S" + strconv.Itoa(i)}, {Key: "roomType", Value: "Single"}, {Key: "beds", Value: 1},
				{Key: "isDeleted", Value: false}, {Key: "createdBy", Value: UserAdmin}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		}
		return insertAll(ctx, db, map[string][]any{"hostelrooms": rooms, "residentapplications": {
			app(70, 64, "HH-SCAN-0001", "Scan One", "9855500001", "PENDING"),
			app(71, 65, "HH-SCAN-0002", "Scan Two", "9800000010", "PENDING"),
			app(72, 66, "HH-SCAN-0003", "Scan Three", "9855500003", "REJECTED", bson.E{Key: "rejectReason", Value: "Fix the phone"}, bson.E{Key: "decidedAt", Value: now.Add(-time.Hour)}),
			app(73, 67, "HH-SCAN-0004", "Scan Four", "9855500004", "ADDED", bson.E{Key: "decidedAt", Value: now.Add(-time.Hour)}),
		}})
	}
}
