// Package indexes builds every index the server's collections need. Indexes are
// a migration (RULES.md §6): cmd/indexes runs this, the API never does at boot.
//
// catalogue.json is the TS schemas' declared indexes (dump-ts.mjs writes it);
// Go-only collections (cronruns, serverlogs) add theirs in cmd/indexes.
package indexes

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

//go:embed catalogue.json
var catalogue []byte

// Spec is one index on one collection.
type Spec struct {
	Collection string
	Keys       bson.D
	Unique     bool
	Sparse     bool
	TTLSeconds *int32
	Partial    bson.D
	Weights    bson.D
	Name       string // empty: the driver's default (key_value joined by "_")
}

// Catalogue reads the embedded TS index list.
func Catalogue() ([]Spec, error) {
	var raw []struct {
		Collection string          `json:"collection"`
		Keys       [][2]any        `json:"keys"`
		Options    json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(catalogue, &raw); err != nil {
		return nil, fmt.Errorf("catalogue.json: %w", err)
	}
	out := make([]Spec, 0, len(raw))
	for _, r := range raw {
		s := Spec{Collection: r.Collection}
		for _, kv := range r.Keys {
			name, _ := kv[0].(string)
			switch v := kv[1].(type) {
			case float64:
				s.Keys = append(s.Keys, bson.E{Key: name, Value: int32(v)})
			case string:
				s.Keys = append(s.Keys, bson.E{Key: name, Value: v})
			default:
				return nil, fmt.Errorf("%s: key %s has value %v", r.Collection, name, kv[1])
			}
		}
		var o struct {
			Unique             bool   `bson:"unique"`
			Sparse             bool   `bson:"sparse"`
			ExpireAfterSeconds *int32 `bson:"expireAfterSeconds"`
			Partial            bson.D `bson:"partialFilterExpression"`
			Weights            bson.D `bson:"weights"`
			Name               string `bson:"name"`
		}
		if err := bson.UnmarshalExtJSON(r.Options, false, &o); err != nil {
			return nil, fmt.Errorf("%s options: %w", r.Collection, err)
		}
		s.Unique, s.Sparse, s.TTLSeconds, s.Partial, s.Weights, s.Name = o.Unique, o.Sparse, o.ExpireAfterSeconds, o.Partial, o.Weights, o.Name
		out = append(out, s)
	}
	return out, nil
}

// IndexName is the name MongoDB gives an index with no explicit name.
func (s Spec) IndexName() string {
	if s.Name != "" {
		return s.Name
	}
	parts := make([]string, 0, len(s.Keys))
	for _, k := range s.Keys {
		parts = append(parts, fmt.Sprintf("%s_%v", k.Key, k.Value))
	}
	return strings.Join(parts, "_")
}

func (s Spec) model() mongo.IndexModel {
	o := options.Index().SetName(s.IndexName())
	if s.Unique {
		o.SetUnique(true)
	}
	if s.Sparse {
		o.SetSparse(true)
	}
	if s.TTLSeconds != nil {
		o.SetExpireAfterSeconds(*s.TTLSeconds)
	}
	if s.Partial != nil {
		o.SetPartialFilterExpression(s.Partial)
	}
	if s.Weights != nil {
		o.SetWeights(s.Weights)
	}
	return mongo.IndexModel{Keys: s.Keys, Options: o}
}

// Result says what Ensure did (or, on a dry run, would do).
type Result struct {
	Created []string // collection.name
	Extra   []string // on the database, not declared: listed, never dropped
	Failed  []string // collection.name: error (a unique index over rows that break it)
}

// Ensure creates each missing index (matched by name) and lists undeclared ones.
// Only ever creates, like ensure-indexes.mjs.
func Ensure(ctx context.Context, db *mongo.Database, specs []Spec, dryRun bool) (Result, error) {
	var res Result
	byColl := map[string][]Spec{}
	for _, s := range specs {
		byColl[s.Collection] = append(byColl[s.Collection], s)
	}
	colls := make([]string, 0, len(byColl))
	for c := range byColl {
		colls = append(colls, c)
	}
	sort.Strings(colls)
	for _, c := range colls {
		existing, err := db.Collection(c).Indexes().ListSpecifications(ctx)
		if err != nil {
			return res, fmt.Errorf("%s: list indexes: %w", c, err)
		}
		have := map[string]bool{}
		for _, e := range existing {
			have[e.Name] = true
		}
		want := map[string]bool{"_id_": true}
		for _, s := range byColl[c] {
			name := s.IndexName()
			want[name] = true
			if have[name] {
				continue
			}
			if !dryRun {
				if _, err := db.Collection(c).Indexes().CreateOne(ctx, s.model()); err != nil {
					res.Failed = append(res.Failed, fmt.Sprintf("%s.%s: %v", c, name, err))
					continue
				}
			}
			res.Created = append(res.Created, c+"."+name)
		}
		for _, e := range existing {
			if !want[e.Name] {
				res.Extra = append(res.Extra, c+"."+e.Name)
			}
		}
	}
	return res, nil
}
