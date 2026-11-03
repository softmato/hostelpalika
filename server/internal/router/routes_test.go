package router

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
)

var (
	exportedMethod = regexp.MustCompile(`export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b`)
	exportList     = regexp.MustCompile(`export\s*\{([^}]*)\}`)
	exportDestruct = regexp.MustCompile(`export\s+const\s*\{([^}]*)\}\s*=`)
	listedMethod   = regexp.MustCompile(`(?:^|[\s,])(?:\w+\s+as\s+)?(GET|POST|PUT|PATCH|DELETE)\s*(?:,|$)`)
	ginParam       = regexp.MustCompile(`:[^/]+`)
)

// tsRoutes reads "METHOD /api/v1/path" from every route.ts, with every path
// param written as ":" so a renamed param is not a mismatch.
func tsRoutes(t *testing.T, root string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() != "route.ts" {
			return err
		}
		src, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, filepath.Dir(p))
		if err != nil {
			return err
		}
		path := "/api/v1"
		for _, s := range strings.Split(filepath.ToSlash(rel), "/") {
			switch {
			case s == ".":
			case strings.HasPrefix(s, "[..."):
				path += "/*"
			case strings.HasPrefix(s, "["):
				path += "/:"
			default:
				path += "/" + s
			}
		}
		for _, m := range exportedMethod.FindAllSubmatch(src, -1) {
			out[string(m[1])+" "+path] = true
		}
		for _, list := range append(exportList.FindAllSubmatch(src, -1), exportDestruct.FindAllSubmatch(src, -1)...) {
			for _, m := range listedMethod.FindAllSubmatch(list[1], -1) {
				out[string(m[1])+" "+path] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// goRoutes is every route the engine really serves, normalised like tsRoutes.
func goRoutes(r *gin.Engine) map[string]bool {
	out := map[string]bool{}
	for _, rt := range r.Routes() {
		path := ginParam.ReplaceAllString(rt.Path, ":")
		if i := strings.IndexByte(path, '*'); i >= 0 {
			path = path[:i] + "*"
		}
		out[rt.Method+" "+path] = true
	}
	return out
}

// TestRoutesMatchWeb is the "same paths as the web" check: a Go route with no
// route.ts behind it fails, so a typo in a path cannot ship. Routes Go has not
// ported yet are reported, not failed, until cut-over; set ROUTES_COMPLETE=1 to
// make them fail (the Phase 10 gate). Skipped once apps/web loses its routes.
func TestRoutesMatchWeb(t *testing.T) {
	root := "../../../apps/web/src/app/api/v1"
	if _, err := os.Stat(root); err != nil {
		t.Skip("no TS routes to compare with")
	}
	cfg, _, err := config.Parse(func(k string) (string, bool) { v, ok := contractEnv[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	// The driver dials lazily, so mounting every route needs no running Mongo.
	client, err := mongo.Connect(options.Client().ApplyURI(fixture.URI))
	if err != nil {
		t.Fatal(err)
	}
	r, err := New(cfg, Deps{DB: client.Database("routes_test")})
	if err != nil {
		t.Fatal(err)
	}
	ts, g := tsRoutes(t, root), goRoutes(r)
	if len(ts) < 500 {
		t.Fatalf("read only %d TS routes; the route.ts parser has broken", len(ts))
	}
	var missing, extra []string
	for k := range ts {
		if !g[k] {
			missing = append(missing, k)
		}
	}
	for k := range g {
		if !ts[k] && !goOnlyAllowed[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	t.Logf("TS routes %d, Go routes %d, not ported %d", len(ts), len(g), len(missing))
	if os.Getenv("ROUTES_LIST") != "" {
		if err := os.WriteFile(os.Getenv("ROUTES_LIST"), []byte(strings.Join(missing, "\n")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if len(extra) > 0 {
		t.Errorf("Go serves %d routes that have no route.ts:\n  %s", len(extra), strings.Join(extra, "\n  "))
	}
	if os.Getenv("ROUTES_COMPLETE") != "" && len(missing) > 0 {
		t.Errorf("%d TS routes not on Go:\n  %s", len(missing), strings.Join(missing, "\n  "))
	}
}

// goOnlyAllowed lists Go routes deliberately absent from TS, each with its reason.
var goOnlyAllowed = map[string]bool{
	// Gin needs explicit GET→405 handlers beside a POST-only static sibling of a
	// GET param route (MEMORY.md): each answers 405, as Next does on that path.
	"GET /api/v1/public/hostels/:/arriving":     true,
	"GET /api/v1/public/hostels/:/inquiries":    true,
	"GET /api/v1/public/hostels/impressions":    true,
	"GET /api/v1/public/hostels/quick-register": true,
	"GET /api/v1/public/hostels/register":       true,
}

// TestRouteBudgetsAreRoutes: a typo in routeBudgets would silently leave a long
// route on the default deadline.
func TestRouteBudgetsAreRoutes(t *testing.T) {
	cfg, _, err := config.Parse(func(k string) (string, bool) { v, ok := contractEnv[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	client, err := mongo.Connect(options.Client().ApplyURI(fixture.URI))
	if err != nil {
		t.Fatal(err)
	}
	r, err := New(cfg, Deps{DB: client.Database("routes_test")})
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, rt := range r.Routes() {
		have[rt.Path] = true
	}
	for path := range routeBudgets {
		if !have[path] {
			t.Errorf("routeBudgets names %s, which no route serves", path)
		}
	}
}
