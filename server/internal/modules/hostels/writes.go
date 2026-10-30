package hostels

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Writes are the public hostel routes that record something: listing
// appearances and page views (hostel-impression.service.ts, hostel-view.service.ts).
type Writes struct {
	db       *mongo.Database
	guards   *authz.Guards
	limiter  *ratelimit.Limiter
	secure   bool
	pub      *Public
	mail     *email.Sender
	notify   *notifications.Service
	rt       *realtime.Client
	cache    realtime.Bumper
	outbound string
}

// WriteDeps are what the public hostel writes lean on.
type WriteDeps struct {
	DB       *mongo.Database
	Guards   *authz.Guards
	Limiter  *ratelimit.Limiter
	Secure   bool // the visitor cookie's Secure flag (NODE_ENV === "production")
	Public   *Public
	Mail     *email.Sender
	Notify   *notifications.Service
	RT       *realtime.Client
	Cache    realtime.Bumper
	Outbound string // outboundUrl(): where links in mail point
}

func NewWrites(d WriteDeps) *Writes {
	return &Writes{d.DB, d.Guards, d.Limiter, d.Secure, d.Public, d.Mail, d.Notify, d.RT, d.Cache, d.Outbound}
}

func methodNotAllowed(c *gin.Context) { c.AbortWithStatus(http.StatusMethodNotAllowed) }

func (w *Writes) Register(v1 *gin.RouterGroup) {
	p := v1.Group("/public/hostels")
	p.POST("/impressions", w.impressions)
	p.GET("/impressions", methodNotAllowed) // else GET falls into :slug
	p.POST("/:slug/views", w.views)
	p.POST("/:slug/inquiries", w.inquiry)
	p.GET("/:slug/inquiries", methodNotAllowed)
}

type recordedFlag struct {
	Recorded bool `json:"recorded"`
}

// impressions records that these hostels were shown in a result list.
func (w *Writes) impressions(c *gin.Context) {
	if err := w.limiter.Check(c, "hostel-listing-impression", 60, w.limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var ids []string
	if items, ok := f.Array("hostelIds", false, false); ok {
		aborted := false
		for i, v := range items {
			s, isStr := v.(string)
			if !isStr {
				aborted = true
				f.Is.Add("hostelIds."+itoa(i), valid.Type("string", valid.Received(v, false)))
				continue
			}
			ids = append(ids, s)
		}
		f.Size("hostelIds", len(items), 1, 60, "", aborted)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := w.recordAppearances(c, ids, time.Now()); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, recordedFlag{true}, "Listing appearance recorded")
}

func (w *Writes) recordAppearances(c *gin.Context, hostelIDs []string, now time.Time) error {
	seen := map[string]bool{}
	var models []mongo.WriteModel
	day := bs.CalendarDay(now).Format("2006-01-02")
	for _, s := range hostelIDs {
		id, err := bson.ObjectIDFromHex(s)
		if err != nil || seen[s] || IsDemoRef(s) {
			continue
		}
		seen[s] = true
		models = append(models, mongo.NewUpdateOneModel().SetUpsert(true).
			SetFilter(bson.D{{Key: "day", Value: day}, {Key: "hostelId", Value: id}}).
			SetUpdate(bson.D{{Key: "$inc", Value: bson.D{{Key: "count", Value: 1}}}}))
	}
	if len(models) == 0 {
		return nil
	}
	_, err := w.db.Collection("hostellistingimpressions").BulkWrite(c, models, options.BulkWrite().SetOrdered(false))
	return err
}

const (
	visitorCookie = "hh_visitor"
	visitorMaxAge = 60 * 60 * 24 * 365
	// A refresh, a back-navigation or a second look within this window counts once.
	dedupeWindow = 30 * time.Minute
)

var visitorKeyRe = regexp.MustCompile(`(?i)^[a-f\d]{32}$`)

// resolveVisitorKey accepts an existing cookie value, or mints one.
func resolveVisitorKey(cookie string) (key string, isNew bool) {
	if visitorKeyRe.MatchString(cookie) {
		return cookie, false
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b), true
}

type viewResult struct {
	Counted   bool                `json:"counted"`
	HostelID  string              `json:"hostelId"`
	Prompt    users.ProfilePrompt `json:"prompt"`
	ViewCount int64               `json:"viewCount"`
}

// views counts a visit to a hostel's public page and, in the same round trip,
// answers whether to offer the one-time resident profile.
func (w *Writes) views(c *gin.Context) {
	if err := w.limiter.Check(c, "hostel-page-view", 60, w.limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	p, err := w.guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID := ""
	if p != nil {
		userID = p.UserID
	}
	key, isNew := resolveVisitorKey(auth.CookieValue(c.Request, visitorCookie))
	out, err := w.recordView(c, c.Param("slug"), c.GetHeader("Referer"), c.GetHeader("User-Agent"), userID, key)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if isNew {
		auth.SetCookie(c.Writer.Header(), visitorCookie, key, visitorMaxAge, "/", "", w.secure, time.Now())
	}
	httpx.OK(c, out, "View recorded")
}

func clip(s string, n int) string {
	// String#slice(0, n) counts UTF-16 units; a Go rune is one or two of them.
	units := 0
	for i, r := range s {
		u := 1
		if r > 0xFFFF {
			u = 2
		}
		if units+u > n {
			return s[:i]
		}
		units += u
	}
	return s
}

func (w *Writes) recordView(c *gin.Context, ref, referrer, userAgent, userID, visitorKey string) (viewResult, error) {
	var filter bson.D
	if id, err := bson.ObjectIDFromHex(ref); err == nil {
		filter = bson.D{{Key: "_id", Value: id}}
	} else {
		filter = bson.D{{Key: "slug", Value: ref}}
	}
	var hostel struct {
		ID              bson.ObjectID `bson:"_id"`
		PublicViewCount int64         `bson:"publicViewCount"`
	}
	err := w.db.Collection("hostels").FindOne(c, append(filter, visible()...),
		options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "publicViewCount", Value: 1}, {Key: "slug", Value: 1}})).Decode(&hostel)
	if err == mongo.ErrNoDocuments {
		return viewResult{}, errNotFound
	}
	if err != nil {
		return viewResult{}, err
	}
	views := w.db.Collection("hostelpageviews")
	recent, err := views.CountDocuments(c, bson.D{{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: time.Now().Add(-dedupeWindow)}}},
		{Key: "hostelId", Value: hostel.ID}, {Key: "visitorKey", Value: visitorKey}}, options.Count().SetLimit(1))
	if err != nil {
		return viewResult{}, err
	}
	counted := recent == 0
	if counted {
		row := bson.D{{Key: "hostelId", Value: hostel.ID}, {Key: "userId", Value: nil}}
		if uid, err := bson.ObjectIDFromHex(userID); err == nil {
			row[1].Value = uid
		}
		row = append(row, bson.E{Key: "visitorKey", Value: visitorKey})
		if referrer != "" {
			row = append(row, bson.E{Key: "referrer", Value: clip(referrer, 300)})
		}
		if userAgent != "" {
			sum := sha256.Sum256([]byte(userAgent))
			row = append(row, bson.E{Key: "userAgent", Value: hex.EncodeToString(sum[:])[:32]})
		}
		row = append(row, bson.E{Key: "createdAt", Value: time.Now().UTC()}, bson.E{Key: "__v", Value: 0})
		if _, err := views.InsertOne(c, row); err != nil {
			return viewResult{}, err
		}
		if _, err := w.db.Collection("hostels").UpdateOne(c, bson.D{{Key: "_id", Value: hostel.ID}},
			bson.D{{Key: "$inc", Value: bson.D{{Key: "publicViewCount", Value: 1}}}}); err != nil {
			return viewResult{}, err
		}
	}
	prompt, err := users.EvaluateProfilePrompt(c, w.db, userID, visitorKey)
	if err != nil {
		return viewResult{}, err
	}
	count := hostel.PublicViewCount
	if counted {
		count++
	}
	return viewResult{counted, hostel.ID.Hex(), prompt, count}, nil
}
