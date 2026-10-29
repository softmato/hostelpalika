// Package zschema runs zod v4 schemas exported as JSON descriptors by
// testdata/vectors/zod-describe.ts, so Go re-parses a stored value exactly as
// TS's `schema.safeParse` would: strip unknown keys, fill defaults, apply
// trims and transforms, and output keys in schema order.
//
// Only success and the parsed value are modelled — not zod's issue messages.
// Request bodies keep using package valid, which does model them.
//
// Values are what package ordered produces: ordered.Map, []any, float64,
// string, bool, nil, and ordered.Undefined for an absent key.
package zschema

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

type Desc struct {
	T        string  `json:"t"`
	Checks   []Check `json:"checks"`
	Shape    []Field `json:"shape"`
	Catchall *Desc   `json:"catchall"`
	El       *Desc   `json:"el"`
	Options  []*Desc `json:"options"`
	Inner    *Desc   `json:"inner"`
	In       *Desc   `json:"in"`
	Out      *Desc   `json:"out"`
	Key      *Desc   `json:"key"`
	Val      *Desc   `json:"val"`
	Fn       string  `json:"fn"`
	Values   []any   `json:"values"`
	// Value is a default's (or catch's) value, decoded in key order on Load.
	Value json.RawMessage `json:"value"`
	def   any
}

type Check struct {
	K     string `json:"k"`
	V     any    `json:"v"`
	Src   string `json:"src"`
	Flags string `json:"flags"`
	Fn    string `json:"fn"`
	re    *regexp.Regexp
}

// Field is one [key, schema] pair of an object shape, in declared order.
type Field struct {
	Key  string
	Desc *Desc
}

func (f *Field) UnmarshalJSON(b []byte) error {
	var pair [2]json.RawMessage
	if err := json.Unmarshal(b, &pair); err != nil {
		return err
	}
	f.Desc = &Desc{}
	if err := json.Unmarshal(pair[0], &f.Key); err != nil {
		return err
	}
	return json.Unmarshal(pair[1], f.Desc)
}

// Prepare decodes defaults and compiles patterns; call once after json.Unmarshal.
// An unknown type, check or function is an error, so a new zod feature fails
// the build's tests instead of parsing wrongly.
func (d *Desc) Prepare() error {
	if d == nil {
		return nil
	}
	switch d.T {
	case "object", "array", "union", "optional", "nullable", "readonly", "nonoptional", "default", "prefault",
		"catch", "pipe", "literal", "enum", "record", "string", "number", "boolean", "any", "unknown", "null":
	case "transform":
		if _, ok := transforms[d.Fn]; !ok {
			return fmt.Errorf("zschema: unknown transform %q", d.Fn)
		}
	default:
		return fmt.Errorf("zschema: unknown type %q", d.T)
	}
	if len(d.Value) > 0 && d.T != "record" {
		v, err := ordered.FromJSON(d.Value)
		if err != nil {
			return err
		}
		d.def = v
	}
	for i := range d.Checks {
		c := &d.Checks[i]
		switch c.K {
		case "regex":
			src := c.Src
			if strings.Contains(c.Flags, "i") {
				src = "(?i)" + src
			}
			re, err := regexp.Compile(src)
			if err != nil {
				return fmt.Errorf("zschema: pattern %q: %w", c.Src, err)
			}
			c.re = re
		case "custom":
			if _, ok := refines[c.Fn]; !ok {
				return fmt.Errorf("zschema: unknown refine %q", c.Fn)
			}
		case "trim", "lower", "multipleOf", "min", "max", "len", "gte", "gt", "lte", "lt", "safeint", "email", "url", "starts_with", "ends_with", "includes":
		default:
			return fmt.Errorf("zschema: unknown check %q", c.K)
		}
	}
	for _, f := range d.Shape {
		if err := f.Desc.Prepare(); err != nil {
			return err
		}
	}
	for _, sub := range append([]*Desc{d.Catchall, d.El, d.Inner, d.In, d.Out, d.Key, d.Val}, d.Options...) {
		if err := sub.Prepare(); err != nil {
			return err
		}
	}
	return nil
}

// Parse is safeParse: the parsed value and whether it succeeded.
func (d *Desc) Parse(v any) (any, bool) {
	switch d.T {
	case "default", "prefault":
		if v == ordered.Undefined {
			if d.T == "default" { // zod 4 hands a default back unparsed
				return Clone(d.def), true
			}
			v = Clone(d.def)
		}
		return d.Inner.Parse(v)
	case "catch":
		if out, ok := d.Inner.Parse(v); ok {
			return out, true
		}
		return Clone(d.def), true
	case "optional":
		if v == ordered.Undefined {
			return v, true
		}
		return d.Inner.Parse(v)
	case "nullable":
		if v == nil {
			return nil, true
		}
		return d.Inner.Parse(v)
	case "readonly", "nonoptional":
		return d.Inner.Parse(v)
	case "pipe":
		mid, ok := d.In.Parse(v)
		if !ok {
			return nil, false
		}
		return d.Out.Parse(mid)
	case "transform":
		return transforms[d.Fn](v), true
	case "union":
		for _, o := range d.Options {
			if out, ok := o.Parse(v); ok {
				return out, true
			}
		}
		return nil, false
	case "any", "unknown":
		return v, true
	case "null":
		return nil, v == nil
	case "literal", "enum":
		for _, want := range d.Values {
			if want == v {
				return v, true
			}
		}
		return nil, false
	case "boolean":
		_, ok := v.(bool)
		return v, ok && d.checks(v)
	case "number":
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, false
		}
		return f, d.checks(f)
	case "string":
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		return d.parseString(s)
	case "array":
		in, ok := v.([]any)
		if !ok {
			return nil, false
		}
		out := make([]any, len(in))
		good := true
		for i, el := range in {
			r, ok := d.El.Parse(el)
			good = good && ok
			out[i] = r
		}
		return out, good && d.checks(out)
	case "object":
		in, ok := v.(ordered.Map)
		if !ok {
			return nil, false
		}
		out := make(ordered.Map, 0, len(d.Shape))
		good := true
		for _, f := range d.Shape {
			child, present := in.Get(f.Key)
			if !present {
				child = ordered.Undefined
			}
			r, ok := f.Desc.Parse(child)
			good = good && ok
			if r != ordered.Undefined || present {
				out = append(out, ordered.Pair{Key: f.Key, Value: r})
			}
		}
		return out, good && d.checks(out)
	case "record":
		in, ok := v.(ordered.Map)
		if !ok {
			return nil, false
		}
		out := make(ordered.Map, 0, len(in))
		good := true
		for _, p := range in {
			k, kok := d.Key.Parse(p.Key)
			r, vok := d.Val.Parse(p.Value)
			good = good && kok && vok
			ks, _ := k.(string)
			out = append(out, ordered.Pair{Key: ks, Value: r})
		}
		return out, good && d.checks(out)
	}
	return nil, false
}

// parseString runs the checks in declared order; an overwrite (trim) changes
// what every later check sees, as in zod.
func (d *Desc) parseString(s string) (any, bool) {
	good := true
	for _, c := range d.Checks {
		switch c.K {
		case "trim":
			s = jsTrim(s)
		case "lower":
			s = strings.ToLower(s)
		case "min":
			good = good && jsLen(s) >= int(num(c.V))
		case "max":
			good = good && jsLen(s) <= int(num(c.V))
		case "len":
			good = good && jsLen(s) == int(num(c.V))
		case "regex":
			good = good && c.re.MatchString(s)
		case "email":
			good = good && isEmail(s)
		case "url":
			good = good && isURL(s)
		case "starts_with":
			good = good && strings.HasPrefix(s, fmt.Sprint(c.V))
		case "ends_with":
			good = good && strings.HasSuffix(s, fmt.Sprint(c.V))
		case "includes":
			good = good && strings.Contains(s, fmt.Sprint(c.V))
		case "custom":
			good = good && refines[c.Fn](s)
		}
	}
	return s, good
}

// checks runs the non-string checks (numbers, array/object sizes, refines).
// A refine only sees a value whose children all parsed, as in zod.
func (d *Desc) checks(v any) bool {
	for _, c := range d.Checks {
		ok := true
		switch c.K {
		case "safeint":
			f := v.(float64)
			ok = f == math.Trunc(f) && math.Abs(f) <= 1<<53-1
		case "multipleOf":
			ok = floatSafeRemainder(v.(float64), num(c.V)) == 0
		case "gte":
			ok = v.(float64) >= num(c.V)
		case "gt":
			ok = v.(float64) > num(c.V)
		case "lte":
			ok = v.(float64) <= num(c.V)
		case "lt":
			ok = v.(float64) < num(c.V)
		case "min":
			ok = size(v) >= int(num(c.V))
		case "max":
			ok = size(v) <= int(num(c.V))
		case "len":
			ok = size(v) == int(num(c.V))
		case "custom":
			ok = refines[c.Fn](v)
		}
		if !ok {
			return false
		}
	}
	return true
}

// floatSafeRemainder is zod's util.floatSafeRemainder: both numbers scaled to
// whole integers at the larger decimal count before the remainder.
func floatSafeRemainder(val, step float64) float64 {
	decimals := func(f float64) int {
		s := strconv.FormatFloat(f, 'f', -1, 64)
		if i := strings.IndexByte(s, '.'); i >= 0 {
			return len(s) - i - 1
		}
		return 0
	}
	n := max(decimals(val), decimals(step))
	scale := func(f float64) int64 {
		i, _ := strconv.ParseInt(strings.Replace(strconv.FormatFloat(f, 'f', n, 64), ".", "", 1), 10, 64)
		return i
	}
	vi, si := scale(val), scale(step)
	if si == 0 {
		return math.NaN()
	}
	return float64(vi%si) / math.Pow10(n)
}

func size(v any) int {
	switch x := v.(type) {
	case []any:
		return len(x)
	case ordered.Map:
		return len(x)
	}
	return 0
}

func num(v any) float64 { f, _ := v.(float64); return f }

// jsLen is String.prototype.length: UTF-16 code units.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// JSTrim is String.prototype.trim.
func JSTrim(s string) string { return jsTrim(s) }

// jsTrim is String.prototype.trim: JS whitespace and line terminators, which
// include U+FEFF and exclude U+0085 (unicode.IsSpace has it the other way).
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
			return true
		}
		return r >= 0x2000 && r <= 0x200a
	})
}

// zod 4's email pattern without its two lookaheads, which RE2 lacks; they are
// the leading-dot and ".." tests in isEmail.
var emailRe = regexp.MustCompile(`^([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

func isEmail(s string) bool {
	return !strings.HasPrefix(s, ".") && !strings.Contains(s, "..") && emailRe.MatchString(s)
}

// isURL is zod 4's url check: `new URL(value)` succeeds.
// ponytail: net/url is laxer than WHATWG URL on odd inputs; tighten if a stored URL ever disagrees.
func isURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme != "" && (u.Host != "" || u.Opaque != "")
}

// Clone deep-copies a value so a default handed out is never shared.
func Clone(v any) any {
	switch x := v.(type) {
	case ordered.Map:
		out := make(ordered.Map, len(x))
		for i, p := range x {
			out[i] = ordered.Pair{Key: p.Key, Value: Clone(p.Value)}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = Clone(e)
		}
		return out
	}
	return v
}

// Truthy is JS truthiness for the values zschema handles.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return v != ordered.Undefined
}

// PlatformName is PLATFORM_NAME (packages/shared/src/brand/brand.ts).
const PlatformName = "HostelPalika"

var transforms = map[string]func(any) any{
	"platformName": func(any) any { return PlatformName },
	"filterBoolean": func(v any) any {
		out := []any{}
		for _, e := range v.([]any) {
			if Truthy(e) {
				out = append(out, e)
			}
		}
		return out
	},
	"filterPhone": func(v any) any {
		out := []any{}
		for _, e := range v.([]any) {
			if m, ok := e.(ordered.Map); ok {
				if p, _ := m.Get("phone"); Truthy(p) {
					out = append(out, e)
				}
			}
		}
		return out
	},
}

func field(v any, key string) any {
	m, _ := v.(ordered.Map)
	x, _ := m.Get(key)
	return x
}

var refines = map[string]func(any) bool{
	"https":        func(v any) bool { return strings.HasPrefix(v.(string), "https://") },
	"httpsOrBlank": func(v any) bool { s := v.(string); return s == "" || strings.HasPrefix(s, "https://") },
	"lifetimeDates": func(v any) bool {
		start, _ := field(v, "startsOn").(string)
		end, _ := field(v, "endsOn").(string)
		return start == "" || end == "" || end >= start
	},
	"lifetimeUniqueOffers": func(v any) bool {
		offers, _ := field(v, "offers").([]any)
		seen := map[any]bool{}
		for _, o := range offers {
			seen[field(o, "planId")] = true
		}
		return len(seen) == len(offers)
	},
	"bookingRules": bookingRules,
	"leaveHold": func(v any) bool {
		return num(field(v, "leaveHoldMinDays")) <= num(field(v, "leaveHoldMaxDays"))
	},
}

// bookingRules is bookingConfigSchema's superRefine (booking-config.ts): cancel
// steps strictly later and never more generous, the last one ending on the
// hold's last day, a no-show refunding less, reminders unique and inside their
// windows.
func bookingRules(v any) bool {
	steps, _ := field(v, "cancelSteps").([]any)
	for i := 1; i < len(steps); i++ {
		if num(field(steps[i], "throughDay")) <= num(field(steps[i-1], "throughDay")) ||
			num(field(steps[i], "refundPercent")) > num(field(steps[i-1], "refundPercent")) {
			return false
		}
	}
	hold := num(field(v, "holdDays"))
	if len(steps) > 0 {
		last := steps[len(steps)-1]
		if num(field(last, "throughDay")) != hold {
			return false
		}
		if noShow := num(field(v, "noShowRefundPercent")); noShow > 0 && noShow >= num(field(last, "refundPercent")) {
			return false
		}
	}
	within := func(key string, limit float64) bool {
		list, _ := field(v, key).([]any)
		seen := map[float64]bool{}
		for _, h := range list {
			if seen[num(h)] || num(h) >= limit {
				return false
			}
			seen[num(h)] = true
		}
		return true
	}
	return within("hostelReminderHoursLeft", num(field(v, "hostelAnswerHours"))) && within("moveInReminderHoursLeft", hold*24)
}
