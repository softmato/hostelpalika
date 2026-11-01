package residentportal

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/offerprogram"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerExtras(v1 *gin.RouterGroup) {
	r := v1.Group("/resident")
	r.GET("/referral", httpx.ETag(), h.referral)
	r.GET("/offer-program", httpx.ETag(), h.offer)
	r.POST("/reviews", h.review)
	r.POST("/questioncall/click", h.qcClick)
	r.GET("/questioncall/status", httpx.ETag(), h.qcStatus)
	r.GET("/leaving", h.leavingGet)
	r.PUT("/leaving", h.leavingPut)
	r.DELETE("/leaving", h.leavingDelete)
	r.GET("/room", httpx.ETag(), h.roomGet)
	r.POST("/room", h.roomAsk)
	r.DELETE("/room", h.roomCancel)
}

func isoAny(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

func oidAny(id *bson.ObjectID) any {
	if id == nil {
		return ordered.Undefined
	}
	return id.Hex()
}

// --- referral ------------------------------------------------------------------

var nonDigit = regexp.MustCompile(`\D`)

func (h *Handler) uniqueCode(ctx context.Context, residentID, phone string) (string, error) {
	tail := nonDigit.ReplaceAllString(phone, "")
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	if tail == "" {
		tail = "0000"
	}
	base := strings.ToUpper("HH" + tail + residentID[len(residentID)-4:])
	candidate := base
	for suffix := 2; ; suffix++ {
		n, err := h.DB.Collection("referralcodes").CountDocuments(ctx, bson.D{{Key: "code", Value: candidate}}, options.Count().SetLimit(1))
		if err != nil {
			return "", err
		}
		if n == 0 {
			return candidate, nil
		}
		candidate = base + strconv.Itoa(suffix)
	}
}

type referralCodeRow struct {
	ID             bson.ObjectID `bson:"_id"`
	Code           string        `bson:"code"`
	ConvertedCount int           `bson:"convertedCount"`
	CreatedAt      *time.Time    `bson:"createdAt"`
	HostelID       bson.ObjectID `bson:"hostelId"`
	JoinedCount    int           `bson:"joinedCount"`
	ResidentID     bson.ObjectID `bson:"residentId"`
	RewardCount    int           `bson:"rewardCount"`
	Status         string        `bson:"status"`
	UpdatedAt      *time.Time    `bson:"updatedAt"`
	UserID         bson.ObjectID `bson:"userId"`
}

type referralRow struct {
	ID                 bson.ObjectID  `bson:"_id"`
	ConfirmedAt        *time.Time     `bson:"confirmedAt"`
	ConfirmedBy        *bson.ObjectID `bson:"confirmedBy"`
	Converted          bool           `bson:"converted"`
	ConvertedAt        *time.Time     `bson:"convertedAt"`
	CreatedAt          *time.Time     `bson:"createdAt"`
	Email              string         `bson:"email"`
	HostelID           bson.ObjectID  `bson:"hostelId"`
	InquiryID          *bson.ObjectID `bson:"inquiryId"`
	JoinedResidentID   *bson.ObjectID `bson:"joinedResidentId"`
	Message            string         `bson:"message"`
	Name               string         `bson:"name"`
	Phone              string         `bson:"phone"`
	ReferralCodeID     bson.ObjectID  `bson:"referralCodeId"`
	ReferrerResidentID bson.ObjectID  `bson:"referrerResidentId"`
	Status             string         `bson:"status"`
	UpdatedAt          *time.Time     `bson:"updatedAt"`
}

type rewardRow struct {
	ID                 bson.ObjectID  `bson:"_id"`
	Amount             int64          `bson:"amount"`
	ApprovedAt         *time.Time     `bson:"approvedAt"`
	ApprovedBy         *bson.ObjectID `bson:"approvedBy"`
	HostelID           bson.ObjectID  `bson:"hostelId"`
	Notes              string         `bson:"notes"`
	ReferralID         bson.ObjectID  `bson:"referralId"`
	ReferrerResidentID bson.ObjectID  `bson:"referrerResidentId"`
	RewardType         string         `bson:"rewardType"`
	Status             string         `bson:"status"`
}

type referralSummary struct {
	Converted            int   `json:"converted"`
	Joined               int   `json:"joined"`
	RewardApprovedAmount int64 `json:"rewardApprovedAmount"`
	RewardPaidAmount     int64 `json:"rewardPaidAmount"`
	Sent                 int   `json:"sent"`
}

type referralOut struct {
	ReferralCode ordered.Map     `json:"referralCode"`
	Referrals    []ordered.Map   `json:"referrals"`
	Resident     ordered.Map     `json:"resident"`
	Summary      referralSummary `json:"summary"`
}

func (h *Handler) referral(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	codes := h.DB.Collection("referralcodes")
	var code referralCodeRow
	err = codes.FindOne(c, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&code)
	if err == mongo.ErrNoDocuments {
		uid, oerr := httpx.OID(p.UserID, "user id")
		if oerr != nil {
			httpx.Fail(c, oerr)
			return
		}
		value, cerr := h.uniqueCode(c, r.ID.Hex(), r.Phone)
		if cerr != nil {
			httpx.Fail(c, cerr)
			return
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		code = referralCodeRow{ID: bson.NewObjectID(), Code: value, CreatedAt: &now, HostelID: r.HostelID, ResidentID: r.ID, Status: "ACTIVE", UpdatedAt: &now, UserID: uid}
		_, err = codes.InsertOne(c, bson.D{{Key: "_id", Value: code.ID}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "userId", Value: uid}, {Key: "code", Value: value}, {Key: "status", Value: "ACTIVE"},
			{Key: "joinedCount", Value: 0}, {Key: "convertedCount", Value: 0}, {Key: "rewardCount", Value: 0}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.DB.Collection("referrals").Find(c, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "isDeleted", Value: false}, {Key: "referrerResidentId", Value: r.ID}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(50))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []referralRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	rewards := map[string]rewardRow{}
	var approved, paid int64
	if len(rows) > 0 {
		ids := bson.A{}
		for _, x := range rows {
			ids = append(ids, x.ID)
		}
		cur, err := h.DB.Collection("referralrewards").Find(c, bson.D{{Key: "referralId", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var rs []rewardRow
		if err := cur.All(c, &rs); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, x := range rs {
			rewards[x.ReferralID.Hex()] = x
			if x.Status == "APPROVED" {
				approved += x.Amount
			}
			if x.Status == "PAID" {
				paid += x.Amount
			}
		}
	}
	out := referralOut{ReferralCode: ordered.Map{{Key: "code", Value: code.Code}, {Key: "convertedCount", Value: code.ConvertedCount}, {Key: "createdAt", Value: isoAny(code.CreatedAt)}, {Key: "hostelId", Value: code.HostelID.Hex()},
		{Key: "id", Value: code.ID.Hex()}, {Key: "joinedCount", Value: code.JoinedCount}, {Key: "link", Value: "/inquiry?ref=" + httpx.EncodeURIComponent(code.Code)}, {Key: "residentId", Value: code.ResidentID.Hex()},
		{Key: "rewardCount", Value: code.RewardCount}, {Key: "status", Value: code.Status}, {Key: "updatedAt", Value: isoAny(code.UpdatedAt)}, {Key: "userId", Value: code.UserID.Hex()}},
		Referrals: []ordered.Map{}, Resident: residents.Summary(r)}
	out.Summary = referralSummary{RewardApprovedAmount: approved, RewardPaidAmount: paid, Sent: len(rows)}
	for _, x := range rows {
		if x.Converted {
			out.Summary.Converted++
		}
		if x.Status == "JOINED" || x.Status == "REWARDED" {
			out.Summary.Joined++
		}
		var reward any
		if w, ok := rewards[x.ID.Hex()]; ok {
			reward = ordered.Map{{Key: "amount", Value: w.Amount}, {Key: "approvedAt", Value: isoAny(w.ApprovedAt)}, {Key: "approvedBy", Value: oidAny(w.ApprovedBy)}, {Key: "hostelId", Value: w.HostelID.Hex()}, {Key: "id", Value: w.ID.Hex()},
				{Key: "notes", Value: w.Notes}, {Key: "referralId", Value: w.ReferralID.Hex()}, {Key: "referrerResidentId", Value: w.ReferrerResidentID.Hex()}, {Key: "rewardType", Value: w.RewardType}, {Key: "status", Value: w.Status}}
		}
		out.Referrals = append(out.Referrals, ordered.Map{{Key: "confirmedAt", Value: isoAny(x.ConfirmedAt)}, {Key: "confirmedBy", Value: oidAny(x.ConfirmedBy)}, {Key: "converted", Value: x.Converted}, {Key: "convertedAt", Value: isoAny(x.ConvertedAt)},
			{Key: "createdAt", Value: isoAny(x.CreatedAt)}, {Key: "email", Value: x.Email}, {Key: "hostelId", Value: x.HostelID.Hex()}, {Key: "id", Value: x.ID.Hex()}, {Key: "inquiryId", Value: oidAny(x.InquiryID)},
			{Key: "joinedResidentId", Value: oidAny(x.JoinedResidentID)}, {Key: "message", Value: x.Message}, {Key: "name", Value: x.Name}, {Key: "phone", Value: x.Phone}, {Key: "referralCodeId", Value: x.ReferralCodeID.Hex()},
			{Key: "referrerResidentId", Value: x.ReferrerResidentID.Hex()}, {Key: "status", Value: x.Status}, {Key: "updatedAt", Value: isoAny(x.UpdatedAt)}, {Key: "reward", Value: reward}})
	}
	httpx.OK(c, out, "Referral code loaded")
}

// --- offer program -------------------------------------------------------------

type offerOut struct {
	Awards  []ordered.Map `json:"awards"`
	Perks   []ordered.Map `json:"perks"`
	Quarter ordered.Map   `json:"quarter"`
}

func (h *Handler) offer(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	quarter, err := offerprogram.QuarterOf(now)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var year, q int
	_, _ = fmt.Sscanf(quarter, "%d-Q%d", &year, &q)
	first := (q-1)*3 + 1
	from, err := bs.PeriodBounds(bs.FormatPeriodKey(year, first))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	to, err := bs.PeriodBounds(bs.FormatPeriodKey(year, first+2))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.DB.Collection("receipts").Aggregate(c, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "residentId", Value: r.ID}, {Key: "certificationCode", Value: bson.D{{Key: "$type", Value: "string"}}},
			{Key: "certifiedAt", Value: bson.D{{Key: "$gte", Value: from.Start}, {Key: "$lte", Value: to.End}}}, {Key: "voidedAt", Value: nil}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "amount", Value: bson.D{{Key: "$sum", Value: "$amount"}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var totals []struct {
		Amount int64 `bson:"amount"`
		Count  int   `bson:"count"`
	}
	if err := cur.All(c, &totals); err != nil {
		httpx.Fail(c, err)
		return
	}
	var total struct {
		Amount int64
		Count  int
	}
	if len(totals) > 0 {
		total.Amount, total.Count = totals[0].Amount, totals[0].Count
	}
	cur, err = h.DB.Collection("offerperks").Find(c, bson.D{{Key: "isActive", Value: true}}, options.Find().SetSort(bson.D{{Key: "sortOrder", Value: 1}, {Key: "createdAt", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var perks []struct {
		ID          bson.ObjectID `bson:"_id"`
		Description string        `bson:"description"`
		GiftValue   *float64      `bson:"giftValue"`
		ImageURL    string        `bson:"imageUrl"`
		IsActive    bool          `bson:"isActive"`
		Kind        string        `bson:"kind"`
		Partner     string        `bson:"partner"`
		PercentOff  *float64      `bson:"percentOff"`
		SortOrder   int           `bson:"sortOrder"`
		Title       string        `bson:"title"`
	}
	if err := cur.All(c, &perks); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err = h.DB.Collection("offerawards").Find(c, bson.D{{Key: "residentId", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "CANCELLED"}}}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var awards []struct {
		ID               bson.ObjectID  `bson:"_id"`
		AppliedAmount    *float64       `bson:"appliedAmount"`
		AppliedAt        *time.Time     `bson:"appliedAt"`
		AppliedInvoiceID *bson.ObjectID `bson:"appliedInvoiceId"`
		CreatedAt        time.Time      `bson:"createdAt"`
		DeliveredAt      *time.Time     `bson:"deliveredAt"`
		HostelPaidAt     *time.Time     `bson:"hostelPaidAt"`
		Kind             string         `bson:"kind"`
		Note             string         `bson:"note"`
		PercentOff       *float64       `bson:"percentOff"`
		Quarter          string         `bson:"quarter"`
		Status           string         `bson:"status"`
		Title            string         `bson:"title"`
	}
	if err := cur.All(c, &awards); err != nil {
		httpx.Fail(c, err)
		return
	}
	periods := map[string]string{}
	ids := bson.A{}
	for _, a := range awards {
		if a.AppliedInvoiceID != nil {
			ids = append(ids, *a.AppliedInvoiceID)
		}
	}
	if len(ids) > 0 {
		cur, err := h.DB.Collection("invoices").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var rows []struct {
			ID     bson.ObjectID `bson:"_id"`
			Period string        `bson:"period"`
		}
		if err := cur.All(c, &rows); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, x := range rows {
			periods[x.ID.Hex()] = x.Period
		}
	}
	nullTime := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return httpx.ISO(*t)
	}
	nullNum := func(n *float64) any {
		if n == nil {
			return nil
		}
		return *n
	}
	out := offerOut{Awards: []ordered.Map{}, Perks: []ordered.Map{}}
	for _, a := range awards {
		var period any
		if a.AppliedInvoiceID != nil {
			if key := periods[a.AppliedInvoiceID.Hex()]; key != "" {
				label := bs.FormatPeriod(key)
				if label == "" {
					label = key
				}
				period = label
			}
		}
		out.Awards = append(out.Awards, ordered.Map{{Key: "appliedAmount", Value: nullNum(a.AppliedAmount)}, {Key: "appliedAt", Value: nullTime(a.AppliedAt)}, {Key: "appliedPeriod", Value: period}, {Key: "awardedAt", Value: httpx.ISO(a.CreatedAt)},
			{Key: "deliveredAt", Value: nullTime(a.DeliveredAt)}, {Key: "hostelPaidAt", Value: nullTime(a.HostelPaidAt)}, {Key: "id", Value: a.ID.Hex()}, {Key: "kind", Value: a.Kind}, {Key: "note", Value: a.Note}, {Key: "percentOff", Value: nullNum(a.PercentOff)},
			{Key: "quarter", Value: a.Quarter}, {Key: "quarterLabel", Value: quarterLabelOf(a.Quarter)}, {Key: "status", Value: a.Status}, {Key: "title", Value: a.Title}})
	}
	for _, x := range perks {
		partner := x.Partner
		if partner == "" {
			partner = email.PlatformName
		}
		out.Perks = append(out.Perks, ordered.Map{{Key: "description", Value: x.Description}, {Key: "giftValue", Value: nullNum(x.GiftValue)}, {Key: "id", Value: x.ID.Hex()}, {Key: "imageUrl", Value: x.ImageURL}, {Key: "isActive", Value: x.IsActive},
			{Key: "kind", Value: x.Kind}, {Key: "partner", Value: partner}, {Key: "percentOff", Value: nullNum(x.PercentOff)}, {Key: "sortOrder", Value: x.SortOrder}, {Key: "title", Value: x.Title}})
	}
	out.Quarter = ordered.Map{{Key: "certifiedAmount", Value: total.Amount}, {Key: "certifiedCount", Value: total.Count}, {Key: "from", Value: httpx.ISO(from.Start)}, {Key: "key", Value: quarter},
		{Key: "label", Value: offerprogram.QuarterLabel(quarter)}, {Key: "to", Value: httpx.ISO(to.End)}}
	httpx.OK(c, out, "Offer Program")
}

var quarterKey = regexp.MustCompile(`^\d{4}-Q[1-4]$`)

func quarterLabelOf(q string) string {
	if quarterKey.MatchString(q) {
		return offerprogram.QuarterLabel(q)
	}
	return q
}

// --- reviews -------------------------------------------------------------------

type reviewRow struct {
	ID                bson.ObjectID  `bson:"_id"`
	CleanlinessRating *float64       `bson:"cleanlinessRating"`
	Comment           string         `bson:"comment"`
	CreatedAt         *time.Time     `bson:"createdAt"`
	FoodRating        *float64       `bson:"foodRating"`
	HiddenAt          *time.Time     `bson:"hiddenAt"`
	HiddenBy          *bson.ObjectID `bson:"hiddenBy"`
	HostelID          bson.ObjectID  `bson:"hostelId"`
	LocationRating    *float64       `bson:"locationRating"`
	ManagementRating  *float64       `bson:"managementRating"`
	OverallRating     float64        `bson:"overallRating"`
	ResidentID        bson.ObjectID  `bson:"residentId"`
	RoomRating        *float64       `bson:"roomRating"`
	SafetyRating      *float64       `bson:"safetyRating"`
	Status            string         `bson:"status"`
	UpdatedAt         *time.Time     `bson:"updatedAt"`
	UserID            bson.ObjectID  `bson:"userId"`
}

func serializeReview(r *reviewRow) ordered.Map {
	num := func(n *float64) any {
		if n == nil {
			return ordered.Undefined
		}
		return *n
	}
	return ordered.Map{{Key: "cleanlinessRating", Value: num(r.CleanlinessRating)}, {Key: "comment", Value: r.Comment}, {Key: "createdAt", Value: isoAny(r.CreatedAt)}, {Key: "foodRating", Value: num(r.FoodRating)},
		{Key: "hiddenAt", Value: isoAny(r.HiddenAt)}, {Key: "hiddenBy", Value: oidAny(r.HiddenBy)}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: r.ID.Hex()}, {Key: "locationRating", Value: num(r.LocationRating)},
		{Key: "managementRating", Value: num(r.ManagementRating)}, {Key: "overallRating", Value: r.OverallRating}, {Key: "residentId", Value: r.ResidentID.Hex()}, {Key: "roomRating", Value: num(r.RoomRating)},
		{Key: "safetyRating", Value: num(r.SafetyRating)}, {Key: "status", Value: r.Status}, {Key: "updatedAt", Value: isoAny(r.UpdatedAt)}, {Key: "userId", Value: r.UserID.Hex()}}
}

type reviewOut struct {
	Resident ordered.Map `json:"resident"`
	Review   ordered.Map `json:"review"`
}

func (h *Handler) review(c *gin.Context) {
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
	star := func(key string, opt bool) (float64, bool) {
		return f.Num(key, valid.N{Opt: opt, Int: true, Min: valid.P(1), Max: valid.P(5)})
	}
	set := bson.D{}
	if v, ok := star("cleanlinessRating", true); ok {
		set = append(set, bson.E{Key: "cleanlinessRating", Value: v})
	}
	comment, hasComment := f.Str("comment", valid.S{Opt: true, Trim: true, Max: 3000})
	if hasComment {
		set = append(set, bson.E{Key: "comment", Value: comment})
	}
	for _, k := range []string{"foodRating", "locationRating", "managementRating"} {
		if v, ok := star(k, true); ok {
			set = append(set, bson.E{Key: k, Value: v})
		}
	}
	overall, _ := star("overallRating", false)
	set = append(set, bson.E{Key: "overallRating", Value: overall})
	for _, k := range []string{"roomRating", "safetyRating"} {
		if v, ok := star(k, true); ok {
			set = append(set, bson.E{Key: k, Value: v})
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if r.Status != "ACTIVE" && r.Status != "MOVED_OUT" {
		httpx.Fail(c, httpx.NewError(403, "REVIEW_NOT_ALLOWED", "Only verified current or past residents can review.", nil))
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := h.DB.Collection("ratingreviews")
	match := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}
	n, err := coll.CountDocuments(c, match, options.Count().SetLimit(1))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	set = append(set, bson.E{Key: "hostelId", Value: r.HostelID}, bson.E{Key: "residentId", Value: r.ID}, bson.E{Key: "status", Value: "VISIBLE"}, bson.E{Key: "userId", Value: uid}, bson.E{Key: "updatedAt", Value: now})
	var row reviewRow
	err = coll.FindOneAndUpdate(c, match, bson.D{{Key: "$set", Value: set}, {Key: "$unset", Value: bson.D{{Key: "hiddenAt", Value: ""}, {Key: "hiddenBy", Value: ""}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{Action: "REVIEW_SUBMITTED", ActorID: uid, EntityID: row.ID.Hex(), EntityType: "RatingReview", HostelID: row.HostelID, Metadata: bson.D{}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Bump, realtime.Change{HostelIDs: []string{row.HostelID.Hex()}, Platform: true, Topics: []realtime.Topic{realtime.Reviews}})
	h.notifyReview(c, r, &row, n > 0)
	httpx.Write(c, 201, reviewOut{residents.Summary(r), serializeReview(&row)}, "Review submitted")
}

func (h *Handler) notifyReview(ctx context.Context, r *residents.Record, row *reviewRow, update bool) {
	staff, err := residents.HostelStaffUserIDs(ctx, h.DB, row.HostelID, false)
	if err != nil {
		return
	}
	excerpt := "No written comment."
	if t := valid.Trim(row.Comment); t != "" {
		excerpt = t
		if valid.JSLen(t) > 160 {
			excerpt = valid.JSPrefix(t, 157) + "…"
		}
	}
	whole := max(1, min(5, int(row.OverallRating)))
	body := strings.Repeat("★", whole) + strings.Repeat("☆", 5-whole) + " " + strconv.FormatFloat(row.OverallRating, 'f', 1, 64) + " — " + excerpt
	priority := "NORMAL"
	if row.OverallRating <= 2 {
		priority = "HIGH"
	}
	title := r.FullName() + " left a review"
	if update {
		title = r.FullName() + " updated their review"
	}
	for _, id := range staff {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/reports", Body: body, Category: "REVIEW", Data: ordered.Map{{Key: "reviewId", Value: row.ID.Hex()}}, HostelID: row.HostelID.Hex(), Priority: priority, Title: title, UserID: id})
	}
}

// --- QuestionCall --------------------------------------------------------------

type qcClick struct {
	ClickID     string  `json:"clickId"`
	RedirectURL any     `json:"redirectUrl"`
	SSOCode     *string `json:"ssoCode"`
}

func (h *Handler) qcClick(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c) // .catch(() => ({}))
	if err != nil {
		body = map[string]any{}
	}
	f := valid.NewForm(body)
	web := "web"
	device, _ := f.Enum("deviceType", false, &web, "web", "android", "ios")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID := r.UserID
	if userID == nil {
		id, err := httpx.OID(p.UserID, "user id")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		userID = &id
	}
	var user struct {
		Email           string     `bson:"email"`
		EmailVerified   bool       `bson:"emailVerified"`
		EmailVerifiedAt *time.Time `bson:"emailVerifiedAt"`
		Status          *string    `bson:"status"`
	}
	err = h.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: *userID}}).Decode(&user)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	canSSO := err == nil && user.Email != "" && (user.EmailVerified || user.EmailVerifiedAt != nil) && (user.Status == nil || *user.Status == "ACTIVE")
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "residentId", Value: r.ID}, {Key: "userId", Value: *userID}, {Key: "hostelId", Value: r.HostelID}, {Key: "clickedAt", Value: now}, {Key: "deviceType", Value: device}, {Key: "converted", Value: false}}
	out := qcClick{ClickID: id.Hex()}
	if canSSO {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		secret := base64.RawURLEncoding.EncodeToString(b)
		sum := sha256.Sum256([]byte(secret))
		doc = append(doc, bson.E{Key: "ssoCodeHash", Value: hex.EncodeToString(sum[:])}, bson.E{Key: "ssoExpiresAt", Value: now.Add(5 * time.Minute)})
		code := id.Hex() + "." + secret
		out.SSOCode = &code
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("questioncallclicks").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	section, err := h.Config.Section(c, "questionCall")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if m, ok := section.(ordered.Map); ok {
		out.RedirectURL, _ = m.Get("url")
	} else if m, ok := section.(map[string]any); ok {
		out.RedirectURL = m["url"]
	}
	httpx.OK(c, out, "QuestionCall click recorded")
}

func (h *Handler) qcStatus(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := h.DB.Collection("questioncallclicks")
	var latest struct {
		ClickedAt *time.Time `bson:"clickedAt"`
		Converted bool       `bson:"converted"`
	}
	err = coll.FindOne(c, bson.D{{Key: "residentId", Value: r.ID}}, options.FindOne().SetSort(bson.D{{Key: "clickedAt", Value: -1}})).Decode(&latest)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	n, err := coll.CountDocuments(c, bson.D{{Key: "residentId", Value: r.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "clickCount", Value: n}, {Key: "converted", Value: latest.Converted}, {Key: "eligible", Value: true}, {Key: "lastClickedAt", Value: isoAny(latest.ClickedAt)}}, "QuestionCall status loaded")
}

// --- leaving notice ------------------------------------------------------------

type noticeResident struct {
	residents.Record `bson:",inline"`
	LeavingOn        *time.Time `bson:"leavingOn"`
	LeavingReason    *string    `bson:"leavingReason"`
}

func (h *Handler) noticeResident(c *gin.Context) (*noticeResident, error) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		return nil, err
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		return nil, err
	}
	var row noticeResident
	if err := h.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: r.ID}}).Decode(&row); err != nil {
		return nil, err
	}
	return &row, nil
}

func (h *Handler) noticeDays(ctx context.Context, hostelID bson.ObjectID) (int, error) {
	var row struct {
		Days int `bson:"moveOutNoticeDays"`
	}
	err := h.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}, options.FindOne().SetProjection(bson.D{{Key: "moveOutNoticeDays", Value: 1}})).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return 0, err
	}
	return row.Days, nil
}

type leavingOut struct {
	Earliest       string  `json:"earliest"`
	LeavingOn      *string `json:"leavingOn"`
	LeavingOnLabel *string `json:"leavingOnLabel"`
	NoticeDays     int     `json:"noticeDays"`
	Reason         *string `json:"reason"`
}

func earliestDay(days int) time.Time {
	return bs.Today(time.Now()).Add(time.Duration(max(days, 0)) * 24 * time.Hour)
}

func leavingSnapshot(on *time.Time, reason *string, days int) leavingOut {
	out := leavingOut{Earliest: earliestDay(days).Format("2006-01-02"), NoticeDays: days, Reason: reason}
	if on != nil {
		key, label := on.UTC().Format("2006-01-02"), bs.FormatDate(*on)
		out.LeavingOn, out.LeavingOnLabel = &key, &label
	}
	return out
}

func (h *Handler) leavingGet(c *gin.Context) {
	r, err := h.noticeResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	days, err := h.noticeDays(c, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, leavingSnapshot(r.LeavingOn, r.LeavingReason, days), "Leaving notice")
}

func (h *Handler) tellStaff(ctx context.Context, r *noticeResident, title, body string) {
	staff, err := residents.HostelStaffUserIDs(ctx, h.DB, r.HostelID, false)
	if err != nil {
		return
	}
	for _, id := range staff {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/residents", Body: body, Category: "ACCOUNT",
			Data: ordered.Map{{Key: "residentId", Value: r.ID.Hex()}, {Key: "type", Value: "RESIDENT_LEAVING"}}, HostelID: r.HostelID.Hex(), Title: title, UserID: id})
	}
}

var dayPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (h *Handler) leavingPut(c *gin.Context) {
	if _, err := h.Guards.RequireResident(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	date, _ := f.Str("date", valid.S{Re: dayPattern, ReMsg: "Pick a day."})
	reason, hasReason := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 300})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := h.noticeResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	days, err := h.noticeDays(c, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	day, perr := time.Parse("2006-01-02", date)
	earliest := earliestDay(days)
	if perr != nil || day.Before(earliest) {
		msg := "Pick today or a later day."
		if days > 0 {
			msg = fmt.Sprintf("This hostel needs %d days' notice. The earliest day is %s.", days, bs.FormatDate(earliest))
		}
		httpx.Fail(c, httpx.NewError(400, "LEAVING_TOO_SOON", msg, nil))
		return
	}
	var stored any
	var out *string
	if hasReason && reason != "" {
		stored, out = reason, &reason
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := h.DB.Collection("residents").UpdateOne(c, bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lastMonthCharge", Value: "TILL_DAY"}, {Key: "leavingNoticeAt", Value: now},
		{Key: "leavingOn", Value: day}, {Key: "leavingReason", Value: stored}, {Key: "moveOutDate", Value: day}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	title := r.FullName() + " is leaving"
	if r.LeavingOn != nil {
		title = r.FullName() + " changed their leaving day"
	}
	text := "Leaving on " + bs.FormatDate(day) + "."
	if out != nil {
		text += " " + *out
	}
	h.tellStaff(c, r, title, text)
	httpx.OK(c, leavingSnapshot(&day, out, days), "Leaving day saved")
}

func (h *Handler) leavingDelete(c *gin.Context) {
	r, err := h.noticeResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	days, err := h.noticeDays(c, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if r.LeavingOn == nil {
		httpx.OK(c, leavingSnapshot(nil, r.LeavingReason, days), "Notice cancelled")
		return
	}
	if _, err := h.DB.Collection("residents").UpdateOne(c, bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lastMonthCharge", Value: nil}, {Key: "leavingOn", Value: nil}, {Key: "leavingReason", Value: nil},
		{Key: "moveOutDate", Value: nil}, {Key: "updatedAt", Value: time.Now().UTC()}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.tellStaff(c, r, r.FullName()+" is staying", "They cancelled their move-out notice.")
	httpx.OK(c, leavingSnapshot(nil, nil, days), "Notice cancelled")
}

// --- my room -------------------------------------------------------------------

var liveStatuses = bson.A{"ACTIVE", "PENDING", "SUSPENDED"}

type roomMe struct {
	ID        bson.ObjectID  `bson:"_id"`
	FirstName string         `bson:"firstName"`
	Floor     *int           `bson:"floor"`
	HostelID  bson.ObjectID  `bson:"hostelId"`
	LastName  string         `bson:"lastName"`
	RoomID    *bson.ObjectID `bson:"roomId"`
	RoomNum   *string        `bson:"roomNumber"`
	RoomType  string         `bson:"roomType"`
}

func (h *Handler) ownResident(c *gin.Context) (*roomMe, string, error) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		return nil, "", err
	}
	hostels := bson.A{}
	for _, id := range p.HostelIDs {
		if oid, err := bson.ObjectIDFromHex(id); err == nil {
			hostels = append(hostels, oid)
		}
	}
	uid, err := bson.ObjectIDFromHex(p.UserID)
	if err != nil {
		return nil, "", err
	}
	var me roomMe
	err = h.DB.Collection("residents").FindOne(c, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: hostels}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: uid}}).Decode(&me)
	if err == mongo.ErrNoDocuments {
		return nil, "", httpx.NewError(404, "RESIDENT_NOT_FOUND", "You are not living in a hostel right now.", nil)
	}
	if err != nil {
		return nil, "", err
	}
	return &me, p.UserID, nil
}

func (h *Handler) roomTracking(ctx context.Context, hostelID bson.ObjectID) (bool, error) {
	var row struct {
		RoomTracking *bool `bson:"roomTracking"`
	}
	err := h.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&row)
	if err != nil && err != mongo.ErrNoDocuments {
		return false, err
	}
	if row.RoomTracking != nil {
		return *row.RoomTracking, nil
	}
	n, err := h.DB.Collection("hostelrooms").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}}, options.Count().SetLimit(1))
	return n > 0, err
}

type roomRow struct {
	ID       bson.ObjectID `bson:"_id"`
	Beds     int           `bson:"beds"`
	Floor    int           `bson:"floor"`
	Number   string        `bson:"number"`
	Position *int          `bson:"position"`
	RoomType string        `bson:"roomType"`
}

// naturalLess is localeCompare(…, {numeric: true}) for room numbers.
func naturalLess(a, b string) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		if isDigit(a[i]) && isDigit(b[j]) {
			si, sj := i, j
			for i < len(a) && isDigit(a[i]) {
				i++
			}
			for j < len(b) && isDigit(b[j]) {
				j++
			}
			x, _ := strconv.Atoi(a[si:i])
			y, _ := strconv.Atoi(b[sj:j])
			if x != y {
				return x < y
			}
			continue
		}
		ca, cb := strings.ToLower(a[i:i+1]), strings.ToLower(b[j:j+1])
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	return len(a)-i < len(b)-j
}

func isDigit(b byte) bool { return b >= '0' && b <= '9' }

// roomsWithFree is loadRooms + viewRooms: the layout's order, and free beds.
func (h *Handler) roomsWithFree(ctx context.Context, hostelID bson.ObjectID) ([]roomRow, map[string]int, error) {
	cur, err := h.DB.Collection("hostelrooms").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}})
	if err != nil {
		return nil, nil, err
	}
	var rooms []roomRow
	if err := cur.All(ctx, &rooms); err != nil {
		return nil, nil, err
	}
	pos := func(r roomRow) int {
		if r.Position != nil {
			return *r.Position
		}
		return 1<<53 - 1
	}
	sort.SliceStable(rooms, func(i, j int) bool {
		a, b := rooms[i], rooms[j]
		if a.Floor != b.Floor {
			return a.Floor < b.Floor
		}
		if pos(a) != pos(b) {
			return pos(a) < pos(b)
		}
		return naturalLess(a.Number, b.Number)
	})
	cur, err = h.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$in", Value: liveStatuses}}}},
		options.Find().SetProjection(bson.D{{Key: "roomId", Value: 1}}))
	if err != nil {
		return nil, nil, err
	}
	var living []struct {
		RoomID *bson.ObjectID `bson:"roomId"`
	}
	if err := cur.All(ctx, &living); err != nil {
		return nil, nil, err
	}
	used := map[string]int{}
	for _, x := range living {
		if x.RoomID != nil {
			used[x.RoomID.Hex()]++
		}
	}
	free := map[string]int{}
	for _, r := range rooms {
		free[r.ID.Hex()] = max(r.Beds-used[r.ID.Hex()], 0)
	}
	return rooms, free, nil
}

func (h *Handler) roomOptions(ctx context.Context, me *roomMe) (ordered.Map, error) {
	rooms, free, err := h.roomsWithFree(ctx, me.HostelID)
	if err != nil {
		return nil, err
	}
	var req struct {
		ID            bson.ObjectID `bson:"_id"`
		CreatedAt     time.Time     `bson:"createdAt"`
		DeclineReason *string       `bson:"declineReason"`
		Status        string        `bson:"status"`
		ToRoomID      bson.ObjectID `bson:"toRoomId"`
	}
	reqErr := h.DB.Collection("roomchangerequests").FindOne(ctx, bson.D{{Key: "residentId", Value: me.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "DECLINED"}}}}}, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&req)
	if reqErr != nil && reqErr != mongo.ErrNoDocuments {
		return nil, reqErr
	}
	tracking, err := h.roomTracking(ctx, me.HostelID)
	if err != nil {
		return nil, err
	}
	var current any
	if me.RoomID != nil {
		var floor, number any
		if me.Floor != nil {
			floor = *me.Floor
		}
		if me.RoomNum != nil {
			number = *me.RoomNum
		}
		current = ordered.Map{{Key: "floor", Value: floor}, {Key: "number", Value: number}, {Key: "roomType", Value: me.RoomType}}
	}
	freeRooms := []ordered.Map{}
	for _, r := range rooms {
		if free[r.ID.Hex()] > 0 && (me.RoomID == nil || *me.RoomID != r.ID) {
			freeRooms = append(freeRooms, ordered.Map{{Key: "beds", Value: r.Beds}, {Key: "floor", Value: r.Floor}, {Key: "free", Value: free[r.ID.Hex()]}, {Key: "id", Value: r.ID.Hex()}, {Key: "number", Value: r.Number}, {Key: "roomType", Value: r.RoomType}})
		}
	}
	var request any
	if reqErr == nil {
		var to any
		for _, r := range rooms {
			if r.ID == req.ToRoomID {
				to = ordered.Map{{Key: "floor", Value: r.Floor}, {Key: "number", Value: r.Number}, {Key: "roomType", Value: r.RoomType}}
			}
		}
		var reason any
		if req.DeclineReason != nil {
			reason = *req.DeclineReason
		}
		request = ordered.Map{{Key: "createdAt", Value: httpx.ISO(req.CreatedAt)}, {Key: "declineReason", Value: reason}, {Key: "id", Value: req.ID.Hex()}, {Key: "status", Value: req.Status}, {Key: "to", Value: to}}
	}
	return ordered.Map{{Key: "current", Value: current}, {Key: "freeRooms", Value: freeRooms}, {Key: "request", Value: request}, {Key: "tracking", Value: tracking}}, nil
}

func (h *Handler) roomGet(c *gin.Context) {
	me, _, err := h.ownResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.roomOptions(c, me)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "My room")
}

func floorLabel(floor int) string {
	if floor == 0 {
		return "Ground floor"
	}
	if floor < 0 {
		if floor == -1 {
			return "Basement"
		}
		return "Basement " + strconv.Itoa(-floor)
	}
	suffix := "th"
	if tens := floor % 100; tens < 11 || tens > 13 {
		switch floor % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return strconv.Itoa(floor) + suffix + " floor"
}

func (h *Handler) cancelOpenRequests(ctx context.Context, residentID bson.ObjectID) error {
	_, err := h.DB.Collection("roomchangerequests").UpdateMany(ctx, bson.D{{Key: "residentId", Value: residentID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "DECLINED"}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "CANCELLED"}, {Key: "updatedAt", Value: time.Now().UTC()}}}})
	return err
}

func (h *Handler) roomAsk(c *gin.Context) {
	if _, err := h.Guards.RequireResident(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 200})
	toRoom := ""
	if f.M != nil {
		v, present := f.M["toRoomId"]
		toRoom, _ = valid.ObjectID(v, "toRoomId", "Invalid id.", &f.Is, !present)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	me, userID, err := h.ownResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	tracking, err := h.roomTracking(c, me.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !tracking {
		httpx.Fail(c, httpx.NewError(409, "ROOM_TRACKING_OFF", "Your hostel does not keep residents by room number.", nil))
		return
	}
	toID, _ := bson.ObjectIDFromHex(toRoom)
	if me.RoomID != nil && *me.RoomID == toID {
		httpx.Fail(c, httpx.NewError(409, "SAME_ROOM", "You are already in that room.", nil))
		return
	}
	var room roomRow
	err = h.DB.Collection("hostelrooms").FindOne(c, bson.D{{Key: "_id", Value: toID}, {Key: "hostelId", Value: me.HostelID}, {Key: "isDeleted", Value: false}}).Decode(&room)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, httpx.NewError(404, "ROOM_NOT_FOUND", "That room is not in this hostel.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	living, err := h.DB.Collection("residents").CountDocuments(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: me.ID}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "roomId", Value: room.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: liveStatuses}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if int(living) >= room.Beds {
		httpx.Fail(c, httpx.NewError(409, "ROOM_FULL", "Room "+room.Number+" is full.", nil))
		return
	}
	if err := h.cancelOpenRequests(c, me.ID); err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(userID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var from any
	if me.RoomID != nil {
		from = *me.RoomID
	}
	doc := bson.D{{Key: "hostelId", Value: me.HostelID}, {Key: "residentId", Value: me.ID}, {Key: "fromRoomId", Value: from}, {Key: "toRoomId", Value: room.ID}}
	if hasNote {
		doc = append(doc, bson.E{Key: "note", Value: note})
	}
	doc = append(doc, bson.E{Key: "status", Value: "PENDING"}, bson.E{Key: "requestedBy", Value: uid}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.DB.Collection("roomchangerequests").InsertOne(c, doc); err != nil {
		httpx.Fail(c, err)
		return
	}
	text := strings.TrimSpace(me.FirstName+" "+me.LastName) + " asks to move to Room " + room.Number + " (" + residents.RoomTypeLabel(room.RoomType) + ", " + floorLabel(room.Floor) + ")."
	if note != "" {
		text += " “" + note + "”"
	}
	staff, err := residents.HostelStaffUserIDs(c, h.DB, me.HostelID, false)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	for _, id := range staff {
		_, _ = h.Notify.CreateInApp(c, notifications.Input{ActionURL: "/hostel-admin/rooms", Body: text, Category: "ROOM", Data: ordered.Map{{Key: "type", Value: "ROOM_CHANGE_REQUEST"}}, HostelID: me.HostelID.Hex(), Title: "Room change request", UserID: id})
	}
	out, err := h.roomOptions(c, me)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, 201, out, "Request sent")
}

func (h *Handler) roomCancel(c *gin.Context) {
	me, _, err := h.ownResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.cancelOpenRequests(c, me.ID); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.roomOptions(c, me)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Request cancelled")
}
