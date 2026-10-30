package hostels

import (
	"regexp"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// hostel-registration.validation.ts: the one shape a hostel registration has.

var (
	panShape   = regexp.MustCompile(`^\d{9}$`)
	yearShape  = regexp.MustCompile(`^\d{4}$`)
	photoHTTP  = regexp.MustCompile(`(?i)^https?://`)
	walletNum  = regexp.MustCompile(`^9[678]\d{8}$`)
	bankNumber = regexp.MustCompile(`^[A-Z0-9]{6,24}$`)
	spacesDash = regexp.MustCompile(`[\s-]`)
)

// Reg is HostelRegistrationInput as the service reads it.
type Reg struct {
	Capacity     bson.D
	Contact      bson.D
	ContactSet   bool
	Desc         *string
	Documents    []files.Submitted
	Facilities   []string
	Food         bson.D
	FoodSet      bool
	HostelType   string
	Location     bson.D
	LocCity      string
	LocArea      string
	Name         string
	Notes        *string
	Photos       bson.A
	Pricing      bson.D
	PricingSet   bool
	Deposit      *float64
	Rooms        []RoomCfg
	RoomTypes    []string
	Rules        []string
	Floors       *float64
	AltPhone     *string
	Applicant    Applicant
	Landmark     *string
	MapLink      *string
	PAN          *string
	Plan         *PlanChoice
	ShortStays   *ShortStaysIn
	Payout       *Payout
	RefDisc      *float64
	TotalCap     *float64
	Year         *string
	RefCode      string
	AdmissionFee *float64
}

type RoomCfg struct {
	Beds        float64
	Meal        string
	MonthlyRent *float64
	Deposit     *float64
	Rooms       float64
	RoomType    string
	Vacant      float64
}

type Applicant struct {
	Age, Email, Gender, IDProof *string
	Name, Phone                 string
}

type PlanChoice struct {
	Cycle    string
	Lifetime *bool
	PlanID   string
}

type ShortStaysIn struct {
	Enabled   bool
	MinNights float64
	Rates     []ShortRate
}

type ShortRate struct {
	Daily    float64
	RoomType string
}

type Payout struct {
	Bank, Branch, Holder, Method, Number string
}

func regStr(f *valid.Form, key string, o valid.S) *string {
	o.Opt, o.Trim = true, true
	if v, ok := f.Str(key, o); ok {
		return &v
	}
	return nil
}

func regNum(f *valid.Form, key string, o valid.N) *float64 {
	o.Opt, o.Coerce = true, true
	if v, ok := f.Num(key, o); ok {
		return &v
	}
	return nil
}

func nonneg() *float64 { return valid.P(0) }

// textArray is textArraySchema: strings trim min1 max80, at most 40, default [].
func textArray(f *valid.Form, key string) []string {
	items, ok := f.Array(key, false, true)
	if !ok {
		return nil
	}
	out := []string{}
	for i, raw := range items {
		sub := &valid.Form{M: map[string]any{"v": raw}}
		if s, ok := sub.Str("v", valid.S{Trim: true, Min: 1, Max: 80}); ok {
			out = append(out, s)
		}
		f.JoinScalar(key+"."+strconv.Itoa(i), sub)
	}
	f.Size(key, len(items), 0, 40, "", false)
	return out
}

// each runs one array's elements as objects, joining their issues under key.i.
func each(f *valid.Form, key string, items []any, fill func(i int, sub *valid.Form)) {
	for i, raw := range items {
		p := key + "." + strconv.Itoa(i)
		m, isObj := raw.(map[string]any)
		if !isObj {
			f.Hard = true
			f.Is.Add(p, valid.Type("object", valid.Received(raw, false)))
			continue
		}
		sub := &valid.Form{M: m}
		fill(i, sub)
		f.Join(p, sub)
	}
}

// ParseRegistration is hostelRegistrationSchema (the public desk's: no payment,
// the plan optional, a referral code allowed).
func ParseRegistration(body any) (Reg, error) {
	f := valid.NewForm(body)
	var in Reg
	f.Nest("capacitySummary", true, func(s *valid.Form) {
		for _, k := range []string{"totalBeds", "totalRooms", "vacantBeds"} {
			if v := regNum(s, k, valid.N{Int: true, Min: nonneg()}); v != nil {
				in.Capacity = append(in.Capacity, bson.E{Key: k, Value: *v})
			}
		}
	})
	if f.Nest("contact", true, func(s *valid.Form) {
		if v, ok := s.Str("email", valid.S{Opt: true, Trim: true}); ok {
			if !valid.IsEmail(v) {
				s.Is.Add("email", valid.Format("email"))
			}
			in.Contact = append(in.Contact, bson.E{Key: "email", Value: v})
		}
		if v := regStr(s, "phone", valid.S{Min: 7, Max: 24}); v != nil {
			in.Contact = append(in.Contact, bson.E{Key: "phone", Value: *v})
		}
	}) {
		in.ContactSet = true
	}
	in.Desc = regStr(f, "description", valid.S{Max: 2000})
	in.Documents = files.ParseSubmitted(f, "documents", true, 0, "")
	in.Facilities = textArray(f, "facilities")
	if f.Nest("food", true, func(s *valid.Form) {
		yes := true
		veg, _ := s.Bool("hasVeg", false, &yes)
		non, _ := s.Bool("hasNonVeg", false, &yes)
		in.Food = bson.D{{Key: "hasNonVeg", Value: non}, {Key: "hasVeg", Value: veg}}
		if v := regNum(s, "mealsPerDay", valid.N{Int: true, Min: nonneg(), Max: valid.P(6)}); v != nil {
			in.Food = append(in.Food, bson.E{Key: "mealsPerDay", Value: *v})
		}
		if v := regStr(s, "notes", valid.S{Max: 500}); v != nil {
			in.Food = append(in.Food, bson.E{Key: "notes", Value: *v})
		}
	}) {
		in.FoodSet = true
	}
	both := "CO_LIVING"
	in.HostelType, _ = f.Enum("hostelType", true, &both, "BOYS", "GIRLS", "CO_LIVING")
	f.Nest("location", false, func(s *valid.Form) {
		if v := regStr(s, "address", valid.S{Max: 240}); v != nil {
			in.Location = append(in.Location, bson.E{Key: "address", Value: *v})
		}
		area, _ := s.Str("area", valid.S{Trim: true, Min: 2, Max: 120})
		in.LocArea = area
		in.Location = append(in.Location, bson.E{Key: "area", Value: area})
		city := "Kathmandu"
		if v, ok := s.Str("city", valid.S{Opt: true, Trim: true, Min: 2, Max: 120}); ok {
			city = v
		}
		in.LocCity = city
		in.Location = append(in.Location, bson.E{Key: "city", Value: city})
		if v := regNum(s, "lat", valid.N{Min: valid.P(-90), Max: valid.P(90)}); v != nil {
			in.Location = append(in.Location, bson.E{Key: "lat", Value: *v})
		}
		if v := regNum(s, "lng", valid.N{Min: valid.P(-180), Max: valid.P(180)}); v != nil {
			in.Location = append(in.Location, bson.E{Key: "lng", Value: *v})
		}
		if s.Present("locationSource") {
			if v, ok := s.Enum("locationSource", true, nil, "MANUAL", "GEOCODED"); ok {
				in.Location = append(in.Location, bson.E{Key: "locationSource", Value: v})
			}
		}
		if v := regStr(s, "province", valid.S{Max: 120}); v != nil {
			in.Location = append(in.Location, bson.E{Key: "province", Value: *v})
		}
	})
	in.Name, _ = f.Str("name", valid.S{Trim: true, Min: 2, Max: 160})
	in.Notes = regStr(f, "notes", valid.S{Max: 1000})
	in.Photos = parsePhotos(f)
	if f.Nest("pricing", true, func(s *valid.Form) {
		if v := regNum(s, "admissionFee", valid.N{Min: nonneg()}); v != nil {
			in.Pricing = append(in.Pricing, bson.E{Key: "admissionFee", Value: *v})
			in.AdmissionFee = v
		}
		if v := regNum(s, "formFee", valid.N{Int: true, Min: nonneg()}); v != nil {
			in.Pricing = append(in.Pricing, bson.E{Key: "formFee", Value: *v})
		}
		cur := "NPR"
		if v, ok := s.Str("currency", valid.S{Opt: true, Trim: true, Min: 2, Max: 8}); ok {
			cur = v
		}
		in.Pricing = append(in.Pricing, bson.E{Key: "currency", Value: cur})
		if v := regNum(s, "monthlyRentMax", valid.N{Min: nonneg()}); v != nil {
			in.Pricing = append(in.Pricing, bson.E{Key: "monthlyRentMax", Value: *v})
		}
		if v := regNum(s, "monthlyRentMin", valid.N{Min: nonneg()}); v != nil {
			in.Pricing = append(in.Pricing, bson.E{Key: "monthlyRentMin", Value: *v})
		}
	}) {
		in.PricingSet = true
	}
	in.Deposit = regNum(f, "securityDeposit", valid.N{Int: true, Min: valid.P(0), Max: valid.P(1_000_000)})
	if items, ok := f.Array("roomConfigurations", false, true); ok {
		each(f, "roomConfigurations", items, func(_ int, s *valid.Form) {
			var r RoomCfg
			beds, _ := s.Num("bedsPerRoom", valid.N{Coerce: true, Int: true, Min: nonneg()})
			r.Beds = beds
			r.Meal, _ = s.Enum("mealInclusion", false, nil, "Included", "Not Included", "Optional")
			r.MonthlyRent = regNum(s, "monthlyRent", valid.N{Min: nonneg()})
			r.Deposit = regNum(s, "securityDeposit", valid.N{Int: true, Min: nonneg()})
			r.Rooms, _ = s.Num("rooms", valid.N{Coerce: true, Int: true, Min: nonneg()})
			r.RoomType, _ = s.Str("roomType", valid.S{Trim: true, Min: 1, Max: 80})
			zero := 0.0
			r.Vacant, _ = s.Num("vacantBeds", valid.N{Coerce: true, Int: true, Min: nonneg(), Default: &zero})
			in.Rooms = append(in.Rooms, r)
		})
		f.Size("roomConfigurations", len(items), 0, 30, "", false)
	}
	in.RoomTypes = textArray(f, "roomTypes")
	in.Rules = textArray(f, "rules")
	in.Floors = regNum(f, "totalFloors", valid.N{Int: true, Min: valid.P(0), Max: valid.P(50)})
	in.AltPhone = regStr(f, "alternatePhone", valid.S{Min: 7, Max: 24})
	f.Nest("applicant", false, func(s *valid.Form) {
		in.Applicant.Age = regStr(s, "age", valid.S{Max: 3})
		if v, ok := s.Str("email", valid.S{Opt: true, Trim: true}); ok {
			if !valid.IsEmail(v) {
				s.Is.Add("email", valid.Format("email"))
			}
			in.Applicant.Email = &v
		}
		if s.Present("gender") {
			if v, ok := s.Enum("gender", true, nil, "Male", "Female", "Other"); ok {
				in.Applicant.Gender = &v
			}
		}
		in.Applicant.IDProof = regStr(s, "idProofType", valid.S{Max: 80})
		in.Applicant.Name, _ = s.Str("name", valid.S{Trim: true, Min: 2, Max: 120})
		in.Applicant.Phone, _ = s.Str("phone", valid.S{Trim: true, Min: 7, Max: 24})
	})
	regNum(f, "cookCount", valid.N{Int: true, Min: valid.P(0), Max: valid.P(100)})
	in.Landmark = regStr(f, "landmark", valid.S{Max: 240})
	in.MapLink = regStr(f, "mapLink", valid.S{Max: 500})
	in.PAN = regStr(f, "panNumber", valid.S{Re: panShape, ReMsg: "A PAN/VAT number is 9 digits."})
	f.Nest("plan", true, func(s *valid.Form) {
		monthly := "monthly"
		cycle, _ := s.Enum("cycle", true, &monthly, "monthly", "halfYearly", "annual")
		pc := PlanChoice{Cycle: cycle}
		if s.Present("lifetime") {
			if b, ok := s.Bool("lifetime", true, nil); ok {
				pc.Lifetime = &b
			}
		}
		pc.PlanID, _ = s.Str("planId", valid.S{Trim: true, Min: 1, Max: 40})
		in.Plan = &pc
	})
	f.Nest("shortStays", true, func(s *valid.Form) {
		var ss ShortStaysIn
		ss.Enabled, _ = s.Bool("enabled", false, nil)
		ss.MinNights, _ = s.Num("minNights", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(29)})
		if items, ok := s.Array("rates", false, false); ok {
			each(s, "rates", items, func(_ int, r *valid.Form) {
				var sr ShortRate
				sr.Daily, _ = r.Num("dailyRate", valid.N{Coerce: true, Int: true, IntMsg: "Use whole rupees.", Min: valid.P(1)})
				sr.RoomType, _ = r.Str("roomType", valid.S{Trim: true, Min: 1, Max: 80})
				ss.Rates = append(ss.Rates, sr)
			})
			s.Size("rates", len(items), 0, 30, "", false)
		}
		in.ShortStays = &ss
	})
	parseFoodRoutine(f)
	f.Nest("payoutAccount", true, func(s *valid.Form) { in.Payout = parsePayout(s) })
	in.RefDisc = regNum(f, "referralAdmissionDiscount", valid.N{Int: true, Min: valid.P(0), Max: valid.P(1_000_000)})
	in.TotalCap = regNum(f, "totalCapacity", valid.N{Int: true, Min: valid.P(0), Max: valid.P(10_000)})
	in.Year = regStr(f, "yearEstablished", valid.S{Re: yearShape, ReMsg: "Year established should be four digits."})
	if v, ok := f.Str("referralCode", valid.S{Opt: true, Trim: true, Max: 32}); ok {
		in.RefCode = v
	}
	if !f.Hard {
		refineRegistration(f, in)
	}
	return in, f.Err()
}

// parsePhotos is the photos array: kind defaults to INTERIOR, a url starts with / or http(s)://.
func parsePhotos(f *valid.Form) bson.A {
	items, ok := f.Array("photos", false, true)
	if !ok {
		return nil
	}
	out := bson.A{}
	each(f, "photos", items, func(_ int, s *valid.Form) {
		var photo bson.D
		if v := regStr(s, "alt", valid.S{Max: 120}); v != nil {
			photo = append(photo, bson.E{Key: "alt", Value: *v})
		}
		if v, present := s.M["fileAssetId"]; present {
			if id, ok := valid.ObjectID(v, "fileAssetId", "", &s.Is, false); ok {
				oid, _ := bson.ObjectIDFromHex(id)
				photo = append(photo, bson.E{Key: "fileAssetId", Value: oid})
			}
		}
		interior := "INTERIOR"
		kind, _ := s.Enum("kind", true, &interior, "EXTERIOR", "INTERIOR", "ROOM")
		photo = append(photo, bson.E{Key: "kind", Value: kind})
		if v := regStr(s, "roomType", valid.S{Min: 1, Max: 80}); v != nil {
			photo = append(photo, bson.E{Key: "roomType", Value: *v})
		}
		if u, ok := s.Str("url", valid.S{Trim: true, Max: 500}); ok {
			if !strings.HasPrefix(u, "/") && !photoHTTP.MatchString(u) {
				s.Is.Add("url", "Photo URL must start with / or http(s)://")
			}
			photo = append(photo, bson.E{Key: "url", Value: u})
		}
		out = append(out, photo)
	})
	f.Size("photos", len(items), 0, 40, "", false)
	return out
}

var (
	mealTypes = []string{"BREAKFAST", "LUNCH", "SNACKS", "DINNER"}
	weekdays  = []string{"SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"}
)

// parseFoodRoutine is foodRoutineSaveSchema without hostelId. Public registration
// only validates it; the team desk stores it.
func parseFoodRoutine(f *valid.Form) {
	f.Nest("foodRoutine", true, func(s *valid.Form) {
		s.Nest("timings", false, func(t *valid.Form) {
			for _, k := range mealTypes {
				if t.Present(k) {
					t.Str(k, valid.S{Trim: true, Max: 80})
				}
			}
		})
		if items, ok := s.Array("meals", false, false); ok {
			each(s, "meals", items, func(_ int, m *valid.Form) {
				m.Enum("dayOfWeek", false, nil, weekdays...)
				m.Enum("mealType", false, nil, mealTypes...)
				if list, ok := m.Array("items", false, false); ok {
					for i, raw := range list {
						sub := &valid.Form{M: map[string]any{"v": raw}}
						sub.Str("v", valid.S{Trim: true, Min: 1, Max: 80})
						m.JoinScalar("items."+strconv.Itoa(i), sub)
					}
					m.Size("items", len(list), 1, 20, "", false)
				}
				regStr(m, "note", valid.S{Max: 500})
			})
			s.Size("meals", len(items), 0, 28, "", false)
		}
		s.Nest("monthEndSpecial", true, func(m *valid.Form) {
			if list, ok := m.Array("items", false, false); ok {
				for i, raw := range list {
					sub := &valid.Form{M: map[string]any{"v": raw}}
					sub.Str("v", valid.S{Trim: true, Min: 1, Max: 80})
					m.JoinScalar("items."+strconv.Itoa(i), sub)
				}
				m.Size("items", len(list), 0, 20, "", false)
			}
			regStr(m, "note", valid.S{Max: 500})
		})
	})
}

// parsePayout is payoutAccountInputSchema: normalised number, per-method checks.
func parsePayout(s *valid.Form) *Payout {
	var p Payout
	p.Bank, p.Branch = "", ""
	if v, ok := s.Str("bankName", valid.S{Opt: true, Trim: true, Max: 120}); ok {
		p.Bank = v
	}
	if v, ok := s.Str("branch", valid.S{Opt: true, Trim: true, Max: 120}); ok {
		p.Branch = v
	}
	p.Holder, _ = s.Str("holderName", valid.S{Trim: true, Min: 2, MinMsg: "Enter the name on the account.", Max: 120})
	p.Method, _ = s.Enum("method", false, nil, "BANK", "ESEWA", "KHALTI")
	raw, _ := s.Str("number", valid.S{Max: 40})
	p.Number = strings.ToUpper(spacesDash.ReplaceAllString(raw, ""))
	if s.Hard {
		return &p
	}
	if p.Method == "BANK" {
		if valid.JSLen(p.Bank) < 2 {
			s.Is.Add("bankName", "Enter the bank's name.")
		}
		if !bankNumber.MatchString(p.Number) {
			s.Is.Add("number", "Enter the account number: 6 to 24 letters or digits.")
		}
	} else if !walletNum.MatchString(p.Number) {
		label := map[string]string{"ESEWA": "eSewa", "KHALTI": "Khalti"}[p.Method]
		s.Is.Add("number", "Enter the 10-digit mobile number your "+label+" account uses.")
	}
	if p.Method != "BANK" {
		p.Bank, p.Branch = "", ""
	}
	return &p
}

// refineRegistration is refineRegistration: the referral discount against the
// admission fee, and ROOM photos against the submitted room types.
func refineRegistration(f *valid.Form, in Reg) {
	fee := 0.0
	if in.AdmissionFee != nil {
		fee = *in.AdmissionFee
	}
	if in.RefDisc != nil && *in.RefDisc > fee {
		f.Is.Add("referralAdmissionDiscount", "A referral discount cannot be more than the admission fee.")
	}
	known := map[string]bool{}
	for _, r := range in.Rooms {
		known[r.RoomType] = true
	}
	for i, p := range in.Photos {
		photo := p.(bson.D)
		kind, _ := lookup(photo, "kind")
		if kind != "ROOM" {
			continue
		}
		rt, ok := lookup(photo, "roomType")
		path := "photos." + strconv.Itoa(i) + ".roomType"
		if !ok {
			f.Is.Add(path, "A room photo has to say which room type it is of.")
			continue
		}
		if !known[rt.(string)] {
			f.Is.Add(path, `"`+rt.(string)+`" is not one of the room types on this hostel.`)
		}
	}
}
