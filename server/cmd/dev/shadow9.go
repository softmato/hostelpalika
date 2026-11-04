package main

// shadow-phase9 is Phase 9's gate (PHASES.md): each scheduled job runs once on
// TS and once on Go, over two identical copies of live data, and what each
// answered and wrote is compared.
//
//   1. The live-data copy (deploy/copy-live-db.ps1) is cloned into hp_shadow_ts
//      and hp_shadow_go on the local Mongo.
//   2. TS runs on :3100 against hp_shadow_ts (testdata/jobs/shadow-ts.sh); Go
//      runs here, in-process, through the same router as the API, against
//      hp_shadow_go. Both block every outbound host and log what was tried.
//   3. Each job's door is posted to TS, then to Go. Their answers and every
//      collection are compared after each job; only drift new since the
//      previous job is reported against it.
//
// Run from the repo root (the root .env supplies the same keys TS reads):
//
//	bash server/testdata/jobs/shadow-ts.sh   # in another terminal
//	server/bin/dev.exe shadow-phase9
//
// Only a local database is accepted.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/jobs"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/router"
)

const shadowSecret = "shadow-cron-secret"

// Written by only one side, so never compared.
var shadowSkip = map[string]bool{jobs.Collection: true, "serverlogs": true}

// blocked refuses every non-local host for Go, like block-outbound.cjs for TS.
type blocked struct {
	real  http.RoundTripper
	mu    sync.Mutex
	hosts map[string]int
}

func (b *blocked) RoundTrip(r *http.Request) (*http.Response, error) {
	h := r.URL.Hostname()
	if h == "localhost" || h == "127.0.0.1" || h == "::1" {
		return b.real.RoundTrip(r)
	}
	b.mu.Lock()
	b.hosts[h]++
	b.mu.Unlock()
	return nil, fmt.Errorf("shadow: outbound blocked (%s)", h)
}

func shadowPhase9(args []string) error {
	fs := flag.NewFlagSet("shadow-phase9", flag.ExitOnError)
	host := fs.String("mongo", "mongodb://127.0.0.1:27018", "the local Mongo holding the live-data copy")
	src := fs.String("src", "hostelpalika_dev", "the live-data copy's database")
	tsBase := fs.String("ts", "http://localhost:3100", "the TS server reading hp_shadow_ts")
	only := fs.String("jobs", "", "comma-separated job names (default: every scheduled job)")
	noClone := fs.Bool("no-clone", false, "keep the shadow databases as they are")
	_ = fs.Parse(args)
	if !strings.HasPrefix(*host, "mongodb://127.0.0.1") && !strings.HasPrefix(*host, "mongodb://localhost") {
		return fmt.Errorf("refusing %q: the shadow only runs on a local copy", *host)
	}
	ctx := context.Background()
	client, _, err := appmongo.Connect(ctx, *host+"/"+*src+"?directConnection=true")
	if err != nil {
		return err
	}
	defer func() { _ = client.Disconnect(ctx) }()
	tsDB, goDB := client.Database("hp_shadow_ts"), client.Database("hp_shadow_go")
	if !*noClone {
		for _, dst := range []*mongo.Database{tsDB, goDB} {
			if err := cloneDB(ctx, client.Database(*src), dst); err != nil {
				return err
			}
		}
		fmt.Println("cloned", *src, "→ hp_shadow_ts, hp_shadow_go")
	}

	// The same keys TS reads, outbound off, Go on its own copy.
	for k, v := range map[string]string{"APP_ENV": "development", "APP_URL": "http://localhost:3000", "CRON_SECRET": shadowSecret,
		"MONGODB_URI": *host + "/hp_shadow_go?directConnection=true", "REDIS_URL": ""} {
		_ = os.Setenv(k, v)
	}
	for _, k := range []string{"RESEND_API_KEY", "PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER", "EXPO_ACCESS_TOKEN",
		"SOFTMATO_BASE_URL", "SOFTMATO_SECRET", "SOFTMATO_WEBHOOK_SECRET", "GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_MAPS_API_KEY",
		"R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_PUBLIC", "R2_BUCKET_PRIVATE", "R2_PUBLIC_URL", "VAPID_PRIVATE_KEY",
		"NEXT_PUBLIC_VAPID_PUBLIC_KEY", "GEMINI_API_KEYS", "GROQ_API_KEYS", "OPENROUTER_API_KEYS", "MISTRAL_API_KEYS", "CEREBRAS_API_KEYS"} {
		_ = os.Setenv(k, "")
	}
	block := &blocked{real: http.DefaultTransport, hosts: map[string]int{}}
	http.DefaultTransport = block
	http.DefaultClient.Transport = block
	cfg, _, err := config.Load()
	if err != nil {
		return err
	}
	runner := jobs.New(ctx, goDB, nil)
	handler, err := router.New(cfg, router.Deps{DB: goDB, Jobs: runner})
	if err != nil {
		return err
	}

	names := map[string]bool{}
	for _, n := range strings.Split(*only, ",") {
		if n = strings.TrimSpace(n); n != "" {
			names[n] = true
		}
	}
	start := time.Now()
	before, err := drift(ctx, tsDB, goDB, start)
	if err != nil {
		return err
	}
	if len(before) > 0 {
		return fmt.Errorf("the two copies differ before any job ran (%d lines); re-run without -no-clone", len(before))
	}
	seen := map[string]bool{}
	tsClient := &http.Client{Timeout: 6 * time.Minute, Transport: &http.Transport{}}
	failed := 0
	type step struct{ job, label, body string }
	var steps []step
	for _, j := range runner.Jobs() {
		if len(names) > 0 && !names[j.Name] {
			continue
		}
		if j.Schedule != "" {
			steps = append(steps, step{j.Name, j.Name, ""})
			continue
		}
		// platform-backup runs only from its door, with the workflow's report.
		steps = append(steps,
			step{j.Name, j.Name + " (backup)", `{"kind":"BACKUP","manifest":{"bytes":123456,"collections":{"hostels":26,"invoices":154},"createdAt":"2026-11-04T00:00:00.000Z","file":"backup-2026-11-04.archive.gz","sha256":"ab12"}}`},
			step{j.Name, j.Name + " (drill)", `{"kind":"DRILL","ok":false,"manifest":{"collections":{"hostels":26},"file":"drill.gz"},"mismatches":[{"actual":25,"collection":"hostels","expected":26}]}`},
			step{j.Name, j.Name + " (invalid)", `{"kind":"NOPE","manifest":{"collections":{"a":-1}}}`})
	}
	for _, st := range steps {
		path := "/api/v1/cron/" + st.job
		tsCode, tsBody, err := post(tsClient, *tsBase+path, st.body)
		if err != nil {
			return fmt.Errorf("%s on TS: %w", st.label, err)
		}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(st.body))
		req.Header.Set("x-cron-secret", shadowSecret)
		req.Header.Set("content-type", "application/json")
		handler.ServeHTTP(rec, req)
		goBody, _ := io.ReadAll(rec.Body)

		lines, err := drift(ctx, tsDB, goDB, start)
		if err != nil {
			return err
		}
		var fresh []string
		for _, l := range lines {
			if !seen[l] {
				seen[l] = true
				fresh = append(fresh, l)
			}
		}
		answer := ""
		if tsCode != rec.Code || maskBody(tsBody) != maskBody(goBody) {
			answer = fmt.Sprintf("\n    TS %d %s\n    Go %d %s", tsCode, trim(tsBody), rec.Code, trim(goBody))
		}
		verdict := "same"
		if answer != "" || len(fresh) > 0 {
			verdict, failed = "DRIFT", failed+1
		}
		fmt.Printf("%-34s %s (TS %d, Go %d)%s\n", st.label, verdict, tsCode, rec.Code, answer)
		for _, l := range fresh {
			fmt.Println("    db:", l)
		}
	}
	tried, _ := os.ReadFile("server/testdata/jobs/outbound.log")
	fmt.Printf("\noutbound blocked — Go: %v; TS log:\n%s", block.hosts, tried)
	if failed > 0 {
		return fmt.Errorf("%d job(s) drifted", failed)
	}
	fmt.Println("zero drift")
	return nil
}

func post(c *http.Client, url, body string) (int, []byte, error) {
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("x-cron-secret", shadowSecret)
	req.Header.Set("content-type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close() //nolint:errcheck // read-only
	b, err := io.ReadAll(res.Body)
	return res.StatusCode, b, err
}

func trim(b []byte) string {
	if len(b) > 600 {
		return string(b[:600]) + "…"
	}
	return string(b)
}

var (
	isoRe = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z`)
	oidRe = regexp.MustCompile(`"[0-9a-f]{24}"`)
)

// maskBody compares answers with instants and ids masked; key order is kept,
// since both servers write it.
func maskBody(b []byte) string {
	var v map[string]any
	if json.Unmarshal(b, &v) == nil {
		delete(v, "meta") // timings
		b, _ = json.Marshal(v)
	}
	return oidRe.ReplaceAllString(isoRe.ReplaceAllString(string(b), "<t>"), `"<id>"`)
}

// cloneDB replaces dst with a copy of src, collection by collection.
func cloneDB(ctx context.Context, src, dst *mongo.Database) error {
	if err := dst.Drop(ctx); err != nil {
		return err
	}
	names, err := src.ListCollectionNames(ctx, bson.D{{Key: "type", Value: "collection"}})
	if err != nil {
		return err
	}
	for _, n := range names {
		if strings.HasPrefix(n, "system.") {
			continue
		}
		cur, err := src.Collection(n).Aggregate(ctx, mongo.Pipeline{{{Key: "$out", Value: bson.D{{Key: "db", Value: dst.Name()}, {Key: "coll", Value: n}}}}})
		if err != nil {
			return fmt.Errorf("clone %s: %w", n, err)
		}
		_ = cur.Close(ctx)
	}
	return nil
}

// drift lists every difference between the two copies, sorted, with ids and
// instants created during the shadow masked.
func drift(ctx context.Context, a, b *mongo.Database, start time.Time) ([]string, error) {
	seen := map[string]bool{}
	var names []string
	for _, db := range []*mongo.Database{a, b} {
		ns, err := db.ListCollectionNames(ctx, bson.D{})
		if err != nil {
			return nil, err
		}
		for _, n := range ns {
			if !seen[n] && !shadowSkip[n] && !strings.HasPrefix(n, "system.") {
				seen[n] = true
				names = append(names, n)
			}
		}
	}
	sort.Strings(names)
	var out []string
	for _, n := range names {
		ta, na, err := snapshot(ctx, a.Collection(n), start)
		if err != nil {
			return nil, err
		}
		tb, nb, err := snapshot(ctx, b.Collection(n), start)
		if err != nil {
			return nil, err
		}
		for id, da := range ta {
			if db, ok := tb[id]; !ok {
				out = append(out, fmt.Sprintf("%s %s only on TS", n, id))
			} else if da != db {
				out = append(out, fmt.Sprintf("%s %s\n        TS %s\n        Go %s", n, id, da, db))
			}
		}
		for id := range tb {
			if _, ok := ta[id]; !ok {
				out = append(out, fmt.Sprintf("%s %s only on Go", n, id))
			}
		}
		// Rows made during the shadow have new ids on each side: compared as a multiset.
		count := map[string]int{}
		for _, d := range na {
			count[d]++
		}
		for _, d := range nb {
			count[d]--
		}
		for d, c := range count {
			switch {
			case c > 0:
				out = append(out, fmt.Sprintf("%s new row only on TS (×%d) %s", n, c, d))
			case c < 0:
				out = append(out, fmt.Sprintf("%s new row only on Go (×%d) %s", n, -c, d))
			}
		}
	}
	sort.Strings(out)
	return out, nil
}

// snapshot is a collection's rows that existed before the shadow, by id, and
// the rows it made, each as masked canonical JSON.
func snapshot(ctx context.Context, c *mongo.Collection, start time.Time) (map[string]string, []string, error) {
	cur, err := c.Find(ctx, bson.D{})
	if err != nil {
		return nil, nil, err
	}
	var docs []bson.D
	if err := cur.All(ctx, &docs); err != nil {
		return nil, nil, err
	}
	old := map[string]string{}
	var made []string
	for _, d := range docs {
		var id any
		for _, e := range d {
			if e.Key == "_id" {
				id = e.Value
			}
		}
		masked := mask(d, start)
		raw, _ := bson.MarshalExtJSON(masked, true, false)
		if oid, ok := id.(bson.ObjectID); ok && !oid.Timestamp().Before(start.Truncate(time.Second)) {
			made = append(made, string(raw))
			continue
		}
		old[fmt.Sprint(id)] = string(raw)
	}
	return old, made, nil
}

// mask replaces ids minted and instants written during the shadow: both sides
// make them a few seconds apart. Later instants (next runs) keep their minute.
func mask(v any, start time.Time) any {
	switch x := v.(type) {
	case bson.D:
		out := make(bson.D, 0, len(x))
		for _, e := range x {
			out = append(out, bson.E{Key: e.Key, Value: mask(e.Value, start)})
		}
		sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })
		return out
	case bson.A:
		out := make(bson.A, len(x))
		for i, e := range x {
			out[i] = mask(e, start)
		}
		return out
	case bson.ObjectID:
		if !x.Timestamp().Before(start.Truncate(time.Second)) {
			return "<new id>"
		}
	case bson.DateTime:
		t := x.Time()
		if !t.Before(start) {
			if t.Before(time.Now().Add(time.Minute)) {
				return "<now>"
			}
			return t.UTC().Truncate(time.Minute).Format(time.RFC3339)
		}
	}
	return v
}

func init() {
	if len(os.Args) > 1 && os.Args[1] == "shadow-phase9" {
		if err := shadowPhase9(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "shadow-phase9:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
}
