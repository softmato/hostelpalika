package fixture

import (
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
)

// PersonalKey is PERSONAL_DATA_ENCRYPTION_KEY for the contract run.
const PersonalKey = "0000000000000000000000000000000000000000000000000000000000000001"

// Join-link people. Each has an account and, but for JoinNoCard, an ID card.
var (
	JoinReady    = oid("50") // card ready, lives nowhere
	JoinNoCard   = oid("51")
	JoinPrivate  = oid("52") // sharing switched off
	JoinElsewere = oid("53") // lives in HostelCheap
	JoinHere     = oid("54") // lives in HostelPublished
	JoinPhone    = oid("55") // phone already used by a resident here
	JoinOneName  = oid("56") // card name has one word
	JoinReturned = oid("57") // a request sent back
	JoinBusy     = oid("58") // staff are adding them
	JoinAgain    = oid("59") // added once, moved out since
)

func cardUser(id bson.ObjectID, email, name, cardID string, now time.Time) d {
	row := ownerUser(id, email, name, HostelPublished, now)
	for i := range row {
		switch row[i].Key {
		case "role":
			row[i].Value = "PUBLIC"
		case "hostelIds":
			row[i].Value = bson.A{}
		}
	}
	if cardID != "" {
		row = append(row[:len(row)-1], e{Key: "userResidentId", Value: cardID}, row[len(row)-1])
	}
	return row
}

func cardProfile(userID bson.ObjectID, fullName, email, phone string, sharing bool, now time.Time) d {
	raw, _ := json.Marshal(map[string]any{"fullName": fullName, "primaryEmail": email, "primaryPhone": phone})
	p, _ := crypto.NewPersonal(PersonalKey)
	blob, _ := p.Encrypt(raw)
	return d{{Key: "_id", Value: bson.NewObjectID()}, {Key: "userId", Value: userID}, {Key: "encryptedData", Value: blob}, {Key: "payloadVersion", Value: 1},
		{Key: "completedAt", Value: fixedAt}, {Key: "photoAssetId", Value: oid("d2")}, {Key: "photoUpdatedAt", Value: fixedAt}, {Key: "shareCount", Value: 0},
		{Key: "sharingEnabled", Value: sharing}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}
}

func resident(id, hostel bson.ObjectID, email, phone, first, last string, user any) d {
	return d{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "userId", Value: user}, {Key: "email", Value: email}, {Key: "phone", Value: phone},
		{Key: "firstName", Value: first}, {Key: "lastName", Value: last}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false},
		{Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}
}

func application(id, user bson.ObjectID, status string, extra ...e) d {
	row := d{{Key: "_id", Value: id}, {Key: "hostelId", Value: HostelPublished}, {Key: "linkId", Value: oid("c9")}, {Key: "userId", Value: user}, {Key: "cardId", Value: "HPR-CARD"},
		{Key: "fullName", Value: "Some Person"}, {Key: "phone", Value: "9833333333"}, {Key: "email", Value: "person@contract.test"}, {Key: "roomType", Value: "Single"},
		{Key: "paidTill", Value: "2083-01"}, {Key: "partPaid", Value: 0}, {Key: "depositPaid", Value: 0}, {Key: "joinedDate", Value: nil}, {Key: "note", Value: ""},
		{Key: "status", Value: status}, {Key: "rejectReason", Value: ""}, {Key: "sends", Value: 1}, {Key: "sentAt", Value: fixedAt}, {Key: "decidedAt", Value: nil}, {Key: "residentId", Value: nil},
		{Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}
	for _, x := range extra {
		for i := range row {
			if row[i].Key == x.Key {
				row[i].Value = x.Value
			}
		}
	}
	return row
}

func link(id, hostel bson.ObjectID, token string, enabled bool, cap, used int) d {
	return d{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "token", Value: token}, {Key: "enabled", Value: enabled}, {Key: "cap", Value: cap}, {Key: "used", Value: used},
		{Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}
}

// joinDocs is the join link's world.
func joinDocs(now time.Time) map[string][]any {
	// Two unpublished hostels, one with its link switched off and one full.
	rooms := e{Key: "roomConfigurations", Value: bson.A{d{{Key: "_id", Value: oid("43")}, {Key: "roomType", Value: "Single"}, {Key: "bedsPerRoom", Value: 1}, {Key: "rooms", Value: 2}, {Key: "monthlyRent", Value: 7000}, {Key: "vacantBeds", Value: 2}}}}
	return map[string][]any{
		"hostels": {
			hostelRow(oid("1d"), OwnerCheap, "Join Off Hostel", "join-off-hostel", "Kalanki", 7000, 7000, now, e{Key: "status", Value: "DRAFT"}, rooms),
			hostelRow(oid("1e"), OwnerCheap, "Join Full Hostel", "join-full-hostel", "Kalanki", 7000, 7000, now, e{Key: "status", Value: "DRAFT"}, rooms),
			// An application filed through the old form, and a quick sign-up that stopped half way.
			hostelRow(oid("1f"), JoinElsewere, "Filed Hostel", "filed-hostel", "Kalanki", 7000, 7000, now, e{Key: "status", Value: "PENDING_APPROVAL"}),
			hostelRow(oid("20"), JoinHere, "Half Done Hostel", "half-done-hostel", "Kalanki", 7000, 7000, now, e{Key: "status", Value: "DRAFT"},
				e{Key: "kyc", Value: d{{Key: "required", Value: true}, {Key: "status", Value: "DRAFT"}}}),
		},
		"users": {
			cardUser(JoinReady, "joiner@contract.test", "Joy Joiner", "HPR-READY01", now),
			cardUser(JoinNoCard, "nocard@contract.test", "No Card", "", now),
			cardUser(JoinPrivate, "private@contract.test", "Pia Private", "HPR-PRIV001", now),
			cardUser(JoinElsewere, "living@contract.test", "Lee Living", "HPR-LIVE001", now),
			cardUser(JoinHere, "here@contract.test", "Hana Here", "HPR-HERE001", now),
			cardUser(JoinPhone, "phone@contract.test", "Pho Ne", "HPR-PHON001", now),
			cardUser(JoinOneName, "cher@contract.test", "Cher", "HPR-ONE0001", now),
			cardUser(JoinReturned, "returned@contract.test", "Rita Returned", "HPR-RETN001", now),
			cardUser(JoinBusy, "busy@contract.test", "Bo Busy", "HPR-BUSY001", now),
			cardUser(JoinAgain, "again@contract.test", "Ann Again", "HPR-AGAN001", now),
		},
		"userresidentprofiles": {
			cardProfile(JoinReady, "Joy Joiner", "joiner@contract.test", "9811111111", true, now),
			cardProfile(JoinPrivate, "Pia Private", "private@contract.test", "9811111112", false, now),
			cardProfile(JoinElsewere, "Lee Living", "living@contract.test", "9811111113", true, now),
			cardProfile(JoinHere, "Hana Here", "here@contract.test", "9811111114", true, now),
			cardProfile(JoinPhone, "Pho Ne", "phone@contract.test", "9822222222", true, now),
			cardProfile(JoinOneName, "Cher", "cher@contract.test", "9811111115", true, now),
			cardProfile(JoinReturned, "Rita Returned", "returned@contract.test", "9811111116", true, now),
			cardProfile(JoinBusy, "Bo Busy", "busy@contract.test", "9811111117", true, now),
			cardProfile(JoinAgain, "Ann Again", "again@contract.test", "9811111118", true, now),
		},
		"residents": {
			resident(oid("1a"), HostelPublished, "taken@contract.test", "9822222222", "Tara", "Taken", nil),
			resident(oid("1b"), HostelCheap, "living@contract.test", "9844444444", "Lee", "Living", JoinElsewere),
			resident(oid("1c"), HostelPublished, "here@contract.test", "9855555555", "Hana", "Here", JoinHere),
		},
		"referralcodes": {
			d{{Key: "_id", Value: oid("21")}, {Key: "code", Value: "RESREF1"}, {Key: "status", Value: "ACTIVE"}, {Key: "hostelId", Value: HostelPublished}, {Key: "residentId", Value: oid("1c")},
				{Key: "userId", Value: JoinHere}, {Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}},
			d{{Key: "_id", Value: oid("22")}, {Key: "code", Value: "RESOLD1"}, {Key: "status", Value: "INACTIVE"}, {Key: "hostelId", Value: HostelPublished}, {Key: "residentId", Value: oid("1c")},
				{Key: "userId", Value: JoinHere}, {Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}},
		},
		"referrals": {
			d{{Key: "_id", Value: oid("23")}, {Key: "hostelId", Value: HostelPublished}, {Key: "referralCodeId", Value: oid("21")}, {Key: "referrerResidentId", Value: oid("1c")},
				{Key: "name", Value: "Already Referred"}, {Key: "phone", Value: "9877777777"}, {Key: "status", Value: "INQUIRY_CREATED"}, {Key: "converted", Value: false}, {Key: "isDeleted", Value: false},
				{Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}},
			d{{Key: "_id", Value: oid("24")}, {Key: "hostelId", Value: HostelPublished}, {Key: "referralCodeId", Value: oid("21")}, {Key: "referrerResidentId", Value: oid("1c")},
				{Key: "name", Value: "Cancelled Before"}, {Key: "phone", Value: "9866666666"}, {Key: "status", Value: "CANCELLED"}, {Key: "converted", Value: false}, {Key: "isDeleted", Value: false},
				{Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}},
		},
		"residentjoinlinks": {
			link(oid("c9"), HostelPublished, "joinopen0001", true, 20, 2),
			link(oid("ca"), oid("1d"), "joinoff00001", false, 5, 0),
			link(oid("cb"), oid("1e"), "joinfull0001", true, 1, 1),
			link(oid("cc"), oid("fd"), "joingone0001", true, 5, 0),
		},
		"residentapplications": {
			application(oid("c0"), JoinReturned, "REJECTED", e{Key: "rejectReason", Value: "Photo is blurry"}, e{Key: "decidedAt", Value: fixedAt}, e{Key: "fullName", Value: "Rita Returned"}),
			application(oid("c1"), JoinBusy, "PENDING", e{Key: "decidedAt", Value: now}),
			application(oid("c2"), JoinAgain, "ADDED", e{Key: "residentId", Value: oid("1c")}, e{Key: "decidedAt", Value: fixedAt}),
		},
	}
}
