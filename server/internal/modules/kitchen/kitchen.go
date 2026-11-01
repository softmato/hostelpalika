// Package kitchen is food's daily side: the resident's food page and feedback,
// and the cook portal (today's brief, calling a meal, photos, invitations).
package kitchen

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/food"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Cache  *cache.Cache
	Notify *notifications.Service
	Push   *push.Sender
	Audit  *audit.Log
	Config *platformconfig.Service
	RT     *realtime.Client
	Issuer *users.Issuer
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/resident/food", h.residentFood)
	v1.POST("/resident/food/feedback", h.feedback)
	v1.POST("/resident/food/photos", h.residentPhoto)
	v1.POST("/cook/accept-invitation", h.accept)
	v1.GET("/cook/today", h.today)
	v1.GET("/cook/residents", h.residents)
	v1.GET("/cook/food-ready", h.readyLogs)
	v1.POST("/cook/food-ready", h.announce)
	v1.GET("/cook/food-photos", httpx.ETag(), h.photos)
	v1.POST("/cook/food-photos", h.cookPhoto)
}

var mealTypes = []string{"BREAKFAST", "LUNCH", "SNACKS", "DINNER"}

type photoRow struct {
	ID         bson.ObjectID  `bson:"_id"`
	Caption    string         `bson:"caption"`
	Date       time.Time      `bson:"date"`
	HostelID   bson.ObjectID  `bson:"hostelId"`
	MealType   string         `bson:"mealType"`
	PhotoAsset string         `bson:"photoAssetId"`
	ResidentID *bson.ObjectID `bson:"residentId"`
	UploadedAt time.Time      `bson:"uploadedAt"`
	UploadedBy *bson.ObjectID `bson:"uploadedBy"`
}

func (p *photoRow) out() ordered.Map {
	res, by := any(ordered.Undefined), ""
	if p.ResidentID != nil {
		res = p.ResidentID.Hex()
	}
	if p.UploadedBy != nil {
		by = p.UploadedBy.Hex()
	}
	return ordered.Map{{Key: "caption", Value: p.Caption}, {Key: "date", Value: httpx.ISO(p.Date)}, {Key: "hostelId", Value: p.HostelID.Hex()}, {Key: "id", Value: p.ID.Hex()}, {Key: "mealType", Value: p.MealType},
		{Key: "photoAssetId", Value: p.PhotoAsset}, {Key: "residentId", Value: res}, {Key: "uploadedAt", Value: httpx.ISO(p.UploadedAt)}, {Key: "uploadedBy", Value: by}}
}

type foodOut struct {
	Photos   []ordered.Map `json:"photos"`
	Resident ordered.Map   `json:"resident"`
	Routine  ordered.Map   `json:"routine"`
}

func (h *Handler) residentFood(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, "resident-food", "Resident food loaded", func() (foodOut, error) {
		r, err := residents.Current(c, h.DB, p)
		if err != nil {
			return foodOut{}, err
		}
		routine, err := food.Routine(c, h.DB, r.HostelID)
		if err != nil {
			return foodOut{}, err
		}
		cur, err := h.DB.Collection("foodphotos").Find(c, bson.D{{Key: "hostelId", Value: r.HostelID}}, options.Find().SetSort(bson.D{{Key: "date", Value: -1}, {Key: "uploadedAt", Value: -1}}).SetLimit(40))
		if err != nil {
			return foodOut{}, err
		}
		var rows []photoRow
		if err := cur.All(c, &rows); err != nil {
			return foodOut{}, err
		}
		out := foodOut{[]ordered.Map{}, residents.Summary(r), routine}
		for i := range rows {
			out.Photos = append(out.Photos, rows[i].out())
		}
		return out, nil
	})
}

// date is z.coerce.date(): new Date(value), undefined included (which is invalid).
func date(f *valid.Form, key string) time.Time {
	if f.M == nil {
		return time.Time{}
	}
	v, present := f.M[key]
	if present {
		if t, ok := valid.CoerceDate(v); ok {
			return t
		}
	}
	f.Hard = true
	f.Is.Add(key, valid.Type("date", "Date"))
	return time.Time{}
}

type photoInput struct {
	Caption    string
	HasCaption bool
	Date       time.Time
	HostelID   string
	MealType   string
	PhotoAsset string
}

func parsePhoto(body any) (photoInput, error) {
	f := valid.NewForm(body)
	var in photoInput
	if v, present := f.M["hostelId"]; present {
		in.HostelID, _ = valid.ObjectID(v, "hostelId", "", &f.Is, false)
	}
	in.MealType, _ = f.Enum("mealType", false, nil, mealTypes...)
	in.Date = date(f, "date")
	in.PhotoAsset, _ = f.Str("photoAssetId", valid.S{Trim: true, Min: 1, Max: 240})
	in.Caption, in.HasCaption = f.Str("caption", valid.S{Opt: true, Trim: true, Max: 240})
	return in, f.Err()
}

type photoOut struct {
	Photo    ordered.Map `json:"photo"`
	Resident any         `json:"resident"`
}

func (h *Handler) savePhoto(c *gin.Context, p *authz.Principal, in photoInput, hostelID bson.ObjectID, r *residents.Record) {
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := photoRow{ID: bson.NewObjectID(), Date: in.Date, HostelID: hostelID, MealType: in.MealType, PhotoAsset: in.PhotoAsset, UploadedAt: now, UploadedBy: &uid}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "hostelId", Value: hostelID}}
	if r != nil {
		row.ResidentID = &r.ID
		doc = append(doc, bson.E{Key: "residentId", Value: r.ID})
	}
	doc = append(doc, bson.E{Key: "mealType", Value: in.MealType}, bson.E{Key: "date", Value: in.Date}, bson.E{Key: "photoAssetId", Value: in.PhotoAsset})
	if in.HasCaption {
		row.Caption = in.Caption
		doc = append(doc, bson.E{Key: "caption", Value: in.Caption})
	}
	doc = append(doc, bson.E{Key: "uploadedBy", Value: uid}, bson.E{Key: "uploadedAt", Value: now}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("foodphotos").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "FOOD_PHOTO_UPLOADED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "FoodPhoto", HostelID: hostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{hostelID.Hex()}, Topics: []realtime.Topic{realtime.Food}})
	var res any
	if r != nil {
		res = residents.Summary(r)
	}
	httpx.Write(c, 201, photoOut{row.out(), res}, "Food photo uploaded")
}

func (h *Handler) residentPhoto(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parsePhoto(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.savePhoto(c, p, in, r.HostelID, r)
}

type feedbackOut struct {
	Feedback ordered.Map `json:"feedback"`
	Resident ordered.Map `json:"resident"`
}

func (h *Handler) feedback(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
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
	when := date(f, "date")
	meal, _ := f.Enum("mealType", false, nil, mealTypes...)
	rating, _ := f.Num("rating", valid.N{Coerce: true, Int: true, Min: valid.P(1), Max: valid.P(5)})
	comment, hasComment := f.Str("comment", valid.S{Opt: true, Trim: true, Max: 500})
	no := false
	anon, _ := f.Bool("isAnonymous", false, &no)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
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
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "date", Value: when}, {Key: "mealType", Value: meal}, {Key: "rating", Value: rating}}
	if hasComment {
		doc = append(doc, bson.E{Key: "comment", Value: comment})
	}
	doc = append(doc, bson.E{Key: "isAnonymous", Value: anon}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("foodfeedbacks").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "FOOD_FEEDBACK_SUBMITTED", ActorID: uid, EntityID: id.Hex(), EntityType: "FoodFeedback", HostelID: r.HostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{r.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Food}})
	h.lowRating(c, r, meal, rating, comment)
	out := ordered.Map{{Key: "comment", Value: comment}, {Key: "createdAt", Value: httpx.ISO(now)}, {Key: "date", Value: httpx.ISO(when)}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: id.Hex()}, {Key: "isAnonymous", Value: anon},
		{Key: "mealType", Value: meal}, {Key: "menuId", Value: ordered.Undefined}, {Key: "rating", Value: rating}, {Key: "residentId", Value: r.ID.Hex()}}
	httpx.Write(c, 201, feedbackOut{out, residents.Summary(r)}, "Food feedback submitted")
}

// CookUserIDs is resolveHostelCookUserIds.
func (h *Handler) cookUserIDs(ctx context.Context, hostelID bson.ObjectID) ([]string, error) {
	cur, err := h.DB.Collection("cookaccounts").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := []string{}
	for _, x := range rows {
		if x.UserID != nil && !slices.Contains(out, x.UserID.Hex()) {
			out = append(out, x.UserID.Hex())
		}
	}
	return out, nil
}

// lowRating is notifyKitchenOfFoodFeedback: only 2 stars or fewer reach anyone.
func (h *Handler) lowRating(ctx context.Context, r *residents.Record, meal string, rating float64, comment string) {
	if rating > 2 {
		return
	}
	cooks, err := h.cookUserIDs(ctx, r.HostelID)
	if err != nil {
		return
	}
	staff, err := residents.HostelStaffUserIDs(ctx, h.DB, r.HostelID, false)
	if err != nil {
		staff = nil
	}
	hostelName, err := residents.HostelName(ctx, h.DB, r.HostelID)
	if err != nil {
		return
	}
	stars := strconv.FormatFloat(rating, 'f', -1, 64)
	mealName := strings.ToLower(meal)
	text := stars + "/5 for " + mealName + ", with no comment left."
	if c := valid.Trim(comment); c != "" {
		if valid.JSLen(c) > 140 {
			c = valid.JSPrefix(c, 137) + "…"
		}
		text = stars + "/5 for " + mealName + " — “" + c + "”"
	}
	for _, id := range cooks {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{Body: text, Category: "FOOD", Data: ordered.Map{{Key: "audience", Value: "COOK"}}, HostelID: r.HostelID.Hex(), Title: "A resident rated your food", UserID: id})
	}
	for _, id := range staff {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/food", Body: r.FullName() + " at " + hostelName + " — " + text, Category: "FOOD", Data: ordered.Map{{Key: "audience", Value: "STAFF"}}, HostelID: r.HostelID.Hex(), Title: "Low food rating", UserID: id})
	}
}

// --- the cook portal -----------------------------------------------------------

func (h *Handler) staff(c *gin.Context) (*authz.Principal, error) {
	p, err := h.Guards.Require(c)
	if err != nil {
		return nil, err
	}
	return p, authz.AssertRoles(p, authz.Cook, authz.HostelAdmin, authz.Warden)
}

// HostelFor is resolveCookHostelId.
func HostelFor(p *authz.Principal, requested string) (bson.ObjectID, error) {
	id := requested
	if p.Role == authz.Cook {
		if id == "" && len(p.HostelIDs) > 0 {
			id = p.HostelIDs[0]
		}
		if id == "" {
			return bson.ObjectID{}, httpx.NewError(422, "HOSTEL_SCOPE_REQUIRED", "This cook account is not linked to a hostel.", nil)
		}
	} else if id == "" {
		if len(p.HostelIDs) != 1 {
			return bson.ObjectID{}, httpx.NewError(422, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for this hostel admin action.", nil)
		}
		id = p.HostelIDs[0]
	}
	if requested != "" || p.Role == authz.Cook {
		if err := authz.AssertHostelScoped(p, id); err != nil {
			return bson.ObjectID{}, err
		}
	}
	return httpx.OID(id, "hostel id")
}

func scopeOf(p *authz.Principal, requested string) []string {
	if requested != "" {
		return []string{requested}
	}
	return p.HostelIDs
}

type announced struct {
	AnnouncedAt   string `json:"announcedAt"`
	ID            string `json:"id"`
	MealType      string `json:"mealType"`
	Message       string `json:"message"`
	NotifiedCount int    `json:"notifiedCount"`
}

type todayBody struct {
	Announced       []announced `json:"announced"`
	Date            string      `json:"date"`
	Hostel          ordered.Map `json:"hostel"`
	Meals           []any       `json:"meals"`
	Routine         ordered.Map `json:"routine"`
	ResidentCount   int64       `json:"residentCount"`
	ExpensesEnabled bool        `json:"expensesEnabled"`
	StockEnabled    bool        `json:"stockEnabled"`
}

type todayOut struct {
	Today todayBody `json:"today"`
}

const nepalOffset = 345 * time.Minute

func startOfToday() time.Time { return bs.Today(time.Now()).Add(-nepalOffset) }

func (h *Handler) today(c *gin.Context) {
	p, err := h.staff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	requested := c.Query("hostelId")
	cache.Respond(c, h.Cache, scopeOf(p, requested), p.UserID, "cook-today", "Today's kitchen brief loaded", func() (todayOut, error) {
		hostelID, err := HostelFor(p, requested)
		if err != nil {
			return todayOut{}, err
		}
		today := startOfToday()
		var hostel struct {
			ID                 bson.ObjectID  `bson:"_id"`
			Name               string         `bson:"name"`
			Slug               string         `bson:"slug"`
			Status             string         `bson:"status"`
			VerificationStatus string         `bson:"verificationStatus"`
			ParentHostelID     *bson.ObjectID `bson:"parentHostelId"`
		}
		hostelErr := h.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: hostelID}, {Key: "isDeleted", Value: false}}).Decode(&hostel)
		if hostelErr != nil && hostelErr != mongo.ErrNoDocuments {
			return todayOut{}, hostelErr
		}
		routine, err := food.Routine(c, h.DB, hostelID)
		if err != nil {
			return todayOut{}, err
		}
		count, err := h.DB.Collection("residents").CountDocuments(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}})
		if err != nil {
			return todayOut{}, err
		}
		cur, err := h.DB.Collection("foodreadylogs").Find(c, bson.D{{Key: "announcedAt", Value: bson.D{{Key: "$gte", Value: today}}}, {Key: "hostelId", Value: hostelID}}, options.Find().SetSort(bson.D{{Key: "announcedAt", Value: -1}}).SetLimit(12))
		if err != nil {
			return todayOut{}, err
		}
		var logs []logRow
		if err := cur.All(c, &logs); err != nil {
			return todayOut{}, err
		}
		var settings struct {
			Expenses *bool `bson:"cookCanRecordExpenses"`
			Stock    *bool `bson:"cookCanUseStock"`
		}
		if err := h.DB.Collection("hostelsettings").FindOne(c, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&settings); err != nil && err != mongo.ErrNoDocuments {
			return todayOut{}, err
		}
		stock := false
		if settings.Stock == nil || *settings.Stock {
			group := hostelID
			var parent struct {
				Parent *bson.ObjectID `bson:"parentHostelId"`
			}
			if err := h.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: hostelID}}).Decode(&parent); err != nil && err != mongo.ErrNoDocuments {
				return todayOut{}, err
			}
			if parent.Parent != nil {
				group = *parent.Parent
			}
			n, err := h.DB.Collection("stockitems").CountDocuments(c, bson.D{{Key: "active", Value: true}, {Key: "groupHostelId", Value: group}, {Key: "kind", Value: "STORE"}}, options.Count().SetLimit(1))
			if err != nil {
				return todayOut{}, err
			}
			stock = n > 0
		}
		body := todayBody{Announced: []announced{}, Date: bs.Today(time.Now()).Format("2006-01-02"), Meals: food.MealsOn(routine, today), Routine: routine, ResidentCount: count, ExpensesEnabled: settings.Expenses != nil && *settings.Expenses, StockEnabled: stock}
		for _, l := range logs {
			body.Announced = append(body.Announced, announced{httpx.ISO(l.AnnouncedAt), l.ID.Hex(), l.MealType, l.Message, l.NotifiedCount})
		}
		if hostelErr == nil {
			slug := ""
			if hostel.Status == "PUBLISHED" && hostel.VerificationStatus == "VERIFIED" {
				slug = hostel.Slug
			}
			body.Hostel = ordered.Map{{Key: "id", Value: hostel.ID.Hex()}, {Key: "name", Value: hostel.Name}, {Key: "slug", Value: slug}}
		} else {
			body.Hostel = ordered.Map{{Key: "id", Value: hostelID.Hex()}, {Key: "name", Value: "Your hostel"}, {Key: "slug", Value: ""}}
		}
		return todayOut{body}, nil
	})
}

type logRow struct {
	ID            bson.ObjectID  `bson:"_id"`
	AnnouncedAt   time.Time      `bson:"announcedAt"`
	AnnouncedBy   *bson.ObjectID `bson:"announcedBy"`
	MealType      string         `bson:"mealType"`
	Message       string         `bson:"message"`
	NotifiedCount int            `bson:"notifiedCount"`
}

type cookResident struct {
	FullName string `json:"fullName"`
	ID       string `json:"id"`
	RoomType string `json:"roomType,omitempty"`
}

type residentsOut struct {
	Residents []cookResident `json:"residents"`
}

func (h *Handler) residents(c *gin.Context) {
	p, err := h.staff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	requested := c.Query("hostelId")
	cache.Respond(c, h.Cache, scopeOf(p, requested), p.UserID, "cook-residents", "Residents loaded", func() (residentsOut, error) {
		hostelID, err := HostelFor(p, requested)
		if err != nil {
			return residentsOut{}, err
		}
		cur, err := h.DB.Collection("residents").Find(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}},
			options.Find().SetSort(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}).SetLimit(500))
		if err != nil {
			return residentsOut{}, err
		}
		var rows []residents.Record
		if err := cur.All(c, &rows); err != nil {
			return residentsOut{}, err
		}
		out := residentsOut{[]cookResident{}}
		for i := range rows {
			out.Residents = append(out.Residents, cookResident{rows[i].FullName(), rows[i].ID.Hex(), rows[i].RoomType})
		}
		return out, nil
	})
}

// cookLabels is resolveCookLabels: a removed cook shows under their kept name.
func (h *Handler) cookLabels(ctx context.Context, hostelID bson.ObjectID, ids []bson.ObjectID) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection("cookaccounts").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "userId", Value: bson.D{{Key: "$in", Value: ids}}}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		HistoricalName string         `bson:"historicalName"`
		Name           string         `bson:"name"`
		Status         string         `bson:"status"`
		UserID         *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, x := range rows {
		if x.UserID == nil {
			continue
		}
		label := x.Name
		if x.Status == "REMOVED" {
			label = x.HistoricalName
			if label == "" {
				label = "Previous cook"
			}
		}
		out[x.UserID.Hex()] = label
	}
	return out, nil
}

type readyLog struct {
	AnnouncedAt   string `json:"announcedAt"`
	AnnouncedBy   string `json:"announcedBy"`
	ID            string `json:"id"`
	MealType      string `json:"mealType"`
	Message       string `json:"message"`
	NotifiedCount int    `json:"notifiedCount"`
}

type readyLogsOut struct {
	Logs []readyLog `json:"logs"`
}

func (h *Handler) readyLogs(c *gin.Context) {
	p, err := h.staff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	requested := c.Query("hostelId")
	cache.Respond(c, h.Cache, scopeOf(p, requested), p.UserID, "cook-food-ready", "Food ready log loaded", func() (readyLogsOut, error) {
		hostelID, err := HostelFor(p, requested)
		if err != nil {
			return readyLogsOut{}, err
		}
		cur, err := h.DB.Collection("foodreadylogs").Find(c, bson.D{{Key: "hostelId", Value: hostelID}}, options.Find().SetSort(bson.D{{Key: "announcedAt", Value: -1}}).SetLimit(50))
		if err != nil {
			return readyLogsOut{}, err
		}
		var rows []logRow
		if err := cur.All(c, &rows); err != nil {
			return readyLogsOut{}, err
		}
		ids := []bson.ObjectID{}
		for _, l := range rows {
			if l.AnnouncedBy != nil {
				ids = append(ids, *l.AnnouncedBy)
			}
		}
		labels, err := h.cookLabels(c, hostelID, ids)
		if err != nil {
			return readyLogsOut{}, err
		}
		out := readyLogsOut{[]readyLog{}}
		for _, l := range rows {
			by := ""
			if l.AnnouncedBy != nil {
				by = labels[l.AnnouncedBy.Hex()]
			}
			out.Logs = append(out.Logs, readyLog{httpx.ISO(l.AnnouncedAt), by, l.ID.Hex(), l.MealType, l.Message, l.NotifiedCount})
		}
		return out, nil
	})
}

type announcement struct {
	AnnouncedAt        string `json:"announcedAt"`
	ID                 string `json:"id"`
	MealType           string `json:"mealType"`
	Message            string `json:"message"`
	NotifiedCount      int    `json:"notifiedCount"`
	StaffNotifiedCount int    `json:"staffNotifiedCount"`
}

type announceOut struct {
	Announcement announcement `json:"announcement"`
}

func (h *Handler) announce(c *gin.Context) {
	p, err := h.staff(c)
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
	device := map[string]any{}
	if v, present := f.M["deviceInfo"]; present {
		if m, ok := v.(map[string]any); ok {
			device = m
		} else {
			f.Hard = true
			f.Is.Add("deviceInfo", valid.Type("record", valid.Received(v, false)))
		}
	}
	requested := ""
	if v, present := f.M["hostelId"]; present {
		requested, _ = valid.ObjectID(v, "hostelId", "", &f.Is, false)
	}
	meal, _ := f.Enum("mealType", false, nil, mealTypes...)
	message, hasMessage := f.Str("message", valid.S{Opt: true, Trim: true, Max: 240})
	yes := true
	useMenu, _ := f.Bool("useMenuDescription", false, &yes)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := HostelFor(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	routine, err := food.Routine(c, h.DB, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	timings, _ := routine.Get("timings")
	timing := ""
	if m, ok := timings.(ordered.Map); ok {
		if t, ok := m.Get(meal); ok {
			timing, _ = t.(string)
		}
	}
	mealLabel := strings.ToLower(meal)
	switch food.AnnounceState(timing, bs.NepalMinuteOfDay(time.Now())) {
	case "EARLY":
		opens, _ := food.OpensAt(timing)
		httpx.Fail(c, httpx.NewError(409, "MEAL_NOT_DUE", mealLabel+" is not due yet. It can be announced from "+food.FormatMinute(opens)+".", nil))
		return
	case "MISSED":
		closes, _ := food.ClosesAt(timing)
		httpx.Fail(c, httpx.NewError(409, "MEAL_WINDOW_CLOSED", mealLabel+" was not announced in time — it could be called until "+food.FormatMinute(closes)+". Ask the office to change the serving time if it has moved.", nil))
		return
	}
	text := message
	if !hasMessage {
		text = strings.ToUpper(mealLabel[:1]) + mealLabel[1:] + " is ready."
		if useMenu {
			for _, m := range food.MealsOn(routine, startOfToday()) {
				mm, _ := m.(ordered.Map)
				if t, _ := mm.Get("mealType"); t == meal {
					if items, _ := mm.Get("items"); items != nil {
						if list, ok := items.([]any); ok && len(list) > 0 {
							names := make([]string, len(list))
							for i, x := range list {
								names[i], _ = x.(string)
							}
							text = "Today's " + mealLabel + ": " + strings.Join(names, ", ")
						}
					}
				}
			}
		}
	}
	cooldown := h.Config.OperationsTyped(c).FoodReadyCooldownMinutes
	logs := h.DB.Collection("foodreadylogs")
	if cooldown > 0 {
		start := time.Now().Add(-time.Duration(cooldown) * time.Minute)
		var recent struct {
			AnnouncedAt time.Time `bson:"announcedAt"`
		}
		err := logs.FindOne(c, bson.D{{Key: "announcedAt", Value: bson.D{{Key: "$gte", Value: start}}}, {Key: "hostelId", Value: hostelID}, {Key: "mealType", Value: meal}}, options.FindOne().SetSort(bson.D{{Key: "announcedAt", Value: -1}})).Decode(&recent)
		if err == nil {
			remaining := time.Until(recent.AnnouncedAt.Add(time.Duration(cooldown) * time.Minute))
			wait := int(remaining / time.Minute)
			if remaining%time.Minute > 0 {
				wait++
			}
			httpx.Fail(c, httpx.NewError(http.StatusTooManyRequests, "FOOD_READY_COOLDOWN", mealLabel+" was already announced recently. Try again in "+strconv.Itoa(max(1, wait))+" minute(s).", nil))
			return
		}
		if err != mongo.ErrNoDocuments {
			httpx.Fail(c, err)
			return
		}
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	residentN, staffN, err := h.notifyReady(c, p.UserID, device, hostelID, mealLabel, meal, text, now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id := bson.NewObjectID()
	if _, err := logs.InsertOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostelID}, {Key: "mealType", Value: meal}, {Key: "announcedAt", Value: now}, {Key: "announcedBy", Value: uid}, {Key: "message", Value: text},
		{Key: "deviceInfo", Value: device}, {Key: "notifiedCount", Value: residentN}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "FOOD_READY_ANNOUNCED", ActorID: uid, EntityID: id.Hex(), EntityType: "FoodReadyLog", HostelID: hostelID,
		Metadata: bson.D{{Key: "mealType", Value: meal}, {Key: "notifiedCount", Value: residentN}, {Key: "staffNotifiedCount", Value: staffN}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{hostelID.Hex()}, Topics: []realtime.Topic{realtime.Food}})
	httpx.Write(c, 201, announceOut{announcement{httpx.ISO(now), id.Hex(), meal, text, residentN, staffN}}, "Residents notified")
}

func deviceLabel(info map[string]any) string {
	parts := []string{}
	for _, k := range []string{"brand", "model"} {
		if s, ok := info[k].(string); ok && valid.Trim(s) != "" {
			parts = append(parts, valid.Trim(s))
		}
	}
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	if strings.HasPrefix(strings.ToLower(parts[1]), strings.ToLower(parts[0])) {
		return parts[1]
	}
	return parts[0] + " " + parts[1]
}

// notifyReady is notifyFoodReady: one durable row each, then one batched push
// for the whole audience instead of N individual sends.
func (h *Handler) notifyReady(ctx context.Context, actor string, device map[string]any, hostelID bson.ObjectID, mealLabel, meal, message string, at time.Time) (int, int, error) {
	cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}},
		options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
	if err != nil {
		return 0, 0, err
	}
	var rows []struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return 0, 0, err
	}
	staff, err := residents.HostelStaffUserIDs(ctx, h.DB, hostelID, false)
	if err != nil {
		staff = []string{}
	}
	hostelName, err := residents.HostelName(ctx, h.DB, hostelID)
	if err != nil {
		return 0, 0, err
	}
	ids := []string{}
	for _, x := range rows {
		if x.UserID != nil && !slices.Contains(ids, x.UserID.Hex()) {
			ids = append(ids, x.UserID.Hex())
		}
	}
	data := ordered.Map{{Key: "mealType", Value: meal}}
	for _, id := range ids {
		if _, err := h.Notify.CreateInApp(ctx, notifications.Input{Body: message, Category: "FOOD", CreatedBy: actor, Data: data, HostelID: hostelID.Hex(), NoPush: true, Priority: "HIGH", Title: "Food is ready", UserID: id}); err != nil {
			return 0, 0, err
		}
	}
	nepal := at.Add(nepalOffset)
	parts := []string{hostelName + " · " + nepal.Format("15:04") + " · " + strconv.Itoa(len(ids)) + " resident(s) notified."}
	if label := deviceLabel(device); label != "" {
		parts = append(parts, "Announced from "+label+".")
	}
	parts = append(parts, "“"+message+"”")
	staffBody := strings.Join(parts, " ")
	staffTitle := "Kitchen announced " + mealLabel
	staffData := ordered.Map{{Key: "mealType", Value: meal}, {Key: "audience", Value: "STAFF"}}
	for _, id := range staff {
		if _, err := h.Notify.CreateInApp(ctx, notifications.Input{Body: staffBody, Category: "FOOD", CreatedBy: actor, Data: staffData, HostelID: hostelID.Hex(), Kind: "NORMAL", NoPush: true, Priority: "NORMAL", Title: staffTitle, UserID: id}); err != nil {
			return 0, 0, err
		}
	}
	if h.Push != nil {
		if len(ids) > 0 {
			h.Push.ToUsers(ctx, ids, push.Payload{Body: message, Category: "FOOD", Data: map[string]any{"mealType": meal}, HostelID: hostelID.Hex(), Priority: "HIGH", Title: "Food is ready"})
		}
		if len(staff) > 0 {
			h.Push.ToUsers(ctx, staff, push.Payload{Body: staffBody, Category: "FOOD", Data: map[string]any{"mealType": meal, "audience": "STAFF"}, HostelID: hostelID.Hex(), Priority: "NORMAL", Title: staffTitle})
		}
	}
	return len(ids), len(staff), nil
}

// --- photos --------------------------------------------------------------------

const cookPhotoLimit = 120

type cookPhoto struct {
	Caption    string `json:"caption"`
	CookName   string `json:"cookName"`
	Date       string `json:"date"`
	ID         string `json:"id"`
	MealType   string `json:"mealType"`
	PhotoAsset string `json:"photoAssetId"`
	Source     string `json:"source"`
	UploadedAt string `json:"uploadedAt"`
}

type photoDay struct {
	Day          string      `json:"day"`
	MealsCovered int         `json:"mealsCovered"`
	Photos       []cookPhoto `json:"photos"`
}

type photosOut struct {
	Cursor  *string    `json:"cursor"`
	Days    []photoDay `json:"days"`
	HasMore bool       `json:"hasMore"`
	Total   int        `json:"total"`
}

func (h *Handler) photos(c *gin.Context) {
	p, err := h.staff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := HostelFor(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{{Key: "hostelId", Value: hostelID}}
	if cursor := c.Query("cursor"); cursor != "" {
		dateText, uploadedText, _ := strings.Cut(cursor, "|")
		d, ok1 := valid.CoerceDate(dateText)
		u, ok2 := valid.CoerceDate(uploadedText)
		if ok1 && ok2 {
			filter = append(filter, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "date", Value: bson.D{{Key: "$lt", Value: d}}}}, bson.D{{Key: "date", Value: d}, {Key: "uploadedAt", Value: bson.D{{Key: "$lt", Value: u}}}}}})
		}
	}
	cur, err := h.DB.Collection("foodphotos").Find(c, filter, options.Find().SetSort(bson.D{{Key: "date", Value: -1}, {Key: "uploadedAt", Value: -1}}).SetLimit(cookPhotoLimit))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []photoRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := []bson.ObjectID{}
	for _, x := range rows {
		if x.ResidentID == nil && x.UploadedBy != nil {
			ids = append(ids, *x.UploadedBy)
		}
	}
	labels, err := h.cookLabels(c, hostelID, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := photosOut{Days: []photoDay{}, HasMore: len(rows) == cookPhotoLimit, Total: len(rows)}
	index := map[string]int{}
	meals := map[string]map[string]bool{}
	for _, x := range rows {
		key := bs.NepalDayKey(x.Date)
		i, ok := index[key]
		if !ok {
			i = len(out.Days)
			index[key] = i
			out.Days = append(out.Days, photoDay{Day: key})
			meals[key] = map[string]bool{}
		}
		source, cook := "KITCHEN", ""
		if x.ResidentID != nil {
			source = "RESIDENT"
		} else if x.UploadedBy != nil {
			cook = labels[x.UploadedBy.Hex()]
		}
		meals[key][x.MealType] = true
		out.Days[i].MealsCovered = len(meals[key])
		out.Days[i].Photos = append(out.Days[i].Photos, cookPhoto{x.Caption, cook, httpx.ISO(x.Date), x.ID.Hex(), x.MealType, x.PhotoAsset, source, httpx.ISO(x.UploadedAt)})
	}
	if out.HasMore {
		last := rows[len(rows)-1]
		cursor := httpx.ISO(last.Date) + "|" + httpx.ISO(last.UploadedAt)
		out.Cursor = &cursor
	}
	httpx.OK(c, out, "Food photos loaded")
}

func (h *Handler) cookPhoto(c *gin.Context) {
	p, err := h.staff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parsePhoto(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := HostelFor(p, in.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.savePhoto(c, p, in, hostelID, nil)
}

// --- invitations ---------------------------------------------------------------

type acceptedOut struct {
	Accepted       bool   `json:"accepted"`
	AccountCreated bool   `json:"accountCreated"`
	Email          string `json:"email"`
	HostelName     string `json:"hostelName"`
	RequiresLogin  bool   `json:"requiresLogin"`
}

func (h *Handler) accept(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	name, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Min: 2, Max: 120})
	token, _ := f.Str("token", valid.S{Trim: true, Min: 16, Max: 128})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := h.DB.Collection("cookaccounts")
	var cook struct {
		ID                  bson.ObjectID `bson:"_id"`
		HostelID            bson.ObjectID `bson:"hostelId"`
		InvitationExpiresAt *time.Time    `bson:"invitationExpiresAt"`
		LoginEmail          string        `bson:"loginEmail"`
		Name                string        `bson:"name"`
	}
	err = coll.FindOne(c, bson.D{{Key: "invitationToken", Value: token}, {Key: "status", Value: "INVITED"}}).Decode(&cook)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, httpx.NewError(404, "COOK_INVITATION_INVALID", "This invitation is not valid.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if cook.InvitationExpiresAt != nil && cook.InvitationExpiresAt.Before(now) {
		if _, err := coll.UpdateOne(c, bson.D{{Key: "_id", Value: cook.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REMOVED"}, {Key: "updatedAt", Value: now}}}, {Key: "$unset", Value: bson.D{{Key: "invitationToken", Value: ""}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.Fail(c, httpx.NewError(410, "COOK_INVITATION_EXPIRED", "This invitation has expired. Ask the hostel to send a new one.", nil))
		return
	}
	var hostel struct {
		Name *string `bson:"name"`
	}
	err = h.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: cook.HostelID}}).Decode(&hostel)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelName := "Hostel"
	if hostel.Name != nil && *hostel.Name != "" {
		hostelName = *hostel.Name
	}
	if !hasName {
		name = cook.Name
	}
	res, err := h.Issuer.RegisterOrUpgrade(c, users.IssueInput{Email: cook.LoginEmail, HostelID: cook.HostelID.Hex(), HostelName: hostelName, Name: name, Role: "COOK"})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID, err := httpx.OID(res.ID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := coll.UpdateOne(c, bson.D{{Key: "_id", Value: cook.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "acceptedAt", Value: now}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: userID}, {Key: "updatedAt", Value: now}}},
		{Key: "$unset", Value: bson.D{{Key: "invitationToken", Value: ""}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.syncPrimary(c, cook.HostelID, now); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "COOK_INVITATION_ACCEPTED", ActorID: userID, EntityID: cook.ID.Hex(), EntityType: "CookAccount", HostelID: cook.HostelID}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, acceptedOut{true, res.Created, res.Email, hostelName, res.Created || res.Upgraded}, "Invitation accepted")
}

// syncPrimary is syncPrimaryCook: the settings row mirrors the oldest live cook.
func (h *Handler) syncPrimary(ctx context.Context, hostelID bson.ObjectID, now time.Time) error {
	var primary struct {
		CredentialIssuedAt *time.Time     `bson:"credentialIssuedAt"`
		Name               string         `bson:"name"`
		UserID             *bson.ObjectID `bson:"userId"`
	}
	err := h.DB.Collection("cookaccounts").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}},
		options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: 1}})).Decode(&primary)
	if err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	_, err = h.DB.Collection("hostelsettings").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "cookCredentialIssuedAt", Value: primary.CredentialIssuedAt}, {Key: "cookName", Value: primary.Name}, {Key: "cookUserId", Value: primary.UserID}, {Key: "hostelId", Value: hostelID}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	return err
}
