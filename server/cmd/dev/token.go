package main

// token prints an access token for a user on the local database, for k6 runs
// (testdata/k6/load.js). Signed with this env's JWT_ACCESS_SECRET; config.Load
// refuses Atlas outside production, so it never mints against live accounts.
//
//	MONGODB_URI=... bin/dev.exe token demo.resident@softmato.com

import (
	"context"
	"fmt"
	"os"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

func init() {
	if len(os.Args) != 3 || os.Args[1] != "token" {
		return
	}
	if err := printToken(os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "token:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func printToken(email string) error {
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	mc, db, err := appmongo.Connect(ctx, cfg.MongoURI)
	if err != nil {
		return err
	}
	defer func() { _ = mc.Disconnect(ctx) }()
	var u struct {
		ID        bson.ObjectID   `bson:"_id"`
		Role      string          `bson:"role"`
		HostelIDs []bson.ObjectID `bson:"hostelIds"`
	}
	if err := db.Collection("users").FindOne(ctx, bson.D{{Key: "email", Value: email}}).Decode(&u); err != nil {
		return fmt.Errorf("%s: %w", email, err)
	}
	ids := make([]string, len(u.HostelIDs))
	for i, h := range u.HostelIDs {
		ids[i] = h.Hex()
	}
	t := auth.NewTokens(cfg.Auth.AccessSecret, cfg.Auth.RefreshSecret, 4*time.Hour, time.Hour)
	tok, err := t.SignAccess(auth.TokenInput{UserID: u.ID.Hex(), Role: u.Role, HostelIDs: ids})
	if err != nil {
		return err
	}
	fmt.Println(tok)
	return nil
}
