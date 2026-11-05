package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"slices"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

var objectIDRe = regexp.MustCompile(`^[a-fA-F0-9]{24}$`)

// checkPrivateDocuments is check-private-documents.mjs: every private document
// row must point at an ACTIVE, non-PUBLIC file asset.
func checkPrivateDocuments(ctx context.Context, e env, args []string) error {
	fs := flag.NewFlagSet("check-private-documents", flag.ContinueOnError)
	strict := fs.Bool("strict-missing", os.Getenv("PRIVATE_DOCUMENT_CHECK_STRICT_MISSING") == "true", "a missing asset is a failure, not a warning")
	if err := fs.Parse(args); err != nil {
		return err
	}
	refs := []struct{ coll, field, label string }{
		{"hosteldocuments", "fileAssetId", "hostel document"},
		{"residentdocuments", "fileAssetId", "resident document"},
		{"serviceproviderdocuments", "fileAssetId", "service provider document"},
		{"paymentproofs", "proofImageAssetId", "payment proof"},
		{"complaintattachments", "fileAssetId", "complaint attachment"},
		{"roomconditionphotos", "fileAssetId", "room condition photo"},
	}
	assets := e.db.Collection("fileassets")
	var violations, warnings []string
	for _, src := range refs {
		cur, err := e.db.Collection(src.coll).Find(ctx, bson.D{{Key: src.field, Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}}},
			{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}})
		if err != nil {
			return err
		}
		for cur.Next(ctx) {
			ref := cur.Current.Lookup(src.field)
			var filter bson.D
			if id, ok := ref.ObjectIDOK(); ok {
				filter = bson.D{{Key: "_id", Value: id}}
			} else if s, ok := ref.StringValueOK(); ok && objectIDRe.MatchString(s) {
				id, _ := bson.ObjectIDFromHex(s)
				filter = bson.D{{Key: "_id", Value: id}}
			} else if ok {
				filter = bson.D{{Key: "key", Value: s}}
			}
			where := fmt.Sprintf("%s %s", src.label, cur.Current.Lookup("_id").ObjectID().Hex())
			var asset struct {
				ID          bson.ObjectID `bson:"_id"`
				AccessLevel string        `bson:"accessLevel"`
				Status      string        `bson:"status"`
				IsDeleted   bool          `bson:"isDeleted"`
			}
			err := mongo.ErrNoDocuments
			if filter != nil {
				err = assets.FindOne(ctx, filter).Decode(&asset)
			}
			if errors.Is(err, mongo.ErrNoDocuments) {
				msg := fmt.Sprintf("%s references missing file asset %s.", where, ref.String())
				if *strict {
					violations = append(violations, msg)
				} else {
					warnings = append(warnings, msg)
				}
				continue
			}
			if err != nil {
				cur.Close(ctx)
				return err
			}
			if asset.AccessLevel == "PUBLIC" {
				violations = append(violations, fmt.Sprintf("%s points to PUBLIC file asset %s.", where, asset.ID.Hex()))
			}
			if asset.Status != "ACTIVE" || asset.IsDeleted {
				violations = append(violations, fmt.Sprintf("%s points to inactive/deleted file asset %s.", where, asset.ID.Hex()))
			}
		}
		if err := cur.Err(); err != nil {
			return err
		}
		cur.Close(ctx)
	}
	for _, w := range warnings {
		fmt.Fprintln(os.Stderr, "WARN: "+w)
	}
	if len(violations) > 0 {
		for _, v := range violations {
			fmt.Fprintln(os.Stderr, "FAIL: "+v)
		}
		return fmt.Errorf("private document check failed with %d violation(s)", len(violations))
	}
	fmt.Println("Private document check passed.")
	return nil
}

// syncPlanServices is sync-plan-services.mjs: services shipped in the defaults
// but missing from the saved Plans config are added, each after the last service
// of its module, only when named, and only if the result still parses.
func syncPlanServices(ctx context.Context, e env, args []string) error {
	fs := flag.NewFlagSet("sync-plan-services", flag.ContinueOnError)
	dry := fs.Bool("dry-run", false, "show what would be added, save nothing")
	if err := fs.Parse(args); err != nil {
		return err
	}
	wanted := fs.Args()
	settings := e.db.Collection("platformsettings")
	var record struct {
		ID    bson.ObjectID `bson:"_id"`
		Value bson.RawValue `bson:"value"`
	}
	err := settings.FindOne(ctx, bson.D{{Key: "key", Value: "plans"}}).Decode(&record)
	if errors.Is(err, mongo.ErrNoDocuments) {
		fmt.Println("No saved Plans config: the live site already serves the defaults, every service included.")
		return nil
	}
	if err != nil {
		return err
	}
	parsed, ok := platformconfig.Parse("plans", ordered.FromBSON(record.Value))
	if !ok {
		fmt.Println("The saved Plans config fails its own schema, so the live site is serving the defaults already.")
		return nil
	}
	catalog := parsed.(ordered.Map)
	list := func(m ordered.Map, key string) []ordered.Map {
		v, _ := m.Get(key)
		raw, _ := v.([]any)
		out := make([]ordered.Map, 0, len(raw))
		for _, x := range raw {
			if om, ok := x.(ordered.Map); ok {
				out = append(out, om)
			}
		}
		return out
	}
	str := func(m ordered.Map, key string) string { v, _ := m.Get(key); s, _ := v.(string); return s }
	services := list(catalog, "services")
	live := map[string]bool{}
	for _, s := range services {
		live[str(s, "slug")] = true
	}
	var missing []ordered.Map
	for _, s := range list(platformconfig.Default("plans").(ordered.Map), "services") {
		if !live[str(s, "slug")] {
			missing = append(missing, s)
		}
	}
	if len(missing) == 0 {
		fmt.Println("Every default service is already on the live site.")
	} else {
		fmt.Println("In the code but not on the live site:")
		for _, s := range missing {
			fmt.Printf("  %s — %s (%s)\n", str(s, "slug"), str(s, "name"), str(s, "plan"))
		}
	}
	if len(wanted) == 0 {
		if len(missing) > 0 {
			fmt.Println("\nName the ones to add, e.g.  sync-plan-services inventory-management")
		}
		return nil
	}
	has := func(key, id string) bool {
		return slices.ContainsFunc(list(catalog, key), func(m ordered.Map) bool { return str(m, "id") == id })
	}
	var adding []ordered.Map
	for _, slug := range wanted {
		i := slices.IndexFunc(missing, func(m ordered.Map) bool { return str(m, "slug") == slug })
		switch {
		case i < 0 && live[slug]:
			fmt.Printf("%s: already on the live site, left as it is\n", slug)
		case i < 0:
			fmt.Printf("%s: not a default service\n", slug)
		case !has("modules", str(missing[i], "module")):
			fmt.Printf("%s: the live site has no %q module — skipped\n", slug, str(missing[i], "module"))
		case !has("plans", str(missing[i], "plan")):
			fmt.Printf("%s: the live site has no %q plan — skipped\n", slug, str(missing[i], "plan"))
		default:
			adding = append(adding, missing[i])
		}
	}
	if len(adding) == 0 {
		return nil
	}
	for _, s := range adding {
		at := 0
		for i, x := range services {
			if str(x, "module") == str(s, "module") {
				at = i + 1
			}
		}
		services = slices.Insert(services, at, s)
	}
	asAny := make([]any, len(services))
	for i, s := range services {
		asAny[i] = s
	}
	next, ok := platformconfig.Parse("plans", catalog.Set("services", asAny))
	if !ok {
		return errors.New("not saved — the result fails the Plans schema")
	}
	fmt.Println()
	for _, s := range adding {
		module := str(s, "module")
		if i := slices.IndexFunc(list(catalog, "modules"), func(m ordered.Map) bool { return str(m, "id") == module }); i >= 0 {
			module = str(list(catalog, "modules")[i], "name")
		}
		fmt.Printf("+ %s — %s, %s plan, /plans-pricing/%s\n", str(s, "name"), module, str(s, "plan"), str(s, "slug"))
	}
	if *dry {
		fmt.Println("\nDry run: nothing saved.")
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := settings.UpdateOne(ctx, bson.D{{Key: "_id", Value: record.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}, {Key: "value", Value: next}}}}); err != nil {
		return err
	}
	slugs := make(bson.A, len(adding))
	for i, s := range adding {
		slugs[i] = str(s, "slug")
	}
	if _, err := e.db.Collection("auditlogs").InsertOne(ctx, bson.D{{Key: "action", Value: "PLATFORM_SITE_CONFIG_UPDATED"}, {Key: "actorId", Value: nil},
		{Key: "actorType", Value: "SYSTEM"}, {Key: "createdAt", Value: now}, {Key: "entityId", Value: "plans"}, {Key: "entityType", Value: "PlatformSetting"},
		{Key: "metadata", Value: bson.D{{Key: "addedServices", Value: slugs}, {Key: "section", Value: "plans"}}}, {Key: "updatedAt", Value: now}}); err != nil {
		return fmt.Errorf("saved, but the audit row failed: %w", err)
	}
	fmt.Println("\nSaved. The API and the app see it within a minute.")
	return nil
}
