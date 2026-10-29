package export

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCSVVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/csv.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cells []struct {
			Value      any
			Cell, Text string
		}
		Date      struct{ At, Cell string }
		Table     string
		SafeNames []struct{ Name, Safe string }
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cells {
		if got := Cell(c.Value); got != c.Cell {
			t.Errorf("cell %#v: %q != %q", c.Value, got, c.Cell)
		}
		if got := CellText(c.Value); got != c.Text {
			t.Errorf("text %#v: %q != %q", c.Value, got, c.Text)
		}
	}
	at, _ := time.Parse(time.RFC3339, v.Date.At)
	if got := Cell(at); got != v.Date.Cell {
		t.Errorf("date cell %q != %q", got, v.Date.Cell)
	}
	got := CSV([]Column{{"name", "Name"}, {"amount", "Amount, NPR"}}, []map[string]any{{"name": "Sita", "amount": 1500.0}, {"name": "=cmd", "amount": nil}})
	if got != v.Table {
		t.Errorf("table %q != %q", got, v.Table)
	}
	for _, c := range v.SafeNames {
		if got := SafeEntryName(c.Name); got != c.Safe {
			t.Errorf("safe %q: %q != %q", c.Name, got, c.Safe)
		}
	}
}

func TestZipStreams(t *testing.T) {
	var buf bytes.Buffer
	files := map[string]string{"a/receipt.pdf": "%PDF-1.7", "नेपाल.txt": "hello"}
	err := Zip(&buf, func(yield func(Entry) bool) {
		for _, name := range []string{"a/receipt.pdf", "नेपाल.txt"} {
			body := files[name]
			if !yield(Entry{Name: name, Date: time.Date(2026, 10, 29, 10, 0, 0, 0, time.UTC), Open: func() (io.ReadCloser, error) {
				return io.NopCloser(strings.NewReader(body)), nil
			}}) {
				return
			}
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	r, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil || len(r.File) != 2 {
		t.Fatal(err)
	}
	for _, f := range r.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		if string(b) != files[f.Name] || f.Method != zip.Store {
			t.Errorf("%s: %q", f.Name, b)
		}
	}
}
