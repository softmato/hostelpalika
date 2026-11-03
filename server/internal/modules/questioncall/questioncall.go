// Package questioncall is the server-to-server half of the QuestionCall
// integration (modules/questioncall): QuestionCall's backend trades a
// resident's single-use `hp_code` for who they are, and tells us when a
// referred student signs up. The resident half (click, status) lives in
// residentportal.
package questioncall

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const secretHeader = "x-questioncall-secret"

var objectID = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

type Handler struct {
	DB     *mongo.Database
	Secret string // QUESTIONCALL_WEBHOOK_SECRET, trimmed
	Now    func() time.Time
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/integrations/questioncall", h.requireSecret)
	g.POST("/sso", h.sso)
	g.POST("/conversion", h.conversion)
}

// requireSecret is the shared secret QuestionCall's backend sends in a header
// (never a query param, which would land in access logs).
func (h *Handler) requireSecret(c *gin.Context) {
	if h.Secret == "" {
		httpx.Fail(c, httpx.NewError(http.StatusServiceUnavailable, "INTEGRATION_NOT_CONFIGURED", "QuestionCall webhook is not configured.", nil))
		c.Abort()
		return
	}
	if !crypto.SecretsMatch(strings.TrimSpace(c.GetHeader(secretHeader)), h.Secret) {
		httpx.Fail(c, httpx.NewError(http.StatusUnauthorized, "UNAUTHENTICATED", "Unauthorized", nil))
		c.Abort()
	}
}

type ssoUser struct {
	ID              bson.ObjectID `bson:"_id"`
	Email           string        `bson:"email"`
	EmailVerified   bool          `bson:"emailVerified"`
	EmailVerifiedAt *time.Time    `bson:"emailVerifiedAt"`
	Name            string        `bson:"name"`
	Phone           *string       `bson:"phone"`
	Status          *string       `bson:"status"`
}

func (h *Handler) sso(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	code, _ := f.Str("code", valid.S{Min: 1, Max: 200})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	invalid := httpx.NewError(http.StatusUnauthorized, "QUESTIONCALL_SSO_INVALID", "This sign-in link has expired or was already used.", nil)
	parts := strings.Split(code, ".")
	clickHex, secret := parts[0], ""
	if len(parts) > 1 {
		secret = parts[1]
	}
	if secret == "" || !objectID.MatchString(clickHex) {
		httpx.Fail(c, invalid)
		return
	}
	clickID, _ := bson.ObjectIDFromHex(strings.ToLower(clickHex))
	sum := sha256.Sum256([]byte(secret))
	now := h.Now().UTC().Truncate(time.Millisecond)
	var click struct {
		ID     bson.ObjectID `bson:"_id"`
		UserID bson.ObjectID `bson:"userId"`
	}
	err = h.DB.Collection("questioncallclicks").FindOneAndUpdate(c,
		bson.D{{Key: "_id", Value: clickID}, {Key: "ssoCodeHash", Value: hex.EncodeToString(sum[:])},
			{Key: "ssoExpiresAt", Value: bson.D{{Key: "$gt", Value: now}}}, {Key: "ssoUsedAt", Value: nil}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "ssoUsedAt", Value: now}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetProjection(bson.D{{Key: "userId", Value: 1}}),
	).Decode(&click)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, invalid)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var u ssoUser
	err = h.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: click.UserID}},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "emailVerified", Value: 1}, {Key: "emailVerifiedAt", Value: 1}, {Key: "name", Value: 1}, {Key: "phone", Value: 1}, {Key: "status", Value: 1}}),
	).Decode(&u)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	if err != nil || u.Email == "" || !(u.EmailVerified || u.EmailVerifiedAt != nil) || (u.Status != nil && *u.Status != "ACTIVE") {
		httpx.Fail(c, invalid)
		return
	}
	httpx.OK(c, gin.H{"clickId": click.ID.Hex(), "user": struct {
		Email string  `json:"email"`
		ID    string  `json:"id"`
		Name  string  `json:"name"`
		Phone *string `json:"phone"`
	}{u.Email, u.ID.Hex(), u.Name, u.Phone}}, "QuestionCall sign-in exchanged")
}

func (h *Handler) conversion(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	clickHex, hasClick := f.Str("clickId", valid.S{Opt: true, Re: objectID, ReMsg: "Invalid object id."})
	userHex, hasUser := f.Str("userId", valid.S{Opt: true, Re: objectID, ReMsg: "Invalid object id."})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	var filter bson.D
	switch {
	case hasClick && clickHex != "":
		id, _ := bson.ObjectIDFromHex(strings.ToLower(clickHex))
		filter = bson.D{{Key: "_id", Value: id}}
	case hasUser && userHex != "":
		id, _ := bson.ObjectIDFromHex(strings.ToLower(userHex))
		filter = bson.D{{Key: "userId", Value: id}}
	default:
		httpx.Fail(c, httpx.NewError(http.StatusUnprocessableEntity, "QUESTIONCALL_CONVERSION_TARGET_REQUIRED", "A clickId or userId is required.", nil))
		return
	}
	now := h.Now().UTC().Truncate(time.Millisecond)
	res, err := h.DB.Collection("questioncallclicks").UpdateMany(c,
		append(filter, bson.E{Key: "converted", Value: bson.D{{Key: "$ne", Value: true}}}),
		bson.D{{Key: "$set", Value: bson.D{{Key: "conversionTrackedAt", Value: now}, {Key: "converted", Value: true}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"updated": res.ModifiedCount}, "QuestionCall conversion recorded")
}
