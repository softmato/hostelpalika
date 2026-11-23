package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// dev demo — data and calendar moves for the demo videos (demo-video.md §6).
// MISSION.md addition 6: it writes to production, but only to Himalaya Boys
// Hostel (HH-BA1F794D). Every row it writes carries demoSeed: true, it sends no
// email, push or SMS, and `dev demo unseed` takes it all back out.
//
//	dev demo inspect <collection> [json filter]   read-only, scoped to the demo hostel
//	dev demo seed-history | unseed                 the lived-in hostel (demo_seed.go)
//	dev demo <scenario> | restore                  time states for the takes (demo_scenarios.go)
//	dev demo fix-data                              the 2026-11-23 one-off repair (demo_scenarios.go)
//
// The database is the repo root .env's MONGODB_URI (production): server/.env
// points at the local dev Mongo, which has no demo hostel.
const (
	demoSlug   = "himalaya-boys-hostel-2"
	demoCode   = "ba1f794d" // HH-BA1F794D = the last 8 hex of the hostel's _id (hostel-code.ts)
	demoMarkey = "demoSeed"
)

func init() {
	if len(os.Args) < 3 || os.Args[1] != "demo" {
		return
	}
	if err := runDemo(os.Args[2], os.Args[3:]); err != nil {
		fmt.Fprintf(os.Stderr, "dev demo %s: %v\n", os.Args[2], err)
		os.Exit(1)
	}
	os.Exit(0)
}

// demo is what every subcommand gets: the database and the one hostel it may touch.
type demo struct {
	db     *mongo.Database
	hostel bson.ObjectID
	owner  bson.ObjectID
	name   string
	prefix string
}

func runDemo(cmd string, args []string) error {
	uri, err := rootEnv("MONGODB_URI")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	mc, db, err := appmongo.Connect(ctx, uri)
	if err != nil {
		return err
	}
	defer func() { _ = mc.Disconnect(context.Background()) }()
	d, err := loadDemo(ctx, db)
	if err != nil {
		return err
	}
	switch cmd {
	case "inspect":
		return d.inspect(ctx, args)
	case "seed-history":
		return d.seedHistory(ctx)
	case "unseed":
		if err := d.restore(ctx); err != nil {
			return err
		}
		return d.unseed(ctx)
	case "rent-due-soon":
		return d.rentDueSoon(ctx)
	case "rent-overdue":
		return d.rentOverdue(ctx)
	case "month-roll":
		return d.monthRoll(ctx)
	case "trial-ending":
		return d.trialEnding(ctx)
	case "trial-ended":
		return d.trialEnded(ctx)
	case "plan-past-due":
		return d.planPastDue(ctx)
	case "seed-bookings":
		return d.seedBookings(ctx)
	case "statement-file":
		return d.statementFile(ctx, args)
	case "check":
		return d.check(ctx)
	case "restore":
		return d.restore(ctx)
	case "fix-data":
		return d.fixData(ctx)
	}
	return fmt.Errorf("unknown subcommand %q", cmd)
}

// rootEnv reads one key from the repo root .env (server/.. when run from server/).
func rootEnv(key string) (string, error) {
	for _, p := range []string{filepath.Join("..", ".env"), ".env"} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), key+"="); ok && strings.Contains(v, ".mongodb.net") {
				_ = f.Close()
				return strings.Trim(v, `"'`), nil
			}
		}
		_ = f.Close()
	}
	return "", errors.New(key + " for Atlas not found in ../.env")
}

// loadDemo finds the demo hostel and refuses to go on unless both its slug and
// its HH- code match: the hard guard every subcommand runs behind.
func loadDemo(ctx context.Context, db *mongo.Database) (*demo, error) {
	var h struct {
		ID     bson.ObjectID `bson:"_id"`
		Name   string        `bson:"name"`
		Slug   string        `bson:"slug"`
		Owner  bson.ObjectID `bson:"ownerId"`
		Prefix string        `bson:"referencePrefix"`
	}
	if err := db.Collection("hostels").FindOne(ctx, bson.D{{Key: "slug", Value: demoSlug}}).Decode(&h); err != nil {
		return nil, fmt.Errorf("demo hostel %s: %w", demoSlug, err)
	}
	if err := checkDemoHostel(h.ID, h.Slug); err != nil {
		return nil, err
	}
	return &demo{db: db, hostel: h.ID, owner: h.Owner, name: h.Name, prefix: h.Prefix}, nil
}

func checkDemoHostel(id bson.ObjectID, slug string) error {
	if slug != demoSlug || !strings.HasSuffix(id.Hex(), demoCode) {
		return fmt.Errorf("refusing hostel %s (%s): dev demo only touches %s, HH-%s", id.Hex(), slug, demoSlug, strings.ToUpper(demoCode))
	}
	return nil
}

func (d *demo) inspect(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: dev demo inspect <collection> [json filter] [limit]")
	}
	filter := bson.M{}
	if len(args) > 1 && args[1] != "" {
		if err := bson.UnmarshalExtJSON([]byte(args[1]), false, &filter); err != nil {
			return err
		}
	}
	if args[0] == "hostels" {
		filter["_id"] = d.hostel
	} else if args[0] != "users" {
		filter["hostelId"] = d.hostel
	}
	limit := int64(5)
	if len(args) > 2 {
		_, _ = fmt.Sscan(args[2], &limit)
	}
	cur, err := d.db.Collection(args[0]).Find(ctx, filter, options.Find().SetLimit(limit).SetSort(bson.D{{Key: "_id", Value: -1}}))
	if err != nil {
		return err
	}
	var rows []bson.M
	if err := cur.All(ctx, &rows); err != nil {
		return err
	}
	n, _ := d.db.Collection(args[0]).CountDocuments(ctx, filter)
	fmt.Printf("%s: %d match, showing %d\n", args[0], n, len(rows))
	for _, r := range rows {
		b, _ := bson.MarshalExtJSON(r, false, false)
		var pretty any
		_ = json.Unmarshal(b, &pretty)
		out, _ := json.Marshal(pretty)
		fmt.Println(string(out))
	}
	return nil
}
