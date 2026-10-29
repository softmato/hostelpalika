package config

import (
	"strings"
	"testing"
	"time"
)

const secret32 = "0123456789abcdef0123456789abcdef"

func env(overrides map[string]string) func(string) (string, bool) {
	base := map[string]string{
		"APP_URL":            "http://localhost:3000/",
		"MONGODB_URI":        "mongodb://localhost:27017/hostelpalika",
		"JWT_ACCESS_SECRET":  secret32,
		"JWT_REFRESH_SECRET": secret32,
	}
	for k, v := range overrides {
		if v == "<unset>" {
			delete(base, k)
		} else {
			base[k] = v
		}
	}
	return func(k string) (string, bool) { v, ok := base[k]; return v, ok }
}

func TestParseDefaults(t *testing.T) {
	c, warnings, err := Parse(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Env != "development" || c.Addr != ":8080" || c.AppURL != "http://localhost:3000" || c.LogLevel != "debug" {
		t.Errorf("basics: %+v", c)
	}
	if c.Auth.AccessTTL != 15*time.Minute || c.Auth.RefreshTTL != 30*24*time.Hour {
		t.Errorf("ttls: %v %v", c.Auth.AccessTTL, c.Auth.RefreshTTL)
	}
	if c.OTP.HashSecret != secret32 || c.Auth.ActivationCodeSecret != secret32 {
		t.Error("OTP/activation secrets should fall back to JWT_ACCESS_SECRET")
	}
	if c.Uploads.MaxVideoBytes != 50<<20 || len(c.Uploads.DocumentMIME) != 8 {
		t.Errorf("uploads: %+v", c.Uploads)
	}
	if c.Sandbox["ESEWA"].MerchantCode != "EPAYTEST" || c.Sandbox["ESEWA"].WebhookSecret != "8gBm/:&EnhH.1/q" {
		t.Errorf("esewa sandbox: %+v", c.Sandbox["ESEWA"])
	}
	if _, ok := c.Sandbox["KHALTI"]; ok {
		t.Error("khalti has no defaults and should be absent")
	}
	if c.Limits.PublicFormMax != 10 || !c.Evidence.OCR || c.Evidence.VisionTimeout != 6*time.Second {
		t.Errorf("limits/evidence: %+v %+v", c.Limits, c.Evidence)
	}
	if warnings != nil {
		t.Errorf("no warnings outside production, got %v", warnings)
	}
}

func TestParseFallbackSemantics(t *testing.T) {
	c, _, err := Parse(env(map[string]string{
		"OTP_HASH_SECRET":        "", // `??`: set-but-empty is kept
		"GOOGLE_CLIENT_ID":       "gid",
		"GOOGLE_DRIVE_CLIENT_ID": "", // `||`: empty falls through
		"CRON_SECRET":            "cron",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.OTP.HashSecret != "" {
		t.Errorf("OTP_HASH_SECRET=\"\" must stay empty (TS ??), got %q", c.OTP.HashSecret)
	}
	if c.Google.DriveClientID != "gid" || c.LLM.SearchQuotaSecret != "cron" {
		t.Errorf("|| fallbacks: %q %q", c.Google.DriveClientID, c.LLM.SearchQuotaSecret)
	}
}

func TestParseErrors(t *testing.T) {
	for name, tc := range map[string]struct {
		env  map[string]string
		want string
	}{
		"short secret":  {map[string]string{"JWT_ACCESS_SECRET": "short"}, "JWT_ACCESS_SECRET"},
		"no mongo":      {map[string]string{"MONGODB_URI": "<unset>"}, "MONGODB_URI is required"},
		"atlas in dev":  {map[string]string{"MONGODB_URI": "mongodb+srv://u:p@x.abc.mongodb.net/db"}, "points at Atlas"},
		"bad url":       {map[string]string{"APP_URL": "localhost"}, "APP_URL"},
		"bad ttl":       {map[string]string{"ACCESS_TOKEN_TTL": "15 minutes"}, "ACCESS_TOKEN_TTL"},
		"bad int":       {map[string]string{"OTP_RATE_LIMIT_MAX": "five"}, "OTP_RATE_LIMIT_MAX"},
		"bad env":       {map[string]string{"APP_ENV": "staging"}, "APP_ENV"},
		"pprof public":  {map[string]string{"PPROF_ADDR": ":6060"}, "PPROF_ADDR"},
		"pprof lan":     {map[string]string{"PPROF_ADDR": "10.0.0.5:6060"}, "PPROF_ADDR"},
		"prod required": {map[string]string{"APP_ENV": "production", "MONGODB_URI": "mongodb+srv://x.mongodb.net"}, "R2_ENDPOINT, R2_ACCESS_KEY_ID"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, _, err := Parse(env(tc.env))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
}

func TestProductionWarnings(t *testing.T) {
	c, warnings, err := Parse(env(map[string]string{
		"APP_ENV": "production", "MONGODB_URI": "mongodb+srv://x.mongodb.net",
		"R2_ENDPOINT": "e", "R2_ACCESS_KEY_ID": "a", "R2_SECRET_ACCESS_KEY": "s",
		"R2_BUCKET_PUBLIC": "pub", "R2_BUCKET_PRIVATE": "priv", "CRON_SECRET": "c", "REDIS_URL": "redis://r",
		"RESEND_API_KEY": "re",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.LogLevel != "info" || len(warnings) != 4 {
		t.Errorf("log %q, warnings %d: %v", c.LogLevel, len(warnings), warnings)
	}
}

func TestParseTTL(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"": time.Minute, "900": 15 * time.Minute, "30s": 30 * time.Second, "15m": 15 * time.Minute,
		"2h": 2 * time.Hour, "30d": 30 * 24 * time.Hour, "1.5": 1500 * time.Millisecond,
	} {
		if got, ok := parseTTL(in, time.Minute); !ok || got != want {
			t.Errorf("parseTTL(%q) = %v, %v; want %v", in, got, ok, want)
		}
	}
	if _, ok := parseTTL("1w", time.Minute); ok {
		t.Error("1w is not a TS unit")
	}
}

func TestParseDotenvLine(t *testing.T) {
	for line, want := range map[string][2]string{
		"A=1":                 {"A", "1"},
		"export B = two ":     {"B", "two"},
		`C="x # not comment"`: {"C", "x # not comment"},
		"D=val # comment":     {"D", "val"},
		"E='q'":               {"E", "q"},
	} {
		k, v, ok := parseDotenvLine(line)
		if !ok || k != want[0] || v != want[1] {
			t.Errorf("%q → %q=%q (%v)", line, k, v, ok)
		}
	}
	for _, line := range []string{"", "# c", "novalue"} {
		if _, _, ok := parseDotenvLine(line); ok {
			t.Errorf("%q should be skipped", line)
		}
	}
}
