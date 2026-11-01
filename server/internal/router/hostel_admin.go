package router

import (
	"github.com/gin-gonic/gin"

	authmod "github.com/softmato/hostelpalika/server/internal/modules/auth"
	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelreferrals"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/modules/safety"
	"github.com/softmato/hostelpalika/server/internal/modules/users"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/llm"
	"github.com/softmato/hostelpalika/server/internal/platform/push"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

// shared is what mountAPI has already built, handed to the /hostel-admin groups.
type shared struct {
	Cfg      *config.Config
	D        Deps
	BG       *background.Runner
	Tokens   *auth.Tokens
	Cookies  *auth.Cookies
	Guards   *authz.Guards
	Limiter  *ratelimit.Limiter
	Mail     *email.Sender
	Audit    *audit.Log
	RT       *realtime.Client
	Push     *push.Sender
	Notify   *notifications.Service
	Cache    *cache.Cache
	R2       *storage.R2
	Config   *platformconfig.Service
	Claims   files.Claims
	Personal *crypto.Personal
	Refs     *hostelreferrals.Service
	Bookings *bookings.Service
	Safety   *safety.Service
	Issuer   *users.Issuer
	Auth     *authmod.Service
	Evidence *finance.Reader
	LLM      *llm.Router
	AppURL   func(path string) string
	Outbound string
}

func mountHostelAdmin(v1 *gin.RouterGroup, s *shared) {
	mountAdminResidents(v1, s)
	mountAdminOps(v1, s)
	mountAdminStock(v1, s)
	mountAdminSetup(v1, s)
	mountAdminFinance(v1, s)
}
