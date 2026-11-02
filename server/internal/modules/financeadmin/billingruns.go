package financeadmin

import (
	"strconv"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerBillingRuns(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/billing-runs", httpx.ETag(), h.billingSummary)
	v1.POST("/hostel-admin/finance/billing-runs", h.runBilling)
}

func (h *Handler) billingSummary(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	period, ok := q["period"]
	if !ok {
		is.Add("period", valid.Type("string", "undefined"))
	} else if !periodRe.MatchString(period) {
		is.Add("period", periodMsg)
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requestedHostel(q))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.Ledger.BillingSummary(c, hostel, period)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Billing period summary")
}

func (h *Handler) runBilling(c *gin.Context) {
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
	var in ledger.BillingInput
	if v, present := f.M["dueDate"]; present && f.M != nil {
		if t, ok := valid.CoerceDate(v); ok {
			in.DueDate = &t
		} else {
			f.Is.Add("dueDate", valid.Type("date", "Date"))
		}
	}
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	in.Period, _ = f.Str("period", valid.S{Re: periodRe, ReMsg: periodMsg})
	list, _ := f.Array("residentIds", true, false)
	var raw []string
	for i, v := range list {
		s, ok := v.(string)
		if !ok {
			f.Is.Add("residentIds."+strconv.Itoa(i), valid.Type("string", valid.Received(v, false)))
			continue
		}
		raw = append(raw, s)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if in.HostelID, err = opsscope.HostelID(p, requested); err != nil {
		httpx.Fail(c, err)
		return
	}
	for _, s := range raw {
		id, err := bson.ObjectIDFromHex(s)
		if err != nil {
			httpx.Fail(c, err) // CastError → 404, as TS
			return
		}
		in.ResidentIDs = append(in.ResidentIDs, id)
	}
	res, err := h.Ledger.RunBillingCycle(c, in, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.Ledger.NotifyInvoicesRaised(c, in.HostelID, in.Period, res.Billed)
	if h.Cache != nil {
		h.Cache.Bump(c, in.HostelID.Hex())
	}
	httpx.OK(c, res, "Billed "+strconv.Itoa(len(res.Billed))+" residents")
}
