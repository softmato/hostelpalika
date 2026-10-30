// Package hostelreferrals is modules/hostel-referrals: the hostel-to-hostel
// and partner referral codes a registration can carry. So far the settings, the
// code lookup and the registration form's "Check code" preview; the go-live
// rewards land with Phase 8.
package hostelreferrals

import (
	"context"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Error is HostelReferralError: status 422 unless the lookup says otherwise.
func err422(code, msg string) *httpx.Error {
	return httpx.NewError(http.StatusUnprocessableEntity, code, msg, nil)
}

// PlanBonus is whole BS months, then days, added to a plan.
type PlanBonus struct {
	Days   int `json:"days" bson:"days"`
	Months int `json:"months" bson:"months"`
}

// Settings is the "hostel-referrals" platformsettings value.
type Settings struct {
	Enabled bool
	Referee PlanBonus
	// The hostel whose code it was.
	Referrer PlanBonus
}

func defaults() Settings {
	return Settings{Enabled: true, Referee: PlanBonus{0, 1}, Referrer: PlanBonus{0, 1}}
}

// coerceInt is `z.coerce.number().int().min(lo).max(hi)`; ok=false on any failure.
func coerceInt(v any, lo, hi float64) (int, bool) {
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case int32:
		f = float64(x)
	case int64:
		f = float64(x)
	case string:
		f = valid.JSNumber(x)
	case bool:
		if x {
			f = 1
		}
	case nil:
		f = 0
	default:
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < lo || f > hi {
		return 0, false
	}
	return int(f), true
}

// bonus is planBonusSchema over a stored object: a missing day/month is 0.
func bonus(v any) (PlanBonus, bool) {
	m, ok := v.(bson.D)
	if !ok {
		return PlanBonus{}, false
	}
	var b PlanBonus
	for _, e := range m {
		switch e.Key {
		case "days":
			if b.Days, ok = coerceInt(e.Value, 0, 365); !ok {
				return b, false
			}
		case "months":
			if b.Months, ok = coerceInt(e.Value, 0, 24); !ok {
				return b, false
			}
		}
	}
	return b, true
}

// parseSettings is hostelReferralSettingsSchema.safeParse: any failure is the
// shipped defaults.
func parseSettings(v any) Settings {
	out := defaults()
	m, ok := v.(bson.D)
	if v == nil {
		return out
	}
	if !ok {
		return defaults()
	}
	for _, e := range m {
		switch e.Key {
		case "enabled":
			b, isBool := e.Value.(bool)
			if !isBool {
				return defaults()
			}
			out.Enabled = b
		case "referee", "referrer":
			b, ok := bonus(e.Value)
			if !ok {
				return defaults()
			}
			if e.Key == "referee" {
				out.Referee = b
			} else {
				out.Referrer = b
			}
		}
	}
	return out
}

type Service struct{ db *mongo.Database }

func NewService(db *mongo.Database) *Service { return &Service{db} }

// Settings never fails: a bad or missing row is the shipped defaults.
func (s *Service) Settings(ctx context.Context) Settings {
	var row struct {
		Value any `bson:"value"`
	}
	if err := s.db.Collection("platformsettings").FindOne(ctx, bson.D{{Key: "key", Value: "hostel-referrals"}}).Decode(&row); err != nil {
		return defaults()
	}
	return parseSettings(row.Value)
}

// Resolved is ResolvedReferralCode.
type Resolved struct {
	Code             string
	CodeID           bson.ObjectID
	CommissionType   string
	CommissionValue  float64
	From             string
	Kind             string // HOSTEL | PARTNER
	RefereeReward    PlanBonus
	ReferrerHostelID *bson.ObjectID
	ReferrerOwnerID  *bson.ObjectID
	ReferrerReward   PlanBonus
}

var nonAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

// Normalize is normalizeHostelReferralCode.
func Normalize(raw string) string { return strings.ToUpper(nonAlnum.ReplaceAllString(raw, "")) }

// Resolve is resolveHostelReferralCode: a live code and what it gives, or a 422
// the registration form can show.
func (s *Service) Resolve(ctx context.Context, raw string) (Resolved, error) {
	invalid := err422("REFERRAL_CODE_INVALID", "That referral code is not valid. Check it, or carry on with a normal registration.")
	code := Normalize(raw)
	if len(code) < 4 {
		return Resolved{}, invalid
	}
	var rec struct {
		ID              bson.ObjectID  `bson:"_id"`
		Code            string         `bson:"code"`
		CommissionType  string         `bson:"commissionType"`
		CommissionValue float64        `bson:"commissionValue"`
		HostelID        *bson.ObjectID `bson:"hostelId"`
		Kind            string         `bson:"kind"`
		Name            string         `bson:"name"`
		OfferDays       int            `bson:"offerDays"`
		OfferMonths     int            `bson:"offerMonths"`
	}
	err := s.db.Collection("hostelreferralcodes").FindOne(ctx, bson.D{{Key: "code", Value: code}, {Key: "status", Value: "ACTIVE"}}).Decode(&rec)
	if err == mongo.ErrNoDocuments {
		return Resolved{}, invalid
	}
	if err != nil {
		return Resolved{}, err
	}
	if rec.Kind == "PARTNER" {
		return Resolved{Code: rec.Code, CodeID: rec.ID, CommissionType: rec.CommissionType, CommissionValue: rec.CommissionValue,
			From: rec.Name, Kind: "PARTNER", RefereeReward: PlanBonus{rec.OfferDays, rec.OfferMonths}}, nil
	}
	settings := s.Settings(ctx)
	var hostel struct {
		ID      bson.ObjectID  `bson:"_id"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	var herr error
	if rec.HostelID != nil {
		herr = s.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: *rec.HostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&hostel)
	} else {
		herr = mongo.ErrNoDocuments
	}
	if herr == mongo.ErrNoDocuments {
		return Resolved{}, invalid
	}
	if herr != nil {
		return Resolved{}, herr
	}
	if !settings.Enabled {
		return Resolved{}, err422("REFERRAL_PAUSED", "Hostel referral codes are paused right now. Carry on with a normal registration.")
	}
	hid := hostel.ID
	return Resolved{Code: rec.Code, CodeID: rec.ID, CommissionType: "AMOUNT", From: hostel.Name, Kind: "HOSTEL", RefereeReward: settings.Referee,
		ReferrerHostelID: &hid, ReferrerOwnerID: hostel.OwnerID, ReferrerReward: settings.Referrer}, nil
}

// Describe is describeBonus: "1 month and 10 days", "15 days", "" for nothing.
func Describe(b PlanBonus) string {
	var parts []string
	unit := func(n int, one, many string) {
		if n > 0 {
			if n == 1 {
				parts = append(parts, "1 "+one)
			} else {
				parts = append(parts, strconv.Itoa(n)+" "+many)
			}
		}
	}
	unit(b.Months, "month", "months")
	unit(b.Days, "day", "days")
	return strings.Join(parts, " and ")
}

// Handler is the public code preview.
type Handler struct {
	svc     *Service
	limiter *ratelimit.Limiter
}

func NewHandler(svc *Service, limiter *ratelimit.Limiter) *Handler { return &Handler{svc, limiter} }

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/public/hostel-referral-codes/:code", httpx.ETag(), h.preview)
}

type preview struct {
	Code       string    `json:"code"`
	From       string    `json:"from"`
	Kind       string    `json:"kind"`
	Reward     PlanBonus `json:"reward"`
	RewardText string    `json:"rewardText"`
}

// preview is what the registration form shows once a code checks out.
func (h *Handler) preview(c *gin.Context) {
	if err := h.limiter.PublicForm(c, "hostel-referral-code"); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := h.svc.Resolve(c, c.Param("code"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, preview{r.Code, r.From, r.Kind, r.RefereeReward, Describe(r.RefereeReward)}, "Referral code")
}

// Record is recordHostelReferral: the referral row a registration with a code files.
func (s *Service) Record(ctx context.Context, r Resolved, refereeHostelID bson.ObjectID) error {
	var referrer any
	if r.ReferrerHostelID != nil {
		referrer = *r.ReferrerHostelID
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	bonus := func(b PlanBonus) bson.D {
		return bson.D{{Key: "days", Value: b.Days}, {Key: "months", Value: b.Months}}
	}
	_, err := s.db.Collection("hostelreferrals").InsertOne(ctx, bson.D{
		{Key: "_id", Value: bson.NewObjectID()}, {Key: "codeId", Value: r.CodeID}, {Key: "code", Value: r.Code}, {Key: "kind", Value: r.Kind},
		{Key: "referrerHostelId", Value: referrer}, {Key: "refereeHostelId", Value: refereeHostelID}, {Key: "status", Value: "PENDING"}, {Key: "liveAt", Value: nil},
		{Key: "refereeReward", Value: bonus(r.RefereeReward)}, {Key: "referrerReward", Value: bonus(r.ReferrerReward)},
		{Key: "refereeAppliedAt", Value: nil}, {Key: "referrerAppliedAt", Value: nil},
		{Key: "commission", Value: bson.D{{Key: "amount", Value: 0}, {Key: "paidAt", Value: nil}, {Key: "status", Value: "NONE"}, {Key: "type", Value: r.CommissionType}, {Key: "value", Value: r.CommissionValue}}},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0},
	})
	return err
}
