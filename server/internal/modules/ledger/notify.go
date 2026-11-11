package ledger

import (
	"context"
	"log/slog"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// finance-notify.ts. None of these fail a write: the money is already committed, so
// a notice that cannot go out is logged and dropped.

func (e *Engine) warn(ctx context.Context, what string, err error) {
	if err != nil {
		slog.WarnContext(ctx, what, "error", err)
	}
}

// NotifyHostelAdmins is notifyHostelAdmins: bell and push to the owner and admins,
// never the actor.
func (e *Engine) NotifyHostelAdmins(ctx context.Context, hostel bson.ObjectID, actionURL, title, body string, data ordered.Map, except string) {
	if e.Notify == nil {
		return
	}
	admins, err := residents.HostelStaffUserIDs(ctx, e.DB, hostel, true)
	if err != nil {
		e.warn(ctx, "hostel admin notification failed", err)
		return
	}
	for _, admin := range admins {
		if admin == except {
			continue
		}
		_, err := e.Notify.CreateInApp(ctx, notifications.Input{ActionURL: actionURL, Body: body, Category: "PAYMENT", Data: data, HostelID: hostel.Hex(), Kind: "NORMAL", Title: title, UserID: admin})
		e.warn(ctx, "hostel admin notification failed", err)
	}
}

// NotifyResident is notifyResident: one resident's bell row and push, through their
// linked account. A desk registration with no account has no phone to reach.
func (e *Engine) NotifyResident(ctx context.Context, hostel, resident bson.ObjectID, title, body string, data ordered.Map) {
	if e.Notify == nil {
		return
	}
	var row struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := e.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: resident}}, options.FindOne().SetProjection(bson.D{{Key: "userId", Value: 1}})).Decode(&row); err != nil || row.UserID == nil {
		return
	}
	_, err := e.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "PAYMENT", Data: data, HostelID: hostel.Hex(), Title: title, UserID: row.UserID.Hex()})
	e.warn(ctx, "resident notification failed", err)
}

func (e *Engine) notifyAdminsOfStaffSettlement(ctx context.Context, ev *Event, staff string) {
	var row struct {
		First string `bson:"firstName"`
		Last  string `bson:"lastName"`
	}
	_ = e.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: *ev.ResidentID}}).Decode(&row) // a missing name reads "A resident"
	name := strings.TrimSpace(row.First + " " + row.Last)
	if name == "" {
		name = "A resident"
	}
	e.NotifyHostelAdmins(ctx, ev.HostelID, "/hostel-admin/payments", "Payment accepted", "A warden accepted NPR "+money.GroupUS(ev.Amount)+" from "+name+".",
		ordered.Map{{Key: "eventId", Value: ev.ID.Hex()}, {Key: "type", Value: "STAFF_PAYMENT_ACCEPTED"}}, staff)
}

// residentContact is what a notice needs about the resident it reaches.
type residentContact struct {
	ID     bson.ObjectID  `bson:"_id"`
	Email  string         `bson:"email"`
	First  string         `bson:"firstName"`
	Last   string         `bson:"lastName"`
	UserID *bson.ObjectID `bson:"userId"`
}

func (e *Engine) contact(ctx context.Context, resident bson.ObjectID) (*residentContact, *residents.Contact) {
	r := &residentContact{}
	if err := e.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: resident}, {Key: "isDeleted", Value: false}}).Decode(r); err != nil {
		return nil, nil
	}
	return r, residents.ResolveContact(ctx, e.DB, r.Email, r.First, r.Last, r.UserID)
}

func (e *Engine) hostelName(ctx context.Context, hostel bson.ObjectID) string {
	name, err := residents.HostelName(ctx, e.DB, hostel)
	e.warn(ctx, "hostel name read failed", err)
	return name
}

func periodText(p *string, otherwise string) string {
	if p == nil || *p == "" {
		return otherwise
	}
	return *p
}

// ClaimReview is notifyClaimReviewed's argument. Kind is verified or rejected.
type ClaimReview struct {
	HostelID, ResidentID bson.ObjectID
	InvoiceID            *bson.ObjectID
	Kind                 string
	Period               *string
	Receipt              *Receipt
	RejectionReason      string
	Remaining, Verified  int64
	// EventID is the settling event, so the push can say what it earned (todo C3).
	EventID *bson.ObjectID
	// Method is how a desk payment arrived; CASH titles the push "Cash collected" (todo E6).
	Method string
}

// NotifyClaimReviewed is notifyClaimReviewed: the bell always fires, the mail only
// when the platform sends payment emails; a verified mail carries the receipt PDF.
func (e *Engine) NotifyClaimReviewed(ctx context.Context, in ClaimReview) {
	r, contact := e.contact(ctx, in.ResidentID)
	if r == nil {
		return
	}
	period := periodText(in.Period, "your account")
	var cert, number string
	if in.Receipt != nil {
		number = in.Receipt.ReceiptNumber
		if in.Receipt.CertificationCode != nil {
			cert = *in.Receipt.CertificationCode
		}
	}
	var invoiceData any
	if in.InvoiceID != nil {
		invoiceData = in.InvoiceID.Hex()
	}
	if r.UserID != nil && e.Notify != nil {
		title, body := "Payment proof rejected", "Your payment proof for "+period+" was not accepted: "+in.RejectionReason
		if in.Kind == "verified" {
			title = "Payment verified"
			if in.Method == "CASH" {
				title = "Cash collected"
			}
			body = "NPR " + money.GroupUS(in.Verified) + " received for " + period + "."
			if in.Remaining > 0 {
				body += " NPR " + money.GroupUS(in.Remaining) + " still due."
			} else {
				body += " Fully paid."
			}
			if cert != "" {
				body += " Your receipt was added to the Resident Offer Program."
			} else if number != "" {
				body += " Receipt " + number + "."
			}
			if in.EventID != nil && in.InvoiceID != nil {
				if pts := finance.PointsEarnedBy(ctx, e.DB, in.ResidentID, *in.InvoiceID, *in.EventID); pts > 0 {
					body += " +" + strconv.Itoa(pts) + " points."
				}
			}
		}
		_, err := e.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/payments", Body: body, Category: "PAYMENT", Data: ordered.Map{{Key: "invoiceId", Value: invoiceData}}, HostelID: in.HostelID.Hex(), Kind: "NORMAL", Title: title, UserID: r.UserID.Hex()})
		e.warn(ctx, "claim review notification failed", err)
	}
	if contact == nil || e.Mail == nil || e.Config == nil || !e.Config.OperationsTyped(ctx).SendPaymentEmails {
		return
	}
	name := contact.Name
	if name == "" {
		name = r.First
	}
	month := periodText(in.Period, "")
	hostel := e.hostelName(ctx, in.HostelID)
	var content email.Content
	var attach []email.Attachment
	if in.Kind == "verified" {
		content = email.PaymentVerified(in.Verified, cert, hostel, month, e.AppURL("/resident/offer-program"), e.AppURL("/resident/payments"), number, in.Remaining, name)
		if in.Receipt != nil {
			if b, file, err := finance.RenderReceiptForMail(ctx, e.DB, in.Receipt.ID); err == nil {
				attach = []email.Attachment{{Content: b, Filename: file + ".pdf"}}
			} else {
				e.warn(ctx, "receipt attachment failed", err)
			}
		}
	} else {
		content = email.PaymentRejected(hostel, month, e.AppURL("/resident/payments"), in.RejectionReason, name)
	}
	e.send(ctx, "payment_"+in.Kind, contact.Email, content, attach)
}

func (e *Engine) send(ctx context.Context, action, to string, c email.Content, attach []email.Attachment) {
	_ = action
	e.Mail.Send(ctx, email.Message{Category: c.Category, To: []string{to}, Subject: c.Subject, HTML: c.HTML, Attachments: attach}) // the sender logs a failed send
}

// notifyPaymentReversed is notifyPaymentReversed. The bell always fires: a reversal
// nobody is told about is found from a dunning notice.
func (e *Engine) notifyPaymentReversed(ctx context.Context, ev *Event, outstanding int64, reason string) {
	r, contact := e.contact(ctx, *ev.ResidentID)
	if r == nil {
		return
	}
	var invoiceData any
	if ev.InvoiceID != nil {
		invoiceData = ev.InvoiceID.Hex()
	}
	if r.UserID != nil && e.Notify != nil {
		_, err := e.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/resident/payments", Body: "A payment of NPR " + money.GroupUS(ev.Amount) + " was reversed: " + reason, Category: "PAYMENT",
			Data: ordered.Map{{Key: "invoiceId", Value: invoiceData}}, HostelID: ev.HostelID.Hex(), Kind: "NORMAL", Title: "Payment reversed", UserID: r.UserID.Hex()})
		e.warn(ctx, "reversal notification failed", err)
	}
	if contact == nil || e.Mail == nil || e.Config == nil || !e.Config.OperationsTyped(ctx).SendPaymentEmails {
		return
	}
	name := contact.Name
	if name == "" {
		name = r.First
	}
	if name == "" {
		name = "there"
	}
	e.send(ctx, "payment_reversed", contact.Email, email.PaymentReversed(ev.Amount, e.hostelName(ctx, ev.HostelID), outstanding, e.AppURL("/resident/payments"), e.PeriodOf(ctx, ev.InvoiceID), reason, name), nil)
}
