// Package inquiries is the staff side of modules/hostels/hostel-inquiry.service:
// the leads a hostel's public page collects, their status, and follow-up notes.
package inquiries

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Cache  *cache.Cache
	Audit  *audit.Log
}

var statuses = []string{"NEW", "CONTACTED", "VISIT_SCHEDULED", "CONVERTED", "CLOSED"}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	staff := authz.Use(h.Guards.RequireHostelStaff)
	a := v1.Group("/hostel-admin/inquiries")
	a.GET("", staff, h.list)
	a.PATCH("/:id/status", staff, h.setStatus)
	a.POST("/:id/notes", staff, h.addNote)
}

type record struct {
	ID          bson.ObjectID `bson:"_id"`
	BudgetRange *string       `bson:"budgetRange"`
	CreatedAt   *time.Time    `bson:"createdAt"`
	Email       *string       `bson:"email"`
	Gender      *string       `bson:"gender"`
	HostelID    bson.ObjectID `bson:"hostelId"`
	Message     *string       `bson:"message"`
	Name        string        `bson:"name"`
	Phone       string        `bson:"phone"`
	RoomType    *string       `bson:"preferredRoomType"`
	VisitDate   *time.Time    `bson:"preferredVisitDate"`
	Source      string        `bson:"source"`
	Status      string        `bson:"status"`
	UpdatedAt   *time.Time    `bson:"updatedAt"`
}

// inquiryOut is serializeInquiry; undefined dates are absent, not null.
type inquiryOut struct {
	BudgetRange        string  `json:"budgetRange"`
	CreatedAt          *string `json:"createdAt,omitempty"`
	Email              string  `json:"email"`
	Gender             string  `json:"gender"`
	HostelID           string  `json:"hostelId"`
	ID                 string  `json:"id"`
	Message            string  `json:"message"`
	Name               string  `json:"name"`
	Phone              string  `json:"phone"`
	PreferredRoomType  string  `json:"preferredRoomType"`
	PreferredVisitDate *string `json:"preferredVisitDate,omitempty"`
	Source             string  `json:"source"`
	Status             string  `json:"status"`
	UpdatedAt          *string `json:"updatedAt,omitempty"`
}

func iso(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := httpx.ISO(*t)
	return &s
}

func or(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (r *record) out() inquiryOut {
	return inquiryOut{or(r.BudgetRange), iso(r.CreatedAt), or(r.Email), or(r.Gender), r.HostelID.Hex(), r.ID.Hex(), or(r.Message), r.Name, r.Phone, or(r.RoomType), iso(r.VisitDate), r.Source, r.Status, iso(r.UpdatedAt)}
}

type listOut struct {
	Inquiries  []inquiryOut    `json:"inquiries"`
	Pagination pagination.Meta `json:"pagination"`
}

func (h *Handler) list(c *gin.Context) {
	p := authz.From(c)
	q := valid.Query(c)
	var is valid.Issues
	page := hostelrooms.ReadPage(q, &is)
	hid := hostelrooms.QueryHostelID(q, &is)
	status := valid.QueryEnum(q, "status", &is, statuses...)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := hostelrooms.ScopeFilter(p, hid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	key := "inquiries"
	if raw := c.Request.URL.RawQuery; raw != "" {
		key += "?" + raw
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, key, "Inquiries loaded", func() (listOut, error) {
		filter := bson.D{{Key: "isDeleted", Value: false}, scope}
		if status != nil {
			filter = append(filter, bson.E{Key: "status", Value: *status})
		}
		r := pagination.RangeOf(page)
		cur, err := h.DB.Collection("inquiries").Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
		if err != nil {
			return listOut{}, err
		}
		var rows []record
		if err := cur.All(c, &rows); err != nil {
			return listOut{}, err
		}
		total, err := h.DB.Collection("inquiries").CountDocuments(c, filter)
		if err != nil {
			return listOut{}, err
		}
		out := listOut{Inquiries: make([]inquiryOut, len(rows)), Pagination: pagination.MetaOf(page, int(total))}
		for i := range rows {
			out.Inquiries[i] = rows[i].out()
		}
		return out, nil
	})
}

func notFound() error {
	return httpx.NewError(http.StatusNotFound, "INQUIRY_NOT_FOUND", "Inquiry was not found.", nil)
}

// find is findScopedInquiry.
func (h *Handler) find(ctx context.Context, p *authz.Principal, rawID, hostelID string) (*record, error) {
	id, err := bson.ObjectIDFromHex(rawID)
	if err != nil {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "INVALID_HOSTEL_ID", "Invalid hostel id.", nil)
	}
	scope, err := hostelrooms.ScopeFilter(p, hostelID)
	if err != nil {
		return nil, err
	}
	var r record
	err = h.DB.Collection("inquiries").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, scope}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, notFound()
	}
	return &r, err
}

func (h *Handler) auditAction(ctx context.Context, p *authz.Principal, r *record, action string, meta bson.D) error {
	return h.Audit.Write(ctx, audit.Entry{ActorID: hostelrooms.UserID(p), HostelID: r.HostelID, Action: action, EntityType: "Inquiry", EntityID: r.ID.Hex(), Metadata: meta})
}

func (h *Handler) setStatus(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	hid := hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
	status, _ := f.Enum("status", false, nil, statuses...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	inquiry, err := h.find(c, p, c.Param("id"), hid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var updated record
	err = h.DB.Collection("inquiries").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: inquiry.ID}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: status}, {Key: "updatedBy", Value: hostelrooms.UserID(p)}, {Key: "updatedAt", Value: time.Now().UTC()}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notFound())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.auditAction(c, p, inquiry, "INQUIRY_STATUS_UPDATED", bson.D{{Key: "inquiryId", Value: inquiry.ID.Hex()}, {Key: "status", Value: status}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Inquiry inquiryOut `json:"inquiry"`
	}{updated.out()}, "Inquiry status updated")
}

type noteOut struct {
	AuthorID       string  `json:"authorId"`
	CreatedAt      string  `json:"createdAt"`
	HostelID       string  `json:"hostelId"`
	ID             string  `json:"id"`
	InquiryID      string  `json:"inquiryId"`
	NextFollowUpAt *string `json:"nextFollowUpAt,omitempty"`
	Note           string  `json:"note"`
	StatusSnapshot string  `json:"statusSnapshot"`
}

func (h *Handler) addNote(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	hid := hostelrooms.OptionalID(f, "hostelId", "Invalid object id.")
	var follow *time.Time
	if v, ok := f.M["nextFollowUpAt"]; ok {
		if t, ok := valid.CoerceDate(v); ok {
			follow = &t
		} else {
			f.Hard = true
			f.Is.Add("nextFollowUpAt", valid.Type("date", "Date"))
		}
	}
	note, _ := f.Str("note", valid.S{Trim: true, Min: 2, Max: 1200})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	inquiry, err := h.find(c, p, c.Param("id"), hid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "inquiryId", Value: inquiry.ID}, {Key: "hostelId", Value: inquiry.HostelID}, {Key: "authorId", Value: hostelrooms.UserID(p)}, {Key: "note", Value: note}}
	if follow != nil {
		doc = append(doc, bson.E{Key: "nextFollowUpAt", Value: *follow})
	}
	doc = append(doc, bson.E{Key: "statusSnapshot", Value: inquiry.Status}, bson.E{Key: "isDeleted", Value: false}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: int32(0)})
	if _, err := h.DB.Collection("inquirynotes").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.auditAction(c, p, inquiry, "INQUIRY_NOTE_ADDED", bson.D{{Key: "inquiryId", Value: inquiry.ID.Hex()}, {Key: "noteId", Value: id.Hex()}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := noteOut{p.UserID, httpx.ISO(now), inquiry.HostelID.Hex(), id.Hex(), inquiry.ID.Hex(), iso(follow), note, inquiry.Status}
	httpx.Write(c, http.StatusCreated, struct {
		Inquiry inquiryOut `json:"inquiry"`
		Note    noteOut    `json:"note"`
	}{inquiry.out(), out}, "Inquiry note added")
}
