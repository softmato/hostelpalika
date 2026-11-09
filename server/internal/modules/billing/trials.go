package billing

import (
	"context"
	"net/url"
	"slices"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// trialReminderMark: the reminders go three days out and on the last day.
func trialReminderMark(daysLeft int) (int, bool) {
	switch {
	case daysLeft <= 0:
		return 0, true
	case daysLeft <= 3:
		return 3, true
	}
	return 0, false
}

// TrialEndingReminders is sendTrialEndingReminders (inside the payment-reminders
// job): a hostel on a trial with no plan hears three days out and on its last
// day, by email and in the bell. The $push claim keeps each mark once.
func (s *Service) TrialEndingReminders(ctx context.Context, n *notifications.Service, now time.Time) (ordered.Map, error) {
	cur, err := s.DB.Collection("hostelsubscriptions").Find(ctx, bson.D{{Key: "lifetimeSince", Value: nil}, {Key: "planId", Value: nil},
		{Key: "trialEndsAt", Value: bson.D{{Key: "$gte", Value: now}, {Key: "$lte", Value: bs.DayEnd(now, 3)}}}},
		options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "trialEndsAt", Value: 1}, {Key: "trialReminded", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var trials []struct {
		ID            bson.ObjectID `bson:"_id"`
		HostelID      bson.ObjectID `bson:"hostelId"`
		TrialEndsAt   time.Time     `bson:"trialEndsAt"`
		TrialReminded []int         `bson:"trialReminded"`
	}
	if err := cur.All(ctx, &trials); err != nil {
		return nil, err
	}
	sent := 0
	for _, t := range trials {
		daysLeft := bs.DaysBetween(now, t.TrialEndsAt)
		mark, ok := trialReminderMark(daysLeft)
		if !ok || slices.Contains(t.TrialReminded, mark) {
			continue
		}
		var h struct {
			IsDeleted bool `bson:"isDeleted"`
			KYC       *struct {
				Required bool    `bson:"required"`
				Status   *string `bson:"status"`
			} `bson:"kyc"`
			Name    string         `bson:"name"`
			OwnerID *bson.ObjectID `bson:"ownerId"`
			Slug    string         `bson:"slug"`
		}
		if err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: t.HostelID}}).Decode(&h); err != nil || h.IsDeleted || h.OwnerID == nil {
			continue
		}
		kycPending := h.KYC != nil && h.KYC.Required && (h.KYC.Status == nil || *h.KYC.Status != "APPROVED")
		res, err := s.DB.Collection("hostelsubscriptions").UpdateOne(ctx, bson.D{{Key: "_id", Value: t.ID}, {Key: "trialReminded", Value: bson.D{{Key: "$ne", Value: mark}}}},
			bson.D{{Key: "$push", Value: bson.D{{Key: "trialReminded", Value: mark}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: nowMS()}}}})
		if err != nil {
			return nil, err
		}
		if res.ModifiedCount == 0 {
			continue
		}
		var owner struct {
			Email string `bson:"email"`
			Name  string `bson:"name"`
		}
		_ = s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *h.OwnerID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}})).Decode(&owner)
		if owner.Email != "" && s.Mail != nil {
			slug := url.PathEscape(h.Slug)
			name := h.Name
			if name == "" {
				name = "Your hostel"
			}
			m := email.HostelTrialEnding(s.PlanPayLink(ctx, t.HostelID, s.SiteURL+"/"+slug+"/admin/billing"), daysLeft, name, kycPending, s.SiteURL+"/"+slug+"/admin/kyc",
				owner.Name, s.supportPhone(ctx), email.EmailDate(t.TrialEndsAt))
			s.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{owner.Email}, Subject: m.Subject, HTML: m.HTML})
		}
		action, body, kind := "/hostel-admin/billing", "After the trial your hostel moves to the Free plan. Get a monthly or lifetime plan to keep every seat.", "HOSTEL_TRIAL"
		if kycPending {
			action, body, kind = "/hostel-admin/kyc", "Complete your KYC to keep your hostel portal open after the trial.", "HOSTEL_KYC"
		}
		title := "Your free trial ends today"
		if daysLeft > 0 {
			unit := "days"
			if daysLeft == 1 {
				unit = "day"
			}
			title = "Your free trial ends in " + strconv.Itoa(daysLeft) + " " + unit
		}
		if n != nil {
			_, _ = n.CreateInApp(ctx, notifications.Input{ActionURL: action, Body: body, Category: "GENERAL", Data: ordered.Map{{Key: "hostelId", Value: t.HostelID.Hex()}, {Key: "type", Value: kind}},
				HostelID: t.HostelID.Hex(), Priority: "HIGH", Title: title, UserID: h.OwnerID.Hex()})
		}
		sent++
	}
	return ordered.Map{{Key: "sent", Value: sent}}, nil
}

func (s *Service) supportPhone(ctx context.Context) string {
	if s.Config == nil {
		return ""
	}
	v, err := s.Config.Section(ctx, "identity")
	var id struct {
		SupportPhone string `json:"supportPhone"`
	}
	if err != nil || platformconfig.Decode(v, &id) != nil {
		return ""
	}
	return id.SupportPhone
}
