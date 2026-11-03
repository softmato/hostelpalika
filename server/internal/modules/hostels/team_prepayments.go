package hostels

import (
	"bytes"
	"io"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// /team/prepayments: the agent takes the setup fee (or the lifetime price) online
// before the hostel exists, and the registration that publishes it claims it.
func (t *TeamRegistration) registerPrepayments(v1 *gin.RouterGroup) {
	v1.GET("/team/prepayments", httpx.ETag(), t.listPrepayments)
	v1.POST("/team/prepayments", t.openPrepayment)
	v1.GET("/team/prepayments/:id", httpx.ETag(), t.readPrepayment)
	v1.PATCH("/team/prepayments/:id", t.saveDraft)
}

// bodyWithDraft reads the JSON body for validation and, separately, the `draft`
// object in its own key order, which is what is stored and handed back.
func bodyWithDraft(c *gin.Context) (any, any, error) {
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return nil, nil, err
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	body, err := valid.Body(c)
	if err != nil {
		return nil, nil, err
	}
	var draft any
	if doc, err := ordered.FromJSON(raw); err == nil {
		if m, ok := doc.(ordered.Map); ok {
			draft, _ = m.Get("draft")
		}
	}
	return body, draft, nil
}

// draftField is z.record(z.string(), z.unknown()): an object, optional or not.
func draftField(f *valid.Form, opt bool) {
	v, present := f.M["draft"]
	if !present && opt {
		return
	}
	if _, ok := v.(map[string]any); !ok {
		f.Is.Add("draft", valid.Type("record", valid.Received(v, !present)))
	}
}

func (t *TeamRegistration) openPrepayment(c *gin.Context) {
	p, err := t.Guards.RequireTeam(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, draft, err := bodyWithDraft(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	var in billing.PrepaymentIn
	in.Area, _ = f.Str("area", valid.S{Trim: true, Min: 1, MinMsg: "Fill in the area on the Location step first."})
	in.Cycle, _ = f.Enum("cycle", false, nil, "monthly", "halfYearly", "annual")
	// .email().optional().or(z.literal("")): "" passes as it is.
	if raw, present := f.M["email"]; present && raw != "" {
		in.Email, _ = f.Email("email", false, "")
	}
	in.HostelName, _ = f.Str("hostelName", valid.S{Trim: true, Min: 1, MinMsg: "Name the hostel on the first step first."})
	in.OwnerName, _ = f.Str("ownerName", valid.S{Trim: true, Min: 1, MinMsg: "Fill in the owner's name first."})
	in.Phone, _ = f.Str("phone", valid.S{Trim: true, Min: 1, MinMsg: "Fill in the owner's phone first."})
	in.PlanID, _ = f.Str("planId", valid.S{Trim: true, Min: 1, MinMsg: "Pick a plan first."})
	if amount, ok := f.Num("amount", valid.N{Opt: true, Int: true, IntMsg: "Whole rupees only.", Min: valid.P(1), MinMsg: "Enter an amount above zero."}); ok {
		n := int64(amount)
		in.Amount = &n
	}
	in.Lifetime, _ = f.Bool("lifetime", true, nil)
	in.PrepaymentID, _ = f.Str("prepaymentId", valid.S{Opt: true, Trim: true})
	draftField(f, true)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, present := f.M["draft"]; present {
		in.Draft = draft
	}
	// The same duplicate check the publish runs, so an agent never pays for a hostel
	// that cannot be listed.
	check := TeamReg{ConfirmSecond: true}
	check.Name, check.LocArea, check.Applicant.Phone = in.HostelName, in.Area, in.Phone
	if in.Email != "" {
		check.Applicant.Email = &in.Email
	}
	if err := t.assertNew(c, check); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Progress(c, "Checkout opened", func(step func(string)) (any, error) {
		return t.Settler.OpenTeamPrepayment(c, in, p, t.Outbound, step)
	})
}

func (t *TeamRegistration) listPrepayments(c *gin.Context) {
	p, err := t.Guards.RequireTeam(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows, err := t.Settler.ListUnpublishedPrepayments(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "prepayments", Value: rows}}, "Paid, not published")
}

func (t *TeamRegistration) readPrepayment(c *gin.Context) {
	p, err := t.Guards.RequireTeam(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := t.Settler.ReadTeamPrepayment(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Payment read")
}

func (t *TeamRegistration) saveDraft(c *gin.Context) {
	p, err := t.Guards.RequireTeam(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, draft, err := bodyWithDraft(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	draftField(f, false)
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := t.Settler.SaveTeamPrepaymentDraft(c, c.Param("id"), p, draft); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "saved", Value: true}}, "Draft kept")
}
