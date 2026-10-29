package hostels

import (
	"bytes"
	"os"
	"testing"
)

// TestDemoHostelsCopy fails when the embedded copy drifts from the TS file.
func TestDemoHostelsCopy(t *testing.T) {
	ts, err := os.ReadFile("../../../../apps/web/src/modules/hostels/demo-hostels.json")
	if err != nil {
		t.Skip("TS tree not present")
	}
	if !bytes.Equal(ts, demoJSON) {
		t.Fatal("demo-hostels.json differs from apps/web/src/modules/hostels/demo-hostels.json: copy it again")
	}
}
