package platformdesk

import (
	"context"
	"sort"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// BackupReport is platformBackupReportSchema, parsed.
type BackupReport struct {
	Kind        string
	Bytes       *int64
	Collections map[string]int64
	CreatedAt   *string
	File        string
	SHA256      *string
	Mismatches  bson.A
	OK          bool
}

var (
	zero = valid.P(0)
	keep = func(dst *valid.Issues, prefix string, src valid.Issues) {
		for _, i := range src {
			p := prefix
			if i.Path != "" {
				p += "." + i.Path
			}
			dst.Add(p, i.Message)
		}
	}
)

// ParseBackupReport reads the nightly workflow's or the restore drill's post
// (`POST /cron/platform-backup`) as the zod schema does.
func ParseBackupReport(body any) (*BackupReport, error) {
	f := valid.NewForm(body)
	var r BackupReport
	r.Kind, _ = f.Enum("kind", false, nil, "BACKUP", "DRILL")

	if f.M == nil {
		return nil, f.Err()
	}
	m := &valid.Form{}
	if raw, present := f.M["manifest"]; present {
		m = valid.NewForm(raw)
	} else {
		m.Is.Add("", valid.Type("object", "undefined"))
	}
	if n, ok := m.Num("bytes", valid.N{Opt: true, Int: true, Min: zero}); ok {
		v := int64(n)
		r.Bytes = &v
	}
	if m.M != nil {
		raw, isObj := m.M["collections"].(map[string]any)
		if !isObj {
			_, present := m.M["collections"]
			m.Is.Add("collections", valid.Type("record", valid.Received(m.M["collections"], !present)))
		} else {
			keys := make([]string, 0, len(raw))
			for k := range raw {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			r.Collections = map[string]int64{}
			cf := &valid.Form{M: raw}
			for _, k := range keys {
				if n, ok := cf.Num(k, valid.N{Int: true, Min: zero}); ok {
					r.Collections[k] = int64(n)
				}
			}
			keep(&m.Is, "collections", cf.Is)
		}
	}
	if s, ok := m.Str("createdAt", valid.S{Opt: true}); ok {
		r.CreatedAt = &s
	}
	r.File, _ = m.Str("file", valid.S{Trim: true, Min: 1, Max: 200})
	if s, ok := m.Str("sha256", valid.S{Opt: true, Trim: true, Max: 128}); ok {
		r.SHA256 = &s
	}
	keep(&f.Is, "manifest", m.Is)

	r.Mismatches = bson.A{}
	if items, ok := f.Array("mismatches", false, true); ok {
		for i, it := range items {
			e := valid.NewForm(it)
			actual, _ := e.Num("actual", valid.N{Int: true})
			coll, _ := e.Str("collection", valid.S{Max: 120})
			expected, _ := e.Num("expected", valid.N{Int: true})
			keep(&f.Is, "mismatches."+strconv.Itoa(i), e.Is)
			r.Mismatches = append(r.Mismatches, bson.D{{Key: "actual", Value: ledger.JSInt(int64(actual))}, {Key: "collection", Value: coll}, {Key: "expected", Value: ledger.JSInt(int64(expected))}})
		}
		f.Size("mismatches", len(items), 0, 500, "", false)
	}
	yes := true
	r.OK, _ = f.Bool("ok", false, &yes)
	if err := f.Err(); err != nil {
		return nil, err
	}
	return &r, nil
}

// RecordBackupReport is recordPlatformBackupReport: one row per post. A backup
// is ok by being posted; a drill is ok only when it says so and no count is off.
func RecordBackupReport(ctx context.Context, db *mongo.Database, r *BackupReport, now time.Time) error {
	var docs int64
	for _, n := range r.Collections {
		docs += n
	}
	ok := r.Kind == "BACKUP" || (r.OK && len(r.Mismatches) == 0)
	d := bson.D{{Key: "kind", Value: r.Kind}, {Key: "file", Value: r.File}}
	if r.CreatedAt != nil {
		if t, err := parseJSDate(*r.CreatedAt); err == nil {
			d = append(d, bson.E{Key: "archivedAt", Value: t})
		}
	}
	if r.Bytes != nil {
		d = append(d, bson.E{Key: "bytes", Value: ledger.JSInt(*r.Bytes)})
	}
	if r.SHA256 != nil {
		d = append(d, bson.E{Key: "sha256", Value: *r.SHA256})
	}
	now = now.UTC().Truncate(time.Millisecond)
	d = append(d, bson.E{Key: "collections", Value: ledger.JSInt(int64(len(r.Collections)))}, bson.E{Key: "documents", Value: ledger.JSInt(docs)}, bson.E{Key: "ok", Value: ok},
		bson.E{Key: "mismatches", Value: r.Mismatches}, bson.E{Key: "_id", Value: bson.NewObjectIDFromTimestamp(now)},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	_, err := db.Collection("platformbackupreports").InsertOne(ctx, d)
	return err
}

// parseJSDate reads what `new Date(s)` accepts from the workflow: ISO 8601.
func parseJSDate(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, strconv.ErrSyntax
}
