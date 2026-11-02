package hostels

import (
	"bufio"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

// The print runs end to end on the real letterhead and flows onto several pages.
func TestAgreementRenders(t *testing.T) {
	p := agreementParties{Company: agreementCompany{letterheadAddress, letterheadEmail, letterheadPhone, "Softmato Pvt Ltd", "123", "98"}, Hostel: agreementHostel{"Ward 4, Kathmandu", "Test Hostel"}, Owner: agreementOwner{"o@x.test", "Ram", "98"}}
	sig := "M0 0L100 100L200 50L300 150L400 20L500 180L550 90L600 200"
	ref := "SMT/HP/2026/001"
	now := time.Now()
	for _, code := range []*string{nil, &ref} {
		r := &signatureRecord{Parties: p, RefCode: code, Signature: sig, SignedAt: now, SignerName: "Ram", Terms: termsFor(p), TextHash: "abc", UserAgent: "go", IP: "1.1.1.1"}
		if code != nil {
			r.IssuedAt = &now
		}
		out, err := agreementPrint{record: r, issuer: agreementIssuer{LegalName: "Softmato Pvt Ltd"}}.render()
		if err != nil {
			t.Fatal(err)
		}
		if len(out) < 100000 {
			t.Fatalf("letterhead missing: %d bytes", len(out))
		}
		if dir := os.Getenv("AGREEMENT_OUT"); dir != "" {
			if err := os.WriteFile(dir+"/agreement.pdf", out, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// The fingerprint is JSON.stringify's: nothing HTML-escaped, keys in order.
func TestAgreementFingerprintStable(t *testing.T) {
	p := agreementParties{Company: agreementCompany{LegalName: "A & B"}}
	a, err := agreementFingerprint(p, termsFor(p))
	if err != nil || len(a) != 64 {
		t.Fatal(a, err)
	}
}

// A sign racing an issue: the update misses the coded row, the upsert hits the index.
func TestSaveSignatureLosesToIssuedRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI(fixture.URI))
	if err != nil {
		t.Fatal(err)
	}
	db := client.Database("hostels_agreement_test")
	defer db.Drop(context.Background())
	coll := db.Collection("hostelagreementsignatures")
	if _, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "hostelId", Value: 1}}, Options: options.Index().SetUnique(true)}); err != nil {
		t.Skip("no Mongo: ", err)
	}
	id := bson.NewObjectID()
	if _, err := coll.InsertOne(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "refCode", Value: "SMT/HP/2026/001"}}); err != nil {
		t.Fatal(err)
	}
	err = (&Admin{DB: db}).saveSignature(ctx, id, bson.D{{Key: "signerName", Value: "Late"}}, time.Now())
	var he *httpx.Error
	if !errors.As(err, &he) || he.ErrorCode != "AGREEMENT_FINAL" {
		t.Fatalf("got %v", err)
	}
}

// Real seals from the real private bucket, read only: AGREEMENT_REAL_R2=<root .env>.
func TestAgreementRealSeals(t *testing.T) {
	path := os.Getenv("AGREEMENT_REAL_R2")
	if path == "" {
		t.Skip("set AGREEMENT_REAL_R2")
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	env := map[string]string{}
	for sc := bufio.NewScanner(file); sc.Scan(); {
		if k, v, ok := strings.Cut(sc.Text(), "="); ok {
			env[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	a := &Admin{R2: storage.New(config.R2{Endpoint: env["R2_ENDPOINT"], AccessKeyID: env["R2_ACCESS_KEY_ID"], SecretAccessKey: env["R2_SECRET_ACCESS_KEY"], BucketPrivate: env["R2_BUCKET_PRIVATE"], KeyPrefix: env["R2_KEY_PREFIX"]})}
	ctx := context.Background()
	stamp := a.seal(ctx, "stamp.png")
	var signers []printedSigner
	for _, s := range agreementSigners {
		if img := a.seal(ctx, s.file); img != nil {
			signers = append(signers, printedSigner{img, s.name, s.title})
		}
	}
	if stamp == nil || len(signers) != 2 {
		t.Fatalf("seals missing: stamp %v signers %d", stamp != nil, len(signers))
	}
	p := agreementParties{Company: agreementCompany{letterheadAddress, letterheadEmail, letterheadPhone, "Softmato", "1", "98"}, Hostel: agreementHostel{"Ward 4", "Test Hostel"}, Owner: agreementOwner{"o@x.test", "Ram", "98"}}
	ref := "SMT/HP/2026/001"
	now := time.Now()
	out, err := agreementPrint{record: &signatureRecord{Parties: p, RefCode: &ref, IssuedAt: &now, Signature: "M0 0L100 100L200 50L300 150", SignedAt: now, SignerName: "Ram", Terms: termsFor(p)}, issuer: agreementIssuer{LegalName: "Softmato"}, signers: signers, stamp: stamp}.render()
	if err != nil {
		t.Fatal(err)
	}
	if dir := os.Getenv("AGREEMENT_OUT"); dir != "" {
		if err := os.WriteFile(dir+"/sealed.pdf", out, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
