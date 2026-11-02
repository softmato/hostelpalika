package hostelresidents

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/qr"
)

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// plainCode is generatePlainCode: eight upper-case letters and digits.
func plainCode() string {
	code := ""
	for len(code) < 8 {
		raw := make([]byte, 6)
		_, _ = rand.Read(raw)
		code += nonAlnum.ReplaceAllString(base64.RawURLEncoding.EncodeToString(raw), "")
	}
	return strings.ToUpper(code[:8])
}

func (s *Service) activationURL(code string) string {
	return s.AppURL("/resident-activation?code=" + url.QueryEscape(code))
}

// ActivationIn is activationCodeGenerateSchema.
type ActivationIn struct {
	ExpiresInHours int
	SendEmail      bool
}

// qrImage is renderActivationQr: the QR as a public image, or "" when it cannot be stored.
func (s *Service) qrImage(ctx context.Context, code string) string {
	png, err := qr.PNG(s.activationURL(code), qr.Options{Width: 400, Margin: 1, SetMargin: true})
	if err != nil || s.R2 == nil {
		return ""
	}
	bucket, err := s.R2.PublicBucket()
	if err != nil {
		return ""
	}
	key := s.R2.GenerateFileKey("activation-qr", "activation-"+code+".png")
	if err := s.R2.Put(ctx, bucket, key, png, "image/png", ""); err != nil {
		slog.WarnContext(ctx, "activation_qr_render_failed", "error", err)
		return ""
	}
	u, err := s.R2.PublicURL(key)
	if err != nil {
		return ""
	}
	return u
}

// GenerateActivation is generateActivationCode (and regenerateActivationCode,
// which is the same call): a fresh code, the old pending ones cancelled.
func (s *Service) GenerateActivation(ctx context.Context, id, hostelID string, in ActivationIn, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	hours := in.ExpiresInHours
	if hours == 0 {
		hours = s.Config.OperationsTyped(ctx).QrActivationExpiryDays * 24
	}
	code := plainCode()
	expires := now().Add(time.Duration(hours) * time.Hour)
	at := now()
	if _, err := s.DB.Collection("qractivations").UpdateMany(ctx, bson.D{{Key: "residentId", Value: r.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "CANCELLED"}}}}); err != nil {
		return nil, err
	}
	by := bsonUser(p)
	actID := bson.NewObjectID()
	if _, err := s.DB.Collection("qractivations").InsertOne(ctx, bson.D{{Key: "_id", Value: actID}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID},
		{Key: "codeHash", Value: auth.HashToken(code + ":" + s.ActivationSecret)}, {Key: "expiresAt", Value: expires}, {Key: "deviceInfo", Value: bson.D{}}, {Key: "sessionInfo", Value: bson.D{}},
		{Key: "createdBy", Value: by}, {Key: "status", Value: "PENDING"}, {Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	if err := s.Audit.Write(ctx, audit.Entry{ActorID: by, HostelID: r.HostelID, Action: "RESIDENT_ACTIVATION_CODE_GENERATED", EntityType: "QRActivation", EntityID: actID.Hex(),
		Metadata: bson.D{{Key: "residentId", Value: r.ID.Hex()}}}); err != nil {
		return nil, err
	}
	delivery := ordered.Map{{Key: "reason", Value: "email_suppressed"}, {Key: "sent", Value: false}}
	if in.SendEmail {
		delivery = s.sendActivation(ctx, r, code, expires)
	}
	act := ordered.Map{{Key: "code", Value: code}, {Key: "createdAt", Value: httpx.ISO(at)}, {Key: "createdBy", Value: by.Hex()}, {Key: "expiresAt", Value: httpx.ISO(expires)},
		{Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "id", Value: actID.Hex()}, {Key: "residentId", Value: r.ID.Hex()}, {Key: "status", Value: "PENDING"}}
	return ordered.Map{{Key: "activation", Value: act}, {Key: "delivery", Value: delivery}, {Key: "resident", Value: r.summary(r.Status)}}, nil
}

// sendActivation is deliverActivationEmail: a failure is a delivery note, not an error.
func (s *Service) sendActivation(ctx context.Context, r *Resident, code string, expires time.Time) ordered.Map {
	c := residents.ResolveContact(ctx, s.DB, r.Email, r.FirstName, r.LastName, r.UserID)
	if c == nil {
		return ordered.Map{{Key: "reason", Value: "no_resident_email"}, {Key: "sent", Value: false}}
	}
	mail := email.ResidentQRActivation(s.activationURL(code), code, expires, s.hostelName(ctx, r.HostelID), s.qrImage(ctx, code), c.Name)
	res := s.Mail.Send(ctx, email.Message{Category: mail.Category, To: []string{c.Email}, Subject: mail.Subject, HTML: mail.HTML})
	if res.Sent {
		return ordered.Map{{Key: "sent", Value: true}, {Key: "to", Value: c.Email}}
	}
	return ordered.Map{{Key: "sent", Value: false}, {Key: "to", Value: c.Email}, {Key: "reason", Value: "delivery_failed"}}
}
