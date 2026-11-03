package zschema

import (
	"math"
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Issue is the message of the first issue zod's safeParse would report for v
// ("" when v parses): what a config editor's 422 shows.
func (d *Desc) Issue(v any) string {
	if is := d.Issues(v); len(is) > 0 {
		return is[0].Message
	}
	return ""
}

// Problem is one zod issue: where, and what.
type Problem struct {
	Path    []string
	Message string
	abort   bool
}

// Issues is every issue zod's safeParse reports for v, in its order.
func (d *Desc) Issues(v any) []Problem { return d.collect(v, nil) }

func at(path []string, msg string, abort bool) []Problem {
	return []Problem{{Path: append([]string(nil), path...), Message: msg, abort: abort}}
}

func soft(list []Problem) bool {
	for _, p := range list {
		if p.abort {
			return false
		}
	}
	return true
}

// collect walks v in the order zod reports issues. A failed type or value
// aborts; a failed check does not. A union with exactly one option that only
// failed checks reports that option's issues, as zod 4 does.
func (d *Desc) collect(v any, path []string) []Problem {
	switch d.T {
	case "default", "prefault":
		if v == ordered.Undefined {
			if d.T == "default" {
				return nil
			}
			v = Clone(d.def)
		}
		return d.Inner.collect(v, path)
	case "catch", "transform", "any", "unknown":
		return nil
	case "optional":
		if v == ordered.Undefined {
			return nil
		}
		return d.Inner.collect(v, path)
	case "nullable":
		if v == nil {
			return nil
		}
		return d.Inner.collect(v, path)
	case "readonly", "nonoptional":
		return d.Inner.collect(v, path)
	case "pipe":
		if is := d.In.collect(v, path); len(is) > 0 {
			return is
		}
		mid, _ := d.In.Parse(v)
		return d.Out.collect(mid, path)
	case "union":
		var only []Problem
		n := 0
		for _, o := range d.Options {
			is := o.collect(v, path)
			if len(is) == 0 {
				return nil
			}
			if soft(is) {
				n++
				only = is
			}
		}
		if n == 1 {
			return only
		}
		return at(path, d.or("Invalid input"), true)
	case "null":
		if v == nil {
			return nil
		}
		return at(path, d.typeMsg("null", v), true)
	case "literal", "enum":
		for _, want := range d.Values {
			if want == v {
				return nil
			}
		}
		return at(path, d.or(oneOf(d.Values, d.T == "enum")), true)
	case "boolean":
		if _, ok := v.(bool); !ok {
			return at(path, d.typeMsg("boolean", v), true)
		}
		return d.checkIssues(v, path)
	case "number":
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
			return at(path, d.typeMsg("number", v), true)
		}
		return d.checkIssues(f, path)
	case "string":
		s, ok := v.(string)
		if !ok {
			return at(path, d.typeMsg("string", v), true)
		}
		return d.stringIssues(s, path)
	case "array":
		in, ok := v.([]any)
		if !ok {
			return at(path, d.typeMsg("array", v), true)
		}
		var out []Problem
		for i, el := range in {
			out = append(out, d.El.collect(el, append(path, strconv.Itoa(i)))...)
		}
		if len(out) > 0 {
			return out
		}
		parsed, _ := d.Parse(v)
		return d.checkIssues(parsed, path)
	case "object":
		in, ok := v.(ordered.Map)
		if !ok {
			return at(path, d.typeMsg("object", v), true)
		}
		var out []Problem
		for _, f := range d.Shape {
			child, present := in.Get(f.Key)
			if !present {
				child = ordered.Undefined
			}
			out = append(out, f.Desc.collect(child, append(path, f.Key))...)
		}
		if len(out) > 0 {
			return out
		}
		parsed, _ := d.Parse(v)
		return d.checkIssues(parsed, path)
	case "record":
		in, ok := v.(ordered.Map)
		if !ok {
			return at(path, d.typeMsg("record", v), true)
		}
		var out []Problem
		for _, p := range in {
			out = append(out, d.Key.collect(p.Key, append(path, p.Key))...)
			out = append(out, d.Val.collect(p.Value, append(path, p.Key))...)
		}
		if len(out) > 0 {
			return out
		}
		parsed, _ := d.Parse(v)
		return d.checkIssues(parsed, path)
	}
	return at(path, "Invalid input", true)
}

func (d *Desc) or(msg string) string {
	if d.Msg != "" {
		return d.Msg
	}
	return msg
}

func (d *Desc) typeMsg(expected string, v any) string {
	return d.or("Invalid input: expected " + expected + ", received " + received(v))
}

func received(v any) string {
	if v == ordered.Undefined {
		return "undefined"
	}
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		if math.IsNaN(x) {
			return "NaN"
		}
		return "number"
	case []any:
		return "array"
	case ordered.Map:
		return "object"
	}
	return "unknown"
}

func primitive(v any) string {
	switch x := v.(type) {
	case string:
		return `"` + x + `"`
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(x)
	}
	return "unknown"
}

func oneOf(values []any, enum bool) string {
	if len(values) == 1 && !enum {
		return "Invalid input: expected " + primitive(values[0])
	}
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = primitive(v)
	}
	return "Invalid option: expected one of " + strings.Join(parts, "|")
}

func bound(word, origin, adj string, n float64) string {
	b := strconv.FormatFloat(n, 'f', -1, 64)
	switch origin {
	case "string":
		return word + ": expected string to have " + adj + b + " characters"
	case "array":
		return word + ": expected array to have " + adj + b + " items"
	}
	return word + ": expected " + origin + " to be " + adj + b
}

func originOf(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case []any:
		return "array"
	case ordered.Map:
		return "object"
	}
	return "number"
}

func withMsg(c Check, fallback string) string {
	if c.Msg != "" {
		return c.Msg
	}
	return fallback
}

func text(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return primitive(v)
}

// stringIssues is parseString's failing checks: zod runs every check on a string.
func (d *Desc) stringIssues(s string, path []string) []Problem {
	var out []Problem
	for _, c := range d.Checks {
		fail := ""
		switch c.K {
		case "trim":
			s = jsTrim(s)
		case "lower":
			s = strings.ToLower(s)
		case "upper":
			s = strings.ToUpper(s)
		case "min":
			if jsLen(s) < int(num(c.V)) {
				fail = bound("Too small", "string", ">=", num(c.V))
			}
		case "max":
			if jsLen(s) > int(num(c.V)) {
				fail = bound("Too big", "string", "<=", num(c.V))
			}
		case "len":
			if n := jsLen(s); n > int(num(c.V)) {
				fail = bound("Too big", "string", "<=", num(c.V))
			} else if n < int(num(c.V)) {
				fail = bound("Too small", "string", ">=", num(c.V))
			}
		case "regex":
			if !c.re.MatchString(s) {
				fail = "Invalid string: must match pattern /" + c.Src + "/" + c.Flags
			}
		case "email":
			if !isEmail(s) {
				fail = "Invalid email address"
			}
		case "url":
			if !isURL(s) {
				fail = "Invalid URL"
			}
		case "starts_with":
			if !strings.HasPrefix(s, text(c.V)) {
				fail = `Invalid string: must start with "` + text(c.V) + `"`
			}
		case "ends_with":
			if !strings.HasSuffix(s, text(c.V)) {
				fail = `Invalid string: must end with "` + text(c.V) + `"`
			}
		case "includes":
			if !strings.Contains(s, text(c.V)) {
				fail = `Invalid string: must include "` + text(c.V) + `"`
			}
		case "custom":
			if !refines[c.Fn](s) {
				fail = "Invalid input"
			}
		}
		if fail != "" {
			out = append(out, at(path, withMsg(c, fail), false)...)
		}
	}
	return out
}

// checkIssues is checks' failing checks.
func (d *Desc) checkIssues(v any, path []string) []Problem {
	var out []Problem
	for _, c := range d.Checks {
		fail := ""
		switch c.K {
		case "safeint":
			f := v.(float64)
			if f != math.Trunc(f) {
				fail = "Invalid input: expected int, received number"
			} else if math.Abs(f) > 1<<53-1 {
				fail = "Too big: expected int to be <=9007199254740991"
			}
		case "multipleOf":
			if floatSafeRemainder(v.(float64), num(c.V)) != 0 {
				fail = "Invalid number: must be a multiple of " + strconv.FormatFloat(num(c.V), 'f', -1, 64)
			}
		case "gte":
			if v.(float64) < num(c.V) {
				fail = bound("Too small", "number", ">=", num(c.V))
			}
		case "gt":
			if v.(float64) <= num(c.V) {
				fail = bound("Too small", "number", ">", num(c.V))
			}
		case "lte":
			if v.(float64) > num(c.V) {
				fail = bound("Too big", "number", "<=", num(c.V))
			}
		case "lt":
			if v.(float64) >= num(c.V) {
				fail = bound("Too big", "number", "<", num(c.V))
			}
		case "min":
			if size(v) < int(num(c.V)) {
				fail = bound("Too small", originOf(v), ">=", num(c.V))
			}
		case "max":
			if size(v) > int(num(c.V)) {
				fail = bound("Too big", originOf(v), "<=", num(c.V))
			}
		case "len":
			if n := size(v); n > int(num(c.V)) {
				fail = bound("Too big", originOf(v), "<=", num(c.V))
			} else if n < int(num(c.V)) {
				fail = bound("Too small", originOf(v), ">=", num(c.V))
			}
		case "custom":
			if !refines[c.Fn](v) {
				fail = "Invalid input"
			}
		}
		if fail != "" {
			out = append(out, at(path, withMsg(c, fail), false)...)
		}
	}
	return out
}
