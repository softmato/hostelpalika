// Package wardens is modules/wardens: a hostel admin's wardens and what each may do.
package wardens

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Service struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	Issuer *users.Issuer
	Limits *billing.Limits
	Notify *notifications.Service
}

func (s *Service) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/wardens", httpx.ETag(), s.list)
	v1.POST("/hostel-admin/wardens", s.create)
	v1.PATCH("/hostel-admin/wardens/:id", s.update)
	v1.DELETE("/hostel-admin/wardens/:id", s.deactivate)
}

var (
	permissionKeys = []string{"registerResidents", "editHostelProfile", "manageRooms", "viewPayments", "approvePayments", "recordCash", "reversePayments", "manageFeeSchedule", "managePaymentProfile", "manageFood", "manageNotices",
		"viewComplaints", "updateComplaints", "viewNightStatus", "updateNightStatus", "manageMaintenance", "recordExpenses", "expenseWithoutProof", "manageStock", "approveStockCount", "verifyPayments"}
	defaultPermissions = []string{"registerResidents", "viewPayments", "approvePayments", "recordCash", "manageFood", "manageNotices", "viewComplaints", "updateComplaints", "viewNightStatus", "updateNightStatus", "manageMaintenance", "recordExpenses", "manageStock"}
)

type member struct {
	ID          bson.ObjectID `bson:"_id"`
	CreatedAt   *time.Time    `bson:"createdAt"`
	HostelID    bson.ObjectID `bson:"hostelId"`
	Permissions []string      `bson:"permissions"`
	Role        string        `bson:"role"`
	Status      string        `bson:"status"`
	UpdatedAt   *time.Time    `bson:"updatedAt"`
	UserID      bson.ObjectID `bson:"userId"`
}

type account struct {
	ID    bson.ObjectID `bson:"_id"`
	Email string        `bson:"email"`
	Name  string        `bson:"name"`
	Phone string        `bson:"phone"`
}

func serialize(m *member, u *account) ordered.Map {
	date := func(t *time.Time) any {
		if t == nil {
			return ordered.Undefined
		}
		return httpx.ISO(*t)
	}
	email, name, phone := "", "Unnamed warden", ""
	if u != nil {
		email, phone = u.Email, u.Phone
		if u.Name != "" {
			name = u.Name
		}
	}
	perms := m.Permissions
	if perms == nil {
		perms = []string{}
	}
	return ordered.Map{{Key: "createdAt", Value: date(m.CreatedAt)}, {Key: "email", Value: email}, {Key: "hostelId", Value: m.HostelID.Hex()}, {Key: "id", Value: m.ID.Hex()}, {Key: "name", Value: name}, {Key: "permissions", Value: perms},
		{Key: "phone", Value: phone}, {Key: "role", Value: m.Role}, {Key: "status", Value: m.Status}, {Key: "updatedAt", Value: date(m.UpdatedAt)}, {Key: "userId", Value: m.UserID.Hex()}}
}

func (s *Service) hydrate(ctx context.Context, id bson.ObjectID) (*account, error) {
	var u account
	err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "email", Value: 1}, {Key: "phone", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Service) find(c *gin.Context, p *authz.Principal, hostel string) (*member, error) {
	id, err := httpx.OID(c.Param("id"), "warden id")
	if err != nil {
		return nil, err
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		return nil, err
	}
	var m member
	err = s.DB.Collection("hostelmembers").FindOne(c, append(bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "role", Value: "WARDEN"}}, scope...)).Decode(&m)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, notFound()
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func notFound() error {
	return httpx.NewError(http.StatusNotFound, "WARDEN_NOT_FOUND", "Warden was not found.", nil)
}

type listOut struct {
	Pagination pagination.Meta `json:"pagination"`
	Wardens    []ordered.Map   `json:"wardens"`
}

func (s *Service) list(c *gin.Context) {
	p, err := s.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := opsscope.ReadPage(q, &is)
	hostel := opsscope.Hostel(q, &is)
	status := valid.QueryEnum(q, "status", &is, "ACTIVE", "INVITED", "SUSPENDED", "REMOVED")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	scope, err := opsscope.Filter(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := append(bson.D{{Key: "isDeleted", Value: false}, {Key: "role", Value: "WARDEN"}}, scope...)
	if status != nil {
		filter = append(filter, bson.E{Key: "status", Value: *status})
	}
	r := pagination.RangeOf(page)
	cur, err := s.DB.Collection("hostelmembers").Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(r.Skip)).SetLimit(int64(r.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []member
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := s.DB.Collection("hostelmembers").CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byID := map[bson.ObjectID]*account{}
	if len(rows) > 0 {
		ids := make(bson.A, len(rows))
		for i := range rows {
			ids[i] = rows[i].UserID
		}
		uc, err := s.DB.Collection("users").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "email", Value: 1}, {Key: "phone", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var accounts []account
		if err := uc.All(c, &accounts); err != nil {
			httpx.Fail(c, err)
			return
		}
		for i := range accounts {
			byID[accounts[i].ID] = &accounts[i]
		}
	}
	out := listOut{Pagination: pagination.MetaOf(page, int(total)), Wardens: make([]ordered.Map, len(rows))}
	for i := range rows {
		out.Wardens[i] = serialize(&rows[i], byID[rows[i].UserID])
	}
	httpx.Write(c, 200, out, "Wardens loaded")
}

// readPermissions is permissionsSchema.optional().
func readPermissions(f *valid.Form) ([]string, bool) {
	list, ok := f.Array("permissions", true, false)
	if !ok {
		return nil, false
	}
	f.Size("permissions", len(list), 0, len(permissionKeys), "", false)
	out := make([]string, 0, len(list))
	for i, v := range list {
		sub := valid.NewForm(map[string]any{"v": v})
		key, _ := sub.Enum("v", false, nil, permissionKeys...)
		f.JoinScalar("permissions."+strconv.Itoa(i), sub)
		out = append(out, key)
	}
	return out, true
}

func (s *Service) create(c *gin.Context) {
	p, err := s.Guards.RequireHostelAdmin(c)
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
	email, _ := f.Email("email", false, "")
	name, _ := f.Str("name", valid.S{Trim: true, Min: 1, Max: 120})
	permissions, has := readPermissions(f)
	phone, _ := f.Str("phone", valid.S{Opt: true, Trim: true, Min: 7, Max: 24})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !has {
		permissions = defaultPermissions
	}
	hostelID, err := opsscope.HostelID(p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Limits.AssertRoom(c, hostelID, "wardens", 1); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelName, err := residents.HostelName(c, s.DB, hostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	issued, err := s.Issuer.RegisterOrUpgrade(c, users.IssueInput{Email: email, HostelID: hostelID.Hex(), HostelName: hostelName, Name: name, PerformedBy: p.UserID, Phone: phone, Role: "WARDEN"})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID, err := httpx.OID(issued.ID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	at := time.Now().UTC().Truncate(time.Millisecond)
	members := s.DB.Collection("hostelmembers")
	var m member
	err = members.FindOneAndUpdate(c, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "userId", Value: userID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: false}, {Key: "permissions", Value: permissions}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: at}}},
			{Key: "$unset", Value: bson.D{{Key: "deletedAt", Value: ""}, {Key: "deletedBy", Value: ""}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&m)
	reactivated := err == nil
	if errors.Is(err, mongo.ErrNoDocuments) {
		m = member{ID: bson.NewObjectID(), CreatedAt: &at, HostelID: hostelID, Permissions: permissions, Role: "WARDEN", Status: "ACTIVE", UpdatedAt: &at, UserID: userID}
		_, err = members.InsertOne(c, bson.D{{Key: "_id", Value: m.ID}, {Key: "createdBy", Value: actor}, {Key: "hostelId", Value: hostelID}, {Key: "permissions", Value: permissions}, {Key: "role", Value: "WARDEN"}, {Key: "status", Value: "ACTIVE"},
			{Key: "userId", Value: userID}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "WARDEN_CREATED", ActorID: actor, EntityID: m.ID.Hex(), EntityType: "HostelMember", HostelID: hostelID,
		Metadata: bson.D{{Key: "accountCreated", Value: issued.Created}, {Key: "accountUpgraded", Value: issued.Upgraded}, {Key: "email", Value: email}, {Key: "permissions", Value: permissions}, {Key: "userId", Value: userID.Hex()}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.notifyAdded(c, p.UserID, hostelID, reactivated, userID.Hex())
	u, err := s.hydrate(c, userID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var temp any
	if issued.TemporaryPassword != "" {
		temp = issued.TemporaryPassword
	}
	httpx.OK(c, ordered.Map{{Key: "accountCreated", Value: issued.Created}, {Key: "accountUpgraded", Value: issued.Upgraded}, {Key: "temporaryPassword", Value: temp}, {Key: "warden", Value: serialize(&m, u)}}, "Warden saved")
}

func (s *Service) update(c *gin.Context) {
	p, err := s.Guards.RequireHostelAdmin(c)
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
	permissions, hasPerms := readPermissions(f)
	status, hasStatus := f.Enum("status", true, nil, "ACTIVE", "SUSPENDED")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasPerms && !hasStatus {
		f.Is.Add("", "Provide permissions or status to update.")
		httpx.Fail(c, f.Err())
		return
	}
	m, err := s.find(c, p, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set := bson.D{{Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}
	meta := bson.D{}
	if hasPerms {
		set = append(set, bson.E{Key: "permissions", Value: permissions})
		meta = append(meta, bson.E{Key: "permissions", Value: permissions})
	}
	if hasStatus {
		set = append(set, bson.E{Key: "status", Value: status})
		meta = append(meta, bson.E{Key: "status", Value: status})
	}
	s.finish(c, p, m, set, "WARDEN_UPDATED", meta, hasPerms, status, "Warden updated")
}

func (s *Service) deactivate(c *gin.Context) {
	p, err := s.Guards.RequireHostelAdmin(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	m, err := s.find(c, p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set := bson.D{{Key: "status", Value: "SUSPENDED"}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}
	s.finish(c, p, m, set, "WARDEN_DEACTIVATED", bson.D{}, false, "SUSPENDED", "Warden deactivated")
}

func (s *Service) finish(c *gin.Context, p *authz.Principal, m *member, set bson.D, action string, meta bson.D, permsChanged bool, status, message string) {
	var updated member
	err := s.DB.Collection("hostelmembers").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: m.ID}, {Key: "isDeleted", Value: false}}, bson.D{{Key: "$set", Value: set}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notFound())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: action, ActorID: actor, EntityID: updated.ID.Hex(), EntityType: "HostelMember", HostelID: updated.HostelID, Metadata: meta}); err != nil {
		httpx.Fail(c, err)
		return
	}
	s.notifyUpdated(c, p.UserID, updated.HostelID, permsChanged, status, updated.UserID.Hex())
	u, err := s.hydrate(c, updated.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "warden", Value: serialize(&updated, u)}}, message)
}

func (s *Service) notifyAdded(ctx context.Context, actor string, hostel bson.ObjectID, reactivated bool, user string) {
	if user == actor {
		return
	}
	name, err := residents.HostelName(ctx, s.DB, hostel)
	if err != nil {
		return
	}
	body, title := "You have been added as a warden at "+name+".", "You are now a warden"
	if reactivated {
		body, title = "Your warden access at "+name+" has been restored.", "Warden access restored"
	}
	_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/dashboard", Body: body, Category: "ACCOUNT", HostelID: hostel.Hex(), Title: title, UserID: user})
}

func (s *Service) notifyUpdated(ctx context.Context, actor string, hostel bson.ObjectID, permsChanged bool, status, user string) {
	suspended, reinstated := status == "SUSPENDED", status == "ACTIVE"
	if user == actor || (!suspended && !reinstated && !permsChanged) {
		return
	}
	name, err := residents.HostelName(ctx, s.DB, hostel)
	if err != nil {
		return
	}
	body, title, priority := "What you can do at "+name+" has been changed by an admin.", "Your permissions changed", "NORMAL"
	if suspended {
		body, title, priority = "Your warden access at "+name+" has been suspended. Contact the hostel admin if this is unexpected.", "Warden access suspended", "HIGH"
	} else if reinstated {
		body, title = "Your warden access at "+name+" is active again.", "Warden access restored"
	}
	_, _ = s.Notify.CreateInApp(ctx, notifications.Input{ActionURL: "/hostel-admin/dashboard", Body: body, Category: "ACCOUNT", HostelID: hostel.Hex(), Priority: priority, Title: title, UserID: user})
}
