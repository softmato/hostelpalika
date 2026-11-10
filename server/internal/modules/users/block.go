package users

import (
	"errors"
	"slices"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// RegisterBlock mounts PATCH/DELETE /platform/users/:id/block (setUserBlocked):
// a superadmin blocks or unblocks any account that is not a platform admin.
func (a *Admins) RegisterBlock(v1 *gin.RouterGroup) {
	super := authz.Use(a.Guards.RequireSuperadmin)
	v1.PATCH("/platform/users/:id/block", super, func(c *gin.Context) { a.setBlocked(c, true) })
	v1.DELETE("/platform/users/:id/block", super, func(c *gin.Context) { a.setBlocked(c, false) })
}

// setBlocked is setUserBlocked. Blocking is status SUSPENDED (every sign-in path
// refuses it, see auth issueSession), a tokenVersion bump, and the sessions
// deleted, so the guard's session check ends access at once.
func (a *Admins) setBlocked(c *gin.Context, blocked bool) {
	raw := c.Param("id")
	id, err := bson.ObjectIDFromHex(raw)
	if err != nil {
		httpx.Fail(c, adminErr(422, "INVALID_OBJECT_ID", "Invalid user id."))
		return
	}
	if raw == authz.From(c).UserID {
		httpx.Fail(c, adminErr(409, "CANNOT_BLOCK_SELF", "You cannot block your own account."))
		return
	}
	var u struct {
		Role   string `bson:"role"`
		Status string `bson:"status"`
	}
	err = a.users().FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.FindOne().SetProjection(bson.D{{Key: "role", Value: 1}, {Key: "status", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, adminErr(404, "NOT_FOUND", "User not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if slices.Contains(adminRoles, u.Role) {
		httpx.Fail(c, adminErr(409, "PLATFORM_ADMIN", "Platform admins are removed from Admins, not blocked."))
		return
	}

	status, message := u.Status, "User unblocked"
	if blocked {
		message = "User blocked"
	}
	if changes := (blocked && (u.Status == "ACTIVE" || u.Status == "INVITED")) || (!blocked && u.Status == "SUSPENDED"); changes {
		status = "ACTIVE"
		update := bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: status}}}}
		if blocked {
			status = "SUSPENDED"
			update = bson.D{{Key: "$inc", Value: bson.D{{Key: "tokenVersion", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "status", Value: status}}}}
		}
		if _, err := a.users().UpdateOne(c, bson.D{{Key: "_id", Value: id}}, update); err != nil {
			httpx.Fail(c, err)
			return
		}
		if blocked {
			if _, err := a.DB.Collection("sessions").DeleteMany(c, bson.D{{Key: "userId", Value: id}}); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
		action := "USER_UNBLOCKED"
		if blocked {
			action = "USER_BLOCKED"
		}
		if err := a.Audit.Write(c, audit.Entry{Action: action, ActorID: actor(c), EntityID: raw, EntityType: "User", Metadata: bson.D{{Key: "previousStatus", Value: u.Status}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	httpx.OK(c, ordered.Map{{Key: "user", Value: ordered.Map{{Key: "id", Value: raw}, {Key: "status", Value: status}}}}, message)
}
