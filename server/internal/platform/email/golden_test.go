package email

import (
	"encoding/json"
	"os"
	"testing"
)

// TestTemplatesMatchTS replays testdata/vectors/emails.json: every template
// output must equal the TS template's, byte for byte.
func TestTemplatesMatchTS(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/emails.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
		Out   struct {
			Category string `json:"category"`
			Subject  string `json:"subject"`
			HTML     string `json:"html"`
		} `json:"out"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		var in map[string]any
		_ = json.Unmarshal(v.Input, &in)
		s := func(k string) string { x, _ := in[k].(string); return x }
		var got Content
		switch v.Name {
		case "hostelInquiryReceived":
			got = HostelInquiryReceived(s("dashboardUrl"), s("hostelName"), s("message"), s("preferredVisitDate"), s("visitorEmail"), s("visitorName"), s("visitorPhone"))
		case "newHostelPending":
			got = NewHostelPending(s("city"), s("hostelName"), s("ownerEmail"), s("ownerName"), s("queueUrl"))
		case "hostelPortalOpen":
			days, _ := in["trialDays"].(float64)
			got = HostelPortalOpen(s("hostelName"), s("kycUrl"), s("ownerName"), int(days), s("trialEndsOn"))
		case "hostelSubmissionReceived":
			got = HostelSubmissionReceived(s("hostelName"), s("ownerName"))
		default:
			t.Fatalf("vector %d: no Go template for %q", i, v.Name)
		}
		if string(got.Category) != v.Out.Category || got.Subject != v.Out.Subject || got.HTML != v.Out.HTML {
			t.Errorf("vector %d (%s %s): category %q/%q subject %q/%q html equal=%v", i, v.Name, v.Input,
				got.Category, v.Out.Category, got.Subject, v.Out.Subject, got.HTML == v.Out.HTML)
		}
	}
}
