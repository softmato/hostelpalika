package email

import (
	"encoding/json"
	"maps"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestEveryTemplateMatchesTS replays testdata/vectors/emails-all.json: every TS
// template, called with inputs built from its own parameter type, must come out
// of the Go template byte for byte (category, subject, html).
func TestEveryTemplateMatchesTS(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/emails-all.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string         `json:"name"`
		Input map[string]any `json:"input"`
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
		got, ok, panicked := call(strings.TrimSuffix(v.Name, "Email"), v.Input)
		if panicked != nil {
			t.Errorf("vector %d %s: the Go call panicked: %v", i, v.Name, panicked)
			continue
		}
		if !ok {
			t.Errorf("vector %d: no Go template for %s", i, v.Name)
			continue
		}
		if string(got.Category) != v.Out.Category || got.Subject != v.Out.Subject || got.HTML != v.Out.HTML {
			t.Errorf("vector %d %s: category %q/%q subject %q/%q\n%s", i, v.Name, got.Category, v.Out.Category,
				got.Subject, v.Out.Subject, firstDiff(got.HTML, v.Out.HTML))
		}
	}
}

// call tries the hand-written cases, then the adapters, then byName.
func call(name string, in map[string]any) (got Content, ok bool, panicked any) {
	defer func() { panicked = recover() }()
	if got, ok = handWritten(name, in); !ok {
		if got, ok = adapted(name, in); !ok {
			got, ok = byName(name, in)
		}
	}
	return got, ok, nil
}

// byName calls the template whose Go parameters are named like the TS input's
// keys (case aside); a struct parameter the input has no key for takes the
// whole input.
func byName(name string, in map[string]any) (Content, bool) {
	tpl, ok := templateTable[name]
	if !ok {
		return Content{}, false
	}
	fn := reflect.ValueOf(tpl.fn)
	args := make([]reflect.Value, len(tpl.params))
	for i, p := range tpl.params {
		pt := fn.Type().In(i)
		arg := reflect.New(pt).Elem()
		raw, found := lookupFold(in, p)
		if path, ok := aliases[name][p]; ok {
			raw, found = lookupPath(in, path)
		}
		if !found && pt.Kind() == reflect.Struct && pt != reflect.TypeOf(time.Time{}) {
			raw, found = in, true
		}
		if found {
			setFrom(arg, raw)
		}
		args[i] = arg
	}
	return fn.Call(args)[0].Interface().(Content), true
}

func lookupFold(in map[string]any, key string) (any, bool) {
	for k, v := range in {
		if strings.EqualFold(k, key) {
			return v, true
		}
	}
	return nil, false
}

// setFrom puts a decoded JSON value into a Go parameter of any type.
func setFrom(arg reflect.Value, raw any) {
	if raw == nil {
		return
	}
	switch {
	case arg.Type() == reflect.TypeOf(time.Time{}):
		if s, ok := raw.(string); ok {
			tm, _ := time.Parse(time.RFC3339Nano, s)
			arg.Set(reflect.ValueOf(tm))
		}
	case arg.Kind() == reflect.String:
		switch x := raw.(type) {
		case string:
			arg.SetString(x)
		case float64:
			arg.SetString(strconv.FormatFloat(x, 'f', -1, 64))
		}
	case arg.Kind() == reflect.Pointer:
		arg.Set(reflect.New(arg.Type().Elem()))
		setFrom(arg.Elem(), raw)
	case arg.Kind() == reflect.Slice:
		list, _ := raw.([]any)
		arg.Set(reflect.MakeSlice(arg.Type(), len(list), len(list)))
		for i, item := range list {
			setFrom(arg.Index(i), item)
		}
	case arg.Kind() == reflect.Struct:
		// Field by field, so a TS number lands in a Go string field (a percent
		// the caller formats) and nested facts find their keys case aside.
		m, _ := raw.(map[string]any)
		for i := range arg.NumField() {
			f := arg.Type().Field(i)
			key := strings.Split(f.Tag.Get("json"), ",")[0]
			if key == "" {
				key = f.Name
			}
			if v, ok := lookupFold(m, key); ok && f.IsExported() {
				setFrom(arg.Field(i), v)
			}
		}
	default:
		b, _ := json.Marshal(raw)
		_ = json.Unmarshal(b, arg.Addr().Interface())
	}
}

// aliases name, per template, the TS input path a Go parameter reads when the
// names differ ("a.b" walks into an object).
var aliases = map[string]map[string]string{
	"bookingConfirmed":         {"b": "booking"},
	"bookingEnded":             {"b": "booking"},
	"bookingMoveInReminder":    {"b": "booking"},
	"bookingPaymentRejected":   {"b": "booking"},
	"bookingPaymentVerified":   {"b": "booking"},
	"bookingProofReceived":     {"b": "booking"},
	"bookingRefundSent":        {"b": "booking"},
	"cookCredentials":          {"login": "credentials.email", "password": "credentials.temporaryPassword"},
	"cookPortalEnabled":        {"login": "credentials.email", "password": "credentials.temporaryPassword"},
	"credentialsIssued":        {"addr": "email"},
	"hostelApproved":           {"creds": "credentials", "cook": "cookCredentials"},
	"hostelDocumentsRequested": {"docs": "documents"},
	"hostelKycApproved":        {"agreementRef": "agreementRefCode", "cook": "cookCredentials"},
	"hostelVerified":           {"creds": "credentials", "supportPhone": "free.supportPhone", "selectedPlan": "selectedPlanName"},
	"newComplaint":             {"kind": "type"},
	"paymentRejected":          {"reason": "rejectionReason"},
	"paymentReversed":          {"outstanding": "outstandingAmount"},
	"paymentVerified":          {"remaining": "remainingAmount"},
	"payoutAccountChanged":     {"a": "account"},
	"payoutAccountReviewed":    {"a": "account"},
	"residentAccessCleared":    {"memberships": "clearedMemberships"},
	"settingChangeConfirm":     {"label": "settingLabel"},
	"subscriptionInvoice":      {"actionLabel": "action.label", "actionURL": "action.url"},
}

func lookupPath(in map[string]any, path string) (any, bool) {
	var cur any = in
	for _, k := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[k]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// adapted holds the templates whose Go parameter is computed from the TS input.
func adapted(name string, in map[string]any) (Content, bool) {
	s := func(k string) string { x, _ := in[k].(string); return x }
	b := func(k string) bool { x, _ := in[k].(bool); return x }
	switch name {
	case "existingResidentAdded": // Go's input flattens activation{url, expiresOn}
		flat := maps.Clone(in)
		if a, ok := in["activation"].(map[string]any); ok {
			flat["activationUrl"], flat["activationExpiresOn"] = a["url"], a["expiresOn"]
		}
		return byName(name, flat)
	case "ownerEmailChanged":
		return OwnerEmailChanged(s("hostelName"), s("loginUrl"), s("newEmail"), s("previousEmail"), s("recipient") == "previous", b("google"), s("temporaryPassword")), true
	case "sosAlert":
		at, _ := time.Parse(time.RFC3339Nano, s("triggeredAt"))
		return SOSAlert(s("actionUrl"), s("hostelName"), s("message"), s("recipientKind") == "GUARDIAN", s("residentName"), s("residentPhone"), at), true
	}
	return Content{}, false
}

// firstDiff shows where two HTML bodies part.
func firstDiff(got, want string) string {
	i := 0
	for i < len(got) && i < len(want) && got[i] == want[i] {
		i++
	}
	lo := max(0, i-80)
	return "got  " + strconv.Quote(got[lo:min(len(got), i+100)]) + "\nwant " + strconv.Quote(want[lo:min(len(want), i+100)])
}
