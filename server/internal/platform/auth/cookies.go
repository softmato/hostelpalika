package auth

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Cookie names: lib/auth-cookies.ts, lib/lock-pin-cookie.ts.
const (
	AccessCookie  = "hostelpalika_access_token"
	RefreshCookie = "hostelpalika_refresh"
	UnlockCookie  = "hostelpalika_unlock"

	// The pre-proxy-refresh cookie, scoped to "/api" (and once "/api/v1/auth").
	legacyRefreshPathCookie = "hostelhub_refresh_token"

	// UnlockIdle is UNLOCK_IDLE_SECONDS; portal-account.tsx mirrors it.
	UnlockIdle = 30 * time.Minute
)

// Older spellings, newest first, read as fallbacks and cleared on every write.
var (
	legacyAccessCookies  = []string{"hostelhub_access_token"}
	legacyRefreshCookies = []string{"hostelhub_refresh", legacyRefreshPathCookie}
	// The renamed pair that sat at "/" beside its replacements.
	renamedRootCookies = []string{"hostelhub_access_token", "hostelhub_refresh"}
)

// cookieValue reads a cookie as Next's parseCookie does: the last duplicate
// wins, the value is decodeURIComponent'd, and an undecodable one is absent.
func cookieValue(r *http.Request, name string) string {
	v := ""
	for _, c := range r.Cookies() {
		if c.Name != name {
			continue
		}
		if d, err := url.PathUnescape(c.Value); err == nil {
			v = d
		}
	}
	return v
}

// first returns the first non-empty value; "" is a cleared cookie, not a session.
func first(r *http.Request, names ...string) string {
	for _, n := range names {
		if v := cookieValue(r, n); v != "" {
			return v
		}
	}
	return ""
}

// AccessCookieValue is readAccessTokenCookie.
func AccessCookieValue(r *http.Request) string {
	return first(r, append([]string{AccessCookie}, legacyAccessCookies...)...)
}

// RefreshCookieValue is readRefreshTokenCookieValue.
func RefreshCookieValue(r *http.Request) string {
	return first(r, append([]string{RefreshCookie}, legacyRefreshCookies...)...)
}

// HasSessionCookie: a session under any spelling.
func HasSessionCookie(r *http.Request) bool {
	return AccessCookieValue(r) != "" || RefreshCookieValue(r) != ""
}

// Cookies writes the session and unlock cookies byte-for-byte as Next's
// ResponseCookies does. Secure = IsProduction (TS: NODE_ENV). Domain empty =
// host-only, exactly as TS today; set (COOKIE_DOMAIN) it is added to every
// cookie, for api.hostelpalika.com (ARCHITECTURE.md §4).
type Cookies struct {
	Tokens *Tokens
	Secure bool
	Domain string
}

// set is stringifyCookie: Path, Expires (only when maxAge > 0), Max-Age,
// Domain, Secure, HttpOnly, SameSite=lax. maxAge < 0 = session cookie.
func (c *Cookies) set(h http.Header, name, value string, maxAge int, path string) {
	SetCookie(h, name, value, maxAge, path, c.Domain, c.Secure, c.Tokens.now())
}

// SetCookie writes one Set-Cookie line the way Next does (see set), for the
// few cookies outside the session pair (visitor id, search quota).
func SetCookie(h http.Header, name, value string, maxAge int, path, domain string, secure bool, now time.Time) {
	var b strings.Builder
	b.WriteString(name + "=" + httpx.EncodeURIComponent(value) + "; Path=" + path)
	if maxAge > 0 {
		b.WriteString("; Expires=" + now.Add(time.Duration(maxAge)*time.Second).UTC().Format(http.TimeFormat))
	}
	if maxAge >= 0 {
		b.WriteString("; Max-Age=" + strconv.Itoa(maxAge))
	}
	if domain != "" {
		b.WriteString("; Domain=" + domain)
	}
	if secure {
		b.WriteString("; Secure")
	}
	b.WriteString("; HttpOnly; SameSite=lax")
	h.Add("Set-Cookie", b.String())
}

// CookieValue is the named cookie's value from the request, or "".
func CookieValue(r *http.Request, name string) string { return cookieValue(r, name) }

// ApplySession is applySessionCookies. refresh "" is a reuse-window refresh:
// only the access cookie is renewed.
func (c *Cookies) ApplySession(h http.Header, access, refresh string) {
	c.set(h, AccessCookie, access, int(c.Tokens.AccessTTL/time.Second), "/")
	if refresh != "" {
		c.set(h, RefreshCookie, refresh, int(c.Tokens.RefreshTTL/time.Second), "/")
		c.set(h, legacyRefreshPathCookie, "", 0, "/api")
	}
	for _, n := range renamedRootCookies {
		c.set(h, n, "", 0, "/")
	}
}

// ClearSession is clearSessionCookies: every spelling, every path.
func (c *Cookies) ClearSession(h http.Header) {
	c.set(h, AccessCookie, "", 0, "/")
	c.set(h, RefreshCookie, "", 0, "/")
	for _, n := range renamedRootCookies {
		c.set(h, n, "", 0, "/")
	}
	c.set(h, legacyRefreshPathCookie, "", 0, "/api")
	// TS appends this one raw, so its attribute order differs.
	raw := legacyRefreshPathCookie + "=; Path=/api/v1/auth; Max-Age=0"
	if c.Domain != "" {
		raw += "; Domain=" + c.Domain
	}
	raw += "; HttpOnly; SameSite=Lax"
	if c.Secure {
		raw += "; Secure"
	}
	h.Add("Set-Cookie", raw)
}

// ApplyPinUnlock is applyPinUnlockCookie: no max-age, dies with the browser;
// the token inside lasts UnlockIdle.
func (c *Cookies) ApplyPinUnlock(h http.Header, userID, sessionID string) error {
	tok, err := c.Tokens.SignPurpose(PurposeInput{
		UserID: userID, Purpose: LockPinUnlock, TTL: UnlockIdle,
		Claims: map[string]string{"sessionId": sessionID},
	})
	if err != nil {
		return err
	}
	c.set(h, UnlockCookie, tok, -1, "/")
	return nil
}

// PinUnlocked is isPinUnlocked: the cookie names this user and this session.
func (c *Cookies) PinUnlocked(r *http.Request, userID, sessionID string) bool {
	tok := cookieValue(r, UnlockCookie)
	if tok == "" {
		return false
	}
	m, err := c.Tokens.VerifyPurpose(tok, LockPinUnlock)
	if err != nil {
		return false
	}
	sub, _ := m["sub"].(string)
	// A missing claim is undefined in TS, which never equals "".
	sid, ok := m["sessionId"].(string)
	return ok && sub == userID && sid == sessionID
}
