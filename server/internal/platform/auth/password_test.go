package auth

import (
	"strings"
	"testing"
)

// Golden hashes made by bcryptjs (the TS server's library), cost 4.
func TestPasswordInterop(t *testing.T) {
	long := strings.Repeat("é", 50) // 100 UTF-8 bytes: bcryptjs keeps the first 72
	if !VerifyPassword("correct horse", "$2b$04$gVzhmrgihil5VHPoMpu7sudEKpRtBMIWGqOEUgcmJTOjiYEbDm44O") ||
		VerifyPassword("wrong", "$2b$04$gVzhmrgihil5VHPoMpu7sudEKpRtBMIWGqOEUgcmJTOjiYEbDm44O") ||
		!VerifyPassword(long, "$2b$04$lLNZSW6A4KVrRzkutzBOw.pt4CEAAmMDFlbrsYNUJtJR0LZk2vMK2") ||
		!VerifyPassword(long+"tail", "$2b$04$lLNZSW6A4KVrRzkutzBOw.pt4CEAAmMDFlbrsYNUJtJR0LZk2vMK2") {
		t.Fatal("bcryptjs hashes must verify")
	}
	h, err := HashPassword(long)
	if err != nil || !VerifyPassword(long, h) || !strings.HasPrefix(h, "$2a$12$") || VerifyPassword("x", "not a hash") {
		t.Fatal(h, err)
	}
}
