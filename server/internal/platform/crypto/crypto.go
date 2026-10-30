// Package crypto holds the two at-rest encryption schemes, byte-compatible with TS:
//
//   - Personal data (lib/personal-data-crypto.ts): `v1.<iv>.<tag>.<ciphertext>`,
//     AES-256-GCM under PERSONAL_DATA_ENCRYPTION_KEY, plus an HMAC blind index.
//   - Finance secrets (modules/finance/gateway/envelope-crypto.ts): a random data
//     key seals the secret, FINANCE_MASTER_KEY wraps the data key, both bound to
//     the hostel and purpose as AAD; FINANCE_MASTER_KEY_PREVIOUS still opens.
//
// Held to testdata/vectors/crypto.json (envelopes sealed by TS).
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
)

const (
	ivBytes  = 12
	keyBytes = 32
	tagBytes = 16
)

var hexKey = regexp.MustCompile(`(?i)^[a-f\d]{64}$`)

// nodeBase64 decodes the way Buffer.from(s, "base64") does: url-safe letters
// accepted, padding optional, anything else outside the alphabet skipped.
func nodeBase64(s string) []byte {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '-':
			b.WriteByte('+')
		case r == '_':
			b.WriteByte('/')
		case r == '=':
			// ponytail: Node stops at the first '='; our inputs only carry it as trailing padding.
		case r == '+' || r == '/' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		}
	}
	s = b.String()
	if len(s)%4 == 1 {
		s = s[:len(s)-1] // a lone trailing sextet carries no whole byte
	}
	out, _ := base64.RawStdEncoding.DecodeString(s)
	return out
}

// keyCandidate is hex when it looks like 64 hex digits, otherwise base64.
func keyCandidate(trimmed string) []byte {
	if hexKey.MatchString(trimmed) {
		out, _ := hex.DecodeString(trimmed)
		return out
	}
	return nodeBase64(trimmed)
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func random(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never fails on supported platforms
	return b
}

// seal is AES-256-GCM with Node's split: ciphertext and tag returned separately.
func seal(key, iv, plaintext, aad []byte) (ciphertext, tag []byte, err error) {
	aead, err := gcm(key)
	if err != nil {
		return nil, nil, err
	}
	out := aead.Seal(nil, iv, plaintext, aad)
	return out[:len(out)-tagBytes], out[len(out)-tagBytes:], nil
}

func open(key, iv, ciphertext, tag, aad []byte) ([]byte, error) {
	if len(iv) != ivBytes {
		return nil, errors.New("crypto: unexpected iv length")
	}
	aead, err := gcm(key)
	if err != nil {
		return nil, err
	}
	return aead.Open(nil, iv, append(append([]byte{}, ciphertext...), tag...), aad)
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

/* Personal data */

// ErrPersonalFormat is "Stored personal data is in an unrecognised format."
var ErrPersonalFormat = errors.New("Stored personal data is in an unrecognised format.")

// ErrPersonalKeyMissing is what a profile read or write throws without the key.
var ErrPersonalKeyMissing = errors.New("PERSONAL_DATA_ENCRYPTION_KEY is required to store or read resident profiles. Generate one with: openssl rand -base64 32")

// Personal seals UserResidentProfile and Resident.detailsData blobs.
type Personal struct{ key []byte }

// NewPersonal reads PERSONAL_DATA_ENCRYPTION_KEY: 32 bytes as hex or base64,
// and any other passphrase stretched with SHA-256 rather than rejected.
func NewPersonal(raw string) (*Personal, error) {
	if raw == "" {
		return nil, ErrPersonalKeyMissing
	}
	trimmed := strings.TrimSpace(raw)
	key := keyCandidate(trimmed)
	if len(key) != keyBytes {
		sum := sha256.Sum256([]byte(trimmed))
		key = sum[:]
	}
	return &Personal{key: key}, nil
}

// Encrypt seals JSON bytes (what JSON.stringify produced on the TS side).
func (p *Personal) Encrypt(plainJSON []byte) (string, error) {
	iv := random(ivBytes)
	ciphertext, tag, err := seal(p.key, iv, plainJSON, nil)
	if err != nil {
		return "", err
	}
	return "v1." + b64(iv) + "." + b64(tag) + "." + b64(ciphertext), nil
}

// Decrypt returns the JSON bytes an envelope holds.
func (p *Personal) Decrypt(envelope string) ([]byte, error) {
	parts := strings.Split(envelope, ".")
	for len(parts) < 4 {
		parts = append(parts, "")
	}
	if parts[0] != "v1" || parts[1] == "" || parts[2] == "" || parts[3] == "" {
		return nil, ErrPersonalFormat
	}
	return open(p.key, nodeBase64(parts[1]), nodeBase64(parts[3]), nodeBase64(parts[2]), nil)
}

// LookupHash is the blind index: one encrypted field matched for equality.
func (p *Personal) LookupHash(value string) string {
	mac := hmac.New(sha256.New, p.key)
	mac.Write([]byte("lookup:v1:" + strings.ToLower(strings.TrimSpace(value))))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
