package hostelrooms

import (
	"net/http"
	"regexp"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var idRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

// ResolveHostel is resolveAdminHostelId (hostel.service.ts): the requested
// hostel when the caller reaches it (404 otherwise, never 403), else their only one.
func ResolveHostel(p *authz.Principal, requested string) (bson.ObjectID, error) {
	if requested != "" {
		if err := authz.AssertHostelScoped(p, requested); err != nil {
			return bson.ObjectID{}, err
		}
		return objectID(requested)
	}
	if len(p.HostelIDs) == 1 {
		return objectID(p.HostelIDs[0])
	}
	return bson.ObjectID{}, httpx.NewError(http.StatusUnprocessableEntity, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for this hostel admin action.", nil)
}

func objectID(v string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(v)
	if err != nil {
		return id, httpx.NewError(http.StatusUnprocessableEntity, "INVALID_HOSTEL_ID", "Invalid hostel id.", nil)
	}
	return id, nil
}

// QueryHostelID reads `hostelId: z.string().regex(objectId).optional()` from
// the query ("" when absent); a bad value adds the zod issue.
func QueryHostelID(q map[string]string, is *valid.Issues) string {
	v, ok := q["hostelId"]
	if !ok {
		return ""
	}
	id, _ := valid.ObjectID(v, "hostelId", "", is, false)
	return id
}

// OptionalID reads an optional `z.string().regex(/^[a-f\d]{24}$/i, msg)` body field.
func OptionalID(f *valid.Form, key, msg string) string {
	v, ok := f.M[key]
	if !ok {
		return ""
	}
	id, _ := valid.ObjectID(v, key, msg, &f.Is, false)
	return id
}

// ReadPage is paginationQuerySchema; a bad value is a validation issue.
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

// ScopeFilter is scopedHostelFilter: the requested hostel, else every hostel
// the caller reaches. Both are ObjectIds.
func ScopeFilter(p *authz.Principal, requested string) (bson.E, error) {
	if requested != "" {
		id, err := ResolveHostel(p, requested)
		return bson.E{Key: "hostelId", Value: id}, err
	}
	ids := make(bson.A, 0, len(p.HostelIDs))
	for _, h := range p.HostelIDs {
		id, err := objectID(h)
		if err != nil {
			return bson.E{}, err
		}
		ids = append(ids, id)
	}
	return bson.E{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, nil
}
