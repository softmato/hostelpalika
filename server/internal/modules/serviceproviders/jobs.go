package serviceproviders

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type job struct {
	ID               bson.ObjectID  `bson:"_id"`
	Category         string         `bson:"category"`
	CompletedAt      *time.Time     `bson:"completedAt"`
	CreatedAt        *time.Time     `bson:"createdAt"`
	Description      string         `bson:"description"`
	HostelID         bson.ObjectID  `bson:"hostelId"`
	Location         string         `bson:"location"`
	MinimumCharge    *float64       `bson:"minimumCharge"`
	Priority         string         `bson:"priority"`
	ScheduledFor     *time.Time     `bson:"scheduledFor"`
	Status           string         `bson:"status"`
	Title            string         `bson:"title"`
	VoiceNoteAssetID *bson.ObjectID `bson:"voiceNoteAssetId"`
}

func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func (h *Handler) jobs(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	pr, err := h.findOwn(c, p.UserID, bson.D{{Key: "status", Value: "APPROVED"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if pr == nil {
		httpx.OK(c, ordered.Map{{Key: "available", Value: []any{}}, {Key: "jobs", Value: []any{}}}, "Jobs loaded")
		return
	}
	col := h.DB.Collection("maintenancerequests")
	find := func(filter bson.D) ([]job, error) {
		cur, err := col.Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(100))
		if err != nil {
			return nil, err
		}
		var out []job
		return out, cur.All(c, &out)
	}
	mine, err := find(bson.D{{Key: "isDeleted", Value: false}, {Key: "providerId", Value: pr.ID}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	open, err := find(bson.D{{Key: "isDeleted", Value: false}, {Key: "providerId", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "status", Value: "PENDING"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := bson.A{}
	for _, j := range append(append([]job{}, mine...), open...) {
		ids = append(ids, j.HostelID)
	}
	type hostel struct {
		ID      bson.ObjectID `bson:"_id"`
		Name    string        `bson:"name"`
		Contact struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
		Location struct {
			Area string `bson:"area"`
			City string `bson:"city"`
		} `bson:"location"`
	}
	hostels := map[bson.ObjectID]hostel{}
	if len(ids) > 0 {
		cur, err := h.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}},
			options.Find().SetProjection(bson.D{{Key: "contact", Value: 1}, {Key: "location", Value: 1}, {Key: "name", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var rows []hostel
		if err := cur.All(c, &rows); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, r := range rows {
			hostels[r.ID] = r
		}
	}
	mine2 := map[string]bool{}
	for _, cat := range pr.cats() {
		mine2[categoryForRole(cat)] = true
	}
	type row struct {
		out     ordered.Map
		inTrade bool
	}
	ser := func(j job, accepted bool) row {
		ho, found := hostels[j.HostelID]
		name, phone := "A hostel", ""
		if found {
			name = ho.Name
			if accepted {
				phone = ho.Contact.Phone
			}
		}
		var charge, voice any
		if j.MinimumCharge != nil {
			charge = *j.MinimumCharge
		}
		if accepted && j.VoiceNoteAssetID != nil {
			voice = j.VoiceNoteAssetID.Hex()
		}
		return row{inTrade: mine2[j.Category], out: ordered.Map{
			{Key: "category", Value: j.Category}, {Key: "createdAt", Value: nullTime(j.CreatedAt)}, {Key: "description", Value: j.Description},
			{Key: "hostelArea", Value: ho.Location.Area}, {Key: "hostelCity", Value: ho.Location.City}, {Key: "hostelName", Value: name}, {Key: "hostelPhone", Value: phone},
			{Key: "id", Value: j.ID.Hex()}, {Key: "inMyTrade", Value: mine2[j.Category]}, {Key: "location", Value: j.Location}, {Key: "minimumCharge", Value: charge},
			{Key: "priority", Value: j.Priority}, {Key: "scheduledFor", Value: nullTime(j.ScheduledFor)}, {Key: "status", Value: j.Status}, {Key: "title", Value: j.Title},
			{Key: "voiceNoteAssetId", Value: voice},
		}}
	}
	avail := make([]row, 0, len(open))
	for _, j := range open {
		avail = append(avail, ser(j, false))
	}
	sort.SliceStable(avail, func(a, b int) bool { return avail[a].inTrade && !avail[b].inTrade })
	availOut := make([]any, 0, len(avail))
	for _, r := range avail {
		availOut = append(availOut, r.out)
	}
	jobsOut := make([]any, 0, len(mine))
	for _, j := range mine {
		jobsOut = append(jobsOut, ser(j, true).out)
	}
	httpx.OK(c, ordered.Map{{Key: "available", Value: availOut}, {Key: "jobs", Value: jobsOut}}, "Jobs loaded")
}

var statusWords = map[string]string{"CANCELLED": "cancelled", "COMPLETED": "completed", "CONTACTED": "picked up", "PENDING": "reopened", "SCHEDULED": "scheduled"}

// notifyStaffOfJobProgress is notifyStaffOfJobProgress (maintenance-notify.ts). Best effort.
func (h *Handler) notifyStaffOfJobProgress(ctx context.Context, actor, previous, providerName string, j job) {
	if previous == j.Status {
		return
	}
	staff, err := residents.HostelStaffUserIDs(ctx, h.DB, j.HostelID, false)
	if err != nil {
		return
	}
	word, ok := statusWords[j.Status]
	if !ok {
		word = lower(j.Status)
	}
	where := ""
	if j.Location != "" {
		where = " at " + j.Location
	}
	priority := "NORMAL"
	if j.Status != "COMPLETED" && (j.Priority == "URGENT" || j.Priority == "HIGH") {
		priority = j.Priority
	}
	for _, u := range staff {
		if u == actor {
			continue
		}
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{
			ActionURL: "/hostel-admin/maintenance", Body: providerName + " " + word + ` "` + j.Title + `"` + where + ".", Category: "MAINTENANCE",
			Data:     ordered.Map{{Key: "maintenanceRequestId", Value: j.ID.Hex()}, {Key: "status", Value: j.Status}},
			HostelID: j.HostelID.Hex(), Priority: priority, Title: "Maintenance " + word, UserID: u,
		})
	}
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func (h *Handler) jobGone() *httpx.Error {
	return serErr("Job was not found.", "MAINTENANCE_REQUEST_NOT_FOUND", http.StatusNotFound)
}

func (h *Handler) history(ctx context.Context, actor bson.ObjectID, j job, action, prev, next, note string, now time.Time) error {
	d := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: j.HostelID}, {Key: "requestId", Value: j.ID}, {Key: "actorId", Value: actor}, {Key: "action", Value: action},
		{Key: "previousStatus", Value: prev}, {Key: "nextStatus", Value: next}}
	if note != "" {
		d = append(d, bson.E{Key: "note", Value: note})
	}
	d = append(d, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "__v", Value: 0})
	_, err := h.DB.Collection("maintenancehistories").InsertOne(ctx, d)
	return err
}

func (h *Handler) accept(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	pr, err := h.findOwn(c, p.UserID, bson.D{{Key: "status", Value: "APPROVED"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if pr == nil {
		httpx.Fail(c, h.jobGone())
		return
	}
	jobID, err := objectID(c.Param("id"), "job id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	var got job
	err = h.DB.Collection("maintenancerequests").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: jobID}, {Key: "isDeleted", Value: false},
		{Key: "providerId", Value: bson.D{{Key: "$exists", Value: false}}}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "providerId", Value: pr.ID}, {Key: "status", Value: "CONTACTED"}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&got)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, serErr("Another provider already took this job, or the hostel closed it.", "MAINTENANCE_JOB_TAKEN", http.StatusConflict))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.history(c, actor, got, "MAINTENANCE_PROVIDER_ACCEPTED", "PENDING", "CONTACTED", "Accepted by "+pr.FullName+".", now); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{ActorID: actor, HostelID: got.HostelID, Action: "MAINTENANCE_PROVIDER_ACCEPTED", EntityType: "MaintenanceRequest", EntityID: got.ID.Hex(),
		Metadata: bson.D{{Key: "providerId", Value: pr.ID.Hex()}, {Key: "source", Value: "SERVICE_PROVIDER"}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{got.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Maintenance}})
	h.notifyStaffOfJobProgress(c, p.UserID, "PENDING", pr.FullName, got)
	httpx.OK(c, ordered.Map{{Key: "job", Value: ordered.Map{{Key: "id", Value: got.ID.Hex()}, {Key: "status", Value: got.Status}}}}, "Job accepted")
}

func (h *Handler) updateJob(c *gin.Context) {
	p, err := h.Guards.Require(c)
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
	note, hasNote := f.Str("note", valid.S{Opt: true, Trim: true, Max: 800})
	status, _ := f.Enum("status", false, nil, "CONTACTED", "COMPLETED")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	pr, err := h.findOwn(c, p.UserID, bson.D{{Key: "status", Value: "APPROVED"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if pr == nil {
		httpx.Fail(c, h.jobGone())
		return
	}
	jobID, err := objectID(c.Param("id"), "job id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	col := h.DB.Collection("maintenancerequests")
	var before job
	err = col.FindOne(c, bson.D{{Key: "_id", Value: jobID}, {Key: "isDeleted", Value: false}, {Key: "providerId", Value: pr.ID}}).Decode(&before)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, h.jobGone())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if before.Status == "COMPLETED" || before.Status == "CANCELLED" {
		httpx.Fail(c, serErr("This job is already closed. Ask the hostel to reopen it.", "MAINTENANCE_REQUEST_CLOSED", http.StatusConflict))
		return
	}
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	now := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "status", Value: status}, {Key: "updatedBy", Value: actor}}
	if status == "COMPLETED" {
		set = append(set, bson.E{Key: "completedAt", Value: now})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	var updated job
	err = col.FindOneAndUpdate(c, bson.D{{Key: "_id", Value: before.ID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: before.Status}}, bson.D{{Key: "$set", Value: set}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&updated)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, serErr("This job changed while you were working on it. Pull to refresh.", "MAINTENANCE_REQUEST_CONFLICT", http.StatusConflict))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	n := ""
	if hasNote {
		n = note
	}
	if err := h.history(c, actor, before, "MAINTENANCE_STATUS_UPDATED", before.Status, updated.Status, n, now); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.Write(c, audit.Entry{ActorID: actor, HostelID: before.HostelID, Action: "MAINTENANCE_STATUS_UPDATED", EntityType: "MaintenanceRequest", EntityID: before.ID.Hex(),
		Metadata: bson.D{{Key: "nextStatus", Value: updated.Status}, {Key: "previousStatus", Value: before.Status}, {Key: "providerId", Value: pr.ID.Hex()}, {Key: "source", Value: "SERVICE_PROVIDER"}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	realtime.PublishResourceChange(c, h.RT, h.Cache, realtime.Change{HostelIDs: []string{before.HostelID.Hex()}, Topics: []realtime.Topic{realtime.Maintenance}})
	name := pr.FullName
	if name == "" {
		name = "The service provider"
	}
	merged := before
	merged.Status = updated.Status
	h.notifyStaffOfJobProgress(c, p.UserID, before.Status, name, merged)
	httpx.OK(c, ordered.Map{{Key: "job", Value: ordered.Map{{Key: "completedAt", Value: nullTime(updated.CompletedAt)}, {Key: "id", Value: updated.ID.Hex()}, {Key: "status", Value: updated.Status}}}}, "Job updated")
}
