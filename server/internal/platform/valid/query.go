package valid

import (
	"math"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/zschema"
)

// Query is `Object.fromEntries(request.nextUrl.searchParams.entries())`: the
// last value of each key.
func Query(c *gin.Context) map[string]string {
	out := map[string]string{}
	for k, vs := range c.Request.URL.Query() {
		out[k] = vs[len(vs)-1]
	}
	return out
}

// QueryString is an optional `z.string().trim().min(min).max(max)` read from
// the query; nil when absent or invalid (an issue is added for the latter).
func QueryString(q map[string]string, key string, min, max int, is *Issues) *string {
	raw, ok := q[key]
	if !ok {
		return nil
	}
	s := zschema.JSTrim(raw)
	n := jsLen(s)
	switch {
	case n < min:
		is.Add(key, TooSmall("string", float64(min), true))
		return nil
	case max > 0 && n > max:
		is.Add(key, TooBig("string", float64(max), true))
		return nil
	}
	return &s
}

// QueryEnum is an optional z.enum read from the query.
func QueryEnum(q map[string]string, key string, is *Issues, values ...string) *string {
	raw, ok := q[key]
	if !ok {
		return nil
	}
	for _, v := range values {
		if raw == v {
			return &raw
		}
	}
	vs := make([]any, len(values))
	for i, v := range values {
		vs[i] = v
	}
	is.Add(key, OneOf(vs...))
	return nil
}

// QueryNumber is an optional `z.coerce.number()` (with .nonnegative() when
// nonNegative) read from the query.
func QueryNumber(q map[string]string, key string, nonNegative bool, is *Issues) *float64 {
	raw, ok := q[key]
	if !ok {
		return nil
	}
	f := JSNumber(raw)
	switch {
	case math.IsNaN(f):
		is.Add(key, Type("number", "NaN"))
		return nil
	case math.IsInf(f, 0):
		is.Add(key, Type("number", "Infinity"))
		return nil
	case nonNegative && f < 0:
		is.Add(key, TooSmall("number", 0, true))
		return nil
	}
	return &f
}

// JSNumber is JS Number(string): trimmed, "" → 0, 0x/0o/0b integers,
// Infinity, decimals; anything else NaN.
func JSNumber(s string) float64 {
	s = zschema.JSTrim(s)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		if base != 0 {
			if n, err := strconv.ParseUint(s[2:], base, 64); err == nil && !strings.ContainsAny(s[2:], "_+-") {
				return float64(n)
			}
			return math.NaN()
		}
	}
	body := strings.TrimLeft(s, "+-")
	if body == "Infinity" {
		if strings.HasPrefix(s, "-") {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	if len(s)-len(body) > 1 { // "--1", "+-1"
		return math.NaN()
	}
	for _, r := range body {
		if !(r >= '0' && r <= '9' || r == '.' || r == 'e' || r == 'E' || r == '+' || r == '-') {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !strings.Contains(err.Error(), "range") {
		return math.NaN()
	}
	return f
}

func jsLen(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
	}
	return n
}
