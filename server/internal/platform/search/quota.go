package search

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"math"
	"strconv"
	"strings"
	"time"
)

// The per-visitor quota for the LLM fallback lives in a signed cookie: the
// endpoint is anonymous, so there is no user to key on. Clearing cookies resets
// it — accepted, the downside is one extra free-tier call.
const (
	QuotaCookie = "hh_search_quota"
	QuotaLimit  = 10
	window      = 5 * time.Hour
)

// QuotaState is the LLM calls already spent in the current window and the epoch
// milliseconds when it resets.
type QuotaState struct {
	Used         int
	WindowEndsAt int64
}

// Quota signs and reads the cookie with SEARCH_QUOTA_SECRET (or CRON_SECRET).
type Quota struct{ Secret string }

func (q Quota) sign(payload string) string {
	mac := hmac.New(sha256.New, []byte(q.Secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Encode is `used.windowEndsAt.signature`; the signature stops a visitor
// editing `used` back to 0.
func (q Quota) Encode(s QuotaState) string {
	payload := strconv.Itoa(s.Used) + "." + strconv.FormatInt(s.WindowEndsAt, 10)
	return payload + "." + q.sign(payload)
}

func (q Quota) decode(raw string) (QuotaState, bool) {
	parts := strings.Split(raw, ".")
	if raw == "" || len(parts) != 3 {
		return QuotaState{}, false
	}
	if !hmac.Equal([]byte(parts[2]), []byte(q.sign(parts[0]+"."+parts[1]))) {
		return QuotaState{}, false
	}
	used, err := strconv.ParseFloat(parts[0], 64)
	end, err2 := strconv.ParseFloat(parts[1], 64)
	if err != nil || err2 != nil || used != math.Trunc(used) || math.IsInf(end, 0) {
		return QuotaState{}, false
	}
	return QuotaState{int(used), int64(end)}, true
}

// CurrentWindow is the live state, or a fresh window when none is live.
func (q Quota) CurrentWindow(raw string, now time.Time) QuotaState {
	if s, ok := q.decode(raw); ok && s.WindowEndsAt > now.UnixMilli() {
		return s
	}
	return QuotaState{0, now.Add(window).UnixMilli()}
}

func Remaining(s QuotaState) int {
	if r := QuotaLimit - s.Used; r > 0 {
		return r
	}
	return 0
}

// MaxAge is the cookie lifetime in seconds, so the cookie dies with its window.
func MaxAge(s QuotaState, now time.Time) int {
	return int(math.Max(1, math.Ceil(float64(s.WindowEndsAt-now.UnixMilli())/1000)))
}
