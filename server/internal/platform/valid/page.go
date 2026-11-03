package valid

import "github.com/softmato/hostelpalika/server/internal/platform/pagination"

// Page is paginationQuerySchema; a bad value is a validation issue.
func Page(q map[string]string, is *Issues) pagination.Query {
	out := pagination.Query{}
	read := func(key string, max float64) *int {
		v := QueryNumber(q, key, false, is)
		if v == nil {
			return nil
		}
		n := *v
		if n != float64(int(n)) {
			is.Add(key, Type("int", "number"))
			return nil
		}
		if n <= 0 {
			is.Add(key, TooSmall("number", 0, false))
			return nil
		}
		if max > 0 && n > max {
			is.Add(key, TooBig("number", max, true))
			return nil
		}
		i := int(n)
		return &i
	}
	out.Page = read("page", 0)
	out.PageSize = read("pageSize", pagination.MaxPageSize)
	return out
}
