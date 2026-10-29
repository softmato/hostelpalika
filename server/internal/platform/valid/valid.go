// Package valid builds zod-shaped validation errors. The messages are zod v4's
// English locale (node_modules/zod/v4/locales/en.js) word for word, because
// clients show them and TS tests assert on them.
//
// A request schema checks fields in the order the zod schema declares them,
// adds one issue per failure, and returns Issues.Err(); httpx.Fail answers it.
package valid

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Issues collects failures in schema order. The zero value is ready to use.
type Issues []httpx.Issue

// Add records one failure; path is dotted ("profile.phone", "tags.0"), "" for the root.
func (is *Issues) Add(path, message string) {
	*is = append(*is, httpx.Issue{Message: message, Path: path})
}

// Err is nil when nothing failed.
func (is Issues) Err() error {
	if len(is) == 0 {
		return nil
	}
	return &httpx.ValidationError{Issues: is}
}

// Received is zod's parsedType for a value decoded from JSON into any;
// pass missing=true for an absent key ("undefined").
func Received(v any, missing bool) string {
	if missing {
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
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// Type: invalid_type. expected is zod's name: string, number, int, boolean, object, array, date…
func Type(expected, received string) string {
	return "Invalid input: expected " + expected + ", received " + received
}

// OneOf: invalid_value (z.enum, z.literal, z.union of literals).
func OneOf(values ...any) string {
	if len(values) == 1 {
		return "Invalid input: expected " + primitive(values[0])
	}
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = primitive(v)
	}
	return "Invalid option: expected one of " + strings.Join(parts, "|")
}

// sizing is zod's Sizable table; other origins (number, date, bigint) compare values.
var sizing = map[string]string{"string": "characters", "file": "bytes", "array": "items", "set": "items", "map": "entries"}

// TooSmall: .min / .gt / .nonempty / .positive. origin is "string", "array", "number"…
func TooSmall(origin string, minimum float64, inclusive bool) string {
	adj := ">"
	if inclusive {
		adj = ">="
	}
	if unit, ok := sizing[origin]; ok {
		return "Too small: expected " + origin + " to have " + adj + num(minimum) + " " + unit
	}
	return "Too small: expected " + origin + " to be " + adj + num(minimum)
}

// TooBig: .max / .lt.
func TooBig(origin string, maximum float64, inclusive bool) string {
	adj := "<"
	if inclusive {
		adj = "<="
	}
	if unit, ok := sizing[origin]; ok {
		return "Too big: expected " + origin + " to have " + adj + num(maximum) + " " + unit
	}
	return "Too big: expected " + origin + " to be " + adj + num(maximum)
}

// Pattern: .regex(re). pattern is the JS literal as zod prints it, e.g. `/^\d+$/`.
func Pattern(pattern string) string { return "Invalid string: must match pattern " + pattern }

// formats is zod's FormatDictionary for the formats this API uses.
var formats = map[string]string{
	"email": "email address", "url": "URL", "uuid": "UUID", "datetime": "ISO datetime",
	"date": "ISO date", "time": "ISO time", "e164": "E.164 number", "jwt": "JWT",
}

// Format: z.email(), z.url(), z.iso.date()… Unknown names print as given, as zod does.
func Format(name string) string {
	if f, ok := formats[name]; ok {
		return "Invalid " + f
	}
	return "Invalid " + name
}

// num is JS Number#toString for the finite values a schema bound uses.
func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// primitive is zod's util.stringifyPrimitive.
func primitive(v any) string {
	switch x := v.(type) {
	case string:
		return `"` + x + `"`
	case float64:
		return num(x)
	case int:
		return strconv.Itoa(x)
	}
	return fmt.Sprint(v)
}
