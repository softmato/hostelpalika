package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	platauth "github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
)

// recoverAdmin is recover-admin-account.mjs, plus what a recovery is for: the
// account's other sessions end and its old tokens stop verifying, in case
// whoever locked the owner out still holds one.
func recoverAdmin(ctx context.Context, e env, _ []string) error {
	addr := strings.ToLower(strings.TrimSpace(os.Getenv("ADMIN_RECOVERY_EMAIL")))
	password := os.Getenv("ADMIN_RECOVERY_PASSWORD")
	switch {
	case os.Getenv("ADMIN_RECOVERY_CONFIRM") != "YES":
		return errors.New("set ADMIN_RECOVERY_CONFIRM=YES to run admin account recovery")
	case addr == "":
		return errors.New("ADMIN_RECOVERY_EMAIL is required")
	case len(password) < 12:
		return errors.New("ADMIN_RECOVERY_PASSWORD must be at least 12 characters")
	}
	hash, err := platauth.HashPassword(password)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var u struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err = e.db.Collection("users").FindOneAndUpdate(ctx, bson.D{{Key: "email", Value: addr}, {Key: "role", Value: "SUPERADMIN"}},
		bson.D{
			{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: false}, {Key: "passwordHash", Value: hash}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedAt", Value: now}}},
			{Key: "$unset", Value: bson.D{{Key: "deletedAt", Value: ""}, {Key: "deletedBy", Value: ""}}},
			{Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}},
		}, options.FindOneAndUpdate().SetReturnDocument(options.After).SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return errors.New("no SUPERADMIN account matched ADMIN_RECOVERY_EMAIL")
	}
	if err != nil {
		return err
	}
	if err := platauth.NewSessions(e.db, e.cfg.Auth.RefreshTTL).RevokeAll(ctx, u.ID); err != nil {
		return fmt.Errorf("password reset, but ending old sessions failed: %w", err)
	}
	fmt.Printf("Platform owner recovery complete:\n  email: %s\n  password: value from ADMIN_RECOVERY_PASSWORD\n  every other session of this account has ended\n", addr)
	return nil
}

// envelopeSource is one place a finance envelope lives and the scope it was sealed under.
type envelopeSource struct {
	coll, label string
	filter      bson.D
	prefix      string // where the envelope's fields sit in the row ("" = the row itself)
	scope       func(row bson.Raw) (crypto.Scope, string)
}

func hexOf(row bson.Raw, key string) string {
	if id, ok := row.Lookup(key).ObjectIDOK(); ok {
		return id.Hex()
	}
	return ""
}

func strOf(row bson.Raw, keys ...string) string {
	s, _ := row.Lookup(keys...).StringValueOK()
	return s
}

var envelopeSources = []envelopeSource{
	{"encryptedsecrets", "gateway secret(s)", bson.D{}, "", func(r bson.Raw) (crypto.Scope, string) {
		p := strOf(r, "provider") + ":" + strOf(r, "purpose")
		return crypto.Scope{HostelID: hexOf(r, "hostelId"), Purpose: p}, p + " for hostel " + hexOf(r, "hostelId")
	}},
	// TS read every row and crashed on one with no number; only rows that have one hold an envelope.
	{"hostelpayoutaccounts", "payout account number(s)", bson.D{{Key: "number", Value: bson.D{{Key: "$exists", Value: true}}}}, "number", func(r bson.Raw) (crypto.Scope, string) {
		return crypto.Scope{HostelID: hexOf(r, "hostelId"), Purpose: "PAYOUT_ACCOUNT_NUMBER"}, "payout account for hostel " + hexOf(r, "hostelId")
	}},
	{"bookings", "booking refund account number(s)", bson.D{{Key: "refundAccount.number", Value: bson.D{{Key: "$exists", Value: true}}}}, "refundAccount.number", func(r bson.Raw) (crypto.Scope, string) {
		return crypto.Scope{HostelID: hexOf(r, "_id"), Purpose: "BOOKING_REFUND_ACCOUNT"}, "refund account on booking " + strOf(r, "code")
	}},
	{"hostelbackups", "Drive backup token(s)", bson.D{{Key: "drive.token", Value: bson.D{{Key: "$exists", Value: true}}}}, "drive.token", func(r bson.Raw) (crypto.Scope, string) {
		return crypto.Scope{HostelID: hexOf(r, "hostelId"), Purpose: "DRIVE_REFRESH_TOKEN"}, "Drive token for hostel " + hexOf(r, "hostelId")
	}},
}

// rotateFinanceKey is rotate-finance-master-key.mjs: every envelope's data key is
// rewrapped onto FINANCE_MASTER_KEY; the ciphertext is never touched, and an
// envelope no configured key opens is reported and left alone.
func rotateFinanceKey(ctx context.Context, e env, args []string) error {
	fs := flag.NewFlagSet("rotate-finance-key", flag.ContinueOnError)
	dry := fs.Bool("dry-run", false, "report what would be rewrapped, write nothing")
	if err := fs.Parse(args); err != nil {
		return err
	}
	logf := func(format string, a ...any) {
		if *dry {
			format = "[dry] " + format
		}
		fmt.Printf(format+"\n", a...)
	}
	keys, err := crypto.MasterKeys(e.cfg.Crypto.FinanceMasterKey, e.cfg.Crypto.FinanceMasterKeyPrev)
	if err != nil {
		return err
	}
	target := keys[0]
	if e.cfg.Crypto.FinanceMasterKeyPrev == "" {
		logf("FINANCE_MASTER_KEY_PREVIOUS is not set — only rows already readable by the current key can be rewrapped.")
	}
	var rewrapped, failed, remaining int64
	for _, src := range envelopeSources {
		coll := e.db.Collection(src.coll)
		at := func(field string) string {
			if src.prefix == "" {
				return field
			}
			return src.prefix + "." + field
		}
		stale := append(append(bson.D{}, src.filter...), bson.E{Key: at("keyId"), Value: bson.D{{Key: "$ne", Value: target.ID}}})
		cur, err := coll.Find(ctx, stale)
		if err != nil {
			return err
		}
		var n int64
		for cur.Next(ctx) {
			n++
			row := cur.Current
			raw := row
			if src.prefix != "" {
				doc, ok := row.Lookup(strings.Split(src.prefix, ".")...).DocumentOK()
				if !ok {
					continue
				}
				raw = doc
			}
			var envl crypto.Envelope
			if err := bson.Unmarshal(raw, &envl); err != nil {
				return err
			}
			scope, label := src.scope(row)
			next, err := crypto.RewrapSecret(envl, scope, keys, target)
			if err != nil {
				failed++
				logf("  ! %s is wrapped by %s, which is not configured. Left untouched.", label, envl.KeyID)
				continue
			}
			if !*dry {
				id := row.Lookup("_id")
				if _, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{
					{Key: at("keyId"), Value: next.KeyID}, {Key: at("wrappedKey"), Value: next.WrappedKey},
					{Key: at("wrappedKeyIv"), Value: next.WrappedKeyIV}, {Key: at("wrappedKeyTag"), Value: next.WrappedKeyTag}}}}); err != nil {
					cur.Close(ctx)
					return err
				}
			}
			rewrapped++
			logf("  ✓ %s", label)
		}
		if err := cur.Err(); err != nil {
			return err
		}
		cur.Close(ctx)
		logf("%d %s not wrapped by %s.", n, src.label, target.ID)
		if *dry {
			remaining += n
		} else if left, err := coll.CountDocuments(ctx, stale); err == nil {
			remaining += left
		} else {
			return err
		}
	}
	fmt.Printf("\nrewrapped               %d\nunreadable (left alone) %d\nstill on an old key     %d\n", rewrapped, failed, remaining)
	if failed > 0 {
		fmt.Println("\nSome envelopes could not be opened by any configured key. They were NOT deleted.\n" +
			"Find the master key that wrapped them, set it as FINANCE_MASTER_KEY_PREVIOUS, and re-run.\n" +
			"Until then those hostels cannot take gateway payments or be paid out.")
		return errFindings
	}
	if remaining == 0 && !*dry {
		fmt.Println("\nEverything is on the current key. FINANCE_MASTER_KEY_PREVIOUS can now be removed.")
	}
	return nil
}

// verifyFinanceLedger is verify-finance-ledger.mjs, with the per-invoice and
// per-hostel aggregations done as one grouped pass each.
func verifyFinanceLedger(ctx context.Context, e env, _ []string) error {
	const sampleLimit = 20
	var failures []string
	net := bson.D{
		{Key: "credit", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$direction", "CREDIT"}}}, "$amount", 0}}}}}},
		{Key: "debit", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$direction", "DEBIT"}}}, "$amount", 0}}}}}},
	}
	type sums struct {
		ID     any     `bson:"_id"`
		Credit float64 `bson:"credit"`
		Debit  float64 `bson:"debit"`
		Paid   float64 `bson:"paid"`
		Count  int64   `bson:"count"`
	}
	group := func(coll string, match bson.D, by string, fields bson.D) (map[string]sums, error) {
		cur, err := e.db.Collection(coll).Aggregate(ctx, mongo.Pipeline{{{Key: "$match", Value: match}},
			{{Key: "$group", Value: append(bson.D{{Key: "_id", Value: "$" + by}}, fields...)}}})
		if err != nil {
			return nil, err
		}
		var rows []sums
		if err := cur.All(ctx, &rows); err != nil {
			return nil, err
		}
		out := make(map[string]sums, len(rows))
		for _, r := range rows {
			out[fmt.Sprint(r.ID)] = r
		}
		return out, nil
	}

	// 1. Migration parity, while the legacy collection is still there.
	names, err := e.db.ListCollectionNames(ctx, bson.D{{Key: "name", Value: "payments"}})
	if err != nil {
		return err
	}
	legacyPresent := len(names) > 0
	type parity struct {
		hostel                string
		legacy, ledger, delta float64
	}
	var parityRows []parity
	if legacyPresent {
		legacy, err := group("payments", bson.D{}, "hostelId", bson.D{{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}, {Key: "paid", Value: bson.D{{Key: "$sum", Value: "$paidAmount"}}}})
		if err != nil {
			return err
		}
		ledger, err := group("paymentevents", bson.D{{Key: "status", Value: "SETTLED"}}, "hostelId", net)
		if err != nil {
			return err
		}
		cur, err := e.db.Collection("hostels").Find(ctx, bson.D{}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			return err
		}
		var hostels []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name string        `bson:"name"`
		}
		if err := cur.All(ctx, &hostels); err != nil {
			return err
		}
		for _, h := range hostels {
			l, g := legacy[fmt.Sprint(h.ID)], ledger[fmt.Sprint(h.ID)]
			paid := g.Credit - g.Debit
			if l.Count == 0 && paid == 0 {
				continue
			}
			p := parity{h.Name, l.Paid, paid, paid - l.Paid}
			parityRows = append(parityRows, p)
			if p.delta != 0 {
				failures = append(failures, fmt.Sprintf("PARITY  %s: legacy %v, ledger %v, Δ %v", h.Name, p.legacy, p.ledger, p.delta))
			}
		}
	}

	// 2. Conservation: every cached balance equals its settled events.
	// ponytail: the per-invoice totals sit in memory (one entry per invoice with
	// events); stream them sorted beside the balances if that ever grows too big.
	truth, err := group("paymentevents", bson.D{{Key: "status", Value: "SETTLED"}, {Key: "invoiceId", Value: bson.D{{Key: "$ne", Value: nil}}}}, "invoiceId", net)
	if err != nil {
		return err
	}
	cur, err := e.db.Collection("invoicebalances").Find(ctx, bson.D{}, options.Find().SetProjection(bson.D{{Key: "invoiceId", Value: 1}, {Key: "settledAmount", Value: 1}}))
	if err != nil {
		return err
	}
	var checked, drifted int64
	var samples []string
	for cur.Next(ctx) {
		var b struct {
			InvoiceID bson.ObjectID `bson:"invoiceId"`
			Settled   float64       `bson:"settledAmount"`
		}
		if err := cur.Decode(&b); err != nil {
			return err
		}
		checked++
		t := truth[fmt.Sprint(b.InvoiceID)]
		if settled := t.Credit - t.Debit; settled != b.Settled {
			drifted++
			if len(samples) < sampleLimit {
				samples = append(samples, fmt.Sprintf("invoice %s: cached %v, events %v", b.InvoiceID.Hex(), b.Settled, settled))
			}
		}
	}
	if err := cur.Err(); err != nil {
		return err
	}
	cur.Close(ctx)
	if drifted > 0 {
		failures = append(failures, fmt.Sprintf("DRIFT   %d of %d invoice balances disagree with their events", drifted, checked))
	}

	// 3. Integrality: money is whole rupees.
	fractional := func(coll, field string) (int64, error) {
		return e.db.Collection(coll).CountDocuments(ctx, bson.D{{Key: "$expr", Value: bson.D{{Key: "$and", Value: bson.A{
			bson.D{{Key: "$isNumber", Value: "$" + field}}, bson.D{{Key: "$ne", Value: bson.A{bson.D{{Key: "$mod", Value: bson.A{"$" + field, 1}}}, 0}}}}}}}})
	}
	checks := []struct{ label, coll, field string }{
		{"Invoice.totalAmount", "invoices", "totalAmount"},
		{"PaymentEvent.amount", "paymentevents", "amount"},
		{"InvoiceBalance.settledAmount", "invoicebalances", "settledAmount"},
	}
	integrality := make([]string, 0, len(checks))
	for _, c := range checks {
		n, err := fractional(c.coll, c.field)
		if err != nil {
			return err
		}
		integrality = append(integrality, fmt.Sprintf("%s %d", c.label, n))
		if n > 0 {
			failures = append(failures, fmt.Sprintf("AMOUNT  %d rows have a fractional %s", n, c.label))
		}
	}

	// 4. Suspense: settled money no invoice owns.
	suspense, err := group("paymentevents", bson.D{{Key: "invoiceId", Value: nil}, {Key: "status", Value: "SETTLED"}}, "invoiceId",
		bson.D{{Key: "paid", Value: bson.D{{Key: "$sum", Value: "$amount"}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}})
	if err != nil {
		return err
	}
	var susp sums
	for _, s := range suspense {
		susp = s
	}

	fmt.Println()
	switch {
	case !legacyPresent:
		fmt.Println("Parity: legacy `payments` collection removed — nothing to compare (post-2.8).")
	case len(parityRows) == 0:
		fmt.Println("Parity: no hostel has any ledger history yet.")
	default:
		fmt.Println("Hostel                                   legacy       ledger        Δ")
		fmt.Println("---------------------------------------------------------------------")
		for _, r := range parityRows {
			name := []rune(r.hostel)
			if len(name) > 34 {
				name = name[:34]
			}
			fmt.Printf("%-38s%11v%13v%9v\n", string(name), r.legacy, r.ledger, r.delta)
		}
	}
	fmt.Printf("\nConservation: %d balances checked, %d drifted.\n", checked, drifted)
	for _, s := range samples {
		fmt.Println("  " + s)
	}
	if drifted > int64(len(samples)) {
		fmt.Printf("  … and %d more.\n", drifted-int64(len(samples)))
	}
	fmt.Printf("Integrality: %s.\n", strings.Join(integrality, ", "))
	fmt.Printf("Suspense: %d settled events unassigned to an invoice, NPR %v.\n\n", susp.Count, susp.Paid)
	if len(failures) > 0 {
		for _, f := range failures {
			fmt.Fprintln(os.Stderr, f)
		}
		fmt.Fprintf(os.Stderr, "\n%d finding(s). This is evidence, not a repair job — find what wrote where it should not have before touching any of it.\n", len(failures))
		return errFindings
	}
	fmt.Println("All ledger invariants hold.")
	return nil
}
