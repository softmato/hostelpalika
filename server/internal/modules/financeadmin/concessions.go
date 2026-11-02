package financeadmin

import (
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// periodRe is periodSchema (fee-schedule.validation.ts).
var periodRe = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

const periodMsg = "Period must be YYYY-MM."

func (h *Handler) registerConcessions(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/rent-concessions", httpx.ETag(), h.listConcessions)
	v1.POST("/hostel-admin/finance/rent-concessions", h.saveConcession)
	v1.DELETE("/hostel-admin/finance/rent-concessions/:id", h.deleteConcession)
}

type concessionRow struct {
	ID         string  `json:"_id"`
	Label      string  `json:"label"`
	PercentOff any     `json:"percentOff"`
	Period     string  `json:"period"`
	Reason     *string `json:"reason"`
	Standing   string  `json:"standing"`
}

// concessionRows is listRentConcessions, newest month first.
func (h *Handler) concessionRows(c *gin.Context, hostel bson.ObjectID) ([]concessionRow, error) {
	cur, err := h.DB.Collection("rentconcessions").Find(c, bson.D{{Key: "hostelId", Value: hostel}}, options.Find().SetSort(bson.D{{Key: "period", Value: -1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID         bson.ObjectID `bson:"_id"`
		PercentOff int64         `bson:"percentOff"`
		Period     string        `bson:"period"`
		Reason     string        `bson:"reason"`
	}
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}
	now, err := bs.PeriodOf(time.Now())
	if err != nil {
		return nil, err
	}
	out := make([]concessionRow, 0, len(rows))
	for _, r := range rows {
		row := concessionRow{ID: r.ID.Hex(), Label: bs.FormatPeriod(r.Period), PercentOff: ledger.JSInt(r.PercentOff), Period: r.Period, Standing: "upcoming"}
		if row.Label == "" {
			row.Label = r.Period
		}
		if r.Reason != "" {
			reason := r.Reason
			row.Reason = &reason
		}
		if r.Period == now {
			row.Standing = "current"
		} else if r.Period < now {
			row.Standing = "past"
		}
		out = append(out, row)
	}
	return out, nil
}

func (h *Handler) listConcessions(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requestedHostel(valid.Query(c)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows, err := h.concessionRows(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		Concessions []concessionRow `json:"concessions"`
	}{rows}, "Month discounts")
}

func (h *Handler) saveConcession(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "manageFeeSchedule")
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
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	pct, _ := f.Num("percentOff", valid.N{Int: true, IntMsg: "Use a whole percent.", Min: valid.P(1), MinMsg: "Use at least 1%. Delete the discount to charge full rent.", Max: valid.P(100)})
	period, _ := f.Str("period", valid.S{Re: periodRe, ReMsg: periodMsg})
	reason, _ := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 60})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	set := bson.D{{Key: "percentOff", Value: int64(pct)}, {Key: "updatedAt", Value: nowMS()}}
	update := bson.D{}
	if reason != "" {
		set = append(set, bson.E{Key: "reason", Value: reason})
	} else {
		update = append(update, bson.E{Key: "$unset", Value: bson.D{{Key: "reason", Value: ""}}})
	}
	var createdBy any
	if id, err := bson.ObjectIDFromHex(p.UserID); err == nil {
		createdBy = id
	}
	update = append(update, bson.E{Key: "$set", Value: set}, bson.E{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: createdBy},
		{Key: "hostelId", Value: hostel}, {Key: "period", Value: period}, {Key: "createdAt", Value: nowMS()}, {Key: "__v", Value: 0}}})
	if _, err := h.DB.Collection("rentconcessions").UpdateOne(c, bson.D{{Key: "hostelId", Value: hostel}, {Key: "period", Value: period}}, update, options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	rows, err := h.concessionRows(c, hostel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var saved *concessionRow
	for i := range rows {
		if rows[i].Period == period {
			saved = &rows[i]
		}
	}
	if saved == nil {
		httpx.Fail(c, finance.Err("RENT_CONCESSION_NOT_FOUND", "The discount could not be saved."))
		return
	}
	applied, err := h.Ledger.ApplyConcession(c, hostel, period, int64(pct), reason, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, struct {
		Concession struct {
			concessionRow
			Applied ledger.ConcessionBackfill `json:"applied"`
		} `json:"concession"`
	}{struct {
		concessionRow
		Applied ledger.ConcessionBackfill `json:"applied"`
	}{*saved, applied}}, "Month discount saved")
}

func (h *Handler) deleteConcession(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "manageFeeSchedule")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		httpx.Fail(c, err) // CastError → 404, as TS
		return
	}
	var gone struct {
		Period string `bson:"period"`
	}
	err = h.DB.Collection("rentconcessions").FindOneAndDelete(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}}).Decode(&gone)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, finance.Err("RENT_CONCESSION_NOT_FOUND", "That discount was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	restored, err := h.Ledger.ApplyConcession(c, hostel, gone.Period, 0, "", nil)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, struct {
		DeletedID string                    `json:"deletedId"`
		Restored  ledger.ConcessionBackfill `json:"restored"`
	}{id.Hex(), restored}, "Month discount removed")
}
