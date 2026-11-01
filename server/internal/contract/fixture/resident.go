package fixture

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// A resident in a hostel with attendance on and a location on file.
var (
	HostelTracked = oid("37")
	UserTracked   = oid("37")
	UserInvitee   = oid("26")

	UserGuardian    = oid("27")
	UserGuardianOff = oid("29")
)

// activationHash is hashActivationCode under the contract access secret.
func activationHash(code string) string { return auth.HashToken(code + ":" + AccessSecret) }

func activation(id bson.ObjectID, code, status string, resident, hostel bson.ObjectID, expires, now time.Time) bson.D {
	return bson.D{{Key: "_id", Value: id}, {Key: "codeHash", Value: activationHash(code)}, {Key: "createdBy", Value: UserAdmin}, {Key: "expiresAt", Value: expires}, {Key: "hostelId", Value: hostel},
		{Key: "residentId", Value: resident}, {Key: "status", Value: status}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}
}

func guardianUser(id bson.ObjectID, email string, now time.Time) bson.D {
	return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: "Guardian"}, {Key: "email", Value: email}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: true}, {Key: "role", Value: "GUARDIAN"}, {Key: "status", Value: "ACTIVE"},
		{Key: "mustChangePassword", Value: false}, {Key: "lockPinFailures", Value: 0}, {Key: "hostelIds", Value: bson.A{HostelKyc}}, {Key: "tokenVersion", Value: 0}, {Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false}, {Key: "authProvider", Value: "LOCAL"}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}
}

func gaccess(id, guardian bson.ObjectID, status string, user *bson.ObjectID, email, token string, expires *time.Time, now time.Time) bson.D {
	d := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "guardianId", Value: guardian}, {Key: "phone", Value: "9811111111"}, {Key: "accessCode", Value: "ABC123"}, {Key: "email", Value: email},
		{Key: "expiresAt", Value: now.Add(24 * time.Hour)}, {Key: "status", Value: status}, {Key: "allowComplaintStatus", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}
	if user != nil {
		d = append(d, bson.E{Key: "userId", Value: *user})
	}
	if token != "" {
		d = append(d, bson.E{Key: "invitationToken", Value: token})
	}
	if expires != nil {
		d = append(d, bson.E{Key: "invitationExpiresAt", Value: *expires})
	}
	return d
}

func ptr[T any](v T) *T { return &v }

func notice(id bson.ObjectID, title, audience string, urgent bool, published time.Time, expires *time.Time, hostel bson.ObjectID, now time.Time) bson.D {
	d := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "title", Value: title}, {Key: "content", Value: title + " body"}, {Key: "category", Value: "GENERAL"},
		{Key: "isUrgent", Value: urgent}, {Key: "targetAudience", Value: audience}, {Key: "publishedAt", Value: published}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}
	if expires != nil {
		d = append(d, bson.E{Key: "expiresAt", Value: *expires})
	}
	return d
}

func asset(id bson.ObjectID, level, kind string, hostel, owner *bson.ObjectID, now time.Time, extra ...bson.E) bson.D {
	d := bson.D{{Key: "_id", Value: id}, {Key: "storageProvider", Value: "CLOUDFLARE_R2"}, {Key: "bucket", Value: "contract"}, {Key: "key", Value: "k/" + id.Hex() + ".png"},
		{Key: "fileName", Value: "a.png"}, {Key: "mimeType", Value: "image/png"}, {Key: "sizeBytes", Value: 10}, {Key: "accessLevel", Value: level},
		{Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "variants", Value: bson.A{}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}
	if kind != "" {
		d = append(d, bson.E{Key: "kind", Value: kind})
	}
	if hostel != nil {
		d = append(d, bson.E{Key: "hostelId", Value: *hostel})
	}
	if owner != nil {
		d = append(d, bson.E{Key: "ownerId", Value: *owner})
	}
	return append(d, extra...)
}

// residentDocs is what the signed-in resident routes read (Phase 5).
func communityPost(id, space string, hostel *bson.ObjectID, author bson.ObjectID, body, visibility, status string, reactions int, at time.Time) bson.D {
	var h any
	if hostel != nil {
		h = *hostel
	}
	return bson.D{{Key: "_id", Value: oid(id)}, {Key: "spaceType", Value: space}, {Key: "hostelId", Value: h}, {Key: "authorId", Value: author}, {Key: "body", Value: body}, {Key: "media", Value: bson.A{}}, {Key: "visibility", Value: visibility},
		{Key: "isAnnouncement", Value: false}, {Key: "status", Value: status}, {Key: "reportCount", Value: 0}, {Key: "commentCount", Value: 2}, {Key: "reactionCount", Value: reactions}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}}
}

func khataEntry(id, status string, decided *time.Time, invoice *bson.ObjectID, at time.Time) bson.D {
	d := bson.D{{Key: "_id", Value: oid(id)}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "itemId", Value: oid("f1")}, {Key: "name", Value: "Noodles"}, {Key: "unitPrice", Value: 40}, {Key: "quantity", Value: 2}, {Key: "amount", Value: 80},
		{Key: "status", Value: status}, {Key: "createdAt", Value: at}}
	if decided != nil {
		d = append(d, bson.E{Key: "decidedAt", Value: *decided})
	}
	if invoice != nil {
		d = append(d, bson.E{Key: "invoiceId", Value: *invoice})
	} else {
		d = append(d, bson.E{Key: "invoiceId", Value: nil})
	}
	return d
}

func stockItem(id, name, kind, unit string, lowAt *float64, active bool) bson.D {
	var low any
	if lowAt != nil {
		low = *lowAt
	}
	return bson.D{{Key: "_id", Value: oid(id)}, {Key: "groupHostelId", Value: HostelKyc}, {Key: "name", Value: name}, {Key: "kind", Value: kind}, {Key: "unit", Value: unit}, {Key: "lowAt", Value: low}, {Key: "active", Value: active}, {Key: "category", Value: "GROCERIES"}}
}

type stockLine struct {
	item, name string
	qty        float64
}

func stockEntry(id, kind, status string, by bson.ObjectID, on, at time.Time, to *bson.ObjectID, lines []stockLine) bson.D {
	rows := bson.A{}
	for _, l := range lines {
		rows = append(rows, bson.D{{Key: "itemId", Value: oid(l.item)}, {Key: "name", Value: l.name}, {Key: "qty", Value: l.qty}, {Key: "unit", Value: "KG"}})
	}
	return bson.D{{Key: "_id", Value: oid(id)}, {Key: "groupHostelId", Value: HostelKyc}, {Key: "hostelId", Value: HostelKyc}, {Key: "kind", Value: kind}, {Key: "status", Value: status}, {Key: "on", Value: on}, {Key: "lines", Value: rows},
		{Key: "recordedBy", Value: by}, {Key: "recordedByName", Value: "Someone"}, {Key: "recordedRole", Value: "COOK"}, {Key: "createdAt", Value: at}}
}

func leftHostel(id, slug, prefix string, parent, owner *bson.ObjectID, purge *time.Time) bson.D {
	d := bson.D{{Key: "_id", Value: oid(id)}, {Key: "name", Value: "Hostel " + slug}, {Key: "slug", Value: slug}, {Key: "isDeleted", Value: id != "79"}, {Key: "referencePrefix", Value: prefix}, {Key: "deletedAt", Value: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}}
	if parent != nil {
		d = append(d, bson.E{Key: "parentHostelId", Value: *parent})
	}
	if owner != nil {
		d = append(d, bson.E{Key: "ownerId", Value: *owner})
	}
	if purge != nil {
		d = append(d, bson.E{Key: "purgeScheduledAt", Value: *purge})
	}
	return d
}

func leaveRequest(id string, hostel, owner bson.ObjectID, status string, hold, files time.Time, extra ...bson.E) bson.D {
	d := bson.D{{Key: "_id", Value: oid(id)}, {Key: "hostelId", Value: hostel}, {Key: "hostelName", Value: "Left Hostel " + id}, {Key: "holdDays", Value: 10}, {Key: "holdUntil", Value: hold}, {Key: "filesUntil", Value: files}, {Key: "ownerId", Value: owner},
		{Key: "reason", Value: "Closing"}, {Key: "requestedAt", Value: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)}, {Key: "requestedBy", Value: owner}, {Key: "status", Value: status}}
	return append(d, extra...)
}

func residentDocs(now time.Time) map[string][]any {
	hour := time.Hour
	fixed := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
	return map[string][]any{
		"expenses": {
			bson.D{{Key: "_id", Value: oid("f3")}, {Key: "hostelId", Value: HostelKyc}, {Key: "spentOn", Value: bs.Today(now)}, {Key: "amount", Value: 1500}, {Key: "category", Value: "GAS"}, {Key: "what", Value: "2 cylinders"}, {Key: "paidBy", Value: "CASH"}, {Key: "payer", Value: "STAFF"},
				{Key: "recordedBy", Value: UserCook}, {Key: "recordedByName", Value: "Cook"}, {Key: "recordedByRole", Value: "COOK"}, {Key: "status", Value: "RECORDED"}, {Key: "clientRequestId", Value: "seen-request-1"}, {Key: "createdAt", Value: fixed}},
			bson.D{{Key: "_id", Value: oid("f4")}, {Key: "hostelId", Value: HostelKyc}, {Key: "spentOn", Value: bs.Today(now)}, {Key: "amount", Value: 900}, {Key: "category", Value: "OTHER"}, {Key: "what", Value: "Not the cook"}, {Key: "paidBy", Value: "ESEWA"}, {Key: "payer", Value: "HOSTEL"},
				{Key: "recordedBy", Value: UserAdmin}, {Key: "recordedByName", Value: "Owner"}, {Key: "recordedByRole", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "RECORDED"}, {Key: "createdAt", Value: fixed}},
			bson.D{{Key: "_id", Value: oid("f5")}, {Key: "hostelId", Value: HostelKyc}, {Key: "spentOn", Value: bs.Today(now)}, {Key: "amount", Value: 300}, {Key: "category", Value: "CUSTOM"}, {Key: "customCategoryId", Value: oid("f6")}, {Key: "paidBy", Value: "CASH"}, {Key: "payer", Value: "STAFF"},
				{Key: "recordedBy", Value: UserCook}, {Key: "recordedByRole", Value: "COOK"}, {Key: "status", Value: "VOID"}, {Key: "voidReason", Value: "Wrong"}, {Key: "voidedAt", Value: fixed}, {Key: "createdAt", Value: fixed}},
			bson.D{{Key: "_id", Value: oid("f0")}, {Key: "hostelId", Value: HostelKyc}, {Key: "spentOn", Value: bs.Today(now)}, {Key: "amount", Value: 700}, {Key: "category", Value: "STAFF_CASH"}, {Key: "cashStatus", Value: "PENDING"}, {Key: "cashTo", Value: bson.D{{Key: "name", Value: "Cook"}, {Key: "userId", Value: UserCook}}}, {Key: "paidBy", Value: "CASH"}, {Key: "payer", Value: "HOSTEL"},
				{Key: "recordedBy", Value: UserAdmin}, {Key: "recordedByName", Value: "Owner"}, {Key: "recordedByRole", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "RECORDED"}, {Key: "createdAt", Value: fixed}},
		},
		"hostelexpensecategories": {
			bson.D{{Key: "_id", Value: oid("f6")}, {Key: "hostelId", Value: HostelKyc}, {Key: "name", Value: "Tea"}, {Key: "hidden", Value: false}},
			bson.D{{Key: "_id", Value: oid("f7")}, {Key: "hostelId", Value: HostelKyc}, {Key: "name", Value: "Secret"}, {Key: "hidden", Value: true}},
		},
		"khataentries": {
			khataEntry("f8", "REQUESTED", nil, nil, fixed),
			khataEntry("f9", "GIVEN", &now, nil, fixed),
			khataEntry("fa", "GIVEN", &fixed, ptr(oid("fb")), fixed),
		},
		"stockitems": {
			stockItem("d1", "Rice", "STORE", "KG", ptr(10.0), true),
			stockItem("d2", "Tomato", "DAILY", "KG", nil, true),
			stockItem("d3", "Oil", "STORE", "LITRE", nil, true),
			stockItem("d4", "Old", "STORE", "KG", nil, false),
			append(stockItem("d5", "Flour", "STORE", "KG", nil, true), bson.E{Key: "packSize", Value: 25}, bson.E{Key: "packUnit", Value: "SACK"}),
		},
		"stockentries": {
			stockEntry("d6", "OPENING", "DONE", UserAdmin, bs.Today(now).AddDate(0, 0, -9), now.Add(-5*hour), nil, []stockLine{{"d1", "Rice", 12.5}, {"d3", "Oil", 3}, {"d5", "Flour", 50}}),
			stockEntry("d7", "USE", "DONE", UserCook, bs.Today(now).AddDate(0, 0, -9), now.Add(-4*hour), nil, []stockLine{{"d3", "Oil", 1}}),
			stockEntry("d8", "USE", "DONE", UserCook, bs.Today(now), now.Add(-3*hour), nil, []stockLine{{"d1", "Rice", 1}}),
			stockEntry("d9", "WASTE", "DONE", UserAdmin, bs.Today(now), now.Add(-2*hour), nil, []stockLine{{"d3", "Oil", 0.5}}),
			stockEntry("da", "USE", "CANCELLED", UserCook, bs.Today(now), now.Add(-1*hour), nil, []stockLine{{"d1", "Rice", 5}}),
			stockEntry("db", "BUY", "DONE", UserCook, bs.Today(now), now.Add(-1*hour), nil, []stockLine{{"d3", "Oil", 1}}),
		},
		"hostelpaymentprofiles": {
			bson.D{{Key: "_id", Value: oid("fc")}, {Key: "hostelId", Value: HostelKyc}, {Key: "displayName", Value: "Contract Hostel Pvt"}, {Key: "paymentInstructions", Value: "Quote the code"}, {Key: "staticQrAssetId", Value: oid("70")},
				{Key: "esewaId", Value: "9800000001"}, {Key: "khaltiId", Value: "9800000002"}, {Key: "bankName", Value: "NIC"}, {Key: "bankAccountName", Value: "Contract"}, {Key: "bankAccountNumber", Value: "0001"},
				{Key: "extraAccounts", Value: bson.A{bson.D{{Key: "kind", Value: "BANK"}, {Key: "number", Value: "0002"}}, bson.D{{Key: "kind", Value: "ESEWA"}, {Key: "number", Value: "9800000003"}}, bson.D{{Key: "kind", Value: "KHALTI"}, {Key: "number", Value: "9800000004"}}}},
				{Key: "gateways", Value: bson.A{bson.D{{Key: "provider", Value: "ESEWA"}, {Key: "merchantCode", Value: "EPAY"}, {Key: "mode", Value: "SANDBOX"}, {Key: "accountKind", Value: "MERCHANT"}, {Key: "enabledAt", Value: now}},
					bson.D{{Key: "provider", Value: "FONEPAY"}, {Key: "merchantCode", Value: "FP"}, {Key: "mode", Value: "LIVE"}, {Key: "accountKind", Value: "PERSONAL"}}}}},
		},
		"creditbalances": {
			bson.D{{Key: "_id", Value: oid("fd")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "amount", Value: 250}},
		},
		"hostelleaverequests": {
			leaveRequest("61", oid("62"), UserPublic, "APPROVED", now.Add(48*hour), now.Add(240*hour), bson.E{Key: "branchIds", Value: bson.A{oid("63")}}, bson.E{Key: "exportSections", Value: bson.A{"residents"}},
				bson.E{Key: "exportFiles", Value: bson.A{bson.D{{Key: "_id", Value: oid("64")}, {Key: "bucket", Value: "contract"}, {Key: "createdAt", Value: fixed}, {Key: "fileName", Value: "left-residents.csv"}, {Key: "key", Value: "k/64.csv"}, {Key: "mimeType", Value: "text/csv"}, {Key: "sizeBytes", Value: 20}},
					bson.D{{Key: "_id", Value: oid("65")}, {Key: "bucket", Value: "contract"}, {Key: "createdAt", Value: fixed}, {Key: "fileName", Value: "left-csv.zip"}, {Key: "key", Value: "k/65.zip"}, {Key: "sizeBytes", Value: 30}},
					bson.D{{Key: "_id", Value: oid("66")}, {Key: "bucket", Value: "contract"}, {Key: "createdAt", Value: fixed}, {Key: "fileName", Value: "left.xlsx"}, {Key: "key", Value: "k/66.xlsx"}, {Key: "sizeBytes", Value: 40}}}},
				bson.E{Key: "keptFiles", Value: bson.A{bson.D{{Key: "_id", Value: oid("67")}, {Key: "bucket", Value: "contract"}, {Key: "createdAt", Value: fixed}, {Key: "fileName", Value: "kept.png"}, {Key: "key", Value: "k/67.png"}, {Key: "kind", Value: "PAYMENT_PROOF"}, {Key: "sizeBytes", Value: 50}}}},
				bson.E{Key: "ownerEmail", Value: "public@contract.test"}, bson.E{Key: "ownerName", Value: "Owner"}, bson.E{Key: "zipDownloads", Value: bson.A{bson.D{{Key: "at", Value: now}, {Key: "part", Value: 1}}}}),
			leaveRequest("68", oid("69"), UserPublic, "APPROVED", now.Add(-24*hour), now.Add(240*hour), bson.E{Key: "exportSections", Value: bson.A{"rooms"}}),
			leaveRequest("6a", oid("62"), UserAdmin, "APPROVED", now.Add(48*hour), now.Add(240*hour)),
			leaveRequest("6b", oid("6d"), UserPublic, "APPROVED", now.Add(-48*hour), now.Add(-24*hour)),
			leaveRequest("6e", oid("62"), UserPublic, "PENDING", now.Add(48*hour), now.Add(240*hour)),
			leaveRequest("6f", oid("78"), UserPublic, "APPROVED", now.Add(48*hour), now.Add(240*hour)),
		},
		"communityposts": {
			communityPost("c1", "PUBLIC", nil, UserResident, "Public hello #kathmandu #food", "PUBLIC", "VISIBLE", 0, now.Add(-3*hour)),
			communityPost("c2", "HOSTEL", &HostelKyc, UserAdmin, "Hostel only #food", "HOSTEL_ONLY", "VISIBLE", 2, now.Add(-2*hour)),
			communityPost("c3", "PUBLIC", nil, UserAdmin, "Hidden post", "PUBLIC", "HIDDEN", 0, now.Add(-1*hour)),
			communityPost("c4", "HOSTEL", &HostelTracked, UserGuardian, "Other hostel", "HOSTEL_ONLY", "VISIBLE", 0, now.Add(-1*hour)),
		},
		"communitycomments": {
			bson.D{{Key: "_id", Value: oid("c5")}, {Key: "postId", Value: oid("c1")}, {Key: "parentId", Value: nil}, {Key: "score", Value: 1}, {Key: "authorId", Value: UserAdmin}, {Key: "body", Value: "Root"}, {Key: "status", Value: "VISIBLE"}, {Key: "createdAt", Value: now.Add(-2 * hour)}},
			bson.D{{Key: "_id", Value: oid("c6")}, {Key: "postId", Value: oid("c1")}, {Key: "parentId", Value: oid("c5")}, {Key: "score", Value: 0}, {Key: "authorId", Value: UserResident}, {Key: "body", Value: "Reply"}, {Key: "status", Value: "VISIBLE"}, {Key: "createdAt", Value: now.Add(-1 * hour)}},
			bson.D{{Key: "_id", Value: oid("c7")}, {Key: "postId", Value: oid("c1")}, {Key: "parentId", Value: nil}, {Key: "score", Value: 0}, {Key: "authorId", Value: UserAdmin}, {Key: "body", Value: "Gone"}, {Key: "status", Value: "HIDDEN"}, {Key: "createdAt", Value: now.Add(-1 * hour)}},
		},
		"communityreactions": {
			bson.D{{Key: "_id", Value: oid("c8")}, {Key: "postId", Value: oid("c2")}, {Key: "userId", Value: UserResident}, {Key: "hostelId", Value: HostelKyc}, {Key: "type", Value: "LOVE"}, {Key: "createdAt", Value: now}},
		},
		"sponsors": {
			bson.D{{Key: "_id", Value: oid("c9")}, {Key: "name", Value: "Acme"}, {Key: "tagline", Value: "Best"}, {Key: "linkUrl", Value: "https://acme.example"}, {Key: "isActive", Value: true}, {Key: "priority", Value: 1}, {Key: "clickCount", Value: 0}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}},
		},
		"notifications": {
			bson.D{{Key: "_id", Value: oid("96")}, {Key: "userId", Value: oid("e7")}, {Key: "title", Value: "Tonight?"}, {Key: "body", Value: "Answer"}, {Key: "category", Value: "NIGHT_STATUS"},
				{Key: "kind", Value: "ACTION"}, {Key: "actionState", Value: "PENDING"}, {Key: "channel", Value: "IN_APP"}, {Key: "status", Value: "SENT"},
				{Key: "data", Value: bson.D{{Key: "night", Value: bs.NightKey(now)}}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}},
			bson.D{{Key: "_id", Value: oid("91")}, {Key: "userId", Value: UserResident}, {Key: "hostelId", Value: HostelKyc}, {Key: "title", Value: "Rent due"},
				{Key: "body", Value: "Pay soon"}, {Key: "category", Value: "BILLING"}, {Key: "kind", Value: "NORMAL"}, {Key: "actionState", Value: "PENDING"},
				{Key: "channel", Value: "IN_APP"}, {Key: "data", Value: bson.D{{Key: "z", Value: 1}, {Key: "a", Value: "x"}}}, {Key: "priority", Value: "HIGH"},
				{Key: "status", Value: "SENT"}, {Key: "createdAt", Value: now.Add(-1 * hour)}, {Key: "updatedAt", Value: now.Add(-1 * hour)}, {Key: "__v", Value: 0}},
			bson.D{{Key: "_id", Value: oid("92")}, {Key: "userId", Value: UserResident}, {Key: "title", Value: "Night?"}, {Key: "body", Value: "Answer"},
				{Key: "category", Value: "NIGHT_STATUS"}, {Key: "kind", Value: "ACTION"}, {Key: "actionUrl", Value: "/resident/night"},
				{Key: "actions", Value: bson.A{bson.D{{Key: "endpoint", Value: "/x"}, {Key: "key", Value: "IN"}, {Key: "label", Value: "In"}, {Key: "method", Value: "POST"}, {Key: "tone", Value: "default"}}}},
				{Key: "actionState", Value: "PENDING"}, {Key: "channel", Value: "IN_APP"}, {Key: "status", Value: "SENT"},
				{Key: "createdAt", Value: now.Add(-2 * hour)}, {Key: "updatedAt", Value: now.Add(-2 * hour)}, {Key: "__v", Value: 0}},
			bson.D{{Key: "_id", Value: oid("93")}, {Key: "userId", Value: UserResident}, {Key: "title", Value: "Old"}, {Key: "body", Value: "Read"},
				{Key: "category", Value: "NOTICE"}, {Key: "channel", Value: "IN_APP"}, {Key: "status", Value: "SENT"}, {Key: "readAt", Value: now.Add(-3 * hour)},
				{Key: "createdAt", Value: now.Add(-3 * hour)}, {Key: "updatedAt", Value: now.Add(-3 * hour)}, {Key: "__v", Value: 0}},
			bson.D{{Key: "_id", Value: oid("94")}, {Key: "userId", Value: UserAdmin}, {Key: "title", Value: "Not yours"}, {Key: "body", Value: "Admin"},
				{Key: "category", Value: "NOTICE"}, {Key: "channel", Value: "IN_APP"}, {Key: "status", Value: "SENT"},
				{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}},
		},
		"fileassets": {
			asset(oid("70"), "PRIVATE", "PAYMENT_PROOF", &HostelKyc, &UserResident, now),
			asset(oid("7e"), "PRIVATE", "EXPENSE_RECEIPT", &HostelKyc, &UserCook, now),
			asset(oid("e3"), "PRIVATE", "PAYMENT_PROOF", &HostelKyc, &UserResident, now, bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "contentHash", Value: "hash-e3"}, bson.E{Key: "imageInsight", Value: bson.D{{Key: "width", Value: 800}, {Key: "height", Value: 1600}, {Key: "nearBlank", Value: false}}},
				bson.E{Key: "provenance", Value: bson.D{{Key: "editorSignature", Value: "Photoshop"}, {Key: "quantTablesStandard", Value: false}, {Key: "hasCameraExif", Value: true}, {Key: "screenshotShape", Value: false}}}),
			asset(oid("e4"), "PRIVATE", "PAYMENT_PROOF", &HostelKyc, &UserResident, now, bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "contentHash", Value: "hash-e4"}, bson.E{Key: "imageInsight", Value: bson.D{{Key: "width", Value: 800}, {Key: "height", Value: 1600}, {Key: "nearBlank", Value: true}}}),
			asset(oid("e5"), "PRIVATE", "PAYMENT_PROOF", &HostelKyc, &UserResident, now, bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "systemDocumentKind", Value: "STATEMENT"}),
			asset(oid("e6"), "PRIVATE", "PAYMENT_PROOF", &HostelKyc, &UserResident, now, bson.E{Key: "uploadCompletedAt", Value: now.Add(-400 * hour)}),
			asset(oid("e7"), "PRIVATE", "PAYMENT_PROOF", &HostelKyc, &UserResident, now, bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "contentHash", Value: "hash-e7"}),
			asset(oid("3e"), "PRIVATE", "PAYMENT_PROOF", &HostelKyc, &UserResident, now, bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "contentHash", Value: "hash-3e"}),
			asset(oid("3f"), "PRIVATE", "PAYMENT_PROOF", &HostelTracked, &UserResident, now, bson.E{Key: "uploadCompletedAt", Value: now}),
			asset(oid("7f"), "PRIVATE", "EXPENSE_RECEIPT", &HostelKyc, &UserCook, now, bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "contentHash", Value: "hash-dd"}),
			asset(oid("71"), "PRIVATE", "GENERIC", &HostelKyc, &UserAdmin, now),
			asset(oid("72"), "PRIVATE", "", nil, &UserAdmin, now),
			asset(oid("73"), "PUBLIC", "GENERIC", nil, &UserResident, now, bson.E{Key: "contentHash", Value: "abc"}, bson.E{Key: "uploadCompletedAt", Value: now}),
			asset(oid("74"), "PRIVATE", "MAINTENANCE_NOTE", &HostelKyc, &UserAdmin, now),
		},
		"hostels": {
			leftHostel("62", "left-main", "LFT", nil, &UserPublic, nil),
			leftHostel("63", "left-branch", "", ptr(oid("62")), &UserPublic, nil),
			leftHostel("69", "left-past-hold", "", nil, &UserPublic, nil),
			leftHostel("78", "left-purge-due", "", nil, &UserPublic, ptr(now.Add(-hour))),
			leftHostel("79", "taken-slug-holder", "LFX", nil, nil, nil),
			bson.D{{Key: "_id", Value: HostelTracked}, {Key: "name", Value: "Tracked Hostel"}, {Key: "slug", Value: "tracked-hostel"}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "location", Value: bson.D{{Key: "lat", Value: 27.7}, {Key: "lng", Value: 85.3}}}},
		},
		"hostelsettings": {
			bson.D{{Key: "_id", Value: oid("37")}, {Key: "hostelId", Value: HostelTracked}, {Key: "attendance", Value: bson.D{{Key: "enabled", Value: true}, {Key: "insideZoneRadiusMeters", Value: 50}, {Key: "nearbyZoneRadiusMeters", Value: 200}}}},
		},
		"users": {
			guardianUser(UserGuardian, "guardian@contract.test", now),
			guardianUser(UserGuardianOff, "offguard@contract.test", now),
			bson.D{{Key: "_id", Value: UserInvitee}, {Key: "name", Value: "Invitee"}, {Key: "email", Value: "invitee@contract.test"}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: true}, {Key: "role", Value: "PUBLIC"}, {Key: "status", Value: "ACTIVE"},
				{Key: "mustChangePassword", Value: false}, {Key: "lockPinFailures", Value: 0}, {Key: "hostelIds", Value: bson.A{}}, {Key: "tokenVersion", Value: 0}, {Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false}, {Key: "authProvider", Value: "LOCAL"}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}},
			bson.D{{Key: "_id", Value: UserTracked}, {Key: "name", Value: "Tracked"}, {Key: "email", Value: "tracked@contract.test"}, {Key: "image", Value: "https://img/t.png"}, {Key: "role", Value: "RESIDENT"}, {Key: "status", Value: "ACTIVE"},
				{Key: "hostelIds", Value: bson.A{HostelTracked}}, {Key: "tokenVersion", Value: 0}, {Key: "isDeleted", Value: false}},
		},
		"qractivations": {
			activation(oid("20"), "DEADBEEF", "PENDING", oid("21"), HostelKyc, now.Add(time.Hour), now),
			activation(oid("22"), "USEDCODE", "USED", oid("21"), HostelKyc, now.Add(time.Hour), now),
			activation(oid("23"), "LATECODE", "PENDING", oid("21"), HostelKyc, now.Add(-time.Hour), now),
			activation(oid("24"), "GONECODE", "PENDING", oid("6f"), HostelKyc, now.Add(time.Hour), now),
		},
		"foodroutines": {
			bson.D{{Key: "_id", Value: oid("10")}, {Key: "hostelId", Value: HostelKyc}, {Key: "meals", Value: func() bson.A {
				out := bson.A{}
				for _, day := range []string{"SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"} {
					out = append(out, bson.D{{Key: "dayOfWeek", Value: day}, {Key: "mealType", Value: "DINNER"}, {Key: "items", Value: bson.A{"Rice", "Dal"}}},
						bson.D{{Key: "dayOfWeek", Value: day}, {Key: "mealType", Value: "BREAKFAST"}, {Key: "items", Value: bson.A{"Tea"}}, {Key: "note", Value: "Hot"}})
				}
				return out
			}()}, {Key: "timings", Value: bson.D{{Key: "BREAKFAST", Value: "07:00"}}}, {Key: "updatedAt", Value: now}},
		},
		"invoices": {
			bson.D{{Key: "_id", Value: oid("11")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "period", Value: "2083-05"}, {Key: "status", Value: "PAID"}, {Key: "totalAmount", Value: 500000}, {Key: "referenceCode", Value: "HP-PAID1"},
				{Key: "dueDate", Value: now.Add(-720 * hour)}, {Key: "lines", Value: bson.A{bson.D{{Key: "amount", Value: 500000}, {Key: "basis", Value: "RENT"}, {Key: "description", Value: "Rent"}}}}, {Key: "createdAt", Value: now.Add(-800 * hour)}},
			bson.D{{Key: "_id", Value: oid("12")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "period", Value: "2083-06"}, {Key: "status", Value: "PARTIAL"}, {Key: "totalAmount", Value: 500000}, {Key: "referenceCode", Value: "HP-PART1"},
				{Key: "dueDate", Value: now.Add(24 * hour)}, {Key: "createdAt", Value: now.Add(-24 * hour)}},
			bson.D{{Key: "_id", Value: oid("13")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "period", Value: nil}, {Key: "status", Value: "OPEN"}, {Key: "totalAmount", Value: 100000}, {Key: "referenceCode", Value: "HP-JOIN1"},
				{Key: "dueDate", Value: now.Add(48 * hour)}, {Key: "createdAt", Value: now.Add(-48 * hour)}},
			bson.D{{Key: "_id", Value: oid("14")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "period", Value: "2083-04"}, {Key: "status", Value: "VOID"}, {Key: "totalAmount", Value: 9}, {Key: "dueDate", Value: now}},
		},
		"invoicebalances": {
			bson.D{{Key: "_id", Value: oid("15")}, {Key: "invoiceId", Value: oid("11")}, {Key: "settledAmount", Value: 500000}},
			bson.D{{Key: "_id", Value: oid("16")}, {Key: "invoiceId", Value: oid("12")}, {Key: "settledAmount", Value: 100000}},
		},
		"paymentevents": {
			bson.D{{Key: "_id", Value: oid("17")}, {Key: "invoiceId", Value: oid("11")}, {Key: "direction", Value: "CREDIT"}, {Key: "status", Value: "SETTLED"}, {Key: "provider", Value: "ESEWA"}, {Key: "settledAt", Value: now.Add(-700 * hour)}},
			bson.D{{Key: "_id", Value: oid("18")}, {Key: "invoiceId", Value: oid("13")}, {Key: "direction", Value: "CREDIT"}, {Key: "status", Value: "PENDING"}, {Key: "provider", Value: "BANK"}},
		},
		"guardianaccesses": {
			gaccess(oid("28"), oid("19"), "USED", &UserGuardian, "guardian@contract.test", "", nil, now),
			gaccess(oid("2a"), oid("2b"), "USED", &UserGuardianOff, "offguard@contract.test", "", nil, now),
			gaccess(oid("2c"), oid("2d"), "ACTIVE", nil, "newguard@contract.test", "invite-token-0000000001", ptr(now.Add(time.Hour)), now),
			gaccess(oid("2e"), oid("2d"), "ACTIVE", nil, "newguard@contract.test", "invite-token-0000000002", ptr(now.Add(-time.Hour)), now),
			gaccess(oid("2f"), oid("2d"), "ACTIVE", nil, "resident@contract.test", "invite-token-0000000003", ptr(now.Add(time.Hour)), now),
		},
		"guardianpermissions": {
			bson.D{{Key: "_id", Value: oid("31")}, {Key: "guardianAccessId", Value: oid("28")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "canViewPayments", Value: true}, {Key: "canViewReceipts", Value: true},
				{Key: "canViewNotices", Value: true}, {Key: "canViewFood", Value: true}, {Key: "canViewSafety", Value: true}, {Key: "canViewComplaintStatus", Value: true}},
		},
		"receipts": {
			bson.D{{Key: "_id", Value: oid("3a")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c2")}, {Key: "amount", Value: 10}, {Key: "issuedAt", Value: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}, {Key: "receiptNumber", Value: "RCP-OTH-2083-05-00001"}},
			bson.D{{Key: "_id", Value: oid("32")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "amount", Value: 500000}, {Key: "issuedAt", Value: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}, {Key: "month", Value: "2083-05"}, {Key: "receiptNumber", Value: "R-2083-0001"}},
		},
		"hostelrooms": {
			bson.D{{Key: "_id", Value: oid("a0")}, {Key: "hostelId", Value: HostelKyc}, {Key: "number", Value: "10"}, {Key: "floor", Value: 1}, {Key: "beds", Value: 2}, {Key: "roomType", Value: "Double Sharing"}, {Key: "isDeleted", Value: false}},
			bson.D{{Key: "_id", Value: oid("a4")}, {Key: "hostelId", Value: HostelKyc}, {Key: "number", Value: "9"}, {Key: "floor", Value: 1}, {Key: "beds", Value: 1}, {Key: "roomType", Value: "Single Room"}, {Key: "isDeleted", Value: false}},
			bson.D{{Key: "_id", Value: oid("a5")}, {Key: "hostelId", Value: HostelKyc}, {Key: "number", Value: "1"}, {Key: "floor", Value: 2}, {Key: "beds", Value: 1}, {Key: "roomType", Value: "Single Room"}, {Key: "isDeleted", Value: false}},
			bson.D{{Key: "_id", Value: oid("a6")}, {Key: "hostelId", Value: HostelSuspended}, {Key: "number", Value: "7"}, {Key: "floor", Value: 1}, {Key: "beds", Value: 1}, {Key: "roomType", Value: "Single Room"}, {Key: "isDeleted", Value: false}},
		},
		"offerperks": {
			bson.D{{Key: "_id", Value: oid("a8")}, {Key: "title", Value: "Half off"}, {Key: "kind", Value: "FEE_OFF"}, {Key: "percentOff", Value: 50}, {Key: "isActive", Value: true}, {Key: "sortOrder", Value: 1}},
		},
		"offerawards": {
			bson.D{{Key: "_id", Value: oid("a9")}, {Key: "residentId", Value: oid("c1")}, {Key: "hostelId", Value: HostelKyc}, {Key: "kind", Value: "FEE_OFF"}, {Key: "percentOff", Value: 50}, {Key: "quarter", Value: "2083-Q2"}, {Key: "status", Value: "APPLIED"},
				{Key: "title", Value: "Half off"}, {Key: "appliedAmount", Value: 25000}, {Key: "appliedInvoiceId", Value: oid("11")}, {Key: "createdAt", Value: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}},
		},
		"referrals": {
			bson.D{{Key: "_id", Value: oid("aa")}, {Key: "hostelId", Value: HostelKyc}, {Key: "referrerResidentId", Value: oid("c1")}, {Key: "referralCodeId", Value: oid("ab")}, {Key: "name", Value: "Friend"}, {Key: "phone", Value: "9800000099"}, {Key: "status", Value: "REWARDED"},
				{Key: "converted", Value: true}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}, {Key: "updatedAt", Value: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}},
		},
		"referralrewards": {
			bson.D{{Key: "_id", Value: oid("ac")}, {Key: "hostelId", Value: HostelKyc}, {Key: "referralId", Value: oid("aa")}, {Key: "referrerResidentId", Value: oid("c1")}, {Key: "amount", Value: 50000}, {Key: "rewardType", Value: "CASH"}, {Key: "status", Value: "APPROVED"}},
		},
		"cookaccounts": {
			bson.D{{Key: "_id", Value: oid("b0")}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: UserCook}, {Key: "kind", Value: "CREDENTIAL"}, {Key: "name", Value: "Kitchen Ram"}, {Key: "loginEmail", Value: "kitchen@cook.local"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: now}},
			bson.D{{Key: "_id", Value: oid("b3")}, {Key: "hostelId", Value: HostelKyc}, {Key: "kind", Value: "INVITE"}, {Key: "name", Value: "Invited Cook"}, {Key: "loginEmail", Value: "cookinvite@contract.test"}, {Key: "status", Value: "INVITED"}, {Key: "invitationToken", Value: "cook-token-00000000001"}, {Key: "invitationExpiresAt", Value: now.Add(hour)}, {Key: "createdAt", Value: now}},
			bson.D{{Key: "_id", Value: oid("b4")}, {Key: "hostelId", Value: HostelKyc}, {Key: "kind", Value: "INVITE"}, {Key: "name", Value: "Late Cook"}, {Key: "loginEmail", Value: "cooklate@contract.test"}, {Key: "status", Value: "INVITED"}, {Key: "invitationToken", Value: "cook-token-00000000002"}, {Key: "invitationExpiresAt", Value: now.Add(-hour)}, {Key: "createdAt", Value: now}},
			bson.D{{Key: "_id", Value: oid("b5")}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: oid("bb")}, {Key: "kind", Value: "CREDENTIAL"}, {Key: "name", Value: "Gone Cook"}, {Key: "historicalName", Value: "Previous Contract cook"}, {Key: "loginEmail", Value: "gone@cook.local"}, {Key: "status", Value: "REMOVED"}, {Key: "createdAt", Value: now}},
		},
		"foodphotos": {
			bson.D{{Key: "_id", Value: oid("b6")}, {Key: "hostelId", Value: HostelKyc}, {Key: "mealType", Value: "LUNCH"}, {Key: "date", Value: time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)}, {Key: "photoAssetId", Value: "photo-1"}, {Key: "uploadedBy", Value: UserCook}, {Key: "uploadedAt", Value: time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)}},
			bson.D{{Key: "_id", Value: oid("b7")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "mealType", Value: "DINNER"}, {Key: "date", Value: time.Date(2026, 9, 1, 14, 0, 0, 0, time.UTC)}, {Key: "photoAssetId", Value: "photo-2"}, {Key: "caption", Value: "Nice"}, {Key: "uploadedBy", Value: UserResident}, {Key: "uploadedAt", Value: time.Date(2026, 9, 1, 14, 0, 0, 0, time.UTC)}},
			bson.D{{Key: "_id", Value: oid("b8")}, {Key: "hostelId", Value: HostelKyc}, {Key: "mealType", Value: "LUNCH"}, {Key: "date", Value: time.Date(2026, 8, 31, 6, 0, 0, 0, time.UTC)}, {Key: "photoAssetId", Value: "photo-3"}, {Key: "uploadedBy", Value: oid("bb")}, {Key: "uploadedAt", Value: time.Date(2026, 8, 31, 6, 0, 0, 0, time.UTC)}},
		},
		"foodreadylogs": {
			bson.D{{Key: "_id", Value: oid("b9")}, {Key: "hostelId", Value: HostelKyc}, {Key: "mealType", Value: "DINNER"}, {Key: "announcedAt", Value: time.Date(2026, 9, 1, 14, 0, 0, 0, time.UTC)}, {Key: "announcedBy", Value: UserCook}, {Key: "message", Value: "Dinner is ready."}, {Key: "notifiedCount", Value: 3}},
		},
		"guardians": {
			bson.D{{Key: "_id", Value: oid("2b")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "firstName", Value: "Off"}, {Key: "lastName", Value: "Guard"}, {Key: "phone", Value: "9811111112"}, {Key: "email", Value: "offguard@contract.test"}, {Key: "relation", Value: "Uncle"}, {Key: "isPrimary", Value: false}, {Key: "createdAt", Value: now.Add(-hour)}},
			bson.D{{Key: "_id", Value: oid("2d")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "firstName", Value: "New"}, {Key: "lastName", Value: "Guard"}, {Key: "phone", Value: "9811111113"}, {Key: "email", Value: "newguard@contract.test"}, {Key: "relation", Value: "Aunt"}, {Key: "isPrimary", Value: false}, {Key: "createdAt", Value: now.Add(-2 * hour)}},
			bson.D{{Key: "_id", Value: oid("19")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "firstName", Value: "Guar"}, {Key: "lastName", Value: "Dian"}, {Key: "phone", Value: "9811111111"}, {Key: "email", Value: "guardian@contract.test"}, {Key: "relation", Value: "Father"}, {Key: "isPrimary", Value: true}, {Key: "createdAt", Value: now}},
		},
		"residents": {
			bson.D{{Key: "_id", Value: oid("21")}, {Key: "hostelId", Value: HostelKyc}, {Key: "firstName", Value: "Code"}, {Key: "lastName", Value: "Holder"}, {Key: "phone", Value: "9800000021"},
				{Key: "roomType", Value: "DOUBLE"}, {Key: "depositAmount", Value: 0}, {Key: "moveInDate", Value: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}, {Key: "status", Value: "PENDING"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}},
			bson.D{{Key: "_id", Value: oid("25")}, {Key: "hostelId", Value: HostelKyc}, {Key: "email", Value: "invitee@contract.test"}, {Key: "firstName", Value: "In"}, {Key: "lastName", Value: "Vitee"}, {Key: "phone", Value: "9800000025"},
				{Key: "roomType", Value: "SINGLE"}, {Key: "paidTill", Value: "2083-05"}, {Key: "depositAmount", Value: 0}, {Key: "moveInDate", Value: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}, {Key: "accountLinkDeclinedAt", Value: nil}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}},
			bson.D{{Key: "_id", Value: oid("38")}, {Key: "hostelId", Value: HostelTracked}, {Key: "userId", Value: UserTracked}, {Key: "firstName", Value: "Track"}, {Key: "lastName", Value: "Ed"},
				{Key: "phone", Value: "9800000078"}, {Key: "roomType", Value: "SINGLE"}, {Key: "depositAmount", Value: 0}, {Key: "moveInDate", Value: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
				{Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}},
			bson.D{{Key: "_id", Value: oid("e8")}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: oid("e7")}, {Key: "firstName", Value: "Night"}, {Key: "lastName", Value: "Owl"},
				{Key: "phone", Value: "9800000077"}, {Key: "roomType", Value: "SINGLE"}, {Key: "depositAmount", Value: 0}, {Key: "moveInDate", Value: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
				{Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}},
		},
		"notices": {
			notice(oid("50"), "Water off", "ALL", true, now.Add(-2*hour), nil, HostelKyc, now),
			notice(oid("51"), "Rules", "RESIDENTS", false, now.Add(-3*hour), nil, HostelKyc, now),
			notice(oid("52"), "Staff only", "STAFF", false, now.Add(-hour), nil, HostelKyc, now),
			notice(oid("53"), "Future", "ALL", false, now.Add(hour), nil, HostelKyc, now),
			notice(oid("54"), "Expired", "ALL", false, now.Add(-hour), ptr(now.Add(-time.Minute)), HostelKyc, now),
			notice(oid("55"), "Other hostel", "ALL", false, now.Add(-hour), nil, HostelSuspended, now),
		},
		"noticereadstatuses": {
			bson.D{{Key: "_id", Value: oid("56")}, {Key: "noticeId", Value: oid("51")}, {Key: "userId", Value: UserResident}, {Key: "readAt", Value: now.Add(-hour)}},
		},
		"complaints": {
			bson.D{{Key: "_id", Value: oid("40")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "title", Value: "Leak"}, {Key: "description", Value: "Tap"}, {Key: "category", Value: "MAINTENANCE"},
				{Key: "isAnonymous", Value: false}, {Key: "clientRequestId", Value: "client-request-1"}, {Key: "status", Value: "RESOLVED"}, {Key: "adminResponse", Value: "Fixed"}, {Key: "slaDueAt", Value: now.Add(-hour)}, {Key: "resolvedAt", Value: now.Add(-hour)},
				{Key: "createdAt", Value: now.Add(-48 * hour)}, {Key: "updatedAt", Value: now.Add(-hour)}},
			bson.D{{Key: "_id", Value: oid("41")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "title", Value: "Late"}, {Key: "category", Value: "OTHER"},
				{Key: "isAnonymous", Value: true}, {Key: "status", Value: "PENDING"}, {Key: "slaDueAt", Value: now.Add(-hour)}, {Key: "createdAt", Value: now.Add(-24 * hour)}, {Key: "updatedAt", Value: now.Add(-24 * hour)}},
			bson.D{{Key: "_id", Value: oid("42")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c2")}, {Key: "title", Value: "Not yours"}, {Key: "category", Value: "OTHER"},
				{Key: "isAnonymous", Value: false}, {Key: "status", Value: "RESOLVED"}, {Key: "slaDueAt", Value: now.Add(hour)}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}},
		},
		"complaintupdates": {
			bson.D{{Key: "_id", Value: oid("43")}, {Key: "hostelId", Value: HostelKyc}, {Key: "complaintId", Value: oid("40")}, {Key: "actorId", Value: UserAdmin}, {Key: "actorRole", Value: "HOSTEL_ADMIN"}, {Key: "type", Value: "STATUS_CHANGE"},
				{Key: "previousStatus", Value: "PENDING"}, {Key: "nextStatus", Value: "RESOLVED"}, {Key: "createdAt", Value: now.Add(-hour)}},
		},
		"complaintattachments": {
			bson.D{{Key: "_id", Value: oid("44")}, {Key: "hostelId", Value: HostelKyc}, {Key: "complaintId", Value: oid("40")}, {Key: "fileAssetId", Value: "abc"}, {Key: "uploadedBy", Value: UserResident}, {Key: "uploadedAt", Value: now.Add(-hour)}},
		},
		"attendancelogs": {
			bson.D{{Key: "_id", Value: oid("30")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "userId", Value: UserResident}, {Key: "day", Value: time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -2)},
				{Key: "recordedAt", Value: now}, {Key: "zone", Value: "INSIDE"}, {Key: "source", Value: "MOBILE_PING"}},
		},
		"emergencycontacts": {
			bson.D{{Key: "_id", Value: oid("60")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "name", Value: "Second"}, {Key: "phone", Value: "9811"}, {Key: "relation", Value: "Aunt"}, {Key: "isPrimary", Value: false}, {Key: "createdAt", Value: now.Add(-hour)}},
			bson.D{{Key: "_id", Value: oid("61")}, {Key: "hostelId", Value: HostelKyc}, {Key: "residentId", Value: oid("c1")}, {Key: "name", Value: "First"}, {Key: "phone", Value: "9822"}, {Key: "relation", Value: "Mother"}, {Key: "isPrimary", Value: true}, {Key: "createdAt", Value: now}},
		},
		"hostelmembers": {
			bson.D{{Key: "_id", Value: oid("62")}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: UserAdmin}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}},
		},
		"devicetokens": {
			bson.D{{Key: "_id", Value: oid("95")}, {Key: "userId", Value: UserResident}, {Key: "token", Value: "https://push.example/res"}, {Key: "platform", Value: "WEB"},
				{Key: "status", Value: "ACTIVE"}, {Key: "lastSeenAt", Value: now}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}},
		},
	}
}
