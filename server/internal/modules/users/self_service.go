package users

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// SelfService is the rest of /users: expert consultation requests and
// temporary logins (expert-consultation.service.ts, temporary-credential.service.ts).
type SelfService struct {
	DB      *mongo.Database
	Guards  *authz.Guards
	Limiter *ratelimit.Limiter
	Mail    *email.Sender
	Audit   *audit.Log
	// HasProfile is the resident identity's hasProfile (hostelresidents).
	HasProfile   func(ctx context.Context, user bson.ObjectID) (bool, error)
	SupportEmail func(ctx context.Context) string
	Now          func() time.Time
}

func (s *SelfService) Register(v1 *gin.RouterGroup) {
	v1.GET("/users/expert-consultation-requests", httpx.ETag(), s.myConsultation)
	v1.POST("/users/expert-consultation-requests", s.createConsultation)
	v1.GET("/users/temporary-credentials", httpx.ETag(), s.listCredentials)
	v1.POST("/users/temporary-credentials", s.createCredential)
	v1.DELETE("/users/temporary-credentials/:id", s.revokeCredential)
}

func (s *SelfService) myConsultation(c *gin.Context) {
	p, err := s.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	var r struct {
		ID               bson.ObjectID `bson:"_id"`
		BudgetRange      *string       `bson:"budgetRange"`
		CreatedAt        *time.Time    `bson:"createdAt"`
		Environment      *string       `bson:"environment"`
		LikedSpots       *string       `bson:"likedSpots"`
		PreferredCollege *string       `bson:"preferredCollege"`
	}
	err = s.DB.Collection("expertconsultationrequests").FindOne(c, bson.D{{Key: "userId", Value: uid}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.OK(c, ordered.Map{{Key: "request", Value: nil}}, "Consultation request loaded")
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "request", Value: ordered.Map{{Key: "budgetRange", Value: r.BudgetRange}, {Key: "createdAt", Value: iso(r.CreatedAt)}, {Key: "environment", Value: r.Environment}, {Key: "id", Value: r.ID.Hex()}, {Key: "likedSpots", Value: r.LikedSpots}, {Key: "preferredCollege", Value: r.PreferredCollege}}}}, "Consultation request loaded")
}

func (s *SelfService) createConsultation(c *gin.Context) {
	p, err := s.Guards.Require(c)
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
	type field struct {
		key, label string
		o          valid.S
	}
	// Declared order is the schema's; the email's row order is below.
	fields := []field{{"budgetRange", "Budget", valid.S{Opt: true, Trim: true, Max: 80}}, {"email", "Email", valid.S{Opt: true, Trim: true, Email: true}},
		{"environment", "Environment", valid.S{Opt: true, Trim: true, Max: 120}}, {"fullName", "Name", valid.S{Trim: true, Min: 2, Max: 120}},
		{"likedSpots", "Liked spots", valid.S{Opt: true, Trim: true, Max: 500}}, {"phone", "Phone", valid.S{Trim: true, Min: 7, Max: 24}},
		{"preferredCollege", "Preferred college", valid.S{Opt: true, Trim: true, Max: 160}}}
	got := map[string]string{}
	for _, fl := range fields {
		if v, ok := f.Str(fl.key, fl.o); ok {
			got[fl.key] = v
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	ok, err := s.HasProfile(c, uid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !ok {
		httpx.Fail(c, httpx.NewError(422, "PROFILE_INCOMPLETE", "Save your resident profile first so our team knows who to call.", nil))
		return
	}
	now := s.Now().UTC().Truncate(time.Millisecond)
	doc := bson.D{{Key: "userId", Value: uid}}
	for _, k := range []string{"fullName", "phone", "email", "budgetRange", "environment", "preferredCollege", "likedSpots"} {
		if v, ok := got[k]; ok {
			doc = append(doc, bson.E{Key: k, Value: v})
		}
	}
	id := bson.NewObjectID()
	doc = append(bson.D{{Key: "_id", Value: id}}, append(doc, bson.E{Key: "status", Value: "NEW"}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})...)
	if _, err := s.DB.Collection("expertconsultationrequests").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	// The team's heads-up never fails the visitor's request.
	if to := s.SupportEmail(c); to != "" {
		var rows []email.DetailRow
		for _, k := range [][2]string{{"fullName", "Name"}, {"phone", "Phone"}, {"email", "Email"}, {"budgetRange", "Budget"}, {"environment", "Environment"}, {"preferredCollege", "Preferred college"}, {"likedSpots", "Liked spots"}} {
			if v := got[k[0]]; v != "" {
				rows = append(rows, email.DetailRow{Label: k[1], Value: v})
			}
		}
		content := email.ConsultationRequest(rows, got["fullName"])
		s.Mail.Send(c, email.Message{To: []string{to}, Subject: content.Subject, HTML: content.HTML}) // the sender logs its own failures

	}
	httpx.OK(c, ordered.Map{{Key: "id", Value: id.Hex()}}, "Request sent — our team will call you soon.")
}

// MaxTemporaryCredentials is MAX_ACTIVE_TEMPORARY_CREDENTIALS.
const MaxTemporaryCredentials = 5

var tempUsername = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)

type credentialRow struct {
	ID         bson.ObjectID `bson:"_id"`
	CreatedAt  *time.Time    `bson:"createdAt"`
	ExpiresAt  time.Time     `bson:"expiresAt"`
	Label      *string       `bson:"label"`
	LastUsedAt *time.Time    `bson:"lastUsedAt"`
	RevokedAt  *time.Time    `bson:"revokedAt"`
	UseCount   int           `bson:"useCount"`
	Username   string        `bson:"username"`
}

func (r credentialRow) out(now time.Time) ordered.Map {
	status := "EXPIRED"
	switch {
	case r.RevokedAt != nil:
		status = "REVOKED"
	case r.ExpiresAt.After(now):
		status = "ACTIVE"
	}
	label := ""
	if r.Label != nil {
		label = *r.Label
	}
	return ordered.Map{{Key: "createdAt", Value: iso(r.CreatedAt)}, {Key: "expiresAt", Value: httpx.ISO(r.ExpiresAt)}, {Key: "id", Value: r.ID.Hex()}, {Key: "label", Value: label}, {Key: "lastUsedAt", Value: iso(r.LastUsedAt)}, {Key: "revokedAt", Value: iso(r.RevokedAt)}, {Key: "status", Value: status}, {Key: "useCount", Value: r.UseCount}, {Key: "username", Value: r.Username}}
}

func (s *SelfService) primary(c *gin.Context) (*authz.Principal, bool) {
	p, err := s.Guards.Require(c)
	if err == nil {
		err = authz.AssertPrimaryCredential(p)
	}
	if err != nil {
		httpx.Fail(c, err)
		return nil, false
	}
	return p, true
}

func (s *SelfService) listCredentials(c *gin.Context) {
	p, ok := s.primary(c)
	if !ok {
		return
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	cur, err := s.DB.Collection("temporarycredentials").Find(c, bson.D{{Key: "userId", Value: uid}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(50))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []credentialRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	now := s.Now()
	out := make([]ordered.Map, len(rows))
	for i, r := range rows {
		out[i] = r.out(now)
	}
	httpx.OK(c, ordered.Map{{Key: "credentials", Value: out}, {Key: "limit", Value: MaxTemporaryCredentials}}, "Temporary logins")
}

var errUsernameTaken = httpx.NewError(409, "TEMPORARY_CREDENTIAL_USERNAME_TAKEN", "That username is already taken. Try another.", nil)

func (s *SelfService) createCredential(c *gin.Context) {
	p, ok := s.primary(c)
	if !ok {
		return
	}
	if err := s.Limiter.AuthAttempts(c, "auth-temporary-credentials"); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	hours, _ := f.Num("expiresInHours", valid.N{Coerce: true, Int: true, Min: valid.P(1), MinMsg: "Pick at least one hour.", Max: valid.P(24 * 30),
		MaxMsg: "Temporary access cannot exceed 30 days.", Default: valid.P(24)})
	// The schema lowercases before its checks (trim().toLowerCase().min().regex()); Str lowers last.
	if u, ok := f.M["username"].(string); ok {
		f.M["username"] = strings.ToLower(u)
	}
	label, hasLabel := f.Str("label",
		valid.S{Opt: true, Trim: true, Max: 80, MaxMsg: "Keep the note under 80 characters."})
	username, _ := f.Str("username", valid.S{Trim: true, Lower: true, Min: 4, MinMsg: "Username must be at least 4 characters.", Max: 32,
		MaxMsg: "Username must be 32 characters or fewer.", Re: tempUsername, ReMsg: "Use letters, digits, dots, dashes or underscores — no spaces and no @."})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	now := s.Now().UTC().Truncate(time.Millisecond)
	coll := s.DB.Collection("temporarycredentials")
	// ponytail: count-then-insert lets two racing creates reach 6; the cap is a
	// persistence brake, not a hard quota. A per-user counter row if that matters.
	n, err := coll.CountDocuments(c, bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: now}}}, {Key: "revokedAt", Value: nil}, {Key: "userId", Value: uid}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if n >= MaxTemporaryCredentials {
		httpx.Fail(c, httpx.NewError(409, "TEMPORARY_CREDENTIAL_LIMIT", "You can have "+strconv.Itoa(MaxTemporaryCredentials)+" active temporary logins at a time. Revoke one first.", nil))
		return
	}
	if err := coll.FindOne(c, bson.D{{Key: "username", Value: username}}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err(); err == nil {
		httpx.Fail(c, errUsernameTaken)
		return
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	password := base64.RawURLEncoding.EncodeToString(raw)
	hash, err := auth.HashPassword(password)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	row := credentialRow{ID: bson.NewObjectID(), CreatedAt: &now, ExpiresAt: now.Add(time.Duration(hours) * time.Hour), Username: username}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "userId", Value: uid}, {Key: "username", Value: username}, {Key: "passwordHash", Value: hash}}
	if hasLabel {
		row.Label = &label
		doc = append(doc, bson.E{Key: "label", Value: label})
	}
	doc = append(doc, bson.E{Key: "expiresAt", Value: row.ExpiresAt}, bson.E{Key: "revokedAt", Value: nil}, bson.E{Key: "lastUsedAt", Value: nil}, bson.E{Key: "useCount", Value: 0},
		bson.E{Key: "createdBy", Value: uid}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := coll.InsertOne(c, doc); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			err = errUsernameTaken // two requests racing for one username: the index decides
		}
		httpx.Fail(c, err)
		return
	}
	// TS let a failed audit write turn into a 500 after the credential existed,
	// losing the only copy of its password; the trail is best-effort here.
	if err := s.Audit.Write(c, audit.Entry{ActorID: uid, Action: "TEMPORARY_CREDENTIAL_CREATED", EntityType: "TemporaryCredential", EntityID: row.ID.Hex(),
		Metadata: bson.D{{Key: "expiresAt", Value: row.ExpiresAt}, {Key: "username", Value: username}}}); err != nil {
		slog.WarnContext(c, "temporary credential audit failed", "category", "security", "error", err)
	}
	httpx.Write(c, http.StatusCreated, ordered.Map{{Key: "credential", Value: row.out(now)}, {Key: "password", Value: password}}, "Temporary login created. Copy the password now — it is not shown again.")
}

func (s *SelfService) revokeCredential(c *gin.Context) {
	p, ok := s.primary(c)
	if !ok {
		return
	}
	notFound := httpx.NewError(404, "TEMPORARY_CREDENTIAL_NOT_FOUND", "Temporary login was not found.", nil)
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, notFound)
		return
	}
	uid, _ := bson.ObjectIDFromHex(p.UserID)
	now := s.Now().UTC().Truncate(time.Millisecond)
	var row credentialRow
	// The credential and the sessions it opened die together (TS wrote them apart).
	err = appmongo.InTx(c, s.DB, func(ctx context.Context) error {
		err := s.DB.Collection("temporarycredentials").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "revokedAt", Value: nil}, {Key: "userId", Value: uid}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: now}, {Key: "updatedAt", Value: now}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return notFound
		}
		if err != nil {
			return err
		}
		_, err = s.DB.Collection("sessions").UpdateMany(ctx, bson.D{{Key: "revokedAt", Value: nil}, {Key: "temporaryCredentialId", Value: id}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: now}, {Key: "updatedAt", Value: now}}}})
		return err
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{ActorID: uid, Action: "TEMPORARY_CREDENTIAL_REVOKED", EntityType: "TemporaryCredential", EntityID: id.Hex(),
		Metadata: bson.D{{Key: "username", Value: row.Username}}}); err != nil {
		slog.WarnContext(c, "temporary credential audit failed", "category", "security", "error", err)
	}
	httpx.OK(c, ordered.Map{{Key: "credential", Value: row.out(now)}}, "Temporary login revoked")
}
