package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Quick sign-ups for the KYC cases: 40 owner, 41 a draft with nothing, 42 owner, 43 a
// draft with every required step done, 44-49 that one's rows.
var (
	KycOwner    = gid(4, 40)
	KycEmpty    = gid(4, 41)
	KycOwner2   = gid(4, 42)
	KycComplete = gid(4, 43)
)

func init() {
	extendGroup("admin-setup", func(now time.Time) map[string][]any {
		fixed := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		base := func(id, owner bson.ObjectID, name, slug string, location bson.D, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: owner}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "status", Value: "ACTIVE"}, {Key: "verificationStatus", Value: "PENDING"}, {Key: "location", Value: location}, {Key: "kyc", Value: bson.D{{Key: "required", Value: true}, {Key: "status", Value: "DRAFT"}}},
				{Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}
			return append(d, extra...)
		}
		photo := func(n string) bson.D { return bson.D{{Key: "url", Value: "https://img.contract.test/" + n + ".jpg"}} }
		return map[string][]any{
			"hostels": {
				base(KycEmpty, KycOwner, "Kyc Empty", "kyc-empty", bson.D{{Key: "city", Value: ""}}),
				base(KycComplete, KycOwner2, "Kyc Complete", "kyc-complete",
					bson.D{{Key: "address", Value: "Ward 4"}, {Key: "area", Value: "Baneshwor"}, {Key: "city", Value: "Kathmandu"}, {Key: "lat", Value: 27.7}, {Key: "lng", Value: 85.3}, {Key: "locationSource", Value: "MANUAL"}},
					bson.E{Key: "photos", Value: bson.A{photo("a"), photo("b"), photo("c")}}, bson.E{Key: "rules", Value: bson.A{"Quiet after ten"}}, bson.E{Key: "facilities", Value: bson.A{"WiFi"}}),
			},
			"users": {
				setupUser(KycOwner, "kyc.owner@contract.test", "HOSTEL_ADMIN", bson.A{KycEmpty}, now),
				setupUser(KycOwner2, "kyc.owner2@contract.test", "HOSTEL_ADMIN", bson.A{KycComplete}, now),
			},
			"hostelmembers": {
				bson.D{{Key: "_id", Value: gid(4, 44)}, {Key: "hostelId", Value: KycEmpty}, {Key: "userId", Value: KycOwner}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}},
				bson.D{{Key: "_id", Value: gid(4, 45)}, {Key: "hostelId", Value: KycComplete}, {Key: "userId", Value: KycOwner2}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}},
			},
			"hosteldocuments": {
				bson.D{{Key: "_id", Value: gid(4, 46)}, {Key: "hostelId", Value: KycComplete}, {Key: "ownerId", Value: KycOwner2}, {Key: "documentType", Value: "PAN"}, {Key: "status", Value: "PENDING"}, {Key: "createdBy", Value: KycOwner2}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: fixed}},
				bson.D{{Key: "_id", Value: gid(4, 47)}, {Key: "hostelId", Value: KycComplete}, {Key: "ownerId", Value: KycOwner2}, {Key: "documentType", Value: "LICENCE"}, {Key: "status", Value: "APPROVED"}, {Key: "createdBy", Value: KycOwner2}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: fixed.Add(time.Hour)}},
			},
			"feeschedules": {
				bson.D{{Key: "_id", Value: gid(4, 48)}, {Key: "hostelId", Value: KycComplete}, {Key: "effectiveTo", Value: nil}, {Key: "rates", Value: bson.A{bson.D{{Key: "roomType", Value: "Single"}, {Key: "amount", Value: 9000}}}}, {Key: "createdAt", Value: fixed}},
			},
			"hostelagreementsignatures": {
				bson.D{{Key: "_id", Value: gid(4, 49)}, {Key: "hostelId", Value: KycComplete}, {Key: "refCode", Value: nil}, {Key: "signature", Value: "M0 0L10 10"}, {Key: "signedAt", Value: fixed}, {Key: "signerName", Value: "Kyc Owner"}},
			},
		}
	})
}
