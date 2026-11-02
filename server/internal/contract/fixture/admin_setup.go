package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Group 4 (the hostel owner's setup routes). Ids are gid(4, n):
//
//	1 main hostel, 2 owner, 3 warden, 4 branch hostel, 5 other owner (a second hostel, 6)
//	10-19 plan billing rows
var (
	SetupHostel  = gid(4, 1)
	SetupOwner   = gid(4, 2)
	SetupWarden  = gid(4, 3)
	SetupBranch  = gid(4, 4)
	SetupOther   = gid(4, 5)
	SetupOtherHo = gid(4, 6)
)

func setupUser(id bson.ObjectID, email, role string, hostels bson.A, now time.Time) bson.D {
	return bson.D{{Key: "_id", Value: id}, {Key: "name", Value: "Setup " + role}, {Key: "email", Value: email}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: true}, {Key: "emailVerifiedAt", Value: now.Add(-24 * time.Hour)},
		{Key: "authProvider", Value: "LOCAL"}, {Key: "role", Value: role}, {Key: "mustChangePassword", Value: false}, {Key: "lockPinSetAt", Value: nil}, {Key: "lockPinFailures", Value: 0},
		{Key: "tokenVersion", Value: 0}, {Key: "hostelIds", Value: hostels}, {Key: "status", Value: "ACTIVE"}, {Key: "isDemoData", Value: false}, {Key: "isDeleted", Value: false},
		{Key: "createdAt", Value: now.Add(-24 * time.Hour)}, {Key: "updatedAt", Value: now.Add(-24 * time.Hour)}, {Key: "__v", Value: 0}}
}

func init() {
	groupSeeds["admin-setup"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		far := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
		fixed := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
		hostel := func(id bson.ObjectID, name, slug string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "slug", Value: slug}, {Key: "ownerId", Value: SetupOwner}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "status", Value: "ACTIVE"}, {Key: "verificationStatus", Value: "VERIFIED"}, {Key: "suspension", Value: bson.D{{Key: "graceEndsAt", Value: nil}, {Key: "reason", Value: nil}, {Key: "startedAt", Value: nil}}},
				{Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}}
			return append(d, extra...)
		}
		return insertAll(ctx, db, map[string][]any{
			"hostels": {
				hostel(SetupHostel, "Setup Hostel", "setup-hostel"),
				hostel(SetupOtherHo, "Other Setup Hostel", "other-setup-hostel", bson.E{Key: "ownerId", Value: SetupOther}),
			},
			"users": {
				setupUser(SetupOwner, "setup.owner@contract.test", "HOSTEL_ADMIN", bson.A{SetupHostel}, now),
				setupUser(SetupWarden, "setup.warden@contract.test", "WARDEN", bson.A{SetupHostel}, now),
				setupUser(SetupOther, "setup.other@contract.test", "HOSTEL_ADMIN", bson.A{SetupOtherHo}, now),
			},
			"hostelmembers": {
				bson.D{{Key: "_id", Value: gid(4, 7)}, {Key: "hostelId", Value: SetupHostel}, {Key: "userId", Value: SetupOwner}, {Key: "role", Value: "HOSTEL_ADMIN"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}},
				bson.D{{Key: "_id", Value: gid(4, 8)}, {Key: "hostelId", Value: SetupHostel}, {Key: "userId", Value: SetupWarden}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: fixed}},
			},
			"hostelsubscriptions": {
				bson.D{{Key: "_id", Value: gid(4, 10)}, {Key: "hostelId", Value: SetupHostel}, {Key: "status", Value: "ACTIVE"}, {Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"}, {Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1},
					{Key: "monthlyRate", Value: 4900}, {Key: "cycleTotal", Value: 4900}, {Key: "currency", Value: "NPR"}, {Key: "source", Value: "PUBLIC"}, {Key: "lifetime", Value: false},
					{Key: "activatedAt", Value: fixed}, {Key: "currentPeriodEnd", Value: far}, {Key: "dueBy", Value: nil}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}},
				bson.D{{Key: "_id", Value: gid(4, 14)}, {Key: "hostelId", Value: SetupOtherHo}, {Key: "status", Value: "PENDING_SELECTION"}, {Key: "source", Value: "PUBLIC"}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}},
			},
			"subscriptioninvoices": {
				bson.D{{Key: "_id", Value: gid(4, 11)}, {Key: "invoiceNumber", Value: "SUB-0001-0001"}, {Key: "hostelId", Value: SetupHostel}, {Key: "subscriptionId", Value: gid(4, 10)}, {Key: "kind", Value: "PLAN"}, {Key: "lifetime", Value: false},
					{Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"}, {Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1}, {Key: "amount", Value: 4900}, {Key: "currency", Value: "NPR"}, {Key: "status", Value: "PAID"},
					{Key: "issuedAt", Value: fixed}, {Key: "dueAt", Value: nil}, {Key: "source", Value: "PUBLIC"}, {Key: "softmatoInvoiceNo", Value: nil}, {Key: "documentUrl", Value: nil}, {Key: "localInvoiceNo", Value: "LIN-1"},
					{Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}},
				bson.D{{Key: "_id", Value: gid(4, 12)}, {Key: "invoiceNumber", Value: "SUB-0002-0001"}, {Key: "hostelId", Value: SetupHostel}, {Key: "subscriptionId", Value: gid(4, 10)}, {Key: "kind", Value: "PLAN"}, {Key: "lifetime", Value: false},
					{Key: "planId", Value: "pro"}, {Key: "planName", Value: "Pro"}, {Key: "cycle", Value: "monthly"}, {Key: "cycleMonths", Value: 1}, {Key: "amount", Value: 4900}, {Key: "currency", Value: "NPR"}, {Key: "status", Value: "PARTIAL"},
					{Key: "issuedAt", Value: fixed}, {Key: "dueAt", Value: far}, {Key: "source", Value: "PUBLIC"}, {Key: "softmatoInvoiceNo", Value: nil}, {Key: "documentUrl", Value: nil},
					{Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}},
			},
			"subscriptionpayments": {
				bson.D{{Key: "_id", Value: gid(4, 13)}, {Key: "invoiceId", Value: gid(4, 11)}, {Key: "hostelId", Value: SetupHostel}, {Key: "subscriptionId", Value: gid(4, 10)}, {Key: "amount", Value: 4900}, {Key: "currency", Value: "NPR"},
					{Key: "method", Value: "CASH"}, {Key: "status", Value: "SETTLED"}, {Key: "settledAt", Value: fixed}, {Key: "receiptNumber", Value: "SRC-0001-0001"}, {Key: "isMocked", Value: false},
					{Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}},
				bson.D{{Key: "_id", Value: gid(4, 15)}, {Key: "invoiceId", Value: gid(4, 12)}, {Key: "hostelId", Value: SetupHostel}, {Key: "subscriptionId", Value: gid(4, 10)}, {Key: "amount", Value: 1000}, {Key: "currency", Value: "NPR"},
					{Key: "method", Value: "CASH"}, {Key: "status", Value: "SETTLED"}, {Key: "settledAt", Value: fixed}, {Key: "receiptNumber", Value: "SRC-0002-0001"}, {Key: "isMocked", Value: false},
					{Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}},
				bson.D{{Key: "_id", Value: gid(4, 16)}, {Key: "invoiceId", Value: gid(4, 12)}, {Key: "hostelId", Value: SetupHostel}, {Key: "subscriptionId", Value: gid(4, 10)}, {Key: "amount", Value: 3900}, {Key: "currency", Value: "NPR"},
					{Key: "method", Value: "SOFTMATO"}, {Key: "status", Value: "PENDING"}, {Key: "isMocked", Value: false}, {Key: "createdAt", Value: fixed}, {Key: "updatedAt", Value: fixed}, {Key: "__v", Value: 0}},
			},
		})
	}
}
