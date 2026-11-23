package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/jobs"
	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/router"
)

// Time scenarios for the demo videos (demo-video.md §6): move only the demo
// hostel into a state, then run the real job for that hostel alone.
//
//	dev demo rent-due-soon    open bills of the residents who can sign in fall due in 2 days → reminder
//	dev demo rent-overdue     those bills fall due before the late-fine grace → fines + overdue notice
//	dev demo month-roll       next BS month's bills raised for this hostel
//	dev demo trial-ending     trial ends in 2 days → owner's reminder (bell + email)
//	dev demo trial-ended      trial ended an hour ago → Free plan
//	dev demo plan-past-due    a bought plan's period ended yesterday → renewal bill, PAST_DUE, Free plan
//	dev demo seed-bookings    one booking waiting for the hostel, one confirmed (ch 21b)
//	dev demo statement-file   an eSewa statement (real export format) for the open seeded bills (ch 50a)
//	dev demo restore          every date put back, the renewal bill voided, seeded bookings gone
//
// The jobs run in this process, on the same code the server runs, through the
// cron door with ?hostelId= (router/jobs.go): no deployed version can turn a
// scoped run into an every-hostel one. MISSION.md addition 6 is the permission.

const origKey = "demoSeedOrig"

// jobFn runs one cron job for the demo hostel only.
type jobFn func(job string, q url.Values) error

// jobs builds the server in-process (router.New on the production database)
// and hands back a runner for its cron doors. Built before a scenario writes
// anything, so a config problem stops it with the hostel untouched.
func (d *demo) jobs(ctx context.Context) (jobFn, error) {
	cfg, cronSecret, err := liveConfig()
	if err != nil {
		return nil, err
	}
	bg := &background.Runner{}
	h, err := router.New(cfg, router.Deps{DB: d.db, Background: bg, Jobs: jobs.New(ctx, d.db, nil)})
	if err != nil {
		return nil, err
	}
	return func(job string, q url.Values) error {
		return serveJob(ctx, h, bg, cronSecret, d.hostel, job, q)
	}, nil
}

// liveConfig is the in-process server's config: the root .env, Atlas allowed for
// its host, no Redis, no scheduler, a throwaway cron secret.
func liveConfig() (*config.Config, string, error) {
	env, err := rootEnvFile()
	if err != nil {
		return nil, "", err
	}
	mongoURL, err := url.Parse(env["MONGODB_URI"])
	if err != nil {
		return nil, "", err
	}
	secret := make([]byte, 24)
	_, _ = rand.Read(secret)
	over := map[string]string{
		// The dev config refuses Atlas unless told this host; the demo hostel lives there.
		"ALLOW_DEV_ATLAS_HOST": mongoURL.Hostname(),
		"APP_ENV":              "development",
		"APP_URL":              "https://hostelpalika.com",
		"CRON_SECRET":          hex.EncodeToString(secret),
		"REDIS_URL":            "",
		"REDIS_CACHE_URL":      "",
		"SCHEDULER_ENABLED":    "false",
	}
	cfg, _, err := config.Parse(func(k string) (string, bool) {
		if v, ok := over[k]; ok {
			return v, true
		}
		v, ok := env[k]
		return v, ok
	})
	return cfg, over["CRON_SECRET"], err
}

// nudgeApps makes open apps re-read the demo hostel after a write the live API
// never saw. That API caches each read for cache.TTL under a hostel version only
// it can bump (its Redis is private to the VPS), and an app holding the old answer
// has no reason to ask again: after trial-ended → restore the owner's branch chip
// stayed hidden, across a cold start too, on the cached trial-ended plan. So the
// TTL is waited out first, then the hostel's plan and money topics are published.
func (d *demo) nudgeApps(ctx context.Context) error {
	cfg, _, err := liveConfig()
	if err != nil {
		return err
	}
	fmt.Printf("waiting %s for the live API's cached reads to lapse, then telling open apps…\n", cache.TTL)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(cache.TTL + 2*time.Second):
	}
	realtime.PublishResourceChange(ctx, realtime.New(cfg.Pusher), nil, realtime.Change{
		Topics:    []realtime.Topic{realtime.Hostels, realtime.Payments},
		HostelIDs: []string{d.hostel.Hex()},
	})
	return nil
}

func serveJob(ctx context.Context, h http.Handler, bg *background.Runner, secret string, hostel bson.ObjectID, job string, q url.Values) error {
	q.Set("hostelId", hostel.Hex())
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/cron/"+job+"?"+q.Encode(), nil)
	req.Header.Set("x-cron-secret", secret)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	// Pushes and mail go out on the background runner; let them land before exit.
	_ = bg.Wait(ctx)
	body := rec.Body.String()
	if len(body) > 1500 {
		body = body[:1500] + "…"
	}
	fmt.Printf("%s → %d %s\n", job, rec.Code, body)
	if rec.Code >= 300 {
		return fmt.Errorf("%s answered %d", job, rec.Code)
	}
	return nil
}

// rootEnvFile reads the repo root .env (server/.. when run from server/).
func rootEnvFile() (map[string]string, error) {
	for _, p := range []string{filepath.Join("..", ".env"), ".env"} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		out := map[string]string{}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			k, v, ok := strings.Cut(strings.TrimPrefix(line, "export "), "=")
			if ok {
				out[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
			}
		}
		_ = f.Close()
		if strings.Contains(out["MONGODB_URI"], ".mongodb.net") {
			return out, nil
		}
	}
	return nil, errors.New("root .env with an Atlas MONGODB_URI not found")
}

// keepOrig saves fields' values under demoSeedOrig the first time a scenario
// touches a row, so restore can put the row back however many scenarios ran.
func keepOrig(ctx context.Context, c *mongo.Collection, id bson.ObjectID, fields ...string) error {
	var doc bson.M
	if err := c.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&doc); err != nil {
		return err
	}
	if _, kept := doc[origKey]; kept {
		return nil
	}
	orig, absent := bson.M{}, bson.A{}
	for _, f := range fields {
		if v, ok := doc[f]; ok {
			orig[f] = v
		} else {
			absent = append(absent, f)
		}
	}
	_, err := c.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: origKey, Value: bson.D{{Key: "fields", Value: orig}, {Key: "absent", Value: absent}, {Key: "at", Value: time.Now().UTC()}}}}}})
	return err
}

// putBack restores every row of c under filter that keepOrig marked.
func putBack(ctx context.Context, c *mongo.Collection, filter bson.D) (int, error) {
	cur, err := c.Find(ctx, append(filter, bson.E{Key: origKey, Value: bson.D{{Key: "$exists", Value: true}}}))
	if err != nil {
		return 0, err
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Orig struct {
			Fields bson.M   `bson:"fields"`
			Absent []string `bson:"absent"`
		} `bson:"demoSeedOrig"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return 0, err
	}
	for _, r := range rows {
		set, unset := bson.D{}, bson.D{{Key: origKey, Value: ""}}
		for k, v := range r.Orig.Fields {
			set = append(set, bson.E{Key: k, Value: v})
		}
		for _, k := range r.Orig.Absent {
			unset = append(unset, bson.E{Key: k, Value: ""})
		}
		u := bson.D{{Key: "$unset", Value: unset}}
		if len(set) > 0 {
			u = append(u, bson.E{Key: "$set", Value: set})
		}
		if _, err := c.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}}, u); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}

// liveBills is the open rent of residents who can sign in: the phones on camera.
func (d *demo) liveBills(ctx context.Context) ([]bson.ObjectID, error) {
	var people []bson.ObjectID
	if err := d.db.Collection("residents").Distinct(ctx, "_id", bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}}).Decode(&people); err != nil {
		return nil, err
	}
	if len(people) == 0 {
		return nil, errors.New("no resident with a login lives in the demo hostel (re-join Aarav first, ch 22)")
	}
	var bills []bson.ObjectID
	if err := d.db.Collection("invoices").Distinct(ctx, "_id", bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "residentId", Value: bson.D{{Key: "$in", Value: people}}},
		{Key: "kind", Value: "MONTHLY_RENT"}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}}).Decode(&bills); err != nil {
		return nil, err
	}
	if len(bills) == 0 {
		return nil, errors.New("the residents who can sign in owe no rent: nothing to remind")
	}
	return bills, nil
}

// moveDue sets the bills' due date and clears their reminder ladder.
func (d *demo) moveDue(ctx context.Context, bills []bson.ObjectID, due time.Time) error {
	inv := d.db.Collection("invoices")
	for _, id := range bills {
		if err := keepOrig(ctx, inv, id, "dueDate", "dunning", "status"); err != nil {
			return err
		}
		var b struct {
			Status string `bson:"status"`
		}
		_ = inv.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&b)
		set := bson.D{{Key: "dueDate", Value: due}, {Key: "updatedAt", Value: time.Now().UTC()}}
		if b.Status == "OVERDUE" && due.After(time.Now()) {
			set = append(set, bson.E{Key: "status", Value: "OPEN"})
		}
		if _, err := inv.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: d.hostel}}, bson.D{{Key: "$set", Value: set}, {Key: "$unset", Value: bson.D{{Key: "dunning", Value: ""}}}}); err != nil {
			return err
		}
	}
	fmt.Printf("%d bill(s) now due %s\n", len(bills), due.Format(time.RFC3339))
	return nil
}

func (d *demo) rentDueSoon(ctx context.Context) error {
	run, err := d.jobs(ctx)
	if err != nil {
		return err
	}
	bills, err := d.liveBills(ctx)
	if err != nil {
		return err
	}
	if err := d.moveDue(ctx, bills, bs.DayEnd(time.Now(), 2)); err != nil {
		return err
	}
	return run("payment-reminders", url.Values{})
}

func (d *demo) rentOverdue(ctx context.Context) error {
	run, err := d.jobs(ctx)
	if err != nil {
		return err
	}
	bills, err := d.liveBills(ctx)
	if err != nil {
		return err
	}
	var s struct {
		LateFine *struct {
			Enabled   *bool `bson:"enabled"`
			GraceDays *int  `bson:"graceDays"`
		} `bson:"lateFine"`
	}
	_ = d.db.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}}).Decode(&s)
	grace := 5
	if s.LateFine == nil || s.LateFine.Enabled == nil || !*s.LateFine.Enabled {
		fmt.Println("note: the late fine is off for this hostel (Finance settings → Money rules), so no FINE line will be added")
	} else if s.LateFine.GraceDays != nil {
		grace = *s.LateFine.GraceDays
	}
	if err := d.moveDue(ctx, bills, time.Now().Add(-time.Duration(grace+3)*24*time.Hour)); err != nil {
		return err
	}
	// Billing for the current month is a no-op for anyone already billed; the
	// scoped run then accrues this hostel's fines. The reminders run marks OVERDUE.
	if err := run("billing-cycle", url.Values{}); err != nil {
		return err
	}
	return run("payment-reminders", url.Values{})
}

func (d *demo) monthRoll(ctx context.Context) error {
	run, err := d.jobs(ctx)
	if err != nil {
		return err
	}
	now, err := bs.PeriodOf(time.Now())
	if err != nil {
		return err
	}
	next, err := bs.AddMonths(now, 1)
	if err != nil {
		return err
	}
	fmt.Printf("raising %s (%s) for %s; they stay (that month's own run finds them billed); unseed removes the seeded residents' ones\n", next, bs.FormatPeriod(next), d.name)
	return run("billing-cycle", url.Values{"period": {next}})
}

func (d *demo) subscription(ctx context.Context) (bson.ObjectID, bson.M, error) {
	var sub bson.M
	err := d.db.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}}).Decode(&sub)
	if err != nil {
		return bson.ObjectID{}, nil, fmt.Errorf("demo hostel subscription: %w", err)
	}
	id, _ := sub["_id"].(bson.ObjectID)
	return id, sub, nil
}

var subFields = []string{"trialEndsAt", "trialReminded", "currentPeriodEnd", "status", "dueBy"}

func (d *demo) trialEnding(ctx context.Context) error {
	run, err := d.jobs(ctx)
	if err != nil {
		return err
	}
	id, sub, err := d.subscription(ctx)
	if err != nil {
		return err
	}
	if sub["planId"] != nil || sub["lifetimeSince"] != nil {
		return errors.New("the demo hostel already has a plan: film trial chapters before ch 57, or run restore")
	}
	subs := d.db.Collection("hostelsubscriptions")
	if err := keepOrig(ctx, subs, id, subFields...); err != nil {
		return err
	}
	if _, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "trialEndsAt", Value: bs.DayEnd(time.Now(), 2)}, {Key: "currentPeriodEnd", Value: bs.DayEnd(time.Now(), 2)}, {Key: "trialReminded", Value: bson.A{}}}}}); err != nil {
		return err
	}
	return run("payment-reminders", url.Values{})
}

func (d *demo) trialEnded(ctx context.Context) error {
	run, err := d.jobs(ctx)
	if err != nil {
		return err
	}
	id, sub, err := d.subscription(ctx)
	if err != nil {
		return err
	}
	if sub["planId"] != nil || sub["lifetimeSince"] != nil {
		return errors.New("the demo hostel already has a plan: film trial chapters before ch 57, or run restore")
	}
	subs := d.db.Collection("hostelsubscriptions")
	if err := keepOrig(ctx, subs, id, subFields...); err != nil {
		return err
	}
	if _, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "trialEndsAt", Value: time.Now().Add(-time.Hour)}, {Key: "currentPeriodEnd", Value: time.Now().Add(-time.Hour)}}}}); err != nil {
		return err
	}
	return run("payment-reminders", url.Values{})
}

func (d *demo) planPastDue(ctx context.Context) error {
	run, err := d.jobs(ctx)
	if err != nil {
		return err
	}
	id, sub, err := d.subscription(ctx)
	if err != nil {
		return err
	}
	if sub["planId"] == nil || sub["status"] != "ACTIVE" || sub["lifetimeSince"] != nil {
		return errors.New("needs a bought monthly plan that is ACTIVE (film ch 57 first)")
	}
	subs := d.db.Collection("hostelsubscriptions")
	if err := keepOrig(ctx, subs, id, subFields...); err != nil {
		return err
	}
	if _, err := subs.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "currentPeriodEnd", Value: time.Now().Add(-24 * time.Hour)}}}}); err != nil {
		return err
	}
	return run("payment-reminders", url.Values{})
}

// seedBookings writes one booking waiting for the hostel and one confirmed. The
// guests are ghosts (no user row, no email), and no Softmato invoice number is
// set, so no sweep or refund filing can reach a real person or the provider.
// restore and unseed delete both, so run this just before ch 21b.
func (d *demo) seedBookings(ctx context.Context) error {
	n, err := d.db.Collection("bookings").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: demoMarkey, Value: true}})
	if err != nil {
		return err
	}
	if n > 0 {
		return errors.New("seeded bookings are already there (restore removes them)")
	}
	var h struct {
		Address string `bson:"address"`
		Phone   string `bson:"phone"`
		Contact *struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
	}
	_ = d.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: d.hostel}}).Decode(&h)
	var ref bson.M // the hostel's own booking from ch 21b: snapshot, terms and invoice series
	if err := d.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: demoMarkey, Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&ref); err != nil {
		return fmt.Errorf("copy terms from the hostel's ch 21b booking: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	rooms := &hostelrooms.Capacity{DB: d.db}
	mk := func(i int, name, phone, roomType string, rent int64, status string) bson.D {
		created := now.Add(-time.Duration(26-i*20) * time.Hour)
		paid := created.Add(40 * time.Minute)
		moveIn := bs.DayEnd(now, 5+i*3)
		b := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "bedHeld", Value: status == "CONFIRMED"}, {Key: "checkedInAt", Value: nil}, {Key: "checkedInBy", Value: nil},
			{Key: "code", Value: fmt.Sprintf("BK-DEMO%02d", i)}, {Key: "currency", Value: "NPR"}, {Key: "endReason", Value: nil}, {Key: "endedAt", Value: nil}, {Key: "endedBy", Value: nil},
			{Key: "fee", Value: rent * 7 / 100}, {Key: "guest", Value: bson.D{{Key: "email", Value: ""}, {Key: "name", Value: name}, {Key: "phone", Value: phone}}},
			{Key: "hostelId", Value: d.hostel}, {Key: "hostelRemindersSent", Value: bson.A{}}, {Key: "hostelSnapshot", Value: ref["hostelSnapshot"]}, {Key: "hostelStrike", Value: false},
			{Key: "invoiceNumber", Value: fmt.Sprintf("DEMO-BKI-%02d", i)}, {Key: "isOpen", Value: true}, {Key: "kind", Value: "MONTHLY"}, {Key: "monthlyRent", Value: rent},
			{Key: "moveInRemindersSent", Value: bson.A{}}, {Key: "paymentDueBy", Value: created.Add(24 * time.Hour)}, {Key: "paymentRejection", Value: bson.D{{Key: "at", Value: nil}, {Key: "reason", Value: nil}}},
			{Key: "paymentSubmittedAt", Value: paid}, {Key: "paymentVerifiedAt", Value: paid.Add(10 * time.Minute)}, {Key: "paymentVerifiedBy", Value: nil}, {Key: "plannedMoveIn", Value: moveIn},
			{Key: "policy", Value: ref["policy"]}, {Key: "receiptNumber", Value: nil},
			{Key: "refundAccount", Value: bson.D{{Key: "bankName", Value: ""}, {Key: "branch", Value: ""}, {Key: "holderName", Value: name}, {Key: "method", Value: "ESEWA"}, {Key: "numberLast4", Value: phone[len(phone)-4:]}}},
			{Key: "residentId", Value: nil}, {Key: "roomType", Value: roomType},
			{Key: "settlement", Value: bson.D{{Key: "hostelShare", Value: nil}, {Key: "kept", Value: nil}, {Key: "platformShare", Value: nil}, {Key: "refund", Value: nil}, {Key: "refundPercent", Value: nil}, {Key: "stayKept", Value: nil}, {Key: "stayRefund", Value: nil}}},
			{Key: "softmatoInvoiceNo", Value: nil}, {Key: "status", Value: status}, {Key: "stay", Value: nil}, {Key: "terms", Value: ref["terms"]},
			{Key: "userId", Value: bson.NewObjectID()}, {Key: "createdAt", Value: created}, {Key: "updatedAt", Value: paid}, {Key: "__v", Value: 0}, {Key: demoMarkey, Value: true}}
		if status == "AWAITING_HOSTEL" {
			b = append(b, bson.E{Key: "hostelAnswerBy", Value: paid.Add(24 * time.Hour)}, bson.E{Key: "holdEndsAt", Value: nil}, bson.E{Key: "confirmedAt", Value: nil}, bson.E{Key: "confirmedBy", Value: nil})
		} else {
			b = append(b, bson.E{Key: "hostelAnswerBy", Value: paid.Add(24 * time.Hour)}, bson.E{Key: "holdEndsAt", Value: moveIn}, bson.E{Key: "confirmedAt", Value: paid.Add(3 * time.Hour)}, bson.E{Key: "confirmedBy", Value: d.owner})
		}
		return b
	}
	rows := []struct {
		name, phone, roomType, status string
		rent                          int64
	}{
		{"Bishal Karki", "9800000041", "Single Room", "AWAITING_HOSTEL", 14000},
		{"Sandesh Lama", "9800000042", "Double Sharing", "CONFIRMED", 11000},
	}
	for i, r := range rows {
		if r.status == "CONFIRMED" {
			if err := rooms.Claim(ctx, d.hostel, r.roomType); err != nil {
				return fmt.Errorf("hold a %s bed: %w", r.roomType, err)
			}
		}
		if _, err := d.db.Collection("bookings").InsertOne(ctx, mk(i+1, r.name, r.phone, r.roomType, r.rent, r.status)); err != nil {
			return err
		}
		fmt.Printf("booking BK-DEMO%02d %s · %s · %s\n", i+1, r.name, r.roomType, r.status)
	}
	return nil
}

// dropBookings deletes the seeded bookings, the bells their ghost guests got,
// and recounts the beds a confirmed one held.
func (d *demo) dropBookings(ctx context.Context) error {
	var ghosts []bson.ObjectID
	f := bson.D{{Key: "hostelId", Value: d.hostel}, {Key: demoMarkey, Value: true}}
	if err := d.db.Collection("bookings").Distinct(ctx, "userId", f).Decode(&ghosts); err != nil {
		return err
	}
	if len(ghosts) == 0 {
		return nil
	}
	if _, err := d.db.Collection("notifications").DeleteMany(ctx, bson.D{{Key: "userId", Value: bson.D{{Key: "$in", Value: ghosts}}}}); err != nil {
		return err
	}
	res, err := d.db.Collection("bookings").DeleteMany(ctx, f)
	if err != nil {
		return err
	}
	fmt.Printf("bookings: %d seeded removed\n", res.DeletedCount)
	rs := &hostelrooms.Service{DB: d.db, Cap: &hostelrooms.Capacity{DB: d.db}}
	return rs.SyncTypeCounts(ctx, d.hostel)
}

func (d *demo) restore(ctx context.Context) error {
	n, err := putBack(ctx, d.db.Collection("invoices"), bson.D{{Key: "hostelId", Value: d.hostel}})
	if err != nil {
		return err
	}
	fmt.Printf("invoices: %d due date(s) put back (fine lines stay: waive them on the bill if needed)\n", n)
	subs := d.db.Collection("hostelsubscriptions")
	var sub struct {
		Orig *struct {
			At time.Time `bson:"at"`
		} `bson:"demoSeedOrig"`
	}
	_ = subs.FindOne(ctx, bson.D{{Key: "hostelId", Value: d.hostel}}).Decode(&sub)
	if sub.Orig != nil {
		// The renewal bill plan-past-due raised is voided, not deleted: its number stays in the series.
		res, err := d.db.Collection("subscriptioninvoices").UpdateMany(ctx, bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "createdAt", Value: bson.D{{Key: "$gte", Value: sub.Orig.At}}},
			{Key: "status", Value: bson.D{{Key: "$nin", Value: bson.A{"PAID", "VOID"}}}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "VOID"}, {Key: "updatedAt", Value: time.Now().UTC()}}}})
		if err != nil {
			return err
		}
		if res.ModifiedCount > 0 {
			fmt.Printf("subscriptioninvoices: %d renewal bill(s) voided\n", res.ModifiedCount)
		}
		if _, err := putBack(ctx, subs, bson.D{{Key: "hostelId", Value: d.hostel}}); err != nil {
			return err
		}
		fmt.Println("plan: trial / period dates and status put back")
	}
	if err := d.dropBookings(ctx); err != nil {
		return err
	}
	// Recompute the plan limits for the restored dates (no job: no reminders go out).
	if _, err = (&billing.Limits{DB: d.db, Config: platformconfig.New(d.db)}).Refresh(ctx, d.hostel, time.Now()); err != nil {
		return err
	}
	return d.nudgeApps(ctx)
}

// check builds the in-process server and stops: proof the config and the
// database answer, before a shoot. Writes nothing.
func (d *demo) check(ctx context.Context) error {
	if _, err := d.jobs(ctx); err != nil {
		return err
	}
	fmt.Println("ok:", d.name, d.hostel.Hex(), "— jobs ready")
	return nil
}

// fixData is the one-off repair of 2026-11-23 (demo-video.md §10). Bibek
// Shrestha's deposit was typed together with his joined date (5000 + 2026-05-15)
// before existing-resident rows had a bound; Aarav's two ch 34 desk QR payments
// were saved as BANK before the app sent QR. Every filter names the demo hostel
// and the old value, so a second run changes nothing. The rows are marked
// demoFixed, not demoSeed: unseed must not delete a resident made on camera.
func (d *demo) fixData(ctx context.Context) error {
	now := time.Now().UTC()
	res, err := d.db.Collection("residents").UpdateOne(ctx,
		bson.D{{Key: "hostelId", Value: d.hostel}, {Key: "firstName", Value: "Bibek"}, {Key: "lastName", Value: "Shrestha"}, {Key: "depositAmount", Value: float64(500020260515)}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "depositAmount", Value: float64(5000)}, {Key: "updatedAt", Value: now}, {Key: "demoFixed", Value: "2026-11-23: deposit 500020260515 → 5000"}}}})
	if err != nil {
		return err
	}
	fmt.Printf("residents: %d deposit fixed (Bibek Shrestha → Rs 5,000)\n", res.ModifiedCount)
	qr := 0
	for _, hex := range []string{"6b01085c29f537901c583b5b", "6b03ed027936ad1b7783c17e"} {
		id, err := bson.ObjectIDFromHex(hex)
		if err != nil {
			return err
		}
		res, err := d.db.Collection("paymentevents").UpdateOne(ctx,
			bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: d.hostel}, {Key: "source", Value: "CASH_ENTRY"}, {Key: "provider", Value: "BANK"}, {Key: "rawPayload.via", Value: bson.D{{Key: "$exists", Value: false}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "rawPayload.via", Value: "QR"}, {Key: "demoFixed", Value: "2026-11-23: desk QR saved as BANK"}}}})
		if err != nil {
			return err
		}
		qr += int(res.ModifiedCount)
	}
	fmt.Printf("paymentevents: %d desk QR payment(s) marked QR\n", qr)
	return nil
}
