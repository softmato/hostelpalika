// Package referrals is modules/referrals: a resident's referral code and the
// inquiries it brings in. So far the public inquiry that carries a code; the
// resident and staff sides land with Phases 5 and 6.
package referrals

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	db      *mongo.Database
	limiter *ratelimit.Limiter
}

func NewHandler(db *mongo.Database, limiter *ratelimit.Limiter) *Handler {
	return &Handler{db, limiter}
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.POST("/public/inquiries/with-referral", h.withReferral)
}

type input struct {
	email, message, name, phone, code string
	hasEmail, hasMessage              bool
}

// parse is referredInquiryCreateSchema.
func parse(body any) (input, error) {
	f := valid.NewForm(body)
	var in input
	// z.string().trim().email().optional(): trimmed, case kept.
	if in.email, in.hasEmail = f.Str("email", valid.S{Opt: true, Trim: true}); in.hasEmail && !valid.IsEmail(in.email) {
		f.Is.Add("email", valid.Format("email"))
	}
	in.message, in.hasMessage = f.Str("message", valid.S{Opt: true, Trim: true, Max: 1200})
	in.name, _ = f.Str("name", valid.S{Trim: true, Min: 2, Max: 120})
	in.phone, _ = f.Str("phone", valid.S{Trim: true, Min: 7, Max: 24})
	in.code, _ = f.Str("referralCode", valid.S{Trim: true, Min: 4, Max: 32})
	return in, f.Err()
}

func (h *Handler) withReferral(c *gin.Context) {
	if err := h.limiter.PublicForm(c, "public-referral-inquiry"); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parse(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.create(c, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Referral inquiry submitted")
}

func (h *Handler) create(c *gin.Context, in input) (ordered.Map, error) {
	var code struct {
		ID         bson.ObjectID `bson:"_id"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		ResidentID bson.ObjectID `bson:"residentId"`
	}
	err := h.db.Collection("referralcodes").FindOne(c, bson.D{{Key: "code", Value: strings.ToUpper(valid.Trim(in.code))}, {Key: "status", Value: "ACTIVE"}}).Decode(&code)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(http.StatusNotFound, "REFERRAL_CODE_NOT_FOUND", "Referral code was not found.", nil)
	}
	if err != nil {
		return nil, err
	}
	refs := h.db.Collection("referrals")
	n, err := refs.CountDocuments(c, bson.D{{Key: "hostelId", Value: code.HostelID}, {Key: "isDeleted", Value: false}, {Key: "phone", Value: in.phone},
		{Key: "referralCodeId", Value: code.ID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "CANCELLED"}}}})
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, httpx.NewError(http.StatusConflict, "REFERRAL_ALREADY_EXISTS", "This referral inquiry already exists.", nil)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	inquiryID, referralID := bson.NewObjectID(), bson.NewObjectID()
	inq := bson.D{{Key: "_id", Value: inquiryID}, {Key: "hostelId", Value: code.HostelID}, {Key: "name", Value: in.name}, {Key: "phone", Value: in.phone}}
	ref := bson.D{{Key: "_id", Value: referralID}, {Key: "hostelId", Value: code.HostelID}, {Key: "referralCodeId", Value: code.ID}, {Key: "referrerResidentId", Value: code.ResidentID},
		{Key: "inquiryId", Value: inquiryID}, {Key: "name", Value: in.name}, {Key: "phone", Value: in.phone}}
	if in.hasEmail {
		inq = append(inq, bson.E{Key: "email", Value: in.email})
		ref = append(ref, bson.E{Key: "email", Value: in.email})
	}
	if in.hasMessage {
		inq = append(inq, bson.E{Key: "message", Value: in.message})
		ref = append(ref, bson.E{Key: "message", Value: in.message})
	}
	inq = append(inq, bson.E{Key: "source", Value: "PUBLIC_WEBSITE"}, bson.E{Key: "status", Value: "NEW"}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	ref = append(ref, bson.E{Key: "status", Value: "INQUIRY_CREATED"}, bson.E{Key: "converted", Value: false}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.db.Collection("inquiries").InsertOne(c, inq); err != nil {
		return nil, err
	}
	if _, err := refs.InsertOne(c, ref); err != nil {
		return nil, err
	}
	var email, message any = "", ""
	if in.hasEmail {
		email = in.email
	}
	if in.hasMessage {
		message = in.message
	}
	return ordered.Map{
		{Key: "inquiry", Value: ordered.Map{{Key: "id", Value: inquiryID.Hex()}, {Key: "status", Value: "NEW"}}},
		{Key: "referral", Value: ordered.Map{
			{Key: "confirmedAt", Value: ordered.Undefined}, {Key: "confirmedBy", Value: ordered.Undefined}, {Key: "converted", Value: false},
			{Key: "convertedAt", Value: ordered.Undefined}, {Key: "createdAt", Value: httpx.ISO(now)}, {Key: "email", Value: email}, {Key: "hostelId", Value: code.HostelID.Hex()},
			{Key: "id", Value: referralID.Hex()}, {Key: "inquiryId", Value: inquiryID.Hex()}, {Key: "joinedResidentId", Value: ordered.Undefined}, {Key: "message", Value: message},
			{Key: "name", Value: in.name}, {Key: "phone", Value: in.phone}, {Key: "referralCodeId", Value: code.ID.Hex()}, {Key: "referrerResidentId", Value: code.ResidentID.Hex()},
			{Key: "status", Value: "INQUIRY_CREATED"}, {Key: "updatedAt", Value: httpx.ISO(now)},
		}},
	}, nil
}
