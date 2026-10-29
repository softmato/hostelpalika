// Package authz is lib/api-auth.ts and what it leans on: roles, the principal
// a request carries, the 14 guards, warden capabilities, tenant scoping, and
// the hostel gates (suspension, KYC) every guard applies.
package authz

import (
	"slices"
	"strings"
	"time"
)

// Role is packages/shared/src/types/roles.ts.
type Role string

const (
	Superadmin        Role = "SUPERADMIN"
	PlatformModerator Role = "PLATFORM_MODERATOR"
	PlatformAgent     Role = "PLATFORM_AGENT"
	HostelAdmin       Role = "HOSTEL_ADMIN"
	Warden            Role = "WARDEN"
	Cook              Role = "COOK"
	Resident          Role = "RESIDENT"
	Guardian          Role = "GUARDIAN"
	Public            Role = "PUBLIC"
)

var allRoles = []Role{Superadmin, PlatformModerator, PlatformAgent, HostelAdmin, Warden, Cook, Resident, Guardian, Public}

// lib/permissions.ts.
var (
	HostelStaffRoles = []Role{HostelAdmin, Warden}
	PlatformRoles    = []Role{Superadmin, PlatformModerator}
	// Agents and the superadmins who invite them; never the moderator.
	TeamRoles = []Role{PlatformAgent, Superadmin}
	// Every role whose portal is the hostel's (hostel-suspension.ts).
	SuspendableRoles = []Role{HostelAdmin, Warden, Resident, Guardian, Cook}
)

func IsRole(s string) bool { return slices.Contains(allRoles, Role(s)) }

// Capability is a WardenPermissionKey.
type Capability string

// grantingKeys is grantingPermissionKeys: the retired verifyPayments flag still
// grants view/approve/cash, never reverse, fee schedule or payment profile.
func grantingKeys(c Capability) []string {
	switch c {
	case "approvePayments", "recordCash", "viewPayments":
		return []string{string(c), "verifyPayments"}
	}
	return []string{string(c)}
}

func under(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

func underAny(path string, prefixes []string) bool {
	return slices.ContainsFunc(prefixes, func(p string) bool { return under(path, p) })
}

func isRead(method string) bool {
	return method == "GET" || method == "HEAD" || method == "OPTIONS"
}

// --- hostel-suspension.ts ---------------------------------------------------

const HostelSuspendedMessage = "This hostel's plan has not been paid, so its portal is suspended until it is."

type Suspension struct {
	StartedAt   *time.Time `bson:"startedAt"`
	GraceEndsAt *time.Time `bson:"graceEndsAt"`
}

// Stage is suspensionStage: "" (none, or a start still in the future),
// PRE_SUSPENSION, or SUSPENDED.
func (s *Suspension) Stage(now time.Time) string {
	if s == nil || s.StartedAt == nil || s.GraceEndsAt == nil || now.Before(*s.StartedAt) {
		return ""
	}
	if now.Before(*s.GraceEndsAt) {
		return "PRE_SUSPENSION"
	}
	return "SUSPENDED"
}

// Paying is the way out, so plan billing (and the upload carrying the proof) stays open.
var openWhileSuspended = []string{
	"/api/v1/files",
	"/api/v1/hostel-admin/billing",
	"/api/v1/hostel-admin/leave",
	"/api/v1/hostel-admin/subscription",
}

func IsOpenWhileSuspended(path string) bool { return underAny(path, openWhileSuspended) }

// --- hostel-kyc-lock.ts -----------------------------------------------------

const (
	KycRequiredMessage   = "Please complete your hostel KYC. This opens once our team has approved it."
	TrialEndedKycMessage = "Your free trial has ended. Please complete your KYC — once our team approves it, you can get your plan."
)

var kycFrozen = []string{
	"/api/v1/hostel-admin/attendance",
	"/api/v1/hostel-admin/bookings",
	"/api/v1/hostel-admin/branches",
	"/api/v1/hostel-admin/cook-portal",
	"/api/v1/hostel-admin/cooks",
	"/api/v1/hostel-admin/expenses",
	"/api/v1/hostel-admin/finance",
	"/api/v1/hostel-admin/hostel-referrals",
	"/api/v1/hostel-admin/khata",
	"/api/v1/hostel-admin/move-events",
	"/api/v1/hostel-admin/night-status",
	"/api/v1/hostel-admin/notice-pushes",
	"/api/v1/hostel-admin/notifications",
	"/api/v1/hostel-admin/payments",
	"/api/v1/hostel-admin/referrals",
	"/api/v1/hostel-admin/resident-lookup",
	"/api/v1/hostel-admin/resident-scan",
	"/api/v1/hostel-admin/residents",
	"/api/v1/hostel-admin/stock",
	"/api/v1/hostel-admin/wardens",
	"/api/v1/users/resident-identity",
}

// Inside a frozen prefix, but part of the KYC itself.
var kycOwn = []string{
	"/api/v1/hostel-admin/finance/fee-schedules",
	"/api/v1/hostel-admin/finance/money-rules",
	"/api/v1/hostel-admin/finance/payment-gateways",
	"/api/v1/hostel-admin/finance/payment-profile",
}

var openAfterTrial = []string{
	"/api/v1/hostel-admin/billing",
	"/api/v1/hostel-admin/finance/fee-schedules",
	"/api/v1/hostel-admin/finance/money-rules",
	"/api/v1/hostel-admin/finance/payment-gateways",
	"/api/v1/hostel-admin/finance/payment-profile",
	"/api/v1/hostel-admin/food",
	"/api/v1/hostel-admin/kyc",
	"/api/v1/hostel-admin/leave",
	"/api/v1/hostel-admin/payout-account",
	"/api/v1/hostel-admin/profile",
	"/api/v1/hostel-admin/room-types",
	"/api/v1/hostel-admin/rooms",
	"/api/v1/hostel-admin/settings",
	"/api/v1/hostel-admin/subscription",
}

func IsKycFrozenRequest(method, path string) bool {
	return !isRead(method) && !underAny(path, kycOwn) && underAny(path, kycFrozen)
}

func IsBlockedAfterTrial(method, path string) bool {
	return !isRead(method) && under(path, "/api/v1/hostel-admin") && !underAny(path, openAfterTrial)
}

type Kyc struct {
	Required    bool       `bson:"required"`
	Status      *string    `bson:"status"`
	TrialEndsAt *time.Time `bson:"trialEndsAt"`
}

// Locked until approved — only ever true for a quick sign-up.
func (k *Kyc) Locked() bool {
	return k != nil && k.Required && (k.Status == nil || *k.Status != "APPROVED")
}

func (k *Kyc) TrialOverWithoutKyc(now time.Time) bool {
	return k.Locked() && k.TrialEndsAt != nil && now.After(*k.TrialEndsAt)
}

// LandingPath is landingPathForRole ?? "/" — the only part of
// lib/route-access.ts the server reads (login redirectPath, user invites);
// the rest is the web edge's page routing.
func LandingPath(r Role) string {
	switch r {
	case Superadmin, PlatformModerator:
		return "/platform/dashboard"
	case PlatformAgent:
		return "/team"
	case HostelAdmin, Warden:
		return "/hostel-admin/dashboard"
	case Cook:
		return "/cook"
	case Resident:
		return "/resident/dashboard"
	case Guardian:
		return "/guardian/dashboard"
	}
	return "/"
}
