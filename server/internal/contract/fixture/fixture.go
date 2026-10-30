// Package fixture is the contract database: a handful of accounts and hostels
// with fixed ids and known test passwords, written fresh before every
// recording (TS) and every replay (Go), so both servers answer the same state.
// It lives in its own throwaway database, never hostelpalika_dev: the live
// copy's passwords are unknown and must stay that way.
package fixture

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"golang.org/x/crypto/bcrypt"

	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

// URI is where both servers read the fixture database.
const URI = "mongodb://127.0.0.1:27018/hostelpalika_contract?directConnection=true"

// Test-only values, shared by the TS recording and the Go replay.
const (
	AccessSecret  = "contract-access-secret-0123456789abcdef"
	RefreshSecret = "contract-refresh-secret-0123456789abcdef"
	OTPSecret     = "contract-otp-secret"
	GoogleClient  = "contract-google-client.apps.googleusercontent.com"
	Password      = "Contract-pass-1"
	PIN           = "1234"
)

func oid(n string) bson.ObjectID {
	id, _ := bson.ObjectIDFromHex("6c00000000000000000000" + n)
	return id
}

// Fixed ids, readable in case files.
var (
	HostelKyc       = oid("a1")
	HostelSuspended = oid("a2")

	UserPublic     = oid("01")
	UserUnverified = oid("02")
	UserInvited    = oid("03")
	UserInactive   = oid("04")
	UserAdmin      = oid("05")
	UserWarden     = oid("06")
	UserResident   = oid("07")
	UserStranded   = oid("08")
	UserCook       = oid("09")
	UserMustChange = oid("0a")
	UserDeleting   = oid("0b")
	UserDesk       = oid("0c")
	UserProvider   = oid("0d")
)

// Reset drops the database and writes the fixture. Hashes are cost 4: bcrypt
// reads the cost from the hash, so both servers verify them, just fast.
func Reset(ctx context.Context, db *mongo.Database) error {
	if err := db.Drop(ctx); err != nil {
		return err
	}
	hash := func(s string) string {
		h, _ := bcrypt.GenerateFromPassword([]byte(s), 4)
		return string(h)
	}
	pw, pin := hash(Password), hash(PIN)
	now := time.Now().UTC().Truncate(time.Millisecond)
	day := 24 * time.Hour

	user := func(id bson.ObjectID, email, role, status string, verified bool, hostels []bson.ObjectID, extra ...bson.E) bson.D {
		d := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: "Contract " + strings.Split(email, "@")[0]}, {Key: "email", Value: email},
			{Key: "image", Value: nil}, {Key: "emailVerified", Value: verified}}
		if verified {
			d = append(d, bson.E{Key: "emailVerifiedAt", Value: now.Add(-day)})
		}
		d = append(d, bson.E{Key: "passwordHash", Value: pw}, bson.E{Key: "authProvider", Value: "LOCAL"}, bson.E{Key: "role", Value: role},
			bson.E{Key: "mustChangePassword", Value: false}, bson.E{Key: "lockPinSetAt", Value: nil}, bson.E{Key: "lockPinFailures", Value: 0},
			bson.E{Key: "tokenVersion", Value: 0}, bson.E{Key: "hostelIds", Value: hostels}, bson.E{Key: "status", Value: status},
			bson.E{Key: "isDemoData", Value: false}, bson.E{Key: "isDeleted", Value: false},
			bson.E{Key: "createdAt", Value: now.Add(-day)}, bson.E{Key: "updatedAt", Value: now.Add(-day)}, bson.E{Key: "__v", Value: 0})
		for _, e := range extra { // overrides
			replaced := false
			for i := range d {
				if d[i].Key == e.Key {
					d[i].Value, replaced = e.Value, true
				}
			}
			if !replaced {
				d = append(d, e)
			}
		}
		return d
	}
	none := []bson.ObjectID{}
	inserts := map[string][]any{
		"hostels": {
			bson.D{{Key: "_id", Value: HostelKyc}, {Key: "name", Value: "Contract Hostel"}, {Key: "slug", Value: "contract-hostel"},
				{Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "kyc", Value: bson.D{{Key: "required", Value: true}, {Key: "status", Value: "DRAFT"}, {Key: "trialEndsAt", Value: now.Add(10 * day)}}},
				{Key: "suspension", Value: bson.D{{Key: "graceEndsAt", Value: nil}, {Key: "reason", Value: nil}, {Key: "startedAt", Value: nil}}}},
			bson.D{{Key: "_id", Value: HostelSuspended}, {Key: "name", Value: "Suspended Hostel"}, {Key: "slug", Value: "suspended-hostel"},
				{Key: "parentHostelId", Value: nil}, {Key: "isDeleted", Value: false},
				{Key: "suspension", Value: bson.D{{Key: "graceEndsAt", Value: now.Add(-day)}, {Key: "reason", Value: "PLAN_PAYMENT"}, {Key: "startedAt", Value: now.Add(-5 * day)}}}},
		},
		"hostelsubscriptions": {bson.D{{Key: "_id", Value: oid("b1")}, {Key: "hostelId", Value: HostelKyc}, {Key: "trialDays", Value: 3}, {Key: "trialEndsAt", Value: now.Add(10 * day)}}},
		"hostelsettings":      {bson.D{{Key: "_id", Value: oid("b2")}, {Key: "hostelId", Value: HostelKyc}, {Key: "cookFingerprintLock", Value: true}}},
		"users": {
			user(UserPublic, "public@contract.test", "PUBLIC", "ACTIVE", true, none),
			user(UserUnverified, "unverified@contract.test", "PUBLIC", "ACTIVE", false, none),
			user(UserInvited, "invited@contract.test", "WARDEN", "INVITED", true, []bson.ObjectID{HostelKyc}),
			user(UserInactive, "inactive@contract.test", "PUBLIC", "SUSPENDED", true, none),
			user(UserAdmin, "admin@contract.test", "HOSTEL_ADMIN", "ACTIVE", true, []bson.ObjectID{HostelKyc},
				bson.E{Key: "lockPinSetAt", Value: now.Add(-day)}, bson.E{Key: "lockPinHash", Value: pin}),
			user(UserWarden, "warden@contract.test", "WARDEN", "ACTIVE", true, []bson.ObjectID{HostelSuspended}),
			user(UserResident, "resident@contract.test", "RESIDENT", "ACTIVE", true, []bson.ObjectID{HostelKyc}),
			user(UserStranded, "stranded@contract.test", "RESIDENT", "ACTIVE", true, []bson.ObjectID{HostelKyc}),
			user(UserCook, "kitchen@cook.local", "COOK", "ACTIVE", true, []bson.ObjectID{HostelKyc}),
			user(UserMustChange, "mustchange@contract.test", "PUBLIC", "ACTIVE", true, none, bson.E{Key: "mustChangePassword", Value: true}),
			user(UserDeleting, "deleting@contract.test", "PUBLIC", "SUSPENDED", true, none),
			user(UserDesk, "desk@contract.test", "PUBLIC", "ACTIVE", true, none),
			user(UserProvider, "provider@contract.test", "PUBLIC", "ACTIVE", true, none),
		},
		"residents": {
			bson.D{{Key: "_id", Value: oid("c1")}, {Key: "hostelId", Value: HostelKyc}, {Key: "userId", Value: UserResident}, {Key: "firstName", Value: "Res"},
				{Key: "lastName", Value: "Ident"}, {Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now.Add(-day)}},
			bson.D{{Key: "_id", Value: oid("c2")}, {Key: "hostelId", Value: HostelKyc}, {Key: "email", Value: "desk@contract.test"}, {Key: "firstName", Value: "Desk"},
				{Key: "lastName", Value: "Intake"}, {Key: "phone", Value: "9800000000"}, {Key: "deskIntake", Value: true}, {Key: "accountLinkDeclinedAt", Value: nil},
				{Key: "status", Value: "ACTIVE"}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now.Add(-day)}},
		},
		"serviceproviders": {providerRow(oid("d1"), UserProvider, "Contract Provider", "9801000099", "OTHER", []string{"OTHER"}, "Baneshwor", "APPROVED", now)},
		"temporarycredentials": {
			bson.D{{Key: "_id", Value: oid("e1")}, {Key: "userId", Value: UserPublic}, {Key: "username", Value: "contract-temp"}, {Key: "passwordHash", Value: pw},
				{Key: "label", Value: "contract"}, {Key: "expiresAt", Value: now.Add(day)}, {Key: "revokedAt", Value: nil}, {Key: "useCount", Value: 0}},
			bson.D{{Key: "_id", Value: oid("e2")}, {Key: "userId", Value: UserPublic}, {Key: "username", Value: "contract-gone"}, {Key: "passwordHash", Value: pw},
				{Key: "label", Value: "revoked"}, {Key: "expiresAt", Value: now.Add(day)}, {Key: "revokedAt", Value: now.Add(-time.Hour)}, {Key: "useCount", Value: 0}},
		},
		"accountdeletionrequests": {bson.D{{Key: "_id", Value: oid("f1")}, {Key: "userId", Value: UserDeleting}, {Key: "kind", Value: "SELF_SERVICE"},
			{Key: "reason", Value: "contract"}, {Key: "requestedAt", Value: now.Add(-day)}, {Key: "requestedEmail", Value: "deleting@contract.test"},
			{Key: "requestedRole", Value: "PUBLIC"}, {Key: "hostelIds", Value: none}, {Key: "cancelled", Value: false}, {Key: "executed", Value: false},
			{Key: "scheduledDeletionAt", Value: now.Add(59 * day)}}},
	}
	for coll, docs := range publicDocs(now) {
		inserts[coll] = append(inserts[coll], docs...)
	}
	for coll, docs := range providerDocs(now) {
		inserts[coll] = append(inserts[coll], docs...)
	}
	for coll, docs := range joinDocs(now) {
		inserts[coll] = append(inserts[coll], docs...)
	}
	for coll, docs := range inserts {
		if _, err := db.Collection(coll).InsertMany(ctx, docs); err != nil {
			return err
		}
	}
	// The indexes a recorded answer depends on: unique email (duplicate → 409).
	_, err := db.Collection("users").Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "email", Value: 1}}})
	return err
}

// Mint turns a {{…}} spec into a token signed with the contract secrets:
//
//	access:<userHex>:<role>[:<hostelHex>,…][:lockPin]   an access token (session "contract")
//	purpose:<purpose>:<userHex>[:<tokenVersion>]        a purpose token
//	now · today:<±days> · preference:<email> · claim:<assetId> · bsperiod:<±months>             a timestamp, a date, an email-preferences token
//
// Unknown specs come back unchanged, so captured values can share the syntax.
func Mint(spec string) (string, bool) {
	tokens := auth.NewTokens(AccessSecret, RefreshSecret, 15*time.Minute, 30*24*time.Hour)
	parts := strings.Split(spec, ":")
	switch {
	case spec == "now": // an ISO timestamp for bodies the server windows by its clock
		return time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), true
	case parts[0] == "today" && len(parts) == 2: // today+N days as YYYY-MM-DD (N may be negative)
		n, _ := strconv.Atoi(parts[1])
		return time.Now().UTC().AddDate(0, 0, n).Format("2006-01-02"), true
	case parts[0] == "bsperiod" && len(parts) == 2: // the BS month key N months from now
		n, _ := strconv.Atoi(parts[1])
		cur, err := bs.PeriodOf(time.Now())
		if err != nil {
			return spec, false
		}
		out, err := bs.AddMonths(cur, n)
		return out, err == nil
	case parts[0] == "claim" && len(parts) == 2: // a registration-document claim token for an asset id
		mac := hmac.New(sha256.New, []byte(AccessSecret))
		mac.Write([]byte("registration-document:" + parts[1]))
		return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), true
	case parts[0] == "preference" && len(parts) == 2: // an email-preferences token for an address
		addr := strings.ToLower(strings.TrimSpace(parts[1]))
		mac := hmac.New(sha256.New, []byte(AccessSecret))
		mac.Write([]byte("email-preferences:" + addr))
		return base64.RawURLEncoding.EncodeToString([]byte(addr)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), true
	case parts[0] == "access" && len(parts) >= 3:
		in := auth.TokenInput{UserID: parts[1], Role: parts[2], HostelIDs: []string{}, SessionID: "6c00000000000000000000ff"}
		for _, p := range parts[3:] {
			if p == "lockPin" {
				in.LockPin = true
			} else if p != "" {
				in.HostelIDs = strings.Split(p, ",")
			}
		}
		t, err := tokens.SignAccess(in)
		return t, err == nil
	case parts[0] == "purpose" && len(parts) >= 3:
		in := auth.PurposeInput{UserID: parts[2], Purpose: auth.Purpose(parts[1]), TTL: time.Hour}
		if len(parts) > 3 {
			v := 0
			for _, ch := range parts[3] {
				v = v*10 + int(ch-'0')
			}
			in.TokenVersion = &v
		}
		t, err := tokens.SignPurpose(in)
		return t, err == nil
	}
	return spec, false
}
