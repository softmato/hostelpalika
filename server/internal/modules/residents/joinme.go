package residents

import (
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// MyJoinRequest is public/join-requests/me (my-join-request.ts): the signed-in
// person's open join request — waiting, or sent back — with the link to reopen it.
func MyJoinRequest(db *mongo.Database, guards *authz.Guards) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, err := guards.Require(c)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		uid, err := bson.ObjectIDFromHex(p.UserID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		none := func() { httpx.OK(c, ordered.Map{{Key: "request", Value: nil}}, "Join request loaded") }
		var req struct {
			HostelID     bson.ObjectID `bson:"hostelId"`
			RejectReason string        `bson:"rejectReason"`
			Status       string        `bson:"status"`
		}
		err = db.Collection("residentapplications").FindOne(c, bson.D{{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"PENDING", "REJECTED"}}}}, {Key: "userId", Value: uid}},
			options.FindOne().SetSort(bson.D{{Key: "updatedAt", Value: -1}}).SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "rejectReason", Value: 1}, {Key: "status", Value: 1}})).Decode(&req)
		if err == mongo.ErrNoDocuments {
			none()
			return
		}
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var link struct {
			Token string `bson:"token"`
		}
		lerr := db.Collection("residentjoinlinks").FindOne(c, bson.D{{Key: "hostelId", Value: req.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "token", Value: 1}})).Decode(&link)
		var hostel struct {
			Name string `bson:"name"`
		}
		herr := db.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: req.HostelID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
			options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&hostel)
		for _, e := range []error{lerr, herr} {
			if e == mongo.ErrNoDocuments {
				none()
				return
			}
			if e != nil {
				httpx.Fail(c, e)
				return
			}
		}
		name := valid.Trim(hostel.Name)
		if name == "" {
			name = "Your hostel"
		}
		httpx.OK(c, ordered.Map{{Key: "request", Value: ordered.Map{{Key: "hostelName", Value: name}, {Key: "reason", Value: req.RejectReason}, {Key: "status", Value: req.Status}, {Key: "token", Value: link.Token}}}}, "Join request loaded")
	}
}
