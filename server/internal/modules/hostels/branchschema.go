package hostels

import "github.com/softmato/hostelpalika/server/internal/platform/valid"

// Branch is a parsed branchRequestSchema: a new branch is its name and the short
// label the owner tells it apart by. The branch's own KYC carries the rest.
type Branch struct {
	Name  string
	Label string
}

// ParseBranch is branchRequestSchema.
func ParseBranch(body any) (Branch, error) {
	f := valid.NewForm(body)
	name, _ := f.Str("name", valid.S{Trim: true, Min: 2, Max: 160})
	label, _ := f.Str("branchLabel", valid.S{Trim: true, Min: 1, Max: 40})
	return Branch{name, label}, f.Err()
}
