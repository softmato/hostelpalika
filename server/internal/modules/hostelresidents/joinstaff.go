package hostelresidents

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/qr"
)

// The staff side of the resident join link: resident-join.service.ts.

const (
	joinLinkSpare  = 6
	addLock        = 6 * time.Minute
	addedShownDays = 30
)

func joinErr(msg, code string, status int) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

func newToken() string {
	b := make([]byte, 9)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (s *Service) ensureLink(ctx context.Context, hostel bson.ObjectID, p *authz.Principal) (*residents.JoinLink, error) {
	coll := s.DB.Collection("residentjoinlinks")
	var l residents.JoinLink
	err := coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&l)
	if err == nil {
		return &l, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	h, err := s.loadFreeBeds(ctx, hostel)
	if err != nil {
		return nil, err
	}
	capacity := h
	if capacity < 1 {
		capacity = 1
	}
	by, at := bsonUser(p), now()
	id := bson.NewObjectID()
	token := newToken()
	_, err = coll.InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "cap", Value: capacity + joinLinkSpare}, {Key: "createdBy", Value: by}, {Key: "hostelId", Value: hostel}, {Key: "token", Value: token},
		{Key: "updatedBy", Value: by}, {Key: "enabled", Value: true}, {Key: "used", Value: 0}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
	if mongo.IsDuplicateKeyError(err) {
		err = coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&l)
		return &l, err
	}
	if err != nil {
		return nil, err
	}
	err = coll.FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&l)
	return &l, err
}

func (s *Service) loadFreeBeds(ctx context.Context, hostel bson.ObjectID) (int, error) {
	var h struct {
		Rooms []struct {
			Vacant float64 `bson:"vacantBeds"`
		} `bson:"roomConfigurations"`
	}
	err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return 0, err
	}
	sum := 0.0
	for _, r := range h.Rooms {
		sum += r.Vacant
	}
	return int(sum), nil
}

func (s *Service) linkView(ctx context.Context, l *residents.JoinLink) (ordered.Map, error) {
	url := s.AppURL("/join/" + l.Token)
	var qrURL any
	if data, err := qr.DataURL(url, qr.Options{Width: 480, Margin: 1, SetMargin: true}); err == nil {
		qrURL = data
	}
	waiting, err := s.DB.Collection("residentapplications").CountDocuments(ctx, bson.D{{Key: "hostelId", Value: l.HostelID}, {Key: "status", Value: "PENDING"}})
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "cap", Value: l.Cap}, {Key: "enabled", Value: l.Enabled}, {Key: "qrDataUrl", Value: qrURL}, {Key: "url", Value: url}, {Key: "used", Value: l.Used}, {Key: "waiting", Value: waiting}}, nil
}

// JoinLink is getJoinLink.
func (s *Service) JoinLink(ctx context.Context, hostel bson.ObjectID, p *authz.Principal) (ordered.Map, error) {
	l, err := s.ensureLink(ctx, hostel, p)
	if err != nil {
		return nil, err
	}
	return s.linkView(ctx, l)
}

// JoinLinkIn is joinLinkUpdateSchema.
type JoinLinkIn struct {
	Cap     *int
	Enabled *bool
	Renew   bool
}

// UpdateJoinLink is updateJoinLink.
func (s *Service) UpdateJoinLink(ctx context.Context, hostel bson.ObjectID, in JoinLinkIn, p *authz.Principal) (ordered.Map, error) {
	if _, err := s.ensureLink(ctx, hostel, p); err != nil {
		return nil, err
	}
	set := bson.D{}
	if in.Cap != nil {
		set = append(set, bson.E{Key: "cap", Value: *in.Cap})
	}
	if in.Enabled != nil {
		set = append(set, bson.E{Key: "enabled", Value: *in.Enabled})
	}
	if in.Renew {
		set = append(set, bson.E{Key: "token", Value: newToken()})
	}
	set = append(set, bson.E{Key: "updatedBy", Value: bsonUser(p)}, bson.E{Key: "updatedAt", Value: now()})
	var l residents.JoinLink
	if err := s.DB.Collection("residentjoinlinks").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&l); err != nil {
		return nil, err
	}
	return s.linkView(ctx, &l)
}

// JoinRequests is listJoinRequests.
func (s *Service) JoinRequests(ctx context.Context, hostel bson.ObjectID) (ordered.Map, error) {
	since := now().Add(-addedShownDays * 24 * time.Hour)
	cur, err := s.DB.Collection("residentapplications").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "$or", Value: bson.A{
		bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "REJECTED"}}}}},
		bson.D{{Key: "decidedAt", Value: bson.D{{Key: "$gte", Value: since}}}, {Key: "status", Value: "ADDED"}}}}},
		options.Find().SetSort(bson.D{{Key: "sentAt", Value: -1}}).SetLimit(300))
	if err != nil {
		return nil, err
	}
	var requests []residents.JoinRequest
	if err := cur.All(ctx, &requests); err != nil {
		return nil, err
	}
	period := currentPeriod()
	h, err := s.joinHostel(ctx, hostel)
	if err != nil {
		return nil, err
	}
	types, err := s.pub().RoomTypesFor(ctx, hostel, h.Rooms)
	if err != nil {
		return nil, err
	}
	var rows []residents.ListRow
	for _, r := range requests {
		if r.Status == "PENDING" {
			rows = append(rows, r.ListRow())
		}
	}
	var cctx residents.CheckContext
	if len(rows) > 0 {
		if cctx, err = s.listContext(ctx, hostel, rows, types, nil); err != nil {
			return nil, err
		}
	}
	out := make([]any, len(requests))
	for i, r := range requests {
		if r.Status != "PENDING" || len(rows) == 0 {
			out[i] = r.View(residents.JoinChecked{}, period)
			continue
		}
		check := residents.CheckExistingResidents([]residents.ListRow{r.ListRow()}, cctx)
		problems := append([]string{}, check.ListProblems...)
		for _, p := range check.Rows[0].Problems {
			problems = append(problems, p.Message)
		}
		out[i] = r.View(residents.JoinChecked{Bills: check.Rows[0].Bills, Problems: problems, Rent: check.Rows[0].Rent}, period)
	}
	return ordered.Map{{Key: "currentMonth", Value: ordered.Map{{Key: "label", Value: residents.MonthLabel(period)}, {Key: "period", Value: period}}}, {Key: "requests", Value: out}, {Key: "waiting", Value: len(rows)}}, nil
}

func (s *Service) joinHostel(ctx context.Context, hostel bson.ObjectID) (*listHostel, error) {
	var h listHostel
	err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}, liveUser}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "roomConfigurations", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, joinErr("This hostel is no longer on the app.", "HOSTEL_NOT_FOUND", http.StatusNotFound)
	}
	return &h, err
}

func (s *Service) findRequest(ctx context.Context, hostel bson.ObjectID, id string) (*residents.JoinRequest, error) {
	missing := joinErr("That request was not found.", "JOIN_REQUEST_NOT_FOUND", http.StatusNotFound)
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil || len(id) != 24 {
		return nil, missing
	}
	var r residents.JoinRequest
	err = s.DB.Collection("residentapplications").FindOne(ctx, bson.D{{Key: "_id", Value: oid}, {Key: "hostelId", Value: hostel}}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, missing
	}
	return &r, err
}

func answered(r *residents.JoinRequest) error {
	if r.Status == "ADDED" {
		return joinErr(r.FullName+" is already added.", "JOIN_REQUEST_ANSWERED", http.StatusConflict)
	}
	return joinErr(r.FullName+"'s request was sent back. It comes here again when they fix it.", "JOIN_REQUEST_ANSWERED", http.StatusConflict)
}

// AddJoinRequest is addJoinRequest.
func (s *Service) AddJoinRequest(ctx context.Context, hostel bson.ObjectID, id string, p *authz.Principal, roomNumber string) (ordered.Map, error) {
	r, err := s.findRequest(ctx, hostel, id)
	if err != nil {
		return nil, err
	}
	if r.Status != "PENDING" {
		return nil, answered(r)
	}
	coll := s.DB.Collection("residentapplications")
	at, by := now(), bsonUser(p)
	var locked residents.JoinRequest
	err = coll.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: "PENDING"}, {Key: "$or", Value: bson.A{bson.D{{Key: "decidedAt", Value: nil}}, bson.D{{Key: "decidedAt", Value: bson.D{{Key: "$lt", Value: at.Add(-addLock)}}}}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: at}, {Key: "decidedBy", Value: by}, {Key: "updatedAt", Value: at}}}}).Decode(&locked)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, joinErr("Someone is adding them right now.", "JOIN_REQUEST_BUSY", http.StatusConflict)
	}
	if err != nil {
		return nil, err
	}
	row := RowIn{DepositPaid: int64(r.DepositPaid), Email: r.Email, FullName: r.FullName, JoinedDate: r.JoinedDate, PartPaid: int64(r.PartPaid), Phone: r.Phone, RoomNumber: roomNumber, RoomType: r.RoomType}
	if r.PaidTill != "" {
		v := r.PaidTill
		row.PaidTill = &v
	}
	added, _, err := s.AddScanned(ctx, hostel, row, r.CardID, p)
	if err != nil {
		_, _ = coll.UpdateOne(context.WithoutCancel(ctx), bson.D{{Key: "_id", Value: r.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: nil}, {Key: "updatedAt", Value: now()}}}})
		return nil, err
	}
	var resident any
	var residentOID any
	if added.ResidentID != "" {
		resident = added.ResidentID
		residentOID, _ = bson.ObjectIDFromHex(added.ResidentID)
	}
	if _, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: now()}, {Key: "decidedBy", Value: by}, {Key: "residentId", Value: residentOID}, {Key: "status", Value: "ADDED"}, {Key: "updatedAt", Value: now()}}}}); err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "residentId", Value: resident}, {Key: "result", Value: added.Result.JSON()}}, nil
}

// ReturnJoinRequest is returnJoinRequest.
func (s *Service) ReturnJoinRequest(ctx context.Context, hostel bson.ObjectID, id, reason string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.findRequest(ctx, hostel, id)
	if err != nil {
		return nil, err
	}
	at := now()
	res, err := s.DB.Collection("residentapplications").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "decidedAt", Value: nil}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: at}, {Key: "decidedBy", Value: bsonUser(p)}, {Key: "rejectReason", Value: reason}, {Key: "status", Value: "REJECTED"}, {Key: "updatedAt", Value: at}}}})
	if err != nil {
		return nil, err
	}
	if res.MatchedCount == 0 {
		if r.Status == "PENDING" {
			return nil, joinErr("Someone is adding them right now.", "JOIN_REQUEST_BUSY", http.StatusConflict)
		}
		return nil, answered(r)
	}
	req := *r
	s.runAfter(ctx, func(c context.Context) error { s.tellReturned(c, &req, reason); return nil })
	return ordered.Map{{Key: "ok", Value: true}}, nil
}

func (s *Service) tellReturned(ctx context.Context, r *residents.JoinRequest, reason string) {
	var link struct {
		Token string `bson:"token"`
	}
	_ = s.DB.Collection("residentjoinlinks").FindOne(ctx, bson.D{{Key: "hostelId", Value: s.requestHostel(ctx, r.ID)}}, options.FindOne().SetProjection(bson.D{{Key: "token", Value: 1}})).Decode(&link)
	name := strings.TrimSpace(s.hostelNameOr(ctx, s.requestHostel(ctx, r.ID), "Your hostel"))
	path := "/"
	if link.Token != "" {
		path = "/join/" + link.Token
	}
	var user struct {
		UserID bson.ObjectID `bson:"userId"`
	}
	_ = s.DB.Collection("residentapplications").FindOne(ctx, bson.D{{Key: "_id", Value: r.ID}}, options.FindOne().SetProjection(bson.D{{Key: "userId", Value: 1}})).Decode(&user)
	if _, err := s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: path, Body: reason + " — fix it and send again.", Category: "ACCOUNT", Priority: "HIGH", Title: name + " sent your request back", UserID: user.UserID.Hex()}); err != nil {
		slog.WarnContext(ctx, "Join request: sent back, but the person was not told", "error", err)
		return
	}
	if r.Email != "" {
		first := strings.Fields(r.FullName)
		who := r.FullName
		if len(first) > 0 {
			who = first[0]
		}
		c := email.JoinRequestReturned(s.AppURL(path), name, reason, who)
		s.Mail.Send(ctx, email.Message{Category: c.Category, To: []string{r.Email}, Subject: c.Subject, HTML: c.HTML})
	}
}

// requestHostel reads a request's hostel (the view type does not carry it).
func (s *Service) requestHostel(ctx context.Context, id bson.ObjectID) bson.ObjectID {
	var r struct {
		HostelID bson.ObjectID `bson:"hostelId"`
	}
	_ = s.DB.Collection("residentapplications").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "hostelId", Value: 1}})).Decode(&r)
	return r.HostelID
}
