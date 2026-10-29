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
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "record" {
		fmt.Fprintln(os.Stderr, "usage: dev record -base URL case.json...")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("record", flag.ExitOnError)
	base := fs.String("base", "http://localhost:3000", "TS server base URL")
	baseline := fs.String("baseline", "", "git SHA of the TS code being recorded (PARITY.md baseline)")
	_ = fs.Parse(os.Args[2:]) // ExitOnError: never returns an error
	for _, path := range fs.Args() {
		if err := record(*base, *baseline, path); err != nil {
			fmt.Fprintln(os.Stderr, "record:", err)
			os.Exit(1)
		}
	}
}

func record(base, baseline, path string) error {
	cases, err := contract.Load(path)
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout: 30 * time.Second,
		// Record redirects as TS answers them, don't follow them.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	for i := range cases {
		c := &cases[i]
		var body io.Reader
		if len(c.Request.Body) > 0 {
			body = bytes.NewReader(c.Request.Body)
		}
		req, err := http.NewRequestWithContext(context.Background(), c.Request.Method, strings.TrimRight(base, "/")+c.Request.Path, body)
		if err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range c.Request.Headers {
			req.Header.Set(k, v)
		}
		res, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		raw, err := io.ReadAll(res.Body)
		_ = res.Body.Close() // fully read
		if err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		c.Response = &contract.Response{Status: res.StatusCode, ContentType: res.Header.Get("Content-Type")}
		if json.Valid(raw) {
			c.Response.Body = raw
		}
		c.Recorded = strings.TrimSpace(base + " " + baseline)
		fmt.Printf("%s %s %s → %d\n", c.Name, c.Request.Method, c.Request.Path, res.StatusCode)
	}
	return contract.Save(path, cases)
}
