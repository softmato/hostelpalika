// Package opsscope is what the hostel-admin ops routes share: the TS
// resolveAdminHostelId / scopedHostelFilter pair and the page query.
package opsscope

import (
	"net/http"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// HostelID is resolveAdminHostelId: the requested hostel if the caller may open
// it (404 otherwise), else the only hostel they have, else 422.
func HostelID(p *authz.Principal, requested string) (bson.ObjectID, error) {
	if requested != "" {
		if err := authz.AssertHostelScoped(p, requested); err != nil {
			return bson.ObjectID{}, err
		}
		return httpx.OID(requested, "hostel id")
	}
	if len(p.HostelIDs) == 1 {
		return httpx.OID(p.HostelIDs[0], "hostel id")
	}
	return bson.ObjectID{}, httpx.NewError(http.StatusUnprocessableEntity, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for this hostel admin action.", nil)
}

// IDs is every hostel the caller may open, as object ids.
func IDs(p *authz.Principal) []bson.ObjectID {
	out := make([]bson.ObjectID, 0, len(p.HostelIDs))
	for _, h := range p.HostelIDs {
		if id, err := bson.ObjectIDFromHex(h); err == nil {
			out = append(out, id)
		}
	}
	return out
}

// Filter is scopedHostelFilter: one hostel when asked for, else all of theirs.
func Filter(p *authz.Principal, requested string) (bson.D, error) {
	if requested != "" {
		id, err := HostelID(p, requested)
		if err != nil {
			return nil, err
		}
		return bson.D{{Key: "hostelId", Value: id}}, nil
	}
	return bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: IDs(p)}}}}, nil
}

// Hostel is `hostelId: objectIdSchema.optional()` read from the query.
func Hostel(q map[string]string, is *valid.Issues) string {
	raw, ok := q["hostelId"]
	if !ok {
		return ""
	}
	s, _ := valid.ObjectID(raw, "hostelId", "", is, false)
	return s
}

// ReadPage is paginationQuerySchema.
func ReadPage(q map[string]string, is *valid.Issues) pagination.Query {
	out := pagination.Query{}
	read := func(key string, max float64) *int {
		v := valid.QueryNumber(q, key, false, is)
		if v == nil {
			return nil
		}
		n := *v
		if n != float64(int(n)) {
			is.Add(key, valid.Type("int", "number"))
			return nil
		}
		if n <= 0 {
			is.Add(key, valid.TooSmall("number", 0, false))
			return nil
		}
		if max > 0 && n > max {
			is.Add(key, valid.TooBig("number", max, true))
			return nil
		}
		i := int(n)
		return &i
	}
	out.Page = read("page", 0)
	out.PageSize = read("pageSize", pagination.MaxPageSize)
	return out
}

// Param is a path id as an object id, 422 "Invalid <label>." otherwise.
func Param(raw, label string) (bson.ObjectID, error) { return httpx.OID(raw, label) }
