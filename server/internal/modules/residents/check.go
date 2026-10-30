package residents

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// existing-residents-check.ts: the "check list" for the existing-residents list,
// run on one row by the join link. Pure: callers hand in every lookup.

const (
	MaxMonthsBack  = 12
	MaxMonthsAhead = 12
)

const isoMilli = "2006-01-02T15:04:05.000Z"

// ListRow is one line of the list.
type ListRow struct {
	DepositPaid int64
	Email       string
	FullName    string
	ID          string
	JoinedDate  *string // ISO
	MonthlyRent *int64
	OldDues     int64
	PaidTill    string // "" = null
	PartPaid    int64
	Phone       string
	ResidentID  string
	RoomNumber  string
	RoomType    string
}

type RoomTypeContext struct {
	MonthlyRent *int64
	RoomType    string
	VacantBeds  int
}

type NumberedRoom struct {
	Beds     int
	Floor    int
	Free     int
	ID       string
	Number   string
	RoomType string
}

type CheckContext struct {
	CurrentPeriod   string
	NumberedRooms   []NumberedRoom
	LivingElsewhere map[string]string
	RoomTypes       []RoomTypeContext
	TakenEmails     map[string]string
	TakenPhones     map[string]string
}

type RowProblem struct {
	Field   string
	Message string
}

type BillMonth struct {
	Amount int64  `json:"amount"`
	Label  string `json:"label"`
	Period string `json:"period"`
}

type BillPreview struct {
	Months   []BillMonth `json:"months"`
	OldDues  int64       `json:"oldDues"`
	PartPaid int64       `json:"partPaid"`
	Total    int64       `json:"total"`
}

type CheckedRow struct {
	Added    bool
	Bills    *BillPreview
	ID       string
	Problems []RowProblem
	Rent     *int64
}

type RoomTypeSummary struct {
	FreeBeds int
	InList   int
	RoomType string
}

type CheckResult struct {
	ListProblems []string
	Ready        bool
	RoomTypes    []RoomTypeSummary
	Rows         []CheckedRow
	ToAdd        int
	WithProblems int
}

var (
	emailShape  = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	bsSuffix    = regexp.MustCompile(`\s*BS$`)
	nonDigit    = regexp.MustCompile(`\D`)
	roomTypeKey = map[string]string{"double sharing": "Double Sharing Room", "four sharing": "Four Sharing Room", "single": "Single Sitter Room",
		"single room": "Single Sitter Room", "triple sharing": "Triple Sharing Room"}
)

// RoomTypeLabel is roomTypeLabel (packages/shared constants/room-types.ts).
func RoomTypeLabel(roomType string) string {
	if roomType == "" {
		return ""
	}
	parts := strings.Split(roomType, " — ")
	base := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(parts[0], "_", " ")))
	if name, ok := roomTypeKey[base]; ok {
		return strings.Join(append([]string{name}, parts[1:]...), " — ")
	}
	return strings.ReplaceAll(roomType, "_", " ")
}

func SameRoomType(a, b string) bool {
	return strings.ToLower(strings.TrimSpace(a)) == strings.ToLower(strings.TrimSpace(b))
}

// SplitFullName is splitFullName's yes/no: a first and a last name.
func SplitFullName(fullName string) bool { return len(strings.Fields(fullName)) >= 2 }

// MonthLabel is monthLabel: "Bhadra 2083".
func MonthLabel(period string) string {
	label := bs.FormatPeriod(period)
	if label == "" {
		label = period
	}
	return bsSuffix.ReplaceAllString(label, "")
}

func moveInDateFor(row ListRow) *time.Time {
	if row.JoinedDate != nil {
		if t, err := time.Parse(isoMilli, *row.JoinedDate); err == nil {
			return &t
		}
		return nil
	}
	if row.PaidTill != "" {
		if b, err := bs.PeriodBounds(row.PaidTill); err == nil {
			return &b.Start
		}
	}
	return nil
}

// UnpaidMonths is every month after paidTill up to and including current.
func UnpaidMonths(paidTill, current string) []string {
	var out []string
	for p, err := bs.AddMonths(paidTill, 1); err == nil && p <= current; p, err = bs.AddMonths(p, 1) {
		out = append(out, p)
	}
	return out
}

func roomOfRow(row ListRow, rooms []NumberedRoom) (*NumberedRoom, string) {
	number := strings.ToLower(strings.TrimSpace(row.RoomNumber))
	var room *NumberedRoom
	if number != "" {
		for i := range rooms {
			if strings.ToLower(rooms[i].Number) == number {
				room = &rooms[i]
				break
			}
		}
	}
	rt := strings.TrimSpace(row.RoomType)
	if rt == "" && room != nil {
		rt = room.RoomType
	}
	return room, rt
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// CheckExistingResidents is checkExistingResidents.
func CheckExistingResidents(rows []ListRow, ctx CheckContext) CheckResult {
	oldest, _ := bs.AddMonths(ctx.CurrentPeriod, -MaxMonthsBack)
	newest, _ := bs.AddMonths(ctx.CurrentPeriod, MaxMonthsAhead)
	firstPhone, firstEmail := map[string]int{}, map[string]int{}
	summaries := map[string]*RoomTypeSummary{}
	var order []string
	var listProblems []string
	var numbered []NumberedRoom
	if len(ctx.NumberedRooms) > 0 {
		numbered = ctx.NumberedRooms
	}
	placed := map[string]int{}
	for _, r := range ctx.RoomTypes {
		k := strings.ToLower(r.RoomType)
		if _, seen := summaries[k]; !seen {
			order = append(order, k)
		}
		summaries[k] = &RoomTypeSummary{FreeBeds: r.VacantBeds, RoomType: r.RoomType}
	}
	if len(ctx.RoomTypes) == 0 {
		listProblems = append(listProblems, "This hostel has no room types yet. Add rooms first.")
	}
	checked := make([]CheckedRow, 0, len(rows))
	for index, row := range rows {
		line := index + 1
		if row.ResidentID != "" {
			checked = append(checked, CheckedRow{Added: true, ID: row.ID})
			continue
		}
		var problems []RowProblem
		add := func(field, msg string) { problems = append(problems, RowProblem{field, msg}) }
		hasProblem := func(field string) bool {
			for _, p := range problems {
				if p.Field == field {
					return true
				}
			}
			return false
		}
		if strings.TrimSpace(row.FullName) == "" {
			add("fullName", "Write the full name.")
		} else if !SplitFullName(row.FullName) {
			add("fullName", "Write first and last name.")
		}
		digits := len(nonDigit.ReplaceAllString(row.Phone, ""))
		switch {
		case strings.TrimSpace(row.Phone) == "":
			add("phone", "Write the phone number.")
		case digits < 7 || digits > 15:
			add("phone", "This phone number looks wrong.")
		default:
			if l, ok := firstPhone[row.Phone]; ok {
				add("phone", fmt.Sprintf("Same phone as line %d.", l))
			} else if who, ok := ctx.TakenPhones[row.Phone]; ok {
				add("phone", who+" already uses this phone in this hostel.")
			} else {
				firstPhone[row.Phone] = line
			}
		}
		email := strings.ToLower(strings.TrimSpace(row.Email))
		if email != "" {
			if !emailShape.MatchString(email) {
				add("email", "This email looks wrong.")
			} else if l, ok := firstEmail[email]; ok {
				add("email", fmt.Sprintf("Same email as line %d.", l))
			} else if who, ok := ctx.TakenEmails[email]; ok {
				add("email", who+" already uses this email in this hostel.")
			} else if where, ok := ctx.LivingElsewhere[email]; ok {
				add("email", "This person is already living in "+where+". They must move out there first.")
			} else {
				firstEmail[email] = line
			}
		}
		numberedRoom, roomType := roomOfRow(row, numbered)
		var room *RoomTypeContext
		for i := range ctx.RoomTypes {
			if SameRoomType(ctx.RoomTypes[i].RoomType, roomType) {
				room = &ctx.RoomTypes[i]
				break
			}
		}
		switch {
		case roomType == "":
			add("roomType", "Choose a room type.")
		case room == nil:
			add("roomType", `"`+roomType+`" is not a room type in this hostel.`)
		default:
			summaries[strings.ToLower(room.RoomType)].InList++
		}
		if numbered != nil {
			switch {
			case strings.TrimSpace(row.RoomNumber) == "":
				add("roomNumber", "Pick their room.")
			case numberedRoom == nil:
				add("roomNumber", "There is no room "+strings.TrimSpace(row.RoomNumber)+" in this hostel.")
			case room != nil && !SameRoomType(numberedRoom.RoomType, room.RoomType):
				add("roomNumber", fmt.Sprintf("Room %s is %s, not %s.", numberedRoom.Number, RoomTypeLabel(numberedRoom.RoomType), RoomTypeLabel(room.RoomType)))
			default:
				placed[numberedRoom.ID]++
				if placed[numberedRoom.ID] > numberedRoom.Free {
					if numberedRoom.Free == 0 {
						add("roomNumber", fmt.Sprintf("Room %s is full.", numberedRoom.Number))
					} else {
						add("roomNumber", fmt.Sprintf("Room %s has %d free %s; more lines than that are in it.", numberedRoom.Number, numberedRoom.Free, plural(numberedRoom.Free, "bed", "beds")))
					}
				}
			}
		}
		switch {
		case row.PaidTill == "":
			add("paidTill", "Choose if this month's rent is paid, or how many months are due.")
		case row.PaidTill < oldest:
			add("paidTill", fmt.Sprintf("More than %d months due. Put the older money in Old dues.", MaxMonthsBack))
		case row.PaidTill > newest:
			add("paidTill", fmt.Sprintf("Paid more than %d months ahead. Check the month.", MaxMonthsAhead))
		}
		if row.JoinedDate != nil {
			joined, err := time.Parse(isoMilli, *row.JoinedDate)
			var end time.Time
			if b, berr := bs.PeriodBounds(ctx.CurrentPeriod); berr == nil {
				end = b.End
			}
			if err != nil || joined.After(end) {
				add("joinedDate", "Joined date cannot be in the future.")
			}
		}
		var rent *int64
		if room != nil {
			rent = room.MonthlyRent
		}
		if room != nil && rent == nil {
			add("monthlyRent", RoomTypeLabel(room.RoomType)+" has no rent in the rate card. Set it in Fee schedule first.")
		}
		var bills *BillPreview
		if rent != nil && row.PaidTill != "" && !hasProblem("paidTill") {
			moveIn := moveInDateFor(row)
			months := []BillMonth{}
			for _, period := range UnpaidMonths(row.PaidTill, ctx.CurrentPeriod) {
				amt, _ := finance.MonthlyAmount(*rent, moveIn, period)
				if amt > 0 {
					months = append(months, BillMonth{amt, MonthLabel(period), period})
				}
			}
			if row.PartPaid > 0 && len(months) == 0 {
				add("partPaid", "Nothing is due, so nothing can be part paid.")
			} else if len(months) > 0 && row.PartPaid >= months[0].Amount {
				add("partPaid", fmt.Sprintf("Part paid must be less than %s rent (Rs %d). If it is all paid, choose one month fewer.", months[0].Label, months[0].Amount))
			}
			var total int64
			for _, m := range months {
				total += m.Amount
			}
			bills = &BillPreview{Months: months, OldDues: row.OldDues, PartPaid: row.PartPaid, Total: total + row.OldDues - row.PartPaid}
		}
		checked = append(checked, CheckedRow{Bills: bills, ID: row.ID, Problems: problems, Rent: rent})
	}
	for _, k := range order {
		s := summaries[k]
		if s.InList > s.FreeBeds {
			listProblems = append(listProblems, fmt.Sprintf("%s has %d free %s but %d residents in this list. Change the beds in Rooms first.", RoomTypeLabel(s.RoomType), s.FreeBeds, plural(s.FreeBeds, "bed", "beds"), s.InList))
		}
	}
	res := CheckResult{ListProblems: listProblems, Rows: checked}
	for _, r := range checked {
		if !r.Added {
			res.ToAdd++
		}
		if len(r.Problems) > 0 {
			res.WithProblems++
		}
	}
	res.Ready = res.ToAdd > 0 && res.WithProblems == 0 && len(listProblems) == 0
	for _, k := range order {
		if summaries[k].InList > 0 {
			res.RoomTypes = append(res.RoomTypes, *summaries[k])
		}
	}
	return res
}
