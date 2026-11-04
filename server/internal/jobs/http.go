package jobs

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var errBusy = httpx.NewError(http.StatusConflict, "JOB_RUNNING", "This job is already running.", nil)

// Doors serves POST /cron/{name} for every job and the Cron tab's reads.
type Doors struct {
	Runner *Runner
	Secret string
	// Superadmin is nil when the request carries a superadmin session: the Cron
	// tab's reads, and its Run now, which must never hold the secret.
	Superadmin func(c *gin.Context) error
}

// Register mounts each door by its literal path (TestRoutesMatchWeb).
func (d *Doors) Register(v1 *gin.RouterGroup) {
	for _, j := range d.Runner.Jobs() {
		v1.POST("/cron/"+j.Name, d.door(j))
	}
	v1.GET("/platform/system/cron", d.list)
	v1.GET("/platform/system/cron/runs", d.runs)
}

// Paths is each door's path, for routeBudgets.
func Paths(jobs []*Job) map[string]time.Duration {
	out := map[string]time.Duration{}
	for _, j := range jobs {
		out["/api/v1/cron/"+j.Name] = j.Deadline
	}
	return out
}

// authorize is lib/cron-auth.ts validateCronRequest (`x-cron-secret`, or
// `authorization` as the bare secret or `Bearer <secret>`, timing-safe), plus
// a superadmin session as the manual trigger.
func (d *Doors) authorize(c *gin.Context) (string, error) {
	secret := strings.TrimSpace(d.Secret)
	if secret != "" {
		header := strings.TrimSpace(c.GetHeader("x-cron-secret"))
		auth := strings.TrimSpace(c.GetHeader("authorization"))
		if same(header, secret) || same(auth, secret) || same(auth, "Bearer "+secret) {
			return TriggerHTTP, nil
		}
	}
	if d.Superadmin != nil && d.Superadmin(c) == nil {
		return TriggerManual, nil
	}
	if secret == "" {
		return "", httpx.NewError(http.StatusInternalServerError, "CRON_NOT_CONFIGURED", "CRON_SECRET is not configured.", nil)
	}
	return "", httpx.NewError(http.StatusUnauthorized, "UNAUTHORIZED", "Unauthorized", nil)
}

func same(a, b string) bool {
	return a != "" && len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (d *Doors) door(j *Job) gin.HandlerFunc {
	return func(c *gin.Context) {
		trigger, err := d.authorize(c)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		run := j
		if j.Prepare != nil {
			if run, err = j.Prepare(c); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
		out, err := d.Runner.Run(c, run, trigger)
		if errors.Is(err, ErrRunning) {
			err = errBusy
		}
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.OK(c, out, j.Message)
	}
}

func iso(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := httpx.ISO(*t)
	return &s
}

// view is a Row as both servers answer it.
func view(r Row) ordered.Map {
	return ordered.Map{
		{Key: "runId", Value: r.ID.Hex()}, {Key: "job", Value: r.Job}, {Key: "trigger", Value: r.Trigger}, {Key: "instance", Value: r.Instance},
		{Key: "status", Value: r.Status}, {Key: "startedAt", Value: httpx.ISO(r.StartedAt)}, {Key: "deadlineAt", Value: httpx.ISO(r.DeadlineAt)},
		{Key: "endedAt", Value: iso(r.EndedAt)}, {Key: "durationMs", Value: r.DurationMs}, {Key: "error", Value: r.Error}, {Key: "counts", Value: jsonOf(r.Counts)},
	}
}

// jsonOf turns stored counts back into plain JSON values.
func jsonOf(v any) any {
	if v == nil {
		return nil
	}
	raw, err := bson.Marshal(bson.D{{Key: "v", Value: v}})
	if err != nil {
		return nil
	}
	return ordered.FromBSON(bson.Raw(raw).Lookup("v"))
}

func (d *Doors) last(c *gin.Context, coll *mongo.Collection, f bson.D) (*Row, error) {
	var r Row
	err := coll.FindOne(c, f, options.FindOne().SetSort(bson.D{{Key: "startedAt", Value: -1}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &r, err
}

// list: one row per job, with its last run, last success, next due minute and
// the missed flag (last success older than its previous due run).
func (d *Doors) list(c *gin.Context) {
	if err := d.Superadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	out := make([]ordered.Map, 0, len(d.Runner.Jobs()))
	for _, j := range d.Runner.Jobs() {
		lastRun, err := d.last(c, d.Runner.coll, bson.D{{Key: "job", Value: j.Name}, {Key: "status", Value: bson.D{{Key: "$ne", Value: StatusSkipped}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		lastOK, err := d.last(c, d.Runner.coll, bson.D{{Key: "job", Value: j.Name}, {Key: "status", Value: StatusOK}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var okAt *time.Time
		if lastOK != nil {
			okAt = &lastOK.StartedAt
		}
		var lr any
		if lastRun != nil {
			lr = view(*lastRun)
		}
		var sched *string
		if j.Schedule != "" {
			sched = &j.Schedule
		}
		out = append(out, ordered.Map{
			{Key: "name", Value: j.Name}, {Key: "schedule", Value: sched}, {Key: "timezone", Value: "Asia/Kathmandu"},
			{Key: "deadlineSeconds", Value: int64(j.Deadline / time.Second)}, {Key: "nextRunAt", Value: iso(j.Next(now))},
			{Key: "missed", Value: j.Missed(okAt, now)}, {Key: "lastRun", Value: lr}, {Key: "lastOkAt", Value: iso(okAt)},
		})
	}
	httpx.OK(c, ordered.Map{{Key: "jobs", Value: out}}, "Cron jobs loaded")
}

var statuses = []string{StatusRunning, StatusOK, StatusFailed, StatusSkipped, StatusTimeout}

// runs is the history, newest first, by job, status, trigger and time.
func (d *Doors) runs(c *gin.Context) {
	if err := d.Superadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	f := bson.D{}
	names := make([]string, 0, len(d.Runner.Jobs()))
	for _, j := range d.Runner.Jobs() {
		names = append(names, j.Name)
	}
	if v := valid.QueryEnum(q, "job", &is, names...); v != nil {
		f = append(f, bson.E{Key: "job", Value: *v})
	}
	if v := valid.QueryEnum(q, "status", &is, statuses...); v != nil {
		f = append(f, bson.E{Key: "status", Value: *v})
	}
	if v := valid.QueryEnum(q, "trigger", &is, TriggerSchedule, TriggerManual, TriggerHTTP); v != nil {
		f = append(f, bson.E{Key: "trigger", Value: *v})
	}
	at := bson.D{}
	for key, op := range map[string]string{"from": "$gte", "to": "$lte"} {
		if raw, ok := q[key]; ok {
			t, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				is.Add(key, "Invalid datetime")
				continue
			}
			at = append(at, bson.E{Key: op, Value: t})
		}
	}
	if len(at) > 0 {
		f = append(f, bson.E{Key: "startedAt", Value: at})
	}
	if raw, ok := q["cursor"]; ok {
		id, err := bson.ObjectIDFromHex(raw)
		if err != nil {
			is.Add("cursor", "Invalid cursor")
		}
		f = append(f, bson.E{Key: "_id", Value: bson.D{{Key: "$lt", Value: id}}})
	}
	limit := 50
	if v := valid.QueryNumber(q, "limit", true, &is); v != nil {
		limit = max(1, min(200, int(*v)))
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := d.Runner.coll.Find(c, f, options.Find().SetSort(bson.D{{Key: "_id", Value: -1}}).SetLimit(int64(limit+1)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []Row
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	var next *string
	if len(rows) > limit {
		rows = rows[:limit]
		s := rows[limit-1].ID.Hex()
		next = &s
	}
	out := make([]ordered.Map, 0, len(rows))
	for _, r := range rows {
		out = append(out, view(r))
	}
	httpx.OK(c, ordered.Map{{Key: "runs", Value: out}, {Key: "nextCursor", Value: next}}, "Cron runs loaded")
}
