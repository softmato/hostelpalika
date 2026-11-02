package hostelreferrals

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const dailyInvites = 20

// Admin is what a hostel sees of the referral program: its code, who joined on it,
// and an invite by email.
type Admin struct {
	Service *Service
	Guards  *authz.Guards
	Audit   *audit.Log
	Mail    *email.Sender
	AppURL  func(path string) string
}

func (a *Admin) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/hostel-referrals", httpx.ETag(), a.overview)
	v1.POST("/hostel-admin/hostel-referrals/invite", a.invite)
}

func (a *Admin) link(code string) string {
	return a.AppURL("/register-hostel?ref=" + url.QueryEscape(code))
}

// OrCreateCode is getOrCreateHostelCode. Two requests racing land on the unique
// index; the loser reads the winner's code back.
func (s *Service) OrCreateCode(ctx context.Context, hostel bson.ObjectID) (string, error) {
	coll := s.db.Collection("hostelreferralcodes")
	read := func() (string, error) {
		var row struct {
			Code string `bson:"code"`
		}
		err := coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "kind", Value: "HOSTEL"}}).Decode(&row)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return "", nil
		}
		return row.Code, err
	}
	code, err := read()
	if err != nil || code != "" {
		return code, err
	}
	var row struct {
		Name string `bson:"name"`
	}
	err = s.db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", httpx.NewError(http.StatusNotFound, "NOT_FOUND", "That hostel was not found.", nil)
	}
	if err != nil {
		return "", err
	}
	letters := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return -1
		}
		return r
	}, Normalize(row.Name))
	if len(letters) > 4 {
		letters = letters[:4]
	}
	if letters == "" {
		letters = "HP"
	}
	id := strings.ToUpper(hostel.Hex())
	for _, n := range []int{5, 7, 10, 24} {
		candidate := letters + id[len(id)-n:]
		now := time.Now().UTC().Truncate(time.Millisecond)
		_, err := coll.InsertOne(ctx, bson.D{{Key: "code", Value: candidate}, {Key: "hostelId", Value: hostel}, {Key: "kind", Value: "HOSTEL"}, {Key: "status", Value: "ACTIVE"}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
		if err == nil {
			return candidate, nil
		}
		if !mongo.IsDuplicateKeyError(err) {
			return "", err
		}
		if raced, err := read(); err != nil || raced != "" {
			return raced, err
		}
	}
	return "", httpx.NewError(http.StatusBadRequest, "HOSTEL_REFERRAL_ERROR", "Could not make a referral code. Try again.", nil)
}

type bonusOut struct {
	Days   int    `json:"days"`
	Months int    `json:"months"`
	Text   string `json:"text"`
}

type inviteRow struct {
	CreatedAt   string    `json:"createdAt"`
	HostelName  string    `json:"hostelName"`
	ID          string    `json:"id"`
	LiveAt      *string   `json:"liveAt"`
	Reward      PlanBonus `json:"reward"`
	RewardAdded bool      `json:"rewardAdded"`
	RewardText  string    `json:"rewardText"`
	Status      string    `json:"status"`
}

type overviewOut struct {
	Code      string      `json:"code"`
	Enabled   bool        `json:"enabled"`
	Link      string      `json:"link"`
	Referrals []inviteRow `json:"referrals"`
	TheyGet   bonusOut    `json:"theyGet"`
	YouGet    bonusOut    `json:"youGet"`
}

func (a *Admin) overview(c *gin.Context) {
	p, err := a.Guards.RequireHostelStaff(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	code, err := a.Service.OrCreateCode(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	settings := a.Service.Settings(c)
	cur, err := a.Service.db.Collection("hostelreferrals").Find(c, bson.D{{Key: "referrerHostelId", Value: hostel}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(100))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID             bson.ObjectID `bson:"_id"`
		CreatedAt      time.Time     `bson:"createdAt"`
		LiveAt         *time.Time    `bson:"liveAt"`
		RefereeHostel  bson.ObjectID `bson:"refereeHostelId"`
		ReferrerApplie *time.Time    `bson:"referrerAppliedAt"`
		Reward         PlanBonus     `bson:"referrerReward"`
		Status         string        `bson:"status"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := make(bson.A, len(rows))
	for i := range rows {
		ids[i] = rows[i].RefereeHostel
	}
	names := map[bson.ObjectID]string{}
	if len(ids) > 0 {
		hc, err := a.Service.db.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var hs []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name string        `bson:"name"`
		}
		if err := hc.All(c, &hs); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, h := range hs {
			names[h.ID] = h.Name
		}
	}
	out := overviewOut{Code: code, Enabled: settings.Enabled, Link: a.link(code), Referrals: make([]inviteRow, len(rows)),
		TheyGet: bonusOut{settings.Referee.Days, settings.Referee.Months, Describe(settings.Referee)}, YouGet: bonusOut{settings.Referrer.Days, settings.Referrer.Months, Describe(settings.Referrer)}}
	for i := range rows {
		x := &rows[i]
		name := names[x.RefereeHostel]
		if name == "" {
			name = "A hostel"
		}
		line := inviteRow{CreatedAt: httpx.ISO(x.CreatedAt), HostelName: name, ID: x.ID.Hex(), Reward: x.Reward, RewardAdded: x.ReferrerApplie != nil, RewardText: Describe(x.Reward), Status: x.Status}
		if x.LiveAt != nil {
			s := httpx.ISO(*x.LiveAt)
			line.LiveAt = &s
		}
		out.Referrals[i] = line
	}
	httpx.Write(c, 200, out, "Hostel referrals")
}

func (a *Admin) invite(c *gin.Context) {
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
	to, _ := f.Email("email", false, "")
	to = strings.ToLower(to)
	hostel, _ := f.Str("hostelId", valid.S{Opt: true, Trim: true})
	name, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Max: 120})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	settings := a.Service.Settings(c)
	if !settings.Enabled {
		httpx.Fail(c, httpx.NewError(http.StatusBadRequest, "REFERRAL_PAUSED", "Hostel referrals are paused right now.", nil))
		return
	}
	sent, err := a.Service.db.Collection("auditlogs").CountDocuments(c, bson.D{{Key: "action", Value: "HOSTEL_REFERRAL_INVITE_SENT"}, {Key: "createdAt", Value: bson.D{{Key: "$gte", Value: time.Now().Add(-24 * time.Hour)}}}, {Key: "hostelId", Value: hostelID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if sent >= dailyInvites {
		httpx.Fail(c, httpx.NewError(http.StatusTooManyRequests, "INVITE_LIMIT", "You can send "+strconv.Itoa(dailyInvites)+" invites a day. Share the link instead.", nil))
		return
	}
	code, err := a.Service.OrCreateCode(c, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var row struct {
		Name string `bson:"name"`
	}
	if err := a.Service.db.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: hostelID}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&row); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	from := row.Name
	if from == "" {
		from = email.PlatformName
	}
	invitee := ""
	if hasName {
		invitee = name
	}
	mail := email.HostelReferralInvite(code, from, invitee, a.link(code), Describe(settings.Referee))
	if !a.Mail.Notify(c, email.Notification{Action: "hostel_referral_invite", HTML: mail.HTML, Subject: mail.Subject, To: to, Category: mail.Category}) {
		httpx.Fail(c, httpx.NewError(http.StatusBadGateway, "INVITE_FAILED", "The invite could not be sent. Try again.", nil))
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "HOSTEL_REFERRAL_INVITE_SENT", ActorID: uid, EntityID: hostelID.Hex(), EntityType: "Hostel", HostelID: hostelID, Metadata: bson.D{{Key: "email", Value: to}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "sentTo", Value: to}}, "Invite sent")
}
