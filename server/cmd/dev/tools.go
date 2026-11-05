package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	platauth "github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// The developer tools the TS server kept as npm scripts (PARITY.md §10):
//
//	dev generate-vapid                          (generate-vapid-keys.mjs)
//	dev mint-session [--role ROLE] [email]      (dev-mint-session.mjs)
//	dev send-test-emails <address> [--category c] [--dry-run]   (send-test-emails.ts)
func init() {
	if len(os.Args) < 2 {
		return
	}
	var err error
	switch os.Args[1] {
	case "generate-vapid":
		err = generateVAPID()
	case "mint-session":
		err = withDB(mintSession)
	case "send-test-emails":
		err = withDB(sendTestEmails)
	default:
		return
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "dev %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
	os.Exit(0)
}

// generateVAPID prints a Web Push key pair in the form web-push uses: the P-256
// public point uncompressed and the private scalar, both base64url without padding.
func generateVAPID() error {
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	enc := base64.RawURLEncoding.EncodeToString
	fmt.Print("Add these to the repo root .env (see .env.example):\n\n" +
		"NEXT_PUBLIC_VAPID_PUBLIC_KEY=" + enc(key.PublicKey().Bytes()) + "\n" +
		"VAPID_PRIVATE_KEY=" + enc(key.Bytes()) + "\n" +
		"VAPID_SUBJECT=mailto:support@softmato.com\n\n" +
		"The private key is a credential. It never belongs in the repo, in a\nscreenshot, or in a NEXT_PUBLIC_ variable.\n")
	return nil
}

func withDB(fn func(ctx context.Context, cfg *config.Config, db *mongo.Database, args []string) error) error {
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	mc, db, err := appmongo.Connect(ctx, cfg.MongoURI)
	if err != nil {
		return err
	}
	defer func() { _ = mc.Disconnect(context.Background()) }()
	return fn(ctx, cfg, db, os.Args[2:])
}

// mintSession signs in as a real user of a non-production database: a live
// session row and a pair of tokens, printed as the cookies to paste.
func mintSession(ctx context.Context, cfg *config.Config, db *mongo.Database, args []string) error {
	if cfg.IsProduction() {
		return errors.New("refusing to mint a session against a production environment")
	}
	fs := flag.NewFlagSet("mint-session", flag.ContinueOnError)
	role := fs.String("role", "", "pick the first live user with this role")
	if err := fs.Parse(args); err != nil {
		return err
	}
	filter := bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}
	if addr := fs.Arg(0); strings.Contains(addr, "@") {
		filter = bson.D{{Key: "email", Value: strings.ToLower(addr)}}
	} else if *role != "" {
		filter = append(filter, bson.E{Key: "role", Value: *role})
	}
	var u struct {
		ID        bson.ObjectID   `bson:"_id"`
		Name      string          `bson:"name"`
		Email     string          `bson:"email"`
		Role      string          `bson:"role"`
		HostelIDs []bson.ObjectID `bson:"hostelIds"`
	}
	if err := db.Collection("users").FindOne(ctx, filter).Decode(&u); err != nil {
		return fmt.Errorf("no user matched %v: %w", filter, err)
	}
	sessions := platauth.NewSessions(db, 30*24*time.Hour)
	sess := sessions.New(u.ID, nil, "", "")
	ids := make([]string, len(u.HostelIDs))
	for i, id := range u.HostelIDs {
		ids[i] = id.Hex()
	}
	in := platauth.TokenInput{UserID: u.ID.Hex(), Role: u.Role, HostelIDs: ids, SessionID: sess.ID.Hex()}
	tokens := platauth.NewTokens(cfg.Auth.AccessSecret, cfg.Auth.RefreshSecret, 12*time.Hour, 30*24*time.Hour)
	access, err := tokens.SignAccess(in)
	if err != nil {
		return err
	}
	refresh, err := tokens.SignRefresh(in)
	if err != nil {
		return err
	}
	if err := sessions.Insert(ctx, sess, refresh); err != nil {
		return err
	}
	fmt.Printf("\nUser:  %s <%s>\nRole:  %s\nId:    %s\n\nPaste into the browser console on the target origin:\n\n", u.Name, u.Email, u.Role, u.ID.Hex())
	fmt.Printf("document.cookie='%s=%s;path=/';document.cookie='%s=%s;path=/';location.reload()\n", platauth.AccessCookie, access, platauth.RefreshCookie, refresh)
	return nil
}

// sendTestEmails sends one sample per mailbox through the real sender and the
// saved identity, to check each From and Reply-To end to end.
func sendTestEmails(ctx context.Context, cfg *config.Config, db *mongo.Database, args []string) error {
	fs := flag.NewFlagSet("send-test-emails", flag.ContinueOnError)
	only := fs.String("category", "", "one mailbox only")
	dry := fs.Bool("dry-run", false, "show the headers, send nothing")
	var to string
	rest := args
	for len(rest) > 0 { // the address may come before or after the flags
		if err := fs.Parse(rest); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			break
		}
		to, rest = fs.Arg(0), fs.Args()[1:]
	}
	if !strings.Contains(to, "@") {
		return errors.New("usage: dev send-test-emails <address> [--category <name>] [--dry-run]")
	}
	categories := []email.Category{email.Info, email.Alert, email.Billing, email.Security, email.Support, email.NoReply}
	if *only != "" {
		if !slices.Contains(categories, email.Category(*only)) {
			return fmt.Errorf("unknown category %q", *only)
		}
		categories = []email.Category{email.Category(*only)}
	}
	const hostel = "Test Hostel (email check)"
	sample := func(c email.Category) email.Content {
		switch c {
		case email.Alert:
			return email.SOSAlert("https://example.test/hostel-admin/sos", hostel, "This is a test alert. Nobody is in danger.", false, "Test Resident", "+977-98XXXXXXXX", time.Now())
		case email.Billing:
			return email.PaymentVerified(8500, "", hostel, time.Now().Format("2006-01"), "https://example.test/resident/offer-program", "https://example.test/resident/payments", "TEST-0001", 0, "Test Resident")
		case email.Security:
			return email.OTPCode("123456", 10, "", "")
		case email.Support:
			return email.ComplaintResolved("https://example.test/resident/complaints", hostel, "This is a test. No complaint was filed.", "Test complaint")
		case email.NoReply:
			return email.Content{Category: email.NoReply, Subject: "Test — no-reply mailbox", HTML: email.EmailLayout(email.Layout{Heading: "No-reply test",
				BodyHTML: email.Paragraph("Machine mail with no reply path. If this arrived, the no-reply mailbox sends correctly.")})}
		}
		return email.ResidentNewNotice("This is a test notice sent to check the general mailbox.", "General", hostel, false, "https://example.test/resident/notices", "Test notice")
	}
	sender := email.NewSender(cfg.Email.ResendAPIKey, cfg.Email.Domain, cfg.Email.ReplyTo, db)
	id := sender.Identity(ctx)
	key := "MISSING"
	if cfg.Email.ResendAPIKey != "" {
		key = "present"
	}
	mode := "sending"
	if *dry {
		mode = "dry run — nothing will be sent"
	}
	fmt.Printf("\nTo:        %s\nResend key %s\nMode:      %s\n\n", to, key, mode)
	failures := 0
	for _, c := range categories {
		content := sample(c)
		from, replyTo := id.From(c), id.ReplyToFor(c)
		if replyTo == "" {
			replyTo = "(no reply address)"
		}
		if *dry {
			fmt.Printf("  %-9s from:     %s\n  %9s reply-to: %s\n  %9s subject:  %s\n\n", c, from, "", replyTo, "", content.Subject)
			continue
		}
		r := sender.Send(ctx, email.Message{Category: c, To: []string{to}, Subject: content.Subject, HTML: content.HTML})
		if r.Sent {
			fmt.Printf("  ✓ %-9s %s\n  %11s reply-to: %s\n", c, from, "", replyTo)
			continue
		}
		failures++
		fmt.Fprintf(os.Stderr, "  ✗ %-9s %s\n    %s\n", c, r.Reason, r.Detail)
	}
	if failures > 0 {
		return fmt.Errorf("%d of %d failed", failures, len(categories))
	}
	if *dry {
		fmt.Println("\nDry run complete.")
	} else {
		fmt.Printf("\nAll %d sent.\n", len(categories))
	}
	return nil
}
