package hostelresidents

import "testing"

// A date typed into the deposit box was stored as Rs 500,020,260,515 (ch 23).
func TestReadRupeesBound(t *testing.T) {
	if v, ok := readRupees("500020260515"); ok || v != nil {
		t.Fatalf("a date in a money column read as %v", v)
	}
	if v, ok := readRupees("Rs 1,00,00,000"); !ok || v == nil || *v != maxRowRupees {
		t.Fatalf("Rs 1 crore refused: %v %v", v, ok)
	}
}
