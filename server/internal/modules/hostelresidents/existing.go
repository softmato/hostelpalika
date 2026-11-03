package hostelresidents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// The existing-residents list: existing-residents.service.ts.

const (
	listLockStale = 6 * time.Minute
	platformLabel = "HostelPalika"
	oldDuesLine   = "Old dues (before " + platformLabel + ")"
	partPaidLine  = "Already paid at the hostel (before " + platformLabel + ")"
)

func existingErr(msg, code string, status int) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

type storedRow struct {
	ID          bson.ObjectID  `bson:"_id"`
	DepositPaid float64        `bson:"depositPaid"`
	Email       string         `bson:"email"`
	FullName    string         `bson:"fullName"`
	JoinedDate  *time.Time     `bson:"joinedDate"`
	MonthlyRent *float64       `bson:"monthlyRent"`
	OldDues     float64        `bson:"oldDues"`
	PaidTill    *string        `bson:"paidTill"`
	PartPaid    float64        `bson:"partPaid"`
	Phone       string         `bson:"phone"`
	ResidentID  *bson.ObjectID `bson:"residentId"`
	RoomNumber  string         `bson:"roomNumber"`
	RoomType    string         `bson:"roomType"`
}

type storedList struct {
	ID          bson.ObjectID `bson:"_id"`
	AddedAt     *time.Time    `bson:"addedAt"`
	AddingSince *time.Time    `bson:"addingSince"`
	Result      struct {
		Added       int            `bson:"added"`
		BillsRaised int            `bson:"billsRaised"`
		Problems    []addedProblem `bson:"problems"`
	} `bson:"result"`
	Rows      []storedRow `bson:"rows"`
	UpdatedAt *time.Time  `bson:"updatedAt"`
}

type addedProblem struct {
	Message string `bson:"message" json:"message"`
	Name    string `bson:"name" json:"name"`
}

// AddResult is AddResult.
type AddResult struct {
	Added       int
	BillsRaised int
	Problems    []addedProblem
}

func (a AddResult) JSON() ordered.Map {
	p := make([]any, len(a.Problems))
	for i, x := range a.Problems {
		p[i] = ordered.Map{{Key: "message", Value: x.Message}, {Key: "name", Value: x.Name}}
	}
	return ordered.Map{{Key: "added", Value: a.Added}, {Key: "billsRaised", Value: a.BillsRaised}, {Key: "problems", Value: p}}
}

func (s *Service) pub() *residents.Public { return &residents.Public{DB: s.DB} }

func (r storedRow) listRow() residents.ListRow {
	row := residents.ListRow{DepositPaid: int64(r.DepositPaid), Email: r.Email, FullName: r.FullName, ID: r.ID.Hex(), OldDues: int64(r.OldDues), PartPaid: int64(r.PartPaid), Phone: r.Phone,
		RoomNumber: r.RoomNumber, RoomType: r.RoomType}
	if r.MonthlyRent != nil {
		v := int64(*r.MonthlyRent)
		row.MonthlyRent = &v
	}
	if r.PaidTill != nil {
		row.PaidTill = *r.PaidTill
	}
	if r.JoinedDate != nil {
		v := httpx.ISO(*r.JoinedDate)
		row.JoinedDate = &v
	}
	if r.ResidentID != nil {
		row.ResidentID = r.ResidentID.Hex()
	}
	return row
}

func (s *Service) numberedRooms(ctx context.Context, hostel bson.ObjectID) ([]residents.NumberedRoom, error) {
	layout, err := s.Rooms.Layout(ctx, hostel)
	if err != nil {
		return nil, err
	}
	if !layout.Tracking || len(layout.Rooms) == 0 {
		return nil, nil
	}
	out := make([]residents.NumberedRoom, len(layout.Rooms))
	for i, r := range layout.Rooms {
		out[i] = residents.NumberedRoom{Beds: r.Beds, Floor: r.Floor, Free: r.Free, ID: r.ID, Number: r.Number, RoomType: r.RoomType}
	}
	return out, nil
}

type listHostel struct {
	Name  string                 `bson:"name"`
	Slug  string                 `bson:"slug"`
	Rooms []residents.RoomConfig `bson:"roomConfigurations"`
}

func (s *Service) loadListHostel(ctx context.Context, hostel bson.ObjectID) (*listHostel, error) {
	var h listHostel
	err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}, liveUser}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "slug", Value: 1}, {Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, existingErr("Hostel was not found.", "HOSTEL_NOT_FOUND", http.StatusNotFound)
	}
	return &h, err
}

func (s *Service) listContext(ctx context.Context, hostel bson.ObjectID, rows []residents.ListRow, types []residents.RoomTypeContext, numbered []residents.NumberedRoom) (residents.CheckContext, error) {
	return s.pub().CheckContextFor(ctx, rows, types, hostel, numbered)
}

func (s *Service) openList(ctx context.Context, hostel bson.ObjectID) (*storedList, error) {
	var l storedList
	err := s.DB.Collection("existingresidentlists").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "OPEN"}}).Decode(&l)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &l, err
}

func currentPeriod() string { p, _ := bs.PeriodOf(time.Now()); return p }

// ExistingView is getExistingResidents.
func (s *Service) ExistingView(ctx context.Context, hostel bson.ObjectID) (ordered.Map, error) {
	h, err := s.loadListHostel(ctx, hostel)
	if err != nil {
		return nil, err
	}
	list, err := s.openList(ctx, hostel)
	if err != nil {
		return nil, err
	}
	var latest storedList
	var lastAdded any
	err = s.DB.Collection("existingresidentlists").FindOne(ctx, bson.D{{Key: "addedAt", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "hostelId", Value: hostel}},
		options.FindOne().SetSort(bson.D{{Key: "addedAt", Value: -1}}).SetProjection(bson.D{{Key: "addedAt", Value: 1}, {Key: "result", Value: 1}})).Decode(&latest)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if err == nil && latest.AddedAt != nil {
		res := AddResult{Added: latest.Result.Added, BillsRaised: latest.Result.BillsRaised, Problems: latest.Result.Problems}
		lastAdded = ordered.Map{{Key: "addedAt", Value: httpx.ISO(*latest.AddedAt)}, {Key: "added", Value: res.Added}, {Key: "billsRaised", Value: res.BillsRaised}, {Key: "problems", Value: res.JSON()[2].Value}}
	}
	types, err := s.pub().RoomTypesFor(ctx, hostel, h.Rooms)
	if err != nil {
		return nil, err
	}
	numbered, err := s.numberedRooms(ctx, hostel)
	if err != nil {
		return nil, err
	}
	period := currentPeriod()
	var check, listOut any
	rows := []residents.ListRow{}
	if list != nil {
		for _, r := range list.Rows {
			rows = append(rows, r.listRow())
		}
		cctx, err := s.listContext(ctx, hostel, rows, types, numbered)
		if err != nil {
			return nil, err
		}
		check = residents.CheckExistingResidents(rows, cctx).JSON()
		jr := make([]any, len(rows))
		for i, r := range rows {
			jr[i] = r.JSON()
		}
		var updated any
		if list.UpdatedAt != nil {
			updated = httpx.ISO(*list.UpdatedAt)
		}
		listOut = ordered.Map{{Key: "id", Value: list.ID.Hex()}, {Key: "rows", Value: jr}, {Key: "updatedAt", Value: updated}}
	}
	var numberedOut any
	if numbered != nil {
		n := make([]any, len(numbered))
		for i, r := range numbered {
			n[i] = ordered.Map{{Key: "beds", Value: r.Beds}, {Key: "floor", Value: r.Floor}, {Key: "free", Value: r.Free}, {Key: "id", Value: r.ID}, {Key: "number", Value: r.Number}, {Key: "roomType", Value: r.RoomType}}
		}
		numberedOut = n
	}
	rt := make([]any, len(types))
	for i, t := range types {
		var rent any
		if t.MonthlyRent != nil {
			rent = *t.MonthlyRent
		}
		rt[i] = ordered.Map{{Key: "freeBeds", Value: t.VacantBeds}, {Key: "monthlyRent", Value: rent}, {Key: "roomType", Value: t.RoomType}}
	}
	return ordered.Map{{Key: "check", Value: check}, {Key: "currentMonth", Value: ordered.Map{{Key: "label", Value: residents.MonthLabel(period)}, {Key: "period", Value: period}}},
		{Key: "hostel", Value: ordered.Map{{Key: "id", Value: hostel.Hex()}, {Key: "name", Value: h.Name}}}, {Key: "lastAdded", Value: lastAdded}, {Key: "list", Value: listOut},
		{Key: "numberedRooms", Value: numberedOut}, {Key: "roomTypes", Value: rt}}, nil
}

// RowIn is existingResidentRowSchema, parsed.
type RowIn struct {
	ID                              string
	DepositPaid, OldDues, PartPaid  int64
	Email, FullName, Phone          string
	JoinedDate                      *time.Time
	MonthlyRent                     *int64
	PaidTill                        *string
	RoomNumber, RoomType            string
	UserResidentID, AdmissionFormID string
	Details                         ordered.Map
	Photo                           *Upload
	Documents                       []Upload
}

func storedFromInput(r RowIn) bson.D {
	id := bson.NewObjectID()
	if r.ID != "" {
		id, _ = bson.ObjectIDFromHex(r.ID)
	}
	var joined any
	switch {
	case r.JoinedDate != nil:
		joined = r.JoinedDate.UTC().Truncate(time.Millisecond)
	case r.PaidTill != nil:
		joined = defaultJoinedDate(*r.PaidTill, currentPeriod())
	}
	var paid any
	if r.PaidTill != nil {
		paid = *r.PaidTill
	}
	return bson.D{{Key: "_id", Value: id}, {Key: "fullName", Value: strings.Join(strings.Fields(r.FullName), " ")}, {Key: "phone", Value: r.Phone}, {Key: "email", Value: strings.ToLower(r.Email)},
		{Key: "roomNumber", Value: r.RoomNumber}, {Key: "roomType", Value: r.RoomType}, {Key: "monthlyRent", Value: nil}, {Key: "depositPaid", Value: r.DepositPaid}, {Key: "paidTill", Value: paid},
		{Key: "oldDues", Value: r.OldDues}, {Key: "partPaid", Value: r.PartPaid}, {Key: "joinedDate", Value: joined}, {Key: "residentId", Value: nil}}
}

func (s *Service) assertNotAdding(l *storedList) error {
	if l != nil && l.AddingSince != nil && time.Since(*l.AddingSince) < listLockStale {
		return existingErr("This list is being added right now. Wait a moment and open it again.", "EXISTING_RESIDENTS_BUSY", http.StatusConflict)
	}
	return nil
}

// writeRows is writeRows: replace the open list's rows with what build returns.
func (s *Service) writeRows(ctx context.Context, hostel bson.ObjectID, p *authz.Principal, build func(current []storedRow) []any) error {
	if _, err := s.loadListHostel(ctx, hostel); err != nil {
		return err
	}
	list, err := s.openList(ctx, hostel)
	if err != nil {
		return err
	}
	if err := s.assertNotAdding(list); err != nil {
		return err
	}
	var current []storedRow
	if list != nil {
		current = list.Rows
	}
	next := build(current)
	if len(next) > 500 {
		return existingErr("A list can hold 500 residents. Add these first, then start a new list.", "EXISTING_RESIDENTS_TOO_MANY", http.StatusUnprocessableEntity)
	}
	by, at := bsonUser(p), now()
	coll := s.DB.Collection("existingresidentlists")
	if list != nil {
		_, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: list.ID}, {Key: "status", Value: "OPEN"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "rows", Value: next}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: at}}}})
		return err
	}
	_, err = coll.InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "createdBy", Value: by}, {Key: "hostelId", Value: hostel}, {Key: "rows", Value: next}, {Key: "status", Value: "OPEN"}, {Key: "updatedBy", Value: by},
		{Key: "addingSince", Value: nil}, {Key: "addedAt", Value: nil}, {Key: "result", Value: bson.D{{Key: "added", Value: 0}, {Key: "billsRaised", Value: 0}, {Key: "problems", Value: bson.A{}}}},
		{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
	if mongo.IsDuplicateKeyError(err) {
		_, err = coll.UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "OPEN"}}, bson.D{{Key: "$push", Value: bson.D{{Key: "rows", Value: bson.D{{Key: "$each", Value: next}}}}}, {Key: "$set", Value: bson.D{{Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: at}}}})
	}
	return err
}

func rowDoc(r storedRow) bson.D {
	var joined, paid, rent, resident any
	if r.JoinedDate != nil {
		joined = *r.JoinedDate
	}
	if r.PaidTill != nil {
		paid = *r.PaidTill
	}
	if r.MonthlyRent != nil {
		rent = *r.MonthlyRent
	}
	if r.ResidentID != nil {
		resident = *r.ResidentID
	}
	return bson.D{{Key: "_id", Value: r.ID}, {Key: "fullName", Value: r.FullName}, {Key: "phone", Value: r.Phone}, {Key: "email", Value: r.Email}, {Key: "roomNumber", Value: r.RoomNumber}, {Key: "roomType", Value: r.RoomType},
		{Key: "monthlyRent", Value: rent}, {Key: "depositPaid", Value: r.DepositPaid}, {Key: "paidTill", Value: paid}, {Key: "oldDues", Value: r.OldDues}, {Key: "partPaid", Value: r.PartPaid},
		{Key: "joinedDate", Value: joined}, {Key: "residentId", Value: resident}}
}

// SaveRows is saveExistingResidentRows.
func (s *Service) SaveRows(ctx context.Context, hostel bson.ObjectID, rows []RowIn, p *authz.Principal) (ordered.Map, error) {
	err := s.writeRows(ctx, hostel, p, func(current []storedRow) []any {
		added := map[string]storedRow{}
		for _, r := range current {
			if r.ResidentID != nil {
				added[r.ID.Hex()] = r
			}
		}
		out, sent := []any{}, map[string]bool{}
		for _, r := range rows {
			if r.ID != "" {
				sent[r.ID] = true
			}
			if a, ok := added[r.ID]; r.ID != "" && ok {
				out = append(out, rowDoc(a))
			} else {
				out = append(out, storedFromInput(r))
			}
		}
		for _, r := range current {
			if r.ResidentID != nil && !sent[r.ID.Hex()] {
				out = append(out, rowDoc(r))
			}
		}
		return out
	})
	if err != nil {
		return nil, err
	}
	return s.ExistingView(ctx, hostel)
}

// AddFile is addExistingResidentsFile.
func (s *Service) AddFile(ctx context.Context, hostel bson.ObjectID, content []byte, p *authz.Principal) (ordered.Map, error) {
	rows, notes, err := readExistingFile(content, currentPeriod())
	if err != nil {
		return nil, err
	}
	err = s.writeRows(ctx, hostel, p, func(current []storedRow) []any {
		out := make([]any, 0, len(current)+len(rows))
		for _, r := range current {
			out = append(out, rowDoc(r))
		}
		for _, r := range rows {
			paid := any(nil)
			var pt *string
			if r.PaidTill != "" {
				v := r.PaidTill
				pt = &v
			}
			_ = paid
			out = append(out, storedFromInput(RowIn{DepositPaid: r.DepositPaid, Email: r.Email, FullName: r.FullName, JoinedDate: r.JoinedDate, OldDues: r.OldDues, PaidTill: pt, Phone: r.Phone, RoomNumber: r.RoomNumber, RoomType: r.RoomType}))
		}
		return out
	})
	if err != nil {
		return nil, err
	}
	view, err := s.ExistingView(ctx, hostel)
	if err != nil {
		return nil, err
	}
	if notes == nil {
		notes = []string{}
	}
	return ordered.Map{{Key: "notes", Value: notes}, {Key: "read", Value: len(rows)}, {Key: "view", Value: view}}, nil
}

// ClearList is clearExistingResidents.
func (s *Service) ClearList(ctx context.Context, hostel bson.ObjectID) (ordered.Map, error) {
	list, err := s.openList(ctx, hostel)
	if err != nil {
		return nil, err
	}
	if err := s.assertNotAdding(list); err != nil {
		return nil, err
	}
	if list != nil {
		var added []any
		for _, r := range list.Rows {
			if r.ResidentID != nil {
				added = append(added, rowDoc(r))
			}
		}
		coll := s.DB.Collection("existingresidentlists")
		if len(added) == 0 {
			_, err = coll.DeleteOne(ctx, bson.D{{Key: "_id", Value: list.ID}, {Key: "status", Value: "OPEN"}})
		} else {
			_, err = coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: list.ID}, {Key: "status", Value: "OPEN"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "rows", Value: added}, {Key: "status", Value: "ADDED"}, {Key: "updatedAt", Value: now()}}}})
		}
		if err != nil {
			return nil, err
		}
	}
	return s.ExistingView(ctx, hostel)
}

// Template is existingResidentsTemplate.
func (s *Service) Template(ctx context.Context, hostel bson.ObjectID) ([]byte, string, error) {
	h, err := s.loadListHostel(ctx, hostel)
	if err != nil {
		return nil, "", err
	}
	types, err := s.pub().RoomTypesFor(ctx, hostel, h.Rooms)
	if err != nil {
		return nil, "", err
	}
	numbered, err := s.numberedRooms(ctx, hostel)
	if err != nil {
		return nil, "", err
	}
	var numbers []string
	for _, r := range numbered {
		numbers = append(numbers, r.Number)
	}
	rooms := make([]templateRoom, len(types))
	for i, t := range types {
		rooms[i] = templateRoom{MonthlyRent: t.MonthlyRent, RoomType: t.RoomType}
	}
	name := h.Name
	if name == "" {
		name = "your hostel"
	}
	body, err := buildTemplate(residents.MonthLabel(currentPeriod()), name, numbers, rooms)
	slug := h.Slug
	if slug == "" {
		slug = "hostel"
	}
	return body, slug + "-existing-residents.xlsx", err
}

// AddAll is addExistingResidents; onlyRow limits it to one row of the list.
func (s *Service) AddAll(ctx context.Context, hostel bson.ObjectID, p *authz.Principal, onlyRow string) (res AddResult, view ordered.Map, err error) {
	h, err := s.loadListHostel(ctx, hostel)
	if err != nil {
		return res, nil, err
	}
	at := now()
	coll := s.DB.Collection("existingresidentlists")
	var list storedList
	err = coll.FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "OPEN"},
		{Key: "$or", Value: bson.A{bson.D{{Key: "addingSince", Value: nil}}, bson.D{{Key: "addingSince", Value: bson.D{{Key: "$lt", Value: at.Add(-listLockStale)}}}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "addingSince", Value: at}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&list)
	if errors.Is(err, mongo.ErrNoDocuments) {
		open, oerr := s.openList(ctx, hostel)
		if oerr != nil {
			return res, nil, oerr
		}
		if berr := s.assertNotAdding(open); berr != nil {
			return res, nil, berr
		}
		return res, nil, existingErr("There is no list to add. Upload a file or add residents one by one first.", "EXISTING_RESIDENTS_EMPTY", http.StatusNotFound)
	}
	if err != nil {
		return res, nil, err
	}
	defer func() {
		if err != nil {
			_, _ = coll.UpdateOne(context.WithoutCancel(ctx), bson.D{{Key: "_id", Value: list.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "addingSince", Value: nil}}}})
		}
	}()
	res = AddResult{Problems: []addedProblem{}}
	var rows []residents.ListRow
	for _, r := range list.Rows {
		if onlyRow == "" || r.ID.Hex() == onlyRow {
			rows = append(rows, r.listRow())
		}
	}
	types, err := s.pub().RoomTypesFor(ctx, hostel, h.Rooms)
	if err != nil {
		return res, nil, err
	}
	numbered, err := s.numberedRooms(ctx, hostel)
	if err != nil {
		return res, nil, err
	}
	cctx, err := s.listContext(ctx, hostel, rows, types, numbered)
	if err != nil {
		return res, nil, err
	}
	check := residents.CheckExistingResidents(rows, cctx)
	if check.ToAdd > 0 && !check.Ready {
		return res, nil, httpx.NewError(http.StatusUnprocessableEntity, "EXISTING_RESIDENTS_NOT_READY", "Fix the problems in the list first.", ordered.Map{{Key: "check", Value: check.JSON()}})
	}
	if check.ToAdd > 0 {
		if err = s.Limits.AssertRoom(ctx, hostel, "residents", int64(check.ToAdd)); err != nil {
			return res, nil, err
		}
	}
	residentIDs := map[string]bson.ObjectID{}
	type addedNow struct {
		rent     *int64
		resident bson.ObjectID
	}
	var added []addedNow
	for _, row := range rows {
		if row.ResidentID != "" {
			residentIDs[row.ID], _ = bson.ObjectIDFromHex(row.ResidentID)
			continue
		}
		var checked residents.CheckedRow
		for _, c := range check.Rows {
			if c.ID == row.ID {
				checked = c
			}
		}
		placed, placedType := residents.RoomOfRow(row, numbered)
		var room residents.RoomTypeContext
		for _, t := range types {
			if residents.SameRoomType(t.RoomType, placedType) {
				room = t
				break
			}
		}
		first, last := residents.SplitName(row.FullName)
		if err2 := s.Cap.Claim(ctx, hostel, room.RoomType); err2 != nil {
			res.Problems = append(res.Problems, addedProblem{Message: err2.Error(), Name: row.FullName})
			continue
		}
		if strings.EqualFold(row.Email, residents.DemoResidentEmail) {
			if err2 := s.removeDemoResident(ctx, p); err2 != nil {
				nonFatal(ctx, err2)
			}
		}
		id := bson.NewObjectID()
		doc := bson.D{{Key: "_id", Value: id}, {Key: "admissionFee", Value: nil}, {Key: "bedType", Value: nilIfEmpty(finance.NormalizeBedType(room.RoomType))}, {Key: "createdBy", Value: bsonUser(p)},
			{Key: "depositAmount", Value: float64(row.DepositPaid)}}
		if e := strings.ToLower(strings.TrimSpace(row.Email)); e != "" {
			doc = append(doc, bson.E{Key: "email", Value: e})
		}
		doc = append(doc, bson.E{Key: "existingListId", Value: list.ID}, bson.E{Key: "firstName", Value: first}, bson.E{Key: "hostelId", Value: hostel}, bson.E{Key: "isDeleted", Value: false},
			bson.E{Key: "lastName", Value: last}, bson.E{Key: "monthlyFee", Value: nil})
		if mi := residents.MoveInDateFor(row); mi != nil {
			doc = append(doc, bson.E{Key: "moveInDate", Value: *mi})
		}
		var paid any
		if row.PaidTill != "" {
			paid = row.PaidTill
		}
		doc = append(doc, bson.E{Key: "paidTill", Value: paid}, bson.E{Key: "phone", Value: row.Phone})
		if placed != nil {
			rid, _ := bson.ObjectIDFromHex(placed.ID)
			doc = append(doc, bson.E{Key: "floor", Value: placed.Floor}, bson.E{Key: "roomId", Value: rid}, bson.E{Key: "roomNumber", Value: placed.Number})
		} else {
			doc = append(doc, bson.E{Key: "roomId", Value: nil}, bson.E{Key: "floor", Value: nil}, bson.E{Key: "roomNumber", Value: nil})
		}
		doc = append(doc, bson.E{Key: "roomType", Value: room.RoomType}, bson.E{Key: "status", Value: "ACTIVE"}, bson.E{Key: "updatedBy", Value: bsonUser(p)},
			bson.E{Key: "billingCycle", Value: "CALENDAR_MONTH"}, bson.E{Key: "residentType", Value: "STUDENT"}, bson.E{Key: "admissionFeeDiscount", Value: 0}, bson.E{Key: "deskIntake", Value: false},
			bson.E{Key: "detailsData", Value: nil}, bson.E{Key: "photoAssetId", Value: nil}, bson.E{Key: "admissionFormId", Value: nil}, bson.E{Key: "stayEndsAt", Value: nil}, bson.E{Key: "moveOutDate", Value: nil},
			bson.E{Key: "lastMonthCharge", Value: nil}, bson.E{Key: "leavingOn", Value: nil}, bson.E{Key: "leavingReason", Value: nil}, bson.E{Key: "leavingNoticeAt", Value: nil},
			bson.E{Key: "accountLinkDeclinedAt", Value: nil}, bson.E{Key: "accountLinkDeclinedBy", Value: nil}, bson.E{Key: "isDemoData", Value: false},
			bson.E{Key: "createdAt", Value: now()}, bson.E{Key: "updatedAt", Value: now()}, bson.E{Key: "__v", Value: 0})
		if _, err2 := s.DB.Collection("residents").InsertOne(ctx, doc); err2 != nil {
			nonFatal(ctx, s.Cap.Release(ctx, hostel, room.RoomType))
			msg := err2.Error()
			if mongo.IsDuplicateKeyError(err2) {
				msg = "Phone or email is already used in this hostel."
			}
			res.Problems = append(res.Problems, addedProblem{Message: msg, Name: row.FullName})
			continue
		}
		rowID, _ := bson.ObjectIDFromHex(row.ID)
		if _, err2 := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: list.ID}, {Key: "rows._id", Value: rowID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "rows.$.residentId", Value: id}}}}); err2 != nil {
			return res, nil, err2
		}
		residentIDs[row.ID] = id
		added = append(added, addedNow{rent: checked.Rent, resident: id})
		res.Added++
		nonFatal(ctx, s.auditResident(ctx, p, hostel, id, "RESIDENT_CREATED", bson.D{{Key: "existingListId", Value: list.ID.Hex()}, {Key: "roomType", Value: room.RoomType}, {Key: "source", Value: "EXISTING_RESIDENTS"}}))
	}
	period := currentPeriod()
	bounds, _ := bs.PeriodBounds(period)
	due := bounds.LastDay
	var addedRows []residents.ListRow
	for _, r := range rows {
		if _, ok := residentIDs[r.ID]; ok {
			addedRows = append(addedRows, r)
		}
	}
	seen := map[string]bool{}
	var periods []string
	for _, r := range addedRows {
		if r.PaidTill == "" {
			continue
		}
		for _, m := range residents.UnpaidMonths(r.PaidTill, period) {
			if !seen[m] {
				seen[m] = true
				periods = append(periods, m)
			}
		}
	}
	sortStrings(periods)
	for _, m := range periods {
		ids := bson.A{}
		for _, r := range addedRows {
			if r.PaidTill != "" && r.PaidTill < m {
				ids = append(ids, residentIDs[r.ID])
			}
		}
		run, rerr := s.Ledger.RunBillingCycle(ctx, ledger.BillingInput{DueDate: &due, HostelID: hostel, Period: m, ResidentIDs: ids}, p)
		if rerr != nil {
			noun := "residents"
			if len(ids) == 1 {
				noun = "resident"
			}
			res.Problems = append(res.Problems, addedProblem{Message: fmt.Sprintf("%s rent was not billed: %s", residents.MonthLabel(m), rerr.Error()), Name: fmt.Sprintf("%d %s", len(ids), noun)})
			continue
		}
		res.BillsRaised += len(run.Billed)
		for _, f := range run.Failures {
			name := "A resident"
			for _, r := range addedRows {
				if residentIDs[r.ID].Hex() == f.ResidentID {
					name = r.FullName
				}
			}
			res.Problems = append(res.Problems, addedProblem{Message: fmt.Sprintf("%s rent was not billed: %s", residents.MonthLabel(m), f.Message), Name: name})
		}
	}
	var prefix struct {
		Prefix string `bson:"referencePrefix"`
	}
	_ = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "referencePrefix", Value: 1}})).Decode(&prefix)
	for _, r := range addedRows {
		if r.OldDues <= 0 {
			continue
		}
		rid := residentIDs[r.ID]
		n, cerr := s.DB.Collection("invoices").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "ADJUSTMENT"}, {Key: "lines.description", Value: oldDuesLine}, {Key: "residentId", Value: rid}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}}, options.Count().SetLimit(1))
		if cerr == nil && n > 0 {
			continue
		}
		ref, rerr := s.Ledger.AllocateReferenceCode(ctx, hostel, prefix.Prefix)
		if rerr == nil {
			at := now()
			_, rerr = s.DB.Collection("invoices").InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostel}, {Key: "residentId", Value: rid}, {Key: "period", Value: nil}, {Key: "kind", Value: "ADJUSTMENT"},
				{Key: "lines", Value: bson.A{bson.D{{Key: "description", Value: oldDuesLine}, {Key: "bedType", Value: nil}, {Key: "amount", Value: ledger.JSInt(r.OldDues)}, {Key: "basis", Value: "MANUAL"}}}},
				{Key: "totalAmount", Value: ledger.JSInt(r.OldDues)}, {Key: "currency", Value: "NPR"}, {Key: "dueDate", Value: due}, {Key: "issuedAt", Value: at}, {Key: "status", Value: "OPEN"}, {Key: "referenceCode", Value: strings.ToUpper(ref)},
				{Key: "legacyPaymentId", Value: nil}, {Key: "dunning", Value: bson.D{{Key: "lastNotifiedAt", Value: nil}, {Key: "chaseCount", Value: 0}, {Key: "stage", Value: "NONE"}}}, {Key: "fineWaived", Value: false},
				{Key: "createdBy", Value: bsonUser(p)}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
		}
		if rerr != nil {
			res.Problems = append(res.Problems, addedProblem{Message: "Old dues were not billed: " + rerr.Error(), Name: r.FullName})
			continue
		}
		res.BillsRaised++
	}
	for _, r := range addedRows {
		if r.PartPaid <= 0 {
			continue
		}
		rid := residentIDs[r.ID]
		var oldest struct {
			ID bson.ObjectID `bson:"_id"`
		}
		err2 := s.DB.Collection("invoices").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "MONTHLY_RENT"}, {Key: "residentId", Value: rid}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "VOID"}}}},
			options.FindOne().SetSort(bson.D{{Key: "period", Value: 1}}).SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&oldest)
		if errors.Is(err2, mongo.ErrNoDocuments) {
			continue
		}
		if err2 == nil {
			_, err2 = s.DB.Collection("invoices").UpdateOne(ctx, bson.D{{Key: "_id", Value: oldest.ID}, {Key: "lines.description", Value: bson.D{{Key: "$ne", Value: partPaidLine}}}, {Key: "status", Value: "OPEN"}, {Key: "totalAmount", Value: bson.D{{Key: "$gt", Value: r.PartPaid}}}},
				bson.D{{Key: "$inc", Value: bson.D{{Key: "totalAmount", Value: -r.PartPaid}}}, {Key: "$push", Value: bson.D{{Key: "lines", Value: bson.D{{Key: "amount", Value: -r.PartPaid}, {Key: "basis", Value: "CREDIT"}, {Key: "description", Value: partPaidLine}, {Key: "bedType", Value: nil}}}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now()}}}})
		}
		if err2 != nil {
			res.Problems = append(res.Problems, addedProblem{Message: "Part paid was not taken off: " + err2.Error(), Name: r.FullName})
		}
	}
	remaining := 0
	for _, r := range list.Rows {
		if r.ResidentID == nil {
			if _, ok := residentIDs[r.ID.Hex()]; !ok {
				remaining++
			}
		}
	}
	status := "ADDED"
	if remaining != 0 {
		status = "OPEN"
	}
	problems := bson.A{}
	for _, x := range res.Problems {
		problems = append(problems, bson.D{{Key: "message", Value: x.Message}, {Key: "name", Value: x.Name}})
	}
	if _, err = coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: list.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "addedAt", Value: now()}, {Key: "addedBy", Value: bsonUser(p)}, {Key: "addingSince", Value: nil},
		{Key: "result", Value: bson.D{{Key: "added", Value: res.Added}, {Key: "billsRaised", Value: res.BillsRaised}, {Key: "problems", Value: problems}}}, {Key: "status", Value: status}, {Key: "updatedAt", Value: now()}}}}); err != nil {
		return res, nil, err
	}
	notice := make([]addedResident, len(added))
	for i, a := range added {
		notice[i] = addedResident{rent: a.rent, resident: a.resident}
	}
	billsRaised := res.BillsRaised
	s.runAfter(ctx, func(c context.Context) error { s.notifyAdded(c, notice, billsRaised, hostel, p); return nil })
	view, err = s.ExistingView(ctx, hostel)
	return res, view, err
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func sortStrings(v []string) {
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
}

func (s *Service) runAfter(ctx context.Context, fn func(context.Context) error) {
	if s.After != nil {
		s.After(ctx, fn)
		return
	}
	_ = fn(ctx)
}

// ScannedResult is the answer of one scanned/joined resident being added.
type ScannedResult struct {
	ResidentID string
	Result     AddResult
}

// AddScanned is addScannedExistingResident.
func (s *Service) AddScanned(ctx context.Context, hostel bson.ObjectID, row RowIn, userResidentID string, p *authz.Principal) (*ScannedResult, *IntakeAccount, error) {
	acct, err := s.FindAccountForIntake(ctx, strings.ToLower(strings.TrimSpace(row.Email)), userResidentID, nil)
	if err != nil {
		return nil, nil, err
	}
	var userIDs []bson.ObjectID
	if acct.UserID != nil {
		userIDs = append(userIDs, *acct.UserID)
	}
	if live, err := s.FindLiveResidency(ctx, []string{row.Email, acct.Email}, userIDs, hostel); err != nil {
		return nil, nil, err
	} else if live != nil {
		code := "RESIDENT_LIVES_ELSEWHERE"
		if live.SameHostel {
			code = "RESIDENT_ALREADY_HERE"
		}
		return nil, nil, existingErr(liveResidencyMessage(row.FullName, live), code, http.StatusConflict)
	}
	rowID := bson.NewObjectID()
	row.ID = ""
	if err := s.writeRows(ctx, hostel, p, func(current []storedRow) []any {
		out := make([]any, 0, len(current)+1)
		for _, r := range current {
			out = append(out, rowDoc(r))
		}
		doc := storedFromInput(row)
		doc[0].Value = rowID
		return append(out, doc)
	}); err != nil {
		return nil, nil, err
	}
	takeBack := func() {
		_, _ = s.DB.Collection("existingresidentlists").UpdateOne(context.WithoutCancel(ctx), bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "OPEN"}},
			bson.D{{Key: "$pull", Value: bson.D{{Key: "rows", Value: bson.D{{Key: "_id", Value: rowID}, {Key: "residentId", Value: nil}}}}}})
	}
	result, _, err := s.AddAll(ctx, hostel, p, rowID.Hex())
	if err != nil {
		takeBack()
		var he *httpx.Error
		if errors.As(err, &he) && he.ErrorCode == "EXISTING_RESIDENTS_NOT_READY" {
			if d, ok := he.Details.(ordered.Map); ok {
				if reason := firstReason(d); reason != "" {
					return nil, nil, existingErr(reason, "EXISTING_RESIDENT_NOT_READY", http.StatusUnprocessableEntity)
				}
			}
		}
		return nil, nil, err
	}
	if result.Added == 0 {
		takeBack()
		msg := "They could not be added."
		if len(result.Problems) > 0 {
			msg = result.Problems[0].Message
		}
		return nil, nil, existingErr(msg, "EXISTING_RESIDENT_NOT_ADDED", http.StatusConflict)
	}
	var found struct {
		Rows []storedRow `bson:"rows"`
	}
	_ = s.DB.Collection("existingresidentlists").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "rows._id", Value: rowID}}, options.FindOne().SetProjection(bson.D{{Key: "rows.$", Value: 1}})).Decode(&found)
	out := &ScannedResult{Result: result}
	if len(found.Rows) > 0 && found.Rows[0].ResidentID != nil {
		out.ResidentID = found.Rows[0].ResidentID.Hex()
		var r Resident
		if err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: *found.Rows[0].ResidentID}}).Decode(&r); err == nil {
			s.LinkAccount(ctx, &r, p, userResidentID, false, &acct)
		}
	}
	return out, &acct, nil
}

// firstReason is the first list problem, else the first problem of the first row.
func firstReason(details ordered.Map) string {
	check, _ := details[0].Value.(ordered.Map)
	if lp, ok := check[0].Value.([]string); ok && len(lp) > 0 {
		return lp[0]
	}
	if rows, ok := check[3].Value.([]any); ok && len(rows) > 0 {
		if row, ok := rows[0].(ordered.Map); ok {
			if ps, ok := row[3].Value.([]any); ok && len(ps) > 0 {
				if p, ok := ps[0].(ordered.Map); ok {
					msg, _ := p[1].Value.(string)
					return msg
				}
			}
		}
	}
	return ""
}

type addedResident struct {
	rent     *int64
	resident bson.ObjectID
}

// notifyAdded is notifyExistingResidentsAdded: each person, then a staff summary.
func (s *Service) notifyAdded(ctx context.Context, added []addedResident, billsRaised int, hostel bson.ObjectID, p *authz.Principal) {
	if len(added) == 0 {
		return
	}
	name := s.hostelName(ctx, hostel)
	counts := map[string]int{}
	for _, a := range added {
		counts[s.tellOne(ctx, a, hostel, name, p)]++
	}
	staff, err := residents.HostelStaffUserIDs(ctx, s.DB, hostel, false)
	if err != nil {
		slog.WarnContext(ctx, "Existing residents: staff summary failed", "error", err)
		return
	}
	noun := "bills"
	if billsRaised == 1 {
		noun = "bill"
	}
	body := []string{fmt.Sprintf("%d %s made", billsRaised, noun), fmt.Sprintf("%d emailed", counts["emailed"])}
	if counts["unreached"] > 0 {
		body = append(body, fmt.Sprintf("%d with no email — tell them yourself", counts["unreached"]))
	}
	resident := "residents"
	if len(added) == 1 {
		resident = "resident"
	}
	for _, uid := range staff {
		if _, err := s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/residents", Body: strings.Join(body, " · "), Category: "RESIDENT", HostelID: hostel.Hex(),
			Title: fmt.Sprintf("%d existing %s added", len(added), resident), UserID: uid}); err != nil {
			slog.WarnContext(ctx, "Existing residents: staff summary failed", "error", err)
		}
	}
}

func (s *Service) tellOne(ctx context.Context, a addedResident, hostel bson.ObjectID, hostelName string, p *authz.Principal) string {
	var r Resident
	if err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: a.resident}}).Decode(&r); err != nil {
		return "unreached"
	}
	var paidTill struct {
		PaidTill *string `bson:"paidTill"`
	}
	_ = s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: a.resident}}, options.FindOne().SetProjection(bson.D{{Key: "paidTill", Value: 1}})).Decode(&paidTill)
	cur, err := s.DB.Collection("invoices").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}},
		options.Find().SetSort(bson.D{{Key: "period", Value: 1}, {Key: "issuedAt", Value: 1}}))
	if err != nil {
		return "unreached"
	}
	var invoices []struct {
		DueDate time.Time `bson:"dueDate"`
		Kind    string    `bson:"kind"`
		Lines   []struct {
			Description string `bson:"description"`
		} `bson:"lines"`
		Period        *string `bson:"period"`
		ReferenceCode string  `bson:"referenceCode"`
		TotalAmount   float64 `bson:"totalAmount"`
	}
	if err := cur.All(ctx, &invoices); err != nil {
		return "unreached"
	}
	label := func(period string) string { return strings.TrimSuffix(strings.TrimSpace(bsLabel(period)), " BS") }
	var dues []email.ExistingDue
	var latest time.Time
	add := func(rent bool) {
		for _, inv := range invoices {
			if (inv.Kind == "MONTHLY_RENT") != rent {
				continue
			}
			text := "Bill"
			switch {
			case inv.Kind == "MONTHLY_RENT" && inv.Period != nil:
				text = label(*inv.Period) + " rent"
			case inv.Kind == "ADJUSTMENT":
				text = "Old dues"
			case len(inv.Lines) > 0:
				text = inv.Lines[0].Description
			}
			dues = append(dues, email.ExistingDue{Amount: int64(inv.TotalAmount), Code: inv.ReferenceCode, Label: text})
			if inv.DueDate.After(latest) {
				latest = inv.DueDate
			}
		}
	}
	add(true)
	add(false)
	payBy := ""
	if len(dues) > 0 {
		payBy = bs.FormatDate(latest)
	}
	paid, next := "", ""
	if paidTill.PaidTill != nil && *paidTill.PaidTill != "" {
		paid = label(*paidTill.PaidTill)
		if n, e := bs.AddMonths(*paidTill.PaidTill, 1); e == nil {
			next = label(n)
		}
	}
	var userID *bson.ObjectID
	if r.UserID != nil {
		userID = r.UserID
	} else if r.Email != "" {
		var u struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "email", Value: strings.ToLower(r.Email)}, liveUser}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&u) == nil {
			userID = &u.ID
		}
	}
	if r.UserID != nil {
		_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/payments", Body: hostelName + " added you as a resident. Your rent and bills are in the app.", Category: "ACCOUNT",
			Data: ordered.Map{{Key: "type", Value: "RESIDENT_REGISTERED"}}, Priority: "NORMAL", Title: "Welcome to " + hostelName, UserID: r.UserID.Hex()})
	} else if userID != nil {
		_, _ = s.Notify.CreateInApp(ctx, notifications.Input{Body: hostelName + " added you as a resident. Open to confirm it is you.", Category: "ACCOUNT",
			Data: ordered.Map{{Key: "type", Value: "RESIDENCY_INVITE"}}, Priority: "NORMAL", Title: "Confirm your hostel", UserID: userID.Hex()})
	}
	contact := residents.ResolveContact(ctx, s.DB, r.Email, r.FirstName, r.LastName, r.UserID)
	if contact == nil {
		if userID != nil {
			return "app-only"
		}
		return "unreached"
	}
	in := email.ExistingAddedInput{DashboardURL: s.AppURL("/login"), OfferProgramURL: s.AppURL("/resident-offer-program"), DepositPaid: int64(r.DepositAmount), Dues: dues, HasAccount: userID != nil,
		HostelName: hostelName, NextBillMonth: next, PaidTill: paid, PayBy: payBy, ResidentName: r.FirstName, RoomType: r.RoomType}
	if a.rent != nil {
		in.MonthlyRent = *a.rent
	}
	if userID == nil {
		if out, err := s.GenerateActivation(ctx, r.ID.Hex(), hostel.Hex(), ActivationIn{}, p); err == nil {
			if act, ok := out[0].Value.(ordered.Map); ok {
				code, _ := act[0].Value.(string)
				expires, _ := time.Parse("2006-01-02T15:04:05.000Z", fmt.Sprint(act[3].Value))
				in.ActivationURL = s.activationURL(code)
				in.ActivationExpiresOn = strings.TrimSuffix(bs.FormatDate(expires), " BS")
			}
		} else {
			slog.WarnContext(ctx, "Existing resident: activation link could not be made", "error", err, "residentId", r.ID.Hex())
		}
	}
	mail := email.ExistingResidentAdded(in)
	res := s.Mail.Send(ctx, email.Message{Category: mail.Category, To: []string{contact.Email}, Subject: mail.Subject, HTML: mail.HTML})
	switch {
	case res.Sent:
		return "emailed"
	case userID != nil:
		return "app-only"
	}
	return "unreached"
}

func bsLabel(period string) string {
	l := bs.FormatPeriod(period)
	if l == "" {
		return period
	}
	return l
}

var _ = hostelrooms.TypeLabel

// AddOne is the `one` route: a scanned or hand-typed resident added now, with the
// form, photo and papers that came with them.
func (s *Service) AddOne(ctx context.Context, hostel bson.ObjectID, row RowIn, p *authz.Principal) (ordered.Map, error) {
	photoID, scans, err := s.claimUploads(ctx, CreateIn{Photo: row.Photo, Documents: row.Documents}, hostel)
	if err != nil {
		return nil, err
	}
	added, acct, err := s.AddScanned(ctx, hostel, row, row.UserResidentID, p)
	if err != nil {
		return nil, err
	}
	sealed, err := s.seal(row.Details)
	if err != nil {
		return nil, err
	}
	if added.ResidentID != "" {
		rid, _ := bson.ObjectIDFromHex(added.ResidentID)
		set := bson.D{}
		if sealed != nil {
			set = append(set, bson.E{Key: "detailsData", Value: sealed})
		}
		if photoID != nil {
			set = append(set, bson.E{Key: "photoAssetId", Value: *photoID})
		}
		if len(set) > 0 {
			if _, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: rid}, {Key: "hostelId", Value: hostel}}, bson.D{{Key: "$set", Value: set}}); err != nil {
				return nil, err
			}
		}
		if len(scans) > 0 {
			if err := s.saveDocuments(ctx, rid, hostel, scans, bsonUser(p)); err != nil {
				return nil, err
			}
		}
		if row.AdmissionFormID != "" {
			if err := s.markFormAdded(ctx, hostel, row.AdmissionFormID, rid, p); err != nil {
				return nil, err
			}
			// ponytail: cardFromAdmissionForm (RES-16) follows here once resident-identity is ported.
			if row.UserResidentID == "" {
				var r Resident
				if err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: rid}}).Decode(&r); err == nil && r.UserID == nil && r.Email != "" {
					login, lerr := s.OpenLogin(ctx, r.Email, r.name())
					if lerr != nil {
						return nil, lerr
					}
					s.LinkAccount(ctx, &r, p, "", false, &login)
				}
			}
		}
	}
	_ = acct
	var resident any
	if added.ResidentID != "" {
		resident = added.ResidentID
	}
	return ordered.Map{{Key: "residentId", Value: resident}, {Key: "result", Value: added.Result.JSON()}}, nil
}
