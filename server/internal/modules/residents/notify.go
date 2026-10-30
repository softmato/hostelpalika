package residents

import (
	"context"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Contact is resident-notify.ts' Contact.
type Contact struct {
	Email, Name, UserID string
}

// AppURL is appUrl: a path on the outbound site.
func AppURL(outbound, path string) string {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return outbound + path
}

// memberUserIDs is the owner plus the active members with one of these roles.
func memberUserIDs(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID, roles bson.A) ([]bson.ObjectID, error) {
	var hostel struct {
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	err := db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}},
		options.FindOne().SetProjection(bson.D{{Key: "ownerId", Value: 1}})).Decode(&hostel)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	var ids []bson.ObjectID
	if hostel.OwnerID != nil {
		ids = append(ids, *hostel.OwnerID)
	}
	cur, err := db.Collection("hostelmembers").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: bson.D{{Key: "$in", Value: roles}}}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return nil, err
	}
	var members []struct {
		UserID bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &members); err != nil {
		return nil, err
	}
	for _, m := range members {
		ids = append(ids, m.UserID)
	}
	return ids, nil
}

type userRow struct {
	ID    bson.ObjectID `bson:"_id"`
	Email string        `bson:"email"`
	Name  *string       `bson:"name"`
}

func liveUsers(ctx context.Context, db *mongo.Database, ids []bson.ObjectID) ([]userRow, error) {
	cur, err := db.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}})
	if err != nil {
		return nil, err
	}
	var users []userRow
	return users, cur.All(ctx, &users)
}

// HostelStaffUserIDs is resolveHostelStaffUserIds: every staff member who
// should be *told* something, as user ids — owner, hostel admins and (unless
// adminsOnly) wardens, checked against live users.
func HostelStaffUserIDs(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID, adminsOnly bool) ([]string, error) {
	roles := bson.A{"HOSTEL_ADMIN", "WARDEN"}
	if adminsOnly {
		roles = bson.A{"HOSTEL_ADMIN"}
	}
	ids, err := memberUserIDs(ctx, db, hostelID, roles)
	if err != nil || len(ids) == 0 {
		return []string{}, err
	}
	users, err := liveUsers(ctx, db, ids)
	if err != nil {
		return nil, err
	}
	out, seen := []string{}, map[string]bool{}
	for _, u := range users {
		if h := u.ID.Hex(); !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out, nil
}

// HostelAdminContacts is resolveHostelAdminContacts: the owner and hostel-admin
// members who have an address to mail, de-duplicated by user id.
func HostelAdminContacts(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID) ([]Contact, error) {
	ids, err := memberUserIDs(ctx, db, hostelID, bson.A{"HOSTEL_ADMIN"})
	if err != nil || len(ids) == 0 {
		return []Contact{}, err
	}
	users, err := liveUsers(ctx, db, ids)
	if err != nil {
		return nil, err
	}
	out, seen := []Contact{}, map[string]bool{}
	for _, u := range users {
		if u.Email == "" || seen[u.ID.Hex()] {
			continue
		}
		seen[u.ID.Hex()] = true
		name := "Hostel admin"
		if u.Name != nil {
			name = *u.Name
		}
		out = append(out, Contact{Email: u.Email, Name: name, UserID: u.ID.Hex()})
	}
	return out, nil
}
