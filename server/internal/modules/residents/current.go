package residents

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Record is what the signed-in resident surfaces read of a Resident row.
type Record struct {
	ID            bson.ObjectID  `bson:"_id"`
	CreatedAt     *time.Time     `bson:"createdAt"`
	DepositAmount *float64       `bson:"depositAmount"`
	Email         string         `bson:"email"`
	FirstName     string         `bson:"firstName"`
	HostelID      bson.ObjectID  `bson:"hostelId"`
	LastName      string         `bson:"lastName"`
	MoveInDate    *time.Time     `bson:"moveInDate"`
	Phone         string         `bson:"phone"`
	ResidentType  string         `bson:"residentType"`
	RoomType      string         `bson:"roomType"`
	Status        string         `bson:"status"`
	UpdatedAt     *time.Time     `bson:"updatedAt"`
	UserID        *bson.ObjectID `bson:"userId"`
}

func (r *Record) FullName() string { return strings.TrimSpace(r.FirstName + " " + r.LastName) }

func errNoProfile() error {
	return httpx.NewError(http.StatusNotFound, "RESIDENT_PROFILE_NOT_FOUND", "Resident profile was not found for this account.", nil)
}

// Current is findCurrentResident: the account's live profile, and a profile
// outside the principal's scope reads as a genuine miss (RULES.md §3).
func Current(ctx context.Context, db *mongo.Database, p *authz.Principal) (*Record, error) {
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	var r Record
	err = db.Collection("residents").FindOne(ctx, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: uid}}).Decode(&r)
	if err == mongo.ErrNoDocuments {
		return nil, errNoProfile()
	}
	if err != nil {
		return nil, err
	}
	if !slices.Contains(p.HostelIDs, r.HostelID.Hex()) {
		return nil, errNoProfile()
	}
	return &r, nil
}

func isoOrUndefined(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

// Summary is serializeResidentSummary without avatars (image null when no join ran).
func Summary(r *Record) ordered.Map { return SummaryWith(r, nil) }

// SummaryWith is serializeResidentSummary given findResidentAvatars' map.
func SummaryWith(r *Record, avatars map[string]*string) ordered.Map {
	email := r.Email
	residentType := r.ResidentType
	if residentType == "" {
		residentType = "STUDENT"
	}
	var image any
	user := any(ordered.Undefined)
	if r.UserID != nil {
		user = r.UserID.Hex()
		if a := avatars[r.UserID.Hex()]; a != nil {
			image = *a
		}
	}
	moveIn := any(ordered.Undefined)
	if r.MoveInDate != nil {
		moveIn = httpx.ISO(*r.MoveInDate)
	}
	deposit := any(ordered.Undefined)
	if r.DepositAmount != nil {
		deposit = *r.DepositAmount
	}
	return ordered.Map{{Key: "createdAt", Value: isoOrUndefined(r.CreatedAt)}, {Key: "depositAmount", Value: deposit}, {Key: "email", Value: email},
		{Key: "firstName", Value: r.FirstName}, {Key: "fullName", Value: r.FullName()}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: r.ID.Hex()},
		{Key: "image", Value: image}, {Key: "lastName", Value: r.LastName}, {Key: "moveInDate", Value: moveIn}, {Key: "phone", Value: r.Phone},
		{Key: "residentType", Value: residentType}, {Key: "roomType", Value: r.RoomType}, {Key: "status", Value: r.Status},
		{Key: "updatedAt", Value: isoOrUndefined(r.UpdatedAt)}, {Key: "userId", Value: user}}
}

// HostelName is getHostelName.
func HostelName(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID) (string, error) {
	var row struct {
		Name *string `bson:"name"`
	}
	err := db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return "", err
	}
	if row.Name == nil {
		return "your hostel", nil
	}
	return *row.Name, nil
}

// WardenContacts is resolveHostelWardenContacts.
func WardenContacts(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID) ([]Contact, error) {
	cur, err := db.Collection("hostelmembers").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		UserID bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	ids := make([]bson.ObjectID, len(rows))
	for i, m := range rows {
		ids[i] = m.UserID
	}
	if len(ids) == 0 {
		return []Contact{}, nil
	}
	users, err := liveUsers(ctx, db, ids)
	if err != nil {
		return nil, err
	}
	out := []Contact{}
	for _, u := range users {
		if u.Email == "" {
			continue
		}
		name := "Warden"
		if u.Name != nil {
			name = *u.Name
		}
		out = append(out, Contact{Email: u.Email, Name: name, UserID: u.ID.Hex()})
	}
	return out, nil
}

// GuardianContacts is resolveResidentGuardianContacts; UserID is "" for a
// guardian with no account yet.
func GuardianContacts(ctx context.Context, db *mongo.Database, hostelID, residentID bson.ObjectID) ([]Contact, error) {
	cur, err := db.Collection("guardianaccesses").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "residentId", Value: residentID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "USED"}}}}})
	if err != nil {
		return nil, err
	}
	var accesses []struct {
		GuardianID bson.ObjectID  `bson:"guardianId"`
		UserID     *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &accesses); err != nil {
		return nil, err
	}
	if len(accesses) == 0 {
		return []Contact{}, nil
	}
	ids, users := bson.A{}, map[string]string{}
	for _, a := range accesses {
		ids = append(ids, a.GuardianID)
		if a.UserID != nil {
			users[a.GuardianID.Hex()] = a.UserID.Hex()
		} else {
			delete(users, a.GuardianID.Hex())
		}
	}
	cur, err = db.Collection("guardians").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID        bson.ObjectID `bson:"_id"`
		Email     string        `bson:"email"`
		FirstName string        `bson:"firstName"`
		LastName  string        `bson:"lastName"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := []Contact{}
	for _, g := range rows {
		if g.Email != "" {
			out = append(out, Contact{Email: g.Email, Name: strings.TrimSpace(g.FirstName + " " + g.LastName), UserID: users[g.ID.Hex()]})
		}
	}
	return out, nil
}

// Avatars is findResidentAvatars: one users read for a whole roster.
func Avatars(ctx context.Context, db *mongo.Database, roster []Record) (map[string]*string, error) {
	ids := bson.A{}
	for i := range roster {
		if roster[i].UserID != nil {
			ids = append(ids, *roster[i].UserID)
		}
	}
	out := map[string]*string{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := db.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "image", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID    bson.ObjectID `bson:"_id"`
		Image *string       `bson:"image"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID.Hex()] = r.Image
	}
	return out, nil
}
