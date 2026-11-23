package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/financeadmin"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// seed-history: the lived-in hostel (demo-video.md §6). Residents have no login
// and no email, so nothing (the seed or a later production job) can reach them;
// money goes through ledger.Engine with no notifier, so no bell, push or mail.

// seedResident is one desk-registered resident. Joined is 0 for someone living
// here before the history starts, else 1 or 2: the history month they moved in.
type seedResident struct {
	First, Last, Room string
	Joined, JoinDay   int
}

var seedResidents = []seedResident{
	{"Prabin", "Gurung", "001", 0, 0},
	{"Sagar", "Basnet", "002", 0, 0},
	{"Rohan", "Shrestha", "003", 0, 0},
	{"Nischal", "Adhikari", "003", 0, 0},
	{"Bibash", "Maharjan", "004", 0, 0},
	{"Anish", "Tamang", "004", 0, 0},
	{"Kiran", "Bhandari", "004", 0, 0},
	{"Sujan", "Thapa", "103", 0, 0},
	{"Roshan", "KC", "103", 0, 0},
	{"Dipesh", "Rai", "104", 1, 12},
	{"Manish", "Poudel", "104", 2, 10},
}

// seedBeds is what the plan above may use of each room: its beds minus the
// people already living there (Bibek in 002), with 102 kept for R and 101 for R2.
var seedBeds = map[string]int{"001": 1, "002": 1, "003": 2, "004": 3, "103": 2, "104": 3}

func seedPhone(i int) string { return fmt.Sprintf("98000000%02d", 20+i) }

// pay is one payment on one bill: the day of the month, the share of the bill,
// and how it came in. A share above 1 is money paid ahead.
type pay struct {
	day      int
	share    float64
	provider string
}

func providerFor(i, month int) string {
	switch (i + month) % 6 {
	case 0:
		return "ESEWA"
	case 1:
		return "FONEPAY"
	case 3:
		return "BANK"
	}
	return "CASH"
}

// rentPays is the payment story: history months 0 and 1 paid in full; month 2
// (last month) leaves two unpaid and one half paid, the late-fine cases; the
// current month has a few early payers and one who pays two months at once.
func rentPays(i, month, today int) []pay {
	switch {
	case month < 2:
		return []pay{{2 + (i*3)%9, 1, providerFor(i, month)}}
	case month == 2:
		switch i {
		case 3, 7:
			return nil
		case 9:
			return []pay{{6, 0.5, "CASH"}}
		}
		return []pay{{2 + (i*3)%9, 1, providerFor(i, month)}}
	}
	switch i {
	case 0, 1, 2, 4, 5:
		return []pay{{min(today, 1+i%3), 1, providerFor(i, month)}}
	case 6:
		return []pay{{min(today, 2), 2, "CASH"}}
	}
	return nil
}

type expenseLine struct {
	day                    int
	category, what, paidBy string
	amount                 int64
}

func monthExpenses(month int) []expenseLine {
	bump := int64(month * 150)
	return []expenseLine{
		{1, "INTERNET", "WorldLink monthly", "ESEWA", 1500},
		{1, "SALARY", "Cook salary", "BANK", 15000},
		{1, "SALARY", "Cleaner salary", "CASH", 9000},
		{2, "GROCERIES", "Rice 50 kg", "CASH", 4200 + bump},
		{3, "VEGETABLES_MEAT", "Vegetables", "CASH", 1350 + bump},
		{5, "GAS", "Gas cylinder ×2", "CASH", 3800},
		{8, "VEGETABLES_MEAT", "Chicken 8 kg", "CASH", 3200},
		{9, "GROCERIES", "Dal, oil, spices", "ESEWA", 5600 + bump},
		{10, "CLEANING", "Cleaning supplies", "CASH", 1100},
		{12, "ELECTRICITY", "NEA bill", "ESEWA", 6400 + 2*bump},
		{12, "WATER", "Water tanker ×2", "CASH", 2400},
		{13, "VEGETABLES_MEAT", "Vegetables", "CASH", 1500},
		{16, "GROCERIES", "Rice 25 kg, sugar", "CASH", 3900},
		{17, "REPAIR", "Tap and pipe fix", "CASH", 1800 + bump},
		{18, "VEGETABLES_MEAT", "Vegetables and eggs", "FONEPAY", 1650},
		{20, "GAS", "Gas cylinder ×2", "CASH", 3800},
		{23, "GROCERIES", "Oil 15 L, atta", "CASH", 4800},
		{24, "VEGETABLES_MEAT", "Mutton 3 kg", "CASH", 3300},
		{28, "VEGETABLES_MEAT", "Vegetables", "CASH", 1400},
	}
}

// demoCollections is everything a seed row can land in; unseed clears each by mark
// or by a seeded resident.
var demoCollections = []string{"residents", "invoices", "paymentevents", "invoicebalances", "receipts", "creditbalances",
	"khataentries", "rentconcessions", "expenses", "notices", "complaints", "inquiries", "offerawards", "depositrecords", "bookings"}

func (d *demo) seededIDs(ctx context.Context) (bson.A, error) {
	var ids []bson.ObjectID
	err := d.db.Collection("residents").Distinct(ctx, "_id", bson.D{{Key: "hostelId", Value: d.hostel}, {Key: demoMarkey, Value: true}}).Decode(&ids)
	out := bson.A{}
	for _, id := range ids {
		out = append(out, id)
	}
	return out, err
}

func at(day time.Time, hour, minute int) time.Time {
	// day is a Nepal calendar day stored as UTC midnight; hour:minute is Nepal time.
	return day.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute - (5*time.Hour + 45*time.Minute))
}

func (d *demo) seedHistory(ctx context.Context) error {
	if ids, err := d.seededIDs(ctx); err != nil {
		return err
	} else if len(ids) > 0 {
		return fmt.Errorf("already seeded (%d residents); run `dev demo unseed` first", len(ids))
	}
	now := time.Now()
	current, err := bs.PeriodOf(now)
	if err != nil {
		return err
	}
	today, err := bs.DayOfMonth(now)
	if err != nil {
		return err
	}
	periods := make([]string, 4) // three past months, then this one
	bounds := make([]bs.Bounds, 4)
	for m := range periods {
		if periods[m], err = bs.AddMonths(current, m-3); err != nil {
			return err
		}
		if bounds[m], err = bs.PeriodBounds(periods[m]); err != nil {
			return err
		}
	}
	day := func(m, n int) time.Time { return bounds[m].Start.Add(time.Duration(n-1) * 24 * time.Hour) }

	var owner struct {
		Name string `bson:"name"`
	}
	if err := d.db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: d.owner}}).Decode(&owner); err != nil {
		return fmt.Errorf("owner: %w", err)
	}
	rooms, err := d.freeBeds(ctx)
	if err != nil {
		return err
	}
	for room, want := range seedBeds {
		if rooms[room].free < want {
			return fmt.Errorf("room %s has %d free beds, the plan needs %d; nothing written", room, rooms[room].free, want)
		}
	}

	// 1. Residents.
	ids := make([]bson.ObjectID, len(seedResidents))
	moveIn := make([]time.Time, len(seedResidents))
	for i, r := range seedResidents {
		room := rooms[r.Room]
		ids[i] = bson.NewObjectID()
		moveIn[i] = bounds[0].Start.Add(-time.Duration(20+i*9) * 24 * time.Hour)
		if r.Joined > 0 {
			moveIn[i] = day(r.Joined, r.JoinDay)
		}
		created := at(moveIn[i], 10, 0)
		doc := bson.D{{Key: "_id", Value: ids[i]}, {Key: "hostelId", Value: d.hostel}, {Key: "firstName", Value: r.First}, {Key: "lastName", Value: r.Last},
			{Key: "phone", Value: seedPhone(i)}, {Key: "roomType", Value: room.roomType}, {Key: "roomId", Value: room.id}, {Key: "roomNumber", Value: r.Room},
			{Key: "floor", Value: room.floor}, {Key: "bedType", Value: room.bedType}, {Key: "billingCycle", Value: "CALENDAR_MONTH"}, {Key: "residentType", Value: "STUDENT"},
			{Key: "status", Value: "ACTIVE"}, {Key: "moveInDate", Value: moveIn[i]}, {Key: "moveOutDate", Value: nil}, {Key: "stayEndsAt", Value: nil},
			{Key: "monthlyFee", Value: nil}, {Key: "admissionFee", Value: 2000}, {Key: "admissionFeeDiscount", Value: 0}, {Key: "depositAmount", Value: 5000},
			{Key: "paidTill", Value: nil}, {Key: "lastMonthCharge", Value: nil}, {Key: "leavingNoticeAt", Value: nil}, {Key: "leavingOn", Value: nil}, {Key: "leavingReason", Value: nil},
			{Key: "deskIntake", Value: true}, {Key: "detailsData", Value: nil}, {Key: "admissionFormId", Value: nil}, {Key: "existingListId", Value: nil}, {Key: "photoAssetId", Value: nil},
			{Key: "accountLinkDeclinedAt", Value: nil}, {Key: "accountLinkDeclinedBy", Value: nil}, {Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false},
			{Key: "createdBy", Value: d.owner}, {Key: "updatedBy", Value: d.owner}, {Key: "createdAt", Value: created}, {Key: "updatedAt", Value: created}, {Key: "__v", Value: 0},
			{Key: demoMarkey, Value: true}}
		if _, err := d.db.Collection("residents").InsertOne(ctx, doc); err != nil {
			return err
		}
	}
	rs := &hostelrooms.Service{DB: d.db, Cap: &hostelrooms.Capacity{DB: d.db}}
	if err := rs.SyncTypeCounts(ctx, d.hostel); err != nil {
		return fmt.Errorf("room counts: %w", err)
	}
	all := bson.A{}
	for _, id := range ids {
		all = append(all, id)
	}
	e := &ledger.Engine{DB: d.db} // no Notify, Mail or Audit: money only, nobody told
	for _, id := range ids {
		if _, err := e.EnsureResidentPaymentCode(ctx, d.hostel, id, d.prefix); err != nil {
			return fmt.Errorf("payment code: %w", err)
		}
	}
	fmt.Printf("residents: %d added, room counts synced\n", len(ids))

	// 2. Khata given in month 1 lands on month 2's bill; a festival discount on month 1.
	var settings struct {
		Items []struct {
			ID    bson.ObjectID `bson:"_id"`
			Name  string        `bson:"name"`
			Price int64         `bson:"price"`
		} `bson:"khataItems"`
	}
	if err := d.db.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}}).Decode(&settings); err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	for n, k := range []struct{ who, item, qty, day int }{{0, 0, 6, 8}, {2, 1, 2, 14}, {5, 2, 1, 20}, {8, 0, 4, 25}} {
		if k.item >= len(settings.Items) {
			break
		}
		it := settings.Items[k.item]
		when := at(day(1, k.day), 8, 30+n)
		if _, err := d.db.Collection("khataentries").InsertOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "residentId", Value: ids[k.who]}, {Key: "itemId", Value: it.ID},
			{Key: "name", Value: it.Name}, {Key: "unitPrice", Value: it.Price}, {Key: "quantity", Value: k.qty}, {Key: "amount", Value: it.Price * int64(k.qty)}, {Key: "status", Value: "GIVEN"},
			{Key: "decidedAt", Value: when}, {Key: "decidedBy", Value: d.owner}, {Key: "invoiceId", Value: nil}, {Key: "createdAt", Value: when}, {Key: "updatedAt", Value: when}, {Key: "__v", Value: 0},
			{Key: demoMarkey, Value: true}}); err != nil {
			return err
		}
	}
	if _, err := d.db.Collection("rentconcessions").InsertOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "period", Value: periods[1]}, {Key: "percentOff", Value: 10},
		{Key: "reason", Value: "Dashain"}, {Key: "createdBy", Value: d.owner}, {Key: "createdAt", Value: bounds[1].Start}, {Key: "updatedAt", Value: bounds[1].Start}, {Key: "__v", Value: 0},
		{Key: demoMarkey, Value: true}}); err != nil {
		return err
	}

	// 3. Joining bills for the two who moved in during the history, then each month's rent.
	var schedule struct {
		ID bson.ObjectID `bson:"_id"`
	}
	_ = d.db.Collection("feeschedules").FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&schedule)
	type bill struct {
		id                      bson.ObjectID
		resident, month, kindNo int
		issued                  time.Time
	}
	var bills []bill
	for i, r := range seedResidents {
		if r.Joined == 0 {
			continue
		}
		ref, err := e.AllocateReferenceCode(ctx, d.hostel, d.prefix)
		if err != nil {
			return err
		}
		id, issued := bson.NewObjectID(), at(moveIn[i], 10, 5)
		line := func(desc string, amt int) bson.D {
			return bson.D{{Key: "amount", Value: amt}, {Key: "basis", Value: "SCHEDULE"}, {Key: "bedType", Value: nil}, {Key: "description", Value: desc}, {Key: "feeScheduleId", Value: schedule.ID}}
		}
		if _, err := d.db.Collection("invoices").InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: d.hostel}, {Key: "residentId", Value: ids[i]}, {Key: "period", Value: nil},
			{Key: "kind", Value: "ADMISSION_FEE"}, {Key: "lines", Value: bson.A{line("Admission fee", 2000), line("Security deposit", 5000)}}, {Key: "totalAmount", Value: 7000}, {Key: "currency", Value: "NPR"},
			{Key: "dueDate", Value: moveIn[i]}, {Key: "issuedAt", Value: issued}, {Key: "status", Value: "OPEN"}, {Key: "referenceCode", Value: ref}, {Key: "legacyPaymentId", Value: nil},
			{Key: "dunning", Value: bson.D{{Key: "chaseCount", Value: 0}, {Key: "lastNotifiedAt", Value: nil}, {Key: "stage", Value: "NONE"}}}, {Key: "fineWaived", Value: false},
			{Key: "createdBy", Value: d.owner}, {Key: "createdAt", Value: issued}, {Key: "updatedAt", Value: issued}, {Key: "__v", Value: 0}, {Key: demoMarkey, Value: true}}); err != nil {
			return err
		}
		bills = append(bills, bill{id, i, r.Joined, 1, issued})
	}
	for m, period := range periods {
		due := day(m, 7)
		res, err := e.RunBillingCycle(ctx, ledger.BillingInput{DueDate: &due, HostelID: d.hostel, Period: period, ResidentIDs: all}, nil)
		if err != nil {
			return fmt.Errorf("bills %s: %w", period, err)
		}
		issued := at(bounds[m].Start, 0, 15)
		for _, b := range res.Billed {
			id, _ := bson.ObjectIDFromHex(b.InvoiceID)
			rid, _ := bson.ObjectIDFromHex(b.ResidentID)
			for i := range ids {
				if ids[i] == rid {
					bills = append(bills, bill{id, i, m, 0, issued})
				}
			}
			if _, err := d.db.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}},
				bson.D{{Key: "$set", Value: bson.D{{Key: "issuedAt", Value: issued}, {Key: "createdAt", Value: issued}, {Key: "updatedAt", Value: issued}}}}); err != nil {
				return err
			}
		}
		fmt.Printf("bills %s: %d issued (Rs %d), %d skipped, %d failed\n", period, len(res.Billed), res.TotalBilled, len(res.Skipped), len(res.Failures))
		for _, f := range res.Failures {
			fmt.Printf("  failed %s: %s %s\n", f.ResidentID, f.ErrorCode, f.Message)
		}
	}

	// 4. Payments, through the ledger: a cash or QR entry at the desk, settled that day.
	paid := 0
	for _, b := range bills {
		var inv struct {
			Total int64 `bson:"totalAmount"`
		}
		if err := d.db.Collection("invoices").FindOne(ctx, bson.D{{Key: "_id", Value: b.id}}).Decode(&inv); err != nil {
			return err
		}
		plan := rentPays(b.resident, b.month, today)
		if b.kindNo == 1 {
			plan = []pay{{seedResidents[b.resident].JoinDay, 1, "CASH"}}
		}
		for n, p := range plan {
			amount := int64(float64(inv.Total)*p.share/100+0.5) * 100 // part payments in whole hundreds, like cash at a desk
			if p.share == float64(int64(p.share)) {
				amount = inv.Total * int64(p.share)
			}
			if amount <= 0 {
				continue
			}
			when := at(day(b.month, p.day), 9+(b.resident%8), 10+n*7)
			if when.After(now) {
				when = now.Add(-time.Hour)
			}
			slip := fmt.Sprintf("DEMO-%s-%d", b.id.Hex()[16:], n)
			ev, _, err := e.AppendEvent(ctx, ledger.AppendInput{Amount: amount, Confirmation: "MANUAL_REVIEW", HostelID: d.hostel, IdempotencyKey: "demo:" + d.hostel.Hex() + ":" + slip,
				InvoiceID: &b.id, OccurredAt: when, Provider: p.provider, ResidentID: &ids[b.resident], Source: "CASH_ENTRY", Status: "PENDING",
				RawPayload: bson.D{{Key: "cashReceiptNumber", Value: slip}, {Key: "collectedBy", Value: owner.Name}, {Key: "note", Value: nil}, {Key: "recordedBy", Value: d.owner.Hex()}}})
			if err != nil {
				return fmt.Errorf("payment %s: %w", slip, err)
			}
			if _, err := e.SettleEvent(ctx, ev.ID, ledger.SettleOptions{Confirmation: "MANUAL_REVIEW", SettledAt: when}); err != nil && !errors.Is(err, ledger.ErrNotPending) {
				return fmt.Errorf("settle %s: %w", slip, err)
			}
			for _, c := range []string{"paymentevents", "receipts"} {
				key := "_id"
				if c == "receipts" {
					key = "eventId"
				}
				if _, err := d.db.Collection(c).UpdateMany(ctx, bson.D{{Key: key, Value: ev.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "createdAt", Value: when}, {Key: "updatedAt", Value: when}}}}); err != nil {
					return err
				}
			}
			paid++
		}
	}
	for _, b := range bills { // status from the due date as of today (OVERDUE where unpaid)
		if _, err := e.RecomputeInvoiceBalance(ctx, b.id); err != nil {
			return err
		}
	}
	fmt.Printf("payments: %d recorded on %d bills\n", paid, len(bills))

	// 5. Late fines on last month's unpaid bills: count from that month's start, not
	// from today (the rule was switched on during the shoot). The real value is kept
	// for unseed.
	var lf struct {
		LateFine struct {
			EnabledAt *time.Time `bson:"enabledAt"`
		} `bson:"lateFine"`
	}
	_ = d.db.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}}).Decode(&lf)
	if lf.LateFine.EnabledAt != nil && lf.LateFine.EnabledAt.After(bounds[2].Start) {
		if _, err := d.db.Collection("hostelsettings").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "demoSeedOrig.lateFineEnabledAt", Value: *lf.LateFine.EnabledAt}, {Key: "lateFine.enabledAt", Value: bounds[2].Start}}}}); err != nil {
			return err
		}
	}
	fines, err := (&financeadmin.Handler{DB: d.db}).AccrueLateFinesFor(ctx, nil, now, d.hostel)
	if err != nil {
		return fmt.Errorf("late fines: %w", err)
	}
	fmt.Printf("late fines: %v\n", fines)

	// 6. Spending, notices, complaints, inquiries.
	nExp := 0
	for m := range periods {
		for _, x := range monthExpenses(m) {
			if m == 3 && x.day > today {
				continue
			}
			when := at(day(m, x.day), 11, 30)
			if _, err := d.db.Collection("expenses").InsertOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "spentOn", Value: day(m, x.day)}, {Key: "amount", Value: x.amount},
				{Key: "currency", Value: "NPR"}, {Key: "category", Value: x.category}, {Key: "customCategoryId", Value: nil}, {Key: "what", Value: x.what}, {Key: "paidBy", Value: x.paidBy},
				{Key: "payer", Value: "HOSTEL"}, {Key: "photoAssetId", Value: nil}, {Key: "receiptGroupId", Value: nil}, {Key: "receiptHash", Value: nil}, {Key: "receiptTxnId", Value: nil},
				{Key: "cashTo", Value: nil}, {Key: "cashStatus", Value: nil}, {Key: "salaryFor", Value: nil}, {Key: "recordedBy", Value: d.owner}, {Key: "recordedByName", Value: owner.Name},
				{Key: "recordedByRole", Value: "HOSTEL_ADMIN"}, {Key: "source", Value: "MANUAL"}, {Key: "status", Value: "RECORDED"}, {Key: "clientRequestId", Value: nil},
				{Key: "createdAt", Value: when}, {Key: "updatedAt", Value: when}, {Key: "__v", Value: 0}, {Key: demoMarkey, Value: true}}); err != nil {
				return err
			}
			nExp++
		}
	}
	for _, n := range []struct {
		m, d                     int
		title, content, category string
	}{
		{1, 18, "Dashain food menu", "Special khasi and sel roti on Dashami. Dinner at 7 PM for everyone staying back.", "EVENT"},
		{2, 15, "Water tank cleaned", "The water tank was cleaned today. Please report any taste or colour problem to the warden.", "MAINTENANCE"},
	} {
		when := at(day(n.m, n.d), 9, 0)
		if _, err := d.db.Collection("notices").InsertOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "title", Value: n.title}, {Key: "content", Value: n.content},
			{Key: "category", Value: n.category}, {Key: "isUrgent", Value: false}, {Key: "targetAudience", Value: "ALL"}, {Key: "publishedAt", Value: when}, {Key: "expiresAt", Value: when.Add(10 * 24 * time.Hour)},
			{Key: "createdBy", Value: d.owner}, {Key: "updatedBy", Value: d.owner}, {Key: "createdAt", Value: when}, {Key: "updatedAt", Value: when}, {Key: "__v", Value: 0}, {Key: demoMarkey, Value: true}}); err != nil {
			return err
		}
	}
	for _, c := range []struct {
		who, m, d                       int
		title, desc, category, response string
	}{
		{1, 0, 20, "Fan not working", "The ceiling fan in room 002 stopped.", "MAINTENANCE", "Electrician fixed the regulator."},
		{4, 1, 9, "Hot water too short", "Hot water ends by 7 AM.", "ROOM", "Geyser timer moved to 5 AM."},
		{8, 2, 22, "Wi-Fi slow at night", "Wi-Fi is very slow after 9 PM on the first floor.", "OTHER", "Router moved to the first floor landing."},
	} {
		when := at(day(c.m, c.d), 19, 0)
		done := when.Add(26 * time.Hour)
		if _, err := d.db.Collection("complaints").InsertOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "residentId", Value: ids[c.who]}, {Key: "title", Value: c.title},
			{Key: "description", Value: c.desc}, {Key: "category", Value: c.category}, {Key: "isAnonymous", Value: false}, {Key: "clientRequestId", Value: nil}, {Key: "status", Value: "RESOLVED"},
			{Key: "adminResponse", Value: c.response}, {Key: "slaDueAt", Value: when.Add(48 * time.Hour)}, {Key: "resolvedAt", Value: done}, {Key: "updatedBy", Value: d.owner},
			{Key: "createdAt", Value: when}, {Key: "updatedAt", Value: done}, {Key: "__v", Value: 0}, {Key: demoMarkey, Value: true}}); err != nil {
			return err
		}
	}
	for i, q := range []struct {
		name, msg, room, status string
		daysAgo                 int
	}{
		{"Aashish Lama", "Is a single room free from next month? I study at Shanker Dev Campus.", "Single Room", "NEW", 1},
		{"Bikram Oli", "Can I visit on Saturday to see the two-seater rooms?", "Double Sharing", "CONTACTED", 3},
		{"Sandesh Karki", "Do you give a discount for two brothers sharing a room?", "Double Sharing", "NEW", 0},
	} {
		when := now.Add(-time.Duration(q.daysAgo*24+3+i) * time.Hour)
		if _, err := d.db.Collection("inquiries").InsertOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "name", Value: q.name}, {Key: "phone", Value: seedPhone(40 + i)},
			{Key: "message", Value: q.msg}, {Key: "preferredRoomType", Value: q.room}, {Key: "source", Value: "PUBLIC_WEBSITE"}, {Key: "status", Value: q.status}, {Key: "isDeleted", Value: false},
			{Key: "createdAt", Value: when}, {Key: "updatedAt", Value: when}, {Key: "__v", Value: 0}, {Key: demoMarkey, Value: true}}); err != nil {
			return err
		}
	}
	fmt.Printf("expenses: %d · notices: 2 · complaints: 3 · inquiries: 3\n", nExp)
	return d.markSeeded(ctx, all)
}

// markSeeded puts the mark on every row the engine wrote for a seeded resident.
func (d *demo) markSeeded(ctx context.Context, ids bson.A) error {
	for _, c := range demoCollections {
		if _, err := d.db.Collection(c).UpdateMany(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: demoMarkey, Value: true}}}}); err != nil {
			return err
		}
	}
	return nil
}

func (d *demo) unseed(ctx context.Context) error {
	ids, err := d.seededIDs(ctx)
	if err != nil {
		return err
	}
	filter := bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "$or", Value: bson.A{bson.D{{Key: demoMarkey, Value: true}}, bson.D{{Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}}}}}
	for _, c := range demoCollections {
		res, err := d.db.Collection(c).DeleteMany(ctx, filter)
		if err != nil {
			return err
		}
		if res.DeletedCount > 0 {
			fmt.Printf("%s: %d removed\n", c, res.DeletedCount)
		}
	}
	var s struct {
		Orig struct {
			EnabledAt *time.Time `bson:"lateFineEnabledAt"`
		} `bson:"demoSeedOrig"`
	}
	_ = d.db.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}}).Decode(&s)
	if s.Orig.EnabledAt != nil {
		if _, err := d.db.Collection("hostelsettings").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "lateFine.enabledAt", Value: *s.Orig.EnabledAt}}}, {Key: "$unset", Value: bson.D{{Key: "demoSeedOrig", Value: ""}}}}); err != nil {
			return err
		}
	}
	rs := &hostelrooms.Service{DB: d.db, Cap: &hostelrooms.Capacity{DB: d.db}}
	return rs.SyncTypeCounts(ctx, d.hostel)
}

type freeRoom struct {
	id                bson.ObjectID
	roomType, bedType string
	floor, free       int
}

// freeBeds reads the floor plan and who lives where now.
func (d *demo) freeBeds(ctx context.Context) (map[string]freeRoom, error) {
	cur, err := d.db.Collection("hostelrooms").Find(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "isDeleted", Value: false}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID       bson.ObjectID `bson:"_id"`
		Number   string        `bson:"number"`
		RoomType string        `bson:"roomType"`
		Beds     int           `bson:"beds"`
		Floor    int           `bson:"floor"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[string]freeRoom{}
	for _, r := range rows {
		n, err := d.db.Collection("residents").CountDocuments(ctx, bson.D{{Key: "roomId", Value: r.ID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
			{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING", "SUSPENDED"}}}}})
		if err != nil {
			return nil, err
		}
		out[r.Number] = freeRoom{r.ID, r.RoomType, bedTypeOf(r.Beds), r.Floor, r.Beds - int(n)}
	}
	return out, nil
}

func bedTypeOf(beds int) string {
	switch beds {
	case 1:
		return "SINGLE"
	case 2:
		return "DOUBLE_SHARING"
	case 3:
		return "TRIPLE_SHARING"
	}
	return ""
}
