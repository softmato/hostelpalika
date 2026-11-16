package hostelresidents

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
)

// A warden correcting a resident's email is correcting their login: the admission
// form's address is what their account was opened on. Before this, the edit
// changed the row only, so a typo'd login (ram@gmial.com) stayed the one linked
// and the real person could never reach the resident portal.

// accountEmail is the address the resident signs in with, or "" with no account.
func (s *Service) accountEmail(ctx context.Context, userID *bson.ObjectID) (string, error) {
	if userID == nil {
		return "", nil
	}
	u, err := s.userByFilter(ctx, bson.D{{Key: "_id", Value: *userID}, liveUser})
	if err != nil || u == nil {
		return "", err
	}
	return normalizedEmail(u.Email), nil
}

func isLive(status string) bool {
	for _, s := range liveStatuses {
		if s == status {
			return true
		}
	}
	return false
}

// relinkCheck refuses an address whose account is staff, or lives somewhere else.
func (s *Service) relinkCheck(ctx context.Context, r *Resident, addr string) error {
	cur, err := s.DB.Collection("users").Find(ctx, bson.D{{Key: "email", Value: addr}, liveUser}, options.Find().SetProjection(bson.D{{Key: "role", Value: 1}}))
	if err != nil {
		return err
	}
	var rows []accountRow
	if err := cur.All(ctx, &rows); err != nil {
		return err
	}
	ids := []bson.ObjectID{}
	for _, u := range rows {
		if u.Role != "PUBLIC" && u.Role != "RESIDENT" {
			return rerr("That email is a staff login. Use a different address.", "RESIDENT_EMAIL_STAFF", http.StatusConflict)
		}
		if r.UserID == nil || u.ID != *r.UserID {
			ids = append(ids, u.ID)
		}
	}
	live, err := s.FindLiveResidency(ctx, []string{addr}, ids, r.HostelID)
	if err != nil {
		return err
	}
	if live != nil && live.ResidentID != r.ID.Hex() {
		code := "RESIDENT_LIVES_ELSEWHERE"
		if live.SameHostel {
			code = "RESIDENT_ALREADY_HERE"
		}
		return rerr(liveResidencyMessage(r.name(), live), code, http.StatusConflict)
	}
	return nil
}

// relink moves the login to the row's new email: the old account leaves this
// hostel (PUBLIC again when it lives nowhere else), the new one is opened if
// needed, linked, and sent the "you can sign in" mail. Never fails the edit.
func (s *Service) relink(ctx context.Context, r *Resident, p *authz.Principal, from string) {
	old := r.UserID
	if old != nil {
		_, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "userId", Value: *old}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now()}}}, {Key: "$unset", Value: bson.D{{Key: "userId", Value: ""}}}})
		if err != nil {
			slog.ErrorContext(ctx, "resident_relink_unlink_failed", "resident", r.ID.Hex(), "error", err)
			return
		}
		nonFatal(ctx, s.releaseAccount(ctx, old, r.HostelID))
		r.UserID = nil
	}
	acct, err := s.OpenLogin(ctx, r.Email, r.name())
	if err != nil {
		slog.ErrorContext(ctx, "resident_relink_open_failed", "resident", r.ID.Hex(), "error", err)
		return
	}
	link := s.LinkAccount(ctx, r, p, "", true, &acct)
	nonFatal(ctx, s.auditResident(ctx, p, r.HostelID, r.ID, "RESIDENT_ACCOUNT_RELINKED",
		bson.D{{Key: "from", Value: from}, {Key: "linked", Value: link.Linked}, {Key: "reason", Value: link.Reason}, {Key: "to", Value: r.Email}}))
}

// reload is the row after relink touched it.
func (s *Service) reload(ctx context.Context, id bson.ObjectID) (*Resident, error) {
	var r Resident
	err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errNotFound()
	}
	return &r, err
}
