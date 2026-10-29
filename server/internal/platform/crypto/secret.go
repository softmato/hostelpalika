package crypto

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"
)

// EnvelopeFormat is the only finance-secret format there is.
const EnvelopeFormat = "v1"

// ErrSecretUnreadable maps to SecretCryptoError: errorCode SECRET_UNREADABLE, 500.
var ErrSecretUnreadable = errors.New("A stored secret could not be read.")

// MasterKey is one FINANCE_MASTER_KEY; ID is the first 12 hex of sha256(raw.trim()).
type MasterKey struct {
	ID  string
	Key []byte
}

// Envelope is the EncryptedSecret row's crypto fields.
type Envelope struct {
	AuthTag       string `bson:"authTag" json:"authTag"`
	Ciphertext    string `bson:"ciphertext" json:"ciphertext"`
	Fingerprint   string `bson:"fingerprint" json:"fingerprint"`
	Format        string `bson:"format" json:"format"`
	IV            string `bson:"iv" json:"iv"`
	KeyID         string `bson:"keyId" json:"keyId"`
	WrappedKey    string `bson:"wrappedKey" json:"wrappedKey"`
	WrappedKeyIV  string `bson:"wrappedKeyIv" json:"wrappedKeyIv"`
	WrappedKeyTag string `bson:"wrappedKeyTag" json:"wrappedKeyTag"`
}

// Scope binds a secret to its hostel and purpose ("ESEWA:GATEWAY_SECRET").
type Scope struct {
	HostelID string `json:"hostelId"`
	Purpose  string `json:"purpose"`
}

func (s Scope) aad() []byte { return []byte(EnvelopeFormat + ":" + s.HostelID + ":" + s.Purpose) }

// ParseMasterKey refuses anything but 32 bytes of hex or base64.
func ParseMasterKey(raw string) ([]byte, error) {
	key := keyCandidate(strings.TrimSpace(raw))
	if len(key) != keyBytes {
		return nil, errors.New("A finance master key must be 32 bytes, hex or base64. Generate one with: openssl rand -base64 32")
	}
	return key, nil
}

// MasterKeys is [current, previous?]; the first seals, all of them open.
func MasterKeys(current, previous string) ([]MasterKey, error) {
	if current == "" {
		return nil, errors.New("FINANCE_MASTER_KEY is required to store or read gateway credentials. Generate one with: openssl rand -base64 32")
	}
	var keys []MasterKey
	for _, raw := range []string{current, previous} {
		if raw == "" {
			continue
		}
		key, err := ParseMasterKey(raw)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256([]byte(strings.TrimSpace(raw)))
		keys = append(keys, MasterKey{ID: hex.EncodeToString(sum[:])[:12], Key: key})
	}
	return keys, nil
}

// Fingerprint identifies a secret without revealing it: 16 hex of sha256(purpose:hostel:plaintext).
func Fingerprint(plaintext string, scope Scope) string {
	sum := sha256.Sum256([]byte(scope.Purpose + ":" + scope.HostelID + ":" + plaintext))
	return hex.EncodeToString(sum[:])[:16]
}

// EncryptSecret seals plaintext under a fresh data key wrapped by master.
func EncryptSecret(plaintext string, scope Scope, master MasterKey) (Envelope, error) {
	if plaintext == "" {
		return Envelope{}, errors.New("Refusing to store an empty secret.")
	}
	aad := scope.aad()
	dataKey, iv := random(keyBytes), random(ivBytes)
	ciphertext, tag, err := seal(dataKey, iv, []byte(plaintext), aad)
	if err != nil {
		return Envelope{}, err
	}
	env := Envelope{
		AuthTag:     b64(tag),
		Ciphertext:  b64(ciphertext),
		Fingerprint: Fingerprint(plaintext, scope),
		Format:      EnvelopeFormat,
		IV:          b64(iv),
	}
	err = wrap(&env, dataKey, aad, master)
	clear(dataKey)
	return env, err
}

func wrap(env *Envelope, dataKey, aad []byte, master MasterKey) error {
	wrapIV := random(ivBytes)
	wrapped, tag, err := seal(master.Key, wrapIV, dataKey, aad)
	if err != nil {
		return err
	}
	env.KeyID, env.WrappedKey, env.WrappedKeyIV, env.WrappedKeyTag = master.ID, b64(wrapped), b64(wrapIV), b64(tag)
	return nil
}

// ordered tries the key the envelope names first, then the rest.
func ordered(keys []MasterKey, id string) []MasterKey {
	out := make([]MasterKey, 0, len(keys))
	for _, k := range keys {
		if k.ID == id {
			out = append(out, k)
		}
	}
	for _, k := range keys {
		if k.ID != id {
			out = append(out, k)
		}
	}
	return out
}

func unwrap(env Envelope, aad []byte, master MasterKey) ([]byte, error) {
	return open(master.Key, nodeBase64(env.WrappedKeyIV), nodeBase64(env.WrappedKey), nodeBase64(env.WrappedKeyTag), aad)
}

// DecryptSecret opens an envelope with any configured master key.
func DecryptSecret(env Envelope, scope Scope, keys []MasterKey) (string, error) {
	if env.Format != EnvelopeFormat {
		return "", ErrSecretUnreadable
	}
	aad := scope.aad()
	for _, k := range ordered(keys, env.KeyID) {
		dataKey, err := unwrap(env, aad, k)
		if err != nil {
			continue
		}
		plain, err := open(dataKey, nodeBase64(env.IV), nodeBase64(env.Ciphertext), nodeBase64(env.AuthTag), aad)
		clear(dataKey)
		if err == nil {
			return string(plain), nil
		}
	}
	return "", ErrSecretUnreadable
}

// RewrapSecret moves an envelope's data key onto `to`, leaving the ciphertext alone.
func RewrapSecret(env Envelope, scope Scope, from []MasterKey, to MasterKey) (Envelope, error) {
	aad := scope.aad()
	for _, k := range ordered(from, env.KeyID) {
		dataKey, err := unwrap(env, aad, k)
		if err != nil {
			continue
		}
		err = wrap(&env, dataKey, aad, to)
		clear(dataKey)
		return env, err
	}
	return Envelope{}, ErrSecretUnreadable
}

// SecretsMatch compares in constant time.
func SecretsMatch(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
