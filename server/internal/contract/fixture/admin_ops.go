package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// The ops group's own rows (testdata/contract/admin-ops). Hostel OpsA has no KYC
// gate, so its staff can write to the KYC-frozen routes (cooks, attendance,
// night status, notice pushes); OpsB is the other tenant.
var (
	OpsHostelA = gid(2, 1)
	OpsHostelB = gid(2, 2)

	OpsAdminA   = gid(2, 0x10) // HOSTEL_ADMIN of OpsA
	OpsWarden   = gid(2, 0x11) // WARDEN of OpsA holding every ops capability
	OpsWardenNo = gid(2, 0x12) // WARDEN of OpsA holding none
	OpsAdminB   = gid(2, 0x13) // HOSTEL_ADMIN of OpsB

	OpsResidentUser = gid(2, 0x20)
)

func opsUser(id bson.ObjectID, name, email, role string, hostels []bson.ObjectID, now time.Time) bson.D {
	return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "email", Value: email}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: true}, {Key: "role", Value: role},
		{Key: "status", Value: "ACTIVE"}, {Key: "mustChangePassword", Value: false}, {Key: "lockPinFailures", Value: 0}, {Key: "hostelIds", Value: hostels}, {Key: "tokenVersion", Value: 0},
		{Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false}, {Key: "authProvider", Value: "LOCAL"}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}
}

func opsMember(n int, hostel, user bson.ObjectID, role string, perms []string) bson.D {
	p := bson.A{}
	for _, k := range perms {
		p = append(p, k)
	}
	return bson.D{{Key: "_id", Value: gid(2, n)}, {Key: "hostelId", Value: hostel}, {Key: "userId", Value: user}, {Key: "role", Value: role}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "permissions", Value: p}}
}

func opsResident(n int, hostel bson.ObjectID, user *bson.ObjectID, first, last, email string, now time.Time) bson.D {
	d := bson.D{{Key: "_id", Value: gid(2, n)}, {Key: "hostelId", Value: hostel}, {Key: "firstName", Value: first}, {Key: "lastName", Value: last}, {Key: "phone", Value: "9800000" + string(rune('0'+n%10)) + "00"},
		{Key: "roomType", Value: "SINGLE"}, {Key: "moveInDate", Value: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now.Add(-24 * time.Hour)}}
	if email != "" {
		d = append(d, bson.E{Key: "email", Value: email})
	}
	if user != nil {
		d = append(d, bson.E{Key: "userId", Value: *user})
	}
	return d
}

var opsCapabilities = []string{"manageNotices", "manageMaintenance", "viewNightStatus", "updateNightStatus", "manageFood", "viewComplaints", "updateComplaints"}

func init() {
	groupSeeds["admin-ops"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		day := 24 * time.Hour
		a, b := []bson.ObjectID{OpsHostelA}, []bson.ObjectID{OpsHostelB}
		resUser, resUser2 := OpsResidentUser, gid(2, 0x21)
		return insertAll(ctx, db, map[string][]any{
			"hostels": {
				bson.D{{Key: "_id", Value: OpsHostelA}, {Key: "name", Value: "Ops Hostel"}, {Key: "slug", Value: "ops-hostel"}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false}, {Key: "ownerId", Value: OpsAdminA}},
				bson.D{{Key: "_id", Value: OpsHostelB}, {Key: "name", Value: "Other Ops Hostel"}, {Key: "slug", Value: "other-ops-hostel"}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false}, {Key: "ownerId", Value: OpsAdminB}},
			},
			"users": {
				opsUser(OpsAdminA, "Ops Admin", "ops.admin@contract.test", "HOSTEL_ADMIN", a, now),
				opsUser(OpsWarden, "Ops Warden", "ops.warden@contract.test", "WARDEN", a, now),
				opsUser(OpsWardenNo, "Ops Warden None", "ops.warden.none@contract.test", "WARDEN", a, now),
				opsUser(OpsAdminB, "Other Admin", "ops.other@contract.test", "HOSTEL_ADMIN", b, now),
				opsUser(resUser, "Ana Bell", "ops.ana@contract.test", "RESIDENT", a, now),
				opsUser(resUser2, "Cy User", "ops.cy@contract.test", "RESIDENT", a, now),
			},
			"hostelmembers": {
				opsMember(0x50, OpsHostelA, OpsAdminA, "HOSTEL_ADMIN", nil),
				opsMember(0x51, OpsHostelA, OpsWarden, "WARDEN", opsCapabilities),
				opsMember(0x52, OpsHostelA, OpsWardenNo, "WARDEN", nil),
				opsMember(0x53, OpsHostelB, OpsAdminB, "HOSTEL_ADMIN", nil),
			},
			"residents": {
				opsResident(0x30, OpsHostelA, &resUser, "Ana", "Bell", "ops.ana@contract.test", now),
				opsResident(0x31, OpsHostelA, nil, "Bo", "Mail", "ops.bo@contract.test", now),
				opsResident(0x32, OpsHostelA, &resUser2, "Cy", "User", "", now),
				opsResident(0x33, OpsHostelA, nil, "Di", "Nobody", "", now),
				opsResident(0x34, OpsHostelB, nil, "Ed", "Elsewhere", "ops.ed@contract.test", now),
			},
			"notices": {
				bson.D{{Key: "_id", Value: gid(2, 0x40)}, {Key: "hostelId", Value: OpsHostelA}, {Key: "title", Value: "Water tank"}, {Key: "content", Value: "Cleaning on Friday"}, {Key: "category", Value: "MAINTENANCE"},
					{Key: "isUrgent", Value: true}, {Key: "targetAudience", Value: "RESIDENTS"}, {Key: "publishedAt", Value: now.Add(-2 * day)}, {Key: "createdAt", Value: now.Add(-2 * day)}, {Key: "updatedAt", Value: now.Add(-2 * day)}},
				bson.D{{Key: "_id", Value: gid(2, 0x41)}, {Key: "hostelId", Value: OpsHostelA}, {Key: "title", Value: "Quiet hours"}, {Key: "content", Value: "After ten"}, {Key: "category", Value: "RULE"},
					{Key: "isUrgent", Value: false}, {Key: "targetAudience", Value: "ALL"}, {Key: "publishedAt", Value: now.Add(-day)}, {Key: "createdAt", Value: now.Add(-day)}, {Key: "updatedAt", Value: now.Add(-day)}},
				bson.D{{Key: "_id", Value: gid(2, 0x42)}, {Key: "hostelId", Value: OpsHostelB}, {Key: "title", Value: "Other hostel"}, {Key: "content", Value: "Not yours"}, {Key: "category", Value: "GENERAL"},
					{Key: "isUrgent", Value: false}, {Key: "targetAudience", Value: "ALL"}, {Key: "publishedAt", Value: now.Add(-day)}, {Key: "createdAt", Value: now.Add(-day)}, {Key: "updatedAt", Value: now.Add(-day)}},
			},
		})
	}
}
