package router

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/gateway"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
)

// mountGateway is the resident's online checkout and the providers' callbacks.
func mountGateway(v1 *gin.RouterGroup, s *shared) *gateway.Service {
	client := &http.Client{Timeout: 15 * time.Second}
	svc := &gateway.Service{DB: s.D.DB, Audit: s.Audit, SiteURL: strings.TrimRight(s.Cfg.AppURL, "/"), Production: s.Cfg.IsProduction(), Sandbox: s.Cfg.Sandbox, Now: time.Now, Notify: s.Notify, Mail: s.Mail,
		Ledger: &ledger.Engine{DB: s.D.DB, Audit: s.Audit, Notify: s.Notify, Mail: s.Mail, Config: s.Config, Bump: s.Cache, AppURL: s.AppURL},
		FinanceKeys: func() ([]crypto.MasterKey, error) {
			return crypto.MasterKeys(s.Cfg.Crypto.FinanceMasterKey, s.Cfg.Crypto.FinanceMasterKeyPrev)
		},
		Providers: map[string]gateway.Provider{
			"ESEWA":  &gateway.ESewa{HTTP: client, Now: time.Now},
			"KHALTI": &gateway.Khalti{HTTP: client, Now: time.Now},
		}}
	(&gateway.Handler{Service: svc, Guards: s.Guards, Limiter: s.Limiter}).Register(v1)
	return svc
}
