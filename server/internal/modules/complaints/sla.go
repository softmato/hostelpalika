package complaints

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// RunSLA is runComplaintSlaCheck (the complaint-sla job): open complaints past
// their deadline are flagged once, then each hostel's admins get one email and
// one bell row. Flagged first, so an alert is never sent twice.
func (s *Service) RunSLA(ctx context.Context, now time.Time) (ordered.Map, error) {
	now = now.UTC().Truncate(time.Millisecond)
	cur, err := s.DB.Collection("complaints").Find(ctx, bson.D{
		{Key: "slaBreachedAt", Value: bson.D{{Key: "$exists", Value: false}}},
		{Key: "slaDueAt", Value: bson.D{{Key: "$lt", Value: now}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "IN_PROGRESS"}}}},
	}, options.Find().SetSort(bson.D{{Key: "slaDueAt", Value: 1}}).SetLimit(500).
		SetProjection(bson.D{{Key: "category", Value: 1}, {Key: "hostelId", Value: 1}, {Key: "slaDueAt", Value: 1}, {Key: "title", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var overdue []struct {
		ID       bson.ObjectID `bson:"_id"`
		Category string        `bson:"category"`
		HostelID bson.ObjectID `bson:"hostelId"`
		SLADueAt time.Time     `bson:"slaDueAt"`
		Title    string        `bson:"title"`
	}
	if err := cur.All(ctx, &overdue); err != nil {
		return nil, err
	}
	if len(overdue) == 0 {
		return ordered.Map{{Key: "flagged", Value: 0}, {Key: "hostelsNotified", Value: 0}, {Key: "scanned", Value: 0}}, nil
	}
	ids := make(bson.A, len(overdue))
	for i, c := range overdue {
		ids[i] = c.ID
	}
	if _, err := s.DB.Collection("complaints").UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "slaBreachedAt", Value: now}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return nil, err
	}
	var order []bson.ObjectID
	byHostel := map[bson.ObjectID][]email.OverdueComplaint{}
	for _, c := range overdue {
		if _, ok := byHostel[c.HostelID]; !ok {
			order = append(order, c.HostelID)
		}
		byHostel[c.HostelID] = append(byHostel[c.HostelID], email.OverdueComplaint{HoursLate: max(int(now.Sub(c.SLADueAt)/time.Hour), 0), Title: c.Title, Type: c.Category})
	}
	notified := 0
	for _, hostelID := range order {
		list := byHostel[hostelID]
		name, err := residents.HostelName(ctx, s.DB, hostelID)
		if err != nil {
			slog.WarnContext(ctx, "complaint_sla_notify_failed", "hostelId", hostelID.Hex(), "message", err.Error())
			continue
		}
		admins, err := residents.HostelAdminContacts(ctx, s.DB, hostelID)
		if err != nil {
			slog.WarnContext(ctx, "complaint_sla_notify_failed", "hostelId", hostelID.Hex(), "message", err.Error())
			continue
		}
		if len(admins) == 0 {
			continue
		}
		content := email.OverdueComplaints(list, s.AppURL("/hostel-admin/complaints"), name)
		plural := "s"
		if len(list) == 1 {
			plural = ""
		}
		body := strconv.Itoa(len(list)) + " complaint" + plural + " passed the response deadline."
		var sends []func()
		for _, a := range admins {
			sends = append(sends, func() {
				s.Mail.Notify(ctx, email.Notification{Action: "complaint_sla_breached", HTML: content.HTML, Subject: content.Subject, To: a.Email, Category: content.Category, Topic: "COMPLAINT_ALERTS"})
			})
			if a.UserID != "" {
				sends = append(sends, func() {
					_, _ = s.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "COMPLAINT", Data: ordered.Map{{Key: "overdueCount", Value: len(list)}},
						HostelID: hostelID.Hex(), Title: "Complaints past SLA", UserID: a.UserID})
				})
			}
		}
		background.Parallel(ctx, sends...)
		notified++
	}
	return ordered.Map{{Key: "flagged", Value: len(overdue)}, {Key: "hostelsNotified", Value: notified}, {Key: "scanned", Value: len(overdue)}}, nil
}
