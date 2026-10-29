package auth

import "golang.org/x/crypto/bcrypt"

// passwordCost is lib/password.ts's SALT_ROUNDS. Hashes from bcryptjs ($2a$/$2b$)
// verify here and Go's verify there, so no password needs re-hashing.
const passwordCost = 12

// bcryptjs uses the first 72 UTF-8 bytes; x/crypto refuses longer input
// instead, so both sides cut first and a long password works on either server.
func cut(password string) []byte {
	p := []byte(password)
	if len(p) > 72 {
		p = p[:72]
	}
	return p
}

func HashPassword(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword(cut(password), passwordCost)
	return string(h), err
}

// VerifyPassword is bcrypt.compare: false on mismatch or a malformed hash.
func VerifyPassword(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), cut(password)) == nil
}
