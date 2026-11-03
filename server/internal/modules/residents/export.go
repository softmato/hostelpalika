package residents

import (
	"context"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// What the staff side of the join link and the existing-residents list needs from
// the checker and the public join flow. They live in hostelresidents, which sits
// above this package.

type (
	// JoinLink is a hostel's resident join link row.
	JoinLink = joinLink
	// JoinRequest is a resident application row.
	JoinRequest = joinRequest
	// JoinChecked is what the checker says about one request.
	JoinChecked = checked
	// RoomConfig is one entry of Hostel.roomConfigurations.
	RoomConfig = roomConfig
)

// View is toView: the request as the staff list shows it.
func (r JoinRequest) View(c JoinChecked, current string) ordered.Map { return r.view(c, current) }

// ListRow is asRow: the request as a checkable row.
func (r JoinRequest) ListRow() ListRow { return r.row() }

// State is linkState.
func (l JoinLink) State() string { return l.state() }

// RoomTypesFor is roomTypesFor.
func (p *Public) RoomTypesFor(ctx context.Context, hostel bson.ObjectID, configs []RoomConfig) ([]RoomTypeContext, error) {
	return p.roomTypesFor(ctx, hostel, configs)
}

// CheckContextFor is contextFor: who already holds the phones and emails in rows.
func (p *Public) CheckContextFor(ctx context.Context, rows []ListRow, types []RoomTypeContext, hostel bson.ObjectID, numbered []NumberedRoom) (CheckContext, error) {
	c, err := p.checkContext(ctx, rows, types, hostel)
	c.NumberedRooms = numbered
	return c, err
}

// JSON is the row as the list shows it.
func (r ListRow) JSON() ordered.Map {
	var joined, paid, resident, rent any
	if r.JoinedDate != nil {
		joined = *r.JoinedDate
	}
	if r.PaidTill != "" {
		paid = r.PaidTill
	}
	if r.ResidentID != "" {
		resident = r.ResidentID
	}
	if r.MonthlyRent != nil {
		rent = *r.MonthlyRent
	}
	return ordered.Map{{Key: "depositPaid", Value: r.DepositPaid}, {Key: "email", Value: r.Email}, {Key: "fullName", Value: r.FullName}, {Key: "id", Value: r.ID}, {Key: "joinedDate", Value: joined},
		{Key: "monthlyRent", Value: rent}, {Key: "oldDues", Value: r.OldDues}, {Key: "paidTill", Value: paid}, {Key: "partPaid", Value: r.PartPaid}, {Key: "phone", Value: r.Phone},
		{Key: "residentId", Value: resident}, {Key: "roomNumber", Value: r.RoomNumber}, {Key: "roomType", Value: r.RoomType}}
}

// JSON is CheckResult as the list shows it.
func (c CheckResult) JSON() ordered.Map {
	rows := make([]any, len(c.Rows))
	for i, r := range c.Rows {
		problems := make([]any, len(r.Problems))
		for j, p := range r.Problems {
			problems[j] = ordered.Map{{Key: "field", Value: p.Field}, {Key: "message", Value: p.Message}}
		}
		var bills, rent any
		if r.Bills != nil {
			bills = r.Bills
		}
		if r.Rent != nil {
			rent = *r.Rent
		}
		rows[i] = ordered.Map{{Key: "added", Value: r.Added}, {Key: "bills", Value: bills}, {Key: "id", Value: r.ID}, {Key: "problems", Value: problems}, {Key: "rent", Value: rent}}
	}
	types := make([]any, len(c.RoomTypes))
	for i, t := range c.RoomTypes {
		types[i] = ordered.Map{{Key: "freeBeds", Value: t.FreeBeds}, {Key: "inList", Value: t.InList}, {Key: "roomType", Value: t.RoomType}}
	}
	problems := c.ListProblems
	if problems == nil {
		problems = []string{}
	}
	return ordered.Map{{Key: "listProblems", Value: problems}, {Key: "ready", Value: c.Ready}, {Key: "roomTypes", Value: types}, {Key: "rows", Value: rows}, {Key: "toAdd", Value: c.ToAdd}, {Key: "withProblems", Value: c.WithProblems}}
}

// RoomOfRow is roomOfRow.
func RoomOfRow(row ListRow, rooms []NumberedRoom) (*NumberedRoom, string) {
	return roomOfRow(row, rooms)
}

// MoveInDateFor is moveInDateFor.
func MoveInDateFor(row ListRow) *time.Time { return moveInDateFor(row) }

// SplitName is splitFullName: everything before the last word is the first name.
func SplitName(fullName string) (first, last string) {
	parts := strings.Fields(fullName)
	if len(parts) < 2 {
		return "", ""
	}
	return strings.Join(parts[:len(parts)-1], " "), parts[len(parts)-1]
}
