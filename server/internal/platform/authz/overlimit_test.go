package authz

import "testing"

func TestIsBlockedWhileOverLimit(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		blocked      bool
	}{
		{"POST", "/api/v1/hostel-admin/residents", true},
		{"PATCH", "/api/v1/hostel-admin/notices/abc", true},
		{"GET", "/api/v1/hostel-admin/residents", false},
		{"POST", "/api/v1/hostel-admin/residents/abc/move-out", false},
		{"PATCH", "/api/v1/hostel-admin/residents/abc/status", false},
		{"DELETE", "/api/v1/hostel-admin/wardens/abc", false},
		{"DELETE", "/api/v1/hostel-admin/cooks/abc", false},
		{"PATCH", "/api/v1/hostel-admin/wardens/abc", true},
		{"POST", "/api/v1/hostel-admin/billing/checkout", false},
		{"POST", "/api/v1/hostel-admin/kyc", false},
	} {
		if got := IsBlockedWhileOverLimit(tc.method, tc.path); got != tc.blocked {
			t.Errorf("%s %s: got %v, want %v", tc.method, tc.path, got, tc.blocked)
		}
	}
}
