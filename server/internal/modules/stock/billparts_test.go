package stock

import "testing"

func TestBillParts(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	cases := []struct {
		name                string
		amount, disc, tax   *float64
		subtotal            float64
		allPriced           bool
		gross, wantD, wantT float64
	}{
		{"no total: lines − discount + tax", nil, f(50), f(20), 1000, true, 1000, 50, 20},
		{"total only, nothing priced", f(3000), nil, nil, 0, false, 3000, 0, 0},
		{"total under priced lines is a discount", f(3000), f(999), nil, 3100, true, 3100, 100, 0},
		{"total over priced lines is VAT", f(3130), nil, f(999), 3000, true, 3000, 0, 130},
		{"some unpriced: the gap is theirs", f(3000), nil, nil, 2500, false, 3000, 0, 0},
	}
	for _, c := range cases {
		gross, d, tx := billParts(c.amount, c.disc, c.tax, c.subtotal, c.allPriced)
		if gross != c.gross || d != c.wantD || tx != c.wantT {
			t.Errorf("%s: got %v %v %v, want %v %v %v", c.name, gross, d, tx, c.gross, c.wantD, c.wantT)
		}
		if c.amount != nil && gross-d+tx != *c.amount {
			t.Errorf("%s: total %v is not the bill total %v", c.name, gross-d+tx, *c.amount)
		}
	}
}
