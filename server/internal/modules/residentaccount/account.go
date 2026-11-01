// Package residentaccount is what turns an account into a resident: activation
// codes and the "your hostel added you" invite. Separate from residents because
// both answers carry a fresh session, which only the auth module can issue.
package residentaccount

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	authmod "github.com/softmato/hostelpalika/server/internal/modules/auth"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB               *mongo.Database
	Guards           *authz.Guards
	Auth             *authmod.Service
	Cookies          *auth.Cookies
	Audit            *audit.Log
	Notify           *notifications.Service
	Mail             *email.Sender
	ActivationSecret string
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.POST("/resident/activate", h.activate)
	v1.GET("/resident/activation-status", httpx.ETag(), h.status)
	v1.GET("/account/residency-invite", httpx.ETag(), h.invite)
	v1.POST("/account/residency-invite/:residentId/accept", h.accept)
	v1.POST("/account/residency-invite/:residentId/decline", h.decline)
}

func (h *Handler) hash(code string) string {
	return auth.HashToken(strings.ToUpper(valid.Trim(code)) + ":" + h.ActivationSecret)
}

type activationRow struct {
	ID         bson.ObjectID  `bson:"_id"`
	CreatedAt  *time.Time     `bson:"createdAt"`
	CreatedBy  bson.ObjectID  `bson:"createdBy"`
	ExpiresAt  time.Time      `bson:"expiresAt"`
	HostelID   bson.ObjectID  `bson:"hostelId"`
	ResidentID bson.ObjectID  `bson:"residentId"`
	Status     string         `bson:"status"`
	UsedAt     *time.Time     `bson:"usedAt"`
	UsedBy     *bson.ObjectID `bson:"usedBy"`
}

func serializeActivation(a *activationRow) ordered.Map {
	date := func(t *time.Time) any {
		if t == nil {
			return ordered.Undefined
		}
		return httpx.ISO(*t)
	}
	usedBy := any(ordered.Undefined)
	if a.UsedBy != nil {
		usedBy = a.UsedBy.Hex()
	}
	return ordered.Map{{Key: "code", Value: ordered.Undefined}, {Key: "createdAt", Value: date(a.CreatedAt)}, {Key: "createdBy", Value: a.CreatedBy.Hex()},
		{Key: "expiresAt", Value: httpx.ISO(a.ExpiresAt)}, {Key: "hostelId", Value: a.HostelID.Hex()}, {Key: "id", Value: a.ID.Hex()}, {Key: "residentId", Value: a.ResidentID.Hex()},
		{Key: "status", Value: a.Status}, {Key: "usedAt", Value: date(a.UsedAt)}, {Key: "usedBy", Value: usedBy}}
}

func fail(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

// findByCode is the newest activation for a code.
func (h *Handler) findByCode(ctx context.Context, code string) (*activationRow, error) {
	var a activationRow
	err := h.DB.Collection("qractivations").FindOne(ctx, bson.D{{Key: "codeHash", Value: h.hash(code)}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&a)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

type activated struct {
	Activation   ordered.Map `json:"activation"`
	AccessToken  string      `json:"accessToken"`
	RefreshToken *string     `json:"refreshToken,omitempty"`
	Resident     ordered.Map `json:"resident"`
	User         any         `json:"user"`
}

func (h *Handler) activate(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	code, _ := f.Str("code", valid.S{Trim: true, Min: 6, Max: 32})
	record := func(key string) any {
		v, present := f.M[key]
		if !present {
			return bson.D{}
		}
		m, ok := v.(map[string]any)
		if !ok {
			f.Hard = true
			f.Is.Add(key, valid.Type("record", valid.Received(v, false)))
			return nil
		}
		return m
	}
	device, session := record("deviceInfo"), record("sessionInfo")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	a, err := h.findByCode(c, code)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if a == nil {
		httpx.Fail(c, fail(400, "ACTIVATION_CODE_INVALID", "Activation code is invalid."))
		return
	}
	if a.Status != "PENDING" || a.UsedAt != nil {
		httpx.Fail(c, fail(409, "ACTIVATION_CODE_USED", "Activation code was already used or cancelled."))
		return
	}
	acts := h.DB.Collection("qractivations")
	if !a.ExpiresAt.After(now) {
		if _, err := acts.UpdateOne(c, bson.D{{Key: "_id", Value: a.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "EXPIRED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.Fail(c, fail(410, "ACTIVATION_CODE_EXPIRED", "Activation code has expired."))
		return
	}
	residentsColl := h.DB.Collection("residents")
	var r residents.Record
	err = residentsColl.FindOne(c, bson.D{{Key: "_id", Value: a.ResidentID}, {Key: "hostelId", Value: a.HostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}}).Decode(&r)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, fail(404, "RESIDENT_NOT_FOUND", "Resident was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if r.UserID != nil && r.UserID.Hex() != p.UserID {
		httpx.Fail(c, fail(409, "RESIDENT_ALREADY_LINKED", "Resident profile is already linked to another account."))
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	err = residentsColl.FindOne(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: r.ID}}}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: uid}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == nil {
		httpx.Fail(c, fail(409, "RESIDENT_ACCOUNT_ALREADY_LINKED", "This account is already linked to another active resident profile."))
		return
	}
	if err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	var updated residents.Record
	err = residentsColl.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "ACTIVE"}, {Key: "updatedBy", Value: uid}, {Key: "userId", Value: uid}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, fail(404, "RESIDENT_NOT_FOUND", "Resident was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := acts.UpdateOne(c, bson.D{{Key: "_id", Value: a.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "deviceInfo", Value: device}, {Key: "sessionInfo", Value: session},
		{Key: "status", Value: "USED"}, {Key: "usedAt", Value: now}, {Key: "usedBy", Value: uid}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	res := h.DB.Collection("users").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: uid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}},
		bson.D{{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: a.HostelID}}}, {Key: "$set", Value: bson.D{{Key: "role", Value: "RESIDENT"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: now}}}})
	if err := res.Err(); err == mongo.ErrNoDocuments {
		httpx.Fail(c, fail(404, "USER_NOT_FOUND", "User account was not found."))
		return
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "RESIDENT_ACTIVATED", ActorID: uid, EntityID: a.ID.Hex(), EntityType: "QRActivation", HostelID: a.HostelID,
		Metadata: bson.D{{Key: "residentId", Value: r.ID.Hex()}, {Key: "userId", Value: p.UserID}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	issued, err := h.Auth.IssueFor(c, uid, c.ClientIP(), c.GetHeader("User-Agent"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if issued == nil {
		httpx.Fail(c, fail(404, "USER_NOT_FOUND", "User account was not found."))
		return
	}
	a.Status, a.UsedAt, a.UsedBy = "USED", &now, &uid
	out := activated{Activation: serializeActivation(a), AccessToken: issued.AccessToken, Resident: residents.Summary(&updated), User: issued.User}
	h.applySession(c, issued, &out.RefreshToken)
	httpx.OK(c, out, "Resident activated")
}

// applySession is the session half of every sign-in: tokens to the app in the
// body, cookies to a browser.
func (h *Handler) applySession(c *gin.Context, issued *authmod.Issued, refresh **string) {
	if strings.ToLower(c.GetHeader("x-hostelhub-client")) == "mobile" {
		*refresh = &issued.RefreshToken
		return
	}
	h.Cookies.ApplySession(c.Writer.Header(), issued.AccessToken, issued.RefreshToken)
}

type target struct {
	Area       string  `json:"area"`
	City       string  `json:"city"`
	HostelName string  `json:"hostelName"`
	PhotoURL   *string `json:"photoUrl"`
	RoomType   string  `json:"roomType"`
	Verified   bool    `json:"verified"`
}

type statusOut struct {
	Activation  any  `json:"activation"`
	IsActivated bool `json:"isActivated"`
	Resident    any  `json:"resident"`
	Target      any  `json:"target"`
}

func (h *Handler) status(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(queryAsBody(valid.Query(c)))
	code, hasCode := f.Str("code", valid.S{Opt: true, Trim: true, Min: 6, Max: 32})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var r residents.Record
	err = h.DB.Collection("residents").FindOne(c, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: uid}}).Decode(&r)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	out := statusOut{IsActivated: err == nil}
	if err == nil {
		out.Resident = residents.Summary(&r)
	}
	if hasCode {
		a, err := h.findByCode(c, code)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if a != nil {
			out.Activation = serializeActivation(a)
			if out.Target, err = h.describe(c, a); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
	}
	httpx.OK(c, out, "Activation status loaded")
}

func queryAsBody(q map[string]string) any {
	m := map[string]any{}
	for k, v := range q {
		m[k] = v
	}
	return m
}

func (h *Handler) describe(ctx context.Context, a *activationRow) (any, error) {
	var hostel struct {
		Location struct {
			Area string `bson:"area"`
			City string `bson:"city"`
		} `bson:"location"`
		Name               string   `bson:"name"`
		Photos             bson.Raw `bson:"photos"`
		VerificationStatus string   `bson:"verificationStatus"`
	}
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: a.HostelID}}).Decode(&hostel)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r struct {
		RoomType string `bson:"roomType"`
	}
	if err := h.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: a.ResidentID}}).Decode(&r); err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	return target{hostel.Location.Area, hostel.Location.City, hostel.Name, hostels.ExteriorPhoto(hostel.Photos), r.RoomType, hostel.VerificationStatus == "VERIFIED"}, nil
}

// --- the invite ---------------------------------------------------------------

type inviteOut struct {
	Invite any `json:"invite"`
}

type invite struct {
	DueAmount  float64 `json:"dueAmount"`
	FirstName  string  `json:"firstName"`
	HostelName string  `json:"hostelName"`
	PaidTill   *string `json:"paidTill"`
	ResidentID string  `json:"residentId"`
	RoomType   string  `json:"roomType"`
}

// asking is askingAccount: a verified, active PUBLIC account is the only one a
// hostel's spreadsheet is looking for. "" when this account is not asked.
func (h *Handler) asking(ctx context.Context, userID string) (string, error) {
	id, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return "", err
	}
	var u struct {
		Email           string     `bson:"email"`
		EmailVerified   bool       `bson:"emailVerified"`
		EmailVerifiedAt *time.Time `bson:"emailVerifiedAt"`
		Role            string     `bson:"role"`
		Status          string     `bson:"status"`
	}
	err = h.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u)
	if err == mongo.ErrNoDocuments {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	email := strings.ToLower(valid.Trim(u.Email))
	if email == "" || !(u.EmailVerified || u.EmailVerifiedAt != nil) || u.Role != "PUBLIC" || u.Status != "ACTIVE" {
		return "", nil
	}
	return email, nil
}

func unlinkedFilter(email string) bson.D {
	return bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "userId", Value: nil}}, bson.D{{Key: "userId", Value: bson.D{{Key: "$exists", Value: false}}}}}},
		{Key: "accountLinkDeclinedAt", Value: nil}, {Key: "email", Value: email}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}}
}

var bsSuffix = regexp.MustCompile(`\s*BS$`)

func (h *Handler) invite(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	found, err := h.findInvite(c, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, inviteOut{found}, "Invite loaded")
}

func (h *Handler) findInvite(ctx context.Context, userID string) (any, error) {
	email, err := h.asking(ctx, userID)
	if err != nil || email == "" {
		return nil, err
	}
	var r struct {
		ID        bson.ObjectID `bson:"_id"`
		FirstName string        `bson:"firstName"`
		HostelID  bson.ObjectID `bson:"hostelId"`
		PaidTill  string        `bson:"paidTill"`
		RoomType  string        `bson:"roomType"`
	}
	err = h.DB.Collection("residents").FindOne(ctx, unlinkedFilter(email), options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&r)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var hostel struct {
		Name string `bson:"name"`
	}
	err = h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: r.HostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&hostel)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cur, err := h.DB.Collection("invoices").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"OPEN", "PARTIAL", "OVERDUE"}}}}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$totalAmount"}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var dues []struct {
		Total float64 `bson:"total"`
	}
	if err := cur.All(ctx, &dues); err != nil {
		return nil, err
	}
	out := invite{FirstName: r.FirstName, HostelName: valid.Trim(hostel.Name), ResidentID: r.ID.Hex(), RoomType: r.RoomType}
	if out.HostelName == "" {
		out.HostelName = "Your hostel"
	}
	if len(dues) > 0 {
		out.DueAmount = dues[0].Total
	}
	if r.PaidTill != "" {
		label := bs.FormatPeriod(r.PaidTill)
		if label == "" {
			label = r.PaidTill
		}
		label = bsSuffix.ReplaceAllString(label, "")
		out.PaidTill = &label
	}
	return out, nil
}

// answering is residentForAnswer: the row must still be open for this address.
func (h *Handler) answering(ctx context.Context, userID, residentID string) (string, *residents.Record, error) {
	id, err := bson.ObjectIDFromHex(residentID)
	if err != nil {
		return "", nil, fail(404, "RESIDENCY_INVITE_NOT_FOUND", "This invite was not found.")
	}
	email, err := h.asking(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	if email == "" {
		return "", nil, fail(403, "RESIDENCY_INVITE_NOT_FOR_YOU", "Sign in with the email your hostel has for you.")
	}
	var r residents.Record
	err = h.DB.Collection("residents").FindOne(ctx, append(bson.D{{Key: "_id", Value: id}}, unlinkedFilter(email)...)).Decode(&r)
	if err == mongo.ErrNoDocuments {
		return "", nil, fail(404, "RESIDENCY_INVITE_NOT_FOUND", "This invite is no longer open. Ask your hostel if this is a mistake.")
	}
	if err != nil {
		return "", nil, err
	}
	return email, &r, nil
}

type accepted struct {
	AccessToken  string  `json:"accessToken"`
	RefreshToken *string `json:"refreshToken,omitempty"`
	ResidentID   string  `json:"residentId"`
	User         any     `json:"user"`
}

func (h *Handler) accept(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	email, r, err := h.answering(c, p.UserID, c.Param("residentId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if reason := h.link(c, r, uid, email); reason != "" {
		msg := "We could not connect your account. Ask your hostel for an activation code."
		if reason == "ACCOUNT_ALREADY_LINKED" {
			msg = "This account is already a resident somewhere else. Ask your old hostel to move you out first."
		}
		httpx.Fail(c, fail(409, reason, msg))
		return
	}
	issued, err := h.Auth.IssueFor(c, uid, c.ClientIP(), c.GetHeader("User-Agent"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if issued == nil {
		httpx.Fail(c, fail(404, "USER_NOT_FOUND", "Your account was not found."))
		return
	}
	out := accepted{AccessToken: issued.AccessToken, ResidentID: r.ID.Hex(), User: issued.User}
	h.applySession(c, issued, &out.RefreshToken)
	httpx.OK(c, out, "Welcome to your hostel")
}

// link is linkResidentAccount with the account already resolved and no welcome
// mail: "" on success, else the reason. A failed promotion gives the row back.
func (h *Handler) link(ctx context.Context, r *residents.Record, uid bson.ObjectID, addr string) string {
	coll := h.DB.Collection("residents")
	now := time.Now().UTC().Truncate(time.Millisecond)
	hostel, err := residents.HostelName(ctx, h.DB, r.HostelID)
	if err != nil {
		return "ACCOUNT_LINK_FAILED"
	}
	err = coll.FindOne(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: r.ID}}}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: uid}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == nil {
		return "ACCOUNT_ALREADY_LINKED"
	}
	if err != mongo.ErrNoDocuments {
		return "ACCOUNT_LINK_FAILED"
	}
	if _, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "updatedBy", Value: uid}, {Key: "userId", Value: uid}, {Key: "updatedAt", Value: now}}}}); err != nil {
		return "ACCOUNT_LINK_FAILED"
	}
	up, err := residents.PromoteAccountToResident(ctx, h.DB, h.Audit, residents.Promotion{HostelID: r.HostelID, Name: r.FullName(), PerformedBy: uid, Phone: r.Phone, UserID: uid}, now)
	if err != nil {
		if _, undo := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "userId", Value: uid}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: now}}}, {Key: "$unset", Value: bson.D{{Key: "userId", Value: ""}}}}); undo != nil {
			slog.ErrorContext(ctx, "account link undo failed; the resident stays linked", "resident", r.ID.Hex(), "error", undo)
		}
		if code := httpx.Code(err); code != "" {
			return code
		}
		return "ACCOUNT_LINK_FAILED"
	}
	var clearedRole any
	if up.ClearedRole != "" {
		clearedRole = up.ClearedRole
	} else {
		clearedRole = bson.Null{}
	}
	_ = h.Audit.Write(ctx, audit.Entry{Action: "RESIDENT_ACCOUNT_LINKED", ActorID: uid, EntityID: r.ID.Hex(), EntityType: "Resident", HostelID: r.HostelID,
		Metadata: bson.D{{Key: "clearedMemberships", Value: len(up.ClearedMemberships)}, {Key: "clearedRole", Value: clearedRole}, {Key: "email", Value: addr}, {Key: "upgraded", Value: up.Upgraded}}})
	if up.Cleared() {
		content := email_(up, hostel, r.FirstName)
		h.Mail.Send(ctx, email.Message{Category: content.Category, To: []string{addr}, Subject: content.Subject, HTML: content.HTML})
	}
	return ""
}

func email_(up residents.Promoted, hostel, name string) email.Content {
	rows := make([]email.ClearedMembership, len(up.ClearedMemberships))
	for i, m := range up.ClearedMemberships {
		rows[i] = email.ClearedMembership{HostelName: m.HostelName, Role: m.Role}
	}
	return email.ResidentAccessCleared(rows, up.ClearedRole, hostel, up.ActivatedInvite, name)
}

type declined struct {
	Declined bool `json:"declined"`
}

// decline is "This is not me": the question stops, the hostel is told the
// address is probably wrong, and nothing about the bills changes.
func (h *Handler) decline(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	_, r, err := h.answering(c, p.UserID, c.Param("residentId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := h.DB.Collection("residents").UpdateOne(c, bson.D{{Key: "_id", Value: r.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "accountLinkDeclinedAt", Value: now}, {Key: "accountLinkDeclinedBy", Value: uid}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if staff, err := residents.HostelStaffUserIDs(c, h.DB, r.HostelID, false); err == nil {
		name := r.FullName()
		for _, id := range staff {
			_, _ = h.Notify.CreateInApp(c, notifications.Input{ActionURL: "/hostel-admin/residents",
				Body:     "Someone signed in with " + r.Email + " and said they are not " + name + ". Check the email on their record.",
				Category: "RESIDENT", Data: ordered.Map{{Key: "residentId", Value: r.ID.Hex()}}, HostelID: r.HostelID.Hex(), Title: "Check " + name + "'s email", UserID: id})
		}
	}
	httpx.OK(c, declined{true}, "Noted")
}
