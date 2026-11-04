package residentportal

import (
	"context"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// SendLeavingReminders is sendLeavingReminders: the day before and on the day,
// the resident and staff are told; after it, staff keep being told until
// someone moves the resident out. Rides payment-reminders.
func (h *Handler) SendLeavingReminders(ctx context.Context, now time.Time) (ordered.Map, error) {
	today := bs.Today(now)
	tomorrow := today.Add(24 * time.Hour)
	cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "leavingOn", Value: bson.D{{Key: "$lte", Value: tomorrow}}}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "hostelId", Value: 1}, {Key: "lastName", Value: 1}, {Key: "leavingOn", Value: 1}, {Key: "userId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []noticeResident
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	sent := 0
	for i := range rows {
		r := &rows[i]
		on := *r.LeavingOn
		when := "today"
		if on.Equal(tomorrow) {
			when = "tomorrow"
		}
		overdue := on.Before(today)
		name := strings.TrimSpace(r.FirstName + " " + r.LastName)
		if r.UserID != nil && !overdue {
			title := "Moving out tomorrow"
			if when == "today" {
				title = "Moving out today"
			}
			_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/dashboard", Body: "You are moving out " + when + ". Settle anything still owed with the hostel.",
				Category: "ACCOUNT", Data: ordered.Map{{Key: "type", Value: "RESIDENT_LEAVING"}}, HostelID: r.HostelID.Hex(), Title: title, UserID: r.UserID.Hex()})
		}
		title, body := name+" leaves "+when, "Open Move out on their page to finish."
		if when == "today" {
			body = "Open Move out on Home to finish."
		}
		if overdue {
			title, body = name+" has not been moved out", "They left on "+bs.FormatDate(on)+". Open Move out to finish."
		}
		h.tellStaff(ctx, r, title, body)
		sent++
	}
	return ordered.Map{{Key: "leavingReminders", Value: sent}}, nil
}
