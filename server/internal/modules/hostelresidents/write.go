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

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

var liveStatuses = bson.A{"ACTIVE", "PENDING", "SUSPENDED"}

// demote is demoteToPublicAccount.
func (s *Service) demote(ctx context.Context, userID bson.ObjectID) error {
	_, err := s.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: userID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "RESIDENT"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "role", Value: "PUBLIC"}}}})
	return err
}

// releaseAccount is releaseResidentAccount: the hostel leaves the account, and
// an account that lives nowhere else becomes PUBLIC again.
func (s *Service) releaseAccount(ctx context.Context, userID *bson.ObjectID, hostel bson.ObjectID) error {
	if userID == nil {
		return nil
	}
	if _, err := s.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: *userID}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: hostel}}}}); err != nil {
		return err
	}
	err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: liveStatuses}}}, {Key: "userId", Value: *userID}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return s.demote(ctx, *userID)
	}
	return err
}

// releaseGuardians is releaseGuardianAccounts.
func (s *Service) releaseGuardians(ctx context.Context, userIDs []bson.ObjectID, hostel bson.ObjectID) error {
	live := bson.A{"ACTIVE", "USED"}
	access := s.DB.Collection("guardianaccesses")
	for _, uid := range userIDs {
		here, err := access.CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: bson.D{{Key: "$in", Value: live}}}, {Key: "userId", Value: uid}}, options.Count().SetLimit(1))
		if err != nil {
			return err
		}
		if here > 0 {
			continue
		}
		anywhere, err := access.CountDocuments(ctx, bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: live}}}, {Key: "userId", Value: uid}}, options.Count().SetLimit(1))
		if err != nil {
			return err
		}
		upd := bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: hostel}}}}
		if anywhere == 0 {
			upd = append(upd, bson.E{Key: "$set", Value: bson.D{{Key: "role", Value: "PUBLIC"}}})
		}
		if _, err := s.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: uid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "GUARDIAN"}}, upd); err != nil {
			return err
		}
	}
	return nil
}

// Delete is deleteResident.
func (s *Service) Delete(ctx context.Context, id, hostelID string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	by := hostelrooms.UserID(p)
	t := now()
	if _, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "deletedAt", Value: t}, {Key: "deletedBy", Value: by}, {Key: "isDeleted", Value: true}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: t}}}}); err != nil {
		return nil, err
	}
	if r.Status != "MOVED_OUT" {
		if err := s.Cap.Release(ctx, r.HostelID, r.RoomType); err != nil {
			return nil, err
		}
	}
	live := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "USED"}}}}}
	access := s.DB.Collection("guardianaccesses")
	var users []bson.ObjectID
	if err := access.Distinct(ctx, "userId", live).Decode(&users); err != nil {
		return nil, err
	}
	if _, err := access.UpdateMany(ctx, live, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: t}}}, {Key: "$unset", Value: bson.D{{Key: "invitationToken", Value: ""}}}}); err != nil {
		return nil, err
	}
	if err := s.releaseGuardians(ctx, users, r.HostelID); err != nil {
		return nil, err
	}
	if err := s.releaseAccount(ctx, r.UserID, r.HostelID); err != nil {
		return nil, err
	}
	if err := s.auditResident(ctx, p, r.HostelID, r.ID, "RESIDENT_DELETED", bson.D{{Key: "roomType", Value: r.RoomType}, {Key: "status", Value: r.Status}}); err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "residentId", Value: r.ID.Hex()}}, nil
}

// GuardianIn is guardianCreateSchema.
type GuardianIn struct {
	Email, First, Last, Phone, Relation string
	IsPrimary                           bool
}

// AddGuardian is addGuardian.
func (s *Service) AddGuardian(ctx context.Context, id string, in GuardianIn, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, "")
	if err != nil {
		return nil, err
	}
	t := now()
	doc := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID},
		{Key: "firstName", Value: in.First}, {Key: "lastName", Value: in.Last}, {Key: "phone", Value: in.Phone}}
	if in.Email != "" {
		doc = append(doc, bson.E{Key: "email", Value: strings.ToLower(in.Email)})
	}
	doc = append(doc, bson.E{Key: "relation", Value: in.Relation}, bson.E{Key: "isPrimary", Value: in.IsPrimary},
		bson.E{Key: "createdAt", Value: t}, bson.E{Key: "updatedAt", Value: t}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("guardians").InsertOne(ctx, doc); err != nil {
		return nil, err
	}
	s.tellGuardian(ctx, r, in)
	row := bson.M{"_id": doc[0].Value, "hostelId": r.HostelID, "residentId": r.ID, "firstName": in.First, "lastName": in.Last, "phone": in.Phone,
		"relation": in.Relation, "isPrimary": in.IsPrimary, "createdAt": bson.NewDateTimeFromTime(t), "updatedAt": bson.NewDateTimeFromTime(t)}
	if in.Email != "" {
		row["email"] = strings.ToLower(in.Email)
	}
	return ordered.Map{{Key: "guardian", Value: serializeContact(row, guardianFields...)}, {Key: "resident", Value: Serialize(r)}}, nil
}

// tellGuardian is notifyGuardianOfRegistration: never fails the request.
func (s *Service) tellGuardian(ctx context.Context, r *Resident, g GuardianIn) {
	if g.Email == "" || r.Status == "MOVED_OUT" {
		return
	}
	var h struct {
		Name    string `bson:"name"`
		Contact struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
	}
	if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: r.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "contact", Value: 1}, {Key: "name", Value: 1}})).Decode(&h); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		slog.WarnContext(ctx, "guardian_registration_email_failed", "residentId", r.ID.Hex(), "error", err)
		return
	}
	if h.Name == "" {
		h.Name = "the hostel"
	}
	c := email.WardRegistered(strings.TrimSpace(g.First+" "+g.Last), h.Name, h.Contact.Phone, r.MoveInDate, g.Relation, r.name(), r.RoomType)
	if res := s.Mail.Send(ctx, email.Message{Category: c.Category, To: []string{g.Email}, Subject: c.Subject, HTML: c.HTML}); !res.Sent {
		slog.WarnContext(ctx, "guardian_registration_email_failed", "residentId", r.ID.Hex(), "reason", res.Reason)
	}
}

// EmergencyIn is emergencyContactCreateSchema.
type EmergencyIn struct {
	Name, Phone, Relation string
	IsPrimary             bool
}

// AddEmergencyContact is addEmergencyContact.
func (s *Service) AddEmergencyContact(ctx context.Context, id string, in EmergencyIn, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, "")
	if err != nil {
		return nil, err
	}
	t := now()
	_id := bson.NewObjectID()
	if _, err := s.DB.Collection("emergencycontacts").InsertOne(ctx, bson.D{{Key: "_id", Value: _id}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID},
		{Key: "name", Value: in.Name}, {Key: "phone", Value: in.Phone}, {Key: "relation", Value: in.Relation}, {Key: "isPrimary", Value: in.IsPrimary},
		{Key: "createdAt", Value: t}, {Key: "updatedAt", Value: t}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	row := bson.M{"_id": _id, "hostelId": r.HostelID, "residentId": r.ID, "name": in.Name, "phone": in.Phone, "relation": in.Relation, "isPrimary": in.IsPrimary,
		"createdAt": bson.NewDateTimeFromTime(t), "updatedAt": bson.NewDateTimeFromTime(t)}
	return ordered.Map{{Key: "emergencyContact", Value: serializeContact(row, emergencyFields...)}, {Key: "resident", Value: Serialize(r)}}, nil
}

// UpdateIn is residentUpdateSchema: nil means not given.
type UpdateIn struct {
	DepositAmount, MonthlyFee                         *float64
	Email, First, Last, Phone, ResidentType, RoomType *string
	MoveInDate                                        *time.Time
}

func (s *Service) taken(ctx context.Context, filter bson.D) (bool, error) {
	err := s.DB.Collection("residents").FindOne(ctx, filter, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	return err == nil, err
}

// Update is updateResident.
func (s *Service) Update(ctx context.Context, id, hostelID string, in UpdateIn, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	live := bson.E{Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}
	if in.Phone != nil && *in.Phone != r.Phone {
		yes, err := s.taken(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: r.ID}}}, {Key: "hostelId", Value: r.HostelID}, {Key: "isDeleted", Value: false}, {Key: "phone", Value: *in.Phone}, live})
		if err != nil {
			return nil, err
		}
		if yes {
			return nil, rerr("Someone is already registered here with the phone "+*in.Phone+".", "RESIDENT_PHONE_TAKEN", http.StatusConflict)
		}
	}
	nextEmail, emailChanged := "", false
	if in.Email != nil {
		nextEmail = normalizedEmail(*in.Email)
		emailChanged = nextEmail != "" && nextEmail != normalizedEmail(r.Email)
	}
	if emailChanged {
		yes, err := s.taken(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: r.ID}}}, {Key: "email", Value: nextEmail}, {Key: "hostelId", Value: r.HostelID}, {Key: "isDeleted", Value: false}, live})
		if err != nil {
			return nil, err
		}
		if yes {
			return nil, rerr("Someone is already registered here with the email "+nextEmail+".", "RESIDENT_EMAIL_TAKEN", http.StatusConflict)
		}
	}
	typeChanged := in.RoomType != nil && *in.RoomType != r.RoomType
	if typeChanged {
		if err := s.Cap.Move(ctx, r.HostelID, r.RoomType, *in.RoomType); err != nil {
			return nil, err
		}
	}
	by := hostelrooms.UserID(p)
	set := bson.D{}
	add := func(k string, v any) { set = append(set, bson.E{Key: k, Value: v}) }
	if in.DepositAmount != nil {
		add("depositAmount", *in.DepositAmount)
	}
	if in.Email != nil {
		add("email", nextEmail)
	}
	if in.First != nil {
		add("firstName", *in.First)
	}
	if in.Last != nil {
		add("lastName", *in.Last)
	}
	if in.MonthlyFee != nil {
		add("monthlyFee", *in.MonthlyFee)
	}
	if in.MoveInDate != nil {
		add("moveInDate", *in.MoveInDate)
	}
	if in.Phone != nil {
		add("phone", *in.Phone)
	}
	if in.ResidentType != nil {
		add("residentType", *in.ResidentType)
	}
	if in.RoomType != nil {
		add("roomType", *in.RoomType)
	}
	if emailChanged {
		add("accountLinkDeclinedAt", nil)
		add("accountLinkDeclinedBy", nil)
	}
	if typeChanged {
		add("floor", nil)
		add("roomId", nil)
		add("roomNumber", nil)
	}
	add("updatedBy", by)
	add("updatedAt", now())
	var up Resident
	err = s.DB.Collection("residents").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}}, bson.D{{Key: "$set", Value: set}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&up)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errNotFound()
	}
	if err != nil {
		return nil, err
	}
	if err := s.auditResident(ctx, p, r.HostelID, r.ID, "RESIDENT_UPDATED", nil); err != nil {
		return nil, err
	}
	s.roomChanged(ctx, r, &up)
	return ordered.Map{{Key: "resident", Value: Serialize(&up)}}, nil
}

// hostelName is getHostelName.
func (s *Service) hostelName(ctx context.Context, hostel bson.ObjectID) string {
	var h struct {
		Name string `bson:"name"`
	}
	_ = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h)
	if h.Name == "" {
		return "your hostel"
	}
	return h.Name
}

// roomChanged is notifyResidentRoomChanged: a heads-up that never fails the save.
func (s *Service) roomChanged(ctx context.Context, before, after *Resident) {
	if after.UserID == nil || before.RoomType == after.RoomType {
		return
	}
	body := fmt.Sprintf("You have been moved from %s to %s at %s.", hostelrooms.TypeLabel(before.RoomType), hostelrooms.TypeLabel(after.RoomType), s.hostelName(ctx, before.HostelID))
	if _, err := s.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "ACCOUNT",
		Data: ordered.Map{{Key: "previousRoomType", Value: before.RoomType}, {Key: "roomType", Value: after.RoomType}}, HostelID: before.HostelID.Hex(), Priority: "NORMAL",
		Title: "Your room has changed", UserID: after.UserID.Hex()}); err != nil {
		slog.WarnContext(ctx, "resident_room_change_notification_failed", "error", err)
	}
}
