package hostels

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// InquiryInput is publicInquiryCreateSchema, parsed. Optional fields are nil.
type InquiryInput struct {
	BudgetRange, Email, Gender, Message, Name, Phone, PreferredRoomType *string
	PreferredVisitDate                                                  *time.Time
}

func optStr(f *valid.Form, key string, max int) *string {
	if v, ok := f.Str(key, valid.S{Opt: true, Trim: true, Max: max}); ok {
		return &v
	}
	return nil
}

// ParseInquiry is the schema in declared order: budgetRange, email, gender,
// message, name, phone, preferredRoomType, preferredVisitDate. in.Name and
// in.Phone are always set when err is nil.
func ParseInquiry(body any) (InquiryInput, error) {
	f := valid.NewForm(body)
	var in InquiryInput
	in.BudgetRange = optStr(f, "budgetRange", 80)
	if v, ok := f.Str("email", valid.S{Opt: true, Trim: true}); ok {
		if !email.ValidEmail(v) {
			f.Is.Add("email", valid.Format("email"))
		}
		in.Email = &v
	}
	in.Gender = optStr(f, "gender", 40)
	in.Message = optStr(f, "message", 1200)
	if v, ok := f.Str("name", valid.S{Trim: true, Min: 2, Max: 120}); ok {
		in.Name = &v
	}
	if v, ok := f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24}); ok {
		in.Phone = &v
	}
	in.PreferredRoomType = optStr(f, "preferredRoomType", 80)
	if raw, present := f.M["preferredVisitDate"]; present {
		if t, ok := valid.CoerceDate(raw); ok {
			in.PreferredVisitDate = &t
		} else {
			f.Is.Add("preferredVisitDate", valid.Type("date", "Date"))
		}
	}
	return in, f.Err()
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// inquiryRow is the document createPublicHostelInquiry writes, with the
// serialised answer's pieces.
type inquiryRow struct {
	ID        bson.ObjectID
	HostelID  bson.ObjectID
	CreatedAt time.Time
}

func (w *Writes) insertInquiry(ctx context.Context, hostelID bson.ObjectID, in InquiryInput) (inquiryRow, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}}
	add := func(k string, p *string) {
		if p != nil {
			doc = append(doc, bson.E{Key: k, Value: *p})
		}
	}
	add("budgetRange", in.BudgetRange)
	add("email", in.Email)
	add("gender", in.Gender)
	add("message", in.Message)
	add("name", in.Name)
	add("phone", in.Phone)
	add("preferredRoomType", in.PreferredRoomType)
	if in.PreferredVisitDate != nil {
		doc = append(doc, bson.E{Key: "preferredVisitDate", Value: *in.PreferredVisitDate})
	}
	doc = append(doc, bson.E{Key: "hostelId", Value: hostelID}, bson.E{Key: "source", Value: "PUBLIC_WEBSITE"}, bson.E{Key: "status", Value: "NEW"},
		bson.E{Key: "isDeleted", Value: false}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := w.db.Collection("inquiries").InsertOne(ctx, doc); err != nil {
		return inquiryRow{}, err
	}
	return inquiryRow{id, hostelID, now}, nil
}

// serializeInquiry is serializeInquiry, key order and all.
func serializeInquiry(r inquiryRow, in InquiryInput) ordered.Map {
	visit := any(ordered.Undefined)
	if in.PreferredVisitDate != nil {
		visit = httpx.ISO(*in.PreferredVisitDate)
	}
	return ordered.Map{
		{Key: "budgetRange", Value: str(in.BudgetRange)}, {Key: "createdAt", Value: httpx.ISO(r.CreatedAt)}, {Key: "email", Value: str(in.Email)},
		{Key: "gender", Value: str(in.Gender)}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: r.ID.Hex()},
		{Key: "message", Value: str(in.Message)}, {Key: "name", Value: str(in.Name)}, {Key: "phone", Value: str(in.Phone)},
		{Key: "preferredRoomType", Value: str(in.PreferredRoomType)}, {Key: "preferredVisitDate", Value: visit},
		{Key: "source", Value: "PUBLIC_WEBSITE"}, {Key: "status", Value: "NEW"}, {Key: "updatedAt", Value: httpx.ISO(r.CreatedAt)},
	}
}

// notifyHostelOfInquiry tells the hostel's admins a public inquiry arrived
// (EMAIL_SYSTEM.md §2.4). Best-effort: a failure never fails an inquiry the
// visitor has already submitted.
func (w *Writes) notifyHostelOfInquiry(ctx context.Context, hostelID bson.ObjectID, hostelName string, in InquiryInput) {
	contacts, err := residents.HostelAdminContacts(ctx, w.db, hostelID)
	if err != nil {
		slog.WarnContext(ctx, "inquiry notify failed", "error", err)
		return
	}
	if len(contacts) == 0 {
		return
	}
	visit := ""
	if in.PreferredVisitDate != nil {
		visit = in.PreferredVisitDate.UTC().Format("2006-01-02")
	}
	mail := email.HostelInquiryReceived(residents.AppURL(w.outbound, "/hostel-admin/inquiries"), hostelName, str(in.Message), visit,
		str(in.Email), str(in.Name), str(in.Phone))
	for _, contact := range contacts {
		w.mail.Notify(ctx, email.Notification{Action: "hostel_inquiry_received", To: contact.Email, Subject: mail.Subject, HTML: mail.HTML, Category: mail.Category})
		if contact.UserID == "" {
			continue
		}
		_, _ = w.notify.CreateInApp(ctx, notifications.Input{
			ActionURL: "/hostel-admin/inquiries", Body: str(in.Name) + " enquired about " + hostelName + ".", Category: "INQUIRY",
			Data: ordered.Map{{Key: "hostelId", Value: hostelID.Hex()}}, HostelID: hostelID.Hex(),
			// An inquiry needs a human reply, not a button — deep link only.
			Kind: "ACTION", Title: "New inquiry", UserID: contact.UserID,
		})
	}
	realtime.PublishResourceChange(ctx, w.rt, w.cache, realtime.Change{Topics: []realtime.Topic{realtime.Inquiries}, HostelIDs: []string{hostelID.Hex()}})
}

type inquiryOut struct {
	Hostel               ordered.Map `json:"hostel"`
	Inquiry              ordered.Map `json:"inquiry"`
	ShouldCollectProfile bool        `json:"shouldCollectProfile"`
}

// CreateInquiry is createPublicHostelInquiry: the hostel must be published and
// verified; a sample listing answers 409.
func (w *Writes) createInquiry(c *gin.Context, ref string, in InquiryInput) (ordered.Map, ordered.Map, error) {
	filter := bson.D{{Key: "slug", Value: ref}}
	if id, err := bson.ObjectIDFromHex(ref); err == nil {
		filter = bson.D{{Key: "_id", Value: id}}
	}
	rows, err := w.pub.find(c, append(filter, visible()...))
	if err != nil {
		return nil, nil, err
	}
	if len(rows) == 0 {
		if IsDemoRef(ref) {
			return nil, nil, httpx.NewError(http.StatusConflict, "HOSTEL_NOT_TAKING_INQUIRIES", "This hostel is not taking enquiries right now.", nil)
		}
		return nil, nil, errNotFound
	}
	h := rows[0]
	hid, _ := h.oid("_id")
	row, err := w.insertInquiry(c, hid, in)
	if err != nil {
		return nil, nil, err
	}
	w.notifyHostelOfInquiry(c, hid, h.str("name"), in)
	return serializePublic(h), serializeInquiry(row, in), nil
}

func (w *Writes) inquiry(c *gin.Context) {
	if err := w.limiter.PublicForm(c, "public-hostel-inquiry"); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := ParseInquiry(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, inquiry, err := w.createInquiry(c, c.Param("slug"), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// Sending an inquiry is the clearest signal someone is about to move in —
	// the best moment to offer the fill-once resident profile.
	p, err := w.guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID := ""
	if p != nil {
		userID = p.UserID
	}
	should, perr := users.ShouldPromptAfterInquiry(c, w.db, userID, str(in.Email))
	if perr != nil {
		should = false
	}
	httpx.Write(c, http.StatusCreated, inquiryOut{hostel, inquiry, should}, "Inquiry submitted")
}
