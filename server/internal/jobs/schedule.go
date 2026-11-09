package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Kathmandu is the jobs' clock (PARITY.md §5); fixed +05:45, no DST, so the
// zone database is not needed in the container.
var Kathmandu = time.FixedZone("Asia/Kathmandu", 5*3600+45*60)

// schedule is a five-field crontab: minute hour day month weekday. Fields take
// `*`, `*/n`, `n`, `a-b` and comma lists; day and weekday are ANDed (the only
// schedules here never restrict both).
type schedule struct{ fields [5]map[int]bool }

var bounds = [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}

func parseSchedule(spec string) (*schedule, error) {
	parts := strings.Fields(spec)
	if len(parts) != 5 {
		return nil, fmt.Errorf("crontab %q: want 5 fields", spec)
	}
	var s schedule
	for i, p := range parts {
		lo, hi := bounds[i][0], bounds[i][1]
		if p == "*" {
			continue // nil map = any
		}
		set := map[int]bool{}
		for _, item := range strings.Split(p, ",") {
			step := 1
			if base, n, ok := strings.Cut(item, "/"); ok {
				v, err := strconv.Atoi(n)
				if err != nil || v < 1 {
					return nil, fmt.Errorf("crontab %q: bad step %q", spec, item)
				}
				item, step = base, v
			}
			from, to := lo, hi
			if item != "*" {
				a, b, isRange := strings.Cut(item, "-")
				var err error
				if from, err = strconv.Atoi(a); err != nil {
					return nil, fmt.Errorf("crontab %q: bad value %q", spec, item)
				}
				to = from
				if isRange {
					if to, err = strconv.Atoi(b); err != nil {
						return nil, fmt.Errorf("crontab %q: bad range %q", spec, item)
					}
				}
			}
			if from < lo || to > hi || from > to {
				return nil, fmt.Errorf("crontab %q: %q out of range", spec, item)
			}
			for v := from; v <= to; v += step {
				set[v] = true
			}
		}
		s.fields[i] = set
	}
	return &s, nil
}

func (s *schedule) matches(t time.Time) bool {
	t = t.In(Kathmandu)
	for i, v := range []int{t.Minute(), t.Hour(), t.Day(), int(t.Month()), int(t.Weekday())} {
		if s.fields[i] != nil && !s.fields[i][v] {
			return false
		}
	}
	return true
}

// prev is the latest matching minute strictly before t (within 8 days).
func (s *schedule) prev(t time.Time) (time.Time, bool) {
	m := t.Truncate(time.Minute)
	if m.Equal(t) {
		m = m.Add(-time.Minute)
	}
	for i := 0; i < 8*24*60; i++ {
		if s.matches(m) {
			return m, true
		}
		m = m.Add(-time.Minute)
	}
	return time.Time{}, false
}

// catchUp bounds how many missed minutes a late tick replays (a GC pause, a
// suspended laptop); anything older is reported as missed instead.
const catchUp = 5

// Schedule ticks every minute until ctx ends, starting each job whose crontab
// matches the minute. Call once, after every Add.
func (r *Runner) Schedule(ctx context.Context) {
	r.reportMissed(ctx, time.Now())
	slog.InfoContext(ctx, "Scheduler started", "category", "jobs", "jobs", len(r.jobs))
	last := time.Now().Truncate(time.Minute)
	for {
		next := last.Add(time.Minute)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Until(next)):
		}
		now := time.Now().Truncate(time.Minute)
		from := last.Add(time.Minute)
		if now.Sub(from) >= catchUp*time.Minute {
			slog.ErrorContext(ctx, "Scheduler fell behind; older minutes skipped", "category", "jobs", "from", from, "to", now)
			from = now.Add(-(catchUp - 1) * time.Minute)
		}
		for m := from; !m.After(now); m = m.Add(time.Minute) {
			for _, j := range r.jobs {
				if j.sched != nil && j.sched.matches(m) {
					go func() { _, _ = r.Run(ctx, j, TriggerSchedule) }() // Run records and logs its own outcome
				}
			}
		}
		last = now
	}
}

// reportMissed logs an error for each scheduled job whose last finished run
// is older than its last due minute. A job with no history yet stays quiet.
func (r *Runner) reportMissed(ctx context.Context, now time.Time) {
	for _, j := range r.jobs {
		if j.sched == nil {
			continue
		}
		due, ok := j.sched.prev(now)
		if !ok {
			continue
		}
		var last Row
		err := r.coll.FindOne(ctx, bson.D{{Key: "job", Value: j.Name}, {Key: "status", Value: bson.D{{Key: "$ne", Value: StatusSkipped}}}},
			options.FindOne().SetSort(bson.D{{Key: "startedAt", Value: -1}})).Decode(&last)
		if err != nil {
			continue
		}
		if last.StartedAt.Before(due.Add(-time.Minute)) {
			slog.ErrorContext(ctx, "Scheduled job missed its run", "category", "jobs", "job", j.Name, "due", due, "lastRun", last.StartedAt)
			r.raise(ctx, j.Name, "missed its run due "+due.UTC().Format(time.RFC3339))
		}
	}
}

// Missed reports whether j's last success is older than its previous due run:
// the Cron tab's flag.
func (j *Job) Missed(lastOK *time.Time, now time.Time) bool {
	if j.sched == nil {
		return false
	}
	due, ok := j.sched.prev(now)
	if !ok {
		return false
	}
	// A run due this minute or the one before may still be starting.
	if now.Sub(due) < 2*time.Minute {
		if d2, ok := j.sched.prev(due); ok {
			due = d2
		}
	}
	return lastOK == nil || lastOK.Before(due.Add(-time.Minute))
}

// Next is j's next due minute after now, or nil for an on-demand job.
func (j *Job) Next(now time.Time) *time.Time {
	if j.sched == nil {
		return nil
	}
	m := now.Truncate(time.Minute).Add(time.Minute)
	for i := 0; i < 8*24*60; i++ {
		if j.sched.matches(m) {
			return &m
		}
		m = m.Add(time.Minute)
	}
	return nil
}
