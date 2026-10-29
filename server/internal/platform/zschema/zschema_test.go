package zschema_test

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/bytedance/sonic"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

// TestSiteConfigVectors parses every stored-value mutation TS parsed
// (testdata/vectors/siteconfig.json.gz) and must agree on success and on the
// exact bytes of the result, key order included.
func TestSiteConfigVectors(t *testing.T) {
	raw, err := os.ReadFile("../../modules/platformconfig/schemas.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Sections map[string]*zschema.Desc `json:"sections"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	for name, d := range file.Sections {
		if err := d.Prepare(); err != nil {
			t.Fatal(name, err)
		}
	}
	gz, err := os.ReadFile("../../../testdata/vectors/siteconfig.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(zr)
	var cases []struct {
		Section string          `json:"section"`
		Input   json.RawMessage `json:"input"`
		OK      bool            `json:"ok"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		in := ordered.Undefined
		if len(c.Input) > 0 {
			if in, err = ordered.FromJSON(c.Input); err != nil {
				t.Fatal(err)
			}
		}
		out, ok := file.Sections[c.Section].Parse(in)
		if ok != c.OK {
			t.Errorf("case %d (%s): ok = %v, want %v; input %.300s", i, c.Section, ok, c.OK, c.Input)
			continue
		}
		if !ok {
			continue
		}
		got, _ := sonic.ConfigDefault.Marshal(out)
		var want bytes.Buffer
		_ = json.Compact(&want, c.Data)
		if !bytes.Equal(got, want.Bytes()) {
			t.Errorf("case %d (%s):\n got  %.400s\n want %.400s", i, c.Section, got, want.Bytes())
		}
	}
}
