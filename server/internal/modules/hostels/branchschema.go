package hostels

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Branch is a parsed branchRequestSchema: the registration fields a branch
// shares plus whether to reuse the main hostel's approved documents.
type Branch struct {
	Reg
	ReuseDocuments bool
}

// ParseBranch is branchRequestSchema: platformHostelCreateSchema without the owner,
// a required contact phone, then the registration extras in the order they were added.
func ParseBranch(body any) (Branch, error) {
	f := valid.NewForm(body)
	var in Reg
	parseCreateBase(f, &in, true)
	in.AltPhone = regStr(f, "alternatePhone", valid.S{Min: 7, Max: 24})
	regNum(f, "cookCount", valid.N{Int: true, Min: valid.P(0), Max: valid.P(100)})
	in.Landmark = regStr(f, "landmark", valid.S{Max: 240})
	in.MapLink = regStr(f, "mapLink", valid.S{Max: 500})
	in.PAN = regStr(f, "panNumber", valid.S{Re: panShape, ReMsg: "A PAN/VAT number is 9 digits."})
	f.Nest("payoutAccount", true, func(s *valid.Form) { in.Payout = parsePayout(s) })
	parseShortStays(f, &in)
	in.TotalCap = regNum(f, "totalCapacity", valid.N{Int: true, Min: valid.P(0), Max: valid.P(10_000)})
	in.Year = regStr(f, "yearEstablished", valid.S{Re: yearShape, ReMsg: "Year established should be four digits."})
	no := false
	reuse, _ := f.Bool("reuseDocuments", false, &no)
	if !f.Hard {
		refineBranch(f, in)
	}
	return Branch{in, reuse}, f.Err()
}

// refineBranch is the schema's superRefine: each room type once, sane counts, and a
// total capacity that matches the beds.
func refineBranch(f *valid.Form, in Reg) {
	names := map[string]bool{}
	beds := 0.0
	for i, room := range in.Rooms {
		key := strings.ToLower(room.RoomType)
		if names[key] {
			f.Is.Add("roomConfigurations."+strconv.Itoa(i)+".roomType", "Use each room type only once.")
		}
		names[key] = true
		if room.Rooms < 1 || room.Beds < 1 || room.Vacant > room.Rooms*room.Beds {
			f.Is.Add("roomConfigurations."+strconv.Itoa(i), "Enter positive room and bed counts; vacant beds cannot exceed capacity.")
		}
		beds += room.Rooms * room.Beds
	}
	if in.TotalCap != nil && beds > 0 && *in.TotalCap != beds {
		parts := make([]string, len(in.Rooms))
		for i, room := range in.Rooms {
			parts[i] = fmt.Sprintf("%s × %s for %s", jsNum(room.Rooms), jsNum(room.Beds), room.RoomType)
		}
		f.Is.Add("totalCapacity", fmt.Sprintf("Total capacity is %s beds, but your room counts give %s beds (%s). Set total capacity to %s, or correct the room counts.",
			jsNum(*in.TotalCap), jsNum(beds), strings.Join(parts, " + "), jsNum(beds)))
	}
}

func jsNum(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }
