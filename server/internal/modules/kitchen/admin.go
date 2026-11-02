package kitchen

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/food"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Admin is the hostel's side of the kitchen: the cook roster, the portal switch, the
// weekly routine and the staff food photo.
type Admin struct {
	*Handler
	Mail   *email.Sender
	Limits *billing.Limits
	AppURL func(path string) string
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	v1.POST("/hostel-admin/food/photos", a.staffPhoto)
	v1.GET("/hostel-admin/food/routine", a.getRoutine)
	v1.PUT("/hostel-admin/food/routine", a.putRoutine)
	v1.GET("/hostel-admin/cooks", httpx.ETag(), a.listCooks)
	v1.POST("/hostel-admin/cooks", a.addCook)
	v1.PUT("/hostel-admin/cooks/fingerprint", a.fingerprint)
	v1.PATCH("/hostel-admin/cooks/:cookId", a.updateCook)
	v1.DELETE("/hostel-admin/cooks/:cookId", a.removeCook)
	v1.GET("/hostel-admin/cook-portal", httpx.ETag(), a.getPortal)
	v1.PATCH("/hostel-admin/cook-portal", a.setPortal)
}

const (
	inviteDays    = 7
	maxActiveCook = 10
	loginDomain   = "cook.local"
	passwordChars = "abcdefghjkmnpqrtuvwxyz23467989ACDEFGHJKMNPQRTUVWXYZ"
	loginChars    = "abcdefghjkmnpqrtuvwxyz23467989"
)

var (
	routineDays   = []string{"SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"}
	notLetters    = regexp.MustCompile(`[^a-z]`)
	errHostelGone = httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
)

func stamp() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

func pick(alphabet string, n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b), nil
}

func (a *Admin) staffPhoto(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
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
	hostel, err := opsscope.HostelID(p, in.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a.savePhoto(c, p, in, hostel, nil)
}

type routineOut struct {
	Routine ordered.Map `json:"routine"`
}

func (a *Admin) getRoutine(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, a.Cache, []string{hostel.Hex()}, p.UserID, "food-routine", "Food routine loaded", func() (routineOut, error) {
		r, err := food.Routine(c, a.DB, hostel)
		return routineOut{r}, err
	})
}

// readItems is z.array(z.string().trim().min(1).max(80)).
func readItems(sub *valid.Form, key string, min, max int) []string {
	list, ok := sub.Array(key, false, false)
	if !ok {
		return nil
	}
	sub.Size(key, len(list), min, max, "", false)
	out := make([]string, 0, len(list))
	for i, v := range list {
		item := valid.NewForm(map[string]any{"v": v})
		s, _ := item.Str("v", valid.S{Trim: true, Min: 1, Max: 80})
		sub.JoinScalar(key+"."+strconv.Itoa(i), item)
		out = append(out, s)
	}
	return out
}

func (a *Admin) putRoutine(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
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
	hostel := opsscope.BodyHostel(f)
	timings := bson.D{}
	f.Nest("timings", false, func(sub *valid.Form) {
		for _, meal := range mealTypes {
			if v, ok := sub.Str(meal, valid.S{Opt: true, Trim: true, Max: 80}); ok {
				timings = append(timings, bson.E{Key: meal, Value: v})
			}
		}
	})
	list, _ := f.Array("meals", false, false)
	f.Size("meals", len(list), 0, 28, "", false)
	meals := make(bson.A, 0, len(list))
	for i, raw := range list {
		sub := valid.NewForm(raw)
		day, _ := sub.Enum("dayOfWeek", false, nil, routineDays...)
		meal, _ := sub.Enum("mealType", false, nil, mealTypes...)
		items := readItems(sub, "items", 1, 20)
		note, _ := sub.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
		f.Join("meals."+strconv.Itoa(i), sub)
		meals = append(meals, bson.D{{Key: "dayOfWeek", Value: day}, {Key: "items", Value: items}, {Key: "mealType", Value: meal}, {Key: "note", Value: note}})
	}
	var monthItems []string
	var monthNote string
	f.Nest("monthEndSpecial", true, func(sub *valid.Form) {
		monthItems = readItems(sub, "items", 0, 20)
		monthNote, _ = sub.Str("note", valid.S{Opt: true, Trim: true, Max: 500})
	})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := stamp()
	var special any
	if len(monthItems) > 0 {
		special = bson.D{{Key: "items", Value: monthItems}, {Key: "note", Value: monthNote}}
	}
	if _, err := a.DB.Collection("foodroutines").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostelID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "meals", Value: meals}, {Key: "monthEndSpecial", Value: special}, {Key: "timings", Value: timings}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "FOOD_ROUTINE_SAVED", ActorID: uid, EntityID: hostelID.Hex(), EntityType: "FoodRoutine", HostelID: hostelID,
		Metadata: bson.D{{Key: "meals", Value: len(meals)}, {Key: "monthEndSpecial", Value: len(monthItems) > 0}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, a.RT, a.Cache, realtime.Change{HostelIDs: []string{hostelID.Hex()}, Topics: []realtime.Topic{realtime.Food}})
	a.notifyRoutineChange(c, hostelID, p.UserID)
	routine, err := food.Routine(c, a.DB, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, routineOut{routine}, "Food routine saved")
}

func (a *Admin) notifyRoutineChange(ctx context.Context, hostel bson.ObjectID, actor string) {
	cooks, err := a.cookUserIDs(ctx, hostel)
	if err != nil || len(cooks) == 0 {
		return
	}
	name, err := residents.HostelName(ctx, a.DB, hostel)
	if err != nil {
		return
	}
	for _, u := range cooks {
		if u == actor {
			continue
		}
		_, _ = a.Notify.CreateInApp(ctx, notifications.Input{Body: name + " has updated the weekly menu and serving times. Check today's meals before you start.", Category: "FOOD",
			Data: ordered.Map{{Key: "audience", Value: "COOK"}}, HostelID: hostel.Hex(), Title: "The menu changed", UserID: u})
	}
}

type cookRow struct {
	ID                 bson.ObjectID  `bson:"_id"`
	AcceptedAt         *time.Time     `bson:"acceptedAt"`
	CreatedAt          *time.Time     `bson:"createdAt"`
	CredentialIssuedAt *time.Time     `bson:"credentialIssuedAt"`
	HistoricalName     *string        `bson:"historicalName"`
	HostelID           bson.ObjectID  `bson:"hostelId"`
	InvitationExpires  *time.Time     `bson:"invitationExpiresAt"`
	Kind               string         `bson:"kind"`
	LoginEmail         string         `bson:"loginEmail"`
	Name               string         `bson:"name"`
	RemovedAt          *time.Time     `bson:"removedAt"`
	Status             string         `bson:"status"`
	UserID             *bson.ObjectID `bson:"userId"`
}

func iso(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

func serializeCook(x *cookRow, mustChange bool) ordered.Map {
	historical, user := any(ordered.Undefined), any(ordered.Undefined)
	if x.HistoricalName != nil {
		historical = *x.HistoricalName
	}
	if x.UserID != nil {
		user = x.UserID.Hex()
	}
	return ordered.Map{{Key: "acceptedAt", Value: iso(x.AcceptedAt)}, {Key: "addedAt", Value: iso(x.CreatedAt)}, {Key: "credentialIssuedAt", Value: iso(x.CredentialIssuedAt)}, {Key: "historicalName", Value: historical},
		{Key: "id", Value: x.ID.Hex()}, {Key: "initialPasswordPending", Value: mustChange}, {Key: "invitationExpiresAt", Value: iso(x.InvitationExpires)}, {Key: "invitationPending", Value: x.Status == "INVITED"},
		{Key: "kind", Value: x.Kind}, {Key: "loginEmail", Value: x.LoginEmail}, {Key: "name", Value: x.Name}, {Key: "removedAt", Value: iso(x.RemovedAt)}, {Key: "status", Value: x.Status}, {Key: "userId", Value: user}}
}

type hostelFacts struct {
	Name, Slug string
}

func (a *Admin) loadHostel(ctx context.Context, id bson.ObjectID) (hostelFacts, error) {
	var row struct {
		Name string `bson:"name"`
		Slug string `bson:"slug"`
	}
	err := a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "slug", Value: 1}})).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return hostelFacts{}, errHostelGone
	}
	if err != nil {
		return hostelFacts{}, err
	}
	out := hostelFacts{row.Name, row.Slug}
	if out.Name == "" {
		out.Name = "Hostel"
	}
	if out.Slug == "" {
		out.Slug = id.Hex()
	}
	return out, nil
}

func (a *Admin) loginTaken(ctx context.Context, login string) (bool, error) {
	n, err := a.DB.Collection("users").CountDocuments(ctx, bson.D{{Key: "email", Value: login}}, options.Count().SetLimit(1))
	if err != nil || n > 0 {
		return n > 0, err
	}
	n, err = a.DB.Collection("cookaccounts").CountDocuments(ctx, bson.D{{Key: "loginEmail", Value: login}}, options.Count().SetLimit(1))
	return n > 0, err
}

func (a *Admin) mintLogin(ctx context.Context, nameOrSlug string) (string, error) {
	stem := notLetters.ReplaceAllString(strings.ToLower(nameOrSlug), "")
	if len(stem) > 4 {
		stem = stem[:4]
	}
	if stem == "" {
		stem = "ck"
	}
	for attempt := 0; attempt < 6; attempt++ {
		suffix := ""
		if attempt > 0 {
			var err error
			if suffix, err = pick(loginChars, 2); err != nil {
				return "", err
			}
		}
		candidate := stem + suffix + "@" + loginDomain
		taken, err := a.loginTaken(ctx, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	suffix, err := pick(loginChars, 5)
	if err != nil {
		return "", err
	}
	candidate := stem + suffix + "@" + loginDomain
	taken, err := a.loginTaken(ctx, candidate)
	if err != nil {
		return "", err
	}
	if taken {
		return "", errors.New("could not mint a unique cook login")
	}
	return candidate, nil
}

func previousLabel(hostelName string) string {
	if words := strings.Fields(hostelName); len(words) > 0 {
		return "Previous " + words[0] + " cook"
	}
	return "Previous cook"
}

type credentialsOut struct {
	Email             string `json:"email"`
	TemporaryPassword string `json:"temporaryPassword"`
}

// issueCredentialCook mints the account and the roster row for a kitchen login with no mailbox.
func (a *Admin) issueCredentialCook(ctx context.Context, actor bson.ObjectID, cookName string, hostel bson.ObjectID, facts hostelFacts) (*cookRow, credentialsOut, error) {
	login, err := a.mintLogin(ctx, facts.Slug)
	if err != nil {
		return nil, credentialsOut{}, err
	}
	password, err := pick(passwordChars, 8)
	if err != nil {
		return nil, credentialsOut{}, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, credentialsOut{}, err
	}
	at := stamp()
	userID := bson.NewObjectID()
	if _, err := a.DB.Collection("users").InsertOne(ctx, bson.D{{Key: "_id", Value: userID}, {Key: "authProvider", Value: "LOCAL"}, {Key: "email", Value: login}, {Key: "emailVerified", Value: true}, {Key: "emailVerifiedAt", Value: at},
		{Key: "hostelIds", Value: bson.A{hostel}}, {Key: "mustChangePassword", Value: true}, {Key: "name", Value: cookName}, {Key: "passwordHash", Value: hash}, {Key: "role", Value: "COOK"}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedBy", Value: actor},
		{Key: "image", Value: nil}, {Key: "lockPinFailures", Value: 0}, {Key: "tokenVersion", Value: 0}, {Key: "isDeleted", Value: false}, {Key: "isDemoData", Value: false}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
		return nil, credentialsOut{}, err
	}
	row := &cookRow{ID: bson.NewObjectID(), CreatedAt: &at, CredentialIssuedAt: &at, HostelID: hostel, Kind: "CREDENTIAL", LoginEmail: login, Name: cookName, Status: "ACTIVE", UserID: &userID}
	if _, err := a.DB.Collection("cookaccounts").InsertOne(ctx, bson.D{{Key: "_id", Value: row.ID}, {Key: "createdBy", Value: actor}, {Key: "credentialIssuedAt", Value: at}, {Key: "hostelId", Value: hostel}, {Key: "kind", Value: "CREDENTIAL"},
		{Key: "loginEmail", Value: login}, {Key: "name", Value: cookName}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedBy", Value: actor}, {Key: "userId", Value: userID}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
		return nil, credentialsOut{}, err
	}
	if err := a.syncPrimary(ctx, hostel, at); err != nil {
		return nil, credentialsOut{}, err
	}
	return row, credentialsOut{login, password}, nil
}

func (a *Admin) mailCredentials(ctx context.Context, hostel bson.ObjectID, cookName string, creds credentialsOut, hostelName string, rotated bool) {
	contacts, err := residents.HostelAdminContacts(ctx, a.DB, hostel)
	if err != nil {
		return
	}
	action := "cook_credentials_issued"
	if rotated {
		action = "cook_password_rotated"
	}
	mail := email.CookCredentials(cookName, creds.Email, creds.TemporaryPassword, hostelName, a.AppURL("/login"), rotated)
	for _, contact := range contacts {
		a.Mail.Notify(ctx, email.Notification{Action: action, HTML: mail.HTML, Subject: mail.Subject, To: contact.Email, Category: mail.Category})
	}
}

// backfillLegacyCook gives a settings-only cook from before the roster its row.
func (a *Admin) backfillLegacyCook(ctx context.Context, hostel bson.ObjectID) error {
	var settings struct {
		IssuedAt *time.Time     `bson:"cookCredentialIssuedAt"`
		Name     string         `bson:"cookName"`
		UserID   *bson.ObjectID `bson:"cookUserId"`
	}
	err := a.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&settings)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && settings.UserID == nil) {
		return nil
	}
	if err != nil {
		return err
	}
	n, err := a.DB.Collection("cookaccounts").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "userId", Value: *settings.UserID}}, options.Count().SetLimit(1))
	if err != nil || n > 0 {
		return err
	}
	var user struct {
		Email  string `bson:"email"`
		Name   string `bson:"name"`
		Status string `bson:"status"`
	}
	err = a.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *settings.UserID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&user)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && user.Email == "") {
		return nil
	}
	if err != nil {
		return err
	}
	name := settings.Name
	if name == "" {
		name = user.Name
	}
	if name == "" {
		name = "Cook"
	}
	at := stamp()
	doc := bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "CREDENTIAL"}, {Key: "loginEmail", Value: user.Email}, {Key: "name", Value: name}, {Key: "userId", Value: *settings.UserID}}
	if settings.IssuedAt != nil {
		doc = append(doc, bson.E{Key: "credentialIssuedAt", Value: *settings.IssuedAt})
	}
	if user.Status == "ACTIVE" {
		doc = append(doc, bson.E{Key: "status", Value: "ACTIVE"})
	} else {
		doc = append(doc, bson.E{Key: "status", Value: "REMOVED"}, bson.E{Key: "removedAt", Value: at})
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
	_, err = a.DB.Collection("cookaccounts").InsertOne(ctx, doc)
	return err
}

type cooksOut struct {
	Cooks           []ordered.Map `json:"cooks"`
	ExpensesEnabled bool          `json:"expensesEnabled"`
	StockEnabled    bool          `json:"stockEnabled"`
	FingerprintLock bool          `json:"fingerprintLock"`
	PortalEnabled   bool          `json:"portalEnabled"`
}

func (a *Admin) listCooks(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.backfillLegacyCook(c, hostel); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := a.DB.Collection("cookaccounts").Find(c, bson.D{{Key: "hostelId", Value: hostel}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(1000))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []cookRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	var settings struct {
		Expenses    bool  `bson:"cookCanRecordExpenses"`
		Stock       *bool `bson:"cookCanUseStock"`
		Fingerprint bool  `bson:"cookFingerprintLock"`
		Portal      bool  `bson:"cookPortalEnabled"`
	}
	if err := a.DB.Collection("hostelsettings").FindOne(c, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&settings); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	ids := bson.A{}
	for i := range rows {
		if rows[i].Status != "REMOVED" && rows[i].UserID != nil {
			ids = append(ids, *rows[i].UserID)
		}
	}
	must := map[bson.ObjectID]bool{}
	if len(ids) > 0 {
		uc, err := a.DB.Collection("users").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "mustChangePassword", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var accounts []struct {
			ID   bson.ObjectID `bson:"_id"`
			Must bool          `bson:"mustChangePassword"`
		}
		if err := uc.All(c, &accounts); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, x := range accounts {
			must[x.ID] = x.Must
		}
	}
	out := cooksOut{Cooks: []ordered.Map{}, ExpensesEnabled: settings.Expenses, StockEnabled: settings.Stock == nil || *settings.Stock, FingerprintLock: settings.Fingerprint, PortalEnabled: settings.Portal}
	serialized := func(x *cookRow) ordered.Map {
		return serializeCook(x, x.UserID != nil && must[*x.UserID])
	}
	for i := range rows {
		if rows[i].Status != "REMOVED" {
			out.Cooks = append(out.Cooks, serialized(&rows[i]))
		}
	}
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].Status == "REMOVED" {
			out.Cooks = append(out.Cooks, serialized(&rows[i]))
		}
	}
	httpx.Write(c, 200, out, "Cooks loaded")
}

func (a *Admin) setPortalFlag(ctx context.Context, hostel, actor bson.ObjectID, on bool, extra ...bson.E) error {
	at := stamp()
	set := append(bson.D{{Key: "cookPortalEnabled", Value: on}, {Key: "hostelId", Value: hostel}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: at}}, extra...)
	_, err := a.DB.Collection("hostelsettings").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true))
	return err
}

func (a *Admin) fingerprint(c *gin.Context) {
	p, err := a.Guards.RequireHostelAdmin(c)
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
	enabled, _ := f.Bool("enabled", false, nil)
	hostel := opsscope.BodyHostel(f)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := stamp()
	if _, err := a.DB.Collection("hostelsettings").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostelID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "cookFingerprintLock", Value: enabled}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	message := "Cooks are no longer asked"
	if enabled {
		message = "Cooks will be asked for a fingerprint"
	}
	httpx.OK(c, ordered.Map{{Key: "fingerprintLock", Value: enabled}}, message)
}

func (a *Admin) addCook(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
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
	kind, _ := f.M["kind"].(string)
	if kind != "CREDENTIAL" && kind != "INVITE" {
		f.Is.Add("kind", "Invalid discriminator value. Expected 'CREDENTIAL' | 'INVITE'")
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	var login string
	if kind == "INVITE" {
		login, _ = f.Email("email", false, "")
		if len(login) > 160 {
			f.Is.Add("email", valid.TooBig("string", 160, true))
		}
	}
	hostel := opsscope.BodyHostel(f)
	name, _ := f.Str("name", valid.S{Trim: true, Min: 2, Max: 80})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	facts, err := a.loadHostel(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.backfillLegacyCook(c, hostelID); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Limits.AssertRoom(c, hostelID, "cooks", 1); err != nil {
		httpx.Fail(c, err)
		return
	}
	cooks := a.DB.Collection("cookaccounts")
	live, err := cooks.CountDocuments(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if live >= maxActiveCook {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "COOK_LIMIT_REACHED", "A hostel can have "+strconv.Itoa(maxActiveCook)+" cooks at a time. Remove one before adding another.", nil))
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if kind == "CREDENTIAL" {
		row, creds, err := a.issueCredentialCook(c, uid, name, hostelID, facts)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if err := a.setPortalFlag(c, hostelID, uid, true); err != nil {
			httpx.Fail(c, err)
			return
		}
		if err := a.Audit.Write(c, audit.Entry{Action: "COOK_CREDENTIALS_ISSUED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "CookAccount", HostelID: hostelID, Metadata: bson.D{{Key: "cookName", Value: name}, {Key: "loginEmail", Value: creds.Email}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		a.mailCredentials(c, hostelID, name, creds, facts.Name, false)
		httpx.OK(c, ordered.Map{{Key: "credentials", Value: creds}, {Key: "cook", Value: serializeCook(row, true)}}, "Cook sign-in created")
		return
	}
	login = strings.ToLower(strings.TrimSpace(login))
	clash, err := cooks.CountDocuments(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "loginEmail", Value: login}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}}, options.Count().SetLimit(1))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if clash > 0 {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "COOK_ALREADY_INVITED", "That email is already a cook here.", nil))
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		httpx.Fail(c, err)
		return
	}
	token := hex.EncodeToString(raw)
	at := stamp()
	expires := at.AddDate(0, 0, inviteDays)
	row := cookRow{ID: bson.NewObjectID(), CreatedAt: &at, HostelID: hostelID, InvitationExpires: &expires, Kind: "INVITE", LoginEmail: login, Name: name, Status: "INVITED"}
	if _, err := cooks.InsertOne(c, bson.D{{Key: "_id", Value: row.ID}, {Key: "createdBy", Value: uid}, {Key: "hostelId", Value: hostelID}, {Key: "invitationExpiresAt", Value: expires}, {Key: "invitationToken", Value: token}, {Key: "kind", Value: "INVITE"},
		{Key: "loginEmail", Value: login}, {Key: "name", Value: name}, {Key: "status", Value: "INVITED"}, {Key: "updatedBy", Value: uid}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.setPortalFlag(c, hostelID, uid, true); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "COOK_INVITED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "CookAccount", HostelID: hostelID, Metadata: bson.D{{Key: "cookName", Value: name}, {Key: "email", Value: login}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	mail := email.CookInvitation(a.AppURL("/cook-invite?token="+token), name, inviteDays, facts.Name)
	a.Mail.Notify(c, email.Notification{Action: "cook_invitation", HTML: mail.HTML, Subject: mail.Subject, To: login, Category: mail.Category})
	httpx.OK(c, ordered.Map{{Key: "cook", Value: serializeCook(&row, false)}}, "Invitation sent")
}

func (a *Admin) findCook(c *gin.Context, hostel bson.ObjectID) (*cookRow, error) {
	id, err := httpx.OID(c.Param("cookId"), "cook id")
	if err != nil {
		return nil, err
	}
	var row cookRow
	err = a.DB.Collection("cookaccounts").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(http.StatusNotFound, "COOK_NOT_FOUND", "That cook was not found.", nil)
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (a *Admin) revokeSessions(ctx context.Context, user bson.ObjectID) error {
	_, err := a.DB.Collection("sessions").UpdateMany(ctx, bson.D{{Key: "revokedAt", Value: nil}, {Key: "userId", Value: user}}, bson.D{{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: stamp()}}}})
	return err
}

func (a *Admin) updateCook(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
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
	hostel := opsscope.BodyHostel(f)
	newName, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Min: 2, Max: 80})
	rotate, _ := f.Bool("rotate", true, nil)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	facts, err := a.loadHostel(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cook, err := a.findCook(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if cook.Status == "REMOVED" {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "COOK_REMOVED", "This cook has been removed and cannot be changed.", nil))
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	name := cook.Name
	if hasName && newName != "" {
		name = newName
	}
	at := stamp()
	set := bson.D{{Key: "name", Value: name}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}
	var creds *credentialsOut
	users := a.DB.Collection("users")
	if rotate {
		if cook.Kind != "CREDENTIAL" || cook.UserID == nil {
			httpx.Fail(c, httpx.NewError(http.StatusConflict, "COOK_NOT_CREDENTIAL", "This cook signs in with their own email, so there is no password here to rotate.", nil))
			return
		}
		password, err := pick(passwordChars, 8)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if _, err := users.UpdateOne(c, bson.D{{Key: "_id", Value: *cook.UserID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "mustChangePassword", Value: true}, {Key: "name", Value: name}, {Key: "passwordHash", Value: hash}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		if err := a.revokeSessions(c, *cook.UserID); err != nil {
			httpx.Fail(c, err)
			return
		}
		set = append(set, bson.E{Key: "credentialIssuedAt", Value: at})
		creds = &credentialsOut{cook.LoginEmail, password}
	} else if cook.UserID != nil && hasName {
		if _, err := users.UpdateOne(c, bson.D{{Key: "_id", Value: *cook.UserID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "name", Value: name}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	var updated cookRow
	if err := a.DB.Collection("cookaccounts").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: cook.ID}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.syncPrimary(c, hostelID, at); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := ordered.Map{{Key: "cook", Value: serializeCook(&updated, creds != nil)}}
	message := "Cook updated"
	if creds != nil {
		if err := a.Audit.Write(c, audit.Entry{Action: "COOK_PASSWORD_ROTATED", ActorID: uid, EntityID: cook.ID.Hex(), EntityType: "CookAccount", HostelID: hostelID}); err != nil {
			httpx.Fail(c, err)
			return
		}
		a.mailCredentials(c, hostelID, name, *creds, facts.Name, true)
		out = append(out, ordered.Pair{Key: "credentials", Value: *creds})
	}
	if rotate {
		message = "New password issued"
	}
	httpx.OK(c, out, message)
}

func (a *Admin) removeCook(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	facts, err := a.loadHostel(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cook, err := a.findCook(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if cook.Status == "REMOVED" {
		httpx.OK(c, ordered.Map{{Key: "cook", Value: serializeCook(cook, false)}}, "Cook removed")
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	historical := previousLabel(facts.Name)
	at := stamp()
	if cook.UserID != nil {
		users := a.DB.Collection("users")
		var err error
		if cook.Kind == "CREDENTIAL" {
			_, err = users.UpdateOne(c, bson.D{{Key: "_id", Value: *cook.UserID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}, {Key: "status", Value: "DELETED"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}, {Key: "$unset", Value: bson.D{{Key: "passwordHash", Value: ""}}}})
		} else {
			_, err = users.UpdateOne(c, bson.D{{Key: "_id", Value: *cook.UserID}, {Key: "role", Value: "COOK"}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: hostelID}}}, {Key: "$set", Value: bson.D{{Key: "role", Value: "PUBLIC"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}})
		}
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if err := a.revokeSessions(c, *cook.UserID); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	var removed cookRow
	if err := a.DB.Collection("cookaccounts").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: cook.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "historicalName", Value: historical}, {Key: "removedAt", Value: at}, {Key: "status", Value: "REMOVED"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}},
		{Key: "$unset", Value: bson.D{{Key: "invitationToken", Value: ""}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&removed); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.syncPrimary(c, hostelID, at); err != nil {
		httpx.Fail(c, err)
		return
	}
	remaining, err := a.DB.Collection("cookaccounts").CountDocuments(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}}, options.Count().SetLimit(1))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if remaining == 0 {
		if err := a.setPortalFlag(c, hostelID, uid, false); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "COOK_REMOVED", ActorID: uid, EntityID: cook.ID.Hex(), EntityType: "CookAccount", HostelID: hostelID, Metadata: bson.D{{Key: "historicalName", Value: historical}, {Key: "kind", Value: cook.Kind}, {Key: "loginEmail", Value: cook.LoginEmail}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "cook", Value: serializeCook(&removed, false)}}, "Cook removed")
}

type portalSettings struct {
	CookEmail              string `json:"cookEmail"`
	CookName               string `json:"cookName"`
	CookPortalEnabled      bool   `json:"cookPortalEnabled"`
	CookUserID             string `json:"cookUserId,omitempty"`
	CredentialIssuedAt     string `json:"credentialIssuedAt,omitempty"`
	InitialPasswordPending bool   `json:"initialPasswordPending"`
}

type portalRow struct {
	Name     string         `bson:"cookName"`
	Enabled  bool           `bson:"cookPortalEnabled"`
	UserID   *bson.ObjectID `bson:"cookUserId"`
	IssuedAt *time.Time     `bson:"cookCredentialIssuedAt"`
}

func (a *Admin) readPortal(ctx context.Context, hostel bson.ObjectID) (*portalRow, error) {
	var row portalRow
	err := a.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func serializePortal(row *portalRow, login string, must bool) portalSettings {
	out := portalSettings{CookEmail: login, InitialPasswordPending: must}
	if row != nil {
		out.CookName, out.CookPortalEnabled = row.Name, row.Enabled
		if row.UserID != nil {
			out.CookUserID = row.UserID.Hex()
		}
		if row.IssuedAt != nil {
			out.CredentialIssuedAt = httpx.ISO(*row.IssuedAt)
		}
	}
	return out
}

func (a *Admin) portalWithAccount(ctx context.Context, row *portalRow) (portalSettings, error) {
	if row == nil || row.UserID == nil {
		return serializePortal(row, "", false), nil
	}
	var user struct {
		Email string `bson:"email"`
		Must  bool   `bson:"mustChangePassword"`
	}
	err := a.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *row.UserID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "mustChangePassword", Value: 1}})).Decode(&user)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return portalSettings{}, err
	}
	return serializePortal(row, user.Email, user.Must), nil
}

func (a *Admin) getPortal(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := a.readPortal(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := a.portalWithAccount(c, row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 200, ordered.Map{{Key: "settings", Value: out}}, "Cook portal settings loaded")
}

func (a *Admin) setPortal(c *gin.Context) {
	p, err := a.Guards.RequireHostelCapability(c, "manageFood")
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
	cookName, hasName := f.Str("cookName", valid.S{Opt: true, Trim: true, Min: 2, Max: 80})
	enabled, _ := f.Bool("enabled", false, nil)
	hostel := opsscope.BodyHostel(f)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	facts, err := a.loadHostel(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	existing, err := a.readPortal(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := stamp()
	users := a.DB.Collection("users")
	cooks := a.DB.Collection("cookaccounts")
	if !enabled {
		cur, err := cooks.Find(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}}, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var live []struct {
			UserID bson.ObjectID `bson:"userId"`
		}
		if err := cur.All(c, &live); err != nil {
			httpx.Fail(c, err)
			return
		}
		if len(live) > 0 {
			ids := make(bson.A, len(live))
			for i, x := range live {
				ids[i] = x.UserID
			}
			if _, err := users.UpdateMany(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "SUSPENDED"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}}); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
		if err := a.setPortalFlag(c, hostelID, uid, false); err != nil {
			httpx.Fail(c, err)
			return
		}
		if err := a.Audit.Write(c, audit.Entry{Action: "COOK_PORTAL_DISABLED", ActorID: uid, EntityID: hostelID.Hex(), EntityType: "HostelSettings", HostelID: hostelID}); err != nil {
			httpx.Fail(c, err)
			return
		}
		row, err := a.readPortal(c, hostelID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, ordered.Map{{Key: "credentialsIssued", Value: false}, {Key: "settings", Value: serializePortal(row, "", false)}}, "Cook portal disabled")
		return
	}
	cur, err := cooks.Find(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var roster []cookRow
	if err := cur.All(c, &roster); err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(roster) > 0 {
		ids := bson.A{}
		for i := range roster {
			if roster[i].UserID != nil {
				ids = append(ids, *roster[i].UserID)
			}
		}
		if len(ids) > 0 {
			if _, err := users.UpdateMany(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "ACTIVE"}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}}); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
		name := roster[0].Name
		if hasName {
			name = cookName
			if _, err := cooks.UpdateOne(c, bson.D{{Key: "_id", Value: roster[0].ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "name", Value: cookName}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}}); err != nil {
				httpx.Fail(c, err)
				return
			}
			if roster[0].UserID != nil {
				if _, err := users.UpdateOne(c, bson.D{{Key: "_id", Value: *roster[0].UserID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "name", Value: cookName}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}}); err != nil {
					httpx.Fail(c, err)
					return
				}
			}
		}
		if err := a.setPortalFlag(c, hostelID, uid, true, bson.E{Key: "cookName", Value: name}); err != nil {
			httpx.Fail(c, err)
			return
		}
		if err := a.Audit.Write(c, audit.Entry{Action: "COOK_PORTAL_ENABLED", ActorID: uid, EntityID: hostelID.Hex(), EntityType: "HostelSettings", HostelID: hostelID, Metadata: bson.D{{Key: "cookCount", Value: len(roster)}, {Key: "reactivated", Value: true}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		row, err := a.readPortal(c, hostelID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		out, err := a.portalWithAccount(c, row)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, ordered.Map{{Key: "credentialsIssued", Value: false}, {Key: "settings", Value: out}}, "Cook portal enabled")
		return
	}
	name := cookName
	if !hasName {
		name = ""
		if existing != nil {
			name = existing.Name
		}
		if name == "" {
			name = facts.Name + " Cook"
		}
	}
	_, creds, err := a.issueCredentialCook(c, uid, name, hostelID, facts)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.setPortalFlag(c, hostelID, uid, true); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "COOK_PORTAL_ENABLED", ActorID: uid, EntityID: hostelID.Hex(), EntityType: "HostelSettings", HostelID: hostelID, Metadata: bson.D{{Key: "cookName", Value: name}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	mail := email.CookPortalEnabled(name, creds.Email, creds.TemporaryPassword, facts.Name, a.AppURL("/login"))
	if contacts, err := residents.HostelAdminContacts(c, a.DB, hostelID); err == nil {
		for _, contact := range contacts {
			a.Mail.Notify(c, email.Notification{Action: "cook_portal_enabled", HTML: mail.HTML, Subject: mail.Subject, To: contact.Email, Category: mail.Category})
		}
	}
	row, err := a.readPortal(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "credentials", Value: creds}, {Key: "credentialsIssued", Value: true}, {Key: "settings", Value: serializePortal(row, creds.Email, true)}}, "Cook portal enabled")
}
