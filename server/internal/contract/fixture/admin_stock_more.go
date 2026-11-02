package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// The stock group's referral and provider rows. Ids from 0xa0.
//
//	resident a0 Ravi (referrer) · a1 Maya (joined) · a2 the other hostel's
//	code a4 · referral a5 waiting · a6 joined, reward a8 · a7 the other hostel's
//	provider b0 approved plumber · b1 pending · application b2 · document b3
//	hostel-referral b5
func init() {
	extendGroup("admin-stock", func(time.Time) map[string][]any {
		at := time.Date(2026, 10, 1, 6, 0, 0, 0, time.UTC)
		hostel := gid(3, 2)
		other := oid("a1")
		with := func(d bson.D) bson.D {
			return append(d, bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
		}
		resident := func(n int, h bson.ObjectID, first, phone string) bson.D {
			return with(bson.D{{Key: "_id", Value: gid(3, n)}, {Key: "hostelId", Value: h}, {Key: "firstName", Value: first}, {Key: "lastName", Value: "Rai"}, {Key: "phone", Value: phone}, {Key: "roomType", Value: "SINGLE"}, {Key: "moveInDate", Value: at}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "depositAmount", Value: 0}})
		}
		referral := func(n int, h bson.ObjectID, status string, referrer int) bson.D {
			return with(bson.D{{Key: "_id", Value: gid(3, n)}, {Key: "hostelId", Value: h}, {Key: "referralCodeId", Value: gid(3, 0xa4)}, {Key: "referrerResidentId", Value: gid(3, referrer)}, {Key: "name", Value: "Friend"}, {Key: "phone", Value: "9800000099"}, {Key: "status", Value: status}, {Key: "converted", Value: false}, {Key: "isDeleted", Value: false}})
		}
		provider := func(n int, status, name, phone string) bson.D {
			return with(bson.D{{Key: "_id", Value: gid(3, n)}, {Key: "fullName", Value: name}, {Key: "phone", Value: phone}, {Key: "area", Value: "Baneshwor"}, {Key: "category", Value: "PLUMBER"}, {Key: "categories", Value: bson.A{"PLUMBER"}}, {Key: "status", Value: status}, {Key: "isDeleted", Value: false}, {Key: "description", Value: "Fixes taps"}})
		}
		return map[string][]any{
			"residents":                   {resident(0xa0, hostel, "Ravi", "9800000090"), resident(0xa1, hostel, "Maya", "9800000091"), resident(0xa2, other, "Elsewhere", "9800000092")},
			"referralcodes":               {with(bson.D{{Key: "_id", Value: gid(3, 0xa4)}, {Key: "hostelId", Value: hostel}, {Key: "residentId", Value: gid(3, 0xa0)}, {Key: "userId", Value: gid(3, 10)}, {Key: "code", Value: "HH0090A0"}, {Key: "status", Value: "ACTIVE"}, {Key: "joinedCount", Value: 1}, {Key: "rewardCount", Value: 0}})},
			"referrals":                   {referral(0xa5, hostel, "INQUIRY_CREATED", 0xa0), referral(0xa6, hostel, "JOINED", 0xa0), referral(0xa7, other, "INQUIRY_CREATED", 0xa2)},
			"referralrewards":             {with(bson.D{{Key: "_id", Value: gid(3, 0xa8)}, {Key: "referralId", Value: gid(3, 0xa6)}, {Key: "hostelId", Value: hostel}, {Key: "referrerResidentId", Value: gid(3, 0xa0)}, {Key: "amount", Value: 500}, {Key: "rewardType", Value: "CASH"}, {Key: "status", Value: "PENDING"}})},
			"serviceproviders":            {provider(0xb0, "APPROVED", "Hari Plumber", "9810000000"), provider(0xb1, "PENDING_APPROVAL", "Waiting One", "9810000001")},
			"serviceproviderapplications": {with(bson.D{{Key: "_id", Value: gid(3, 0xb2)}, {Key: "providerId", Value: gid(3, 0xb0)}, {Key: "status", Value: "APPROVED"}, {Key: "submittedAt", Value: at}, {Key: "isDeleted", Value: false}})},
			"serviceproviderdocuments":    {with(bson.D{{Key: "_id", Value: gid(3, 0xb3)}, {Key: "providerId", Value: gid(3, 0xb0)}, {Key: "documentType", Value: "LICENSE"}, {Key: "fileUrl", Value: "https://x.test/a.pdf"}, {Key: "status", Value: "PENDING"}, {Key: "isDeleted", Value: false}})},
			"hostelreferrals":             {with(bson.D{{Key: "_id", Value: gid(3, 0xb5)}, {Key: "referrerHostelId", Value: hostel}, {Key: "refereeHostelId", Value: other}, {Key: "referrerReward", Value: bson.D{{Key: "days", Value: 0}, {Key: "months", Value: 1}}}, {Key: "status", Value: "REGISTERED"}})},
		}
	})
}
