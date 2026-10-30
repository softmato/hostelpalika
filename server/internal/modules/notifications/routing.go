package notifications

import (
	"context"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
)

// Hooks are the rules push.Sender asks of this module: who wants the push
// (preferences, quiet hours) and where a tap goes (push-routing.ts, web-routing.ts).
func Hooks(db *mongo.Database) push.Hooks {
	return push.Hooks{
		Filter: func(ctx context.Context, userIDs []string, category string, urgent bool) []string {
			return FilterRecipients(ctx, db, userIDs, category, urgent, time.Now())
		},
		DeepLink: func(p push.Payload) string { return DeepLink(p.ActionURL, p.Category, p.Data) },
		WebLink:  func(p push.Payload, role string) string { return WebLink(p.ActionURL, p.Category, p.Data, role) },
	}
}

/* ── preferences + quiet hours (notification-quiet-hours.ts, -preference.service.ts) ── */

type preference struct {
	UserID            bson.ObjectID `bson:"userId"`
	MutedCategories   []string      `bson:"mutedCategories"`
	PushEnabled       *bool         `bson:"pushEnabled"`
	QuietHoursEnabled bool          `bson:"quietHoursEnabled"`
	QuietHoursEnd     *int          `bson:"quietHoursEnd"`
	QuietHoursStart   *int          `bson:"quietHoursStart"`
	TimeZone          string        `bson:"timeZone"`
}

// localMinutesNow is wall-clock minutes past midnight in an IANA zone; an
// unknown zone answers in UTC rather than breaking the batch.
func localMinutesNow(zone string, now time.Time) int {
	loc, err := time.LoadLocation(zone)
	if err != nil {
		loc = time.UTC
	}
	t := now.In(loc)
	return (t.Hour()*60 + t.Minute()) % 1440
}

// withinQuietHours is [start, end), wrapping midnight when start > end;
// start == end is no quiet hours at all.
func withinQuietHours(minutes, start, end int) bool {
	if start == end {
		return false
	}
	if start < end {
		return minutes >= start && minutes < end
	}
	return minutes >= start || minutes < end
}

// shouldPush: urgent always goes through; no preference means yes.
func shouldPush(p *preference, category string, urgent bool, now time.Time) bool {
	if urgent || p == nil {
		return true
	}
	if p.PushEnabled != nil && !*p.PushEnabled {
		return false
	}
	if category != "" {
		for _, c := range p.MutedCategories {
			if c == category {
				return false
			}
		}
	}
	if p.QuietHoursEnabled {
		zone := p.TimeZone
		if zone == "" {
			zone = "Asia/Kathmandu"
		}
		start, end := 22*60, 7*60
		if p.QuietHoursStart != nil {
			start = *p.QuietHoursStart
		}
		if p.QuietHoursEnd != nil {
			end = *p.QuietHoursEnd
		}
		if withinQuietHours(localMinutesNow(zone, now), start, end) {
			return false
		}
	}
	return true
}

// FilterRecipients narrows a push audience to the accounts that want it, in one
// query. A lookup failure keeps everyone: over-delivering during a database
// blip is recoverable, silence is not.
func FilterRecipients(ctx context.Context, db *mongo.Database, userIDs []string, category string, urgent bool, now time.Time) []string {
	if len(userIDs) == 0 || urgent {
		return userIDs
	}
	ids := make(bson.A, 0, len(userIDs))
	for _, id := range userIDs {
		if oid, ok := objectID(id); ok {
			ids = append(ids, oid)
		}
	}
	cur, err := db.Collection("notificationpreferences").Find(ctx, bson.D{{Key: "userId", Value: bson.D{{Key: "$in", Value: ids}}}})
	var rows []preference
	if err == nil {
		err = cur.All(ctx, &rows)
	}
	if err != nil || len(rows) == 0 {
		return userIDs
	}
	byUser := map[string]*preference{}
	for i := range rows {
		byUser[rows[i].UserID.Hex()] = &rows[i]
	}
	out := make([]string, 0, len(userIDs))
	for _, id := range userIDs {
		if shouldPush(byUser[id], category, urgent, now) {
			out = append(out, id)
		}
	}
	return out
}

/* ── where a tap goes (push-routing.ts) ── */

var appCategoryPaths = map[string]string{
	"ACCOUNT": "/(resident)/more/profile", "ACCOUNT_DELETION": "/(resident)/more/settings", "ANNOUNCEMENT": "/(resident)/notices",
	"ATTENDANCE": "/(resident)/more/attendance", "COMMUNITY": "/community", "COMPLAINT": "/(resident)/more/complaints",
	"ELECTRICIAN": "/(provider)", "FOOD": "/(resident)/food", "GENERAL": "/notifications", "GUARDIAN": "/guardians",
	"HOSTEL_APPROVAL": "/notifications", "INQUIRY": "/(admin)", "MAINTENANCE": "/(provider)", "NIGHT_STATUS": "/night-status",
	"NOTICE": "/(resident)/notices", "PAYMENT": "/(resident)/payments", "PLUMBER": "/(provider)", "RESIDENT": "/(admin)/residents",
	"REVIEW": "/(resident)/more/reviews", "ROOM": "/(resident)/more/profile", "SERVICE_PROVIDER": "/(provider)", "SOS": "/(admin)/alerts",
	"URGENT": "/notifications",
}

const (
	fallbackPath     = "/notifications"
	planBillingPath  = "/manage/billing"
	PlanDueType      = "PLAN_DUE"
	JoinRequestType  = "JOIN_REQUEST"
	AdmissionFormTyp = "ADMISSION_FORM"
)

func readID(data map[string]any, key string) string {
	if s, ok := data[key].(string); ok {
		return s
	}
	return ""
}

func str(data map[string]any, key string) string { s, _ := data[key].(string); return s }

func isPlanDue(category string, data map[string]any) bool {
	return category == "PAYMENT" && str(data, "type") == PlanDueType
}

// localPath is a single leading slash only: `//evil.example` is
// protocol-relative and would resolve to another origin.
func localPath(s string) bool { return strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") }

// DeepLink is deepLinkForNotification: the app path a tapped push opens.
func DeepLink(actionURL, category string, data map[string]any) string {
	switch t := str(data, "type"); {
	case t == "SHARED_RECEIPT_SAVED":
		return "/expenses"
	case isPlanDue(category, data):
		return planBillingPath
	case t == JoinRequestType:
		return "/manage/join-requests"
	case t == AdmissionFormTyp:
		return "/manage/applications"
	case t == "HOSTEL_KYC":
		return "/manage/kyc"
	case t == "HOSTEL_TRIAL":
		return planBillingPath
	case t == "HOSTEL_PORTAL_OPEN" || t == "HOSTEL_KYC_APPROVED":
		return "/(admin)"
	case t == "ROOM_CHANGE_REQUEST":
		return "/manage/floors"
	case t == "ROOM_CHANGE_ANSWERED":
		return "/my-room"
	}
	if category == "BOOKING" {
		bookingID := readID(data, "bookingId")
		switch {
		case str(data, "audience") == "HOSTEL":
			return "/manage/bookings"
		case str(data, "audience") == "GUEST" && bookingID != "":
			return "/booking/" + bookingID
		}
		return fallbackPath
	}
	if category != "STORE_ORDER" && localPath(actionURL) {
		return actionURL
	}
	pathFor := func(base, key, prefix string) string {
		if id := readID(data, key); id != "" {
			return prefix + id
		}
		return base
	}
	switch category {
	case "PAYMENT":
		return pathFor(appCategoryPaths["PAYMENT"], "invoiceId", "/(resident)/payments/")
	case "COMPLAINT":
		return pathFor(appCategoryPaths["COMPLAINT"], "complaintId", "/(resident)/more/complaints/")
	case "NOTICE", "ANNOUNCEMENT":
		return pathFor(appCategoryPaths["NOTICE"], "noticeId", "/(resident)/notices/")
	case "FOOD":
		switch str(data, "audience") {
		case "STAFF":
			return "/(admin)/today"
		case "COOK":
			return "/(cook)"
		}
		return appCategoryPaths["FOOD"]
	case "COMMUNITY":
		return pathFor(appCategoryPaths["COMMUNITY"], "postId", "/community/")
	case "GUARDIAN":
		if str(data, "audience") == "GUARDIAN" {
			return "/(guardian)"
		}
		return "/guardians"
	case "STORE_ORDER":
		return pathFor("/(store)/orders", "orderId", "/store/order/")
	}
	if p, ok := appCategoryPaths[category]; ok {
		return p
	}
	return fallbackPath
}

/* ── where a browser click goes (web-routing.ts) ── */

var webList = map[string]string{
	string(authz.Superadmin): "/platform/inbox", string(authz.PlatformModerator): "/platform/inbox",
	string(authz.HostelAdmin): "/hostel-admin/inbox", string(authz.Warden): "/hostel-admin/inbox",
	string(authz.Cook): "/", string(authz.Resident): "/resident/notifications",
	string(authz.Guardian): "/guardian/notifications", string(authz.Public): "/community",
}

var webAdmin = map[string]string{
	"ACCOUNT": "/hostel-admin/dashboard", "ANNOUNCEMENT": "/hostel-admin/notices", "ATTENDANCE": "/hostel-admin/attendance",
	"BOOKING": "/hostel-admin/bookings", "COMMUNITY": "/community", "COMPLAINT": "/hostel-admin/complaints",
	"ELECTRICIAN": "/hostel-admin/maintenance", "FOOD": "/hostel-admin/food", "INQUIRY": "/hostel-admin/inquiries",
	"MAINTENANCE": "/hostel-admin/maintenance", "NIGHT_STATUS": "/hostel-admin/night-status", "NOTICE": "/hostel-admin/notices",
	"PAYMENT": "/hostel-admin/payments", "PLUMBER": "/hostel-admin/maintenance", "RESIDENT": "/hostel-admin/residents",
	"REVIEW": "/hostel-admin/reports", "ROOM": "/hostel-admin/rooms", "SERVICE_PROVIDER": "/hostel-admin/service-providers",
	"SOS": "/hostel-admin/sos-alerts",
}

var webPlatform = map[string]string{
	"ACCOUNT_DELETION": "/platform/account-deletions", "ANNOUNCEMENT": "/platform/inbox", "BOOKING": "/platform/bookings",
	"COMMUNITY": "/community", "COMPLAINT": "/platform/complaints", "HOSTEL_APPROVAL": "/platform/hostels",
	"INQUIRY": "/platform/inbox", "PAYMENT": "/platform/transactions", "REVIEW": "/platform/reviews",
	"SERVICE_PROVIDER": "/platform/service-providers", "STORE_ORDER": "/platform/store",
}

var webByRole = map[string]map[string]string{
	string(authz.Superadmin): webPlatform, string(authz.PlatformModerator): webPlatform,
	string(authz.HostelAdmin): webAdmin, string(authz.Warden): webAdmin,
	string(authz.Resident): {
		"ACCOUNT": "/resident/profile", "ACCOUNT_DELETION": "/resident/settings", "ANNOUNCEMENT": "/resident/notices",
		"ATTENDANCE": "/resident/attendance", "BOOKING": "/resident/bookings", "COMMUNITY": "/community",
		"COMPLAINT": "/resident/complaints", "ELECTRICIAN": "/resident/complaints", "FOOD": "/resident/food",
		"GUARDIAN": "/resident/guardians", "MAINTENANCE": "/resident/complaints", "NIGHT_STATUS": "/resident/night-status",
		"NOTICE": "/resident/notices", "PAYMENT": "/resident/payments", "PLUMBER": "/resident/complaints",
		"REVIEW": "/resident/reviews", "ROOM": "/resident/profile", "SOS": "/resident/sos",
	},
	string(authz.Guardian): {
		"ANNOUNCEMENT": "/guardian/notices", "ATTENDANCE": "/guardian/safety", "FOOD": "/guardian/food",
		"GUARDIAN": "/guardian/dashboard", "NIGHT_STATUS": "/guardian/safety", "NOTICE": "/guardian/notices",
		"PAYMENT": "/guardian/dashboard", "SOS": "/guardian/safety",
	},
	string(authz.Cook): {},
	string(authz.Public): {
		"BOOKING": "/bookings", "COMMUNITY": "/community", "ELECTRICIAN": "/jobs", "MAINTENANCE": "/jobs",
		"PLUMBER": "/jobs", "SERVICE_PROVIDER": "/service-providers",
	},
}

// WebLink is webLinkForNotification: a URL the recipient's portal can open.
func WebLink(actionURL, category string, data map[string]any, role string) string {
	if role == "" {
		role = string(authz.Public)
	}
	table := webByRole[role]
	list, ok := webList[role]
	if !ok {
		list = "/community"
	}
	if isPlanDue(category, data) && role == string(authz.HostelAdmin) {
		if slug := readID(data, "hostelSlug"); slug != "" {
			return "/" + httpx.EncodeURIComponent(slug) + "/admin/billing"
		}
		return "/hostel-admin/billing"
	}
	if category != "STORE_ORDER" && localPath(actionURL) {
		return actionURL
	}
	switch category {
	case "PAYMENT":
		if id := readID(data, "invoiceId"); id != "" && role == string(authz.Resident) {
			return "/resident/payments/" + id
		}
	case "COMPLAINT":
		if id := readID(data, "complaintId"); id != "" && role == string(authz.Resident) {
			return "/resident/complaints/" + id
		}
	case "NOTICE", "ANNOUNCEMENT":
		if id := readID(data, "noticeId"); id != "" && role == string(authz.Resident) {
			return "/resident/notices/" + id
		}
	case "COMMUNITY":
		if id := readID(data, "postId"); id != "" {
			return "/community/" + id
		}
		return "/community"
	case "FOOD":
		if str(data, "audience") == "STAFF" {
			return "/hostel-admin/food"
		}
	}
	if p, ok := table[category]; ok {
		return p
	}
	return list
}
