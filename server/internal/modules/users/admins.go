package users

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Admins is the platform-admin roster and its invitations (platform-admin.service.ts,
// platform-admin-invite.service.ts). Every roster route is a full superadmin's; the
// two invitation routes are public, the token being the authorisation.
type Admins struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Audit  *audit.Log
	Mail   *email.Sender
	AppURL func(path string) string
	Now    func() time.Time
}

const inviteExpiryDays = 7

var (
	adminRoles     = []string{"SUPERADMIN", "PLATFORM_MODERATOR"}
	invitableRoles = []string{"SUPERADMIN", "PLATFORM_MODERATOR", "PLATFORM_AGENT"}
	inviteLabels   = map[string]string{"PLATFORM_AGENT": "Team Member", "PLATFORM_MODERATOR": "Platform Moderator", "SUPERADMIN": "Superadmin"}
	roleWords      = map[string]string{"COOK": "a cook account", "GUARDIAN": "a guardian account", "HOSTEL_ADMIN": "a hostel admin account", "PLATFORM_MODERATOR": "a platform moderator",
		"PLATFORM_AGENT": "a team member account", "RESIDENT": "a resident account", "SUPERADMIN": "a superadmin", "WARDEN": "a warden account"}
)

func (a *Admins) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/platform/admins", authz.Use(a.Guards.RequireSuperadmin))
	g.GET("", httpx.ETag(), a.list)
	g.POST("", a.create)
	g.PATCH("/:id", a.changeRole)
	g.DELETE("/:id", a.revoke)
	g.GET("/email-check", httpx.ETag(), a.emailCheck)
	g.GET("/invites", httpx.ETag(), a.listInvites)
	g.POST("/invites", a.invite)
	g.DELETE("/invites/:id", a.revokeInvite)
	v1.GET("/platform-admin/invitation", httpx.ETag(), a.readInvitation)
	v1.POST("/platform-admin/accept-invitation", a.accept)
}

func adminErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

func (a *Admins) now() time.Time { return a.Now().UTC().Truncate(time.Millisecond) }

func (a *Admins) users() *mongo.Collection   { return a.DB.Collection("users") }
func (a *Admins) invites() *mongo.Collection { return a.DB.Collection("platformadmininvites") }

func actor(c *gin.Context) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex(authz.From(c).UserID)
	return id
}

func label(role string) string {
	if role == "SUPERADMIN" {
		return "Superadmin"
	}
	return "Acting Superadmin"
}

func inviteLabel(role string) string {
	if l, ok := inviteLabels[role]; ok {
		return l
	}
	return role
}

type adminUser struct {
	ID          bson.ObjectID `bson:"_id"`
	CreatedAt   *time.Time    `bson:"createdAt"`
	Email       *string       `bson:"email"`
	IsDeleted   bool          `bson:"isDeleted"`
	LastLoginAt *time.Time    `bson:"lastLoginAt"`
	MustChange  bool          `bson:"mustChangePassword"`
	Name        *string       `bson:"name"`
	Phone       *string       `bson:"phone"`
	Role        *string       `bson:"role"`
	Status      *string       `bson:"status"`
}

func or(s *string, def string) string {
	if s == nil {
		return def
	}
	return *s
}

func isoOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func (u *adminUser) out() ordered.Map {
	return ordered.Map{{Key: "createdAt", Value: isoOrNil(u.CreatedAt)}, {Key: "email", Value: or(u.Email, "")}, {Key: "id", Value: u.ID.Hex()}, {Key: "lastLoginAt", Value: isoOrNil(u.LastLoginAt)},
		{Key: "mustChangePassword", Value: u.MustChange}, {Key: "name", Value: or(u.Name, "Unnamed admin")}, {Key: "phone", Value: or(u.Phone, "")},
		{Key: "role", Value: or(u.Role, "PLATFORM_MODERATOR")}, {Key: "status", Value: or(u.Status, "ACTIVE")}}
}

var liveUser = bson.E{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}

func (a *Admins) list(c *gin.Context) {
	cur, err := a.users().Find(c, bson.D{liveUser, {Key: "role", Value: bson.D{{Key: "$in", Value: adminRoles}}}}, options.Find().SetSort(bson.D{{Key: "role", Value: 1}, {Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []adminUser
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		out[i] = rows[i].out()
	}
	httpx.OK(c, ordered.Map{{Key: "admins", Value: out}}, "Platform admins loaded")
}

func randomPassword() string {
	b := make([]byte, 9)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// create is createPlatformAdmin: only a PUBLIC account may be raised; raising a
// hostel or resident account in place would strip its tenant scope.
func (a *Admins) create(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	addr, _ := f.Email("email", false, "")
	name, hasName := f.Str("name", valid.S{Opt: true, Trim: true, Max: 120})
	phone, hasPhone := f.Str("phone", valid.S{Opt: true, Trim: true, Max: 40})
	role, _ := f.Enum("role", false, nil, adminRoles...)
	sendMail, hasSend := f.Bool("sendEmailNotification", true, nil)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	var existing adminUser
	found := true
	if err := a.users().FindOne(c, bson.D{{Key: "email", Value: addr}, liveUser}).Decode(&existing); errors.Is(err, mongo.ErrNoDocuments) {
		found = false
	} else if err != nil {
		httpx.Fail(c, err)
		return
	}
	if found && or(existing.Role, "") != "PUBLIC" {
		if r := or(existing.Role, ""); r == "SUPERADMIN" || r == "PLATFORM_MODERATOR" {
			httpx.Fail(c, adminErr(409, "ALREADY_PLATFORM_ADMIN", "This email is already a platform admin."))
			return
		}
		httpx.Fail(c, adminErr(409, "EMAIL_ALREADY_HAS_ROLE", "This email already belongs to a hostel or resident account. Use a separate address for platform access."))
		return
	}
	password := randomPassword()
	hash, err := auth.HashPassword(password)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := a.now()
	userID := existing.ID
	if found {
		set := bson.D{{Key: "mustChangePassword", Value: true}, {Key: "passwordHash", Value: hash}, {Key: "role", Value: role}, {Key: "status", Value: "INVITED"}}
		if hasName && name != "" {
			set = append(set, bson.E{Key: "name", Value: name})
		}
		if hasPhone && phone != "" {
			set = append(set, bson.E{Key: "phone", Value: phone})
		}
		if _, err := a.users().UpdateOne(c, bson.D{{Key: "_id", Value: existing.ID}}, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: now})}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	} else {
		userID = bson.NewObjectID()
		display := addr
		if name != "" {
			display = name
		}
		doc := bson.D{{Key: "_id", Value: userID}, {Key: "name", Value: display}, {Key: "email", Value: addr}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: true}, {Key: "emailVerifiedAt", Value: now}}
		if phone != "" {
			doc = append(doc, bson.E{Key: "phone", Value: phone})
		}
		doc = append(doc, bson.E{Key: "passwordHash", Value: hash}, bson.E{Key: "authProvider", Value: "LOCAL"}, bson.E{Key: "role", Value: role}, bson.E{Key: "mustChangePassword", Value: true},
			bson.E{Key: "lockPinSetAt", Value: nil}, bson.E{Key: "lockPinFailures", Value: 0}, bson.E{Key: "tokenVersion", Value: 0}, bson.E{Key: "hostelIds", Value: bson.A{}},
			bson.E{Key: "status", Value: "INVITED"}, bson.E{Key: "isDemoData", Value: false}, bson.E{Key: "isDeleted", Value: false},
			bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		if _, err := a.users().InsertOne(c, doc); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_ADMIN_CREATED", ActorID: actor(c), EntityID: userID.Hex(), EntityType: "User",
		Metadata: bson.D{{Key: "email", Value: addr}, {Key: "role", Value: role}, {Key: "upgradedExisting", Value: found}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !hasSend || sendMail {
		m := email.CredentialsIssued(label(role), addr, password, a.AppURL("/login"))
		a.Mail.Send(c, email.Message{Category: m.Category, To: []string{addr}, Subject: m.Subject, HTML: m.HTML})
	}
	// Returned so the superadmin can hand it over when mail is not set up; it must be changed on first login.
	httpx.Write(c, http.StatusCreated, ordered.Map{{Key: "admin", Value: ordered.Map{{Key: "email", Value: addr}, {Key: "id", Value: userID.Hex()}, {Key: "role", Value: role}}},
		{Key: "temporaryPassword", Value: password}}, "Platform admin created")
}

func (a *Admins) findAdmin(ctx context.Context, raw string) (*adminUser, bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		return nil, id, adminErr(422, "INVALID_OBJECT_ID", "Invalid admin id.")
	}
	var u adminUser
	err = a.users().FindOne(ctx, bson.D{{Key: "_id", Value: id}, liveUser, {Key: "role", Value: bson.D{{Key: "$in", Value: adminRoles}}}}).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, id, adminErr(404, "NOT_FOUND", "Platform admin not found.")
	}
	return &u, id, err
}

var lastSuperadmin = adminErr(409, "LAST_SUPERADMIN", "At least one full superadmin must remain.")

// demote moves a platform admin off SUPERADMIN (or off the platform) inside one
// transaction with the count of the superadmins left: TS counted, then wrote, so
// two superadmins demoting each other at once both passed and locked the platform out (P7-28).
func (a *Admins) demote(ctx context.Context, id bson.ObjectID, from string, set bson.D) error {
	return appmongo.InTx(ctx, a.DB, func(ctx context.Context) error {
		if from == "SUPERADMIN" {
			n, err := a.users().CountDocuments(ctx, bson.D{liveUser, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "ARCHIVED"}}}, {Key: "_id", Value: bson.D{{Key: "$ne", Value: id}}}})
			if err != nil {
				return err
			}
			if n == 0 {
				return lastSuperadmin
			}
		}
		// Conditional on the role read, so the transaction conflicts with a racing change.
		res, err := a.users().UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "role", Value: from}}, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: a.now()})}})
		if err != nil {
			return err
		}
		if res.MatchedCount == 0 {
			return adminErr(409, "ADMIN_CHANGED", "This admin was changed by someone else just now. Reload and try again.")
		}
		return nil
	})
}

func (a *Admins) changeRole(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	role, _ := f.Enum("role", false, nil, adminRoles...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	u, id, err := a.findAdmin(c, c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	from := or(u.Role, "")
	if from != role {
		if err := a.demote(c, id, from, bson.D{{Key: "role", Value: role}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		// Their tokens carry the old role: end the sessions so it stops now (P11-6).
		if _, err := a.DB.Collection("sessions").DeleteMany(c, bson.D{{Key: "userId", Value: id}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_ADMIN_ROLE_CHANGED", ActorID: actor(c), EntityID: id.Hex(), EntityType: "User", Metadata: bson.D{{Key: "from", Value: from}, {Key: "to", Value: role}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	u.Role = &role
	httpx.OK(c, ordered.Map{{Key: "admin", Value: u.out()}}, "Platform admin updated")
}

// revoke is revokePlatformAdmin: a soft revoke to PUBLIC + SUSPENDED, so the audit
// trail keeps pointing at a real account. Its sessions end with it: TS left the
// revoked admin signed in until the access token ran out (P7-29).
func (a *Admins) revoke(c *gin.Context) {
	raw := c.Param("id")
	if _, err := bson.ObjectIDFromHex(raw); err != nil {
		httpx.Fail(c, adminErr(422, "INVALID_OBJECT_ID", "Invalid admin id."))
		return
	}
	if raw == authz.From(c).UserID {
		httpx.Fail(c, adminErr(409, "CANNOT_REVOKE_SELF", "You cannot revoke your own platform access."))
		return
	}
	u, id, err := a.findAdmin(c, raw)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	from := or(u.Role, "")
	err = a.demote(c, id, from, bson.D{{Key: "role", Value: "PUBLIC"}, {Key: "status", Value: "SUSPENDED"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := a.users().UpdateOne(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := a.DB.Collection("sessions").DeleteMany(c, bson.D{{Key: "userId", Value: id}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_ADMIN_REVOKED", ActorID: actor(c), EntityID: id.Hex(), EntityType: "User", Metadata: bson.D{{Key: "previousRole", Value: from}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "revoked", Value: true}}, "Platform access revoked")
}

// --- invitations ----------------------------------------------------------------------

type inviteRow struct {
	ID        bson.ObjectID  `bson:"_id"`
	CreatedAt *time.Time     `bson:"createdAt"`
	Email     string         `bson:"email"`
	ExpiresAt time.Time      `bson:"expiresAt"`
	InvitedBy *bson.ObjectID `bson:"invitedBy"`
	Name      *string        `bson:"name"`
	Phone     *string        `bson:"phone"`
	Role      string         `bson:"role"`
	Status    string         `bson:"status"`
}

func (i *inviteRow) out(now time.Time) ordered.Map {
	return ordered.Map{{Key: "createdAt", Value: isoOrNil(i.CreatedAt)}, {Key: "email", Value: i.Email}, {Key: "expired", Value: i.Status == "PENDING" && i.ExpiresAt.Before(now)},
		{Key: "expiresAt", Value: httpx.ISO(i.ExpiresAt)}, {Key: "id", Value: i.ID.Hex()}, {Key: "name", Value: or(i.Name, "")}, {Key: "phone", Value: or(i.Phone, "")},
		{Key: "role", Value: i.Role}, {Key: "status", Value: i.Status}}
}

type availability struct {
	Availability string `json:"availability"`
	Message      string `json:"message"`
	Reason       string `json:"reason"`
	Sendable     bool   `json:"sendable"`
}

func roleWord(role, def string) string {
	if w, ok := roleWords[role]; ok {
		return w
	}
	return def
}

// check is checkPlatformAdminEmail: what the address is already used for, phrased
// so a superadmin can act on it. An account on another role may be taken over
// (its role is parked in previousRole); a platform grade, the same role or a
// closed account refuses.
func (a *Admins) check(ctx context.Context, addr, role string) (availability, error) {
	var user struct {
		IsDeleted bool    `bson:"isDeleted"`
		Name      *string `bson:"name"`
		Role      string  `bson:"role"`
		Status    string  `bson:"status"`
	}
	hasUser := true
	if err := a.users().FindOne(ctx, bson.D{{Key: "email", Value: addr}}).Decode(&user); errors.Is(err, mongo.ErrNoDocuments) {
		hasUser = false
	} else if err != nil {
		return availability{}, err
	}
	switch {
	case hasUser && user.IsDeleted:
		return availability{"TAKEN", addr + " belongs to a closed account. The address stays reserved until that account is purged, so it cannot be invited yet.", "CLOSED_ACCOUNT", false}, nil
	case hasUser && role != "" && user.Role == role:
		return availability{"TAKEN", addr + " is already " + roleWord(user.Role, "on the team") + ". There is nothing left for an invitation to grant.", "ALREADY_HAS_THIS_ROLE", false}, nil
	case hasUser && slices.Contains(invitableRoles, user.Role):
		reason := "ALREADY_HAS_THIS_ROLE"
		if role != "" {
			reason = "OTHER_PLATFORM_ROLE"
		}
		return availability{"TAKEN", addr + " is already " + roleWord(user.Role, "a platform admin") + ". Change their access level on the admin roster instead.", reason, false}, nil
	}
	dormant := user.Status == "SUSPENDED" || user.Status == "ARCHIVED"
	if hasUser && user.Role != "PUBLIC" {
		extra := ""
		if dormant {
			extra = " and reactivates it"
		}
		return availability{"UPGRADEABLE", addr + " currently belongs to " + roleWord(user.Role, "another account") + ". Accepting moves that same account onto the field team" + extra +
			" — their present access ends, and comes back if you remove them from the team later.", "OTHER_ROLE", true}, nil
	}
	var pending struct {
		ExpiresAt time.Time `bson:"expiresAt"`
		Role      string    `bson:"role"`
	}
	if err := a.invites().FindOne(ctx, bson.D{{Key: "email", Value: addr}, {Key: "status", Value: "PENDING"}}).Decode(&pending); err == nil {
		msg := addr + " already has a " + inviteLabel(pending.Role) + " invitation waiting. Sending again withdraws that one and replaces it."
		if pending.ExpiresAt.Before(time.Now()) {
			msg = addr + " has an invitation that has run out. Sending again replaces it with a fresh link."
		}
		return availability{"UPGRADEABLE", msg, "INVITE_PENDING", true}, nil
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		return availability{}, err
	}
	exists := func(coll string, filter bson.D) (bool, error) {
		n, err := a.DB.Collection(coll).CountDocuments(ctx, filter, options.Count().SetLimit(1))
		return n > 0, err
	}
	if ok, err := exists("cookaccounts", bson.D{{Key: "loginEmail", Value: addr}, {Key: "status", Value: "INVITED"}}); err != nil {
		return availability{}, err
	} else if ok {
		return availability{"UPGRADEABLE", addr + " also has an unaccepted cook invitation from a hostel. Whichever link is opened second will be refused, so tell them which one to use.", "COOK_INVITE_PENDING", true}, nil
	}
	if ok, err := exists("guardianaccesses", bson.D{{Key: "email", Value: addr}, {Key: "invitationToken", Value: bson.D{{Key: "$exists", Value: true}}}, {Key: "status", Value: "ACTIVE"},
		{Key: "userId", Value: bson.D{{Key: "$exists", Value: false}}}}); err != nil {
		return availability{}, err
	} else if ok {
		return availability{"UPGRADEABLE", addr + " also has an unaccepted guardian invitation from a resident. Whichever link is opened second will be refused, so tell them which one to use.", "GUARDIAN_INVITE_PENDING", true}, nil
	}
	if dormant {
		return availability{"UPGRADEABLE", addr + " has a suspended account. Accepting the invitation reactivates it and puts them on the field team.", "SUSPENDED_ACCOUNT", true}, nil
	}
	if hasUser {
		return availability{"UPGRADEABLE", addr + " has a public account (" + or(user.Name, "unnamed") + "). Accepting raises that same account — they keep their password and sign in as they do now.", "PUBLIC_ACCOUNT", true}, nil
	}
	return availability{"AVAILABLE", addr + " is not used anywhere on the platform. They accept the emailed link, then sign in with Google.", "FREE", true}, nil
}

func (a *Admins) emailCheck(c *gin.Context) {
	q := valid.Query(c)
	in := map[string]any{"email": q["email"]}
	if r := q["role"]; r != "" {
		in["role"] = r
	}
	f := valid.NewForm(in)
	addr, _ := f.Email("email", false, "Enter a complete email address.")
	role, _ := f.Enum("role", true, nil, invitableRoles...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := a.check(c, addr, role)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Email checked")
}

func (a *Admins) listInvites(c *gin.Context) {
	cur, err := a.invites().Find(c, bson.D{{Key: "status", Value: "PENDING"}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []inviteRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	out := make([]ordered.Map, len(rows))
	for i := range rows {
		out[i] = rows[i].out(now)
	}
	httpx.OK(c, ordered.Map{{Key: "invites", Value: out}}, "Invitations loaded")
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

type inviteInput struct{ email, name, phone, role string }

// sendInvite is invitePlatformAdmin: the availability check runs again here, and a
// waiting invitation for the address is superseded rather than left to collide.
func (a *Admins) sendInvite(c *gin.Context, in inviteInput) (ordered.Map, error) {
	addr := strings.ToLower(strings.TrimSpace(in.email))
	if addr == "" {
		return nil, adminErr(422, "EMAIL_REQUIRED", "Email is required.")
	}
	av, err := a.check(c, addr, in.role)
	if err != nil {
		return nil, err
	}
	if !av.Sendable {
		return nil, adminErr(409, av.Reason, av.Message)
	}
	by := actor(c)
	now := a.now()
	if _, err := a.invites().UpdateMany(c, bson.D{{Key: "email", Value: addr}, {Key: "status", Value: "PENDING"}}, bson.D{
		{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: now}, {Key: "revokedBy", Value: by}, {Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: now}}},
		{Key: "$unset", Value: bson.D{{Key: "tokenHash", Value: ""}}}}); err != nil {
		return nil, err
	}
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token := hex.EncodeToString(raw)
	row := inviteRow{ID: bson.NewObjectID(), CreatedAt: &now, Email: addr, ExpiresAt: now.AddDate(0, 0, inviteExpiryDays), InvitedBy: &by, Role: in.role, Status: "PENDING"}
	doc := bson.D{{Key: "_id", Value: row.ID}, {Key: "email", Value: addr}}
	if n := strings.TrimSpace(in.name); n != "" {
		row.Name = &n
		doc = append(doc, bson.E{Key: "name", Value: n})
	}
	if p := strings.TrimSpace(in.phone); p != "" {
		row.Phone = &p
		doc = append(doc, bson.E{Key: "phone", Value: p})
	}
	doc = append(doc, bson.E{Key: "role", Value: in.role}, bson.E{Key: "tokenHash", Value: hashToken(token)}, bson.E{Key: "expiresAt", Value: row.ExpiresAt}, bson.E{Key: "status", Value: "PENDING"},
		bson.E{Key: "invitedBy", Value: by}, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := a.invites().InsertOne(c, doc); err != nil {
		return nil, err
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_ADMIN_INVITED", ActorID: by, EntityID: row.ID.Hex(), EntityType: "PlatformAdminInvite",
		Metadata: bson.D{{Key: "email", Value: addr}, {Key: "role", Value: in.role}}}); err != nil {
		return nil, err
	}
	var inviter struct {
		Name *string `bson:"name"`
	}
	_ = a.users().FindOne(c, bson.D{{Key: "_id", Value: by}}).Decode(&inviter)
	m := email.PlatformAdminInvitation(a.AppURL("/platform-admin-invite?token="+token), inviteExpiryDays, or(inviter.Name, "A platform superadmin"), inviteLabel(in.role))
	r := a.Mail.Send(c, email.Message{Category: m.Category, To: []string{addr}, Subject: m.Subject, HTML: m.HTML})
	var reason any
	if !r.Sent {
		slog.WarnContext(c, "platform_admin_invitation_email_failed", "email", addr, "reason", r.Reason)
		reason = r.Reason
		if r.Reason == "" {
			reason = "unknown"
		}
	}
	// Reported honestly: with no password to hand over, an unsent mail is an invitation nobody can accept.
	return ordered.Map{{Key: "delivered", Value: r.Sent}, {Key: "deliveryReason", Value: reason}, {Key: "invite", Value: row.out(time.Now())}}, nil
}

func inviteFields(f *valid.Form) inviteInput {
	addr, _ := f.Str("email", valid.S{Trim: true})
	if addr != "" && !valid.IsEmail(strings.ToLower(addr)) {
		f.Is.Add("email", valid.Format("email"))
	}
	name, _ := f.Str("name", valid.S{Opt: true, Trim: true, Max: 120})
	phone, _ := f.Str("phone", valid.S{Opt: true, Trim: true, Max: 40})
	return inviteInput{email: addr, name: name, phone: phone}
}

// invite sends one invitation, or with `invitations` a batch reported per address
// (200, not 201: some may have failed). A batch is not atomic on purpose.
func (a *Admins) invite(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	if _, batch := f.M["invitations"]; !batch {
		in := inviteFields(f)
		in.role, _ = f.Enum("role", false, nil, invitableRoles...)
		if err := f.Err(); err != nil {
			httpx.Fail(c, err)
			return
		}
		out, err := a.sendInvite(c, in)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.Write(c, http.StatusCreated, out, "Invitation sent")
		return
	}
	list, _ := f.Array("invitations", false, false)
	rows := make([]inviteInput, 0, len(list))
	for i, raw := range list {
		sub := valid.NewForm(raw)
		if sub.M == nil {
			f.Is.Add("invitations."+itoa(i), valid.Type("object", valid.Received(raw, false)))
			continue
		}
		rows = append(rows, inviteFields(sub))
		f.Join("invitations."+itoa(i), sub)
	}
	f.Size("invitations", len(list), 1, 20, "Add at least one address.", false)
	if len(list) > 20 {
		f.Is = replaceLast(f.Is, "invitations", "Send at most twenty invitations at a time.")
	}
	role, _ := f.Enum("role", false, nil, invitableRoles...)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	results := []ordered.Map{}
	seen := map[string]bool{}
	sent := 0
	for _, in := range rows {
		key := strings.ToLower(strings.TrimSpace(in.email))
		if seen[key] {
			continue // a repeated row would supersede its own first link
		}
		seen[key] = true
		in.role = role
		out, err := a.sendInvite(c, in)
		if err != nil {
			msg := "Could not send this invitation."
			var he *httpx.Error
			if errors.As(err, &he) {
				msg = he.Message
			}
			results = append(results, ordered.Map{{Key: "delivered", Value: false}, {Key: "email", Value: in.email}, {Key: "error", Value: msg}, {Key: "sent", Value: false}})
			continue
		}
		delivered, _ := out.Get("delivered")
		results = append(results, ordered.Map{{Key: "delivered", Value: delivered}, {Key: "email", Value: in.email}, {Key: "error", Value: nil}, {Key: "sent", Value: true}})
		sent++
	}
	httpx.OK(c, ordered.Map{{Key: "results", Value: results}, {Key: "sent", Value: sent}, {Key: "total", Value: len(results)}}, itoa(sent)+" of "+itoa(len(results))+" invitations sent")
}

func replaceLast(is valid.Issues, path, msg string) valid.Issues {
	for i := len(is) - 1; i >= 0; i-- {
		if is[i].Path == path {
			is[i].Message = msg
			break
		}
	}
	return is
}

func (a *Admins) revokeInvite(c *gin.Context) {
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, adminErr(422, "INVALID_OBJECT_ID", "Invalid invitation id."))
		return
	}
	now := a.now()
	var row inviteRow
	err = a.invites().FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "PENDING"}}, bson.D{
		{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: now}, {Key: "revokedBy", Value: actor(c)}, {Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: now}}},
		{Key: "$unset", Value: bson.D{{Key: "tokenHash", Value: ""}}}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, adminErr(404, "INVITE_NOT_FOUND", "That invitation is no longer outstanding."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "PLATFORM_ADMIN_INVITE_REVOKED", ActorID: actor(c), EntityID: row.ID.Hex(), EntityType: "PlatformAdminInvite",
		Metadata: bson.D{{Key: "email", Value: row.Email}, {Key: "role", Value: row.Role}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "revoked", Value: true}}, "Invitation withdrawn")
}

// liveInvite is findLiveInvite: a used, withdrawn or unknown token reads the same.
func (a *Admins) liveInvite(ctx context.Context, token string) (*inviteRow, error) {
	var row inviteRow
	err := a.invites().FindOne(ctx, bson.D{{Key: "status", Value: "PENDING"}, {Key: "tokenHash", Value: hashToken(token)}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, adminErr(404, "INVITE_INVALID", "This invitation is not valid. It may have been withdrawn or already used.")
	}
	if err != nil {
		return nil, err
	}
	if row.ExpiresAt.Before(time.Now()) {
		_, _ = a.invites().UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "EXPIRED"}, {Key: "updatedAt", Value: a.now()}}}, {Key: "$unset", Value: bson.D{{Key: "tokenHash", Value: ""}}}})
		return nil, adminErr(410, "INVITE_EXPIRED", "This invitation has expired. Ask the platform team to send a new one.")
	}
	return &row, nil
}

func (a *Admins) readInvitation(c *gin.Context) {
	row, err := a.liveInvite(c, strings.TrimSpace(c.Query("token")))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "invitation", Value: ordered.Map{{Key: "email", Value: row.Email}, {Key: "expiresAt", Value: httpx.ISO(row.ExpiresAt)}, {Key: "role", Value: row.Role},
		{Key: "roleLabel", Value: inviteLabel(row.Role)}}}}, "Invitation loaded")
}

// accept is acceptPlatformAdminInvitation. No credential is minted: Google sign-in
// matches the account by email and finishes the handover. The invitation is
// claimed and the account written in one transaction, so a double tap on the link
// cannot grant twice or leave a used token live.
func (a *Admins) accept(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	token, _ := f.Str("token", valid.S{Trim: true, Min: 1, MinMsg: "This link is missing its invitation token."})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	invite, err := a.liveInvite(c, token)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var userID bson.ObjectID
	var created, already bool
	var displaced any
	err = appmongo.InTx(c, a.DB, func(ctx context.Context) error {
		now := a.now()
		created, already, displaced = false, false, nil
		var existing struct {
			ID     bson.ObjectID `bson:"_id"`
			Phone  *string       `bson:"phone"`
			Role   string        `bson:"role"`
			Status string        `bson:"status"`
		}
		found := true
		if err := a.users().FindOne(ctx, bson.D{{Key: "email", Value: invite.Email}, liveUser}).Decode(&existing); errors.Is(err, mongo.ErrNoDocuments) {
			found = false
		} else if err != nil {
			return err
		}
		claim := func(user bson.ObjectID) error {
			res, err := a.invites().UpdateOne(ctx, bson.D{{Key: "_id", Value: invite.ID}, {Key: "status", Value: "PENDING"}}, bson.D{
				{Key: "$set", Value: bson.D{{Key: "acceptedAt", Value: now}, {Key: "acceptedUserId", Value: user}, {Key: "status", Value: "ACCEPTED"}, {Key: "updatedAt", Value: now}}},
				{Key: "$unset", Value: bson.D{{Key: "tokenHash", Value: ""}}}})
			if err == nil && res.ModifiedCount == 0 {
				return adminErr(404, "INVITE_INVALID", "This invitation is not valid. It may have been withdrawn or already used.")
			}
			return err
		}
		if found && slices.Contains(invitableRoles, existing.Role) {
			// Settled rather than left live for an address that already has the access.
			already = true
			return claim(existing.ID)
		}
		if found {
			set := bson.D{{Key: "role", Value: invite.Role}}
			if existing.Role != invite.Role {
				displaced = existing.Role
				set = append(set, bson.E{Key: "previousRole", Value: existing.Role})
			}
			// Suspension is often how they left the team; inviting them back lifts it.
			if existing.Status == "SUSPENDED" || existing.Status == "ARCHIVED" {
				set = append(set, bson.E{Key: "status", Value: "ACTIVE"})
			}
			if invite.Phone != nil && (existing.Phone == nil || *existing.Phone == "") {
				set = append(set, bson.E{Key: "phone", Value: *invite.Phone})
			}
			// A held token carries the old role; the bump makes the next refresh re-sign.
			if _, err := a.users().UpdateOne(ctx, bson.D{{Key: "_id", Value: existing.ID}}, bson.D{{Key: "$set", Value: append(set, bson.E{Key: "updatedAt", Value: now})}, {Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}}}); err != nil {
				return err
			}
			userID = existing.ID
		} else {
			userID, created = bson.NewObjectID(), true
			name := invite.Email
			if invite.Name != nil && strings.TrimSpace(*invite.Name) != "" {
				name = strings.TrimSpace(*invite.Name)
			}
			doc := bson.D{{Key: "_id", Value: userID}, {Key: "name", Value: name}, {Key: "email", Value: invite.Email}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: true}, {Key: "emailVerifiedAt", Value: now}}
			if invite.Phone != nil {
				doc = append(doc, bson.E{Key: "phone", Value: *invite.Phone})
			}
			// GOOGLE: created with no password hash, so there is nothing for LOCAL to check.
			doc = append(doc, bson.E{Key: "authProvider", Value: "GOOGLE"}, bson.E{Key: "role", Value: invite.Role}, bson.E{Key: "mustChangePassword", Value: false},
				bson.E{Key: "lockPinSetAt", Value: nil}, bson.E{Key: "lockPinFailures", Value: 0}, bson.E{Key: "tokenVersion", Value: 0}, bson.E{Key: "hostelIds", Value: bson.A{}},
				bson.E{Key: "status", Value: "INVITED"}, bson.E{Key: "isDemoData", Value: false}, bson.E{Key: "isDeleted", Value: false},
				bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
			if _, err := a.users().InsertOne(ctx, doc); err != nil {
				return err
			}
		}
		return claim(userID)
	})
	if err == nil && already {
		err = errAlreadyAdmin
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var invitedBy any
	if invite.InvitedBy != nil {
		invitedBy = invite.InvitedBy.Hex()
	}
	_ = a.Audit.Write(c, audit.Entry{Action: "PLATFORM_ADMIN_INVITE_ACCEPTED", ActorID: userID, EntityID: invite.ID.Hex(), EntityType: "PlatformAdminInvite",
		Metadata: bson.D{{Key: "accountCreated", Value: created}, {Key: "displacedRole", Value: displaced}, {Key: "email", Value: invite.Email}, {Key: "invitedBy", Value: invitedBy}, {Key: "role", Value: invite.Role}}})
	httpx.OK(c, ordered.Map{{Key: "accepted", Value: true}, {Key: "accountCreated", Value: created}, {Key: "displacedRole", Value: displaced}, {Key: "email", Value: invite.Email},
		{Key: "role", Value: invite.Role}, {Key: "roleLabel", Value: inviteLabel(invite.Role)}}, "Invitation accepted")
}

var errAlreadyAdmin = adminErr(409, "ALREADY_PLATFORM_ADMIN", "This address already has platform access. Sign in with it instead.")

func itoa(n int) string { return strconv.Itoa(n) }
