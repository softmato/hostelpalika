// Package residents: so far only the sign-in hook (desk-intake-link.ts) and the
// promotion it calls (users/resident-promotion.service.ts). The module proper
// lands in Phase 6.
package residents

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

var unlinked = bson.A{bson.D{{Key: "userId", Value: nil}}, bson.D{{Key: "userId", Value: bson.D{{Key: "$exists", Value: false}}}}}

// LinkDeskIntakeOnSignIn: the first sign-in of a verified, active PUBLIC
// address a hostel typed at the desk links that resident row and opens the
// resident portal. Never fails a sign-in; answers whether it linked.
func LinkDeskIntakeOnSignIn(ctx context.Context, db *mongo.Database, log *audit.Log, userID bson.ObjectID, now time.Time) bool {
	linked, err := linkDeskIntake(ctx, db, log, userID, now)
	if err != nil {
		return false
	}
	return linked
}

func linkDeskIntake(ctx context.Context, db *mongo.Database, log *audit.Log, userID bson.ObjectID, now time.Time) (bool, error) {
	var user struct {
		Email           string     `bson:"email"`
		EmailVerified   bool       `bson:"emailVerified"`
		EmailVerifiedAt *time.Time `bson:"emailVerifiedAt"`
		Role            string     `bson:"role"`
		Status          string     `bson:"status"`
	}
	if err := db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: userID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "emailVerified", Value: 1}, {Key: "emailVerifiedAt", Value: 1}, {Key: "role", Value: 1}, {Key: "status", Value: 1}})).Decode(&user); err != nil {
		return false, err
	}
	email := strings.ToLower(strings.TrimSpace(user.Email))
	if email == "" || !(user.EmailVerified || user.EmailVerifiedAt != nil) || user.Role != "PUBLIC" || user.Status != "ACTIVE" {
		return false, nil
	}
	residents := db.Collection("residents")
	var resident struct {
		ID        bson.ObjectID `bson:"_id"`
		FirstName string        `bson:"firstName"`
		LastName  string        `bson:"lastName"`
		HostelID  bson.ObjectID `bson:"hostelId"`
		Phone     string        `bson:"phone"`
	}
	err := residents.FindOne(ctx, bson.D{
		{Key: "$or", Value: unlinked},
		{Key: "accountLinkDeclinedAt", Value: nil},
		{Key: "deskIntake", Value: true},
		{Key: "email", Value: email},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}},
	}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}}).
		SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "hostelId", Value: 1}, {Key: "phone", Value: 1}})).Decode(&resident)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// One live residency per account.
	err = residents.FindOne(ctx, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: userID}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return false, err
	}
	res, err := residents.UpdateOne(ctx, bson.D{{Key: "_id", Value: resident.ID}, {Key: "$or", Value: unlinked}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "userId", Value: userID}, {Key: "updatedAt", Value: now}}}})
	if err != nil || res.ModifiedCount == 0 {
		return false, err
	}
	if _, err := PromoteAccountToResident(ctx, db, log, Promotion{
		HostelID: resident.HostelID, Name: strings.TrimSpace(resident.FirstName + " " + resident.LastName),
		PerformedBy: userID, Phone: resident.Phone, UserID: userID,
	}, now); err != nil {
		_, _ = residents.UpdateOne(ctx, bson.D{{Key: "_id", Value: resident.ID}, {Key: "userId", Value: userID}},
			bson.D{{Key: "$unset", Value: bson.D{{Key: "userId", Value: ""}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}})
		return false, nil
	}
	_ = log.Write(ctx, audit.Entry{
		ActorID: userID, HostelID: resident.HostelID, Action: "RESIDENT_ACCOUNT_LINKED", EntityType: "Resident", EntityID: resident.ID.Hex(),
		Metadata: bson.D{{Key: "email", Value: email}, {Key: "via", Value: "DESK_INTAKE_SIGN_IN"}},
	})
	return true, nil
}

// Promotion is promoteAccountToResident's input. PerformedBy zero = no audit row.
type Promotion struct {
	HostelID    bson.ObjectID
	Name        string
	PerformedBy bson.ObjectID
	Phone       string
	UserID      bson.ObjectID
}

// Intake may not overwrite these roles.
var protectedRoles = map[string]bool{"HOSTEL_ADMIN": true, "SUPERADMIN": true}

// PromoteAccountToResident makes one account a RESIDENT, standing down what
// contradicted it. It reports whether the role changed.
func PromoteAccountToResident(ctx context.Context, db *mongo.Database, log *audit.Log, in Promotion, now time.Time) (bool, error) {
	var user struct {
		ID        bson.ObjectID   `bson:"_id"`
		Email     string          `bson:"email"`
		HostelIDs []bson.ObjectID `bson:"hostelIds"`
		Name      string          `bson:"name"`
		Phone     string          `bson:"phone"`
		Role      string          `bson:"role"`
		Status    string          `bson:"status"`
	}
	err := db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: in.UserID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&user)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, httpx.NewError(404, "USER_NOT_FOUND", "That account no longer exists.", nil)
	}
	if err != nil {
		return false, err
	}
	previousRole := user.Role
	if previousRole == "" {
		previousRole = "PUBLIC"
	}
	if protectedRoles[previousRole] {
		return false, httpx.NewError(409, "ROLE_TOO_PRIVILEGED", "This email belongs to an administrator account, which an intake may not change.", nil)
	}
	alreadyHere := false
	for _, h := range user.HostelIDs {
		alreadyHere = alreadyHere || h == in.HostelID
	}
	activatedInvite := user.Status == "INVITED"
	var clearedRole any
	if previousRole != "PUBLIC" && previousRole != "RESIDENT" {
		clearedRole = previousRole
	}
	set := bson.D{{Key: "role", Value: "RESIDENT"}}
	if activatedInvite {
		set = append(set, bson.E{Key: "mustChangePassword", Value: false}, bson.E{Key: "status", Value: "ACTIVE"})
	}
	if n := strings.TrimSpace(in.Name); n != "" && user.Name == "" {
		set = append(set, bson.E{Key: "name", Value: n})
	}
	if p := strings.TrimSpace(in.Phone); p != "" && user.Phone == "" {
		set = append(set, bson.E{Key: "phone", Value: p})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	update := bson.D{{Key: "$set", Value: set}}
	if !alreadyHere {
		update = append(update, bson.E{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: in.HostelID}}})
	}
	if _, err := db.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: user.ID}}, update); err != nil {
		return false, err
	}
	cleared := standDownMemberships(ctx, db, user.ID, now)

	if !in.PerformedBy.IsZero() {
		var email any // undefined when the account has none
		if user.Email != "" {
			email = user.Email
		}
		if err := log.Write(ctx, audit.Entry{
			ActorID: in.PerformedBy, HostelID: in.HostelID, Action: "USER_ROLE_UPGRADED", EntityType: "User", EntityID: user.ID.Hex(),
			Metadata: bson.D{
				{Key: "clearedMemberships", Value: cleared},
				{Key: "clearedRole", Value: nullable(clearedRole)},
				{Key: "email", Value: email},
				{Key: "previousRole", Value: previousRole},
				{Key: "reactivatedInvite", Value: activatedInvite},
				{Key: "role", Value: "RESIDENT"},
			},
		}); err != nil {
			slog.ErrorContext(ctx, "Could not audit a resident promotion; the promotion stands.", "error", err, "userId", user.ID.Hex())
		}
	}
	return previousRole != "RESIDENT", nil
}

// nullable keeps a null in metadata (audit.Write drops nil values, as
// mongoose drops undefined — but null is stored).
func nullable(v any) any {
	if v == nil {
		return bson.Null{}
	}
	return v
}

// standDownMemberships removes every staff membership; never fatal. Returns
// how many were stood down.
func standDownMemberships(ctx context.Context, db *mongo.Database, userID bson.ObjectID, now time.Time) int {
	members := db.Collection("hostelmembers")
	cur, err := members.Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "REMOVED"}}}, {Key: "userId", Value: userID}})
	if err != nil {
		slog.ErrorContext(ctx, "Could not stand down memberships during resident promotion.", "error", err, "userId", userID.Hex())
		return 0
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Role string        `bson:"role"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		slog.ErrorContext(ctx, "Could not stand down memberships during resident promotion.", "error", err, "userId", userID.Hex())
		return 0
	}
	staff := bson.A{}
	for _, r := range rows {
		if r.Role != "RESIDENT" {
			staff = append(staff, r.ID)
		}
	}
	if len(staff) == 0 {
		return 0
	}
	if _, err := members.UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: staff}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}, {Key: "status", Value: "REMOVED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		slog.ErrorContext(ctx, "Could not stand down memberships during resident promotion.", "error", err, "userId", userID.Hex())
		return 0
	}
	return len(staff)
}
