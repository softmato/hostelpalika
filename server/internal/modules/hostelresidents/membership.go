package hostelresidents

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

func listOf[T any](ctx context.Context, coll *mongo.Collection, filter bson.D, opts ...options.Lister[options.FindOptions]) ([]T, error) {
	cur, err := coll.Find(ctx, filter, opts...)
	if err != nil {
		return nil, err
	}
	var out []T
	return out, cur.All(ctx, &out)
}

type guardianRow struct {
	ID        bson.ObjectID `bson:"_id"`
	Email     *string       `bson:"email"`
	FirstName string        `bson:"firstName"`
	IsPrimary bool          `bson:"isPrimary"`
	LastName  string        `bson:"lastName"`
	Phone     string        `bson:"phone"`
	Relation  string        `bson:"relation"`
}

type emergencyRow struct {
	ID        bson.ObjectID `bson:"_id"`
	IsPrimary bool          `bson:"isPrimary"`
	Name      string        `bson:"name"`
	Phone     string        `bson:"phone"`
	Relation  string        `bson:"relation"`
}

type complaintRow struct {
	ID        bson.ObjectID `bson:"_id"`
	Category  string        `bson:"category"`
	CreatedAt *time.Time    `bson:"createdAt"`
	Status    string        `bson:"status"`
	Title     string        `bson:"title"`
}

// membership is loadMembership: this person on one of the scanning hostel's rolls.
func (s *Service) membership(ctx context.Context, canViewPayments bool, profile ordered.Map, scope []bson.ObjectID, user *scanUser) (ordered.Map, bson.ObjectID, error) {
	none := bson.NilObjectID
	ids := bson.A{}
	for _, id := range scope {
		ids = append(ids, id)
	}
	base := bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, liveUser}
	newest := options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})
	find := func(extra bson.E) (*Resident, error) {
		var r Resident
		err := s.DB.Collection("residents").FindOne(ctx, append(append(bson.D{}, base...), extra), newest).Decode(&r)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return &r, err
	}
	matched := "ACCOUNT"
	r, err := find(bson.E{Key: "userId", Value: user.ID})
	if err != nil {
		return nil, none, err
	}
	phone, _ := pstr(profile, "primaryPhone")
	phone = strings.TrimSpace(phone)
	addr, _ := pstr(profile, "primaryEmail")
	if addr == "" && user.Email != nil {
		addr = *user.Email
	}
	addr = strings.ToLower(strings.TrimSpace(addr))
	if r == nil && phone != "" {
		if r, err = find(bson.E{Key: "phone", Value: phone}); err != nil {
			return nil, none, err
		}
		matched = "PHONE"
	}
	if r == nil && addr != "" {
		if r, err = find(bson.E{Key: "email", Value: addr}); err != nil {
			return nil, none, err
		}
		matched = "EMAIL"
	}
	if r == nil {
		return nil, none, nil
	}
	byResident := bson.D{{Key: "residentId", Value: r.ID}}
	primaryFirst := options.Find().SetSort(bson.D{{Key: "isPrimary", Value: -1}})
	guardians, err := listOf[guardianRow](ctx, s.DB.Collection("guardians"), byResident, primaryFirst)
	if err != nil {
		return nil, none, err
	}
	emergencies, err := listOf[emergencyRow](ctx, s.DB.Collection("emergencycontacts"), byResident, primaryFirst)
	if err != nil {
		return nil, none, err
	}
	complaints, err := listOf[complaintRow](ctx, s.DB.Collection("complaints"), byResident, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(5))
	if err != nil {
		return nil, none, err
	}
	open, err := s.DB.Collection("complaints").CountDocuments(ctx, append(append(bson.D{}, byResident...), bson.E{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "IN_PROGRESS"}}}}))
	if err != nil {
		return nil, none, err
	}
	total, err := s.DB.Collection("complaints").CountDocuments(ctx, byResident)
	if err != nil {
		return nil, none, err
	}
	var night struct {
		CheckedAt *time.Time `bson:"checkedAt"`
		Note      *string    `bson:"note"`
		Source    string     `bson:"source"`
		Status    string     `bson:"status"`
	}
	var nightOut any
	switch err := s.DB.Collection("nightstatuses").FindOne(ctx, byResident).Decode(&night); {
	case err == nil:
		src := night.Source
		if src == "" {
			src = "RESIDENT"
		}
		nightOut = ordered.Map{{Key: "checkedAt", Value: isoOrNull(night.CheckedAt)}, {Key: "note", Value: nullable(night.Note)}, {Key: "source", Value: src}, {Key: "status", Value: night.Status}}
	case !errors.Is(err, mongo.ErrNoDocuments):
		return nil, none, err
	}
	var ledger any
	if canViewPayments && s.Ledger2 != nil {
		if l, err := s.Ledger2(ctx, r.HostelID, r.ID.Hex()); err == nil && l != nil {
			ledger = l
		}
	}
	rows := make([]any, 0, len(complaints))
	for _, c := range complaints {
		cat := c.Category
		if cat == "" {
			cat = "OTHER"
		}
		rows = append(rows, ordered.Map{{Key: "category", Value: cat}, {Key: "createdAt", Value: isoOrNull(c.CreatedAt)}, {Key: "id", Value: c.ID.Hex()}, {Key: "status", Value: c.Status}, {Key: "title", Value: c.Title}})
	}
	ems := make([]any, 0, len(emergencies))
	for _, e := range emergencies {
		ems = append(ems, ordered.Map{{Key: "id", Value: e.ID.Hex()}, {Key: "isPrimary", Value: e.IsPrimary}, {Key: "name", Value: e.Name}, {Key: "phone", Value: e.Phone}, {Key: "relation", Value: e.Relation}})
	}
	gs := make([]any, 0, len(guardians))
	for _, g := range guardians {
		mail := ""
		if g.Email != nil {
			mail = *g.Email
		}
		gs = append(gs, ordered.Map{{Key: "email", Value: mail}, {Key: "firstName", Value: g.FirstName}, {Key: "id", Value: g.ID.Hex()}, {Key: "isPrimary", Value: g.IsPrimary}, {Key: "lastName", Value: g.LastName}, {Key: "phone", Value: g.Phone}, {Key: "relation", Value: g.Relation}})
	}
	rtype := "STUDENT"
	if r.ResidentType != nil {
		rtype = *r.ResidentType
	}
	var userID, mail any
	if r.UserID != nil {
		userID = r.UserID.Hex()
	}
	if r.Email != "" {
		mail = r.Email
	}
	hostelName := "This hostel"
	var h struct {
		Name string `bson:"name"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: r.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h); err == nil && h.Name != "" {
		hostelName = h.Name
	}
	return ordered.Map{
		{Key: "complaints", Value: ordered.Map{{Key: "open", Value: open}, {Key: "recent", Value: rows}, {Key: "total", Value: total}}},
		{Key: "contacts", Value: ordered.Map{{Key: "emergencyContacts", Value: ems}, {Key: "guardians", Value: gs}}},
		{Key: "hostel", Value: ordered.Map{{Key: "id", Value: r.HostelID.Hex()}, {Key: "name", Value: hostelName}}},
		{Key: "ledger", Value: ledger}, {Key: "ledgerDenied", Value: !canViewPayments}, {Key: "matchedBy", Value: matched}, {Key: "nightStatus", Value: nightOut},
		{Key: "resident", Value: ordered.Map{{Key: "createdAt", Value: isoOrNull(r.CreatedAt)}, {Key: "depositAmount", Value: r.DepositAmount}, {Key: "email", Value: mail}, {Key: "firstName", Value: r.FirstName},
			{Key: "id", Value: r.ID.Hex()}, {Key: "lastName", Value: r.LastName}, {Key: "monthlyFee", Value: nullable(r.MonthlyFee)}, {Key: "moveInDate", Value: httpx.ISO(r.MoveInDate)}, {Key: "phone", Value: r.Phone},
			{Key: "residentType", Value: rtype}, {Key: "roomType", Value: r.RoomType}, {Key: "status", Value: r.Status}, {Key: "userId", Value: userID}}},
	}, r.HostelID, nil
}
