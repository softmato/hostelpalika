package finance

import (
	"os"
	"testing"
)

func TestStatementFixtures(t *testing.T) {
	want := map[string]int{"esewa-statement.csv": 5, "esewa-statement-app-export.csv": 6, "esewa-statement-app-export.xls": 6, "esewa-statement-app-export.xlsx": 6, "khalti-statement.csv": 3, "khalti-transaction-history.xlsx": 2, "bank-statement.csv": 5}
	cases := map[string]string{
		"esewa-statement.csv": "ESEWA", "esewa-statement-app-export.csv": "ESEWA", "esewa-statement-app-export.xls": "ESEWA",
		"esewa-statement-app-export.xlsx": "ESEWA", "khalti-statement.csv": "KHALTI", "khalti-transaction-history.xlsx": "KHALTI", "bank-statement.csv": "BANK",
	}
	for f, prov := range cases {
		b, err := os.ReadFile("testdata/statements/" + f)
		if err != nil {
			t.Fatal(err)
		}
		p, err := ResolveStmtParser(prov, b)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		tb, err := ReadStmtTable(b, p.Anchors)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		rows, err := p.Parse(tb)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if len(rows) != want[f] {
			t.Errorf("%s: %d rows, want %d", f, len(rows), want[f])
		}
	}
}
