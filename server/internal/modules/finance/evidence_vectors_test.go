package finance

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/pdf/pdftest"
)

func vector(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile("../../../testdata/vectors/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatal(err)
	}
}

func str(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Every reader against evidence-*.ts on the same text, NBSP and Devanagari included.
func TestEvidenceVectors(t *testing.T) {
	var v struct {
		Code     string
		Identity PayeeIdentity `json:"identity"`
		Facts    struct {
			Amount          int64
			ReferenceCode   string
			TransactionCode string
		}
		Texts []struct {
			Text    string
			Receipt struct {
				Amount    *int64
				Direction *string
				Payee     *string
				Provider  string
				Shape     string
				TxnID     *string `json:"txnId"`
			}
			Direction struct {
				Direction    string
				IsLedgerView bool
				Outcome      string
				StrongCredit bool
			}
			DirectionRefusal *string
			OutcomeRefusal   *string
			Payee            struct {
				Payee   *string
				Verdict string
			}
			PayeeRefusal *string
			Fields       struct {
				Amount          *int64
				Method          string
				ReferenceCode   string
				TransactionCode string
			}
			Flags      []string
			LooksLike  bool
			NotPayment bool
			References []string
			Statement  bool
			Bank       *struct{ Key, Name string }
			System     *string
		}
		Codes []struct {
			Value   string
			Problem *string
			Esewa   []string
			Bank    []string
		}
		Hamming []struct {
			A, B string
			Near bool
		}
	}
	vector(t, "evidence.json", &v)
	v.Identity.AccountIDs, v.Identity.Names = append([]string{}, v.Identity.AccountIDs...), append([]string{}, v.Identity.Names...)
	facts := ClaimFacts{v.Facts.Amount, v.Facts.ReferenceCode, v.Facts.TransactionCode}
	if len(v.Texts) < 10 {
		t.Fatal("vectors are missing")
	}
	for _, c := range v.Texts {
		r := ParseReceipt(c.Text)
		if !reflect.DeepEqual(r.Amount, c.Receipt.Amount) || r.Direction != str(c.Receipt.Direction) || r.Payee != str(c.Receipt.Payee) || r.Provider != c.Receipt.Provider || r.Shape != c.Receipt.Shape || r.TxnID != str(c.Receipt.TxnID) {
			t.Errorf("receipt %q:\n got %+v\nwant %+v", c.Text, r, c.Receipt)
		}
		d := ReadDirection(c.Text)
		if d.Direction != c.Direction.Direction || d.IsLedgerView != c.Direction.IsLedgerView || d.Outcome != c.Direction.Outcome || d.StrongCredit != c.Direction.StrongCredit {
			t.Errorf("direction %q:\n got %+v\nwant %+v", c.Text, d, c.Direction)
		}
		if DirectionRefusal(d) != str(c.DirectionRefusal) || OutcomeRefusal(d) != str(c.OutcomeRefusal) {
			t.Errorf("refusal %q", c.Text)
		}
		p := ReadPayee(c.Text, v.Identity, r.Payee)
		if p.Payee != str(c.Payee.Payee) || p.Verdict != c.Payee.Verdict || PayeeRefusal(p) != str(c.PayeeRefusal) {
			t.Errorf("payee %q:\n got %+v\nwant %+v", c.Text, p, c.Payee)
		}
		f := ExtractClaimFields(c.Text)
		if !reflect.DeepEqual(f.Amount, c.Fields.Amount) || f.Method != c.Fields.Method || f.ReferenceCode != c.Fields.ReferenceCode || f.TransactionCode != c.Fields.TransactionCode {
			t.Errorf("fields %q:\n got %+v\nwant %+v", c.Text, f, c.Fields)
		}
		if c.Text != "" {
			if got := EvidenceTextFlags(c.Text, facts); !slices.Equal(got, c.Flags) {
				t.Errorf("flags %q: got %v, want %v", c.Text, got, c.Flags)
			}
		}
		if LooksLikePaymentReceipt(c.Text) != c.LooksLike || IsDefinitelyNotPayment(c.Text) != c.NotPayment || LooksLikeStatement(c.Text) != c.Statement || SystemDocumentFromText(c.Text) != str(c.System) {
			t.Errorf("signals %q", c.Text)
		}
		if got := ExtractReferenceCodes(c.Text); !slices.Equal(got, c.References) {
			t.Errorf("references %q: got %v, want %v", c.Text, got, c.References)
		}
		key, name := ReceiptBank(c.Text)
		if c.Bank == nil && key != "" || c.Bank != nil && (key != c.Bank.Key || name != c.Bank.Name) {
			t.Errorf("bank %q: got %s %s, want %+v", c.Text, key, name, c.Bank)
		}
	}
	for _, c := range v.Codes {
		if got := TransactionCodeProblem(c.Value); got != str(c.Problem) {
			t.Errorf("code %q: got %q, want %q", c.Value, got, str(c.Problem))
		}
		if got := TxnIDFlags("ESEWA", c.Value); !slices.Equal(got, c.Esewa) {
			t.Errorf("esewa %q: got %v, want %v", c.Value, got, c.Esewa)
		}
		if got := TxnIDFlags("BANK_TRANSFER", c.Value); !slices.Equal(got, c.Bank) {
			t.Errorf("bank rule %q: got %v, want %v", c.Value, got, c.Bank)
		}
	}
	for _, c := range v.Hamming {
		if HammingNear(c.A, c.B) != c.Near {
			t.Errorf("hamming %s %s", c.A, c.B)
		}
	}
}

// What is measured from a file's bytes at upload, against readEvidenceProvenance
// and computePerceptualHash on the same bytes.
func TestProvenanceVectors(t *testing.T) {
	var v map[string]struct {
		Bytes string
		Flags []string
		Hash  string
	}
	vector(t, "provenance.json", &v)
	for name, c := range v {
		b, err := base64.StdEncoding.DecodeString(c.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		p := ReadProvenance(b)
		raw, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		var stored struct {
			CameraExif      *bool   `json:"hasCameraExif"`
			EditorSignature *string `json:"editorSignature"`
			QuantStandard   *bool   `json:"quantTablesStandard"`
			ScreenshotShape *bool   `json:"screenshotShape"`
		}
		if err := json.Unmarshal(raw, &stored); err != nil {
			t.Fatal(err)
		}
		got := ProvenanceFlags(&StoredProvenance{stored.CameraExif, stored.EditorSignature, stored.QuantStandard, stored.ScreenshotShape})
		if len(got) != len(c.Flags) || !slices.Equal(got, c.Flags) {
			t.Errorf("%s flags: got %v, want %v", name, got, c.Flags)
		}
		if got := PerceptualHash(b); !HammingNear(got, c.Hash) {
			t.Errorf("%s hash: got %s, want near %s", name, got, c.Hash)
		}
	}
}

func goldenPDF(t *testing.T, name string, got []byte, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("../../../testdata/golden/pdf/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if diff := pdftest.Diff(got, want, 0.05); diff != "" {
		t.Errorf("%s differs from the TS golden:\n%s", name, diff)
	}
}

func TestReceiptAndStatementGolden(t *testing.T) {
	stamp := time.Date(2026, 9, 1, 6, 0, 0, 0, time.UTC)
	from, to := time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	got, err := RenderReceiptPDF(ReceiptInput{Amount: 12500, CoversFrom: &from, CoversTo: &to, HostelName: "Education Light Hostel",
		Lines: []ReceiptLine{{12000, "Rent"}, {500, "Late fine with a very long description that should be cut before it runs off the page"}}, InvoicePeriod: "Bhadra 2083 BS", IssuedAt: stamp,
		Method: "Paid by HostelPalika - Resident Offer Program", ReceiptNumber: "RCP-EDU-2083-05-00012", ReferenceCode: "EDU-0002-P", ResidentName: "Sita Sharma é", Room: "Room 204, Double Sharing"})
	goldenPDF(t, "receipt.pdf", got, err)
	got, err = RenderReceiptPDF(ReceiptInput{Amount: 9000, CertificationCode: "HP-7KQ2-9XWM", HostelName: "Education Light Hostel", IssuedAt: stamp, ReceiptNumber: "RCP-EDU-2083-05-00013", ResidentName: "Ram"})
	goldenPDF(t, "receipt-certified.pdf", got, err)
	got, err = RenderReceiptPDF(ReceiptInput{Amount: 9000, HostelName: "Education Light Hostel", IssuedAt: stamp, ReceiptNumber: "RCP-EDU-2083-05-00014", ResidentName: "Ram", VoidReason: "Entered twice", VoidedAt: &stamp})
	goldenPDF(t, "receipt-void.pdf", got, err)
	rows := make([]StatementRow, 30)
	for i := range rows {
		rows[i] = StatementRow{DueAmount: int64(12000 + i), Period: "One-off", Status: "UNPAID"}
		if i > 0 {
			rows[i].Period = "Month " + itoa(i)
		}
		if i%2 == 1 {
			rows[i].PaidAmount, rows[i].Status = 12000, "PAID"
		}
	}
	got, err = RenderStatementPDF(stamp, "Education Light Hostel", "Sita Sharma", rows)
	goldenPDF(t, "statement.pdf", got, err)
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func TestRoomLabel(t *testing.T) {
	for _, c := range [][3]string{{"204", "Double Sharing", "Room 204, Double Sharing"}, {"", "SINGLE", "Single"}, {"12", "", "Room 12"}, {"", "TWO_SEATER", "Two Seater"}, {"", "", ""}} {
		if got := RoomLabel(c[0], c[1]); got != c[2] {
			t.Errorf("RoomLabel(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}
