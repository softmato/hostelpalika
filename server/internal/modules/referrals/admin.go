package referrals

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Admin is the hostel's referral board: who brought whom, and what they earned.
type Admin struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	Notify *notifications.Service
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/referrals", httpx.ETag(), a.list)
	v1.PATCH("/hostel-admin/referrals/:id/confirm", a.confirm)
	v1.PATCH("/hostel-admin/referrals/:id/reward", a.reward)
}

const notifyCategory = "PAYMENT"

var rewardTypes = []string{"DISCOUNT", "CASH", "SERVICE_CREDIT", "OTHER"}

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
	Amount             float64        `bson:"amount"`
	ApprovedAt         *time.Time     `bson:"approvedAt"`
	ApprovedBy         *bson.ObjectID `bson:"approvedBy"`
	HostelID           bson.ObjectID  `bson:"hostelId"`
	Notes              string         `bson:"notes"`
	ReferralID         bson.ObjectID  `bson:"referralId"`
	ReferrerResidentID bson.ObjectID  `bson:"referrerResidentId"`
	RewardType         string         `bson:"rewardType"`
	Status             string         `bson:"status"`
}

func when(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

func hexOf(id *bson.ObjectID) any {
	if id == nil {
		return ordered.Undefined
	}
	return id.Hex()
}

func serializeReferral(r *referralRow) ordered.Map {
	return ordered.Map{{Key: "confirmedAt", Value: when(r.ConfirmedAt)}, {Key: "confirmedBy", Value: hexOf(r.ConfirmedBy)}, {Key: "converted", Value: r.Converted}, {Key: "convertedAt", Value: when(r.ConvertedAt)}, {Key: "createdAt", Value: when(r.CreatedAt)},
		{Key: "email", Value: r.Email}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: r.ID.Hex()}, {Key: "inquiryId", Value: hexOf(r.InquiryID)}, {Key: "joinedResidentId", Value: hexOf(r.JoinedResidentID)}, {Key: "message", Value: r.Message},
		{Key: "name", Value: r.Name}, {Key: "phone", Value: r.Phone}, {Key: "referralCodeId", Value: r.ReferralCodeID.Hex()}, {Key: "referrerResidentId", Value: r.ReferrerResidentID.Hex()}, {Key: "status", Value: r.Status}, {Key: "updatedAt", Value: when(r.UpdatedAt)}}
}

func serializeReward(r *rewardRow) any {
	if r == nil {
		return nil
	}
	return ordered.Map{{Key: "amount", Value: r.Amount}, {Key: "approvedAt", Value: when(r.ApprovedAt)}, {Key: "approvedBy", Value: hexOf(r.ApprovedBy)}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: r.ID.Hex()}, {Key: "notes", Value: r.Notes},
		{Key: "referralId", Value: r.ReferralID.Hex()}, {Key: "referrerResidentId", Value: r.ReferrerResidentID.Hex()}, {Key: "rewardType", Value: r.RewardType}, {Key: "status", Value: r.Status}}
}

type person struct {
	ID        bson.ObjectID `bson:"_id"`
	FirstName string        `bson:"firstName"`
	LastName  string        `bson:"lastName"`
	Phone     string        `bson:"phone"`
	RoomType  string        `bson:"roomType"`
}

func (a *Admin) people(ctx context.Context, ids bson.A) (map[bson.ObjectID]person, error) {
	out := map[bson.ObjectID]person{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := a.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "phone", Value: 1}, {Key: "roomType", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []person
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = r
	}
	return out, nil
}

// nameOf is referrerName.
func nameOf(p person, _ bool) string {
	if name := strings.TrimSpace(p.FirstName + " " + p.LastName); name != "" {
		return name
	}
	return "—"
}

type summaryOut struct {
	ByStatus             ordered.Map `json:"byStatus"`
	Converted            int64       `json:"converted"`
	Joined               int         `json:"joined"`
	PendingConfirmation  int         `json:"pendingConfirmation"`
	RewardApprovedAmount float64     `json:"rewardApprovedAmount"`
	RewardPaidAmount     float64     `json:"rewardPaidAmount"`
	RewardPendingAmount  float64     `json:"rewardPendingAmount"`
	Total                int         `json:"total"`
}

type topReferrer struct {
	Code        string `json:"code"`
	ID          string `json:"id"`
	JoinedCount int    `json:"joinedCount"`
	Name        string `json:"name"`
	RewardCount int    `json:"rewardCount"`
	RoomType    string `json:"roomType"`
}

type listOut struct {
	Referrals    []ordered.Map   `json:"referrals"`
	Pagination   pagination.Meta `json:"pagination"`
	Summary      summaryOut      `json:"summary"`
	TopReferrers []topReferrer   `json:"topReferrers"`
}

func (a *Admin) list(c *gin.Context) {
	p, err := a.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	hostel := opsscope.Hostel(q, &is)
	status := valid.QueryEnum(q, "status", &is, "INQUIRY_CREATED", "JOINED", "REWARDED", "CANCELLED")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	summaryFilter := append(bson.D{{Key: "isDeleted", Value: false}}, scope...)
	filter := append(bson.D{}, summaryFilter...)
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	refs := a.DB.Collection("referrals")
	r := pagination.RangeOf(page)
	cur, err := refs.Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []referralRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := refs.CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rewards := map[bson.ObjectID]*rewardRow{}
	referrers, ids := bson.A{}, bson.A{}
	for i := range rows {
		ids = append(ids, rows[i].ID)
		referrers = append(referrers, rows[i].ReferrerResidentID)
	}
	if len(ids) > 0 {
		rc, err := a.DB.Collection("referralrewards").Find(c, bson.D{{Key: "referralId", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var list []rewardRow
		if err := rc.All(c, &list); err != nil {
			httpx.Fail(c, err)
			return
		}
		for i := range list {
			rewards[list[i].ReferralID] = &list[i]
		}
	}
	byReferrer, err := a.people(c, referrers)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cc, err := a.DB.Collection("referralcodes").Find(c, scope, options.Find().SetSort(bson.D{{Key: "joinedCount", Value: -1}}).SetLimit(10))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var codes []struct {
		ID          bson.ObjectID `bson:"_id"`
		Code        string        `bson:"code"`
		JoinedCount int           `bson:"joinedCount"`
		ResidentID  bson.ObjectID `bson:"residentId"`
		RewardCount int           `bson:"rewardCount"`
	}
	if err := cc.All(c, &codes); err != nil {
		httpx.Fail(c, err)
		return
	}
	leaders := bson.A{}
	for i := range codes {
		leaders = append(leaders, codes[i].ResidentID)
	}
	byLeader, err := a.people(c, leaders)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sc, err := refs.Aggregate(c, bson.A{bson.D{{Key: "$match", Value: summaryFilter}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$status"}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var counts []struct {
		ID    string `bson:"_id"`
		Count int    `bson:"count"`
	}
	if err := sc.All(c, &counts); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := listOut{Referrals: make([]ordered.Map, len(rows)), Pagination: pagination.MetaOf(page, int(total)), Summary: summaryOut{ByStatus: ordered.Map{}}, TopReferrers: []topReferrer{}}
	for _, x := range counts {
		out.Summary.ByStatus = append(out.Summary.ByStatus, ordered.Pair{Key: x.ID, Value: x.Count})
		out.Summary.Total += x.Count
		switch x.ID {
		case "JOINED", "REWARDED":
			out.Summary.Joined += x.Count
		case "INQUIRY_CREATED":
			out.Summary.PendingConfirmation = x.Count
		}
	}
	if out.Summary.Converted, err = refs.CountDocuments(c, append(append(bson.D{}, summaryFilter...), bson.E{Key: "converted", Value: true})); err != nil {
		httpx.Fail(c, err)
		return
	}
	mc, err := a.DB.Collection("referralrewards").Aggregate(c, bson.A{bson.D{{Key: "$match", Value: scope}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$status"}, {Key: "amount", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var sums []struct {
		ID     string  `bson:"_id"`
		Amount float64 `bson:"amount"`
	}
	if err := mc.All(c, &sums); err != nil {
		httpx.Fail(c, err)
		return
	}
	for _, x := range sums {
		switch x.ID {
		case "APPROVED":
			out.Summary.RewardApprovedAmount = x.Amount
		case "PAID":
			out.Summary.RewardPaidAmount = x.Amount
		case "PENDING":
			out.Summary.RewardPendingAmount = x.Amount
		}
	}
	for i := range rows {
		who, ok := byReferrer[rows[i].ReferrerResidentID]
		base := serializeReferral(&rows[i])
		out.Referrals[i] = append(base, ordered.Pair{Key: "referrerName", Value: nameOf(who, ok)}, ordered.Pair{Key: "referrerPhone", Value: who.Phone}, ordered.Pair{Key: "reward", Value: serializeReward(rewards[rows[i].ID])})
	}
	for i := range codes {
		if codes[i].JoinedCount <= 0 && codes[i].RewardCount <= 0 {
			continue
		}
		who, ok := byLeader[codes[i].ResidentID]
		out.TopReferrers = append(out.TopReferrers, topReferrer{codes[i].Code, codes[i].ID.Hex(), codes[i].JoinedCount, nameOf(who, ok), codes[i].RewardCount, who.RoomType})
	}
	httpx.Write(c, 200, out, "Referrals loaded")
}

func (a *Admin) find(c *gin.Context, p *authz.Principal, hostel string) (*referralRow, error) {
	id, err := httpx.OID(c.Param("id"), "referral id")
	if err != nil {
		return nil, err
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		return nil, err
	}
	var r referralRow
	err = a.DB.Collection("referrals").FindOne(c, append(bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}, scope...)).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(http.StatusNotFound, "REFERRAL_NOT_FOUND", "Referral was not found.", nil)
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (a *Admin) upsertReward(ctx context.Context, referral bson.ObjectID, set bson.D, at time.Time) (*rewardRow, error) {
	var out rewardRow
	err := a.DB.Collection("referralrewards").FindOneAndUpdate(ctx, bson.D{{Key: "referralId", Value: referral}}, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: at})}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (a *Admin) reward(c *gin.Context) {
	p, err := a.Guards.RequireHostelStaff(c)
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
	amount, hasAmount := f.Num("amount", valid.N{Opt: true, Coerce: true, Min: valid.P(0)})
	notes, hasNotes := f.Str("notes", valid.S{Opt: true, Trim: true, Max: 500})
	rewardType, hasType := f.Enum("rewardType", true, nil, rewardTypes...)
	status, _ := f.Enum("status", false, nil, "PENDING", "APPROVED", "PAID", "CANCELLED")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := a.find(c, p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if r.Status == "INQUIRY_CREATED" {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "REFERRAL_NOT_CONFIRMED", "Confirm the referral as joined before recording a reward.", nil))
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "referrerResidentId", Value: r.ReferrerResidentID}, {Key: "status", Value: status}}
	if hasAmount {
		set = append(set, bson.E{Key: "amount", Value: amount})
	}
	if hasNotes {
		set = append(set, bson.E{Key: "notes", Value: notes})
	}
	if hasType {
		set = append(set, bson.E{Key: "rewardType", Value: rewardType})
	}
	if status == "PAID" {
		set = append(set, bson.E{Key: "approvedAt", Value: at}, bson.E{Key: "approvedBy", Value: uid})
	}
	var prior struct {
		Status string `bson:"status"`
	}
	if err := a.DB.Collection("referralrewards").FindOne(c, bson.D{{Key: "referralId", Value: r.ID}}).Decode(&prior); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	reward, err := a.upsertReward(c, r.ID, set, at)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	next := r.Status
	if status == "PAID" {
		next = "REWARDED"
	}
	var updated referralRow
	if err := a.DB.Collection("referrals").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: next}, {Key: "updatedBy", Value: uid}, {Key: "updatedAt", Value: at}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "REFERRAL_REWARD_UPDATED", ActorID: uid, EntityID: r.ID.Hex(), EntityType: "Referral", HostelID: r.HostelID, Metadata: bson.D{{Key: "amount", Value: reward.Amount}, {Key: "status", Value: status}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	kind := reward.RewardType
	if kind == "" {
		kind = rewardType
	}
	a.notifyReward(c, r, reward.Amount, prior.Status, kind, status)
	httpx.OK(c, ordered.Map{{Key: "referral", Value: serializeReferral(&updated)}, {Key: "reward", Value: serializeReward(reward)}}, "Referral reward updated")
}

func (a *Admin) confirm(c *gin.Context) {
	p, err := a.Guards.RequireHostelStaff(c)
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
	discount, zero := "DISCOUNT", 0.0
	hostel := opsscope.BodyHostel(f)
	var joinedRaw string
	if raw, ok := f.M["joinedResidentId"]; ok {
		joinedRaw, _ = valid.ObjectID(raw, "joinedResidentId", "", &f.Is, false)
	}
	amount, _ := f.Num("rewardAmount", valid.N{Coerce: true, Min: valid.P(0), Default: &zero})
	notes, hasNotes := f.Str("rewardNotes", valid.S{Opt: true, Trim: true, Max: 500})
	rewardType, _ := f.Enum("rewardType", false, &discount, rewardTypes...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := a.find(c, p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "confirmedAt", Value: at}, {Key: "confirmedBy", Value: uid}}
	if joinedRaw != "" {
		id, err := httpx.OID(joinedRaw, "resident id")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		n, err := a.DB.Collection("residents").CountDocuments(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}, {Key: "isDeleted", Value: false}}, options.Count().SetLimit(1))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if n == 0 {
			httpx.Fail(c, httpx.NewError(http.StatusNotFound, "RESIDENT_NOT_FOUND", "Joined resident was not found.", nil))
			return
		}
		set = append(set, bson.E{Key: "joinedResidentId", Value: id})
	}
	set = append(set, bson.E{Key: "status", Value: "JOINED"}, bson.E{Key: "updatedBy", Value: uid}, bson.E{Key: "updatedAt", Value: at})
	var updated referralRow
	err = a.DB.Collection("referrals").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "REFERRAL_NOT_FOUND", "Referral was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rewardStatus := "PENDING"
	if amount > 0 {
		rewardStatus = "APPROVED"
	}
	rs := bson.D{{Key: "amount", Value: amount}, {Key: "approvedAt", Value: at}, {Key: "approvedBy", Value: uid}, {Key: "hostelId", Value: r.HostelID}}
	if hasNotes {
		rs = append(rs, bson.E{Key: "notes", Value: notes})
	}
	rs = append(rs, bson.E{Key: "referrerResidentId", Value: r.ReferrerResidentID}, bson.E{Key: "rewardType", Value: rewardType}, bson.E{Key: "status", Value: rewardStatus})
	reward, err := a.upsertReward(c, r.ID, rs, at)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	already := r.Status != "INQUIRY_CREATED"
	joined, rewarded := 0, 0
	if !already {
		joined = 1
		if amount > 0 {
			rewarded = 1
		}
	}
	if _, err := a.DB.Collection("referralcodes").UpdateOne(c, bson.D{{Key: "_id", Value: r.ReferralCodeID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "joinedCount", Value: joined}, {Key: "rewardCount", Value: rewarded}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "REFERRAL_JOINED_CONFIRMED", ActorID: uid, EntityID: r.ID.Hex(), EntityType: "Referral", HostelID: r.HostelID, Metadata: bson.D{{Key: "rewardAmount", Value: amount}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !already {
		a.notifyJoined(c, r)
	}
	httpx.OK(c, ordered.Map{{Key: "referral", Value: serializeReferral(&updated)}, {Key: "reward", Value: serializeReward(reward)}}, "Referral confirmed")
}

// referrerUser is the referrer's live account, or "" when nobody will read a row.
func (a *Admin) referrerUser(ctx context.Context, resident bson.ObjectID) string {
	var row struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := a.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: resident}}, options.FindOne().SetProjection(bson.D{{Key: "userId", Value: 1}})).Decode(&row); err != nil || row.UserID == nil {
		return ""
	}
	n, err := a.DB.Collection("users").CountDocuments(ctx, bson.D{{Key: "_id", Value: *row.UserID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Count().SetLimit(1))
	if err != nil || n == 0 {
		return ""
	}
	return row.UserID.Hex()
}

func (a *Admin) notifyJoined(ctx context.Context, r *referralRow) {
	user := a.referrerUser(ctx, r.ReferrerResidentID)
	if user == "" {
		return
	}
	name, err := residents.HostelName(ctx, a.DB, r.HostelID)
	if err != nil {
		return
	}
	_, _ = a.Notify.CreateInApp(ctx, notifications.Input{Body: "Someone you referred has joined " + name + ". Your reward is with the hostel office.", Category: notifyCategory, Data: ordered.Map{{Key: "kind", Value: "REFERRAL_JOINED"}}, HostelID: r.HostelID.Hex(), Priority: "NORMAL", Title: "Your referral joined", UserID: user})
}

func thousands(v float64) string {
	whole, frac := int64(v), ""
	if float64(whole) != v {
		s := strconv.FormatFloat(v, 'f', 3, 64)
		frac = strings.TrimRight(s[strings.IndexByte(s, '.'):], "0")
	}
	s := strconv.FormatInt(whole, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s + frac
}

func (a *Admin) notifyReward(ctx context.Context, r *referralRow, amount float64, previous, rewardType, status string) {
	kind := "reward"
	switch rewardType {
	case "CASH":
		kind = "cash reward"
	case "DISCOUNT":
		kind = "discount"
	case "SERVICE_CREDIT":
		kind = "service credit"
	}
	worth := ""
	if amount > 0 {
		worth = " of NPR " + thousands(amount)
	}
	var body func(string) string
	title := ""
	switch {
	case status == "APPROVED":
		body, title = func(h string) string {
			return h + " approved your referral " + kind + worth + ". It is not paid out yet."
		}, "Your referral reward is approved"
	case status == "PAID":
		body, title = func(h string) string { return h + " has paid your referral " + kind + worth + "." }, "Your referral reward is paid"
	case status == "CANCELLED" && (previous == "APPROVED" || previous == "PAID"):
		body, title = func(h string) string {
			return h + " has cancelled your referral " + kind + ". Speak to the hostel office."
		}, "Your referral reward was cancelled"
	default:
		return
	}
	user := a.referrerUser(ctx, r.ReferrerResidentID)
	if user == "" {
		return
	}
	name, err := residents.HostelName(ctx, a.DB, r.HostelID)
	if err != nil {
		return
	}
	_, _ = a.Notify.CreateInApp(ctx, notifications.Input{Body: body(name), Category: notifyCategory, Data: ordered.Map{{Key: "kind", Value: "REFERRAL_REWARD"}, {Key: "status", Value: status}}, HostelID: r.HostelID.Hex(), Priority: "NORMAL", Title: title, UserID: user})
}
