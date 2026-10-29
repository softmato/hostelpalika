package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/modules/users"
	platauth "github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Handler is the 20 route files under app/api/v1/auth.
type Handler struct {
	svc     *Service
	guards  *authz.Guards
	cookies *platauth.Cookies
	limiter *ratelimit.Limiter
}

func NewHandler(svc *Service, guards *authz.Guards, cookies *platauth.Cookies, limiter *ratelimit.Limiter) *Handler {
	return &Handler{svc, guards, cookies, limiter}
}

// Register mounts the routes on /api/v1.
func (h *Handler) Register(v1 *gin.RouterGroup) {
	a := v1.Group("/auth")
	a.POST("/biometric/code", h.biometricCode)
	a.POST("/biometric/verify", h.biometricVerify)
	a.POST("/cancel-account-deletion", h.cancelAccountDeletion)
	a.POST("/change-password", h.changePassword)
	a.POST("/forgot-password", h.forgotPassword)
	a.POST("/google", h.google)
	a.PUT("/lock-pin", h.setLockPin)
	a.DELETE("/lock-pin", h.removeLockPin)
	a.POST("/lock-pin/touch", h.touchLockPin)
	a.POST("/lock-pin/verify", h.verifyLockPin)
	a.POST("/login", h.login)
	a.POST("/logout", h.logout)
	a.GET("/me", httpx.ETag(), h.me)
	a.POST("/otp/request", h.otpRequest)
	a.POST("/otp/verify", h.otpVerify)
	a.POST("/refresh", h.refresh)
	a.POST("/register", h.register)
	a.POST("/resend-verification", h.resendVerification)
	a.POST("/reset-password", h.resetPassword)
	a.POST("/signup", h.signup)
	a.POST("/verify-email", h.verifyEmail)
}

func rc(c *gin.Context) reqCtx { return reqCtx{IP: c.ClientIP(), UserAgent: c.GetHeader("User-Agent")} }

// isMobile is isMobileAuthClient: the app and PWA keep their own tokens.
func isMobile(c *gin.Context) bool {
	return strings.ToLower(c.GetHeader("x-hostelhub-client")) == "mobile"
}

// bearer is getBearerToken: present when the header starts "Bearer ", even if empty after.
func bearer(c *gin.Context) (string, bool) {
	rest, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
	return strings.TrimSpace(rest), ok
}

func body(c *gin.Context) (any, bool) {
	v, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return nil, false
	}
	return v, true
}

const fifteenMin = 15 * time.Minute

type signedIn struct {
	AccessToken  string  `json:"accessToken"`
	RefreshToken *string `json:"refreshToken,omitempty"`
	User         any     `json:"user"`
}

// session answers a sign-in: the app gets both tokens in the body, a browser
// gets the access token in the body and the pair as cookies.
func (h *Handler) session(c *gin.Context, status int, msg string, r *Issued) {
	out := signedIn{AccessToken: r.AccessToken, User: r.User}
	if isMobile(c) {
		out.RefreshToken = &r.RefreshToken
	} else {
		h.cookies.ApplySession(c.Writer.Header(), r.AccessToken, r.RefreshToken)
	}
	httpx.Write(c, status, out, msg)
}

func (h *Handler) login(c *gin.Context) {
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseLogin(b)
	if err == nil {
		err = h.svc.refuseIfTooManyFailures(c, "auth-login", in.Identifier)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := h.svc.Login(c, in.Identifier, in.Password, rc(c))
	if err != nil {
		if isCode(err, "INVALID_CREDENTIALS") {
			h.svc.recordFailedAttempt(c, "auth-login", in.Identifier)
		}
		httpx.Fail(c, err)
		return
	}
	h.session(c, http.StatusOK, "Login successful", r)
}

func isCode(err error, code string) bool {
	var e *httpx.Error
	return errors.As(err, &e) && e.ErrorCode == code
}

func (h *Handler) register(c *gin.Context) {
	if err := h.limiter.AuthAttempts(c, "auth-register"); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseRegister(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := h.svc.Register(c, in.Email, in.Name, in.OTPChallengeID, in.Password, rc(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.session(c, http.StatusCreated, "Registration successful", r)
}

func (h *Handler) google(c *gin.Context) {
	if err := h.limiter.Check(c, "auth-google", 10, fifteenMin); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	token, err := parseGoogle(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := h.svc.Google(c, token, rc(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.session(c, http.StatusOK, "Google sign-in successful", r)
}

// readBodyRefreshToken: a malformed or absent body is simply no token.
func readBodyRefreshToken(c *gin.Context) string {
	raw, _ := io.ReadAll(c.Request.Body)
	var b struct {
		RefreshToken any `json:"refreshToken"`
	}
	if json.Unmarshal(raw, &b) != nil {
		return ""
	}
	s, _ := b.RefreshToken.(string)
	return strings.TrimSpace(s)
}

func (h *Handler) refresh(c *gin.Context) {
	// The PWA uses the mobile contract on the website's origin: never let a
	// stray website cookie replace its explicit session.
	cookieToken := ""
	if !isMobile(c) {
		cookieToken = platauth.RefreshCookieValue(c.Request)
	}
	bodyToken := ""
	if cookieToken == "" {
		bodyToken = readBodyRefreshToken(c)
	}
	token := cookieToken
	if token == "" {
		token = bodyToken
	}
	if token == "" {
		httpx.Fail(c, fail(http.StatusUnauthorized, "UNAUTHENTICATED", "Refresh token is missing."))
		return
	}
	r, err := h.svc.Refresh(c, token, cookieToken != "")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := signedIn{AccessToken: r.AccessToken, User: r.User}
	if isMobile(c) {
		out.RefreshToken = &r.RefreshToken
	}
	if cookieToken != "" {
		h.cookies.ApplySession(c.Writer.Header(), r.AccessToken, r.RefreshToken)
	} else if platauth.RefreshCookieValue(c.Request) == bodyToken {
		// Retire the duplicate cookie older app logins created.
		h.cookies.ClearSession(c.Writer.Header())
	}
	httpx.Write(c, http.StatusOK, out, "Token refreshed")
}

func (h *Handler) logout(c *gin.Context) {
	mobile := isMobile(c)
	token := ""
	if !mobile {
		token = platauth.RefreshCookieValue(c.Request)
	}
	if token == "" {
		token = readBodyRefreshToken(c)
	}
	if token != "" {
		if err := h.svc.Logout(c, token); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if !mobile {
		h.cookies.ClearSession(c.Writer.Header())
	}
	httpx.Write(c, http.StatusOK, nil, "Logged out")
}

func (h *Handler) me(c *gin.Context) {
	token, isBearer := bearer(c)
	if !isBearer {
		token = platauth.AccessCookieValue(c.Request)
	}
	if token == "" {
		httpx.Fail(c, fail(http.StatusUnauthorized, "UNAUTHENTICATED", "Access token is missing."))
		return
	}
	u, claims, err := h.svc.Me(c, token)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// A browser that still owes the PIN; the app (bearer) draws its own lock.
	u.PinLocked = !isBearer && u.HasLockPin && !u.ViaTemporaryCredential && !h.cookies.PinUnlocked(c.Request, u.ID, claims.SessionID)
	httpx.Write(c, http.StatusOK, gin.H{"user": u}, "Authenticated user loaded")
}

func (h *Handler) otpRequest(c *gin.Context) {
	// Each request sends an email: this is the spend limit.
	if err := h.limiter.AuthAttempts(c, "auth-otp-request"); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseOTPRequest(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.OTPRequest(c, in.Channel, in.Identifier, in.Purpose, rc(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "OTP challenge created")
}

func (h *Handler) otpVerify(c *gin.Context) {
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseOTPVerify(b)
	if err == nil {
		err = h.svc.refuseIfTooManyFailures(c, "auth-otp-verify", in.ChallengeID)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.OTPVerify(c, in.ChallengeID, in.Code)
	if err != nil {
		if isCode(err, "OTP_INCORRECT") {
			h.svc.recordFailedAttempt(c, "auth-otp-verify", in.ChallengeID)
		}
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "OTP verified")
}

// primary is requireApiPrincipal + assertPrimaryCredentialPrincipal.
func (h *Handler) primary(c *gin.Context) (*authz.Principal, bool) {
	p, err := h.guards.Require(c)
	if err == nil {
		err = authz.AssertPrimaryCredential(p)
	}
	if err != nil {
		httpx.Fail(c, err)
		return nil, false
	}
	return p, true
}

func (h *Handler) biometricCode(c *gin.Context) {
	p, ok := h.primary(c)
	if !ok {
		return
	}
	out, err := h.svc.BiometricCode(c, p.UserID, rc(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "Code sent")
}

func (h *Handler) biometricVerify(c *gin.Context) {
	p, ok := h.primary(c)
	if !ok {
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseOTPVerify(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.BiometricVerify(c, p.UserID, in.ChallengeID, in.Code)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "Code accepted")
}

func (h *Handler) setLockPin(c *gin.Context) {
	p, ok := h.primary(c)
	if !ok {
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	pin, proof, err := parseSetPin(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.SetLockPin(c, p.UserID, pin, proof)
	if err == nil {
		// Whoever just set it has proved themselves: unlock this browser.
		err = h.cookies.ApplyPinUnlock(c.Writer.Header(), p.UserID, p.SessionID)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "PIN saved")
}

func (h *Handler) removeLockPin(c *gin.Context) {
	p, ok := h.primary(c)
	if !ok {
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	proof, err := parsePinProof(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.RemoveLockPin(c, p.UserID, proof)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "App lock is off")
}

func (h *Handler) verifyLockPin(c *gin.Context) {
	p, err := h.guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	pin, err := parseVerifyPin(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.VerifyLockPin(c, p.UserID, pin)
	if err == nil {
		err = h.cookies.ApplyPinUnlock(c.Writer.Header(), p.UserID, p.SessionID)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "Unlocked")
}

// touchLockPin slides a live unlock another UnlockIdle; a lapsed one is not revived.
func (h *Handler) touchLockPin(c *gin.Context) {
	p, err := h.guards.Load(c)
	switch {
	case err != nil:
	case p == nil:
		err = fail(http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication is required.")
	case p.PinLocked:
		err = fail(http.StatusLocked, "LOCK_PIN_REQUIRED", "Enter your PIN to continue.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, cerr := c.Request.Cookie(platauth.UnlockCookie); cerr == nil {
		if err := h.cookies.ApplyPinUnlock(c.Writer.Header(), p.UserID, p.SessionID); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	httpx.Write(c, http.StatusOK, gin.H{"idleSeconds": int(platauth.UnlockIdle.Seconds())}, "Still here")
}

func (h *Handler) changePassword(c *gin.Context) {
	token, isBearer := bearer(c)
	if !isBearer {
		token = platauth.AccessCookieValue(c.Request)
	}
	if token == "" {
		httpx.Fail(c, fail(http.StatusUnauthorized, "UNAUTHENTICATED", "Access token is missing."))
		return
	}
	claims, err := h.svc.tokens.VerifyAccess(token)
	if err != nil || claims.Subject == "" {
		httpx.Fail(c, fail(http.StatusUnauthorized, "UNAUTHENTICATED", "Access token is invalid."))
		return
	}
	// A borrowed login must not lock the owner out (this revokes every session).
	if claims.TemporaryCredentialID != "" {
		httpx.Fail(c, fail(http.StatusForbidden, "TEMPORARY_CREDENTIAL_FORBIDDEN", "A temporary login cannot change the account password."))
		return
	}
	if err := h.svc.refuseIfTooManyFailures(c, "auth-change-password", claims.Subject); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseChange(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := h.svc.ChangePassword(c, claims.Subject, in.Current, in.NewPassword, rc(c))
	if err != nil {
		if isCode(err, "INVALID_CREDENTIALS") {
			h.svc.recordFailedAttempt(c, "auth-change-password", claims.Subject)
		}
		httpx.Fail(c, err)
		return
	}
	h.session(c, http.StatusOK, "Password changed", r)
}

func (h *Handler) forgotPassword(c *gin.Context) {
	if err := h.limiter.Check(c, "auth-forgot-password", 5, fifteenMin); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.emailForm(c, h.svc.ForgotPassword, "A reset link has been sent.")
}

func (h *Handler) resendVerification(c *gin.Context) {
	if err := h.limiter.Check(c, "auth-resend-verification", 5, fifteenMin); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.emailForm(c, h.svc.ResendVerification, "If that email needs verification, a new link has been sent.")
}

func (h *Handler) emailForm(c *gin.Context, run func(context.Context, string) (map[string]any, error), msg string) {
	b, ok := body(c)
	if !ok {
		return
	}
	addr, err := parseEmailOnly(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := run(c, addr)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, msg)
}

func (h *Handler) signup(c *gin.Context) {
	if err := h.limiter.Check(c, "auth-signup", 10, fifteenMin); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseSignup(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Signup(c, in.Email, in.Name, in.Password)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, "Account created. Check your inbox for the verification link.")
}

func (h *Handler) verifyEmail(c *gin.Context) {
	if err := h.limiter.AuthAttempts(c, "auth-verify-email"); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	token, err := parseToken(b, "Verification token is required.")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.VerifyEmail(c, token)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "Email verified. You can now log in.")
}

func (h *Handler) resetPassword(c *gin.Context) {
	if err := h.limiter.AuthAttempts(c, "auth-reset-password"); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	in, err := parseReset(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.ResetPassword(c, in.Token, in.NewPassword)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "Password reset. You can now log in.")
}

func (h *Handler) cancelAccountDeletion(c *gin.Context) {
	if err := h.limiter.Check(c, "auth-cancel-account-deletion", 10, fifteenMin); err != nil {
		httpx.Fail(c, err)
		return
	}
	b, ok := body(c)
	if !ok {
		return
	}
	token, err := parseCancelDeletion(b)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := users.CancelByToken(c, h.svc.db, h.svc.tokens, h.svc.email, h.svc.cfg.OutboundURL(), token, h.svc.now())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusOK, out, "Account deletion cancelled")
}

func slogWarn(c *gin.Context, action string, err error, namespace string) {
	slog.WarnContext(c, err.Error(), "action", action, "namespace", namespace)
}
