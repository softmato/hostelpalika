package crypto

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// Envelopes in testdata/vectors/crypto.json were sealed by the TS code
// (testdata/vectors/generate.ts). Go must open every one and seal ones it can reopen.

type vectors struct {
	Personal []struct {
		Kind, Key string
		Sealed    []struct {
			Value    any
			Envelope string
		}
		Lookups []struct{ Value, Hash string }
	}
	Finance struct {
		Current, Previous string
		KeyIDs            struct{ Current, Previous string } `json:"keyIds"`
		Scope             Scope
		Fingerprint       string
		Sealed            []struct {
			Secret, SealedWith string
			Envelope           Envelope
		}
	}
}

func load(t *testing.T) vectors {
	raw, err := os.ReadFile("../../../testdata/vectors/crypto.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestPersonalOpensTS(t *testing.T) {
	for _, c := range load(t).Personal {
		p, err := NewPersonal(c.Key)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range c.Sealed {
			plain, err := p.Decrypt(s.Envelope)
			if err != nil {
				t.Fatalf("%s: %v", c.Kind, err)
			}
			var got any
			_ = json.Unmarshal(plain, &got)
			if !reflect.DeepEqual(got, s.Value) {
				t.Errorf("%s: %v != %v", c.Kind, got, s.Value)
			}
			again, _ := p.Encrypt(plain)
			if back, err := p.Decrypt(again); err != nil || string(back) != string(plain) {
				t.Errorf("%s: round trip %v", c.Kind, err)
			}
		}
		for _, l := range c.Lookups {
			if got := p.LookupHash(l.Value); got != l.Hash {
				t.Errorf("%s lookup %q: %s != %s", c.Kind, l.Value, got, l.Hash)
			}
		}
	}
	p, _ := NewPersonal("other key")
	if _, err := p.Decrypt(load(t).Personal[0].Sealed[0].Envelope); err == nil {
		t.Error("wrong key opened an envelope")
	}
	if _, err := p.Decrypt("v2.a.b.c"); err != ErrPersonalFormat {
		t.Error(err)
	}
}

func TestFinanceOpensTS(t *testing.T) {
	f := load(t).Finance
	keys, err := MasterKeys(f.Current, f.Previous)
	if err != nil {
		t.Fatal(err)
	}
	if keys[0].ID != f.KeyIDs.Current || keys[1].ID != f.KeyIDs.Previous {
		t.Fatalf("key ids %s %s", keys[0].ID, keys[1].ID)
	}
	if got := Fingerprint("8gBm/:&EnhH.1/q", f.Scope); got != f.Fingerprint {
		t.Errorf("fingerprint %s", got)
	}

	for _, s := range f.Sealed {
		plain, err := DecryptSecret(s.Envelope, f.Scope, keys)
		if err != nil || plain != s.Secret {
			t.Fatalf("%s: %q %v", s.SealedWith, plain, err)
		}
		// Bound to its scope: another hostel's row cannot be opened with it.
		if _, err := DecryptSecret(s.Envelope, Scope{"66f000000000000000000002", f.Scope.Purpose}, keys); err != ErrSecretUnreadable {
			t.Error("opened under the wrong scope")
		}
		// Rotation: rewrap onto the current key, then drop the previous one.
		moved, err := RewrapSecret(s.Envelope, f.Scope, keys, keys[0])
		if err != nil {
			t.Fatal(err)
		}
		if plain, err := DecryptSecret(moved, f.Scope, keys[:1]); err != nil || plain != s.Secret || moved.KeyID != keys[0].ID {
			t.Errorf("rewrap: %q %v", plain, err)
		}
	}

	sealed, err := EncryptSecret("go-sealed", f.Scope, keys[0])
	if err != nil || sealed.Fingerprint != Fingerprint("go-sealed", f.Scope) {
		t.Fatal(err)
	}
	if plain, err := DecryptSecret(sealed, f.Scope, keys); err != nil || plain != "go-sealed" {
		t.Errorf("go round trip: %q %v", plain, err)
	}
	if _, err := ParseMasterKey("too short"); err == nil {
		t.Error("short master key accepted")
	}
	if !SecretsMatch("a", "a") || SecretsMatch("a", "b") || SecretsMatch("a", "ab") {
		t.Error("SecretsMatch")
	}
}
