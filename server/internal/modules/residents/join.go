package residents

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// resident-join.service.ts, the person's side: a hostel's join link, as the
// person opening it sees it, and sending (or fixing) the request.

// DemoResidentEmail is the one address any hostel may register while it lives elsewhere.
const DemoResidentEmail = "demo.resident@softmato.com"

func joinErr(status int, code, msg string, details any) *httpx.Error {
	return httpx.NewError(status, code, msg, details)
}

type joinLink struct {
	ID       bson.ObjectID `bson:"_id"`
	Cap      int           `bson:"cap"`
	Enabled  bool          `bson:"enabled"`
	HostelID bson.ObjectID `bson:"hostelId"`
	Token    string        `bson:"token"`
	Used     int           `bson:"used"`
}

func (l joinLink) state() string {
	if !l.Enabled {
		return "OFF"
	}
	if l.Used >= l.Cap {
		return "FULL"
	}
	return "OPEN"
}

type joinRequest struct {
	ID           bson.ObjectID  `bson:"_id"`
	CardID       string         `bson:"cardId"`
	DecidedAt    *time.Time     `bson:"decidedAt"`
	DepositPaid  float64        `bson:"depositPaid"`
	Email        string         `bson:"email"`
	FullName     string         `bson:"fullName"`
	JoinedDate   *time.Time     `bson:"joinedDate"`
	Note         string         `bson:"note"`
	PaidTill     string         `bson:"paidTill"`
	PartPaid     float64        `bson:"partPaid"`
	Phone        string         `bson:"phone"`
	RejectReason string         `bson:"rejectReason"`
	ResidentID   *bson.ObjectID `bson:"residentId"`
	RoomType     string         `bson:"roomType"`
	Sends        float64        `bson:"sends"`
	SentAt       time.Time      `bson:"sentAt"`
	Status       string         `bson:"status"`
}

func iso(t time.Time) string { return t.UTC().Format(isoMilli) }

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

func (r joinRequest) row() ListRow {
	row := ListRow{DepositPaid: int64(r.DepositPaid), Email: r.Email, FullName: r.FullName, ID: "join", PartPaid: int64(r.PartPaid), Phone: r.Phone,
		PaidTill: r.PaidTill, RoomType: r.RoomType}
	if r.JoinedDate != nil {
		s := iso(*r.JoinedDate)
		row.JoinedDate = &s
	}
	return row
}

// rentStatusLabel is rentStatusLabel: the sheet's wording for "rent paid till".
func rentStatusLabel(current, value string) string {
	if value == "" {
		return ""
	}
	name := func(period string) string {
		if len(period) >= 7 {
			if m, err := strconv.Atoi(period[5:]); err == nil && m >= 1 && m <= 12 {
				return bs.MonthName(m)
			}
		}
		return period
	}
	type opt struct{ label, value string }
	add := func(n int) string { p, _ := bs.AddMonths(current, n); return p }
	opts := []opt{{"Paid this month", current}}
	for due := 1; due <= 12; due++ {
		label := fmt.Sprintf("%d months due (%s to %s)", due, name(add(1-due)), name(current))
		if due == 1 {
			label = "1 month due (" + name(current) + ")"
		}
		opts = append(opts, opt{label, add(-due)})
	}
	for ahead := 1; ahead <= 2; ahead++ {
		opts = append(opts, opt{"Paid ahead till " + name(add(ahead)), add(ahead)})
	}
	for _, o := range opts {
		if o.value == value {
			return o.label
		}
	}
	label := bs.FormatPeriod(value)
	if label == "" {
		label = value
	}
	return "Paid till " + label
}

type checked struct {
	Bills    *BillPreview
	Problems []string
	Rent     *int64
}

func jsonOrNull(v any) any { return v }

func (r joinRequest) view(c checked, current string) ordered.Map {
	var bills any
	if c.Bills != nil {
		bills = c.Bills
	}
	var rent any
	if c.Rent != nil {
		rent = float64(*c.Rent)
	}
	var resident any
	if r.ResidentID != nil {
		resident = r.ResidentID.Hex()
	}
	label := rentStatusLabel(current, r.PaidTill)
	if label == "" {
		label = "Paid till " + MonthLabel(r.PaidTill)
	}
	problems := c.Problems
	if problems == nil {
		problems = []string{}
	}
	return ordered.Map{
		{Key: "bills", Value: bills}, {Key: "cardId", Value: r.CardID}, {Key: "decidedAt", Value: isoPtr(r.DecidedAt)}, {Key: "depositPaid", Value: r.DepositPaid},
		{Key: "email", Value: r.Email}, {Key: "fullName", Value: r.FullName}, {Key: "id", Value: r.ID.Hex()}, {Key: "joinedDate", Value: isoPtr(r.JoinedDate)},
		{Key: "note", Value: r.Note}, {Key: "paidTill", Value: r.PaidTill}, {Key: "partPaid", Value: r.PartPaid}, {Key: "phone", Value: r.Phone},
		{Key: "problems", Value: problems}, {Key: "rejectReason", Value: r.RejectReason}, {Key: "rent", Value: rent}, {Key: "rentLabel", Value: label},
		{Key: "residentId", Value: resident}, {Key: "roomType", Value: r.RoomType}, {Key: "sends", Value: r.Sends}, {Key: "sentAt", Value: iso(r.SentAt)},
		{Key: "status", Value: r.Status},
	}
}

func (p *Public) findLink(ctx context.Context, token string) (joinLink, error) {
	var l joinLink
	err := p.DB.Collection("residentjoinlinks").FindOne(ctx, bson.D{{Key: "token", Value: valid.Trim(token)}}).Decode(&l)
	if err == mongo.ErrNoDocuments {
		return l, joinErr(http.StatusNotFound, "JOIN_LINK_NOT_FOUND", "This link does not work any more. Ask your hostel for the new one.", nil)
	}
	return l, err
}

type roomConfig struct {
	RoomType    string   `bson:"roomType"`
	VacantBeds  float64  `bson:"vacantBeds"`
	MonthlyRent *float64 `bson:"monthlyRent"`
}

// roomTypesFor is roomTypesFor: each room type with the rent the billing run
// would charge (rate card first, the room list's rent after) and its free beds.
func (p *Public) roomTypesFor(ctx context.Context, hostelID bson.ObjectID, configs []roomConfig) ([]RoomTypeContext, error) {
	out := []RoomTypeContext{}
	var schedule *finance.Schedule
	loaded := false
	for _, cfg := range configs {
		if valid.Trim(cfg.RoomType) == "" {
			continue
		}
		if !loaded {
			period, err := bs.PeriodOf(time.Now())
			if err != nil {
				return nil, err
			}
			if schedule, err = finance.EffectiveSchedule(ctx, p.DB, hostelID, period); err != nil {
				return nil, err
			}
			loaded = true
		}
		var rent *int64
		if rate := finance.RateForRoomType(schedule, cfg.RoomType); rate != nil {
			if rate.MonthlyAmount != nil {
				v := int64(*rate.MonthlyAmount)
				rent = &v
			}
		} else {
			// The first entry with this exact type; a zero rent counts as none.
			for _, entry := range configs {
				if entry.RoomType == cfg.RoomType {
					if entry.MonthlyRent != nil && *entry.MonthlyRent != 0 {
						v := int64(*entry.MonthlyRent)
						rent = &v
					}
					break
				}
			}
		}
		out = append(out, RoomTypeContext{MonthlyRent: rent, RoomType: cfg.RoomType, VacantBeds: int(cfg.VacantBeds)})
	}
	return out, nil
}

type hostelRooms struct {
	City      string
	Name      string
	RoomTypes []RoomTypeContext
}

func (p *Public) hostelRooms(ctx context.Context, hostelID bson.ObjectID) (hostelRooms, error) {
	var h struct {
		Location struct {
			City string `bson:"city"`
		} `bson:"location"`
		Name               string       `bson:"name"`
		RoomConfigurations []roomConfig `bson:"roomConfigurations"`
	}
	err := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "location.city", Value: 1}, {Key: "name", Value: 1}, {Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if err == mongo.ErrNoDocuments {
		return hostelRooms{}, joinErr(http.StatusNotFound, "HOSTEL_NOT_FOUND", "This hostel is no longer on the app.", nil)
	}
	if err != nil {
		return hostelRooms{}, err
	}
	types, err := p.roomTypesFor(ctx, hostelID, h.RoomConfigurations)
	return hostelRooms{h.Location.City, h.Name, types}, err
}

// checkContext is contextFor for a list of join rows (no numbered rooms).
func (p *Public) checkContext(ctx context.Context, rows []ListRow, types []RoomTypeContext, hostelID bson.ObjectID) (CheckContext, error) {
	phones, emails := bson.A{}, bson.A{}
	seenP, seenE := map[string]bool{}, map[string]bool{}
	for _, r := range rows {
		if r.ResidentID != "" {
			continue
		}
		if r.Phone != "" && !seenP[r.Phone] {
			seenP[r.Phone] = true
			phones = append(phones, r.Phone)
		}
		if e := strings.ToLower(valid.Trim(r.Email)); e != "" && !seenE[e] {
			seenE[e] = true
			emails = append(emails, e)
		}
	}
	period, err := bs.PeriodOf(time.Now())
	if err != nil {
		return CheckContext{}, err
	}
	out := CheckContext{CurrentPeriod: period, RoomTypes: types, TakenEmails: map[string]string{}, TakenPhones: map[string]string{}, LivingElsewhere: map[string]string{}}
	res := p.DB.Collection("residents")
	if len(phones) > 0 || len(emails) > 0 {
		or := bson.A{}
		if len(phones) > 0 {
			or = append(or, bson.D{{Key: "phone", Value: bson.D{{Key: "$in", Value: phones}}}})
		}
		if len(emails) > 0 {
			or = append(or, bson.D{{Key: "email", Value: bson.D{{Key: "$in", Value: emails}}}})
		}
		cur, err := res.Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "email", Value: bson.D{{Key: "$ne", Value: DemoResidentEmail}}},
			{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}, {Key: "$or", Value: or}},
			options.Find().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "phone", Value: 1}}))
		if err != nil {
			return out, err
		}
		var own []struct {
			Email, FirstName, LastName, Phone string
		}
		if err := cur.All(ctx, &own); err != nil {
			return out, err
		}
		for _, r := range own {
			name := valid.Trim(r.FirstName + " " + r.LastName)
			if name == "" {
				name = "A resident"
			}
			if r.Phone != "" {
				out.TakenPhones[r.Phone] = name
			}
			if r.Email != "" {
				out.TakenEmails[strings.ToLower(r.Email)] = name
			}
		}
	}
	if len(emails) > 0 {
		cur, err := res.Find(ctx, bson.D{{Key: "email", Value: bson.D{{Key: "$in", Value: emails}, {Key: "$ne", Value: DemoResidentEmail}}},
			{Key: "hostelId", Value: bson.D{{Key: "$ne", Value: hostelID}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
			{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING", "SUSPENDED"}}}}},
			options.Find().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "hostelId", Value: 1}}))
		if err != nil {
			return out, err
		}
		var elsewhere []struct {
			Email    string        `bson:"email"`
			HostelID bson.ObjectID `bson:"hostelId"`
		}
		if err := cur.All(ctx, &elsewhere); err != nil {
			return out, err
		}
		names := map[bson.ObjectID]string{}
		if len(elsewhere) > 0 {
			ids := bson.A{}
			seen := map[bson.ObjectID]bool{}
			for _, e := range elsewhere {
				if !seen[e.HostelID] {
					seen[e.HostelID] = true
					ids = append(ids, e.HostelID)
				}
			}
			hc, err := p.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
			if err != nil {
				return out, err
			}
			var hs []struct {
				ID   bson.ObjectID `bson:"_id"`
				Name string        `bson:"name"`
			}
			if err := hc.All(ctx, &hs); err != nil {
				return out, err
			}
			for _, h := range hs {
				n := valid.Trim(h.Name)
				if n == "" {
					n = "another hostel"
				}
				names[h.ID] = n
			}
		}
		for _, e := range elsewhere {
			if e.Email == "" {
				continue
			}
			n, ok := names[e.HostelID]
			if !ok {
				n = "another hostel"
			}
			out.LivingElsewhere[strings.ToLower(e.Email)] = n
		}
	}
	return out, nil
}

type viewer struct {
	Card      string
	CardID    string
	CardIDSet bool
	Email     string
	FullName  string
	HasPhoto  bool
	LivesAt   *struct {
		HostelName string
		SameHostel bool
	}
	Phone          string
	PhotoUpdatedAt any
}

func (v viewer) out() ordered.Map {
	var cardID any
	if v.CardIDSet {
		cardID = v.CardID
	}
	var lives any
	if v.LivesAt != nil {
		lives = ordered.Map{{Key: "hostelName", Value: v.LivesAt.HostelName}, {Key: "sameHostel", Value: v.LivesAt.SameHostel}}
	}
	return ordered.Map{{Key: "card", Value: v.Card}, {Key: "cardId", Value: cardID}, {Key: "email", Value: v.Email}, {Key: "fullName", Value: v.FullName},
		{Key: "hasPhoto", Value: v.HasPhoto}, {Key: "livesAt", Value: lives}, {Key: "phone", Value: v.Phone}, {Key: "photoUpdatedAt", Value: v.PhotoUpdatedAt}}
}

func str(m map[string]any, k string) (string, bool) {
	s, ok := m[k].(string)
	return s, ok
}

// viewerFor is viewerFor over getResidentIdentity: the account, its ID card and
// where they already live.
func (p *Public) viewerFor(ctx context.Context, userID string, hostelID bson.ObjectID) (viewer, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if err != nil {
		return viewer{}, err
	}
	var user struct {
		Email          *string `bson:"email"`
		Name           string  `bson:"name"`
		UserResidentID *string `bson:"userResidentId"`
	}
	err = p.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: uid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}, {Key: "userResidentId", Value: 1}})).Decode(&user)
	if err == mongo.ErrNoDocuments {
		return viewer{}, joinErr(http.StatusNotFound, "USER_NOT_FOUND", "User was not found.", nil)
	}
	if err != nil {
		return viewer{}, err
	}
	var rec struct {
		CompletedAt    *time.Time     `bson:"completedAt"`
		EncryptedData  string         `bson:"encryptedData"`
		PhotoAssetID   *bson.ObjectID `bson:"photoAssetId"`
		PhotoUpdatedAt *time.Time     `bson:"photoUpdatedAt"`
		SharingEnabled *bool          `bson:"sharingEnabled"`
	}
	hasRec := true
	err = p.DB.Collection("userresidentprofiles").FindOne(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "userId", Value: uid}}).Decode(&rec)
	if err == mongo.ErrNoDocuments {
		hasRec = false
	} else if err != nil {
		return viewer{}, err
	}
	var profile map[string]any
	if hasRec {
		if p.Personal == nil {
			return viewer{}, errPersonalMissing
		}
		raw, err := p.Personal.Decrypt(rec.EncryptedData)
		if err != nil {
			return viewer{}, err
		}
		if err := json.Unmarshal(raw, &profile); err != nil {
			return viewer{}, err
		}
	}
	accountEmail := ""
	if user.Email != nil {
		accountEmail = *user.Email
	}
	profEmail, _ := str(profile, "primaryEmail")
	email := accountEmail
	if user.Email == nil {
		email = profEmail
	}
	v := viewer{Email: strings.ToLower(email), HasPhoto: hasRec && rec.PhotoAssetID != nil, PhotoUpdatedAt: nil}
	if hasRec {
		v.PhotoUpdatedAt = isoPtr(rec.PhotoUpdatedAt)
	}
	hasProfile := hasRec && rec.CompletedAt != nil
	cardID := ""
	if user.UserResidentID != nil {
		cardID = *user.UserResidentID
		v.CardID, v.CardIDSet = cardID, true
	}
	switch {
	case !hasProfile || !v.CardIDSet || cardID == "":
		v.Card = "NONE"
	case hasRec && rec.SharingEnabled != nil && !*rec.SharingEnabled:
		v.Card = "PRIVATE"
	default:
		v.Card = "READY"
	}
	if name, ok := str(profile, "fullName"); ok {
		v.FullName = name
	} else {
		v.FullName = user.Name
	}
	v.Phone, _ = str(profile, "primaryPhone")
	res, err := p.liveResidency(ctx, []string{accountEmail, profEmail}, []bson.ObjectID{uid}, hostelID)
	if err != nil {
		return viewer{}, err
	}
	v.LivesAt = res
	return v, nil
}

var errPersonalMissing = fmt.Errorf("PERSONAL_DATA_ENCRYPTION_KEY is required to store or read resident profiles. Generate one with: openssl rand -base64 32")

// liveResidency is findLiveResidency, reduced to what the join link reads.
func (p *Public) liveResidency(ctx context.Context, emailsIn []string, userIDs []bson.ObjectID, asking bson.ObjectID) (*struct {
	HostelName string
	SameHostel bool
}, error) {
	seen := map[string]bool{}
	emails := bson.A{}
	for _, e := range emailsIn {
		e = strings.ToLower(valid.Trim(e))
		if e == "" || seen[e] {
			continue
		}
		seen[e] = true
		emails = append(emails, e)
	}
	if len(emails) == 0 && len(userIDs) == 0 || seen[DemoResidentEmail] {
		return nil, nil
	}
	or := bson.A{}
	if len(userIDs) > 0 {
		ids := bson.A{}
		for _, id := range userIDs {
			ids = append(ids, id)
		}
		or = append(or, bson.D{{Key: "userId", Value: bson.D{{Key: "$in", Value: ids}}}})
	}
	if len(emails) > 0 {
		or = append(or, bson.D{{Key: "email", Value: bson.D{{Key: "$in", Value: emails}}}})
	}
	cur, err := p.DB.Collection("residents").Find(ctx, bson.D{{Key: "$or", Value: or}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING", "SUSPENDED"}}}}},
		options.Find().SetLimit(5).SetProjection(bson.D{{Key: "_id", Value: 1}, {Key: "hostelId", Value: 1}, {Key: "status", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
	}
	if err := cur.All(ctx, &rows); err != nil || len(rows) == 0 {
		return nil, err
	}
	row := rows[0]
	same := false
	for _, r := range rows {
		if r.HostelID == asking {
			row, same = r, true
			break
		}
	}
	var h struct {
		Name string `bson:"name"`
	}
	err = p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: row.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h)
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	name := valid.Trim(h.Name)
	if name == "" {
		name = "another hostel"
	}
	return &struct {
		HostelName string
		SameHostel bool
	}{name, same}, nil
}

func (p *Public) joinPage(ctx context.Context, token, userID string) (ordered.Map, error) {
	link, err := p.findLink(ctx, token)
	if err != nil {
		return nil, err
	}
	hostel, err := p.hostelRooms(ctx, link.HostelID)
	if err != nil {
		return nil, err
	}
	period, err := bs.PeriodOf(time.Now())
	if err != nil {
		return nil, err
	}
	var viewerOut any
	var requestOut any
	if userID != "" {
		v, err := p.viewerFor(ctx, userID, link.HostelID)
		if err != nil {
			return nil, err
		}
		viewerOut = v.out()
		uid, _ := bson.ObjectIDFromHex(userID)
		var req joinRequest
		err = p.DB.Collection("residentapplications").FindOne(ctx, bson.D{{Key: "hostelId", Value: link.HostelID}, {Key: "userId", Value: uid}}).Decode(&req)
		if err != nil && err != mongo.ErrNoDocuments {
			return nil, err
		}
		if err == nil {
			rows := []ListRow{req.row()}
			cc, err := p.checkContext(ctx, rows, hostel.RoomTypes, link.HostelID)
			if err != nil {
				return nil, err
			}
			c := CheckExistingResidents(rows, cc).Rows[0]
			requestOut = req.view(checked{Bills: c.Bills, Rent: c.Rent}, period)
		}
	}
	rooms := make([]any, 0, len(hostel.RoomTypes))
	for _, r := range hostel.RoomTypes {
		var rent any
		if r.MonthlyRent != nil {
			rent = float64(*r.MonthlyRent)
		}
		rooms = append(rooms, ordered.Map{{Key: "monthlyRent", Value: rent}, {Key: "roomType", Value: r.RoomType}})
	}
	return ordered.Map{
		{Key: "currentMonth", Value: ordered.Map{{Key: "label", Value: MonthLabel(period)}, {Key: "period", Value: period}}},
		{Key: "hostel", Value: ordered.Map{{Key: "city", Value: hostel.City}, {Key: "name", Value: hostel.Name}}},
		{Key: "link", Value: link.state()}, {Key: "request", Value: requestOut}, {Key: "roomTypes", Value: rooms}, {Key: "token", Value: link.Token},
		{Key: "viewer", Value: viewerOut},
	}, nil
}

func (p *Public) joinGet(c *gin.Context) {
	if err := p.Limiter.Check(c, "join-link-read", 60, p.Limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	principal, err := p.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID := ""
	if principal != nil {
		userID = principal.UserID
	}
	page, err := p.joinPage(c, c.Param("token"), userID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, page, "Join link loaded")
}

var joinPaidTill = regexp.MustCompile(`^\d{4}-\d{2}$`)

type joinIn struct {
	depositPaid, partPaid float64
	joined                *time.Time
	note, paidTill, room  string
}

// rupees is `z.coerce.number().int("Write rupees without paisa.").min(0).default(0)`.
func rupees(f *valid.Form, key string) float64 {
	v, present := f.M[key]
	if !present {
		return 0
	}
	var n float64
	switch x := v.(type) {
	case float64:
		n = x
	case string:
		n = valid.JSNumber(x)
	case bool:
		if x {
			n = 1
		}
	case nil:
	default:
		n = math.NaN()
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		f.Is.Add(key, valid.Type("number", "NaN"))
		return 0
	}
	if n != math.Trunc(n) {
		f.Is.Add(key, "Write rupees without paisa.")
	}
	if n < 0 {
		f.Is.Add(key, valid.TooSmall("number", 0, true))
	}
	return n
}

// parseJoin is joinRequestSchema.
func parseJoin(body any) (joinIn, error) {
	f := valid.NewForm(body)
	var in joinIn
	in.depositPaid = rupees(f, "depositPaid")
	if v, present := f.M["joinedDate"]; present && v != nil {
		if t, ok := valid.CoerceDate(v); ok {
			in.joined = &t
		} else {
			f.Is.Add("joinedDate", valid.Type("date", "Date"))
		}
	}
	in.note, _ = f.Str("note", valid.S{Trim: true, Max: 300, Opt: true})
	in.paidTill, _ = f.Str("paidTill", valid.S{Re: joinPaidTill, ReMsg: "Choose if this month's rent is paid.", ReSrc: `/^\d{4}-\d{2}$/`})
	in.partPaid = rupees(f, "partPaid")
	in.room, _ = f.Str("roomType", valid.S{Trim: true, Min: 1, MinMsg: "Choose your room type.", Max: 80})
	return in, f.Err()
}

func (p *Public) joinSend(c *gin.Context) {
	if err := p.Limiter.Check(c, "join-link-send", 12, p.Limiter.FormWindow); err != nil {
		httpx.Fail(c, err)
		return
	}
	principal, err := p.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	in, err := parseJoin(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	token := c.Param("token")
	if err := p.sendJoinRequest(c, token, in, principal.UserID); err != nil {
		httpx.Fail(c, err)
		return
	}
	page, err := p.joinPage(c, token, principal.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, page, "Request sent")
}

var wsRun = regexp.MustCompile(`\s+`)

func forResident(field, message string) string {
	switch field {
	case "fullName":
		return "Your ID card needs your first and last name. Fix it on your ID card."
	case "phone", "email":
		if strings.Contains(message, "already uses") {
			return "This hostel already has a resident with your phone or email. Ask them — you may be added already."
		}
		return message + " Fix it on your ID card."
	case "monthlyRent":
		return "The hostel has not set a rent for this room yet. Ask them, then send again."
	}
	return message
}

func (p *Public) sendJoinRequest(ctx context.Context, token string, in joinIn, userID string) error {
	link, err := p.findLink(ctx, token)
	if err != nil {
		return err
	}
	hostelID := link.HostelID
	v, err := p.viewerFor(ctx, userID, hostelID)
	if err != nil {
		return err
	}
	if v.Card == "NONE" {
		return joinErr(http.StatusUnprocessableEntity, "JOIN_NEEDS_CARD", "Make your ID card first. The hostel checks you against it.", nil)
	}
	if v.Card == "PRIVATE" {
		return joinErr(http.StatusUnprocessableEntity, "JOIN_CARD_PRIVATE", "Your ID card is set to private. Turn on sharing so the hostel can see it, then send.", nil)
	}
	if v.LivesAt != nil {
		msg := "You are still a resident of " + v.LivesAt.HostelName + ". They must move you out first."
		if v.LivesAt.SameHostel {
			msg = "You are already a resident here."
		}
		return joinErr(http.StatusConflict, "JOIN_LIVES_SOMEWHERE", msg, nil)
	}
	hostel, err := p.hostelRooms(ctx, hostelID)
	if err != nil {
		return err
	}
	var room *RoomTypeContext
	for i := range hostel.RoomTypes {
		if SameRoomType(hostel.RoomTypes[i].RoomType, in.room) {
			room = &hostel.RoomTypes[i]
			break
		}
	}
	if room == nil {
		return joinErr(http.StatusUnprocessableEntity, "JOIN_REQUEST_INVALID", "Choose your room type from the list.", ordered.Map{{Key: "field", Value: "roomType"}})
	}
	fullName := valid.Trim(wsRun.ReplaceAllString(v.FullName, " "))
	fields := bson.D{{Key: "cardId", Value: v.CardID}, {Key: "depositPaid", Value: in.depositPaid}, {Key: "email", Value: v.Email}, {Key: "fullName", Value: fullName},
		{Key: "joinedDate", Value: nilTime(in.joined)}, {Key: "note", Value: in.note}, {Key: "paidTill", Value: in.paidTill}, {Key: "partPaid", Value: in.partPaid},
		{Key: "phone", Value: v.Phone}, {Key: "roomType", Value: room.RoomType}}
	row := ListRow{DepositPaid: int64(in.depositPaid), Email: v.Email, FullName: fullName, ID: "join", PartPaid: int64(in.partPaid), Phone: v.Phone, PaidTill: in.paidTill, RoomType: room.RoomType}
	if in.joined != nil {
		s := iso(*in.joined)
		row.JoinedDate = &s
	}
	rows := []ListRow{row}
	cc, err := p.checkContext(ctx, rows, hostel.RoomTypes, hostelID)
	if err != nil {
		return err
	}
	if probs := CheckExistingResidents(rows, cc).Rows[0].Problems; len(probs) > 0 {
		return joinErr(http.StatusUnprocessableEntity, "JOIN_REQUEST_INVALID", forResident(probs[0].Field, probs[0].Message), ordered.Map{{Key: "field", Value: probs[0].Field}})
	}
	owner, _ := bson.ObjectIDFromHex(userID)
	apps := p.DB.Collection("residentapplications")
	var existing joinRequest
	err = apps.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "userId", Value: owner}}).Decode(&existing)
	hasExisting := err == nil
	if err != nil && err != mongo.ErrNoDocuments {
		return err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	fresh := !hasExisting || existing.Status == "ADDED"
	wasReturned := hasExisting && existing.Status == "REJECTED"
	if hasExisting && !fresh {
		if !link.Enabled {
			return joinErr(http.StatusConflict, "JOIN_LINK_OFF", "This hostel has paused its join link. Ask them.", nil)
		}
		if existing.DecidedAt != nil && existing.Status == "PENDING" {
			return joinErr(http.StatusConflict, "JOIN_REQUEST_BUSY", "The hostel is adding you right now.", nil)
		}
		set := append(append(bson.D{}, fields...), bson.E{Key: "decidedAt", Value: nil}, bson.E{Key: "rejectReason", Value: ""}, bson.E{Key: "sentAt", Value: now},
			bson.E{Key: "status", Value: "PENDING"}, bson.E{Key: "updatedAt", Value: now})
		upd := bson.D{{Key: "$set", Value: set}}
		if wasReturned {
			upd = append(upd, bson.E{Key: "$inc", Value: bson.D{{Key: "sends", Value: 1}}})
		}
		if _, err := apps.UpdateOne(ctx, bson.D{{Key: "_id", Value: existing.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "REJECTED"}}}}}, upd); err != nil {
			return err
		}
	} else {
		// A new request uses up one place on the link, taken atomically.
		res := p.DB.Collection("residentjoinlinks").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: link.ID}, {Key: "enabled", Value: true},
			{Key: "$expr", Value: bson.D{{Key: "$lt", Value: bson.A{"$used", "$cap"}}}}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "used", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}})
		if res.Err() == mongo.ErrNoDocuments {
			if link.Enabled {
				return joinErr(http.StatusConflict, "JOIN_LINK_FULL", "This link is full. Ask your hostel to allow more requests.", nil)
			}
			return joinErr(http.StatusConflict, "JOIN_LINK_OFF", "This hostel has paused its join link. Ask them.", nil)
		}
		if res.Err() != nil {
			return res.Err()
		}
		if hasExisting {
			set := append(append(bson.D{}, fields...), bson.E{Key: "decidedAt", Value: nil}, bson.E{Key: "decidedBy", Value: nil}, bson.E{Key: "linkId", Value: link.ID},
				bson.E{Key: "rejectReason", Value: ""}, bson.E{Key: "residentId", Value: nil}, bson.E{Key: "sends", Value: 1}, bson.E{Key: "sentAt", Value: now},
				bson.E{Key: "status", Value: "PENDING"}, bson.E{Key: "updatedAt", Value: now})
			if _, err := apps.UpdateOne(ctx, bson.D{{Key: "_id", Value: existing.ID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
				return err
			}
		} else {
			doc := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: hostelID}, {Key: "linkId", Value: link.ID}, {Key: "userId", Value: owner}}
			doc = append(doc, fields...)
			doc = append(doc, bson.E{Key: "status", Value: "PENDING"}, bson.E{Key: "rejectReason", Value: ""}, bson.E{Key: "sends", Value: 1}, bson.E{Key: "sentAt", Value: now},
				bson.E{Key: "decidedAt", Value: nil}, bson.E{Key: "residentId", Value: nil}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
			if _, err := apps.InsertOne(ctx, doc); err != nil {
				_, _ = p.DB.Collection("residentjoinlinks").UpdateOne(ctx, bson.D{{Key: "_id", Value: link.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "used", Value: -1}}}})
				if !mongo.IsDuplicateKeyError(err) {
					return err
				}
				// Sent twice at once from two tabs — the first one stands.
				fresh, wasReturned = false, false
			}
		}
	}
	if fresh || wasReturned {
		period, _ := bs.PeriodOf(now)
		p.tellJoinStaff(ctx, hostelID, wasReturned, fullName, rentStatusLabel(period, in.paidTill), room.RoomType)
	}
	return nil
}

func nilTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Truncate(time.Millisecond)
}

func (p *Public) tellJoinStaff(ctx context.Context, hostelID bson.ObjectID, fixed bool, name, rent, roomType string) {
	staff, err := HostelStaffUserIDs(ctx, p.DB, hostelID, false)
	if err != nil {
		slog.WarnContext(ctx, "Join request: staff were not told", "error", err)
		return
	}
	var parts []string
	for _, s := range []string{roomType, rent, "Check and add"} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	title := name + " asked to be added as a resident"
	if fixed {
		title = name + " fixed their request to join"
	}
	for _, userID := range staff {
		if _, err := p.Notify.CreateInApp(ctx, notifications.Input{
			ActionURL: "/hostel-admin/residents", Body: strings.Join(parts, " · "), Category: "RESIDENT",
			Data: ordered.Map{{Key: "type", Value: notifications.JoinRequestType}}, HostelID: hostelID.Hex(), Title: title, UserID: userID,
		}); err != nil {
			slog.WarnContext(ctx, "Join request: staff were not told", "error", err)
			return
		}
	}
}
