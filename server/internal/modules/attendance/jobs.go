package attendance

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Jobs is the attendance-maintenance job's dependencies.
type Jobs struct {
	DB     *mongo.Database
	Mail   *email.Sender
	Notify *notifications.Service
	AppURL func(path string) string
}

// absenceStreak counts days back from today with no inside/nearby sighting,
// stopping at the day the resident started being watched.
func absenceStreak(zoneByDay map[string]string, today time.Time, maxDays int, watchedFrom time.Time) int {
	streak := 0
	for offset := 0; offset < maxDays; offset++ {
		day := today.AddDate(0, 0, -offset)
		if day.Before(watchedFrom) {
			break
		}
		if z, ok := zoneByDay[day.Format("2006-01-02")]; ok && z != "OUTSIDE" && z != "UNKNOWN" {
			break
		}
		streak++
	}
	return streak
}

// Maintenance is runAttendanceMaintenance: absence alerts raised, refreshed or
// resolved per hostel with the geofence on, then logs past retention purged.
func (j *Jobs) Maintenance(ctx context.Context, now time.Time) (ordered.Map, error) {
	now = now.UTC().Truncate(time.Millisecond)
	today := bs.CalendarDay(now)
	cur, err := j.DB.Collection("hostelsettings").Find(ctx, bson.D{{Key: "attendance.enabled", Value: true}})
	if err != nil {
		return nil, err
	}
	type setting struct {
		HostelID   bson.ObjectID `bson:"hostelId"`
		Attendance settingsDoc   `bson:"attendance"`
	}
	var settings []setting
	for cur.Next(ctx) {
		row := setting{Attendance: defaults()}
		if err := cur.Decode(&row); err != nil {
			return nil, err
		}
		settings = append(settings, row)
	}
	if err := cur.Err(); err != nil {
		return nil, err
	}
	raised, updated := 0, 0
	var purged int64
	for _, s := range settings {
		r, u, p, err := j.hostel(ctx, s.HostelID, s.Attendance, today, now)
		raised, updated, purged = raised+r, updated+u, purged+p
		if err != nil {
			slog.WarnContext(ctx, "attendance_maintenance_failed", "hostelId", s.HostelID.Hex(), "message", err.Error())
		}
	}
	return ordered.Map{{Key: "alertsRaised", Value: raised}, {Key: "alertsUpdated", Value: updated}, {Key: "hostelsProcessed", Value: len(settings)}, {Key: "logsPurged", Value: purged}}, nil
}

type watched struct {
	ID         bson.ObjectID `bson:"_id"`
	CreatedAt  time.Time     `bson:"createdAt"`
	FirstName  string        `bson:"firstName"`
	LastName   string        `bson:"lastName"`
	MoveInDate *time.Time    `bson:"moveInDate"`
}

func (j *Jobs) hostel(ctx context.Context, hostelID bson.ObjectID, cfg settingsDoc, today, now time.Time) (raised, updated int, purged int64, err error) {
	cur, err := j.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}})
	if err != nil {
		return 0, 0, 0, err
	}
	var list []watched
	if err := cur.All(ctx, &list); err != nil {
		return 0, 0, 0, err
	}
	// TS skipped the hostel here when nobody was ACTIVE, and with it the
	// retention purge below: P9-1.
	if len(list) > 0 {
		r, u, err := j.alerts(ctx, hostelID, cfg, list, today, now)
		raised, updated = r, u
		if err != nil {
			return raised, updated, 0, err
		}
	}
	res, err := j.DB.Collection("attendancelogs").DeleteMany(ctx, bson.D{{Key: "day", Value: bson.D{{Key: "$lt", Value: today.AddDate(0, 0, -cfg.RetentionDays)}}}, {Key: "hostelId", Value: hostelID}})
	if err != nil {
		return raised, updated, 0, err
	}
	return raised, updated, res.DeletedCount, nil
}

func (j *Jobs) alerts(ctx context.Context, hostelID bson.ObjectID, cfg settingsDoc, list []watched, today, now time.Time) (raised, updated int, err error) {
	cur, err := j.DB.Collection("attendancelogs").Find(ctx, bson.D{{Key: "day", Value: bson.D{{Key: "$gte", Value: today.AddDate(0, 0, -cfg.AbsenceAlertDays)}}}, {Key: "hostelId", Value: hostelID}})
	if err != nil {
		return 0, 0, err
	}
	var logs []struct {
		Day        time.Time     `bson:"day"`
		ResidentID bson.ObjectID `bson:"residentId"`
		Zone       string        `bson:"zone"`
	}
	if err := cur.All(ctx, &logs); err != nil {
		return 0, 0, err
	}
	byResident := map[bson.ObjectID]map[string]string{}
	for _, l := range logs {
		if byResident[l.ResidentID] == nil {
			byResident[l.ResidentID] = map[string]string{}
		}
		byResident[l.ResidentID][l.Day.UTC().Format("2006-01-02")] = l.Zone
	}
	alerts := j.DB.Collection("attendancealerts")
	var breached []email.AwayResident
	for _, r := range list {
		from := r.CreatedAt
		if r.MoveInDate != nil && r.MoveInDate.After(from) {
			from = *r.MoveInDate
		}
		if cfg.EnabledAt != nil && cfg.EnabledAt.After(from) {
			from = *cfg.EnabledAt
		}
		streak := absenceStreak(byResident[r.ID], today, cfg.AbsenceAlertDays, bs.CalendarDay(from))
		open := bson.D{{Key: "residentId", Value: r.ID}, {Key: "status", Value: "OPEN"}}
		if streak < cfg.AbsenceAlertDays {
			if _, err := alerts.UpdateOne(ctx, open, bson.D{{Key: "$set", Value: bson.D{{Key: "resolutionNote", Value: "Resident was seen again."},
				{Key: "resolvedAt", Value: now}, {Key: "status", Value: "RESOLVED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
				return raised, updated, err
			}
			continue
		}
		res, err := alerts.UpdateOne(ctx, open, bson.D{{Key: "$set", Value: bson.D{{Key: "consecutiveDays", Value: streak}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			return raised, updated, err
		}
		if res.MatchedCount > 0 {
			updated++
			continue
		}
		if _, err := alerts.InsertOne(ctx, bson.D{{Key: "_id", Value: bson.NewObjectIDFromTimestamp(now)}, {Key: "hostelId", Value: hostelID}, {Key: "residentId", Value: r.ID},
			{Key: "consecutiveDays", Value: streak}, {Key: "status", Value: "OPEN"}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
			return raised, updated, err
		}
		raised++
		breached = append(breached, email.AwayResident{Days: streak, Name: strings.TrimSpace(r.FirstName + " " + r.LastName)})
	}
	if len(breached) > 0 {
		j.tell(ctx, hostelID, breached)
	}
	return raised, updated, nil
}

func (j *Jobs) tell(ctx context.Context, hostelID bson.ObjectID, breached []email.AwayResident) {
	name, err := residents.HostelName(ctx, j.DB, hostelID)
	if err != nil {
		slog.WarnContext(ctx, "attendance_alert_failed", "hostelId", hostelID.Hex(), "message", err.Error())
		return
	}
	admins, err := residents.HostelAdminContacts(ctx, j.DB, hostelID)
	if err != nil {
		slog.WarnContext(ctx, "attendance_alert_failed", "hostelId", hostelID.Hex(), "message", err.Error())
		return
	}
	content := email.AttendanceAlert(j.AppURL("/hostel-admin/attendance"), name, breached)
	verb := "s have"
	if len(breached) == 1 {
		verb = " has"
	}
	body := strconv.Itoa(len(breached)) + " resident" + verb + " been away past the alert threshold."
	var sends []func()
	for _, a := range admins {
		sends = append(sends, func() {
			j.Mail.Notify(ctx, email.Notification{Action: "attendance_alert", HTML: content.HTML, Subject: content.Subject, To: a.Email, Category: content.Category, Topic: "ATTENDANCE_ALERTS"})
		})
		if a.UserID != "" {
			sends = append(sends, func() {
				_, _ = j.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "ATTENDANCE", Data: ordered.Map{{Key: "count", Value: len(breached)}},
					HostelID: hostelID.Hex(), Title: "Attendance alert", UserID: a.UserID})
			})
		}
	}
	background.Parallel(ctx, sends...)
}
