package pdfin

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
)

func TestText(t *testing.T) {
	if _, err := exec.LookPath("pdftotext"); err != nil {
		t.Skip("pdftotext not installed")
	}
	ctx := context.Background()
	// Written by pdf-lib (TS), two pages.
	sample, _ := os.ReadFile("../../../testdata/golden/pdf/text-sample.pdf")
	text, err := Text(ctx, sample)
	for _, want := range []string{"eSewa Transaction Receipt", "NPR 1,500.00", "0A1B2C3D", "Bhadra rent"} {
		if err != nil || !strings.Contains(text, want) {
			t.Fatalf("missing %q in %q (%v)", want, text, err)
		}
	}
	// Written by our own writer.
	d := pdf.New()
	d.Text(50, 700, "Receipt HP-7KQ2 — NPR 12,000", pdf.Regular, 12, pdf.ColorText)
	b, _ := d.Bytes()
	if text, err := Text(ctx, b); err != nil || !strings.Contains(text, "HP-7KQ2") {
		t.Fatalf("%q %v", text, err)
	}
	for _, bad := range [][]byte{nil, []byte("not a pdf"), []byte("%PDF-1.7 truncated")} {
		if _, err := Text(ctx, bad); err != ErrNoText {
			t.Errorf("%q: %v", bad, err)
		}
	}
}
