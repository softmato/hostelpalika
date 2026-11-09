package router

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/jobs"
	"github.com/softmato/hostelpalika/server/internal/modules/attendance"
	"github.com/softmato/hostelpalika/server/internal/modules/backup"
	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/campaigns"
	"github.com/softmato/hostelpalika/server/internal/modules/complaints"
	"github.com/softmato/hostelpalika/server/internal/modules/financeadmin"
	"github.com/softmato/hostelpalika/server/internal/modules/gateway"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/kitchen"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/noticepushes"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformdesk"
	"github.com/softmato/hostelpalika/server/internal/modules/residentportal"
	"github.com/softmato/hostelpalika/server/internal/modules/safety"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/maps"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// jobHosts are the instances the routes were mounted on, reused by the jobs so
// both run the same wiring.
type jobHosts struct {
	Safety         *safety.Service
	Portal         *residentportal.Handler
	Kitchen        *kitchen.Handler
	Complaints     *complaints.Service
	Deletion       *users.Deletion
	Engine         *ledger.Engine
	Finance        *financeadmin.Handler
	NoticePushes   *noticepushes.Service
	Campaigns      *campaigns.Service
	Backup         *backup.Handler
	Hostels        *hostels.Platform
	PlatformPushes *noticepushes.Platform
	Gateway        *gateway.Service
	Bookings       *bookings.Signed
	Plans          *billing.Service
}

// automaticPush is AUTOMATIC_PUSHES' delivery half: each row's kind, early days and email.
var automaticPush = map[string]struct {
	kind      string
	earlyDays []int
	email     bool
}{
	"PLAN_DUE_MORNING":   {"PLAN_DUE", []int{7, 5}, true},
	"PLAN_DUE_EVENING":   {"PLAN_DUE", nil, false},
	"FEE_DUE_MORNING":    {"FEE_DUE", []int{7, 5}, false},
	"FEE_DUE_EVENING":    {"FEE_DUE", nil, false},
	"FREE_MONTH_MORNING": {"FREE_MONTH", nil, false},
}

func sum(rows []ordered.Map, key string) int {
	n := 0
	for _, r := range rows {
		v, _ := r.Get(key)
		switch x := v.(type) {
		case int:
			n += x
		case int64:
			n += int(x)
		}
	}
	return n
}

// soft is a step whose failure the TS route catches and reports in its answer.
func soft(ctx context.Context, what string, out ordered.Map, err error) any {
	if err != nil {
		slog.ErrorContext(ctx, what, "category", "jobs", "error", err.Error())
		return ordered.Map{{Key: "error", Value: what}}
	}
	return out
}

// mountJobs registers PARITY.md §5's 19 jobs, in its order, and their doors.
func mountJobs(v1 *gin.RouterGroup, s *shared) {
	j, db := s.J, s.D.DB
	j.PlatformPushes.Automatic = func(ctx context.Context, key string, now time.Time) (noticepushes.Reached, error) {
		a, ok := automaticPush[key]
		if !ok {
			return noticepushes.Reached{}, nil
		}
		var r noticepushes.Reached
		var err error
		switch a.kind {
		case "PLAN_DUE":
			r.Devices, _, r.Recipients, err = j.Plans.PlanDueReminders(ctx, s.Push, a.earlyDays, a.email, now)
		case "FREE_MONTH":
			r.Recipients, err = j.Plans.FreeMonthWelcomes(ctx, s.Notify, now)
		default:
			r.Devices, r.Recipients, err = ledger.FeeDueReminders(ctx, db, s.Push, a.earlyDays, now)
		}
		return r, err
	}
	retryHandlers := map[string]billing.TaskHandler{"BOOKING_PAYMENT": j.Bookings.RetryPayment, "REFUND_FILING": j.Bookings.RefileRefund}
	attendanceJobs := &attendance.Jobs{DB: db, Mail: s.Mail, Notify: s.Notify, AppURL: s.AppURL}
	mapsClient := maps.NewClient(s.Cfg.Google.MapsAPIKey, s.Cfg.AppURL)
	const minute = time.Minute

	billingCycle := func(period string) func(ctx context.Context) (any, error) {
		return func(ctx context.Context) (any, error) {
			now := time.Now()
			if period == "" {
				p, err := bs.PeriodOf(now)
				if err != nil {
					return nil, err
				}
				period = p
			}
			hostels, err := j.Engine.RunBillingCycleForAll(ctx, period)
			if err != nil {
				return nil, err
			}
			fines, err := j.Finance.AccrueLateFines(ctx, s.Push, now)
			if err != nil {
				return nil, err
			}
			failed := []ordered.Map{}
			for _, h := range hostels {
				if _, ok := h.Get("errorCode"); ok {
					failed = append(failed, h)
				}
			}
			total := int64(0)
			for _, h := range hostels {
				v, _ := h.Get("totalBilled")
				switch x := v.(type) {
				case int64:
					total += x
				case int:
					total += int64(x)
				}
			}
			return ordered.Map{{Key: "failedHostels", Value: failed}, {Key: "hostels", Value: hostels}, {Key: "invoicesIssued", Value: sum(hostels, "billedCount")},
				{Key: "lateFines", Value: fines}, {Key: "period", Value: period}, {Key: "totalBilled", Value: total}}, nil
		}
	}

	r := s.D.Jobs
	r.OnFailure(func(ctx context.Context, job, problem string) { alertSuperadmins(ctx, db, s.Notify, job, problem) })
	r.Add(
		&jobs.Job{Name: "platform-push", Schedule: "* * * * *", Deadline: minute, Message: "Scheduled pushes dispatched",
			Run: func(ctx context.Context) (any, error) {
				now := time.Now()
				platform, err := j.PlatformPushes.DispatchDue(ctx, now)
				if err != nil {
					return nil, err
				}
				notices, err := j.NoticePushes.Dispatch(ctx, now)
				if err != nil {
					return nil, err
				}
				swept, err := j.Bookings.Sweep(ctx, now)
				bookingsOut := soft(ctx, "Booking sweep failed.", swept, err)
				retried, err := j.Plans.RetryTasks(ctx, retryHandlers, now)
				retries := soft(ctx, "Softmato retries failed.", retried, err)
				return append(platform, ordered.Map{{Key: "bookings", Value: bookingsOut}, {Key: "noticePushes", Value: noticeTally(notices)}, {Key: "softmatoRetries", Value: retries}}...), nil
			}},
		&jobs.Job{Name: "gateway-expiry-sweep", Schedule: "*/5 * * * *", Deadline: 2 * minute, Message: "Checkout attempts swept",
			Run: func(ctx context.Context) (any, error) {
				expired, settled, unconfirmed, err := j.Gateway.ExpireStale(ctx, 100, time.Now())
				if err != nil {
					return nil, err
				}
				return ordered.Map{{Key: "expired", Value: expired}, {Key: "settled", Value: settled}, {Key: "unconfirmed", Value: unconfirmed}}, nil
			}},
		&jobs.Job{Name: "notification-dispatch", Schedule: "*/15 * * * *", Deadline: minute, Message: "Scheduled notifications dispatched",
			Run: func(ctx context.Context) (any, error) {
				now := time.Now()
				out, err := j.Campaigns.DispatchDue(ctx, now)
				if err != nil {
					return nil, err
				}
				platform, err := j.PlatformPushes.DispatchDue(ctx, now)
				if err != nil {
					return nil, err
				}
				notices, err := j.NoticePushes.Dispatch(ctx, now)
				if err != nil {
					return nil, err
				}
				return append(out, ordered.Map{{Key: "noticePushes", Value: noticeTally(notices)}, {Key: "platformPushes", Value: platform}}...), nil
			}},
		&jobs.Job{Name: "meal-call-reminders", Schedule: "*/15 * * * *", Deadline: minute, Message: "Meal call reminders processed",
			Run: func(ctx context.Context) (any, error) { return j.Kitchen.RunMealCallReminders(ctx, time.Now()) }},
		&jobs.Job{Name: "night-status-prompt", Schedule: "*/15 * * * *", Deadline: minute, Message: "Night status prompts processed",
			Run: func(ctx context.Context) (any, error) { return j.Safety.RunNightPrompts(ctx, time.Now()) }},
		&jobs.Job{Name: "push-receipts", Schedule: "0 * * * *", Deadline: minute, Message: "Push receipts checked",
			Run: func(ctx context.Context) (any, error) { return s.Push.SweepReceipts(ctx) }},
		&jobs.Job{Name: "refresh-nearby-places", Schedule: "0 * * * *", Deadline: minute, Message: "Nearby places refreshed",
			Run: func(ctx context.Context) (any, error) { return hostels.RefreshStaleNearby(ctx, db, mapsClient) }},
		&jobs.Job{Name: "customer-backup", Schedule: "5 * * * *", Deadline: 5 * minute, Heavy: true, Message: "Customer backups run",
			Run: func(ctx context.Context) (any, error) { return j.Backup.RunScheduled(ctx) }},
		&jobs.Job{Name: "billing-cycle", Schedule: "15 0 * * *", Deadline: minute, Message: "Billing cycle processed", Run: billingCycle(""),
			Prepare: func(c *gin.Context) (*jobs.Job, error) {
				job := *r.Job("billing-cycle")
				job.Run = billingCycle(c.Query("period"))
				return &job, nil
			}},
		&jobs.Job{Name: "payment-reminders", Schedule: "45 7 * * *", Deadline: minute, Message: "Payment reminders processed",
			Run: func(ctx context.Context) (any, error) {
				now := time.Now()
				renewals, err := j.Plans.RaiseDueRenewals(ctx, now)
				if err != nil {
					return nil, err
				}
				trials, err := j.Plans.TrialEndingReminders(ctx, s.Notify, now)
				if err != nil {
					return nil, err
				}
				out, err := j.Engine.RunPaymentReminders(ctx, now)
				if err != nil {
					return nil, err
				}
				digest := j.Engine.SendAdminPaymentDigest(ctx, now)
				leaving, err := j.Portal.SendLeavingReminders(ctx, now)
				if err != nil {
					slog.WarnContext(ctx, "leaving reminders failed", "category", "jobs", "error", err.Error())
					leaving = ordered.Map{{Key: "leavingReminders", Value: 0}}
				}
				return append(append(out, leaving...), ordered.Map{{Key: "digest", Value: digest}, {Key: "renewals", Value: renewals}, {Key: "trials", Value: trials}}...), nil
			}},
		&jobs.Job{Name: "purge-expired-otps", Schedule: "45 8 * * *", Deadline: minute, Message: "Expired OTP challenges purged",
			Run: func(ctx context.Context) (any, error) {
				res, err := db.Collection("otpchallenges").DeleteMany(ctx, bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$lt", Value: time.Now()}}}})
				if err != nil {
					return nil, err
				}
				return ordered.Map{{Key: "deleted", Value: res.DeletedCount}}, nil
			}},
		&jobs.Job{Name: "account-purge", Schedule: "45 8 * * *", Deadline: minute, Message: "Account deletion purge processed",
			Run: func(ctx context.Context) (any, error) { return j.Deletion.RunPurge(ctx) }},
		&jobs.Job{Name: "hostel-purge", Schedule: "45 8 * * *", Deadline: minute, Message: "Hostel archive purge processed",
			Run: func(ctx context.Context) (any, error) { return j.Hostels.RunArchivePurge(ctx, time.Now()) }},
		&jobs.Job{Name: "ledger-drift", Schedule: "45 8 * * *", Deadline: 5 * minute, Heavy: true, Message: "Ledger drift checked",
			Run: func(ctx context.Context) (any, error) {
				hostels, err := ledger.RunLedgerDrift(ctx, db, time.Now(), "CRON")
				if err != nil {
					return nil, err
				}
				return ordered.Map{{Key: "findings", Value: sum(hostels, "findings")}, {Key: "hostels", Value: hostels}, {Key: "scanned", Value: sum(hostels, "scanned")}}, nil
			}},
		&jobs.Job{Name: "complaint-sla", Schedule: "45 9 * * *", Deadline: minute, Message: "Complaint SLA check processed",
			Run: func(ctx context.Context) (any, error) { return j.Complaints.RunSLA(ctx, time.Now()) }},
		&jobs.Job{Name: "attendance-maintenance", Schedule: "45 10 * * *", Deadline: minute, Message: "Attendance maintenance processed",
			Run: func(ctx context.Context) (any, error) { return attendanceJobs.Maintenance(ctx, time.Now()) }},
		&jobs.Job{Name: "gateway-health", Schedule: "15 12 * * *", Deadline: 5 * minute, Heavy: true, Message: "Gateway health checked",
			Run: func(ctx context.Context) (any, error) {
				hostels, err := j.Gateway.RunGatewayHealth(ctx, time.Now(), "CRON")
				if err != nil {
					return nil, err
				}
				return ordered.Map{{Key: "checked", Value: sum(hostels, "checked")}, {Key: "findings", Value: sum(hostels, "findings")}, {Key: "hostels", Value: hostels},
					{Key: "notified", Value: sum(hostels, "notified")}}, nil
			}},
		&jobs.Job{Name: "gateway-settlement-recon", Schedule: "45 9 * * 1", Deadline: 5 * minute, Heavy: true, Message: "Settlements reconciled",
			Run: func(ctx context.Context) (any, error) {
				hostels, err := j.Gateway.RunSettlementRecon(ctx, time.Now(), "")
				if err != nil {
					return nil, err
				}
				return ordered.Map{{Key: "findings", Value: sum(hostels, "findings")}, {Key: "hostels", Value: hostels}, {Key: "recovered", Value: sum(hostels, "recovered")},
					{Key: "rechecked", Value: sum(hostels, "rechecked")}}, nil
			}},
		&jobs.Job{Name: "platform-backup", Deadline: minute, Message: "Backup report recorded",
			Run: func(context.Context) (any, error) { return nil, errNoReport },
			Prepare: func(c *gin.Context) (*jobs.Job, error) {
				body, err := valid.Body(c)
				if err != nil {
					return nil, err
				}
				report, err := platformdesk.ParseBackupReport(body)
				if err != nil {
					return nil, err
				}
				job := *r.Job("platform-backup")
				job.Run = func(ctx context.Context) (any, error) {
					if err := platformdesk.RecordBackupReport(ctx, db, report, time.Now()); err != nil {
						return nil, err
					}
					return ordered.Map{{Key: "recorded", Value: true}}, nil
				}
				return &job, nil
			}},
	)
	(&jobs.Doors{Runner: r, Secret: s.Cfg.CronSecret, Superadmin: func(c *gin.Context) error {
		_, err := s.Guards.RequireSuperadmin(c)
		return err
	}}).Register(v1)
}

// alertSuperadmins tells every active superadmin (bell + push) that a scheduled
// job failed, timed out or was missed: an in-process scheduler has nobody to
// switch it off, but someone must still hear when a run goes wrong.
func alertSuperadmins(ctx context.Context, db *mongo.Database, notify *notifications.Service, job, problem string) {
	cur, err := db.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "role", Value: "SUPERADMIN"}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}).SetLimit(100))
	if err != nil {
		slog.ErrorContext(ctx, "Job alert: superadmins not read", "category", "jobs", "job", job, "error", err)
		return
	}
	var staff []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &staff); err != nil {
		slog.ErrorContext(ctx, "Job alert: superadmins not read", "category", "jobs", "job", job, "error", err)
		return
	}
	for _, m := range staff {
		if _, err := notify.CreateInApp(ctx, notifications.Input{ActionURL: "/platform/system/cron?job=" + job, Body: job + " " + problem, Category: "GENERAL",
			Data: ordered.Map{{Key: "job", Value: job}}, Kind: "ACTION", Priority: "HIGH", Title: "Scheduled job needs a look", UserID: m.ID.Hex()}); err != nil {
			slog.ErrorContext(ctx, "Job alert not delivered", "category", "jobs", "job", job, "error", err)
		}
	}
}

// errNoReport: platform-backup only runs from its door, with the report it posts.
var errNoReport = httpx.NewError(http.StatusBadRequest, "VALIDATION_ERROR", "platform-backup runs only from its door, with a report.", nil)

func noticeTally(d noticepushes.DispatchResult) ordered.Map {
	return ordered.Map{{Key: "due", Value: d.Due}, {Key: "failed", Value: d.Failed}, {Key: "sent", Value: d.Sent}, {Key: "skipped", Value: d.Skipped}}
}
