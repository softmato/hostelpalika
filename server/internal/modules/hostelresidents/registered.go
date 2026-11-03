package hostelresidents

import (
	"context"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

type registeredNotice struct {
	admissionFee float64
	deposit      float64
	hostel       bson.ObjectID
	first        FirstInvoice
	prorated     bool
	monthlyRent  *float64
	resident     Resident
	moveIn       time.Time
	newLogin     bool
	userID       string
}

// notifyAfter runs notifyResidentRegistered once the response is out.
func (s *Service) notifyAfter(ctx context.Context, n registeredNotice) {
	run := func(c context.Context) error { s.notifyRegistered(c, n); return nil }
	if s.After != nil {
		s.After(ctx, run)
		return
	}
	_ = run(ctx)
}

// notifyRegistered is notifyResidentRegistered: the resident, the staff, and the mail. Never fails the intake.
func (s *Service) notifyRegistered(ctx context.Context, n registeredNotice) {
	hostelName := s.hostelName(ctx, n.hostel)
	r := &n.resident
	name := strings.TrimSpace(r.FirstName + " " + r.LastName)
	roomNumber := ""
	if r.RoomNumber != nil {
		roomNumber = *r.RoomNumber
	}
	var parts []string
	for _, p := range []string{hostelrooms.TypeLabel(r.RoomType), roomNumber} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	room := strings.Join(parts, " · ")

	if n.userID != "" {
		body, category, data := fmt.Sprintf("You are registered at %s.", hostelName), "ACCOUNT", ordered.Map{{Key: "type", Value: "RESIDENT_REGISTERED"}}
		if n.first.Raised {
			label := bs.FormatPeriod(n.first.Period)
			if label == "" {
				label = n.first.Period
			}
			body = fmt.Sprintf("You are registered at %s. Your rent for %s is NPR %s.", hostelName, label, money.GroupUS(n.first.Amount))
			category = "PAYMENT"
			data = ordered.Map{{Key: "type", Value: "RESIDENT_REGISTERED"}, {Key: "invoiceId", Value: n.first.InvoiceID}}
		}
		if _, err := s.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: category, Data: data, HostelID: n.hostel.Hex(), Priority: "NORMAL", Title: "You are registered", UserID: n.userID}); err != nil {
			nonFatal(ctx, err)
		}
	}

	if staff, err := residents.HostelStaffUserIDs(ctx, s.DB, n.hostel, false); err == nil {
		where := room
		if where == "" {
			where = "no room recorded"
		}
		for _, uid := range staff {
			_, err := s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/residents", Body: fmt.Sprintf("%s — %s, moving in %s.", name, where, n.moveIn.UTC().Format("Mon Jan 02 2006")),
				Category: "RESIDENT", Data: ordered.Map{{Key: "residentId", Value: r.ID.Hex()}}, HostelID: n.hostel.Hex(), Title: "New resident registered", UserID: uid})
			nonFatal(ctx, err)
		}
	} else {
		nonFatal(ctx, err)
	}

	uid := r.UserID
	if uid == nil && n.userID != "" {
		if id, err := bson.ObjectIDFromHex(n.userID); err == nil {
			uid = &id
		}
	}
	contact := residents.ResolveContact(ctx, s.DB, r.Email, r.FirstName, r.LastName, uid)
	if contact == nil {
		return
	}
	in := email.RegisteredInput{AdmissionFee: int64(n.admissionFee), DashboardURL: s.AppURL("/resident/dashboard"), DepositAmount: int64(n.deposit), HostelName: hostelName,
		MoveInDate: n.moveIn, ResidentName: r.FirstName, RoomNumber: roomNumber, RoomType: r.RoomType, SignIn: "ACTIVATION_CODE", SignInEmail: contact.Email}
	if n.admissionFee <= 0 {
		in.AdmissionFee = 0
	}
	if n.monthlyRent != nil {
		in.MonthlyRent = int64(*n.monthlyRent)
	}
	if n.userID != "" {
		in.SignIn = "EXISTING_ACCOUNT"
		if n.newLogin {
			in.SignIn = "NEW_ACCOUNT"
		}
	}
	if n.first.Raised {
		due, err := time.Parse(time.RFC3339Nano, n.first.DueDate)
		if err != nil {
			if b, berr := bs.PeriodBounds(n.first.Period); berr == nil {
				due = b.LastDay
			}
		}
		in.FirstMonth = &email.RegisteredFirstMonth{Amount: n.first.Amount, DueDate: due, Period: n.first.Period, Prorated: n.prorated, ReferenceCode: n.first.ReferenceCode}
	}
	c := email.ResidentRegistered(in)
	s.Mail.Send(ctx, email.Message{Category: c.Category, To: []string{contact.Email}, Subject: c.Subject, HTML: c.HTML})
}
