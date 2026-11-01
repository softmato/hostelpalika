// Package guardian is modules/guardian: a resident's invitations and permissions,
// and what a guardian may see, permission by permission.
package guardian

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/food"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const invitationDays = 7

type Service struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Notify *notifications.Service
	Mail   *email.Sender
	Audit  *audit.Log
	Issuer *users.Issuer
	AppURL func(path string) string
}

func (s *Service) Register(v1 *gin.RouterGroup) {
	v1.GET("/resident/guardians", httpx.ETag(), s.list)
	v1.POST("/resident/guardians", s.invite)
	v1.PATCH("/resident/guardians/:id", s.patch)
	v1.DELETE("/resident/guardians/:id", s.revoke)
	v1.POST("/guardian/accept-invitation", s.accept)
	v1.GET("/guardian/dashboard", httpx.ETag(), s.dashboardRoute)
	v1.GET("/guardian/food", httpx.ETag(), s.foodRoute)
	v1.GET("/guardian/notices", httpx.ETag(), s.noticesRoute)
	v1.GET("/guardian/payments", httpx.ETag(), s.paymentsRoute)
	v1.GET("/guardian/safety-summary", httpx.ETag(), s.safetyRoute)
}

// Permissions are GuardianPermission's flags, in the key order TS writes them.
type Permissions struct {
	CanViewComplaintStatus bool `json:"canViewComplaintStatus" bson:"canViewComplaintStatus"`
	CanViewFood            bool `json:"canViewFood" bson:"canViewFood"`
	CanViewNotices         bool `json:"canViewNotices" bson:"canViewNotices"`
	CanViewPayments        bool `json:"canViewPayments" bson:"canViewPayments"`
	CanViewReceipts        bool `json:"canViewReceipts" bson:"canViewReceipts"`
	CanViewSafety          bool `json:"canViewSafety" bson:"canViewSafety"`
}

type guardianRow struct {
	ID        bson.ObjectID `bson:"_id"`
	Email     string        `bson:"email"`
	FirstName string        `bson:"firstName"`
	HostelID  bson.ObjectID `bson:"hostelId"`
	LastName  string        `bson:"lastName"`
	Phone     string        `bson:"phone"`
	Relation  string        `bson:"relation"`
}

func (g *guardianRow) name() string { return strings.TrimSpace(g.FirstName + " " + g.LastName) }

type accessRow struct {
	ID                   bson.ObjectID  `bson:"_id"`
	AllowComplaintStatus bool           `bson:"allowComplaintStatus"`
	Email                string         `bson:"email"`
	ExpiresAt            time.Time      `bson:"expiresAt"`
	GuardianID           bson.ObjectID  `bson:"guardianId"`
	HostelID             bson.ObjectID  `bson:"hostelId"`
	InvitationExpiresAt  *time.Time     `bson:"invitationExpiresAt"`
	InvitationToken      string         `bson:"invitationToken"`
	Phone                string         `bson:"phone"`
	ResidentID           bson.ObjectID  `bson:"residentId"`
	Status               string         `bson:"status"`
	UserID               *bson.ObjectID `bson:"userId"`
}

func link(g *guardianRow, a *accessRow, p Permissions) ordered.Map {
	addr := a.Email
	if addr == "" {
		addr = g.Email
	}
	inv := any(ordered.Undefined)
	if a.InvitationExpiresAt != nil {
		inv = httpx.ISO(*a.InvitationExpiresAt)
	}
	return ordered.Map{{Key: "accessId", Value: a.ID.Hex()}, {Key: "email", Value: addr}, {Key: "expiresAt", Value: httpx.ISO(a.ExpiresAt)}, {Key: "guardianId", Value: g.ID.Hex()},
		{Key: "invitationExpiresAt", Value: inv}, {Key: "invitationPending", Value: a.Status == "ACTIVE" && a.InvitationToken != ""}, {Key: "name", Value: g.name()},
		{Key: "permissions", Value: p}, {Key: "phone", Value: g.Phone}, {Key: "relation", Value: g.Relation}, {Key: "status", Value: a.Status}}
}

func (s *Service) permissions(ctx context.Context, accessID bson.ObjectID) (Permissions, bool, error) {
	var p Permissions
	err := s.DB.Collection("guardianpermissions").FindOne(ctx, bson.D{{Key: "guardianAccessId", Value: accessID}}).Decode(&p)
	if err == mongo.ErrNoDocuments {
		return p, false, nil
	}
	return p, err == nil, err
}

type guardiansOut struct {
	Guardians []ordered.Map `json:"guardians"`
}

func (s *Service) list(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := s.DB.Collection("guardianaccesses").Find(c, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "USED"}}}}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var accesses []accessRow
	if err := cur.All(c, &accesses); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := guardiansOut{[]ordered.Map{}}
	if len(accesses) > 0 {
		ids := bson.A{}
		for _, a := range accesses {
			ids = append(ids, a.GuardianID)
		}
		cur, err := s.DB.Collection("guardians").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var rows []guardianRow
		if err := cur.All(c, &rows); err != nil {
			httpx.Fail(c, err)
			return
		}
		by := map[string]*guardianRow{}
		for i := range rows {
			by[rows[i].ID.Hex()] = &rows[i]
		}
		for i := range accesses {
			perm, _, err := s.permissions(c, accesses[i].ID)
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			if g := by[accesses[i].GuardianID.Hex()]; g != nil {
				out.Guardians = append(out.Guardians, link(g, &accesses[i], perm))
			}
		}
	}
	httpx.OK(c, out, "Guardians loaded")
}

var permissionLabels = []struct{ key, label string }{
	{"canViewComplaintStatus", "Complaint status (titles only, never the details)"},
	{"canViewFood", "This week's food menu"},
	{"canViewNotices", "Hostel notices"},
	{"canViewPayments", "Fee status (paid / unpaid / due)"},
	{"canViewReceipts", "Payment receipts"},
	{"canViewSafety", "Night safety summary (day-level only)"},
}

func (p Permissions) labels() []string {
	on := []bool{p.CanViewComplaintStatus, p.CanViewFood, p.CanViewNotices, p.CanViewPayments, p.CanViewReceipts, p.CanViewSafety}
	out := []string{}
	for i, x := range permissionLabels {
		if on[i] {
			out = append(out, x.label)
		}
	}
	return out
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var permissionKeys = []string{"canViewComplaintStatus", "canViewFood", "canViewNotices", "canViewPayments", "canViewReceipts", "canViewSafety"}

// readPermissions is guardianPermissionsSchema: every flag defaults off.
func readPermissions(f *valid.Form) Permissions {
	no := false
	var p Permissions
	p.CanViewComplaintStatus, _ = f.Bool("canViewComplaintStatus", false, &no)
	p.CanViewFood, _ = f.Bool("canViewFood", false, &no)
	p.CanViewNotices, _ = f.Bool("canViewNotices", false, &no)
	p.CanViewPayments, _ = f.Bool("canViewPayments", false, &no)
	p.CanViewReceipts, _ = f.Bool("canViewReceipts", false, &no)
	p.CanViewSafety, _ = f.Bool("canViewSafety", false, &no)
	return p
}

type inviteOut struct {
	Guardian ordered.Map `json:"guardian"`
}

func (s *Service) invite(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
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
	addr, _ := f.Email("email", false, "")
	first, _ := f.Str("firstName", valid.S{Trim: true, Min: 1, Max: 80})
	last, _ := f.Str("lastName", valid.S{Trim: true, Min: 1, Max: 80})
	var perm Permissions
	f.Nest("permissions", true, func(sub *valid.Form) { perm = readPermissions(sub) })
	phone, _ := f.Str("phone", valid.S{Trim: true, Min: 6, Max: 32})
	relation, _ := f.Str("relation", valid.S{Trim: true, Min: 2, Max: 40})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, s.DB, p)
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
	var g guardianRow
	err = s.DB.Collection("guardians").FindOne(c, bson.D{{Key: "email", Value: addr}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&g)
	if err == mongo.ErrNoDocuments {
		g = guardianRow{bson.NewObjectID(), addr, first, r.HostelID, last, phone, relation}
		_, err = s.DB.Collection("guardians").InsertOne(c, bson.D{{Key: "_id", Value: g.ID}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "firstName", Value: first},
			{Key: "lastName", Value: last}, {Key: "phone", Value: phone}, {Key: "email", Value: addr}, {Key: "relation", Value: relation}, {Key: "isPrimary", Value: false},
			{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	accesses := s.DB.Collection("guardianaccesses")
	if _, err := accesses.UpdateMany(c, bson.D{{Key: "guardianId", Value: g.ID}, {Key: "status", Value: "ACTIVE"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	token := randomHex(32)
	expires, invExpires := now.AddDate(0, 0, 365), now.AddDate(0, 0, invitationDays)
	a := accessRow{ID: bson.NewObjectID(), Email: addr, ExpiresAt: expires, GuardianID: g.ID, HostelID: r.HostelID, InvitationExpiresAt: &invExpires, InvitationToken: token, Phone: phone, ResidentID: r.ID, Status: "ACTIVE"}
	if _, err := accesses.InsertOne(c, bson.D{{Key: "_id", Value: a.ID}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "guardianId", Value: g.ID}, {Key: "phone", Value: phone},
		{Key: "accessCode", Value: strings.ToUpper(randomHex(4))[:6]}, {Key: "email", Value: addr}, {Key: "invitationToken", Value: token}, {Key: "invitationExpiresAt", Value: invExpires}, {Key: "invitedBy", Value: uid},
		{Key: "expiresAt", Value: expires}, {Key: "status", Value: "ACTIVE"}, {Key: "allowComplaintStatus", Value: perm.CanViewComplaintStatus}, {Key: "createdBy", Value: uid},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := s.DB.Collection("guardianpermissions").InsertOne(c, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "guardianAccessId", Value: a.ID},
		{Key: "canViewPayments", Value: perm.CanViewPayments}, {Key: "canViewReceipts", Value: perm.CanViewReceipts}, {Key: "canViewNotices", Value: perm.CanViewNotices}, {Key: "canViewFood", Value: perm.CanViewFood},
		{Key: "canViewSafety", Value: perm.CanViewSafety}, {Key: "canViewComplaintStatus", Value: perm.CanViewComplaintStatus}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "GUARDIAN_INVITED", ActorID: uid, EntityID: a.ID.Hex(), EntityType: "GuardianAccess", HostelID: r.HostelID,
		Metadata: bson.D{{Key: "guardianId", Value: g.ID.Hex()}, {Key: "permissions", Value: perm}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelName, err := residents.HostelName(c, s.DB, r.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	content := email.GuardianInvitation(s.AppURL("/guardian-invite?token="+token), invitationDays, hostelName, perm.labels(), r.FullName())
	s.Mail.Notify(c, email.Notification{Action: "guardian_invitation", HTML: content.HTML, Subject: content.Subject, To: addr, Category: content.Category})
	httpx.Write(c, 201, inviteOut{link(&g, &a, perm)}, "Guardian invited")
}

// owned is findResidentOwnedAccess.
func (s *Service) owned(c *gin.Context, p *authz.Principal) (*accessRow, *residents.Record, error) {
	r, err := residents.Current(c, s.DB, p)
	if err != nil {
		return nil, nil, err
	}
	id, err := httpx.OID(c.Param("id"), "guardian access id")
	if err != nil {
		return nil, nil, err
	}
	var a accessRow
	err = s.DB.Collection("guardianaccesses").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&a)
	if err == mongo.ErrNoDocuments {
		return nil, nil, httpx.NewError(404, "GUARDIAN_ACCESS_NOT_FOUND", "Guardian access was not found.", nil)
	}
	if err != nil {
		return nil, nil, err
	}
	return &a, r, nil
}

type permissionsOut struct {
	Permissions Permissions `json:"permissions"`
}

func (s *Service) patch(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
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
	// Only the keys sent change. A key left out keeps its value, and is off only on
	// the row this upsert creates.
	var flags, unsent bson.D
	for _, key := range permissionKeys {
		if _, present := f.M[key]; !present {
			unsent = append(unsent, bson.E{Key: key, Value: false})
			continue
		}
		if v, ok := f.Bool(key, true, nil); ok {
			flags = append(flags, bson.E{Key: key, Value: v})
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	a, r, err := s.owned(c, p)
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
	set := append(append(bson.D{}, flags...), bson.E{Key: "hostelId", Value: r.HostelID}, bson.E{Key: "residentId", Value: r.ID}, bson.E{Key: "updatedAt", Value: now})
	onInsert := append(bson.D{{Key: "guardianAccessId", Value: a.ID}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}, unsent...)
	if _, err := s.DB.Collection("guardianpermissions").UpdateOne(c, bson.D{{Key: "guardianAccessId", Value: a.ID}},
		bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: onInsert}}, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	for _, flag := range flags {
		if flag.Key != "canViewComplaintStatus" {
			continue
		}
		if _, err := s.DB.Collection("guardianaccesses").UpdateOne(c, bson.D{{Key: "_id", Value: a.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "allowComplaintStatus", Value: flag.Value}, {Key: "updatedAt", Value: now}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "GUARDIAN_PERMISSIONS_UPDATED", ActorID: uid, EntityID: a.ID.Hex(), EntityType: "GuardianAccess", HostelID: r.HostelID,
		Metadata: bson.D{{Key: "permissions", Value: flags}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if a.UserID != nil {
		if hostelName, err := residents.HostelName(c, s.DB, r.HostelID); err == nil {
			_, _ = s.Notify.CreateInApp(c, notifications.Input{ActionURL: "/guardian/dashboard", Body: r.FullName() + " changed what you can see at " + hostelName + ".", Category: "GUARDIAN",
				Data: ordered.Map{{Key: "audience", Value: "GUARDIAN"}}, HostelID: r.HostelID.Hex(), Title: "Your access changed", UserID: a.UserID.Hex()})
		}
	}
	perm, _, err := s.permissions(c, a.ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, permissionsOut{perm}, "Guardian permissions updated")
}

type revokedOut struct {
	AccessID string `json:"accessId"`
	Status   string `json:"status"`
}

func (s *Service) revoke(c *gin.Context) {
	p, err := s.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	a, r, err := s.owned(c, p)
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
	if _, err := s.DB.Collection("guardianaccesses").UpdateOne(c, bson.D{{Key: "_id", Value: a.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: now}}}, {Key: "$unset", Value: bson.D{{Key: "invitationToken", Value: ""}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.release(c, a.UserID, r.HostelID, now); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "GUARDIAN_ACCESS_REVOKED", ActorID: uid, EntityID: a.ID.Hex(), EntityType: "GuardianAccess", HostelID: r.HostelID}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if a.UserID != nil {
		_, _ = s.Notify.CreateInApp(c, notifications.Input{Body: r.FullName() + " has ended your guardian access. You will no longer see their hostel information.", Category: "GUARDIAN",
			Data: ordered.Map{{Key: "audience", Value: "GUARDIAN"}}, HostelID: r.HostelID.Hex(), Priority: "HIGH", Title: "Guardian access ended", UserID: a.UserID.Hex()})
	}
	httpx.OK(c, revokedOut{a.ID.Hex(), "REVOKED"}, "Guardian access revoked")
}

// release is releaseGuardianAccounts: losing the last link at a hostel takes
// that hostel off the account; the last link anywhere makes it PUBLIC again.
func (s *Service) release(ctx context.Context, userID *bson.ObjectID, hostelID bson.ObjectID, now time.Time) error {
	if userID == nil {
		return nil
	}
	live := bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "USED"}}}
	coll := s.DB.Collection("guardianaccesses")
	if n, err := coll.CountDocuments(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: live}, {Key: "userId", Value: *userID}}, options.Count().SetLimit(1)); err != nil || n > 0 {
		return err
	}
	anywhere, err := coll.CountDocuments(ctx, bson.D{{Key: "status", Value: live}, {Key: "userId", Value: *userID}}, options.Count().SetLimit(1))
	if err != nil {
		return err
	}
	set := bson.D{{Key: "updatedAt", Value: now}}
	if anywhere == 0 {
		set = append(bson.D{{Key: "role", Value: "PUBLIC"}}, set...)
	}
	_, err = s.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: *userID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "GUARDIAN"}},
		bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: hostelID}}}, {Key: "$set", Value: set}})
	return err
}

type acceptedOut struct {
	Accepted       bool   `json:"accepted"`
	AccountCreated bool   `json:"accountCreated"`
	Email          string `json:"email"`
	HostelName     string `json:"hostelName"`
	RequiresLogin  bool   `json:"requiresLogin"`
}

func (s *Service) accept(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	name, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Min: 1, Max: 120})
	token, _ := f.Str("token", valid.S{Trim: true, Min: 16, Max: 128})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	accesses := s.DB.Collection("guardianaccesses")
	var a accessRow
	err = accesses.FindOne(c, bson.D{{Key: "invitationToken", Value: token}, {Key: "status", Value: "ACTIVE"}}).Decode(&a)
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	if err == mongo.ErrNoDocuments || a.Email == "" {
		httpx.Fail(c, httpx.NewError(404, "GUARDIAN_INVITATION_INVALID", "This invitation is not valid.", nil))
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if a.InvitationExpiresAt != nil && a.InvitationExpiresAt.Before(now) {
		if _, err := accesses.UpdateOne(c, bson.D{{Key: "_id", Value: a.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "EXPIRED"}, {Key: "updatedAt", Value: now}}}, {Key: "$unset", Value: bson.D{{Key: "invitationToken", Value: ""}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.Fail(c, httpx.NewError(410, "GUARDIAN_INVITATION_EXPIRED", "This invitation has expired. Ask the resident to send a new one.", nil))
		return
	}
	var g guardianRow
	err = s.DB.Collection("guardians").FindOne(c, bson.D{{Key: "_id", Value: a.GuardianID}}).Decode(&g)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, httpx.NewError(404, "GUARDIAN_NOT_FOUND", "Guardian was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelName, err := residents.HostelName(c, s.DB, a.HostelID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasName {
		name = g.name()
	}
	res, err := s.Issuer.RegisterOrUpgrade(c, users.IssueInput{Email: a.Email, HostelID: a.HostelID.Hex(), HostelName: hostelName, Name: name, Phone: g.Phone, Role: "GUARDIAN"})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	userID, err := httpx.OID(res.ID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := accesses.UpdateOne(c, bson.D{{Key: "_id", Value: a.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "USED"}, {Key: "usedAt", Value: now}, {Key: "userId", Value: userID}, {Key: "updatedAt", Value: now}}},
		{Key: "$unset", Value: bson.D{{Key: "invitationToken", Value: ""}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := s.Audit.Write(c, audit.Entry{Action: "GUARDIAN_INVITATION_ACCEPTED", ActorID: userID, EntityID: a.ID.Hex(), EntityType: "GuardianAccess", HostelID: a.HostelID}); err != nil {
		httpx.Fail(c, err)
		return
	}
	var row struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if err := s.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: a.ResidentID}}).Decode(&row); err == nil && row.UserID != nil {
		_, _ = s.Notify.CreateInApp(c, notifications.Input{ActionURL: "/resident/guardians", Body: g.name() + " accepted your invitation and can now see what you allowed.", Category: "GUARDIAN",
			Data: ordered.Map{{Key: "audience", Value: "RESIDENT"}}, HostelID: a.HostelID.Hex(), Title: "Guardian linked", UserID: row.UserID.Hex()})
	}
	httpx.OK(c, acceptedOut{true, res.Created, res.Email, hostelName, res.Created || res.Upgraded}, "Guardian invitation accepted")
}

// --- what a guardian sees ------------------------------------------------------

type view struct {
	a *accessRow
	g *guardianRow
	p Permissions
	r *residents.Record
}

// load is loadGuardianAccess: the newest live link in the caller's scope whose
// resident and guardian rows still exist.
func (s *Service) load(c *gin.Context, p *authz.Principal) (*view, error) {
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	cur, err := s.DB.Collection("guardianaccesses").Find(c, bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "USED"}}}}, {Key: "userId", Value: uid}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		return nil, err
	}
	var rows []accessRow
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}
	inScope := rows[:0]
	for _, a := range rows {
		if slices.Contains(p.HostelIDs, a.HostelID.Hex()) {
			inScope = append(inScope, a)
		}
	}
	if len(inScope) == 0 {
		return nil, httpx.NewError(404, "GUARDIAN_ACCESS_NOT_FOUND", "Guardian access was not found for this account.", nil)
	}
	for i := range inScope {
		a := &inScope[i]
		var r residents.Record
		err := s.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: a.ResidentID}, {Key: "hostelId", Value: a.HostelID}, {Key: "isDeleted", Value: false}}).Decode(&r)
		if err == mongo.ErrNoDocuments {
			continue
		}
		if err != nil {
			return nil, err
		}
		var g guardianRow
		err = s.DB.Collection("guardians").FindOne(c, bson.D{{Key: "_id", Value: a.GuardianID}, {Key: "hostelId", Value: a.HostelID}, {Key: "residentId", Value: a.ResidentID}}).Decode(&g)
		if err == mongo.ErrNoDocuments {
			continue
		}
		if err != nil {
			return nil, err
		}
		perm, found, err := s.permissions(c, a.ID)
		if err != nil {
			return nil, err
		}
		if !found {
			perm.CanViewComplaintStatus = a.AllowComplaintStatus
		}
		return &view{a, &g, perm, &r}, nil
	}
	return nil, httpx.NewError(404, "GUARDIAN_LINK_NOT_FOUND", "Guardian resident link was not found.", nil)
}

type dashboard struct {
	Access      ordered.Map   `json:"access"`
	Complaints  []idStatus    `json:"complaints"`
	Food        []any         `json:"food"`
	Guardian    ordered.Map   `json:"guardian"`
	Hostel      any           `json:"hostel"`
	Notices     []noticeOut   `json:"notices"`
	Payments    []ordered.Map `json:"payments"`
	Permissions Permissions   `json:"permissions"`
	Receipts    []receiptOut  `json:"receipts"`
	Resident    ordered.Map   `json:"resident"`
	Safety      any           `json:"safety"`
	Summary     any           `json:"summary"`
}

type idStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Title  string `json:"title"`
}

type noticeOut struct {
	Category string `json:"category"`
	Content  string `json:"content"`
	ID       string `json:"id"`
	IsUrgent bool   `json:"isUrgent"`
	Title    string `json:"title"`
}

type receiptOut struct {
	Amount        int64  `json:"amount"`
	ID            string `json:"id"`
	IssuedOn      string `json:"issuedOn"`
	Month         string `json:"month"`
	ReceiptNumber string `json:"receiptNumber"`
}

type safetyOut struct {
	AsOf   *string `json:"asOf"`
	Status string  `json:"status"`
}

type summaryOut struct {
	DueAmount   int64 `json:"dueAmount"`
	UnpaidCount int   `json:"unpaidCount"`
}

func (s *Service) hostel(ctx context.Context, id bson.ObjectID) (any, error) {
	var raw bson.Raw
	err := s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}}).Decode(&raw)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	str := func(d bson.Raw, k string) string { v, _ := d.Lookup(k).StringValueOK(); return v }
	contact, _ := raw.Lookup("contact").DocumentOK()
	location := any(ordered.Map{})
	if v, err := raw.LookupErr("location"); err == nil && v.Type != bson.TypeNull {
		location = ordered.FromBSON(v)
	}
	photo := ""
	if arr, ok := raw.Lookup("photos").ArrayOK(); ok {
		vals, _ := arr.Values()
		first := ""
		for i, v := range vals {
			d, ok := v.DocumentOK()
			if !ok {
				continue
			}
			if i == 0 {
				first = str(d, "url")
			}
			if str(d, "kind") == "EXTERIOR" && str(d, "url") != "" {
				photo = str(d, "url")
				break
			}
		}
		if photo == "" {
			photo = first
		}
	}
	verified := str(raw, "verificationStatus") == "VERIFIED"
	slug := ""
	if str(raw, "status") == "PUBLISHED" && verified {
		slug = str(raw, "slug")
	}
	return ordered.Map{{Key: "contact", Value: ordered.Map{{Key: "email", Value: str(contact, "email")}, {Key: "phone", Value: str(contact, "phone")}}}, {Key: "id", Value: id.Hex()},
		{Key: "isVerified", Value: verified}, {Key: "location", Value: location}, {Key: "name", Value: str(raw, "name")}, {Key: "photoUrl", Value: photo}, {Key: "slug", Value: slug}}, nil
}

func serializePayment(p *finance.LedgerInvoice) ordered.Map {
	due := any(ordered.Undefined)
	if p.DueDate != nil {
		due = httpx.ISO(*p.DueDate)
	}
	var month any
	if p.Period != nil {
		month = *p.Period
	}
	return ordered.Map{{Key: "dueAmount", Value: p.DueAmount}, {Key: "dueDate", Value: due}, {Key: "id", Value: p.ID}, {Key: "month", Value: month}, {Key: "paidAmount", Value: p.PaidAmount}, {Key: "status", Value: p.Status}}
}

func unpaid(status string) bool {
	return status == "UNPAID" || status == "PARTIAL" || status == "OVERDUE" || status == "PENDING_PROOF"
}

// build is getGuardianDashboard: everything is read only when its flag is on.
func (s *Service) build(c *gin.Context, p *authz.Principal) (*dashboard, error) {
	v, err := s.load(c, p)
	if err != nil {
		return nil, err
	}
	a, perm := v.a, v.p
	d := &dashboard{Complaints: []idStatus{}, Food: []any{}, Notices: []noticeOut{}, Payments: []ordered.Map{}, Permissions: perm, Receipts: []receiptOut{}}
	if d.Hostel, err = s.hostel(c, a.HostelID); err != nil {
		return nil, err
	}
	var payments []finance.LedgerInvoice
	if perm.CanViewPayments {
		if payments, err = finance.ListResidentInvoices(c, s.DB, finance.LedgerScope{HostelID: a.HostelID, ResidentID: a.ResidentID, Limit: 6}); err != nil {
			return nil, err
		}
	}
	if perm.CanViewNotices {
		cur, err := s.DB.Collection("notices").Find(c, bson.D{{Key: "hostelId", Value: a.HostelID}, {Key: "targetAudience", Value: bson.D{{Key: "$in", Value: bson.A{"ALL", "GUARDIANS"}}}}},
			options.Find().SetSort(bson.D{{Key: "isUrgent", Value: -1}, {Key: "publishedAt", Value: -1}}).SetLimit(5))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			ID       bson.ObjectID `bson:"_id"`
			Category string        `bson:"category"`
			Content  string        `bson:"content"`
			IsUrgent bool          `bson:"isUrgent"`
			Title    string        `bson:"title"`
		}
		if err := cur.All(c, &rows); err != nil {
			return nil, err
		}
		for _, n := range rows {
			d.Notices = append(d.Notices, noticeOut{n.Category, n.Content, n.ID.Hex(), n.IsUrgent, n.Title})
		}
	}
	if perm.CanViewFood {
		if d.Food, err = food.MealsToday(c, s.DB, a.HostelID, time.Now()); err != nil {
			return nil, err
		}
	}
	if perm.CanViewComplaintStatus {
		cur, err := s.DB.Collection("complaints").Find(c, bson.D{{Key: "hostelId", Value: a.HostelID}, {Key: "residentId", Value: a.ResidentID}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(5))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			ID     bson.ObjectID `bson:"_id"`
			Status string        `bson:"status"`
			Title  string        `bson:"title"`
		}
		if err := cur.All(c, &rows); err != nil {
			return nil, err
		}
		for _, x := range rows {
			d.Complaints = append(d.Complaints, idStatus{x.ID.Hex(), x.Status, x.Title})
		}
	}
	if perm.CanViewReceipts {
		cur, err := s.DB.Collection("receipts").Find(c, bson.D{{Key: "hostelId", Value: a.HostelID}, {Key: "residentId", Value: a.ResidentID}}, options.Find().SetSort(bson.D{{Key: "issuedAt", Value: -1}}).SetLimit(12))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			ID            bson.ObjectID `bson:"_id"`
			Amount        int64         `bson:"amount"`
			IssuedAt      time.Time     `bson:"issuedAt"`
			Month         string        `bson:"month"`
			ReceiptNumber string        `bson:"receiptNumber"`
		}
		if err := cur.All(c, &rows); err != nil {
			return nil, err
		}
		for _, x := range rows {
			d.Receipts = append(d.Receipts, receiptOut{x.Amount, x.ID.Hex(), x.IssuedAt.UTC().Format("2006-01-02"), x.Month, x.ReceiptNumber})
		}
	}
	if perm.CanViewSafety {
		var night struct {
			CheckedAt time.Time `bson:"checkedAt"`
			Status    string    `bson:"status"`
		}
		err := s.DB.Collection("nightstatuses").FindOne(c, bson.D{{Key: "residentId", Value: v.r.ID}}).Decode(&night)
		if err != nil && err != mongo.ErrNoDocuments {
			return nil, err
		}
		out := safetyOut{Status: "NOT_VERIFIED"}
		if err == nil {
			day := night.CheckedAt.UTC().Format("2006-01-02")
			out = safetyOut{&day, night.Status}
		}
		d.Safety = out
	}
	var due int64
	count := 0
	for i := range payments {
		d.Payments = append(d.Payments, serializePayment(&payments[i]))
		if unpaid(payments[i].Status) {
			count++
			if x := payments[i].DueAmount - payments[i].PaidAmount; x > 0 {
				due += x
			}
		}
	}
	if perm.CanViewPayments {
		d.Summary = summaryOut{due, count}
	}
	var image any
	if v.r.UserID != nil {
		var u struct {
			Image *string `bson:"image"`
		}
		err := s.DB.Collection("users").FindOne(c, bson.D{{Key: "_id", Value: *v.r.UserID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&u)
		if err != nil && err != mongo.ErrNoDocuments {
			return nil, err
		}
		if u.Image != nil {
			image = *u.Image
		}
	}
	d.Resident = ordered.Map{{Key: "fullName", Value: v.r.FullName()}, {Key: "id", Value: v.r.ID.Hex()}, {Key: "image", Value: image}, {Key: "roomType", Value: v.r.RoomType}, {Key: "status", Value: v.r.Status}}
	d.Guardian = ordered.Map{{Key: "id", Value: v.g.ID.Hex()}, {Key: "name", Value: v.g.name()}, {Key: "phone", Value: v.g.Phone}, {Key: "relation", Value: v.g.Relation}}
	user := any(ordered.Undefined)
	if a.UserID != nil {
		user = a.UserID.Hex()
	}
	d.Access = ordered.Map{{Key: "expiresAt", Value: httpx.ISO(a.ExpiresAt)}, {Key: "guardianId", Value: a.GuardianID.Hex()}, {Key: "hostelId", Value: a.HostelID.Hex()}, {Key: "id", Value: a.ID.Hex()},
		{Key: "phone", Value: a.Phone}, {Key: "residentId", Value: a.ResidentID.Hex()}, {Key: "status", Value: a.Status}, {Key: "userId", Value: user}}
	return d, nil
}

func (s *Service) route(c *gin.Context, message string, pick func(*dashboard) any) {
	p, err := s.Guards.RequireGuardian(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	d, err := s.build(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, pick(d), message)
}

func (s *Service) dashboardRoute(c *gin.Context) {
	s.route(c, "Guardian dashboard loaded", func(d *dashboard) any {
		return struct {
			Dashboard *dashboard `json:"dashboard"`
		}{d}
	})
}

func (s *Service) paymentsRoute(c *gin.Context) {
	s.route(c, "Guardian payments loaded", func(d *dashboard) any {
		return struct {
			Payments []ordered.Map `json:"payments"`
			Receipts []receiptOut  `json:"receipts"`
			Summary  any           `json:"summary"`
		}{d.Payments, d.Receipts, d.Summary}
	})
}

func (s *Service) noticesRoute(c *gin.Context) {
	s.route(c, "Guardian notices loaded", func(d *dashboard) any {
		return struct {
			Notices []noticeOut `json:"notices"`
		}{d.Notices}
	})
}

func (s *Service) foodRoute(c *gin.Context) {
	s.route(c, "Guardian food loaded", func(d *dashboard) any {
		return struct {
			Food []any `json:"food"`
		}{d.Food}
	})
}

func (s *Service) safetyRoute(c *gin.Context) {
	s.route(c, "Guardian safety summary loaded", func(d *dashboard) any {
		return struct {
			Complaints []idStatus `json:"complaints"`
			Safety     any        `json:"safety"`
		}{d.Complaints, d.Safety}
	})
}
