// Package ordered is a JSON object that keeps its key order, and the BSON →
// JSON conversion TS gets from mongoose `.lean()` followed by JSON.stringify:
// stored key order, ObjectId → hex, Date → ISO string, every number a JS number.
//
// Use it where TS passes a stored subdocument through untouched
// (`location: hostel.location`); anything TS builds key by key is a struct.
package ordered

import (
	"bytes"
	"encoding/json"
	"math"
	"time"

	"github.com/bytedance/sonic"
	"go.mongodb.org/mongo-driver/v2/bson"
)

var enc = sonic.ConfigDefault // same encoder as httpx: no HTML escaping

type Pair struct {
	Key   string
	Value any
}

// Map is a JSON object in insertion order. A nil Map encodes as {}.
type Map []Pair

func (m Map) Get(key string) (any, bool) {
	for _, p := range m {
		if p.Key == key {
			return p.Value, true
		}
	}
	return nil, false
}

// Set replaces key in place, or appends it — the order a JS spread gives.
func (m Map) Set(key string, v any) Map {
	for i := range m {
		if m[i].Key == key {
			m[i].Value = v
			return m
		}
	}
	return append(m, Pair{key, v})
}

func (m Map) Delete(key string) Map {
	out := m[:0:0]
	for _, p := range m {
		if p.Key != key {
			out = append(out, p)
		}
	}
	return out
}

// Undefined is a value JSON.stringify drops from an object (and writes as null in an array).
type undefined struct{}

var Undefined any = undefined{}

func (m Map) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	first := true
	for _, p := range m {
		if p.Value == Undefined {
			continue
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		k, _ := enc.Marshal(p.Key)
		b.Write(k)
		b.WriteByte(':')
		v, err := enc.Marshal(p.Value)
		if err != nil {
			return nil, err
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (u undefined) MarshalJSON() ([]byte, error) { return []byte("null"), nil }

// FromBSON is a stored value as `.lean()` + JSON.stringify would write it.
// Numbers come back as float64 (int32/int64 promoted like the driver's promoteLongs).
func FromBSON(v bson.RawValue) any {
	switch v.Type {
	case bson.TypeEmbeddedDocument:
		elems, _ := v.Document().Elements()
		m := make(Map, 0, len(elems))
		for _, e := range elems {
			m = append(m, Pair{e.Key(), FromBSON(e.Value())})
		}
		return m
	case bson.TypeArray:
		vals, _ := v.Array().Values()
		out := make([]any, len(vals))
		for i, e := range vals {
			out[i] = FromBSON(e)
		}
		return out
	case bson.TypeString:
		return v.StringValue()
	case bson.TypeDouble:
		return jsNumber(v.Double())
	case bson.TypeInt32:
		return float64(v.Int32())
	case bson.TypeInt64:
		return float64(v.Int64())
	case bson.TypeBoolean:
		return v.Boolean()
	case bson.TypeNull, bson.TypeUndefined:
		return nil
	case bson.TypeObjectID:
		return v.ObjectID().Hex()
	case bson.TypeDateTime:
		return time.UnixMilli(v.DateTime()).UTC().Format("2006-01-02T15:04:05.000Z")
	case bson.TypeDecimal128:
		return Map{{"$numberDecimal", v.Decimal128().String()}}
	default:
		return nil
	}
}

// jsNumber is what JSON.stringify writes for a non-finite double: null.
func jsNumber(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}

// Raw is FromBSON for a whole raw document (nil when absent).
func Raw(doc bson.Raw) any {
	if doc == nil {
		return nil
	}
	return FromBSON(bson.RawValue{Type: bson.TypeEmbeddedDocument, Value: doc})
}

// FromJSON decodes JSON keeping object key order (Map), numbers as float64.
func FromJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	return decode(dec)
}

func decode(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			out := []any{}
			for dec.More() {
				v, err := decode(dec)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
			_, err := dec.Token()
			return out, err
		}
		m := Map{}
		for dec.More() {
			k, err := dec.Token()
			if err != nil {
				return nil, err
			}
			v, err := decode(dec)
			if err != nil {
				return nil, err
			}
			m = append(m, Pair{k.(string), v})
		}
		_, err := dec.Token()
		return m, err
	default:
		return t, nil // string, float64, bool, nil
	}
}

// ToBSON turns a decoded value back into BSON in the same key order.
func ToBSON(v any) any {
	switch x := v.(type) {
	case Map:
		d := make(bson.D, 0, len(x))
		for _, p := range x {
			if p.Value != Undefined {
				d = append(d, bson.E{Key: p.Key, Value: ToBSON(p.Value)})
			}
		}
		return d
	case []any:
		a := make(bson.A, len(x))
		for i, e := range x {
			a[i] = ToBSON(e)
		}
		return a
	}
	return v
}
