package bookings

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/email"
)

// FindHeld is findHeldBooking: the user's CONFIRMED booking at the hostel. One
// whose hold has run out ends as a no-show and reads as none.
func (s *Signed) FindHeld(ctx context.Context, hostel, user bson.ObjectID, now time.Time) (*Booking, error) {
	var b Booking
	err := s.db.Collection("bookings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "CONFIRMED"}, {Key: "userId", Value: user}}).Decode(&b)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if past(b.HoldEndsAt, now) {
		return nil, s.EndAsNoShow(ctx, &b, now)
	}
	return &b, nil
}

// EndAsNoShow is endAsNoShow.
func (s *Signed) EndAsNoShow(ctx context.Context, b *Booking, now time.Time) error {
	ended, err := s.endBooking(ctx, b, endInput{from: "CONFIRMED", status: "NO_SHOW"}, now)
	if err == nil && ended != nil {
		s.announceEnding(ctx, ended, b.Status)
	}
	return err
}

// CheckIn is checkInBooking: the booking becomes CHECKED_IN, keeping its bed
// (the resident sleeps in it). When it ended at the same moment, the bed the
// resident took is counted again via claim and nil comes back.
func (s *Signed) CheckIn(ctx context.Context, b *Booking, actor, resident bson.ObjectID, now time.Time, claim func(context.Context) error) (*Booking, error) {
	ended, err := s.endBooking(ctx, b, endInput{actor: &actor, from: "CONFIRMED", status: "CHECKED_IN", keepBed: true,
		set: bson.D{{Key: "checkedInAt", Value: now}, {Key: "checkedInBy", Value: actor}, {Key: "residentId", Value: resident}}}, now)
	if err != nil {
		return nil, err
	}
	if ended == nil {
		if cerr := claim(ctx); cerr != nil {
			slog.ErrorContext(ctx, "A resident was admitted on a booking that ended at the same moment; the bed count could not be corrected.", "bookingId", b.ID.Hex(), "error", cerr, "residentId", resident.Hex())
		}
		return nil, nil
	}
	if ended.Settlement != nil && ended.Settlement.HostelShare != nil && *ended.Settlement.HostelShare > 0 {
		share := *ended.Settlement.HostelShare
		s.notifyPlatform(ctx, ended, "booking_checked_in", ended.Code+": "+ended.Guest.Name+" moved in at "+ended.HostelSnapshot.Name+". Payout "+email.Rupees(share)+" to send.", nil, "payouts", "Payout to send", "BOOKING_MONEY_DUE")
	}
	return ended, nil
}
