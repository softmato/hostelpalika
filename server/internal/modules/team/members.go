package team

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// team-member.service.ts: suspending, reinstating, removing and deleting a
// field agent. Superadmin only, like the rest of /platform/team.

type member struct {
	ID           bson.ObjectID `bson:"_id"`
	Email        *string       `bson:"email"`
	Name         *string       `bson:"name"`
	PreviousRole *string       `bson:"previousRole"`
	Status       *string       `bson:"status"`
}

func (h *Handler) now() time.Time { return h.Now().UTC().Truncate(time.Millisecond) }

func memberErr(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

func deref(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

func (h *Handler) findMember(ctx context.Context, id string) (*member, bson.ObjectID, error) {
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		return nil, oid, memberErr(422, "INVALID_OBJECT_ID", "Invalid member id.")
	}
	var m member
	err = h.col("users").FindOne(ctx, bson.D{{Key: "_id", Value: oid}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "PLATFORM_AGENT"}}).Decode(&m)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, oid, memberErr(404, "NOT_FOUND", "That team member was not found.")
	}
	return &m, oid, err
}

// endSessions: a bumped tokenVersion kills every access token, and the sessions go.
func (h *Handler) endSessions(ctx context.Context, id bson.ObjectID) error {
	if _, err := h.col("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: h.now()}}}}); err != nil {
		return err
	}
	_, err := h.col("sessions").DeleteMany(ctx, bson.D{{Key: "userId", Value: id}})
	return err
}

func (h *Handler) memberAction(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	action, _ := f.Enum("action", false, nil, "SUSPEND", "REINSTATE")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	id := c.Param("id")
	if action == "SUSPEND" {
		out, err := h.suspend(c, id, p)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out, "Team member suspended")
		return
	}
	out, err := h.reinstate(c, id, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Team member reinstated")
}

func statusOut(id, status string) ordered.Map {
	return ordered.Map{{Key: "id", Value: id}, {Key: "status", Value: status}}
}

func (h *Handler) suspend(ctx context.Context, id string, p *authz.Principal) (ordered.Map, error) {
	if id == p.UserID {
		return nil, memberErr(409, "CANNOT_SUSPEND_SELF", "You cannot suspend your own account.")
	}
	m, oid, err := h.findMember(ctx, id)
	if err != nil {
		return nil, err
	}
	done := ordered.Map{{Key: "member", Value: statusOut(id, "SUSPENDED")}, {Key: "suspended", Value: true}}
	if deref(m.Status, "") == "SUSPENDED" {
		return done, nil
	}
	if _, err := h.col("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: oid}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "SUSPENDED"}, {Key: "updatedAt", Value: h.now()}}}}); err != nil {
		return nil, err
	}
	if err := h.endSessions(ctx, oid); err != nil {
		return nil, err
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	return done, h.Audit.Write(ctx, audit.Entry{ActorID: actor, Action: "TEAM_MEMBER_SUSPENDED", EntityType: "User", EntityID: id,
		Metadata: bson.D{{Key: "email", Value: deref(m.Email, "")}, {Key: "previousStatus", Value: deref(m.Status, "ACTIVE")}}})
}

func (h *Handler) reinstate(ctx context.Context, id string, p *authz.Principal) (ordered.Map, error) {
	m, oid, err := h.findMember(ctx, id)
	if err != nil {
		return nil, err
	}
	if s := deref(m.Status, ""); s != "SUSPENDED" && s != "ARCHIVED" {
		return ordered.Map{{Key: "member", Value: statusOut(id, deref(m.Status, "ACTIVE"))}, {Key: "reinstated", Value: false}}, nil
	}
	if _, err := h.col("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: oid}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "ACTIVE"}, {Key: "updatedAt", Value: h.now()}}}}); err != nil {
		return nil, err
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	return ordered.Map{{Key: "member", Value: statusOut(id, "ACTIVE")}, {Key: "reinstated", Value: true}}, h.Audit.Write(ctx, audit.Entry{ActorID: actor, Action: "TEAM_MEMBER_REINSTATED",
		EntityType: "User", EntityID: id, Metadata: bson.D{{Key: "email", Value: deref(m.Email, "")}}})
}

func (h *Handler) memberDelete(c *gin.Context) {
	p := authz.From(c)
	mode := "remove"
	if v, ok := c.GetQuery("mode"); ok {
		if v != "remove" && v != "delete" {
			var is valid.Issues
			is.Add("", valid.OneOf("remove", "delete"))
			httpx.Fail(c, is.Err())
			return
		}
		mode = v
	}
	if mode == "delete" {
		out, err := h.deleteMember(c, c.Param("id"), p)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out, "Account deleted")
		return
	}
	out, err := h.removeMember(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Removed from the team")
}

// removeMember hands the account back the role it held before the invitation.
func (h *Handler) removeMember(ctx context.Context, id string, p *authz.Principal) (ordered.Map, error) {
	if id == p.UserID {
		return nil, memberErr(409, "CANNOT_REMOVE_SELF", "You cannot remove your own account from the team.")
	}
	m, oid, err := h.findMember(ctx, id)
	if err != nil {
		return nil, err
	}
	restored := deref(m.PreviousRole, "PUBLIC")
	if _, err := h.col("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: oid}}, bson.D{{Key: "$set", Value: bson.D{{Key: "role", Value: restored}, {Key: "updatedAt", Value: h.now()}}},
		{Key: "$unset", Value: bson.D{{Key: "previousRole", Value: ""}}}}); err != nil {
		return nil, err
	}
	if err := h.endSessions(ctx, oid); err != nil {
		return nil, err
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	if m.Email != nil && *m.Email != "" {
		// A pending invitation would re-grant what was just taken away.
		if _, err := h.col("platformadmininvites").UpdateMany(ctx, bson.D{{Key: "email", Value: *m.Email}, {Key: "status", Value: "PENDING"}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "revokedAt", Value: h.now()}, {Key: "revokedBy", Value: actor}, {Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: h.now()}}},
				{Key: "$unset", Value: bson.D{{Key: "tokenHash", Value: ""}}}}); err != nil {
			return nil, err
		}
	}
	return ordered.Map{{Key: "removed", Value: true}, {Key: "restoredRole", Value: restored}}, h.Audit.Write(ctx, audit.Entry{ActorID: actor, Action: "TEAM_MEMBER_REMOVED",
		EntityType: "User", EntityID: id, Metadata: bson.D{{Key: "email", Value: deref(m.Email, "")}, {Key: "restoredRole", Value: restored}, {Key: "restoredPreviousRole", Value: m.PreviousRole != nil}}})
}

// deleteMember destroys an account nothing points at. The history check and the
// deletes run in one transaction, so a registration filed in between cannot be
// left pointing at a deleted account (P7-14).
func (h *Handler) deleteMember(ctx context.Context, id string, p *authz.Principal) (ordered.Map, error) {
	if id == p.UserID {
		return nil, memberErr(409, "CANNOT_DELETE_SELF", "You cannot delete your own account.")
	}
	m, oid, err := h.findMember(ctx, id)
	if err != nil {
		return nil, err
	}
	err = appmongo.InTx(ctx, h.DB, func(ctx context.Context) error {
		regs, err := h.col("hostelsubscriptions").CountDocuments(ctx, bson.D{{Key: "agentId", Value: oid}})
		if err != nil {
			return err
		}
		cols, err := h.col("subscriptionpayments").CountDocuments(ctx, bson.D{{Key: "collectedBy", Value: oid}})
		if err != nil {
			return err
		}
		if regs > 0 || cols > 0 {
			who := deref(m.Name, deref(m.Email, "This member"))
			return memberErr(409, "MEMBER_HAS_HISTORY", fmt.Sprintf("%s has %d registration%s and %d payment%s attributed to them, and the books have to keep pointing at a real account. Remove them from the team instead — that ends their access and leaves the history intact.",
				who, regs, plural(regs), cols, plural(cols)))
		}
		if m.PreviousRole != nil {
			return memberErr(409, "MEMBER_HAS_PRIOR_ACCOUNT", "This address belonged to another account before it joined the team, so deleting it would take that account with it. Remove them from the team instead — they go back to the role they came from.")
		}
		if _, err := h.col("sessions").DeleteMany(ctx, bson.D{{Key: "userId", Value: oid}}); err != nil {
			return err
		}
		if _, err := h.col("oauthaccounts").DeleteMany(ctx, bson.D{{Key: "userId", Value: oid}}); err != nil {
			return err
		}
		// TS deleted by `{ email: member.email }`: with no email mongoose dropped the
		// key and deleted every invitation (P7-13).
		if m.Email != nil && *m.Email != "" {
			if _, err := h.col("platformadmininvites").DeleteMany(ctx, bson.D{{Key: "email", Value: *m.Email}}); err != nil {
				return err
			}
		}
		_, err = h.col("users").DeleteOne(ctx, bson.D{{Key: "_id", Value: oid}})
		return err
	})
	if err != nil {
		return nil, err
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	return ordered.Map{{Key: "deleted", Value: true}}, h.Audit.Write(ctx, audit.Entry{ActorID: actor, Action: "TEAM_MEMBER_DELETED", EntityType: "User", EntityID: id,
		Metadata: bson.D{{Key: "email", Value: deref(m.Email, "")}, {Key: "name", Value: deref(m.Name, "")}}})
}

func plural(n int64) string {
	if n == 1 {
		return ""
	}
	return "s"
}
