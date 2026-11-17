package notifications

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
)

func TestFeedScope(t *testing.T) {
	const main, branch = "64b000000000000000000001", "64b000000000000000000002"
	cases := []struct {
		name, header string
		p            authz.Principal
		scoped       bool
	}{
		{"one hostel", "", authz.Principal{HostelIDs: []string{main}, AllHostelIDs: []string{main}}, false},
		{"resident", "", authz.Principal{HostelIDs: []string{main}}, false},
		{"branch picked", branch, authz.Principal{HostelIDs: []string{branch}, AllHostelIDs: []string{main, branch}}, true},
		{"main by default", "", authz.Principal{HostelIDs: []string{main}, AllHostelIDs: []string{main, branch}}, true},
		{"overall", " Overall ", authz.Principal{HostelIDs: []string{main}, AllHostelIDs: []string{main, branch}}, false},
	}
	for _, tc := range cases {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/api/v1/notifications", nil)
		c.Request.Header.Set(authz.ActiveHostelHeader, tc.header)
		got := feedScope(c, &tc.p)
		if (got != nil) != tc.scoped {
			t.Fatalf("%s: scoped = %v, want %v", tc.name, got != nil, tc.scoped)
		}
		if got != nil && got[0].Key != "$or" {
			t.Fatalf("%s: %v", tc.name, got)
		}
	}
}
