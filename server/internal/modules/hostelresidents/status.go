package hostelresidents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/movechecklist"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"time"
)

// FirstInvoice is FirstMonthInvoiceResult.
type FirstInvoice struct {
	Raised                            bool
	Amount                            int64
	DueDate, InvoiceID, ReferenceCode string
	Period, Reason                    string
}

func (f FirstInvoice) JSON() ordered.Map {
	if !f.Raised {
		return ordered.Map{{Key: "period", Value: f.Period}, {Key: "raised", Value: false}, {Key: "reason", Value: f.Reason}}
	}
	return ordered.Map{{Key: "amount", Value: f.Amount}, {Key: "dueDate", Value: f.DueDate}, {Key: "invoiceId", Value: f.InvoiceID}, {Key: "period", Value: f.Period}, {Key: "raised", Value: true}, {Key: "referenceCode", Value: f.ReferenceCode}}
}

// RaiseFirstMonth is raiseFirstMonthInvoice: runBillingCycle for one resident and
// one period. It never fails the caller; a refusal is a reason.
func (s *Service) RaiseFirstMonth(ctx context.Context, hostel, resident bson.ObjectID, moveIn time.Time, p *authz.Principal) FirstInvoice {
	period, err := bs.PeriodOf(moveIn)
	if err != nil {
		return FirstInvoice{Reason: err.Error()}
	}
	res, err := s.Ledger.RunBillingCycle(ctx, ledger.BillingInput{HostelID: hostel, Period: period, ResidentIDs: bson.A{resident}}, p)
	if err != nil {
		return FirstInvoice{Period: period, Reason: err.Error()}
	}
	if len(res.Billed) > 0 {
		b := res.Billed[0]
		return FirstInvoice{Raised: true, Amount: b.Amount, DueDate: b.DueDate, InvoiceID: b.InvoiceID, Period: period, ReferenceCode: b.ReferenceCode}
	}
	reason := "NOT_BILLABLE_YET"
	switch {
	case len(res.Skipped) > 0:
		reason = res.Skipped[0].Reason
	case len(res.Failures) > 0:
		reason = res.Failures[0].ErrorCode
	}
	return FirstInvoice{Period: period, Reason: reason}
}

type statusNotice struct{ title, body, priority string }

// notifyStatusChanged is notifyResidentStatusChanged: never fails the change.
func (s *Service) notifyStatusChanged(ctx context.Context, hostel bson.ObjectID, previous, status string, userID *bson.ObjectID) {
	if userID == nil || previous == status {
		return
	}
	name := s.hostelName(ctx, hostel)
	var n statusNotice
	switch status {
	case "ACTIVE":
		n = statusNotice{"You are admitted", fmt.Sprintf("Your stay at %s is now active.", name), "NORMAL"}
	case "MOVED_OUT":
		n = statusNotice{"Your stay has ended", fmt.Sprintf("Your stay at %s has been closed. Any deposit is settled separately.", name), "NORMAL"}
	case "SUSPENDED":
		n = statusNotice{"Your stay is suspended", fmt.Sprintf("Your stay at %s has been suspended. Speak to the hostel office.", name), "HIGH"}
	default:
		return
	}
	if _, err := s.Notify.CreateInApp(ctx, notifications.Input{Body: n.body, Category: "ACCOUNT",
		Data:     ordered.Map{{Key: "previousStatus", Value: previous}, {Key: "status", Value: status}},
		HostelID: hostel.Hex(), Priority: n.priority, Title: n.title, UserID: userID.Hex()}); err != nil {
		slog.WarnContext(ctx, "resident_status_change_notification_failed", "error", err)
	}
}

// UpdateStatus is updateResidentStatus.
func (s *Service) UpdateStatus(ctx context.Context, id, hostelID, status string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	coll := s.DB.Collection("residents")
	if r.Status == "MOVED_OUT" && status != "MOVED_OUT" {
		filter := bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: r.ID}}}, {Key: "hostelId", Value: r.HostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}}
		if addr := normalizedEmail(r.Email); addr != "" {
			filter = append(filter, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "phone", Value: r.Phone}}, bson.D{{Key: "email", Value: addr}}}})
		} else {
			filter = append(filter, bson.E{Key: "phone", Value: r.Phone})
		}
		var cur struct {
			First string `bson:"firstName"`
			Last  string `bson:"lastName"`
		}
		err := coll.FindOne(ctx, filter, options.FindOne().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}})).Decode(&cur)
		if err == nil {
			return nil, rerr(fmt.Sprintf("%s %s is already on the roll again with this phone or email. Open that record instead.", cur.First, cur.Last), "RESIDENT_ALREADY_HERE", http.StatusConflict)
		}
		if !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
	}
	by := bsonUser(p)
	var updated Resident
	err = coll.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: status}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: now()}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errNotFound()
	}
	if err != nil {
		return nil, err
	}
	if status == "MOVED_OUT" && r.Status != "MOVED_OUT" {
		if err := s.Cap.Release(ctx, r.HostelID, r.RoomType); err != nil {
			return nil, err
		}
		if err := s.releaseAccount(ctx, r.UserID, r.HostelID); err != nil {
			return nil, err
		}
		leftOn := movechecklist.MoveOutDay("")
		charge, err := s.money().DefaultLastMonthCharge(ctx, r.HostelID)
		if err != nil {
			return nil, err
		}
		if _, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lastMonthCharge", Value: charge}, {Key: "moveOutDate", Value: leftOn}}}}); err != nil {
			return nil, err
		}
		if err := s.money().SettleLeavingMonth(ctx, r.mover(), leftOn, charge, p); err != nil {
			slog.ErrorContext(ctx, "Post-registration step failed; the resident is registered.", "error", err.Error())
		}
	}
	var firstMonth any
	if status == "ACTIVE" && r.Status != "ACTIVE" && !updated.MoveInDate.IsZero() {
		cur, e1 := bs.PeriodOf(updated.MoveInDate)
		today, e2 := bs.PeriodOf(time.Now())
		if e1 == nil && e2 == nil && cur >= today {
			firstMonth = s.RaiseFirstMonth(ctx, r.HostelID, r.ID, updated.MoveInDate, p).JSON()
		}
	}
	var returning *IntakeAccount
	if status == "ACTIVE" && r.Status == "MOVED_OUT" && r.UserID != nil {
		u, err := s.userByFilter(ctx, bson.D{{Key: "_id", Value: *r.UserID}, liveUser})
		if err != nil {
			return nil, err
		}
		if u != nil && strings.TrimSpace(u.Email) != "" {
			a := u.account()
			returning = &a
		}
	}
	link := AccountLink{Linked: r.UserID != nil}
	if status == "ACTIVE" && (r.UserID == nil || returning != nil) {
		link = s.LinkAccount(ctx, &updated, p, "", true, returning)
	}
	if err := s.auditResident(ctx, p, r.HostelID, r.ID, "RESIDENT_STATUS_UPDATED", bson.D{{Key: "status", Value: status}}); err != nil {
		return nil, err
	}
	final := &updated
	if link.Linked && r.UserID == nil {
		var again Resident
		if err := coll.FindOne(ctx, bson.D{{Key: "_id", Value: r.ID}}).Decode(&again); err == nil {
			final = &again
		}
	}
	s.notifyStatusChanged(ctx, r.HostelID, r.Status, status, final.UserID)
	return ordered.Map{{Key: "accountLink", Value: link.JSON()}, {Key: "firstMonth", Value: firstMonth}, {Key: "resident", Value: Serialize(final)}}, nil
}
