package auth

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Golden: Set-Cookie lines from the real applySessionCookies/clearSessionCookies
// (Next 16 ResponseCookies), clock 2026-10-29T10:00:00.500Z, TTLs 15m/30d.
var cookieGolden = map[string][]string{
	"apply": {
		"hostelpalika_access_token=a.b-c_d; Path=/; Expires=Thu, 29 Oct 2026 10:15:00 GMT; Max-Age=900; Secure; HttpOnly; SameSite=lax",
		"hostelpalika_refresh=r%201%2B%2F%3D; Path=/; Expires=Sat, 28 Nov 2026 10:00:00 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax",
		"hostelhub_refresh_token=; Path=/api; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelhub_access_token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelhub_refresh=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
	},
	"reuse": {
		"hostelpalika_access_token=a; Path=/; Expires=Thu, 29 Oct 2026 10:15:00 GMT; Max-Age=900; Secure; HttpOnly; SameSite=lax",
		"hostelhub_access_token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelhub_refresh=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
	},
	"clear": {
		"hostelpalika_access_token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelpalika_refresh=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelhub_access_token=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelhub_refresh=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelhub_refresh_token=; Path=/api; Max-Age=0; Secure; HttpOnly; SameSite=lax",
		"hostelhub_refresh_token=; Path=/api/v1/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
	},
}

func testCookies(secure bool, domain string) *Cookies {
	tk := NewTokens("test-access-secret", "test-refresh-secret", 15*time.Minute, 30*24*time.Hour)
	tk.now = func() time.Time { return time.Date(2026, 10, 29, 10, 0, 0, 5e8, time.UTC) }
	return &Cookies{Tokens: tk, Secure: secure, Domain: domain}
}

func TestSessionCookiesMatchNext(t *testing.T) {
	for _, secure := range []bool{true, false} {
		c := testCookies(secure, "")
		got := map[string][]string{"apply": nil, "reuse": nil, "clear": nil}
		h := http.Header{}
		c.ApplySession(h, "a.b-c_d", "r 1+/=")
		got["apply"] = h.Values("Set-Cookie")
		h = http.Header{}
		c.ApplySession(h, "a", "")
		got["reuse"] = h.Values("Set-Cookie")
		h = http.Header{}
		c.ClearSession(h)
		got["clear"] = h.Values("Set-Cookie")
		for k, want := range cookieGolden {
			if !secure { // development golden is the same lines without Secure
				w := make([]string, len(want))
				for i, l := range want {
					w[i] = strings.NewReplacer("; Secure;", ";", "; Secure", "").Replace(l)
				}
				want = w
			}
			if !reflect.DeepEqual(got[k], want) {
				t.Errorf("secure=%v %s:\n got %q\nwant %q", secure, k, got[k], want)
			}
		}
	}

	h := http.Header{}
	testCookies(true, ".hostelpalika.com").ApplySession(h, "a", "")
	if l := h.Values("Set-Cookie")[0]; !strings.Contains(l, "; Max-Age=900; Domain=.hostelpalika.com; Secure;") {
		t.Errorf("domain: %s", l)
	}
}

func req(cookie string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Cookie", cookie)
	return r
}

func TestReadSessionCookies(t *testing.T) {
	cases := []struct {
		cookie, access, refresh string
	}{
		{"hostelpalika_access_token=new", "new", ""},
		{"hostelhub_access_token=old", "old", ""},
		{"hostelpalika_access_token=new; hostelhub_access_token=old", "new", ""},
		{"hostelhub_refresh=renamed", "", "renamed"},
		{"hostelhub_refresh_token=pre-proxy", "", "pre-proxy"},
		{"hostelhub_refresh=newer; hostelhub_refresh_token=older", "", "newer"},
		{"hostelpalika_access_token=", "", ""},
		// Next: last duplicate wins, decoded; an empty current name falls back.
		{"hostelhub_refresh_token=old; hostelhub_refresh_token=new%2Bx; hostelpalika_refresh=", "", "new+x"},
	}
	for _, tc := range cases {
		r := req(tc.cookie)
		if a, rf := AccessCookieValue(r), RefreshCookieValue(r); a != tc.access || rf != tc.refresh {
			t.Errorf("%q: access %q refresh %q", tc.cookie, a, rf)
		}
		if HasSessionCookie(r) != (tc.access != "" || tc.refresh != "") {
			t.Errorf("%q: HasSessionCookie", tc.cookie)
		}
	}
}

func TestPinUnlockCookie(t *testing.T) {
	c := testCookies(false, "")
	c.Tokens.now = time.Now
	h := http.Header{}
	if err := c.ApplyPinUnlock(h, "u1", "s1"); err != nil {
		t.Fatal(err)
	}
	line := h.Get("Set-Cookie")
	if !strings.HasSuffix(line, "; Path=/; HttpOnly; SameSite=lax") || strings.Contains(line, "Max-Age") {
		t.Fatalf("unlock cookie: %s", line)
	}
	r := req(strings.SplitN(line, ";", 2)[0])
	if !c.PinUnlocked(r, "u1", "s1") || c.PinUnlocked(r, "u2", "s1") || c.PinUnlocked(r, "u1", "") {
		t.Fatal("PinUnlocked must match user and session")
	}
	// No sessionId claim: TS compares undefined to "" and refuses.
	tok, _ := c.Tokens.SignPurpose(PurposeInput{UserID: "u1", Purpose: LockPinUnlock, TTL: time.Minute})
	if c.PinUnlocked(req(UnlockCookie+"="+tok), "u1", "") {
		t.Fatal("missing sessionId claim must not unlock")
	}
}
