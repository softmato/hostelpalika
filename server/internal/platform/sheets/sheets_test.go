package sheets

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// sheets.json: workbooks SheetJS wrote, and what SheetJS reads back from them.
func TestReadsLikeSheetJS(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/sheets.json")
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]struct {
		File   string
		Path   string // a real export in the repo, read from disk
		Sheets []struct {
			Name string
			Rows [][]string
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for kind, c := range v {
		b, _ := base64.StdEncoding.DecodeString(c.File)
		if c.Path != "" {
			if b, err = os.ReadFile("../../../../" + c.Path); err != nil {
				t.Fatal(err)
			}
		}
		got, err := Read(b, 0)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if len(got) != len(c.Sheets) {
			t.Fatalf("%s: %d sheets", kind, len(got))
		}
		for i, want := range c.Sheets {
			if got[i].Name != want.Name || len(got[i].Rows) != len(want.Rows) {
				t.Errorf("%s %s: %d rows, want %d", kind, want.Name, len(got[i].Rows), len(want.Rows))
				continue
			}
			for r := range want.Rows {
				if !reflect.DeepEqual(got[i].Rows[r], want.Rows[r]) {
					t.Errorf("%s %s row %d:\n got %q\nwant %q", kind, want.Name, r, got[i].Rows[r], want.Rows[r])
				}
			}
		}
	}
	if _, err := Read([]byte("hello"), 0); err == nil {
		t.Error("garbage read as a workbook")
	}
}

func TestWriteRoundTrip(t *testing.T) {
	b, err := Write([]WriteSheet{
		{Name: "About", Rows: [][]any{{"Hostel", "Education Light"}}},
		{Name: "Residents", Rows: [][]any{{"Name", "Paid"}, {"Sita", 1500}, {"Ram", nil}}, AutoFilter: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Read(b, 0)
	if err != nil || len(got) != 2 || !reflect.DeepEqual(got[1].Rows, [][]string{{"Name", "Paid"}, {"Sita", "1500"}, {"Ram", ""}}) {
		t.Fatalf("%v %+v", err, got)
	}
}
