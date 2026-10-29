package crypto

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// archive.json was sealed by tweetnacl through the TS code. Set HP_WRITE_VECTORS=1
// to write archive-go.json, which the generator then opens in TS.
func TestArchiveVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/vectors/archive.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		SecretKey, PublicKey, Fingerprint, RecoveryCode, QRText string
		CodeReads                                               []struct {
			Text string
			Key  *string
		}
		Sealed []struct{ Plaintext, Archive string }
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	dec := base64.StdEncoding.DecodeString
	sec, _ := dec(v.SecretKey)
	var secret [32]byte
	copy(secret[:], sec)
	pub := PublicKey(&secret)[:]
	if b64(pub) != v.PublicKey || KeyFingerprint(pub) != v.Fingerprint {
		t.Fatalf("public key / fingerprint: %s %s", b64(pub), KeyFingerprint(pub))
	}
	if RecoveryCode(sec) != v.RecoveryCode || RecoveryQRText(v.RecoveryCode) != v.QRText {
		t.Fatalf("recovery code %s", RecoveryCode(sec))
	}
	for _, c := range v.CodeReads {
		got := KeyFromRecoveryCode(c.Text)
		if (got == nil) != (c.Key == nil) || (got != nil && b64(got) != *c.Key) {
			t.Errorf("read %q: %v", c.Text, got)
		}
	}

	for _, s := range v.Sealed {
		archive, _ := dec(s.Archive)
		h, plain, err := OpenArchive(archive, sec)
		if err != nil || string(plain) != s.Plaintext || h.HostelID != "66f000000000000000000001" {
			t.Fatalf("open: %v", err)
		}
		// A header rewritten to another hostel no longer opens.
		forged, _ := json.Marshal(ArchiveHeader{h.CreatedAt, h.EPK, "66f000000000000000000002", h.Nonce, h.Recipient, h.V, h.WrapNonce, h.WrappedKey})
		_, body, _ := ReadArchiveHeader(archive)
		bad := append(append([]byte("HPBK\x01"), byte(len(forged)>>24), byte(len(forged)>>16), byte(len(forged)>>8), byte(len(forged))), forged...)
		var ae *ArchiveError
		if _, _, err := OpenArchive(append(bad, body...), sec); !errors.As(err, &ae) || ae.Code != "DAMAGED" {
			t.Errorf("forged header: %v", err)
		}
	}

	sealed, err := SealArchive([]byte("sealed by go — नेपाल"), pub, "66f000000000000000000001", "2026-10-29T10:00:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	if _, plain, err := OpenArchive(sealed, sec); err != nil || string(plain) != "sealed by go — नेपाल" {
		t.Fatalf("go round trip: %v", err)
	}
	var other [32]byte
	other[0] = 1
	var ae *ArchiveError
	if _, _, err := OpenArchive(sealed, other[:]); !errors.As(err, &ae) || ae.Code != "WRONG_KEY" {
		t.Errorf("wrong key: %v", err)
	}
	if os.Getenv("HP_WRITE_VECTORS") == "1" {
		out, _ := json.Marshal(map[string]string{"archive": b64(sealed), "plaintext": "sealed by go — नेपाल"})
		if err := os.WriteFile("../../../testdata/vectors/archive-go.json", out, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
