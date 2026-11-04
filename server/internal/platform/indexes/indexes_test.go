package indexes

import "testing"

func TestCatalogue(t *testing.T) {
	specs, err := Catalogue()
	if err != nil {
		t.Fatal(err)
	}
	if len(specs) < 300 {
		t.Fatalf("catalogue has %d indexes; dump-ts.mjs output looks truncated", len(specs))
	}
	seen := map[string]bool{}
	for _, s := range specs {
		k := s.Collection + "." + s.IndexName()
		if seen[k] {
			t.Errorf("%s declared twice", k)
		}
		seen[k] = true
	}
	// Names must be MongoDB's own default, or Ensure rebuilds what already exists.
	for _, want := range []string{"users.role_1_status_1", "subscriptionpayments.invoiceId_1_inReview"} {
		if !seen[want] {
			t.Errorf("missing %s", want)
		}
	}
}
