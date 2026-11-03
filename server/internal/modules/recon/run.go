// Package recon is withRun: one reconciliation run row per check, with its
// counters and findings, so every scheduled money check leaves a record the
// finance screens read.
package recon

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const maxFindings = 200

type Finding struct {
	Code, Detail, EntityType string
	EntityID                 *bson.ObjectID
	Severity                 string // "" = INFO
}

// Recorder collects a run's counters (in first-seen order) and findings.
type Recorder struct {
	counts   bson.D
	Findings []Finding
}

func (r *Recorder) Count(name string, by int64) {
	for i := range r.counts {
		if r.counts[i].Key == name {
			r.counts[i].Value = r.counts[i].Value.(int64) + by
			return
		}
	}
	r.counts = append(r.counts, bson.E{Key: name, Value: by})
}

func (r *Recorder) Finding(f Finding) {
	if f.Severity == "" {
		f.Severity = "INFO"
	}
	r.Findings = append(r.Findings, f)
}

// Status is statusFor: any ERROR or WARN finding makes the run WARN.
func (r *Recorder) Status() string {
	for _, f := range r.Findings {
		if f.Severity == "ERROR" || f.Severity == "WARN" {
			return "WARN"
		}
	}
	return "OK"
}

func (r *Recorder) findingsDoc() bson.A {
	out := bson.A{}
	for i, f := range r.Findings {
		if i == maxFindings {
			break
		}
		var id any
		if f.EntityID != nil {
			id = *f.EntityID
		}
		out = append(out, bson.D{{Key: "code", Value: f.Code}, {Key: "detail", Value: f.Detail}, {Key: "entityId", Value: id}, {Key: "entityType", Value: f.EntityType}, {Key: "severity", Value: f.Severity}})
	}
	return out
}

func (r *Recorder) countsDoc() bson.D {
	out := make(bson.D, len(r.counts))
	for i, e := range r.counts {
		out[i] = bson.E{Key: e.Key, Value: int32or64(e.Value.(int64))}
	}
	return out
}

// int32or64 is how mongoose stores a JS number that is a small integer.
func int32or64(n int64) any {
	if n >= -1<<31 && n < 1<<31 {
		return int32(n)
	}
	return n
}

type Run struct {
	ID     bson.ObjectID
	Status string // OK, WARN, FAIL
}

// WithRun opens a RUNNING row, runs work, and closes it with the counters and
// findings; a failed work closes it FAIL with the error and returns that error.
func WithRun(ctx context.Context, db *mongo.Database, hostelID *bson.ObjectID, kind, triggeredBy string, work func(*Recorder) error) (Run, *Recorder, error) {
	runs := db.Collection("reconciliationruns")
	now := time.Now().UTC().Truncate(time.Millisecond)
	if triggeredBy == "" {
		triggeredBy = "CRON"
	}
	var hostel any
	if hostelID != nil {
		hostel = *hostelID
	}
	id := bson.NewObjectID()
	rec := &Recorder{}
	if _, err := runs.InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "kind", Value: kind}, {Key: "startedAt", Value: now}, {Key: "status", Value: "RUNNING"},
		{Key: "triggeredBy", Value: triggeredBy}, {Key: "counters", Value: bson.D{}}, {Key: "findings", Value: bson.A{}}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		return Run{}, rec, err
	}
	werr := work(rec)
	status := rec.Status()
	finished := time.Now().UTC().Truncate(time.Millisecond)
	set := bson.D{{Key: "counters", Value: rec.countsDoc()}, {Key: "findings", Value: rec.findingsDoc()}, {Key: "finishedAt", Value: finished}, {Key: "status", Value: status}, {Key: "updatedAt", Value: finished}}
	if werr != nil {
		status = "FAIL"
		set = append(set, bson.E{Key: "errorDetail", Value: werr.Error()})
		set[3].Value = status
	}
	// Closed even when the caller's deadline is spent: a run left RUNNING is a lie.
	if _, err := runs.UpdateOne(context.WithoutCancel(ctx), bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		slog.ErrorContext(ctx, "could not close reconciliation run", "category", "jobs", "id", id.Hex(), "error", err.Error())
	}
	return Run{ID: id, Status: status}, rec, werr
}
