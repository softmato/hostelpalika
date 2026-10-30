// Package search is lib/search/*: the hero search's keyword parser, its signed
// per-visitor LLM quota cookie, and the LLM fallback that structures a query
// the keywords could not explain.
package search

import (
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Filters is SearchFilters as the JSON object TS builds: key order is the
// order keys were first set, which is part of the wire bytes.
type Filters = ordered.Map

// ParsedSearch is ParsedSearch.
type ParsedSearch struct {
	Confidence  float64
	Filters     Filters
	RawTextOnly bool
	Source      string // "keyword" | "llm" | "fallback"
}

var Areas = []string{
	"Baneshwor", "New Baneshwor", "Old Baneshwor", "Koteshwor", "Balkumari", "Imadol", "Gwarko", "Satdobato", "Lagankhel",
	"Pulchowk", "Jawalakhel", "Kupondole", "Sanepa", "Ekantakuna", "Chabahil", "Boudha", "Baluwatar", "Maharajgunj",
	"Basundhara", "Samakhusi", "Gongabu", "Balaju", "Kalanki", "Kalimati", "Kirtipur", "Thamel", "Putalisadak",
	"Dillibazar", "Bagbazar", "Anamnagar", "Ghattekulo", "Sinamangal", "Tinkune", "Jadibuti", "Bhaktapur",
	"Suryabinayak", "Lokanthali", "Kausaltar", "Thimi", "Budhanilkantha", "Tokha", "Swayambhu", "Dhumbarahi",
	"Naxal", "Lazimpat", "Sundhara", "Teku", "Kalopul",
}

var Cities = []string{"Kathmandu", "Lalitpur", "Bhaktapur", "Pokhara", "Biratnagar", "Patan"}

type alias struct {
	re    *regexp.Regexp
	value string
}

func aliases(pairs ...string) []alias {
	out := make([]alias, 0, len(pairs)/2)
	for i := 0; i < len(pairs); i += 2 {
		out = append(out, alias{regexp.MustCompile(`(?i)` + pairs[i]), pairs[i+1]})
	}
	return out
}

var facilityAliases = aliases(
	`\bwi-?fi\b|\binternet\b`, "WiFi",
	`\bhot water\b|\bgeyser\b`, "Hot water",
	`\bparking\b|\bbike park\w*\b`, "Parking",
	`\blaundry\b|\bwashing\b`, "Laundry",
	`\bgym\b|\bfitness\b`, "Gym",
	`\bstudy (?:table|room)\b|\breading room\b`, "Study table",
	`\battach(?:ed)? (?:bath|toilet)\w*\b`, "Attached bathroom",
	`\bac\b|\bair con\w*\b`, "AC",
	`\bcctv\b|\bsecurity camera\b`, "CCTV",
	`\bbackup\b|\binverter\b|\bgenerator\b`, "Power backup",
)

var roomTypeAliases = aliases(
	`\bsingle\b|\b1\s*sharing\b|\bone sharing\b`, "Single",
	`\b(?:two|2)\s*sharing\b|\bdouble\b`, "Double",
	`\b(?:three|3)\s*sharing\b|\btriple\b`, "Triple",
	`\b(?:four|4)\s*sharing\b|\bdorm\w*\b`, "Dormitory",
)

func values(a []alias) []string {
	out := make([]string, len(a))
	for i, x := range a {
		out[i] = x.value
	}
	return out
}

// RoomTypes and Facilities bound what the LLM may emit.
var (
	RoomTypes  = values(roomTypeAliases)
	Facilities = values(facilityAliases)
)

var fillerWords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`a an the any some good best nice hostel hostels room rooms place places stay staying
		near nearby around close closeby beside in at on of to for with find looking look search searching want need
		please show me is are there i my`) {
		fillerWords[w] = true
	}
}

// ws is JS \s: ASCII whitespace plus the Unicode space separators.
const ws = `\s\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

var (
	splitWS    = regexp.MustCompile(`[` + ws + `]+`)
	nonWord    = regexp.MustCompile(`[^\w]`)
	amountSrc  = `(\d[\d,]*)\s*(k|thousand|hajar|hazar)?`
	betweenRe  = regexp.MustCompile(`(?i)\bbetween\s+` + amountSrc + `\s*(?:-|–|to|and)\s*` + amountSrc)
	underRe    = regexp.MustCompile(`(?i)\b(?:under|below|less than|upto|up to|max|within)\s+` + amountSrc)
	overRe     = regexp.MustCompile(`(?i)\b(?:above|over|more than|at least|min|minimum)\s+` + amountSrc)
	rangeRe    = regexp.MustCompile(`(?i)\b` + amountSrc + `\s*(?:-|–|to)\s*` + amountSrc)
	suffixRe   = regexp.MustCompile(`(?i)^(k|thousand|hajar|hazar)$`)
	girlsRe    = regexp.MustCompile(`(?i)\bgirls?\b|\bfemale\b|\bladies\b`)
	boysRe     = regexp.MustCompile(`(?i)\bboys?\b|\bmale\b|\bgents\b`)
	coRe       = regexp.MustCompile(`(?i)\bco-?living\b|\bco-?ed\b|\bmixed\b`)
	cheapRe    = regexp.MustCompile(`(?i)\bcheap\w*\b|\baffordable\b|\bbudget\b|\bsasto\b`)
	vegRe      = regexp.MustCompile(`(?i)\bveg(?:etarian)?\b`)
	nonVegRe   = regexp.MustCompile(`(?i)\bnon-?\s?veg`)
	nonVegWord = regexp.MustCompile(`(?i)\bnon-?\s?veg\w*\b`)
	genericCol = regexp.MustCompile(`(?i)^(campus|college|university|international|model)$`)
)

// stripFillerWords drops filler words, keeping the proper nouns a substring
// search needs; a sentence of nothing but filler is searched whole.
func stripFillerWords(query string) string {
	var kept []string
	for _, w := range splitWS.Split(query, -1) {
		if !fillerWords[nonWord.ReplaceAllString(strings.ToLower(w), "")] {
			kept = append(kept, w)
		}
	}
	if joined := valid.Trim(strings.Join(kept, " ")); joined != "" {
		return joined
	}
	return query
}

// parseAmount: "8k" / "8 thousand" / "8,000" / "8 hajar" → 8000; a bare
// number under 1000 in a rent query is thousands. NaN when not a number.
func parseAmount(raw, suffix string) float64 {
	base := valid.JSNumber(strings.NewReplacer(",", "", " ", "").Replace(raw))
	if math.IsNaN(base) || math.IsInf(base, 0) {
		return math.NaN()
	}
	thousands := suffix != "" && suffixRe.MatchString(valid.Trim(suffix))
	if thousands || base < 1000 {
		return base * 1000
	}
	return base
}

func wordRe(s string) *regexp.Regexp { return regexp.MustCompile(`(?i)\b` + s + `\b`) }

var sortedAreas = func() []string {
	out := append([]string{}, Areas...)
	sort.SliceStable(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}()

var areaRes = func() map[string]*regexp.Regexp {
	m := map[string]*regexp.Regexp{}
	for _, a := range Areas {
		m[a] = wordRe(regexp.MustCompile(`\s+`).ReplaceAllString(a, `\s+`))
	}
	return m
}()

func matchArea(q string) string {
	for _, a := range sortedAreas { // longest first so "New Baneshwor" wins over "Baneshwor"
		if areaRes[a].MatchString(q) {
			return a
		}
	}
	return ""
}

type college struct{ name string }

var colleges = []college{
	{"Tribhuvan University (Kirtipur)"}, {"IOE Pulchowk Campus"}, {"Kathmandu University (Dhulikhel)"},
	{"Amrit Science Campus (Lainchaur)"}, {"St. Xavier's College (Maitighar)"}, {"Islington College (Kamalpokhari)"},
	{"Trinity International College (Dillibazar)"}, {"KCM (Gwarko)"}, {"Kathmandu Model College (Bagbazar)"},
	{"Purwanchal Campus / Bhaktapur MC"},
}

func matchCollegeArea(q string) string {
	for _, c := range colleges {
		name := strings.NewReplacer("(", " ", ")", " ").Replace(c.name)
		for _, w := range splitWS.Split(name, -1) {
			if valid.JSLen(w) > 4 && !genericCol.MatchString(w) && wordRe(regexp.QuoteMeta(w)).MatchString(q) {
				return c.name
			}
		}
	}
	return ""
}

// amount is a parsed price; a number JS cannot represent prints as null.
func amount(m []string, i int) any {
	if f := parseAmount(m[i], m[i+1]); !math.IsNaN(f) {
		return f
	}
	return nil
}

// ParseSearchQuery is the deterministic first pass: cheap, instant, and enough
// for the overwhelming majority of hero searches (an area, a gender, a budget).
func ParseSearchQuery(input string) ParsedSearch {
	query := valid.Trim(input)
	f := Filters{}
	signals := 0
	if query == "" {
		return ParsedSearch{Confidence: 1, Filters: f, Source: "keyword"}
	}
	switch {
	case girlsRe.MatchString(query):
		f, signals = f.Set("type", "GIRLS"), signals+1
	case boysRe.MatchString(query):
		f, signals = f.Set("type", "BOYS"), signals+1
	case coRe.MatchString(query):
		f, signals = f.Set("type", "CO_LIVING"), signals+1
	}
	area := matchArea(query)
	if area != "" {
		f, signals = f.Set("area", area), signals+1
	} else {
		for _, city := range Cities {
			if wordRe(city).MatchString(query) {
				f, signals = f.Set("area", city), signals+1
				break
			}
		}
	}
	// A college reference is a location intent; the campus name is the most
	// useful free-text handle.
	if col := matchCollegeArea(query); col != "" {
		if _, has := f.Get("area"); !has {
			f, signals = f.Set("q", strings.SplitN(col, " (", 2)[0]), signals+1
		}
	}
	switch between, under, over, rng := betweenRe.FindStringSubmatch(query), underRe.FindStringSubmatch(query),
		overRe.FindStringSubmatch(query), rangeRe.FindStringSubmatch(query); {
	case between != nil:
		f = f.Set("minPrice", amount(between, 1)).Set("maxPrice", amount(between, 3))
		signals++
	case under != nil:
		f, signals = f.Set("maxPrice", amount(under, 1)), signals+1
	case over != nil:
		f, signals = f.Set("minPrice", amount(over, 1)), signals+1
	case rng != nil:
		f = f.Set("minPrice", amount(rng, 1)).Set("maxPrice", amount(rng, 3))
		signals++
	case cheapRe.MatchString(query):
		// A soft budget hint rather than a stated number.
		f, signals = f.Set("maxPrice", 8000.0), signals+1
	}
	switch {
	case vegRe.MatchString(query) && !nonVegRe.MatchString(query):
		f, signals = f.Set("food", "veg"), signals+1
	case nonVegWord.MatchString(query):
		f, signals = f.Set("food", "non-veg"), signals+1
	}
	for _, a := range facilityAliases {
		if a.re.MatchString(query) {
			f, signals = f.Set("facility", a.value), signals+1
			break
		}
	}
	for _, a := range roomTypeAliases {
		if a.re.MatchString(query) {
			f, signals = f.Set("roomType", a.value), signals+1
			break
		}
	}
	// Words the passes above consumed; what is left over is what an LLM could
	// still explain — a lot of leftovers means low confidence.
	var consumed []string
	for _, k := range []string{"area", "facility", "roomType", "q"} {
		if v, ok := f.Get(k); ok {
			if s, _ := v.(string); s != "" {
				consumed = append(consumed, s)
			}
		}
	}
	joined := strings.Join(consumed, " ")
	leftover := 0
	for _, w := range splitWS.Split(query, -1) {
		if valid.JSLen(w) <= 2 {
			continue
		}
		if !regexp.MustCompile(`(?i)` + nonWord.ReplaceAllString(w, "")).MatchString(joined) {
			leftover++
		}
	}
	confidence := 0.0
	if signals != 0 {
		confidence = math.Min(1, float64(signals)/math.Max(1, math.Ceil(float64(leftover)/2)))
	}
	_, hasQ := f.Get("q")
	rawTextOnly := !hasQ && signals == 0
	if rawTextOnly {
		f = f.Set("q", valid.JSPrefix(stripFillerWords(query), 160))
	}
	return ParsedSearch{Confidence: confidence, Filters: f, RawTextOnly: rawTextOnly, Source: "keyword"}
}
