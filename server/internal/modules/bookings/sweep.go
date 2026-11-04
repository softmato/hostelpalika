package bookings

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const sweepBatch = 100

type sentReminder struct {
	At        time.Time `bson:"at"`
	HoursLeft float64   `bson:"hoursLeft"`
}

type sweepRow struct {
	Booking             `bson:",inline"`
	HostelRemindersSent []sentReminder `bson:"hostelRemindersSent"`
	MoveInRemindersSent []sentReminder `bson:"moveInRemindersSent"`
}

// dueReminder is the smallest threshold the deadline has crossed that has not
// been sent yet, or -1.
func dueReminder(deadline, now time.Time, thresholds []float64, sent []sentReminder) float64 {
	hoursLeft := float64(deadline.Sub(now)) / float64(time.Hour)
	if hoursLeft <= 0 {
		return -1
	}
	smallest := -1.0
	for _, t := range thresholds {
		if hoursLeft <= t && (smallest < 0 || t < smallest) {
			smallest = t
		}
	}
	if smallest < 0 {
		return -1
	}
	for _, r := range sent {
		if r.HoursLeft <= smallest {
			return -1
		}
	}
	return smallest
}

func (s *Signed) endEach(ctx context.Context, filter bson.D, deadline string, end func(*Booking) (bool, error)) (int, error) {
	cur, err := s.db.Collection("bookings").Find(ctx, filter, options.Find().SetSort(bson.D{{Key: deadline, Value: 1}}).SetLimit(sweepBatch))
	if err != nil {
		return 0, err
	}
	var due []Booking
	if err := cur.All(ctx, &due); err != nil {
		return 0, err
	}
	ended := 0
	for i := range due {
		ok, err := end(&due[i])
		if err != nil {
			slog.ErrorContext(ctx, "Booking sweep could not end a booking.", "bookingId", due[i].ID.Hex(), "error", err.Error())
			continue
		}
		if ok {
			ended++
		}
	}
	return ended, nil
}

func (s *Signed) remindEach(ctx context.Context, deadline, sentField, status string, thresholds []float64, now time.Time, send func(*Booking, float64)) (int, error) {
	if len(thresholds) == 0 {
		return 0, nil
	}
	horizon := now.Add(time.Duration(slices.Max(thresholds) * float64(time.Hour)))
	cur, err := s.db.Collection("bookings").Find(ctx, bson.D{{Key: deadline, Value: bson.D{{Key: "$gt", Value: now}, {Key: "$lte", Value: horizon}}}, {Key: "status", Value: status}},
		options.Find().SetSort(bson.D{{Key: deadline, Value: 1}}).SetLimit(sweepBatch*5))
	if err != nil {
		return 0, err
	}
	var rows []sweepRow
	if err := cur.All(ctx, &rows); err != nil {
		return 0, err
	}
	sent := 0
	for _, r := range rows {
		at, list := r.HostelAnswerBy, r.HostelRemindersSent
		if deadline == "holdEndsAt" {
			at, list = r.HoldEndsAt, r.MoveInRemindersSent
		}
		if at == nil {
			continue
		}
		hours := dueReminder(*at, now, thresholds, list)
		if hours < 0 {
			continue
		}
		var claimed Booking
		err := s.db.Collection("bookings").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: status}, {Key: sentField + ".hoursLeft", Value: bson.D{{Key: "$nin", Value: bson.A{hours}}}}},
			bson.D{{Key: "$push", Value: bson.D{{Key: sentField, Value: bson.D{{Key: "at", Value: now}, {Key: "hoursLeft", Value: hours}}}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}}},
			options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&claimed)
		if err == mongo.ErrNoDocuments {
			continue
		}
		if err != nil {
			return sent, err
		}
		send(&claimed, hours)
		sent++
	}
	return sent, nil
}

func (s *Signed) remindHostel(ctx context.Context, b *Booking, hoursLeft float64) {
	answerBy := ""
	if b.HostelAnswerBy != nil {
		answerBy = whenText(*b.HostelAnswerBy)
	}
	share := settleBooking(time.Now(), b.ConfirmedAt, "CHECKED_IN", b.Fee, b.Stay, b.Terms).HostelShare
	s.notifyHostel(ctx, b, "booking_answer_reminder", b.Guest.Name+"'s "+email.RoomTypeLabel(b.RoomType)+" booking ("+b.Code+") needs your answer by "+answerBy+".",
		func(name string) email.Content {
			return email.BookingAnswerReminder(answerBy, s.appURL(hostelPath(b)), b.Code, b.Guest.Name, b.Guest.Phone, b.HostelSnapshot.Name, share, hoursLeft, name, b.RoomType)
		}, "HIGH", "Less than "+email.HoursWord(hoursLeft)+" to answer", "BOOKING_ANSWER_REMINDER")
}

func (s *Signed) remindMoveIn(ctx context.Context, b *Booking, hoursLeft float64) {
	var hs struct {
		Contact  struct{ Phone string } `bson:"contact"`
		Location *struct {
			Address, Area, City, Landmark, MapLink string
			Lat, Lng                               *float64
		} `bson:"location"`
	}
	_ = s.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: b.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "contact", Value: 1}, {Key: "location", Value: 1}})).Decode(&hs)
	holdEnds, at := "", time.Now()
	if b.HoldEndsAt != nil {
		holdEnds, at = whenText(*b.HoldEndsAt), *b.HoldEndsAt
	}
	phone := hs.Contact.Phone
	if phone == "" {
		phone = b.HostelSnapshot.Phone
	}
	refund := settleBooking(at, b.ConfirmedAt, "NO_SHOW", b.Fee, b.Stay, b.Terms).Refund
	m := email.BookingMoveInReminder(facts(b), b.HostelSnapshot.Address, s.appURL(guestPath(b)), directionsURL(hs.Location), holdEnds, phone, hoursLeft, b.Guest.Name, refund)
	s.notifyGuest(ctx, b, "booking_move_in_reminder", "Move in at "+b.HostelSnapshot.Name+" by "+holdEnds+", or the bed held for you is released.", &m, nil,
		"Less than "+email.HoursWord(hoursLeft)+" to move in", "BOOKING_MOVE_IN_REMINDER")
}

// Sweep is sweepBookings (inside the platform-push job): unpaid, unanswered and
// no-show bookings are ended, reminders sent once per threshold, short stays closed.
func (s *Signed) Sweep(ctx context.Context, now time.Time) (ordered.Map, error) {
	now = now.UTC().Truncate(time.Millisecond)
	cfg := s.BookingConfig(ctx)
	expired, err := s.endEach(ctx, bson.D{{Key: "paymentDueBy", Value: bson.D{{Key: "$lte", Value: now}}}, {Key: "status", Value: "AWAITING_PAYMENT"}}, "paymentDueBy",
		func(b *Booking) (bool, error) {
			if b.SoftmatoInvoiceNo != nil && *b.SoftmatoInvoiceNo != "" {
				if outcome, err := s.settleSoftmato(ctx, b, now, func(string) {}); err == nil && outcome == "paid" {
					return false, nil
				}
			}
			ended, err := s.expireUnpaid(ctx, b, now)
			if err == nil && ended != nil {
				s.announceEnding(ctx, ended, b.Status)
			}
			return ended != nil, err
		})
	if err != nil {
		return nil, err
	}
	missed, err := s.endEach(ctx, bson.D{{Key: "hostelAnswerBy", Value: bson.D{{Key: "$lte", Value: now}}}, {Key: "status", Value: "AWAITING_HOSTEL"}}, "hostelAnswerBy",
		func(b *Booking) (bool, error) {
			ended, err := s.endBooking(ctx, b, endInput{from: "AWAITING_HOSTEL", status: "HOSTEL_NO_RESPONSE", strike: true}, now)
			if err == nil && ended != nil {
				s.announceEnding(ctx, ended, b.Status)
			}
			return ended != nil, err
		})
	if err != nil {
		return nil, err
	}
	noShows, err := s.endEach(ctx, bson.D{{Key: "holdEndsAt", Value: bson.D{{Key: "$lte", Value: now}}}, {Key: "status", Value: "CONFIRMED"}}, "holdEndsAt",
		func(b *Booking) (bool, error) {
			ended, err := s.endBooking(ctx, b, endInput{from: "CONFIRMED", status: "NO_SHOW"}, now)
			if err == nil && ended != nil {
				s.announceEnding(ctx, ended, b.Status)
			}
			return ended != nil, err
		})
	if err != nil {
		return nil, err
	}
	hostelReminders, err := s.remindEach(ctx, "hostelAnswerBy", "hostelRemindersSent", "AWAITING_HOSTEL", cfg.HostelReminderHoursLeft, now,
		func(b *Booking, h float64) { s.remindHostel(ctx, b, h) })
	if err != nil {
		return nil, err
	}
	moveInReminders, err := s.remindEach(ctx, "holdEndsAt", "moveInRemindersSent", "CONFIRMED", cfg.MoveInReminderHoursLeft, now,
		func(b *Booking, h float64) { s.remindMoveIn(ctx, b, h) })
	if err != nil {
		return nil, err
	}
	stays, err := s.endShortStays(ctx, now)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "expired", Value: expired}, {Key: "hostelReminders", Value: hostelReminders}, {Key: "missedAnswers", Value: missed},
		{Key: "moveInReminders", Value: moveInReminders}, {Key: "noShows", Value: noShows}, {Key: "staysEnded", Value: stays}}, nil
}

// endShortStays: a short stay's resident is moved out on its last day and the bed counted free again.
func (s *Signed) endShortStays(ctx context.Context, now time.Time) (int, error) {
	cur, err := s.db.Collection("residents").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING", "SUSPENDED"}}}},
		{Key: "stayEndsAt", Value: bson.D{{Key: "$lte", Value: now}}}}, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "roomType", Value: 1}, {Key: "stayEndsAt", Value: 1}}).SetLimit(100))
	if err != nil {
		return 0, err
	}
	var due []struct {
		ID         bson.ObjectID `bson:"_id"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		RoomType   string        `bson:"roomType"`
		StayEndsAt time.Time     `bson:"stayEndsAt"`
	}
	if err := cur.All(ctx, &due); err != nil {
		return 0, err
	}
	ended := 0
	for _, r := range due {
		res, err := s.db.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "moveOutDate", Value: r.StayEndsAt}, {Key: "status", Value: "MOVED_OUT"}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			slog.ErrorContext(ctx, "A short stay could not be ended.", "error", err.Error(), "residentId", r.ID.Hex())
			continue
		}
		if res.ModifiedCount == 0 {
			continue
		}
		if err := s.releaseBed(ctx, r.HostelID, r.RoomType, now); err != nil {
			slog.ErrorContext(ctx, "A short stay could not be ended.", "error", err.Error(), "residentId", r.ID.Hex())
			continue
		}
		_ = s.Audit.Write(ctx, audit.Entry{Action: "SHORT_STAY_ENDED", ActorType: "SYSTEM", EntityID: r.ID.Hex(), EntityType: "Resident", HostelID: r.HostelID,
			Metadata: bson.D{{Key: "stayEndsAt", Value: r.StayEndsAt}}})
		ended++
	}
	return ended, nil
}
