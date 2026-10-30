package valid

import (
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// Form reads a JSON object field by field the way a z.object does, collecting
// issues in declared order. Unknown keys are ignored (zod strips them).
type Form struct {
	M  map[string]any
	Is Issues
	// Hard is set by an issue zod does not continue past (a type or enum mismatch): a
	// superRefine over the object is skipped then.
	Hard bool
}

// NewForm starts a schema over a decoded body; a non-object is a root issue.
func NewForm(body any) *Form {
	f := &Form{}
	f.M = Object(body, &f.Is)
	return f
}

func (f *Form) Err() error { return f.Is.Err() }

// Present is key !== undefined.
func (f *Form) Present(key string) bool { _, ok := f.M[key]; return ok }

// JSLen is String#length (UTF-16 code units), which zod's min/max count.
func JSLen(s string) int {
	n := 0
	for _, r := range s {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

// Trim is String#trim.
func Trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
			return true
		}
		return r >= 0x2000 && r <= 0x200A
	})
}

// S describes one z.string() chain. Checks run in declared order; Trim first
// because `.trim()` precedes `.min()` in every schema here.
type S struct {
	Opt    bool // .optional()
	Trim   bool
	Min    int
	MinMsg string
	Max    int // 0 = none
	MaxMsg string
	Re     *regexp.Regexp
	ReMsg  string
	ReSrc  string // the JS literal, for the default message
	Email  bool
	Lower  bool // .toLowerCase()
}

// Str reads key as a string. ok=false when absent+optional or an issue was added.
func (f *Form) Str(key string, o S) (string, bool) {
	if f.M == nil {
		return "", false
	}
	v, present := f.M[key]
	if !present && o.Opt {
		return "", false
	}
	s, isStr := v.(string)
	if !isStr {
		f.Hard = true
		f.Is.Add(key, Type("string", Received(v, !present)))
		return "", false
	}
	if o.Trim {
		s = Trim(s)
	}
	if o.Min > 0 && JSLen(s) < o.Min {
		m := o.MinMsg
		if m == "" {
			m = TooSmall("string", float64(o.Min), true)
		}
		f.Is.Add(key, m)
	}
	if o.Max > 0 && JSLen(s) > o.Max {
		m := o.MaxMsg
		if m == "" {
			m = TooBig("string", float64(o.Max), true)
		}
		f.Is.Add(key, m)
	}
	if o.Re != nil && !o.Re.MatchString(s) {
		m := o.ReMsg
		if m == "" {
			m = Pattern(o.ReSrc)
		}
		f.Is.Add(key, m)
	}
	if o.Email && !strings.Contains(s, "@") { // callers needing zod's exact email regexp check it themselves
		f.Is.Add(key, Format("email"))
	}
	if o.Lower {
		s = strings.ToLower(s)
	}
	return s, true
}

// Enum reads key as z.enum(values). def, when non-nil, is `.default(def)`.
func (f *Form) Enum(key string, opt bool, def *string, values ...string) (string, bool) {
	if f.M == nil {
		return "", false
	}
	v, present := f.M[key]
	if !present {
		if def != nil {
			return *def, true
		}
		if opt {
			return "", false
		}
	}
	s, _ := v.(string)
	for _, x := range values {
		if present && x == s {
			return s, true
		}
	}
	f.Hard = true
	f.Is.Add(key, enumMsg(values))
	return "", false
}

func enumMsg(values []string) string {
	a := make([]any, len(values))
	for i, v := range values {
		a[i] = v
	}
	return OneOf(a...)
}

// Num reads key as z.number(); Int adds .int(); min/max are inclusive bounds
// (nil = none). ok=false when absent+optional or an issue was added.
type N struct {
	Opt      bool
	Int      bool
	Min, Max *float64
	// Coerce is z.coerce.number(): Number(v), so "" and null are 0 and undefined is NaN.
	Coerce bool
	// Default is `.default(n)` (undefined only).
	Default *float64
	// IntMsg replaces the .int() message.
	IntMsg string
}

func P(v float64) *float64 { return &v }

func (f *Form) Num(key string, o N) (float64, bool) {
	if f.M == nil {
		return 0, false
	}
	v, present := f.M[key]
	if !present {
		if o.Default != nil {
			return *o.Default, true
		}
		if o.Opt {
			return 0, false
		}
	}
	n, isNum := v.(float64)
	if o.Coerce {
		n, isNum = coerceNumber(v, present)
		if !isNum {
			f.Hard = true
			f.Is.Add(key, Type("number", "NaN"))
			return 0, false
		}
	}
	if !isNum || math.IsNaN(n) || math.IsInf(n, 0) {
		f.Hard = true
		f.Is.Add(key, Type("number", Received(v, !present)))
		return 0, false
	}
	if o.Int && n != math.Trunc(n) {
		msg := o.IntMsg
		if msg == "" {
			msg = Type("int", "number")
		}
		f.Is.Add(key, msg)
		return 0, false
	}
	if o.Min != nil && n < *o.Min {
		f.Is.Add(key, TooSmall("number", *o.Min, true))
	}
	if o.Max != nil && n > *o.Max {
		f.Is.Add(key, TooBig("number", *o.Max, true))
	}
	return n, true
}

// Bool reads key as z.boolean(); def != nil is `.default(*def)`.
func (f *Form) Bool(key string, opt bool, def *bool) (bool, bool) {
	if f.M == nil {
		return false, false
	}
	v, present := f.M[key]
	if !present {
		if def != nil {
			return *def, true
		}
		if opt {
			return false, false
		}
	}
	b, isBool := v.(bool)
	if !isBool {
		f.Hard = true
		f.Is.Add(key, Type("boolean", Received(v, !present)))
		return false, false
	}
	return b, true
}

// Array reads key as z.array(...): the elements, or ok=false (issue added, or
// absent+optional). def true treats absence as an empty array (`.default([])`).
// Size checks come after the elements' own issues, so call Size once the
// elements are parsed.
func (f *Form) Array(key string, opt, def bool) ([]any, bool) {
	if f.M == nil {
		return nil, false
	}
	v, present := f.M[key]
	if !present {
		if def {
			return []any{}, true
		}
		if opt {
			return nil, false
		}
	}
	a, isArr := v.([]any)
	if !isArr {
		f.Hard = true
		f.Is.Add(key, Type("array", Received(v, !present)))
		return nil, false
	}
	return a, true
}

// Size is .min()/.max() on an array. zod runs them after the elements, and an
// element's own issues (a type issue included) do not stop them. aborted is
// kept for the callers that still pass it.
func (f *Form) Size(key string, n, min, max int, minMsg string, aborted bool) {
	if min > 0 && n < min {
		if minMsg == "" {
			minMsg = TooSmall("array", float64(min), true)
		}
		f.Is.Add(key, minMsg)
	}
	if max > 0 && n > max {
		f.Is.Add(key, TooBig("array", float64(max), true))
	}
}

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

// ObjectID is `z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.")` (msg
// overrides the text). path is the issue path; ok=false when refused.
func ObjectID(v any, path, msg string, is *Issues, missing bool) (string, bool) {
	s, isStr := v.(string)
	if !isStr {
		is.Add(path, Type("string", Received(v, missing)))
		return "", false
	}
	if !objectIDRe.MatchString(s) {
		if msg == "" {
			msg = "Invalid object id."
		}
		is.Add(path, msg)
		return "", false
	}
	return s, true
}

// JSPrefix is String#slice(0, n): the first n UTF-16 code units.
func JSPrefix(s string, n int) string {
	units := 0
	for i, r := range s {
		u := 1
		if r > 0xFFFF {
			u = 2
		}
		if units+u > n {
			return s[:i]
		}
		units += u
	}
	return s
}

// CoerceDate is z.coerce.date(): `new Date(value)`, valid or not.
func CoerceDate(v any) (time.Time, bool) {
	switch x := v.(type) {
	case float64:
		if x < -8.64e15 || x > 8.64e15 {
			return time.Time{}, false
		}
		return time.UnixMilli(int64(x)).UTC(), true
	case nil:
		return time.UnixMilli(0).UTC(), true
	case bool:
		if x {
			return time.UnixMilli(1).UTC(), true
		}
		return time.UnixMilli(0).UTC(), true
	case string:
		s := Trim(x)
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02", "2006-01", "2006",
			"2006-01-02 15:04:05", "Mon, 02 Jan 2006 15:04:05 MST", "January 2, 2006", "Jan 2, 2006", "1/2/2006"} {
			if t, err := time.Parse(layout, s); err == nil {
				return t.UTC(), true
			}
		}
	}
	return time.Time{}, false
}

var emailRe = regexp.MustCompile(`^([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

// IsEmail is zod 4's email check (its two lookaheads are the dot tests).
func IsEmail(s string) bool {
	return !strings.HasPrefix(s, ".") && !strings.Contains(s, "..") && emailRe.MatchString(s)
}

// Email reads key as `z.string({error: msg}).trim().toLowerCase().email(msg)`;
// an empty msg keeps zod's defaults.
func (f *Form) Email(key string, opt bool, msg string) (string, bool) {
	if f.M == nil {
		return "", false
	}
	v, present := f.M[key]
	if !present && opt {
		return "", false
	}
	s, isStr := v.(string)
	if !isStr {
		m := msg
		if m == "" {
			m = Type("string", Received(v, !present))
		}
		f.Is.Add(key, m)
		return "", false
	}
	s = strings.ToLower(Trim(s))
	if !IsEmail(s) {
		m := msg
		if m == "" {
			m = Format("email")
		}
		f.Is.Add(key, m)
	}
	return s, true
}

// Blank is `z.preprocess(blankToUndefined, …)`: true when key holds only
// whitespace, so the caller reads it as absent.
func (f *Form) Blank(key string) bool {
	s, ok := f.M[key].(string)
	return ok && Trim(s) == ""
}

// Nest reads key as a nested z.object: fill gets a form over it and its issues
// join f's under key. ok=false when absent+optional or not an object (issue added).
func (f *Form) Nest(key string, opt bool, fill func(sub *Form)) bool {
	if f.M == nil {
		return false
	}
	v, present := f.M[key]
	if !present && opt {
		return false
	}
	m, isObj := v.(map[string]any)
	if !isObj {
		f.Hard = true
		f.Is.Add(key, Type("object", Received(v, !present)))
		return false
	}
	sub := &Form{M: m}
	fill(sub)
	f.Join(key, sub)
	return true
}

// Join copies a sub-form's issues in under prefix (an array index works too).
func (f *Form) Join(prefix string, sub *Form) {
	f.Hard = f.Hard || sub.Hard
	for _, is := range sub.Is {
		p := prefix
		if is.Path != "" {
			p += "." + is.Path
		}
		f.Is.Add(p, is.Message)
	}
}

// JoinScalar copies the issues of a one-value form (key "v") in at prefix itself:
// an array element has no path of its own below its index.
func (f *Form) JoinScalar(prefix string, sub *Form) {
	f.Hard = f.Hard || sub.Hard
	for _, is := range sub.Is {
		f.Is.Add(prefix, is.Message)
	}
}

// coerceNumber is Number(v) for a JSON value; ok=false when that is NaN or infinite.
func coerceNumber(v any, present bool) (float64, bool) {
	var n float64
	switch x := v.(type) {
	case float64:
		n = x
	case string:
		n = JSNumber(x)
	case bool:
		if x {
			n = 1
		}
	case nil:
		if !present { // undefined
			return 0, false
		}
	default:
		return 0, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return n, true
}
