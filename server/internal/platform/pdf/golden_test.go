package pdf

import (
	"os"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/platform/pdf/pdftest"
)

// The same page testdata/vectors/generate.ts draws through layout.ts and pdf-lib.
func TestCursorMatchesTS(t *testing.T) {
	d := New()
	c := NewCursor(d)
	c.Eyebrow(AtX, MarginLeft, "Payment receipt")
	c.Title(AtX, MarginLeft, "Receipt")
	c.Title(Center, 0, "Centred title")
	c.Stamp("Paid", StampOptions{})
	c.Line(Right, 0, "Education Light Hostel", Style{Font: Bold, Size: SizeIssuer})
	c.Rule(RuleOptions{})
	c.Field("Received from", "Sita Sharma", FieldOptions{})
	c.Field("Amount", "NPR 12,000.00", FieldOptions{Suffix: "incl. fine"})
	mono := MonoBold
	c.Field("Reference", "HP-7KQ2-9XWM", FieldOptions{ValueFont: &mono, ValueColor: &ColorAccent})
	c.RuleStrong()
	c.Line(AtX, MarginLeft, "Amount in words: Twelve Thousand Rupees Only — “paid” in full", Style{Size: SizeFootnote})
	got, err := d.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("../../../testdata/golden/pdf/cursor.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if diff := pdftest.Diff(got, want, 0.05); diff != "" {
		t.Errorf("differs from the TS golden:\n%s", diff)
	}
}
