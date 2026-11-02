package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// Group 3 (testdata/contract/admin-stock): stock, expenses, wardens, reports, referrals.
//
//	hostel   2 the group's main hostel (no KYC lock) · 1 its branch
//	users   10 warden with stock + expenses · 11 stock only · 12 expenses only · 13 stock + expenses + approve counts
//	member  20-23 their grants in HostelKyc
//	item    30 rice (store, packed) · 31 daal · 32 spinach (daily) · 33 gas · 34 switched off
//	supplier 40 Local Store (owes 1000 before) · 41 switched off
//	entry   50 opening rice · 51 bought daal on credit · 52 rice used · 53 rice sent to the branch, waiting
//	        54 count waiting for approval (by 11) · 55 cancelled use · 56 spinach bought
//	expense 60 the credit bill's paid part · 61 a payment to the supplier · 62 a warden's own spend
//	        63 cash to a warden, accepted · 64 cash to a warden, waiting · 65 spend by warden 12
//	payment 70 · category 80 · file asset 90 (owner's) · 91 (warden 10's)
func init() {
	groupSeeds["admin-stock"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		today := bs.Today(now)
		// Fixed instants, so a recording and a replay agree on every seeded timestamp.
		start := time.Date(2026, 10, 20, 6, 0, 0, 0, time.UTC)
		ago := func(h int) time.Time { return start.Add(-time.Duration(h) * time.Hour) }
		hostel := gid(3, 2)
		branch := gid(3, 1)
		warden := func(n int, email string, perms ...string) []bson.D {
			p := bson.A{}
			for _, x := range perms {
				p = append(p, x)
			}
			return []bson.D{
				{{Key: "_id", Value: gid(3, n)}, {Key: "name", Value: "Warden " + email}, {Key: "email", Value: email + "@contract.test"}, {Key: "emailVerified", Value: true}, {Key: "role", Value: "WARDEN"},
					{Key: "status", Value: "ACTIVE"}, {Key: "hostelIds", Value: bson.A{hostel}}, {Key: "authProvider", Value: "LOCAL"}, {Key: "tokenVersion", Value: 0}, {Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false},
					{Key: "mustChangePassword", Value: false}, {Key: "createdAt", Value: ago(48)}, {Key: "updatedAt", Value: ago(48)}, {Key: "__v", Value: 0}},
				{{Key: "_id", Value: gid(3, n+10)}, {Key: "hostelId", Value: hostel}, {Key: "userId", Value: gid(3, n)}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}, {Key: "permissions", Value: p},
					{Key: "isDeleted", Value: false}, {Key: "createdAt", Value: ago(48)}, {Key: "updatedAt", Value: ago(48)}, {Key: "__v", Value: 0}},
			}
		}
		var users, members []any
		for _, w := range [][]any{{10, "w10", []string{"manageStock", "recordExpenses"}}, {11, "w11", []string{"manageStock"}}, {12, "w12", []string{"recordExpenses"}}, {13, "w13", []string{"manageStock", "recordExpenses", "approveStockCount"}}} {
			rows := warden(w[0].(int), w[1].(string), w[2].([]string)...)
			users = append(users, rows[0])
			members = append(members, rows[1])
		}
		item := func(n int, name, kind, unit, category string, lowAt any, packSize any, packUnit any, active bool) bson.D {
			return bson.D{{Key: "_id", Value: gid(3, n)}, {Key: "groupHostelId", Value: hostel}, {Key: "name", Value: name}, {Key: "kind", Value: kind}, {Key: "unit", Value: unit}, {Key: "category", Value: category},
				{Key: "packSize", Value: packSize}, {Key: "packUnit", Value: packUnit}, {Key: "lowAt", Value: lowAt}, {Key: "active", Value: active}, {Key: "createdBy", Value: UserAdmin},
				{Key: "createdAt", Value: ago(72)}, {Key: "updatedAt", Value: ago(72)}, {Key: "__v", Value: 0}}
		}
		line := func(item int, name, unit string, qty float64, rate any, system any) bson.D {
			return bson.D{{Key: "itemId", Value: gid(3, item)}, {Key: "name", Value: name}, {Key: "unit", Value: unit}, {Key: "qty", Value: qty}, {Key: "systemQty", Value: system}, {Key: "packQty", Value: nil}, {Key: "packUnit", Value: nil}, {Key: "receivedQty", Value: nil}, {Key: "rate", Value: rate}}
		}
		entry := func(n int, kind, status string, h bson.ObjectID, by bson.ObjectID, byName, role string, hoursAgo int, lines bson.A, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(3, n)}, {Key: "groupHostelId", Value: hostel}, {Key: "kind", Value: kind}, {Key: "hostelId", Value: h}, {Key: "toHostelId", Value: nil}, {Key: "on", Value: today}, {Key: "lines", Value: lines},
				{Key: "supplierId", Value: nil}, {Key: "photoAssetId", Value: nil}, {Key: "discount", Value: 0}, {Key: "tax", Value: 0}, {Key: "total", Value: nil}, {Key: "paid", Value: nil}, {Key: "useFor", Value: nil}, {Key: "wasteReason", Value: nil},
				{Key: "status", Value: status}, {Key: "expenseId", Value: nil}, {Key: "amount", Value: nil}, {Key: "recordedBy", Value: by}, {Key: "recordedByName", Value: byName}, {Key: "recordedRole", Value: role}, {Key: "clientRequestId", Value: nil}}
			d = override(d, extra)
			return append(d, bson.E{Key: "createdAt", Value: ago(hoursAgo)}, bson.E{Key: "updatedAt", Value: ago(hoursAgo)}, bson.E{Key: "__v", Value: 0})
		}
		expense := func(n, amount int, category, what, payer, role string, by bson.ObjectID, byName string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(3, n)}, {Key: "hostelId", Value: hostel}, {Key: "spentOn", Value: today}, {Key: "amount", Value: amount}, {Key: "category", Value: category}, {Key: "customCategoryId", Value: nil},
				{Key: "what", Value: what}, {Key: "paidBy", Value: "CASH"}, {Key: "payer", Value: payer}, {Key: "photoAssetId", Value: nil}, {Key: "recordedBy", Value: by}, {Key: "recordedByName", Value: byName}, {Key: "recordedByRole", Value: role},
				{Key: "source", Value: "MANUAL"}, {Key: "status", Value: "RECORDED"}, {Key: "cashTo", Value: nil}, {Key: "cashStatus", Value: nil}, {Key: "salaryFor", Value: nil}, {Key: "clientRequestId", Value: nil}}
			d = override(d, extra)
			return append(d, bson.E{Key: "createdAt", Value: ago(n % 7)}, bson.E{Key: "updatedAt", Value: ago(n % 7)}, bson.E{Key: "__v", Value: 0})
		}
		cashTo := func(user int, name string) bson.D {
			return bson.D{{Key: "name", Value: name}, {Key: "userId", Value: gid(3, user)}}
		}
		sent := line(30, "Rice", "KG", 5, nil, nil)
		return insertAll(ctx, db, map[string][]any{
			"residents": {stockResident(gid(3, 3), hostel, "Rita", ago(30)), stockResident(gid(3, 4), hostel, "Ram", ago(30))},
			"hostels": {bson.D{{Key: "_id", Value: hostel}, {Key: "name", Value: "Stock Hostel"}, {Key: "slug", Value: "stock-hostel"}, {Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false}, {Key: "ownerId", Value: UserAdmin},
				{Key: "location", Value: bson.D{{Key: "area", Value: "Thamel"}, {Key: "city", Value: "Kathmandu"}}}, {Key: "createdAt", Value: ago(50)}}, bson.D{{Key: "_id", Value: branch}, {Key: "name", Value: "Contract Branch"}, {Key: "slug", Value: "contract-branch"}, {Key: "parentHostelId", Value: hostel}, {Key: "isDeleted", Value: false},
				{Key: "ownerId", Value: UserAdmin}, {Key: "location", Value: bson.D{{Key: "area", Value: "Baneshwor"}, {Key: "city", Value: "Kathmandu"}}}, {Key: "createdAt", Value: ago(40)}}},
			"users":         users,
			"hostelmembers": members,
			"stockitems": {
				item(30, "Rice", "STORE", "KG", "GROCERIES", 20, 25, "SACK", true),
				item(31, "Daal", "STORE", "KG", "GROCERIES", nil, nil, nil, true),
				item(32, "Spinach", "DAILY", "KG", "VEGETABLES_MEAT", nil, nil, nil, true),
				item(33, "Gas", "STORE", "CYLINDER", "GAS", 1, nil, nil, true),
				item(34, "Old flour", "STORE", "KG", "GROCERIES", nil, nil, nil, false),
			},
			"stocksuppliers": {
				bson.D{{Key: "_id", Value: gid(3, 40)}, {Key: "groupHostelId", Value: hostel}, {Key: "name", Value: "Local Store"}, {Key: "phone", Value: "9800000040"}, {Key: "openingDue", Value: 1000}, {Key: "active", Value: true}, {Key: "createdBy", Value: UserAdmin}, {Key: "createdAt", Value: ago(70)}, {Key: "updatedAt", Value: ago(70)}, {Key: "__v", Value: 0}},
				bson.D{{Key: "_id", Value: gid(3, 41)}, {Key: "groupHostelId", Value: hostel}, {Key: "name", Value: "Closed Shop"}, {Key: "openingDue", Value: 0}, {Key: "active", Value: false}, {Key: "createdBy", Value: UserAdmin}, {Key: "createdAt", Value: ago(70)}, {Key: "updatedAt", Value: ago(70)}, {Key: "__v", Value: 0}},
			},
			"stockentries": {
				entry(50, "OPENING", "DONE", hostel, UserAdmin, "Contract admin", "OWNER", 30, bson.A{line(30, "Rice", "KG", 100, 60, nil)}),
				entry(51, "BUY", "DONE", hostel, UserAdmin, "Contract admin", "OWNER", 20, bson.A{line(31, "Daal", "KG", 20, 100, nil)},
					bson.E{Key: "supplier", Value: "Local Store"}, bson.E{Key: "supplierId", Value: gid(3, 40)}, bson.E{Key: "billNo", Value: "B-17"}, bson.E{Key: "total", Value: 2000}, bson.E{Key: "paid", Value: 1000}, bson.E{Key: "amount", Value: 1000}, bson.E{Key: "expenseId", Value: gid(3, 60)}),
				entry(52, "USE", "DONE", hostel, UserAdmin, "Contract admin", "OWNER", 10, bson.A{line(30, "Rice", "KG", 10, nil, nil)}, bson.E{Key: "useFor", Value: "KITCHEN"}),
				entry(53, "SEND", "PENDING", hostel, UserAdmin, "Contract admin", "OWNER", 8, bson.A{sent}, bson.E{Key: "toHostelId", Value: branch}),
				entry(54, "COUNT", "PENDING", hostel, gid(3, 11), "Warden w11", "WARDEN", 6, bson.A{line(30, "Rice", "KG", 80, nil, 85)}, bson.E{Key: "note", Value: "Spilled"}),
				entry(55, "USE", "CANCELLED", hostel, UserAdmin, "Contract admin", "OWNER", 5, bson.A{line(30, "Rice", "KG", 2, nil, nil)}, bson.E{Key: "useFor", Value: "KITCHEN"}, bson.E{Key: "cancelReason", Value: "Typo"}),
				entry(56, "BUY", "DONE", hostel, gid(3, 10), "Warden w10", "WARDEN", 4, bson.A{line(32, "Spinach", "KG", 6, nil, nil)}),
				entry(57, "USE", "DONE", hostel, gid(3, 11), "Warden w11", "WARDEN", 3, bson.A{line(30, "Rice", "KG", 3, nil, nil)}, bson.E{Key: "useFor", Value: "KITCHEN"}),
			},
			"stockpayments": {bson.D{{Key: "_id", Value: gid(3, 70)}, {Key: "groupHostelId", Value: hostel}, {Key: "hostelId", Value: hostel}, {Key: "supplierId", Value: gid(3, 40)}, {Key: "amount", Value: 500}, {Key: "on", Value: today}, {Key: "paidBy", Value: "CASH"},
				{Key: "entryIds", Value: bson.A{}}, {Key: "expenseId", Value: gid(3, 61)}, {Key: "status", Value: "DONE"}, {Key: "recordedBy", Value: UserAdmin}, {Key: "recordedByName", Value: "Contract admin"}, {Key: "clientRequestId", Value: nil},
				{Key: "createdAt", Value: ago(2)}, {Key: "updatedAt", Value: ago(2)}, {Key: "__v", Value: 0}}},
			"expenses": {
				expense(60, 1000, "GROCERIES", "Local Store: Daal 20 kg", "HOSTEL", "HOSTEL_ADMIN", UserAdmin, "Contract admin"),
				expense(61, 500, "GROCERIES", "Paid Local Store", "HOSTEL", "HOSTEL_ADMIN", UserAdmin, "Contract admin"),
				expense(62, 300, "GAS", "Gas refill", "STAFF", "WARDEN", gid(3, 10), "Warden w10"),
				expense(63, 2000, "STAFF_CASH", "", "HOSTEL", "HOSTEL_ADMIN", UserAdmin, "Contract admin", bson.E{Key: "cashTo", Value: cashTo(10, "Warden w10")}, bson.E{Key: "cashStatus", Value: "ACCEPTED"}),
				expense(64, 500, "STAFF_CASH", "", "HOSTEL", "HOSTEL_ADMIN", UserAdmin, "Contract admin", bson.E{Key: "cashTo", Value: cashTo(10, "Warden w10")}, bson.E{Key: "cashStatus", Value: "PENDING"}),
				expense(65, 120, "CLEANING", "Brooms", "STAFF", "WARDEN", gid(3, 12), "Warden w12"),
			},
			"hostelexpensecategories": {bson.D{{Key: "_id", Value: gid(3, 80)}, {Key: "hostelId", Value: hostel}, {Key: "name", Value: "Pest control"}, {Key: "hidden", Value: false}, {Key: "createdBy", Value: UserAdmin}, {Key: "createdAt", Value: ago(30)}, {Key: "updatedAt", Value: ago(30)}, {Key: "__v", Value: 0}}},
			"fileassets": {
				bson.D{{Key: "_id", Value: gid(3, 90)}, {Key: "ownerId", Value: UserAdmin}, {Key: "hostelId", Value: hostel}, {Key: "kind", Value: "EXPENSE_RECEIPT"}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "uploadCompletedAt", Value: ago(1)}, {Key: "contentHash", Value: "hash-owner-90"}, {Key: "mimeType", Value: "image/jpeg"}, {Key: "bucket", Value: "private"}, {Key: "key", Value: "expense/90.jpg"}, {Key: "createdAt", Value: ago(1)}},
				bson.D{{Key: "_id", Value: gid(3, 91)}, {Key: "ownerId", Value: gid(3, 10)}, {Key: "hostelId", Value: hostel}, {Key: "kind", Value: "EXPENSE_RECEIPT"}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "uploadCompletedAt", Value: ago(1)}, {Key: "contentHash", Value: "hash-w10-91"}, {Key: "mimeType", Value: "image/jpeg"}, {Key: "bucket", Value: "private"}, {Key: "key", Value: "expense/91.jpg"}, {Key: "createdAt", Value: ago(1)}},
			},
		})
	}
}

func stockResident(id, hostel bson.ObjectID, name string, at time.Time) bson.D {
	return bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "firstName", Value: name}, {Key: "lastName", Value: "Stock"}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: at}}
}

// override sets keys the row already has and appends the rest.
func override(d bson.D, extra []bson.E) bson.D {
	for _, e := range extra {
		found := false
		for i := range d {
			if d[i].Key == e.Key {
				d[i].Value, found = e.Value, true
			}
		}
		if !found {
			d = append(d, e)
		}
	}
	return d
}
