package crypto

import (
	"bytes"
	"crypto/rand"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
	"golang.org/x/crypto/nacl/secretbox"
)

// Sealed backups, a port of packages/shared/src/backup/sealed-archive.ts (tweetnacl):
//
//	"HPBK" | version 1 | uint32 BE header length | header JSON | secretbox(body)
//
// The data key is box-wrapped to the owner's recovery key together with
// "hostelId|createdAt", so a header edited to claim another hostel fails to open.

// ArchiveVersion is the only version there is.
const ArchiveVersion = 1

var archiveMagic = []byte("HPBK")

// ArchiveHeader keeps TS's key order: it is what JSON.stringify wrote.
type ArchiveHeader struct {
	CreatedAt  string `json:"createdAt"`
	EPK        string `json:"epk"`
	HostelID   string `json:"hostelId"`
	Nonce      string `json:"nonce"`
	Recipient  string `json:"recipient"`
	V          int    `json:"v"`
	WrapNonce  string `json:"wrapNonce"`
	WrappedKey string `json:"wrappedKey"`
}

// ArchiveError carries TS's code: NOT_AN_ARCHIVE | WRONG_KEY | DAMAGED.
type ArchiveError struct{ Code, Message string }

func (e *ArchiveError) Error() string { return e.Message }

var errTampered = &ArchiveError{"DAMAGED", "This backup file has been changed and cannot be trusted."}

// PublicKey is the curve25519 public half of a recovery key.
func PublicKey(secretKey *[32]byte) *[32]byte {
	var pub [32]byte
	curve25519.ScalarBaseMult(&pub, secretKey)
	return &pub
}

// KeyFingerprint is "ABCD-EF01-2345-6789": the first 8 bytes of sha512(publicKey).
func KeyFingerprint(publicKey []byte) string {
	sum := sha512.Sum512(publicKey)
	h := strings.ToUpper(hex.EncodeToString(sum[:8]))
	return h[0:4] + "-" + h[4:8] + "-" + h[8:12] + "-" + h[12:16]
}

const b32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// RecoveryCode is the secret key plus a 3-byte checksum in Crockford base32, 14 groups of 4.
func RecoveryCode(secretKey []byte) string {
	sum := sha512.Sum512(secretKey)
	var bits, value int
	var out strings.Builder
	for _, b := range append(append([]byte{}, secretKey...), sum[:3]...) {
		value = value<<8 | int(b)
		bits += 8
		for bits >= 5 && out.Len() < 56 {
			bits -= 5
			out.WriteByte(b32[(value>>bits)&31])
		}
		value &= 1<<bits - 1
	}
	code := out.String()
	groups := make([]string, 0, 14)
	for i := 0; i+4 <= len(code); i += 4 {
		groups = append(groups, code[i:i+4])
	}
	return strings.Join(groups, " ")
}

var (
	codePrefix  = regexp.MustCompile(`^HPKEY1:`)
	codeNonB32  = regexp.MustCompile(`[^0-9A-Z]`)
	codeLookAli = strings.NewReplacer("O", "0", " ", "", "I", "1", "L", "1")
)

// KeyFromRecoveryCode reads a typed or scanned code back; nil when it does not check out.
func KeyFromRecoveryCode(code string) []byte {
	clean := codePrefix.ReplaceAllString(strings.ToUpper(code), "")
	clean = codeNonB32.ReplaceAllString(codeLookAli.Replace(clean), "")
	if len(clean) != 56 {
		return nil
	}
	out := make([]byte, 0, 35)
	var bits, value int
	for _, c := range clean {
		digit := strings.IndexRune(b32, c)
		if digit < 0 {
			return nil
		}
		value = value<<5 | digit
		bits += 5
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(value>>bits))
			value &= 1<<bits - 1
		}
	}
	secretKey := out[:32]
	if strings.ReplaceAll(RecoveryCode(secretKey), " ", "") != clean {
		return nil
	}
	return secretKey
}

// RecoveryQRText is what the recovery QR encodes.
func RecoveryQRText(code string) string { return "HPKEY1:" + strings.ReplaceAll(code, " ", "") }

func binding(hostelID, createdAt string) []byte { return []byte(hostelID + "|" + createdAt) }

// SealArchive encrypts plaintext so only the holder of the recovery key can open it.
func SealArchive(plaintext, recipientPublicKey []byte, hostelID, createdAt string) ([]byte, error) {
	if len(recipientPublicKey) != keyBytes {
		return nil, &ArchiveError{"WRONG_KEY", "That is not a backup key."}
	}
	var recipient, dataKey [32]byte
	var nonce, wrapNonce [24]byte
	copy(recipient[:], recipientPublicKey)
	copy(dataKey[:], random(32))
	copy(nonce[:], random(24))
	copy(wrapNonce[:], random(24))
	senderPub, senderSec, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	wrapped := box.Seal(nil, append(dataKey[:], binding(hostelID, createdAt)...), &wrapNonce, &recipient, senderSec)
	clear(senderSec[:])

	header, err := marshalNoEscape(ArchiveHeader{
		CreatedAt:  createdAt,
		EPK:        b64(senderPub[:]),
		HostelID:   hostelID,
		Nonce:      b64(nonce[:]),
		Recipient:  KeyFingerprint(recipientPublicKey),
		V:          ArchiveVersion,
		WrapNonce:  b64(wrapNonce[:]),
		WrappedKey: b64(wrapped),
	})
	if err != nil {
		return nil, err
	}
	out := append(append([]byte{}, archiveMagic...), ArchiveVersion)
	out = binary.BigEndian.AppendUint32(out, uint32(len(header)))
	out = append(out, header...)
	out = secretbox.Seal(out, plaintext, &nonce, &dataKey)
	clear(dataKey[:])
	return out, nil
}

// ReadArchiveHeader parses the header without opening the body.
func ReadArchiveHeader(archive []byte) (ArchiveHeader, []byte, error) {
	var h ArchiveHeader
	if len(archive) < 9 || !bytes.Equal(archive[:4], archiveMagic) || archive[4] != ArchiveVersion {
		return h, nil, &ArchiveError{"NOT_AN_ARCHIVE", "This is not a HostelPalika backup file."}
	}
	length := int(binary.BigEndian.Uint32(archive[5:9]))
	if 9+length > len(archive) {
		return h, nil, &ArchiveError{"DAMAGED", "This backup file is cut short."}
	}
	if err := json.Unmarshal(archive[9:9+length], &h); err != nil {
		return h, nil, &ArchiveError{"DAMAGED", "This backup file is damaged."}
	}
	return h, archive[9+length:], nil
}

// OpenArchive decrypts with the owner's recovery (secret) key.
func OpenArchive(archive []byte, secretKey []byte) (ArchiveHeader, []byte, error) {
	h, body, err := ReadArchiveHeader(archive)
	if err != nil {
		return h, nil, err
	}
	var sec, epk [32]byte
	var wrapNonce, nonce [24]byte
	copy(sec[:], secretKey)
	if KeyFingerprint(PublicKey(&sec)[:]) != h.Recipient {
		return h, nil, &ArchiveError{"WRONG_KEY", "This backup was made for a different recovery key."}
	}
	copy(epk[:], nodeBase64(h.EPK))
	copy(wrapNonce[:], nodeBase64(h.WrapNonce))
	copy(nonce[:], nodeBase64(h.Nonce))
	unwrapped, ok := box.Open(nil, nodeBase64(h.WrappedKey), &wrapNonce, &epk, &sec)
	if !ok || len(unwrapped) < 32 || !bytes.Equal(unwrapped[32:], binding(h.HostelID, h.CreatedAt)) {
		return h, nil, errTampered
	}
	var dataKey [32]byte
	copy(dataKey[:], unwrapped[:32])
	clear(unwrapped)
	plaintext, ok := secretbox.Open(nil, body, &nonce, &dataKey)
	clear(dataKey[:])
	if !ok {
		return h, nil, errTampered
	}
	return h, plaintext, nil
}

// marshalNoEscape is JSON.stringify: no HTML escaping, no trailing newline.
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("archive header: %w", err)
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
