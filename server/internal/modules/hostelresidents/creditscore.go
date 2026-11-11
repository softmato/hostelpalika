package hostelresidents

import (
	"errors"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// creditScore is GET /hostel-admin/residents/:id/credit-score (getResidentCreditScore).
func (h *Handler) creditScore(c *gin.Context) {
	hostel, _, ok := scope(c)
	if !ok {
		return
	}
	rid, err := bson.ObjectIDFromHex(c.Param("id"))
	notFound := finance.Err("RESIDENT_NOT_FOUND", "Resident was not found.")
	if err != nil {
		fail(c, notFound)
		return
	}
	var r struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err = h.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: rid}, {Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		fail(c, notFound)
		return
	}
	if fail(c, err) {
		return
	}
	var code *string
	if s, err := h.Ledger.EnsureResidentPaymentCode(c, hostel, rid, ""); err == nil {
		code = &s
	}
	out, err := finance.CreditScoreOf(c, h.DB, rid, code)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Credit score")
}
