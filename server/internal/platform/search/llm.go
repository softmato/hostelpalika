package search

import (
	"context"
	"math"
	"regexp"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/llm"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const systemPrompt = "You convert a hostel seeker's search sentence into structured filters for a Nepal hostel listing site. Respond with valid JSON only."

// places are the areas and cities the model may name.
var places = append(append([]string{}, Areas...), Cities...)

// ParseWithLLM asks a model to structure a query the keyword pass could not
// explain. nil whenever the model is unavailable or its answer is unusable, so
// the caller can fall back to plain text search.
func ParseWithLLM(ctx context.Context, r *llm.Router, query string) Filters {
	prompt := strings.Join([]string{
		`Search sentence: "` + query + `"`,
		"",
		"Return one JSON object with only the keys you are confident about:",
		`{ "area": string, "type": "BOYS"|"GIRLS"|"CO_LIVING", "minPrice": number,`,
		`  "maxPrice": number, "food": "veg"|"non-veg", "facility": string,`,
		`  "roomType": string, "q": string }`,
		"",
		"Rules:",
		"- Omit every key you cannot infer. An empty object {} is a valid answer.",
		"- Never invent a value. Only use what the sentence actually says.",
		"- Prices are NPR per month; '8k' means 8000. If no budget is stated, omit",
		"  BOTH minPrice and maxPrice. Never set them to the same number.",
		"- area must be exactly one of: " + strings.Join(places, ", "),
		"- facility must be exactly one of: " + strings.Join(Facilities, ", "),
		"- roomType must be exactly one of: " + strings.Join(RoomTypes, ", "),
		"- q is only for a hostel or college NAME, max 60 characters. Never put the",
		"  whole sentence in q.",
		"- Do not add keys outside the list above.",
	}, "\n")
	temp := 0.1
	raw := r.Generate(ctx, prompt, llm.Options{JSON: true, MaxTokens: 300, SystemPrompt: systemPrompt, Temperature: &temp})
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	v, ok := llm.ParseModelJSON(raw, "parseWithLLM")
	payload, isObj := v.(map[string]any)
	if !ok || !isObj {
		return nil
	}
	return normalizeFilters(payload, query)
}

var squashRe = regexp.MustCompile(`[^a-z0-9]`)

func squash(s string) string { return squashRe.ReplaceAllString(strings.ToLower(s), "") }

// number is JS Number(value) for what JSON can hold.
func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		return valid.JSNumber(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case nil:
		return 0
	}
	return math.NaN()
}

// normalizeFilters whitelists and coerces the model's output: anything
// unexpected is dropped rather than trusted, because this feeds a database
// query and the free models confidently invent values.
func normalizeFilters(p map[string]any, query string) Filters {
	f := Filters{}
	squashedQuery := squash(query)
	// A vocabulary match the query must also actually mention.
	oneOf := func(v any, allowed []string) any {
		s, ok := v.(string)
		if !ok {
			return ordered.Undefined
		}
		needle := strings.ToLower(valid.Trim(s))
		for _, item := range allowed {
			if strings.ToLower(item) != needle {
				continue
			}
			for _, w := range splitWS.Split(item, -1) {
				if w = squash(w); len(w) >= 3 && strings.Contains(squashedQuery, w) {
					return item
				}
			}
			return ordered.Undefined
		}
		return ordered.Undefined
	}
	price := func(v any) any {
		n := number(v)
		if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 || n > 1_000_000 {
			return ordered.Undefined
		}
		return math.Floor(n + 0.5) // Math.round
	}
	f = f.Set("area", oneOf(p["area"], places)).Set("facility", oneOf(p["facility"], Facilities)).
		Set("roomType", oneOf(p["roomType"], RoomTypes)).Set("minPrice", price(p["minPrice"])).Set("maxPrice", price(p["maxPrice"]))
	// `q` is only useful as a short proper noun; echoing the sentence matches nothing.
	if s, ok := p["q"].(string); ok {
		if c := valid.Trim(s); c != "" && valid.JSLen(c) <= 60 && strings.ToLower(c) != strings.ToLower(valid.Trim(query)) {
			f = f.Set("q", c)
		}
	}
	if t, _ := p["type"].(string); t == "BOYS" || t == "GIRLS" || t == "CO_LIVING" {
		f = f.Set("type", t)
	}
	if t, _ := p["food"].(string); t == "veg" || t == "non-veg" {
		f = f.Set("food", t)
	}
	// A budget the sentence never mentioned is the most common hallucination.
	if !regexp.MustCompile(`\d`).MatchString(query) {
		f = f.Delete("minPrice").Delete("maxPrice")
	}
	lo, hasLo := f.Get("minPrice")
	hi, hasHi := f.Get("maxPrice")
	if hasLo && hasHi && lo != ordered.Undefined && hi != ordered.Undefined && lo.(float64) >= hi.(float64) {
		f = f.Delete("minPrice").Delete("maxPrice")
	}
	for _, pair := range f {
		if pair.Value != ordered.Undefined {
			return f
		}
	}
	return nil
}
