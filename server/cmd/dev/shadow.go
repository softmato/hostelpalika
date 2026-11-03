package main

// shadow-phase8 is Phase 8's gate (PHASES.md): Go's money-in checks run over a
// copy of live data (deploy/copy-live-db.ps1), and what they find or write is
// compared with what TS already recorded for the same data.
//
//   1. gateway-health and gateway-settlement-recon, per hostel, against TS's
//      latest run of each: same status, same counters, same finding codes.
//   2. Softmato: every plan invoice with a Softmato document is reconciled
//      through Go (Softmato is only read). TS settled these already, so any
//      payment Go records, or any invoice whose status moves, is drift.
//   3. Team prepayments still OPEN are refreshed the same way.
//
// Only a local database is accepted; everything Go writes stays in it.

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/gateway"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/softmato"
)

func shadowPhase8(args []string) error {
	fs := flag.NewFlagSet("shadow-phase8", flag.ExitOnError)
	uri := fs.String("db", "mongodb://127.0.0.1:27018/hostelpalika_dev?directConnection=true", "the live-data copy (local only)")
	_ = fs.Parse(args)
	if !strings.HasPrefix(*uri, "mongodb://127.0.0.1") && !strings.HasPrefix(*uri, "mongodb://localhost") {
		return fmt.Errorf("refusing %q: the shadow only runs on a local copy", *uri)
	}
	cfg, _, err := config.Load() // the repo-root .env, for the Softmato keys only
	if err != nil {
		return err
	}
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, *uri)
	if err != nil {
		return err
	}
	defer func() { _ = client.Disconnect(ctx) }()

	log := audit.New(db)
	site := platformconfig.New(db)
	noMail := email.NewSender("", cfg.Email.Domain, cfg.Email.ReplyTo, db) // sends nothing
	drift := 0

	// 1. gateway jobs
	httpc := &http.Client{Timeout: 15 * time.Second}
	gw := &gateway.Service{DB: db, Audit: log, SiteURL: cfg.AppURL, Production: true, Now: time.Now,
		Providers: map[string]gateway.Provider{"ESEWA": &gateway.ESewa{HTTP: httpc, Now: time.Now}, "KHALTI": &gateway.Khalti{HTTP: httpc, Now: time.Now}}}
	now := time.Now()
	for _, job := range []struct{ name, tsTrigger, goTrigger string }{{"gateway-health", "CRON", "SHADOW"}, {"gateway-settlement-recon", "CRON_SETTLEMENT", "SHADOW_SETTLEMENT"}} {
		ts, err := latestRuns(ctx, db, job.tsTrigger)
		if err != nil {
			return err
		}
		if job.name == "gateway-health" {
			_, err = gw.RunGatewayHealth(ctx, now, job.goTrigger)
		} else {
			_, err = gw.RunSettlementRecon(ctx, now, job.goTrigger)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", job.name, err)
		}
		got, err := latestRuns(ctx, db, job.goTrigger)
		if err != nil {
			return err
		}
		same, missing := 0, 0
		for hostel, g := range got {
			t, ok := ts[hostel]
			if !ok {
				missing++ // a hostel TS has not run yet (new since its last run)
				continue
			}
			if g != t {
				drift++
				fmt.Printf("DRIFT %s hostel %s\n  ts: %s\n  go: %s\n", job.name, hostel, t, g)
				continue
			}
			same++
		}
		fmt.Printf("%s: %d hostels, %d match TS's latest run, %d have no TS run yet\n", job.name, len(got), same, missing)
	}

	// 2 + 3. Softmato
	sm := softmato.New(cfg.Softmato.BaseURL, cfg.Softmato.Secret, cfg.Softmato.WebhookSecret)
	if sm == nil {
		fmt.Println("softmato: no keys in .env, skipped")
		return report(drift)
	}
	settler := &billing.Settler{Service: &billing.Service{DB: db, SiteURL: cfg.AppURL, SoftmatoBase: cfg.Softmato.BaseURL, Softmato: sm, Config: site, Audit: log, Mail: noMail, Outbound: cfg.OutboundURL()}, Now: time.Now}
	before, err := ledgerState(ctx, db)
	if err != nil {
		return err
	}
	cur, err := db.Collection("subscriptioninvoices").Find(ctx, bson.D{{Key: "softmatoInvoiceNo", Value: bson.D{{Key: "$type", Value: "string"}}}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return err
	}
	var invoices []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &invoices); err != nil {
		return err
	}
	failed, read := 0, 0
	for _, inv := range invoices {
		var no struct {
			No string `bson:"softmatoInvoiceNo"`
		}
		_ = db.Collection("subscriptioninvoices").FindOne(ctx, bson.D{{Key: "_id", Value: inv.ID}}).Decode(&no)
		if d, err := sm.GetInvoice(ctx, no.No); err == nil && d != nil {
			read++
		} else {
			fmt.Println("softmato read", no.No, err)
		}
		if err := settler.Reconcile(ctx, inv.ID); err != nil {
			failed++
			fmt.Printf("reconcile %s: %v\n", inv.ID.Hex(), err)
		}
	}
	after, err := ledgerState(ctx, db)
	if err != nil {
		return err
	}
	for _, line := range diffState(before, after) {
		drift++
		fmt.Println("DRIFT softmato", line)
	}
	fmt.Printf("softmato: %d invoices (%d read back from Softmato) reconciled through Go (%d errors), %d payments before, %d after\n", len(invoices), read, failed, before.payments, after.payments)
	// A pre-integration invoice 404s at Softmato for TS too; none reading back
	// would mean bad keys, and a vacuous check.
	if len(invoices) > 0 && read == 0 {
		drift++
	}

	var open []struct {
		ID         bson.ObjectID `bson:"_id"`
		SoftmatoNo string        `bson:"softmatoInvoiceNo"`
	}
	cur, err = db.Collection("teamprepayments").Find(ctx, bson.D{{Key: "status", Value: "OPEN"}, {Key: "softmatoInvoiceNo", Value: bson.D{{Key: "$type", Value: "string"}}}})
	if err != nil {
		return err
	}
	if err := cur.All(ctx, &open); err != nil {
		return err
	}
	for _, p := range open {
		d, err := sm.GetInvoice(ctx, p.SoftmatoNo)
		if err == nil && d != nil && d.Status == "paid" {
			drift++
			fmt.Printf("DRIFT prepayment %s is OPEN here but paid at Softmato\n", p.ID.Hex())
		}
	}
	fmt.Printf("team prepayments: %d OPEN checked against Softmato\n", len(open))
	return report(drift)
}

func report(drift int) error {
	if drift > 0 {
		return fmt.Errorf("%d drift lines", drift)
	}
	fmt.Println("zero drift")
	return nil
}

// latestRuns is each hostel's newest GATEWAY_HEALTH run with this trigger, as
// "status counters codes" so two runs compare as strings.
func latestRuns(ctx context.Context, db *mongo.Database, trigger string) (map[string]string, error) {
	cur, err := db.Collection("reconciliationruns").Aggregate(ctx, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "kind", Value: "GATEWAY_HEALTH"}, {Key: "triggeredBy", Value: trigger}}}},
		{{Key: "$sort", Value: bson.D{{Key: "createdAt", Value: -1}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$hostelId"}, {Key: "run", Value: bson.D{{Key: "$first", Value: "$$ROOT"}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID  bson.ObjectID `bson:"_id"`
		Run struct {
			Status   string         `bson:"status"`
			Counters map[string]any `bson:"counters"`
			Findings []struct {
				Code string `bson:"code"`
			} `bson:"findings"`
		} `bson:"run"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, r := range rows {
		keys := make([]string, 0, len(r.Run.Counters))
		for k, v := range r.Run.Counters {
			keys = append(keys, fmt.Sprintf("%s=%v", k, v))
		}
		codes := make([]string, len(r.Run.Findings))
		for i, f := range r.Run.Findings {
			codes[i] = f.Code
		}
		sort.Strings(keys)
		sort.Strings(codes)
		out[r.ID.Hex()] = r.Run.Status + " {" + strings.Join(keys, ",") + "} [" + strings.Join(codes, ",") + "]"
	}
	return out, nil
}

type state struct {
	payments int64
	invoices map[string]string // id → status
	subs     map[string]string // id → status|periodEnd
}

func ledgerState(ctx context.Context, db *mongo.Database) (state, error) {
	s := state{invoices: map[string]string{}, subs: map[string]string{}}
	var err error
	if s.payments, err = db.Collection("subscriptionpayments").CountDocuments(ctx, bson.D{}); err != nil {
		return s, err
	}
	cur, err := db.Collection("subscriptioninvoices").Find(ctx, bson.D{}, options.Find().SetProjection(bson.D{{Key: "status", Value: 1}}))
	if err != nil {
		return s, err
	}
	var invs []struct {
		ID     bson.ObjectID `bson:"_id"`
		Status string        `bson:"status"`
	}
	if err := cur.All(ctx, &invs); err != nil {
		return s, err
	}
	for _, i := range invs {
		s.invoices[i.ID.Hex()] = i.Status
	}
	cur, err = db.Collection("hostelsubscriptions").Find(ctx, bson.D{}, options.Find().SetProjection(bson.D{{Key: "status", Value: 1}, {Key: "currentPeriodEnd", Value: 1}}))
	if err != nil {
		return s, err
	}
	var subs []struct {
		ID     bson.ObjectID `bson:"_id"`
		Status string        `bson:"status"`
		End    *time.Time    `bson:"currentPeriodEnd"`
	}
	if err := cur.All(ctx, &subs); err != nil {
		return s, err
	}
	for _, x := range subs {
		end := ""
		if x.End != nil {
			end = x.End.UTC().Format(time.RFC3339)
		}
		s.subs[x.ID.Hex()] = x.Status + "|" + end
	}
	return s, nil
}

func diffState(a, b state) []string {
	var out []string
	if a.payments != b.payments {
		out = append(out, fmt.Sprintf("subscription payments %d → %d", a.payments, b.payments))
	}
	for id, st := range b.invoices {
		if a.invoices[id] != st {
			out = append(out, fmt.Sprintf("invoice %s %s → %s", id, a.invoices[id], st))
		}
	}
	for id, st := range b.subs {
		if a.subs[id] != st {
			out = append(out, fmt.Sprintf("subscription %s %s → %s", id, a.subs[id], st))
		}
	}
	sort.Strings(out)
	return out
}

func init() {
	if len(os.Args) > 1 && os.Args[1] == "shadow-phase8" {
		if err := shadowPhase8(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "shadow-phase8:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
}
