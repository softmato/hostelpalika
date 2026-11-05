// Command ops is the operator toolbox the TS server kept as npm scripts
// (PARITY.md §10). It reads the API's own environment (config.Load), so the
// production guards apply unchanged. In the image:
//
//	docker compose run --rm --entrypoint ops api <command> [flags]
//
// Commands: recover-admin, rotate-finance-key, verify-finance-ledger,
// check-private-documents, sync-plan-services, check-softmato.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

type env struct {
	cfg *config.Config
	db  *mongo.Database
}

var commands = map[string]struct {
	help string
	run  func(ctx context.Context, e env, args []string) error
}{
	"recover-admin":           {"reset a SUPERADMIN's password (ADMIN_RECOVERY_EMAIL, _PASSWORD, _CONFIRM=YES)", recoverAdmin},
	"rotate-finance-key":      {"rewrap every finance envelope onto FINANCE_MASTER_KEY [-dry-run]", rotateFinanceKey},
	"verify-finance-ledger":   {"parity, conservation, integrality and suspense checks over the ledger", verifyFinanceLedger},
	"check-private-documents": {"every private document points at a live, private file asset [-strict-missing]", checkPrivateDocuments},
	"sync-plan-services":      {"add shipped plan services to the saved Plans config [-dry-run] slug...", syncPlanServices},
	"check-softmato":          {"end-to-end check against a LOCAL Softmato and this API [-api URL]", checkSoftmato},
}

func main() {
	if len(os.Args) < 2 || commands[os.Args[1]].run == nil {
		fmt.Fprintln(os.Stderr, "usage: ops <command> [flags]")
		names := make([]string, 0, len(commands))
		for n := range commands {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			fmt.Fprintf(os.Stderr, "  %-24s %s\n", n, commands[n].help)
		}
		os.Exit(2)
	}
	name := os.Args[1]
	if err := run(name, os.Args[2:]); err != nil {
		fmt.Fprintf(os.Stderr, "ops %s: %v\n", name, err)
		os.Exit(1)
	}
}

func run(name string, args []string) error {
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()
	mc, db, err := appmongo.Connect(ctx, cfg.MongoURI)
	if err != nil {
		return err
	}
	defer func() { _ = mc.Disconnect(context.Background()) }()
	return commands[name].run(ctx, env{cfg, db}, args)
}

// errFindings ends a check that ran to the end and found something: exit 1,
// the report already printed.
var errFindings = errors.New("findings above")
