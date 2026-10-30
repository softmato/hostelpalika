// Command dev holds developer tools.
//
//	go run ./cmd/dev record -base http://localhost:3000 testdata/contract/health/health.json
//
// record sends each case's request to a TS server and writes back the response
// TS gave (TESTING.md §3). Point -base at a TS server running against the
// local test Mongo, never at production, for any route that touches data;
// public read-only routes with no data (health) may be recorded from the live site.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/contract"
	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

func main() {
	// mint prints a contract-secret token for a fixture spec (see fixture.Mint).
	if len(os.Args) == 3 && os.Args[1] == "mint" {
		t, ok := fixture.Mint(os.Args[2])
		if !ok {
			os.Exit(1)
		}
		fmt.Println(t)
		return
	}
	if len(os.Args) < 2 || os.Args[1] != "record" {
		fmt.Fprintln(os.Stderr, "usage: dev record -base URL [-fixture] case.json...")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("record", flag.ExitOnError)
	base := fs.String("base", "http://localhost:3000", "TS server base URL")
	baseline := fs.String("baseline", "", "git SHA of the TS code being recorded (PARITY.md baseline)")
	withFixture := fs.Bool("fixture", false, "reset the contract database (fixture.URI) before each file; the TS server must be reading it")
	_ = fs.Parse(os.Args[2:]) // ExitOnError: never returns an error
	for _, path := range fs.Args() {
		if *withFixture {
			if err := resetFixture(); err != nil {
				fmt.Fprintln(os.Stderr, "fixture:", err)
				os.Exit(1)
			}
		}
		if err := record(*base, *baseline, path); err != nil {
			fmt.Fprintln(os.Stderr, "record:", err)
			os.Exit(1)
		}
	}
}

func resetFixture() error {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, fixture.URI)
	if err != nil {
		return err
	}
	defer func() { _ = client.Disconnect(ctx) }()
	return fixture.Reset(ctx, db)
}

func record(base, baseline, path string) error {
	cases, err := contract.Load(path)
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout: 60 * time.Second, // next dev compiles a route on its first hit
		// Record redirects as TS answers them, don't follow them.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	vars := map[string]string{}
	for i := range cases {
		c := &cases[i]
		method, reqPath, headers, raw := c.Request.Prepare(vars)
		var body io.Reader
		if raw != nil {
			body = bytes.NewReader(raw)
		}
		req, err := http.NewRequestWithContext(context.Background(), method, strings.TrimRight(base, "/")+reqPath, body)
		if err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		out, err := io.ReadAll(res.Body)
		_ = res.Body.Close() // fully read
		if err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		cookies := res.Header.Values("Set-Cookie")
		c.Response = &contract.Response{Status: res.StatusCode, ContentType: res.Header.Get("Content-Type"), SetCookie: contract.NormalizeCookies(cookies)}
		if loc := res.Header.Get("Location"); loc != "" {
			c.Response.Location = contract.PathAndQuery(loc)
		}
		if json.Valid(out) {
			c.Response.Body = out
		}
		contract.Collect(*c, cookies, out, vars)
		c.Recorded = strings.TrimSpace(base + " " + baseline)
		fmt.Printf("%s %s %s → %d\n", c.Name, c.Request.Method, c.Request.Path, res.StatusCode)
	}
	return contract.Save(path, cases)
}
