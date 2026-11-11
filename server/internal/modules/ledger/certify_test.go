package ledger

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Owner rule D3/B6: approved claims and desk payments are certified, fee-off never.
func TestQualifiesForOfferProgram(t *testing.T) {
	inv := bson.NewObjectID()
	code := "RUP-001F-BHA83"
	cases := []struct {
		ev   Event
		want bool
	}{
		{Event{InvoiceID: &inv, Source: "RESIDENT_CLAIM", Confirmation: "MANUAL_REVIEW"}, true},
		{Event{InvoiceID: &inv, Source: "CASH_ENTRY", Confirmation: "MANUAL_REVIEW"}, true},
		{Event{Source: "CASH_ENTRY"}, false},
		{Event{InvoiceID: &inv, ReferenceCode: &code, Source: "GATEWAY_POLL", Confirmation: "GATEWAY_VERIFIED"}, true},
		{Event{InvoiceID: &inv, ReferenceCode: &code, Source: "STATEMENT_IMPORT", Confirmation: "STATEMENT_MATCH"}, true},
		{Event{InvoiceID: &inv, ReferenceCode: &code, Source: "OFFER_PROGRAM"}, false},
		{Event{InvoiceID: &inv, ReferenceCode: &code, Source: "ADJUSTMENT"}, false},
	}
	for i, tc := range cases {
		if got := qualifiesForOfferProgram(&tc.ev); got != tc.want {
			t.Errorf("case %d (%s) = %v, want %v", i, tc.ev.Source, got, tc.want)
		}
	}
}
