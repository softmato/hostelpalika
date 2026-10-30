package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Service-provider people. ProvLegacy has no userId on the provider row, only a
// matching email.
var (
	ProvA       = oid("e8") // approved plumber + electrician
	ProvB       = oid("e9") // approved cleaner
	ProvPending = oid("ea")
	ProvRefused = oid("eb")
	ProvNone    = oid("ec") // never applied
	ProvLegacy  = oid("ed")
	ProvHidden  = oid("f7") // approved once, hidden since
)

func plainUser(id bson.ObjectID, email, name string, now time.Time) d {
	row := ownerUser(id, email, name, HostelPublished, now)
	for i := range row {
		switch row[i].Key {
		case "role":
			row[i].Value = "PUBLIC"
		case "hostelIds":
			row[i].Value = bson.A{}
		}
	}
	return row
}

func providerRow(id bson.ObjectID, user any, name, phone, category string, cats []string, area, status string, now time.Time, extra ...e) d {
	row := d{{Key: "_id", Value: id}, {Key: "fullName", Value: name}, {Key: "phone", Value: phone}}
	if user != nil {
		row = append(row, e{Key: "userId", Value: user})
	}
	row = append(row, e{Key: "email", Value: phone + "@prov.test"}, e{Key: "category", Value: category}, e{Key: "area", Value: area}, e{Key: "city", Value: "Kathmandu"})
	if cats != nil {
		row = append(row, e{Key: "categories", Value: cats})
	}
	row = append(row, e{Key: "ratingSummary", Value: d{{Key: "averageRating", Value: 4.5}, {Key: "totalReviews", Value: 3}}}, e{Key: "status", Value: status},
		e{Key: "isDeleted", Value: false}, e{Key: "createdAt", Value: fixedAt.Add(-48 * time.Hour)}, e{Key: "updatedAt", Value: fixedAt.Add(-24 * time.Hour)}, e{Key: "__v", Value: 0})
	return append(row, extra...)
}

func jobRow(id bson.ObjectID, title, category, status string, now time.Time, ago time.Duration, extra ...e) d {
	row := d{{Key: "_id", Value: id}, {Key: "hostelId", Value: HostelPublished}, {Key: "category", Value: category}, {Key: "title", Value: title}, {Key: "description", Value: title + " needs a look"},
		{Key: "priority", Value: "MEDIUM"}, {Key: "status", Value: status}, {Key: "requestedBy", Value: OwnerPublished}, {Key: "isDeleted", Value: false},
		{Key: "createdAt", Value: fixedAt.Add(-ago)}, {Key: "updatedAt", Value: fixedAt.Add(-ago)}, {Key: "__v", Value: 0}}
	for _, x := range extra {
		set := false
		for i := range row {
			if row[i].Key == x.Key {
				row[i].Value, set = x.Value, true
			}
		}
		if !set {
			row = append(row, x)
		}
	}
	return row
}

func providerDocs(now time.Time) map[string][]any {
	day := 24 * time.Hour
	provA, provB := oid("74"), oid("75")
	return map[string][]any{
		"users": {
			plainUser(ProvA, "prov-a@contract.test", "Prov A", now), plainUser(ProvB, "prov-b@contract.test", "Prov B", now),
			plainUser(ProvPending, "prov-pending@contract.test", "Prov Pending", now), plainUser(ProvRefused, "prov-refused@contract.test", "Prov Refused", now),
			plainUser(ProvNone, "prov-none@contract.test", "Prov None", now), plainUser(ProvLegacy, "9801000005@prov.test", "Prov Legacy", now),
			plainUser(ProvHidden, "prov-hidden@contract.test", "Prov Hidden", now),
		},
		"serviceproviders": {
			providerRow(provA, ProvA, "Ram Plumber", "9801000001", "PLUMBER", []string{"PLUMBER", "ELECTRICIAN"}, "Baneshwor", "APPROVED", now,
				e{Key: "availability", Value: "Mornings"}, e{Key: "description", Value: "Twenty years"}, e{Key: "experience", Value: "20 yrs"}, e{Key: "photoAssetId", Value: oid("7e")}),
			providerRow(provB, ProvB, "Sita Cleaner", "9801000002", "CLEANER", nil, "Koteshwor", "APPROVED", now),
			providerRow(oid("76"), ProvPending, "Hari Painter", "9801000003", "PAINTER", []string{"PAINTER"}, "Baneshwor", "PENDING_APPROVAL", now),
			providerRow(oid("77"), ProvRefused, "Gita Carpenter", "9801000004", "CARPENTER", []string{"CARPENTER"}, "Kalanki", "REJECTED", now, e{Key: "rejectionReason", Value: "Photo unclear"}),
			providerRow(oid("78"), nil, "Legacy Electrician", "9801000005", "ELECTRICIAN", nil, "Baneshwor", "APPROVED", now),
			providerRow(oid("79"), ProvHidden, "Hidden Doctor", "9801000006", "DOCTOR_CLINIC", []string{"DOCTOR_CLINIC"}, "Baneshwor", "HIDDEN", now),
			providerRow(oid("7a"), nil, "Other Town Plumber", "9801000007", "PLUMBER", []string{"PLUMBER"}, "Pokhara Lakeside", "APPROVED", now, e{Key: "city", Value: "Pokhara"}),
		},
		"serviceproviderdocuments": {
			d{{Key: "_id", Value: oid("7c")}, {Key: "providerId", Value: provA}, {Key: "documentType", Value: "Licence"}, {Key: "status", Value: "APPROVED"}, {Key: "isDeleted", Value: false},
				{Key: "createdAt", Value: now.Add(-day)}, {Key: "updatedAt", Value: now.Add(-day)}, {Key: "__v", Value: 0}},
		},
		"maintenancerequests": {
			jobRow(oid("b5"), "Leaking tap", "PLUMBING", "PENDING", now, 2*time.Hour, e{Key: "location", Value: "Room 3"}, e{Key: "minimumCharge", Value: 1500}, e{Key: "voiceNoteAssetId", Value: oid("7f")}),
			jobRow(oid("b6"), "Dead socket", "ELECTRICAL", "PENDING", now, 3*time.Hour, e{Key: "priority", Value: "HIGH"}),
			jobRow(oid("b7"), "Mop the hall", "CLEANING", "PENDING", now, 4*time.Hour),
			jobRow(oid("b8"), "Blocked drain", "PLUMBING", "CONTACTED", now, 5*time.Hour, e{Key: "providerId", Value: provA}, e{Key: "location", Value: "Kitchen"}, e{Key: "priority", Value: "URGENT"},
				e{Key: "scheduledFor", Value: fixedAt.Add(day)}, e{Key: "voiceNoteAssetId", Value: oid("7f")}),
			jobRow(oid("b9"), "Old repair", "PLUMBING", "COMPLETED", now, 30*time.Hour, e{Key: "providerId", Value: provA}, e{Key: "completedAt", Value: now.Add(-day)}),
			jobRow(oid("ba"), "Called off", "ELECTRICAL", "CANCELLED", now, 31*time.Hour, e{Key: "providerId", Value: provA}),
			jobRow(oid("bb"), "Someone else's job", "CLEANING", "CONTACTED", now, 6*time.Hour, e{Key: "providerId", Value: provB}),
			jobRow(oid("bc"), "Second drain", "PLUMBING", "CONTACTED", now, 7*time.Hour, e{Key: "providerId", Value: provA}),
			jobRow(oid("bd"), "Third drain", "PLUMBING", "SCHEDULED", now, 8*time.Hour, e{Key: "providerId", Value: provA}),
			jobRow(oid("be"), "Gone", "PLUMBING", "PENDING", now, 9*time.Hour, e{Key: "isDeleted", Value: true}),
		},
	}
}
