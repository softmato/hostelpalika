package auth

import (
	"testing"
	"time"
)

// Minted the way jose does (header {"alg":"HS256"}, payload in signAccessToken's
// key order) with secret "test-access-secret", iat 1761700000, exp +3600.
const (
	joseAccess  = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiSE9TVEVMX0FETUlOIiwiaG9zdGVsSWRzIjpbImgxIl0sImxvY2tQaW4iOnRydWUsInNlc3Npb25JZCI6IjY3MjBhMDAwMDAwMDAwMDAwMDAwMDAwMSIsInRva2VuVHlwZSI6ImFjY2VzcyIsInN1YiI6InUxIiwiaWF0IjoxNzYxNzAwMDAwLCJleHAiOjE3NjE3MDM2MDB9.htSgqhX5D3hOdrcehWLZTEoJ4RGLErHXR23t0fVEc5o"
	josePurpose = "eyJhbGciOiJIUzI1NiJ9.eyJob3N0ZWxJZCI6Img5IiwidG9rZW5UeXBlIjoicGFzc3dvcmQtcmVzZXQiLCJ0b2tlblZlcnNpb24iOjMsInN1YiI6InUxIiwiaWF0IjoxNzYxNzAwMDAwLCJleHAiOjE3NjE3MDM2MDB9.IimGO6DrW_7iSaUOiedy2k0QKHQ1QQwx5G39MZGPy5E"
)

func testTokens(at int64) *Tokens {
	t := NewTokens("test-access-secret", "test-refresh-secret", time.Hour, 30*24*time.Hour)
	t.now = func() time.Time { return time.Unix(at, 0) }
	return t
}

func TestTokens(t *testing.T) {
	tk := testTokens(1761700000)
	in := TokenInput{UserID: "u1", Role: "HOSTEL_ADMIN", HostelIDs: []string{"h1"}, LockPin: true, SessionID: "6720a0000000000000000001"}

	// Same bytes as jose ⇒ each server verifies the other's tokens.
	got, err := tk.SignAccess(in)
	if err != nil || got != joseAccess {
		t.Fatalf("SignAccess = %s, %v\nwant %s", got, err, joseAccess)
	}
	c, err := tk.VerifyAccess(joseAccess)
	if err != nil || c.Subject != "u1" || c.Role != "HOSTEL_ADMIN" || !c.LockPin || c.SessionID != "6720a0000000000000000001" {
		t.Fatalf("VerifyAccess = %+v, %v", c, err)
	}
	m, err := tk.VerifyPurpose(josePurpose, PasswordReset)
	if err != nil || m["hostelId"] != "h9" || m["tokenVersion"] != float64(3) {
		t.Fatalf("VerifyPurpose = %v, %v", m, err)
	}

	refresh, _ := tk.SignRefresh(in)
	rc, err := tk.VerifyRefresh(refresh)
	if err != nil || rc.LockPin {
		t.Fatalf("refresh = %+v, %v (lockPin must be dropped)", rc, err)
	}
	v := 2
	own, _ := tk.SignPurpose(PurposeInput{UserID: "u1", Purpose: VerifyEmail, TTL: time.Hour, TokenVersion: &v, Claims: map[string]string{"tokenType": "access"}})
	if pm, err := tk.VerifyPurpose(own, VerifyEmail); err != nil || pm["tokenType"] != "verify-email" {
		t.Fatalf("own purpose = %v, %v (tokenType must override claims)", pm, err)
	}

	for name, fn := range map[string]func() error{
		"refresh as access":  func() error { _, err := tk.VerifyAccess(refresh); return err },
		"access as refresh":  func() error { _, err := tk.VerifyRefresh(joseAccess); return err },
		"purpose as access":  func() error { _, err := tk.VerifyAccess(josePurpose); return err },
		"access as purpose":  func() error { _, err := tk.VerifyPurpose(joseAccess, PasswordReset); return err },
		"wrong purpose":      func() error { _, err := tk.VerifyPurpose(josePurpose, VerifyEmail); return err },
		"expired (exp==now)": func() error { _, err := testTokens(1761703600).VerifyAccess(joseAccess); return err },
		"alg none": func() error {
			_, err := tk.VerifyAccess("eyJhbGciOiJub25lIn0." + joseAccess[21:len(joseAccess)-43])
			return err
		},
		"tampered": func() error { _, err := tk.VerifyAccess(joseAccess[:len(joseAccess)-2] + "xx"); return err },
	} {
		if fn() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if BearerToken("Bearer  abc ") != "abc" || BearerToken("bearer abc") != "" {
		t.Error("BearerToken")
	}
}
