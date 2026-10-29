// Package pagination is lib/pagination.ts: page/pageSize defaults applied in
// one place, and the `pagination` block every list returns.
package pagination

import "math"

const (
	DefaultPageSize = 20
	MaxPageSize     = 100
)

// Query is PaginationQuery; nil means "not given".
type Query struct {
	Page, PageSize *int
}

type Range struct {
	Limit, Page, PageSize, Skip int
}

// RangeOf is paginationRange: pageSize clamped to 1..100, page at least 1.
func RangeOf(q Query) Range {
	size := DefaultPageSize
	if q.PageSize != nil {
		size = *q.PageSize
	}
	size = min(max(size, 1), MaxPageSize)
	page := 1
	if q.Page != nil {
		page = max(*q.Page, 1)
	}
	return Range{Limit: size, Page: page, PageSize: size, Skip: (page - 1) * size}
}

// Meta is PaginationMeta, in paginationMeta's key order.
type Meta struct {
	HasMore    bool `json:"hasMore"`
	Page       int  `json:"page"`
	PageSize   int  `json:"pageSize"`
	Total      int  `json:"total"`
	TotalPages int  `json:"totalPages"`
}

func MetaOf(q Query, total int) Meta {
	r := RangeOf(q)
	pages := 0
	if total > 0 {
		pages = int(math.Ceil(float64(total) / float64(r.PageSize)))
	}
	return Meta{HasMore: r.Page*r.PageSize < total, Page: r.Page, PageSize: r.PageSize, Total: total, TotalPages: pages}
}
