// Package jobs runs the scheduled jobs (PARITY.md §5, ARCHITECTURE.md §8).
// Every run, whether the scheduler's, a POST /cron/{name} or a superadmin's
// Run now, goes through Runner.Run: one lock, one deadline, one `cronruns` row.
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/indexes"
	"github.com/softmato/hostelpalika/server/internal/platform/obs"
	"go.mongodb.org/mongo-driver/v2/mongo"

	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
)

// Collection holds one row per run: written before the job starts and closed
// after, with plain writes (never the droppable log batcher).
const Collection = "cronruns"

// keepRuns lets a superadmin compare a month with the two before it. At ~2,100
// runs a day that is ~45 MB on Atlas.
const keepRuns = 92 * 24 * time.Hour

const (
	TriggerSchedule = "schedule"
	TriggerManual   = "manual"
	TriggerHTTP     = "http"

	StatusRunning = "running"
	StatusOK      = "ok"
	StatusFailed  = "failed"
	StatusSkipped = "skipped"
	StatusTimeout = "timeout"
)

// maxCounts caps a run's stored counts; a bigger answer keeps its size only.
const maxCounts = 64 << 10

// Job is one scheduled job. Run's answer is the HTTP door's data and the run
// row's counts.
type Job struct {
	Name     string
	Schedule string        // crontab in Asia/Kathmandu; "" = on demand only
	Deadline time.Duration // TS maxDuration
	Message  string        // the door's success message
	Heavy    bool          // shares one slot with the other heavy jobs
	Run      func(ctx context.Context) (any, error)
	// Prepare reads a door's request into the job to run (platform-backup's
	// report body); nil for jobs that take no input.
	Prepare func(c *gin.Context) (*Job, error)
	sched   *schedule
}

// ErrRunning: the job is already running here or on another instance.
var ErrRunning = errors.New("jobs: already running")

type Runner struct {
	coll     *mongo.Collection
	redis    *goredis.Client
	instance string
	stop     context.Context // the API's shutdown: runs end with it
	jobs     map[string]*Job
	order    []*Job
	heavy    chan struct{}
	wg       sync.WaitGroup

	mu      sync.Mutex
	running map[string]bool
	alerted map[string]time.Time // throttle when Redis is absent

	alert func(ctx context.Context, job, problem string)
}

// alertEvery is how often one job may alert: a broken every-minute job must
// not page anyone sixty times an hour.
const alertEvery = 6 * time.Hour

// OnFailure sets who hears about a scheduled run that failed, timed out or was
// missed. Set before Schedule starts.
func (r *Runner) OnFailure(f func(ctx context.Context, job, problem string)) { r.alert = f }

// raise calls the OnFailure hook at most once per job per alertEvery, across
// replicas (Redis SET NX), with its own short deadline.
func (r *Runner) raise(ctx context.Context, job, problem string) {
	if r.alert == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if r.redis != nil {
		if first, err := r.redis.SetNX(ctx, "jobs:alert:"+job, problem, alertEvery).Result(); err == nil && !first {
			return
		}
	} else {
		r.mu.Lock()
		last, seen := r.alerted[job]
		if seen && time.Since(last) < alertEvery {
			r.mu.Unlock()
			return
		}
		r.alerted[job] = time.Now()
		r.mu.Unlock()
	}
	r.alert(ctx, job, problem)
}

// New builds a runner bound to stop, the API's shutdown context.
func New(stop context.Context, db *mongo.Database, rdb *goredis.Client) *Runner {
	host, _ := os.Hostname()
	return &Runner{coll: db.Collection(Collection), redis: rdb, instance: fmt.Sprintf("%s:%d", host, os.Getpid()), stop: stop,
		jobs: map[string]*Job{}, heavy: make(chan struct{}, 1), running: map[string]bool{}, alerted: map[string]time.Time{}}
}

// Add registers jobs; a bad crontab is a programming error.
func (r *Runner) Add(jobs ...*Job) {
	for _, j := range jobs {
		if j.Schedule != "" {
			s, err := parseSchedule(j.Schedule)
			if err != nil {
				panic(fmt.Sprintf("jobs: %s: %v", j.Name, err))
			}
			j.sched = s
		}
		r.jobs[j.Name] = j
		r.order = append(r.order, j)
	}
}

func (r *Runner) Job(name string) *Job { return r.jobs[name] }

// Jobs is every registered job, in the order added (PARITY.md §5's).
func (r *Runner) Jobs() []*Job { return r.order }

// Row is one cronruns document.
type Row struct {
	ID         bson.ObjectID `bson:"_id" json:"runId"`
	Job        string        `bson:"job" json:"job"`
	Trigger    string        `bson:"trigger" json:"trigger"`
	Instance   string        `bson:"instance" json:"instance"`
	Status     string        `bson:"status" json:"status"`
	StartedAt  time.Time     `bson:"startedAt" json:"startedAt"`
	DeadlineAt time.Time     `bson:"deadlineAt" json:"deadlineAt"`
	EndedAt    *time.Time    `bson:"endedAt" json:"endedAt"`
	DurationMs *int64        `bson:"durationMs" json:"durationMs"`
	Error      *string       `bson:"error" json:"error"`
	Counts     any           `bson:"counts" json:"counts"`
}

// IndexSpecs: the TTL, the Cron tab's per-job history, and the boot sweep.
// Built by cmd/indexes, never at boot (RULES.md §6).
var IndexSpecs = []indexes.Spec{
	{Collection: Collection, Keys: bson.D{{Key: "startedAt", Value: 1}}, TTLSeconds: ptr(int32(keepRuns.Seconds()))},
	{Collection: Collection, Keys: bson.D{{Key: "job", Value: 1}, {Key: "startedAt", Value: -1}}},
	{Collection: Collection, Keys: bson.D{{Key: "status", Value: 1}, {Key: "deadlineAt", Value: 1}}},
}

func ptr[T any](v T) *T { return &v }

// Run runs j once under its lock and deadline and records it. ErrRunning when
// another run holds the lock (recorded as skipped).
func (r *Runner) Run(parent context.Context, j *Job, trigger string) (any, error) {
	id := bson.NewObjectID()
	ctx := applog.WithRequestID(context.WithoutCancel(parent), id.Hex())
	log := slog.With("category", "jobs", "job", j.Name, "trigger", trigger)
	if j.Heavy {
		select {
		case r.heavy <- struct{}{}:
			defer func() { <-r.heavy }()
		case <-parent.Done():
			return nil, parent.Err()
		case <-r.stop.Done():
			return nil, r.stop.Err()
		}
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := Row{ID: id, Job: j.Name, Trigger: trigger, Instance: r.instance, Status: StatusRunning, StartedAt: now, DeadlineAt: now.Add(j.Deadline)}
	release, ok := r.lock(ctx, j, id.Hex())
	if !ok {
		row.Status, row.EndedAt, row.DurationMs = StatusSkipped, &now, new(int64)
		r.insert(ctx, row)
		obs.JobRun(j.Name, StatusSkipped)
		log.InfoContext(ctx, "Job skipped: another run holds its lock")
		return nil, ErrRunning
	}
	defer release()
	r.wg.Add(1)
	defer r.wg.Done()
	r.insert(ctx, row)
	log.InfoContext(ctx, "Job started")

	jctx, cancel := context.WithTimeout(ctx, j.Deadline)
	defer cancel()
	unhook := context.AfterFunc(r.stop, cancel)
	defer unhook()
	out, err := r.call(jctx, j)

	end := time.Now().UTC().Truncate(time.Millisecond)
	ms := end.Sub(now).Milliseconds()
	set := bson.D{{Key: "endedAt", Value: end}, {Key: "durationMs", Value: ms}}
	status := StatusOK
	switch {
	case err == nil:
		set = append(set, bson.E{Key: "status", Value: StatusOK}, bson.E{Key: "counts", Value: counts(out)})
		log.InfoContext(ctx, "Job finished", "durationMs", ms)
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(jctx.Err(), context.DeadlineExceeded):
		set = append(set, bson.E{Key: "status", Value: StatusTimeout}, bson.E{Key: "error", Value: err.Error()})
		status = StatusTimeout
		log.ErrorContext(ctx, "Job ran past its deadline", "error", err, "deadline", j.Deadline.String())
	default:
		if r.stop.Err() != nil {
			err = fmt.Errorf("stopped by shutdown: %w", err)
		}
		set = append(set, bson.E{Key: "status", Value: StatusFailed}, bson.E{Key: "error", Value: err.Error()})
		status = StatusFailed
		log.ErrorContext(ctx, "Job failed", "error", err, "durationMs", ms)
	}
	r.update(ctx, id, set)
	obs.JobRun(j.Name, status)
	if status != StatusOK && trigger == TriggerSchedule && r.stop.Err() == nil {
		r.raise(ctx, j.Name, status+": "+err.Error())
	}
	return out, err
}

// call runs the job, turning a panic into its error so the row still closes.
func (r *Runner) call(ctx context.Context, j *Job) (out any, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic: %v", p)
		}
	}()
	return j.Run(ctx)
}

// lock takes the job in this process and then in Redis (SET NX, owned by the
// run id). Redis down or absent fails open: every job keeps its own idempotency,
// the lock is the extra guard (PARITY.md §5).
func (r *Runner) lock(ctx context.Context, j *Job, owner string) (release func(), ok bool) {
	r.mu.Lock()
	if r.running[j.Name] {
		r.mu.Unlock()
		return nil, false
	}
	r.running[j.Name] = true
	r.mu.Unlock()
	local := func() { r.mu.Lock(); delete(r.running, j.Name); r.mu.Unlock() }
	if r.redis == nil {
		return local, true
	}
	key := "jobs:lock:" + j.Name
	got, err := r.redis.SetNX(ctx, key, owner, j.Deadline+time.Minute).Result()
	if err != nil {
		slog.WarnContext(ctx, "Job lock unavailable; running on this instance's guard alone", "category", "jobs", "job", j.Name, "error", err)
		return local, true
	}
	if !got {
		local()
		return nil, false
	}
	return func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if err := unlockScript.Run(ctx, r.redis, []string{key}, owner).Err(); err != nil {
			slog.WarnContext(ctx, "Job lock not released; it expires on its own", "category", "jobs", "job", j.Name, "error", err)
		}
		local()
	}, true
}

// unlockScript deletes the lock only while this run still owns it.
var unlockScript = goredis.NewScript(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`)

func (r *Runner) insert(ctx context.Context, row Row) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := r.coll.InsertOne(ctx, row); err != nil {
		slog.ErrorContext(ctx, "Cron run row not written", "category", "jobs", "job", row.Job, "error", err)
	}
}

func (r *Runner) update(ctx context.Context, id bson.ObjectID, set bson.D) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := r.coll.UpdateByID(ctx, id, bson.D{{Key: "$set", Value: set}}); err != nil {
		slog.ErrorContext(ctx, "Cron run row not closed", "category", "jobs", "runId", id.Hex(), "error", err)
	}
}

// counts stores the job's answer as the JSON the door sends, so the Cron tab
// shows the same fields; an oversized one keeps only its size.
func counts(out any) any {
	raw, err := json.Marshal(out)
	if err != nil {
		return bson.D{{Key: "unreadable", Value: err.Error()}}
	}
	if len(raw) > maxCounts {
		return bson.D{{Key: "truncatedBytes", Value: len(raw)}}
	}
	var v any
	if err := bson.UnmarshalExtJSON(raw, false, &v); err != nil {
		return bson.D{{Key: "unreadable", Value: err.Error()}}
	}
	return v
}

// CloseStale closes runs still `running` past their deadline, left by an
// instance that stopped mid-run. Called at boot.
func (r *Runner) CloseStale(ctx context.Context, now time.Time) (int64, error) {
	res, err := r.coll.UpdateMany(ctx, bson.D{{Key: "status", Value: StatusRunning}, {Key: "deadlineAt", Value: bson.D{{Key: "$lt", Value: now}}}},
		mongo.Pipeline{{{Key: "$set", Value: bson.D{
			{Key: "status", Value: StatusTimeout},
			{Key: "endedAt", Value: "$deadlineAt"},
			{Key: "durationMs", Value: bson.D{{Key: "$subtract", Value: bson.A{"$deadlineAt", "$startedAt"}}}},
			{Key: "error", Value: "The run never finished: its instance stopped before the deadline."},
		}}}})
	if err != nil {
		return 0, err
	}
	if res.ModifiedCount > 0 {
		slog.ErrorContext(ctx, "Cron runs closed as timed out at boot", "category", "jobs", "count", res.ModifiedCount)
	}
	return res.ModifiedCount, nil
}

// Wait blocks until every run in flight has closed its row, or ctx ends.
func (r *Runner) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() { r.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
