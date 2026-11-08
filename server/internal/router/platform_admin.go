package router

import (
	"context"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/campaigns"
	"github.com/softmato/hostelpalika/server/internal/modules/community"
	"github.com/softmato/hostelpalika/server/internal/modules/feedback"
	"github.com/softmato/hostelpalika/server/internal/modules/financeadmin"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelleave"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelreferrals"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelresidents"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/kitchen"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/listingflags"
	"github.com/softmato/hostelpalika/server/internal/modules/noticepushes"
	"github.com/softmato/hostelpalika/server/internal/modules/offerprogram"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/platformdesk"
	"github.com/softmato/hostelpalika/server/internal/modules/questioncall"
	"github.com/softmato/hostelpalika/server/internal/modules/reports"
	"github.com/softmato/hostelpalika/server/internal/modules/reviews"
	"github.com/softmato/hostelpalika/server/internal/modules/serviceproviders"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/maps"
)

// mountPlatform is the platform's own desks: the field team's registration and
// the superadmin portal's hostel, money and config routes.
func mountPlatform(v1 *gin.RouterGroup, s *shared, settler *billing.Settler) {
	siteURL := strings.TrimRight(s.Cfg.AppURL, "/")
	mapsClient := maps.NewClient(s.Cfg.Google.MapsAPIKey, s.Cfg.AppURL)
	reg := &hostels.Registration{Refs: s.Refs, DB: s.D.DB, Guards: s.Guards, Limiter: s.Limiter, Claims: s.Claims, Mail: s.Mail, Notify: s.Notify, Audit: s.Audit, RT: s.RT, Cache: s.Cache,
		Outbound: s.Outbound, FinanceKey: s.Cfg.Crypto.FinanceMasterKey, FinancePrev: s.Cfg.Crypto.FinanceMasterKeyPrev, PersonalKey: s.Cfg.Crypto.PersonalDataKey, ShortStayLimits: shortStayLimits(s)}
	rateCards := &financeadmin.Handler{DB: s.D.DB, Audit: s.Audit, Cache: s.Cache, RT: s.RT, Branches: &hostels.Admin{DB: s.D.DB}}
	(&hostels.TeamRegistration{Registration: reg, Settler: settler, Issuer: s.Issuer, Config: s.Config, Maps: mapsClient, SeedRateCard: rateCards.SeedOpeningRateCard}).Register(v1)

	flags := &listingflags.Handler{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Now: time.Now}
	flags.Register(v1)
	kitchenAdmin := &kitchen.Admin{Handler: &kitchen.Handler{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache, Notify: s.Notify, Push: s.Push, Audit: s.Audit, Config: s.Config, RT: s.RT, Issuer: s.Issuer},
		Mail: s.Mail, AppURL: s.AppURL}
	idCards := &hostelresidents.Service{DB: s.D.DB, Notify: s.Notify, Audit: s.Audit, Mail: s.Mail, Personal: s.Personal, R2: s.R2, AppURL: s.AppURL, SiteURL: siteURL, Config: s.Config}
	platform := &hostels.Platform{Admin: &hostels.Admin{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Mail: s.Mail, Notify: s.Notify, RT: s.RT, R2: s.R2, Maps: mapsClient, Cache: s.Cache,
		Billing: settler.Service, Outbound: s.Outbound, Config: s.Config, Claims: s.Claims}, Settler: settler, Issuer: s.Issuer, SiteURL: siteURL,
		ProvisionCook: kitchenAdmin.ProvisionCook, SendIDCard: idCards.SendIDCard, SeedRateCard: rateCards.SeedOpeningRateCard, DuplicateCheck: flags.DuplicateCheck, Now: time.Now}
	platform.Register(v1)
	s.J.Hostels = platform
	feedback.NewHandler(s.D.DB, s.Guards, s.Limiter).RegisterPlatform(v1)
	(&reviews.Moderation{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, RT: s.RT, Cache: s.Cache}).Register(v1)
	communityAdmin := &community.Handler{DB: s.D.DB, Guards: s.Guards, Notify: s.Notify, RT: s.RT, Bump: s.Cache, BG: s.BG, LLM: s.LLM}
	communityAdmin.RegisterPlatform(v1, s.Audit)
	communityAdmin.RegisterSponsors(v1, s.Audit)
	configAdmin := &platformconfig.Admin{Config: s.Config, DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Mail: s.Mail, SiteURL: siteURL, Now: time.Now, Cache: s.Cache}
	configAdmin.Register(v1)
	(&platformdesk.Handler{DB: s.D.DB, Guards: s.Guards, R2: s.R2, Now: time.Now}).Register(v1)
	leaveOwner := &hostelleave.Owner{Handler: &hostelleave.Handler{DB: s.D.DB, Guards: s.Guards, R2: s.R2, BG: s.BG, Mail: s.Mail, Audit: s.Audit, AppURL: s.AppURL, Public: s.Cache}, Notify: s.Notify, RT: s.RT, Cache: s.Cache}
	(&hostelleave.Review{Owner: leaveOwner, Archive: platform.Archive}).Register(v1)
	(&hostelreferrals.Platform{Service: s.Refs, Guards: s.Guards, Audit: s.Audit, AppURL: s.AppURL}).Register(v1)
	(&serviceproviders.Platform{Handler: &serviceproviders.Handler{DB: s.D.DB, Guards: s.Guards, Mail: s.Mail, Notify: s.Notify, Audit: s.Audit, RT: s.RT, Cache: s.Cache},
		Config: s.Config, AppURL: s.AppURL, SendIDCard: idCards.SendIDCard}).Register(v1)
	engine := &ledger.Engine{DB: s.D.DB, Audit: s.Audit, Notify: s.Notify, Mail: s.Mail, Config: s.Config, Bump: s.Cache, AppURL: s.AppURL}
	(&offerprogram.Admin{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Notify: s.Notify, Mail: s.Mail, AppURL: s.AppURL, ApplyFeeOffs: engine.ApplyPendingFeeOffs}).Register(v1)
	(&campaigns.Service{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Push: s.Push, RT: s.RT, Bump: s.Cache}).RegisterPlatform(v1)
	s.J.PlatformPushes = &noticepushes.Platform{DB: s.D.DB, Guard: s.Guards, Audit: s.Audit, Push: s.Push}
	s.J.PlatformPushes.Register(v1)
	(&reports.Admin{DB: s.D.DB, Guards: s.Guards, Cache: s.Cache}).RegisterPlatform(v1)
	(&questioncall.Analytics{DB: s.D.DB, Guards: s.Guards}).Register(v1)
	(&billing.Platform{Settler: settler, Guards: s.Guards, Audit: s.Audit}).Register(v1)
	(&users.Admins{DB: s.D.DB, Guards: s.Guards, Audit: s.Audit, Mail: s.Mail, AppURL: s.AppURL, Now: time.Now}).Register(v1)
	financeKeys := func() ([]crypto.MasterKey, error) {
		return crypto.MasterKeys(s.Cfg.Crypto.FinanceMasterKey, s.Cfg.Crypto.FinanceMasterKeyPrev)
	}
	bookingDesk := &bookings.Signed{Service: s.Bookings, Guards: s.Guards, Limiter: s.Limiter, Notify: s.Notify, Mail: s.Mail, Audit: s.Audit, RT: s.RT, Bump: s.Cache, Outbound: s.Outbound,
		FinanceKeys: financeKeys, SoftmatoOn: s.Cfg.Softmato.BaseURL != "" && s.Cfg.Softmato.Secret != "" && s.Cfg.Softmato.WebhookSecret != ""}
	(&bookings.Platform{Signed: bookingDesk, Settings: configAdmin, Payouts: &hostels.Admin{DB: s.D.DB, Audit: s.Audit, Mail: s.Mail, Notify: s.Notify, Outbound: s.Outbound,
		FinanceKey: s.Cfg.Crypto.FinanceMasterKey, FinancePrev: s.Cfg.Crypto.FinanceMasterKeyPrev}}).Register(v1)
	settler.GrantOwnerAccess = func(ctx context.Context, hostelID bson.ObjectID, actorID string) error {
		return platform.GrantOwnerAccess(ctx, hostelID, actorID)
	}
}

func shortStayLimits(s *shared) func(context.Context) (float64, float64) {
	return func(ctx context.Context) (float64, float64) {
		c := s.Bookings.BookingConfig(ctx)
		return c.ShortStayMinMarkupPercent, c.ShortStayMaxNights
	}
}
