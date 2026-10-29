package auth

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// The zod schemas of auth.validation.ts and shared/schemas/auth.schema.ts,
// field by field in declaration order with zod v4's messages. In zod v4 an
// invalid_type or enum failure aborts the object, so its .refine/.superRefine
// runs only when none occurred; format/length failures do not abort.

type form struct {
	m       map[string]any
	is      valid.Issues
	aborted bool
}

func parse(body any) *form {
	f := &form{}
	f.m = valid.Object(body, &f.is)
	f.aborted = f.m == nil
	return f
}

func (f *form) err() error { return f.is.Err() }

// jsLen is String#length: UTF-16 code units, which zod's min/max count.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// str reads a string field; ok=false when absent-and-optional or refused.
func (f *form) str(key string, optional bool) (string, bool) {
	if f.m == nil {
		return "", false
	}
	before := len(f.is)
	s, ok := valid.String(f.m, key, optional, &f.is)
	if len(f.is) > before {
		f.aborted = true // invalid_type
	}
	return s, ok
}

func (f *form) add(key, msg string) { f.is.Add(key, msg) }

func (f *form) min(key, s string, n int, msg string) {
	if jsLen(s) < n {
		if msg == "" {
			msg = valid.TooSmall("string", float64(n), true)
		}
		f.add(key, msg)
	}
}

func (f *form) max(key, s string, n int, msg string) {
	if jsLen(s) > n {
		if msg == "" {
			msg = valid.TooBig("string", float64(n), true)
		}
		f.add(key, msg)
	}
}

func (f *form) match(key, s string, re *regexp.Regexp, msg string) {
	if !re.MatchString(s) {
		f.add(key, msg)
	}
}

func (f *form) email(key, s, msg string) {
	if !email.ValidEmail(s) {
		if msg == "" {
			msg = valid.Format("email")
		}
		f.add(key, msg)
	}
}

var (
	objectIDRe     = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)
	otpCodeRe      = regexp.MustCompile(`^\d{6}$`)
	pinRe          = regexp.MustCompile(`^\d{4}$`)
	tempUsernameRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)
)

const (
	msgObjectID  = "Expected a MongoDB ObjectId."
	msgEmail     = "Expected a valid email address."
	msgPasswordL = "Password must be at least 8 characters."
	msgPasswordH = "Password must be at most 128 characters."
	msgName      = "Name is required."
	msgPin       = "Enter 4 digits."
)

func (f *form) objectID(key string, optional bool) (string, bool) {
	s, ok := f.str(key, optional)
	if ok {
		f.match(key, s, objectIDRe, msgObjectID)
	}
	return s, ok
}

// emailField is emailSchema: trim, toLowerCase, email.
func (f *form) emailField(key string) string {
	s, ok := f.str(key, false)
	if !ok {
		return ""
	}
	s = strings.ToLower(strings.TrimSpace(s))
	f.email(key, s, msgEmail)
	return s
}

// passwordField is passwordSchema: min 8, max 128.
func (f *form) passwordField(key string) string {
	s, ok := f.str(key, false)
	if ok {
		f.min(key, s, 8, msgPasswordL)
		f.max(key, s, 128, msgPasswordH)
	}
	return s
}

func (f *form) nameField() string {
	s, ok := f.str("name", false)
	if ok {
		s = strings.TrimSpace(s)
		f.min("name", s, 2, msgName)
		f.max("name", s, 120, "")
	}
	return s
}

// temporaryCredentialUsernameSchema.safeParse(value).success
func validTempUsername(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	n := jsLen(s)
	return n >= 4 && n <= 32 && tempUsernameRe.MatchString(s)
}

type loginIn struct{ Identifier, Password string }

func parseLogin(body any) (loginIn, error) {
	f := parse(body)
	var in loginIn
	if id, ok := f.str("identifier", false); ok {
		in.Identifier = strings.TrimSpace(id)
		good := validTempUsername(in.Identifier)
		if strings.Contains(in.Identifier, "@") {
			good = email.ValidEmail(in.Identifier)
		}
		if !good {
			f.add("identifier", "Enter a valid email address or temporary access username.")
		}
	}
	if p, ok := f.str("password", false); ok {
		in.Password = p
		f.min("password", p, 1, "Password is required.")
	}
	return in, f.err()
}

type otpRequestIn struct{ Channel, Identifier, Purpose string }

func parseOTPRequest(body any) (otpRequestIn, error) {
	f := parse(body)
	var in otpRequestIn
	if f.m != nil {
		ch, present := f.m["channel"]
		if s, _ := ch.(string); s != "email" || !present {
			f.add("channel", valid.OneOf("email"))
			f.aborted = true
		} else {
			in.Channel = s
		}
	}
	identOK := false
	if s, ok := f.str("identifier", false); ok {
		in.Identifier = strings.TrimSpace(s)
		identOK = true
		f.email("identifier", in.Identifier, msgEmail)
	}
	if f.m != nil {
		in.Purpose = "registration"
		if p, present := f.m["purpose"]; present {
			if s, _ := p.(string); s != "registration" {
				f.add("purpose", valid.OneOf("registration"))
				f.aborted = true
			}
		}
	}
	// superRefine: a second, identical issue when the address is not an email.
	if !f.aborted && identOK && !email.ValidEmail(in.Identifier) {
		f.add("identifier", msgEmail)
	}
	return in, f.err()
}

type otpVerifyIn struct{ ChallengeID, Code string }

func parseOTPVerify(body any) (otpVerifyIn, error) {
	f := parse(body)
	var in otpVerifyIn
	in.ChallengeID, _ = f.objectID("challengeId", false)
	if s, ok := f.str("code", false); ok {
		in.Code = strings.TrimSpace(s)
		f.match("code", in.Code, otpCodeRe, "Expected a 6-digit OTP code.")
	}
	return in, f.err()
}

type registerIn struct{ Email, Name, OTPChallengeID, Password string }

func parseRegister(body any) (registerIn, error) {
	f := parse(body)
	var in registerIn
	emailOK := false
	if s, ok := f.str("email", false); ok {
		in.Email = strings.TrimSpace(s)
		emailOK = true
		f.email("email", in.Email, "")
	}
	in.Name = f.nameField()
	in.OTPChallengeID, _ = f.objectID("otpChallengeId", false)
	if s, ok := f.str("password", false); ok {
		in.Password = s
		f.min("password", s, 8, msgPasswordL)
	}
	if !f.aborted && emailOK && in.Email == "" {
		f.add("email", "Email is required.")
	}
	return in, f.err()
}

func parseGoogle(body any) (string, error) {
	f := parse(body)
	s, ok := f.str("idToken", false)
	if ok {
		s = strings.TrimSpace(s)
		f.min("idToken", s, 20, "Google ID token is required.")
	}
	return s, f.err()
}

func (f *form) pinProof() pinProof {
	var p pinProof
	if s, ok := f.objectID("challengeId", true); ok {
		p.ChallengeID = &s
	}
	if s, ok := f.str("code", true); ok {
		s = strings.TrimSpace(s)
		f.match("code", s, otpCodeRe, "Expected a 6-digit code.")
		p.Code = &s
	}
	if s, ok := f.str("currentPin", true); ok {
		f.match("currentPin", s, pinRe, msgPin)
		p.CurrentPin = &s
	}
	if s, ok := f.str("password", true); ok {
		f.min("password", s, 1, "")
		f.max("password", s, 200, "")
		p.Password = &s
	}
	return p
}

func parsePinProof(body any) (pinProof, error) {
	f := parse(body)
	p := f.pinProof()
	return p, f.err()
}

func parseSetPin(body any) (string, pinProof, error) {
	f := parse(body)
	p := f.pinProof()
	pin, ok := f.str("pin", false)
	if ok {
		f.match("pin", pin, pinRe, msgPin)
	}
	return pin, p, f.err()
}

func parseVerifyPin(body any) (string, error) {
	f := parse(body)
	pin, ok := f.str("pin", false)
	if ok {
		f.match("pin", pin, pinRe, msgPin)
	}
	return pin, f.err()
}

type signupIn struct{ Email, Name, Password string }

func parseSignup(body any) (signupIn, error) {
	f := parse(body)
	in := signupIn{Email: f.emailField("email"), Name: f.nameField(), Password: f.passwordField("password")}
	return in, f.err()
}

func parseToken(body any, msg string) (string, error) {
	f := parse(body)
	s, ok := f.str("token", false)
	if ok {
		s = strings.TrimSpace(s)
		f.min("token", s, 20, msg)
	}
	return s, f.err()
}

func parseEmailOnly(body any) (string, error) {
	f := parse(body)
	return f.emailField("email"), f.err()
}

type resetIn struct{ Token, NewPassword string }

func parseReset(body any) (resetIn, error) {
	f := parse(body)
	var in resetIn
	if s, ok := f.str("token", false); ok {
		in.Token = strings.TrimSpace(s)
		f.min("token", in.Token, 20, "Reset token is required.")
	}
	in.NewPassword = f.passwordField("newPassword")
	return in, f.err()
}

type changeIn struct {
	Current     *string
	NewPassword string
}

func parseChange(body any) (changeIn, error) {
	f := parse(body)
	var in changeIn
	if s, ok := f.str("currentPassword", true); ok {
		f.min("currentPassword", s, 1, "")
		in.Current = &s
	}
	in.NewPassword = f.passwordField("newPassword")
	return in, f.err()
}

// accountDeletionCancelSchema: z.string().min(1), no trim.
func parseCancelDeletion(body any) (string, error) {
	f := parse(body)
	s, ok := f.str("token", false)
	if ok {
		f.min("token", s, 1, "")
	}
	return s, f.err()
}
