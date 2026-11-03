package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// The field team (group 12): two agents, the KYC hostel filed by the first,
// its setup fee and plan money, a wallet with a payout, the agreement sheet
// and a pending invite.
var (
	UserAgent      = gid(12, 1)
	UserAgentOther = gid(12, 2)
)

func init() {
	groupSeeds["team"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		at := fixedAt
		agent := func(id bson.ObjectID, email, name string) any {
			row := ownerUser(id, email, name, HostelPublished, at)
			for i := range row {
				switch row[i].Key {
				case "role":
					row[i].Value = "PLATFORM_AGENT"
				case "hostelIds":
					row[i].Value = bson.A{}
				}
			}
			return row
		}
		if _, err := db.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: HostelKyc}}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "agentId", Value: UserAgent}, {Key: "source", Value: "TEAM"}, {Key: "status", Value: "ACTIVE"}, {Key: "cycleTotal", Value: 4900},
			{Key: "planName", Value: "Team Plan"}, {Key: "dueBy", Value: at.Add(30 * 24 * time.Hour)}, {Key: "createdAt", Value: at}}}}); err != nil {
			return err
		}
		sub := oid("b1")
		inv := func(id bson.ObjectID, kind, status, number string, amount int) any {
			return d{{Key: "_id", Value: id}, {Key: "subscriptionId", Value: sub}, {Key: "hostelId", Value: HostelKyc}, {Key: "kind", Value: kind}, {Key: "status", Value: status},
				{Key: "invoiceNumber", Value: number}, {Key: "amount", Value: amount}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		pay := func(id, invoice bson.ObjectID, method string, amount int) any {
			return d{{Key: "_id", Value: id}, {Key: "subscriptionId", Value: sub}, {Key: "invoiceId", Value: invoice}, {Key: "hostelId", Value: HostelKyc}, {Key: "method", Value: method},
				{Key: "status", Value: "SETTLED"}, {Key: "amount", Value: amount}, {Key: "collectedBy", Value: UserAgent}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		wallet := func(id bson.ObjectID, typ string, amount float64, extra ...e) any {
			row := d{{Key: "_id", Value: id}, {Key: "agentId", Value: UserAgent}, {Key: "type", Value: typ}, {Key: "amount", Value: amount}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
			return append(row, extra...)
		}
		agreement := func(id bson.ObjectID, seq int, by bson.ObjectID, name string) any {
			return d{{Key: "_id", Value: id}, {Key: "sequence", Value: seq}, {Key: "refCode", Value: agreementCode(seq)}, {Key: "hostelName", Value: name}, {Key: "location", Value: "Baneshwor"},
				{Key: "ownerName", Value: "Ram"}, {Key: "phone", Value: "9800000000"}, {Key: "signedOn", Value: time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)}, {Key: "status", Value: "SIGNED"},
				{Key: "notes", Value: ""}, {Key: "deletedAt", Value: nil}, {Key: "createdBy", Value: by}, {Key: "updatedBy", Value: by}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
		}
		return insertAll(ctx, db, map[string][]any{
			"users":                append(platformStaff(at), agent(UserAgent, "agent@contract.test", "Contract Agent"), agent(UserAgentOther, "agent2@contract.test", "Other Agent")),
			"subscriptioninvoices": {inv(gid(12, 20), "SETUP_FEE", "PAID", "SET-0001", 1000), inv(gid(12, 21), "PLAN", "OPEN", "INV-0001", 4900)},
			"subscriptionpayments": {pay(gid(12, 30), gid(12, 20), "CASH", 1000), pay(gid(12, 31), gid(12, 21), "ESEWA", 900)},
			"teamwalletentries": {wallet(gid(12, 40), "COMMISSION", 100.5, e{Key: "hostelId", Value: HostelKyc}, e{Key: "ratePercent", Value: 10}, e{Key: "base", Value: 1005}),
				wallet(gid(12, 41), "PAYOUT", 30, e{Key: "method", Value: "CASH"}, e{Key: "reference", Value: "R1"})},
			"hostelagreements":          {agreement(gid(12, 50), 1, UserAgent, "Mine Hostel"), agreement(gid(12, 51), 2, UserAgentOther, "Their Hostel")},
			"platformdocumentsequences": {d{{Key: "_id", Value: gid(12, 55)}, {Key: "fiscalYear", Value: "LIFETIME"}, {Key: "kind", Value: "HOSTEL_AGREEMENT"}, {Key: "sequence", Value: 2}}},
			"platformadmininvites": {d{{Key: "_id", Value: gid(12, 60)}, {Key: "email", Value: "new.agent@contract.test"}, {Key: "name", Value: "New Agent"}, {Key: "role", Value: "PLATFORM_AGENT"},
				{Key: "status", Value: "PENDING"}, {Key: "tokenHash", Value: "x"}, {Key: "expiresAt", Value: time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}}},
		})
	}
}

func agreementCode(seq int) string { return "SMT/HP/2026/00" + string(rune('0'+seq)) }
