// Command indexes builds every index the database needs: the TS schemas'
// declared indexes (internal/platform/indexes/catalogue.json) plus the Go-only
// collections. Only ever creates; an undeclared index is listed, never dropped.
// Run after a deploy that adds an index, and once on a fresh database:
//
//	indexes            # create what is missing
//	indexes -dry-run   # list what would be created
//
// Reads the same env as the API (config.Load), so it refuses Atlas outside production.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/softmato/hostelpalika/server/internal/jobs"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/indexes"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
	"github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

func main() {
	dry := flag.Bool("dry-run", false, "list what would be created, write nothing")
	flag.Parse()
	if err := run(*dry); err != nil {
		fmt.Fprintln(os.Stderr, "indexes:", err)
		os.Exit(1)
	}
}

func run(dry bool) error {
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	specs, err := indexes.Catalogue()
	if err != nil {
		return err
	}
	specs = append(specs, jobs.IndexSpecs...)
	specs = append(specs, applog.IndexSpecs...)

	// A unique index over a big collection can take a while; the cap stops a hung cluster holding the deploy.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	mc, db, err := mongo.Connect(ctx, cfg.MongoURI)
	if err != nil {
		return err
	}
	defer func() { _ = mc.Disconnect(context.Background()) }()

	res, err := indexes.Ensure(ctx, db, specs, dry)
	verb := "created"
	if dry {
		verb = "would create"
	}
	for _, n := range res.Created {
		fmt.Println(verb, n)
	}
	for _, n := range res.Extra {
		fmt.Println("not declared, left alone:", n)
	}
	for _, f := range res.Failed {
		fmt.Fprintln(os.Stderr, "failed:", f)
	}
	if err != nil {
		return err
	}
	if len(res.Failed) > 0 {
		return fmt.Errorf("%d index(es) failed; a unique index usually fails on rows that already break it", len(res.Failed))
	}
	fmt.Printf("%d declared, %d %s.\n", len(specs), len(res.Created), verb)
	return nil
}
