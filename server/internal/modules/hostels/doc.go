package hostels

import (
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// hostelDoc reads a stored hostel the way TS reads a `.lean()` row: a missing
// or null field is "nullish", anything else passes through as stored.
type hostelDoc struct{ bson.Raw }

func (h hostelDoc) val(path ...string) bson.RawValue {
	v, err := h.Raw.LookupErr(path...)
	if err != nil {
		return bson.RawValue{}
	}
	return v
}

func nullish(v bson.RawValue) bool {
	return v.Type == 0 || v.Type == bson.TypeNull || v.Type == bson.TypeUndefined
}

// pass is `hostel.x`: absent stays absent (dropped by JSON.stringify).
func pass(v bson.RawValue) any {
	if v.Type == 0 {
		return ordered.Undefined
	}
	return ordered.FromBSON(v)
}

// or is `hostel.x ?? fallback`.
func or(v bson.RawValue, fallback any) any {
	if nullish(v) {
		return fallback
	}
	return ordered.FromBSON(v)
}

func (h hostelDoc) str(path ...string) string {
	s, _ := h.val(path...).StringValueOK()
	return s
}

func (h hostelDoc) num(path ...string) float64 {
	f, _ := ordered.FromBSON(h.val(path...)).(float64)
	return f
}

func (h hostelDoc) boolean(path ...string) bool {
	b, _ := h.val(path...).BooleanOK()
	return b
}

func (h hostelDoc) strs(path ...string) []string {
	var out []string
	arr, ok := h.val(path...).ArrayOK()
	if !ok {
		return out
	}
	vals, _ := arr.Values()
	for _, v := range vals {
		if s, ok := v.StringValueOK(); ok {
			out = append(out, s)
		}
	}
	return out
}

func (h hostelDoc) oid(path ...string) (bson.ObjectID, bool) {
	return h.val(path...).ObjectIDOK()
}

func (h hostelDoc) id() string {
	id, _ := h.oid("_id")
	return id.Hex()
}

// idOf is `x._id?.toString()` on a subdocument: absent when there is none.
func idOf(v bson.RawValue) any {
	if id, ok := v.ObjectIDOK(); ok {
		return id.Hex()
	}
	if nullish(v) {
		return ordered.Undefined
	}
	return ordered.FromBSON(v)
}

// docs is an array field's subdocuments (non-documents skipped).
func (h hostelDoc) docs(path ...string) []hostelDoc {
	var out []hostelDoc
	arr, ok := h.val(path...).ArrayOK()
	if !ok {
		return out
	}
	vals, _ := arr.Values()
	for _, v := range vals {
		if d, ok := v.DocumentOK(); ok {
			out = append(out, hostelDoc{d})
		}
	}
	return out
}
