package residents

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// resident-details.ts: the paper admission form as data, one shape for every
// door a resident comes in by.

var (
	GenderValues    = []string{"MALE", "FEMALE", "OTHER", "PREFER_NOT_TO_SAY"}
	BloodGroups     = []string{"A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "UNKNOWN"}
	DietaryValues   = []string{"NO_PREFERENCE", "VEG", "NON_VEG", "EGGETARIAN", "VEGAN"}
	signatureShape  = regexp.MustCompile(`^(?:[ML]\d{1,3} \d{1,3})+$`)
	signaturePoints = regexp.MustCompile(`([ML])(\d+) (\d+)`)
	dobShape        = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

const (
	signatureWidth     = 600
	signatureHeight    = 200
	signatureMinPoints = 8
)

// text is `z.preprocess(blankToUndefined, z.string().trim().max(n).optional())`.
func text(f *valid.Form, key string, max int, out *ordered.Map) {
	if !f.Present(key) || f.Blank(key) {
		return
	}
	if v, ok := f.Str(key, valid.S{Opt: true, Trim: true, Max: max}); ok {
		*out = append(*out, ordered.Pair{Key: key, Value: v})
	}
}

// pick is `z.preprocess(blankToUndefined, z.enum(values).optional())`.
func pick(f *valid.Form, key string, out *ordered.Map, values ...string) {
	if !f.Present(key) || f.Blank(key) {
		return
	}
	if v, ok := f.Enum(key, true, nil, values...); ok {
		*out = append(*out, ordered.Pair{Key: key, Value: v})
	}
}

// person is the details' `person` object, plus address for a local guardian.
func person(sub *valid.Form, withAddress bool) ordered.Map {
	var out ordered.Map
	if v, ok := sub.Str("name", valid.S{Trim: true, Min: 2, Max: 120}); ok {
		out = append(out, ordered.Pair{Key: "name", Value: v})
	}
	text(sub, "occupation", 80, &out)
	text(sub, "phone", 24, &out)
	if v, ok := sub.Str("relation", valid.S{Trim: true, Min: 2, Max: 60}); ok {
		out = append(out, ordered.Pair{Key: "relation", Value: v})
	}
	if withAddress {
		text(sub, "address", 160, &out)
	}
	return out
}

// signature is `residentSignatureSchema`: blank or absent is fine here (the
// callers decide whether one is needed); anything else must be a drawn signature.
func signature(f *valid.Form, key string, out *ordered.Map) {
	if !f.Present(key) || f.Blank(key) {
		return
	}
	v := f.M[key]
	s, ok := v.(string)
	if !ok {
		f.Is.Add(key, "Sign in the box before saving.")
		return
	}
	if valid.JSLen(s) > 16000 {
		f.Is.Add(key, "That signature is too detailed. Clear it and sign again.")
	}
	if !strings.HasPrefix(s, "M") || !signatureShape.MatchString(s) {
		f.Is.Add(key, "That signature could not be read. Clear it and sign again.")
	}
	pts := signaturePoints.FindAllStringSubmatch(s, -1)
	good := len(pts) >= signatureMinPoints
	for _, m := range pts {
		x, _ := strconv.ParseFloat(m[2], 64)
		y, _ := strconv.ParseFloat(m[3], 64)
		good = good && x <= signatureWidth && y <= signatureHeight
	}
	if !good {
		f.Is.Add(key, "Sign in the box before saving.")
	}
	*out = append(*out, ordered.Pair{Key: key, Value: s})
}

// ParseDetails is residentDetailsSchema over the object at key of f; the output
// is what zod keeps: schema order, undefined keys gone, family always present.
func ParseDetails(f *valid.Form, key string) (ordered.Map, bool) {
	var out ordered.Map
	ok := f.Nest(key, false, func(d *valid.Form) {
		if d.Present("dateOfBirth") && !d.Blank("dateOfBirth") {
			if v, ok := d.Str("dateOfBirth", valid.S{Opt: true, Trim: true, Re: dobShape, ReMsg: "Write the date of birth as YYYY-MM-DD."}); ok {
				out = append(out, ordered.Pair{Key: "dateOfBirth", Value: v})
			}
		}
		pick(d, "gender", &out, GenderValues...)
		pick(d, "bloodGroup", &out, BloodGroups...)
		pick(d, "food", &out, DietaryValues...)
		for _, t := range []struct {
			k string
			n int
		}{{"medicalNotes", 500}, {"district", 60}, {"municipality", 80}, {"wardNo", 10}, {"tole", 160},
			{"citizenshipNo", 40}, {"citizenshipIssuedOn", 20}, {"citizenshipIssuedAt", 80},
			{"institution", 160}, {"levelOfStudy", 80}, {"classTime", 60}, {"stayDuration", 60}} {
			text(d, t.k, t.n, &out)
		}
		family := []any{}
		if items, ok := d.Array("family", false, true); ok {
			aborted := false
			for i, raw := range items {
				p := "family." + strconv.Itoa(i)
				m, isObj := raw.(map[string]any)
				if !isObj {
					aborted = true
					d.Is.Add(p, valid.Type("object", valid.Received(raw, false)))
					continue
				}
				sub := &valid.Form{M: m}
				family = append(family, person(sub, false))
				d.Join(p, sub)
			}
			d.Size("family", len(items), 0, 6, "", aborted)
		}
		out = append(out, ordered.Pair{Key: "family", Value: family})
		d.Nest("localGuardian", true, func(g *valid.Form) {
			out = append(out, ordered.Pair{Key: "localGuardian", Value: person(g, true)})
		})
		signature(d, "signature", &out)
	})
	return out, ok
}

// DetailsEmpty is isEmpty: nothing but an empty family.
func DetailsEmpty(d ordered.Map) bool {
	for _, p := range d {
		if a, ok := p.Value.([]any); ok && len(a) == 0 {
			continue
		}
		return false
	}
	return true
}

// CardGap is cardGap: what the ID card needs beyond the schema, in the
// person's words, or "".
func CardGap(d ordered.Map) string {
	str := func(k string) string { v, _ := d.Get(k); s, _ := v.(string); return s }
	if str("dateOfBirth") == "" {
		return "Write your date of birth."
	}
	if str("gender") == "" {
		return "Choose your gender."
	}
	rung := false
	if fam, ok := d.Get("family"); ok {
		for _, p := range fam.([]any) {
			ph, _ := p.(ordered.Map).Get("phone")
			s, _ := ph.(string)
			digits := 0
			for _, r := range s {
				if r >= '0' && r <= '9' {
					digits++
				}
			}
			rung = rung || digits >= 7
		}
	}
	if !rung {
		return "Write your father's or mother's contact number."
	}
	if str("signature") == "" {
		return "Sign the form."
	}
	return ""
}
