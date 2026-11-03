package hostelresidents

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/idcard"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/qr"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// resident-identity.service.ts: the "fill it once" profile behind the platform ID
// card, its photo and photographed signature, and the card made from an
// admission form (card-from-form.ts).

// Crockford-style: no I, L, O, U, 0 or 1, because the id is typed off a phone screen.
const idAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

func idBlock() string {
	b := make([]byte, 4)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(idAlphabet))))
		b[i] = idAlphabet[n.Int64()]
	}
	return string(b)
}

var profiles = func(s *Service) *mongo.Collection { return s.DB.Collection("userresidentprofiles") }

type identityUser struct {
	ID             bson.ObjectID `bson:"_id"`
	Email          *string       `bson:"email"`
	Name           string        `bson:"name"`
	UserResidentID *string       `bson:"userResidentId"`
}

func (u *identityUser) card() string {
	if u.UserResidentID == nil {
		return ""
	}
	return *u.UserResidentID
}

func (u *identityUser) email() string {
	if u.Email == nil {
		return ""
	}
	return *u.Email
}

func (s *Service) identityUser(ctx context.Context, user bson.ObjectID) (*identityUser, error) {
	var u identityUser
	err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: user}, liveUser},
		options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}, {Key: "userResidentId", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, identityErr("User was not found.", "USER_NOT_FOUND", http.StatusNotFound)
	}
	return &u, err
}

// mintCard is mintResidentId; the unique index is the real guard against a collision.
func (s *Service) mintCard(ctx context.Context, user bson.ObjectID) (string, error) {
	users := s.DB.Collection("users")
	for range 6 {
		candidate := "HH-" + idBlock() + "-" + idBlock()
		if n, err := users.CountDocuments(ctx, bson.D{{Key: "userResidentId", Value: candidate}}, options.Count().SetLimit(1)); err != nil || n > 0 {
			if err != nil {
				return "", err
			}
			continue
		}
		var u identityUser
		err := users.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: user}, {Key: "userResidentId", Value: bson.D{{Key: "$in", Value: bson.A{nil, ""}}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "userResidentId", Value: candidate}}}}, options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&u)
		if err == nil && u.card() != "" {
			return u.card(), nil
		}
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) && !mongo.IsDuplicateKeyError(err) {
			return "", err
		}
		// Another save won the race and already set one: use theirs.
		if cur, err := s.identityUser(ctx, user); err == nil && cur.card() != "" {
			return cur.card(), nil
		}
	}
	return "", identityErr("Could not allocate a resident ID. Please try again.", "RESIDENT_ID_ALLOCATION_FAILED", http.StatusInternalServerError)
}

func (s *Service) shareURL(card string) string {
	return s.SiteURL + "/resident-id/" + url.PathEscape(card)
}

func isoOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

// Identity is getResidentIdentity.
func (s *Service) Identity(ctx context.Context, user bson.ObjectID) (ordered.Map, error) {
	u, err := s.identityUser(ctx, user)
	if err != nil {
		return nil, err
	}
	rec, err := s.profileOf(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	role, kind, err := s.cardKind(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	id := ordered.Map{{Key: "accountEmail", Value: u.Email}, {Key: "accountName", Value: u.Name}, {Key: "cardRole", Value: role}, {Key: "cardType", Value: kind}}
	var card, share any
	if c := u.card(); c != "" {
		card, share = c, s.shareURL(c)
	}
	if rec == nil {
		id = append(id, ordered.Map{{Key: "hasPhoto", Value: false}, {Key: "hasProfile", Value: false}, {Key: "lastSharedAt", Value: nil}, {Key: "photoUpdatedAt", Value: nil},
			{Key: "residentId", Value: card}, {Key: "shareCount", Value: 0}, {Key: "shareUrl", Value: share}, {Key: "sharingEnabled", Value: true},
			{Key: "hasSignatureImage", Value: false}, {Key: "signatureUpdatedAt", Value: nil}, {Key: "updatedAt", Value: nil}}...)
		return ordered.Map{{Key: "identity", Value: id}, {Key: "profile", Value: nil}}, nil
	}
	m, err := s.readProfile(rec)
	if err != nil {
		return nil, err
	}
	dob, _ := pstr(m, "dateOfBirth")
	profile := m.Set("age", age(dob)) // `{ ...profile, age }`
	id = append(id, ordered.Map{{Key: "hasPhoto", Value: rec.PhotoAssetID != nil}, {Key: "hasProfile", Value: rec.CompletedAt != nil}, {Key: "lastSharedAt", Value: isoOrNil(rec.LastSharedAt)},
		{Key: "photoUpdatedAt", Value: isoOrNil(rec.PhotoUpdatedAt)}, {Key: "residentId", Value: card}, {Key: "shareCount", Value: rec.ShareCount}, {Key: "shareUrl", Value: share},
		{Key: "sharingEnabled", Value: rec.SharingEnabled == nil || *rec.SharingEnabled}, {Key: "hasSignatureImage", Value: rec.SignatureAssetID != nil},
		{Key: "signatureUpdatedAt", Value: isoOrNil(rec.SignatureUpdatedAt)}, {Key: "updatedAt", Value: isoOrNil(rec.UpdatedAt)}}...)
	return ordered.Map{{Key: "identity", Value: id}, {Key: "profile", Value: profile}}, nil
}

func identityStr(m ordered.Map, key string) string {
	v, _ := m.Get("identity")
	id, _ := v.(ordered.Map)
	s, _ := pstr(id, key)
	return s
}

// IdentityQR is getResidentIdentityQr.
func (s *Service) IdentityQR(ctx context.Context, user bson.ObjectID) (ordered.Map, error) {
	got, err := s.Identity(ctx, user)
	if err != nil {
		return nil, err
	}
	card, share := identityStr(got, "residentId"), identityStr(got, "shareUrl")
	if card == "" || share == "" {
		return nil, identityErr("Save your resident profile first to get a QR code.", "RESIDENT_PROFILE_MISSING", http.StatusNotFound)
	}
	var data any
	if d, err := qr.DataURL(share, qr.Options{Width: 420, Margin: 1, SetMargin: true}); err == nil {
		data = d
	}
	return ordered.Map{{Key: "qrDataUrl", Value: data}, {Key: "residentId", Value: card}, {Key: "shareUrl", Value: share}}, nil
}

var nonDigit = regexp.MustCompile(`\D`)

// phoneKey is residentPhoneKey: digits, with Nepal's 977 dropped from a 13-digit number.
func phoneKey(v string) string {
	d := nonDigit.ReplaceAllString(v, "")
	if len(d) == 13 && strings.HasPrefix(d, "977") {
		return d[3:]
	}
	return d
}

func (s *Service) phoneHash(phone string) string {
	return s.Personal.LookupHash("phone:" + phoneKey(phone))
}

// emailStatus is residentEmailStatus.
func (s *Service) emailStatus(ctx context.Context, user bson.ObjectID, addr string) (string, error) {
	addr = strings.ToLower(strings.TrimSpace(addr))
	var acct struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "email", Value: addr}, liveUser}, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&acct)
	found := err == nil
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return "", err
	}
	if found && acct.ID != user {
		return "TAKEN", nil
	}
	n, err := profiles(s).CountDocuments(ctx, bson.D{liveUser, {Key: "primaryEmailHash", Value: s.Personal.LookupHash(addr)}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: user}}}}, options.Count().SetLimit(1))
	if err != nil {
		return "", err
	}
	if n > 0 {
		return "TAKEN", nil
	}
	if found {
		return "YOURS", nil
	}
	return "AVAILABLE", nil
}

// phoneSpellings is accountPhoneSpellings. ponytail: a spelling not listed (dots,
// brackets) is missed until account phones are stored normalised.
func phoneSpellings(phone string) bson.A {
	k := phoneKey(phone)
	out, seen := bson.A{}, map[string]bool{}
	for _, v := range []string{strings.TrimSpace(phone), k, "+" + k, "+977" + k, "977" + k, "+977 " + k, "+977-" + k} {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// phoneStatus is residentPhoneStatus.
func (s *Service) phoneStatus(ctx context.Context, user bson.ObjectID, phone string) (string, error) {
	cur, err := s.DB.Collection("users").Find(ctx, bson.D{liveUser, {Key: "phone", Value: bson.D{{Key: "$in", Value: phoneSpellings(phone)}}}},
		options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}).SetLimit(2))
	if err != nil {
		return "", err
	}
	var accts []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &accts); err != nil {
		return "", err
	}
	n, err := profiles(s).CountDocuments(ctx, bson.D{liveUser, {Key: "primaryPhoneHash", Value: s.phoneHash(phone)}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: user}}}}, options.Count().SetLimit(1))
	if err != nil {
		return "", err
	}
	for _, a := range accts {
		if a.ID != user {
			n++
		}
	}
	switch {
	case n > 0:
		return "TAKEN", nil
	case len(accts) > 0:
		return "YOURS", nil
	}
	return "AVAILABLE", nil
}

type ownedAsset struct {
	ID       bson.ObjectID  `bson:"_id"`
	MimeType string         `bson:"mimeType"`
	OwnerID  *bson.ObjectID `bson:"ownerId"`
}

var assetKinds = map[string][5]string{
	// forbidden, notAnImage, notFound, notFoundMessage, notImageMessage
	"photo": {"PHOTO_FORBIDDEN", "PHOTO_NOT_AN_IMAGE", "PHOTO_NOT_FOUND", "That upload could not be found. Please pick the photo again.", "Your ID card photo has to be an image."},
	"signature": {"SIGNATURE_FORBIDDEN", "SIGNATURE_NOT_AN_IMAGE", "SIGNATURE_NOT_FOUND",
		"That signature upload could not be found. Photograph your signature again.", "Your signature has to be a photo."},
}

// ownedImage is loadOwnedImageAsset: the id came from the browser, so ownership is re-checked.
func (s *Service) ownedImage(ctx context.Context, owner bson.ObjectID, assetID, kind string) (*ownedAsset, error) {
	k := assetKinds[kind]
	oid, _ := bson.ObjectIDFromHex(assetID)
	var a ownedAsset
	err := s.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: oid}, liveUser, {Key: "status", Value: "ACTIVE"}},
		options.FindOne().SetProjection(bson.D{{Key: "mimeType", Value: 1}, {Key: "ownerId", Value: 1}})).Decode(&a)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, identityErr(k[3], k[2], http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}
	if a.OwnerID == nil || *a.OwnerID != owner {
		return nil, identityErr("That upload does not belong to you.", k[0], http.StatusForbidden)
	}
	if !strings.HasPrefix(a.MimeType, "image/") {
		return nil, identityErr(k[4], k[1], http.StatusUnprocessableEntity)
	}
	return &a, nil
}

const legacySelfPhoto = "/api/v1/users/resident-identity/photo"

var accountAvatar = regexp.MustCompile(`^/api/v1/users/[0-9a-fA-F]{24}/avatar(?:\?|$)`)

func isCardPhotoImage(v *string) bool {
	return v != nil && (strings.HasPrefix(*v, legacySelfPhoto) || accountAvatar.MatchString(*v))
}

// syncAvatar is syncAvatarWithCardPhoto: fills an empty avatar or replaces one we set; a
// picture from elsewhere (a Google sign-in) is the user's.
func (s *Service) syncAvatar(ctx context.Context, user bson.ObjectID, version *time.Time) error {
	var cur struct {
		Image *string `bson:"image"`
	}
	if err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: user}}, options.FindOne().SetProjection(bson.D{{Key: "image", Value: 1}})).Decode(&cur); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	if cur.Image != nil && *cur.Image != "" && !isCardPhotoImage(cur.Image) {
		return nil
	}
	var image any
	if version != nil {
		image = "/api/v1/users/" + user.Hex() + "/avatar?v=" + strconv.FormatInt(version.UnixMilli(), 10)
	}
	_, err := s.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: user}}, bson.D{{Key: "$set", Value: bson.D{{Key: "image", Value: image}}}})
	return err
}

// IdentityInput is the parsed residentIdentitySaveSchema.
type IdentityInput struct {
	PhotoAssetID, SignatureAssetID string
	Profile                        ordered.Map
	SharingEnabled                 bool
}

func missingProfile(msg string) error {
	return identityErr(msg, "RESIDENT_PROFILE_MISSING", http.StatusNotFound)
}

// SaveIdentity is saveResidentIdentity.
func (s *Service) SaveIdentity(ctx context.Context, user bson.ObjectID, in IdentityInput) (ordered.Map, error) {
	if s.Personal == nil {
		return nil, errors.New("PERSONAL_DATA_ENCRYPTION_KEY is required to store or read resident profiles")
	}
	u, err := s.identityUser(ctx, user)
	if err != nil {
		return nil, err
	}
	// The card's email is the sign-in email whenever the account has one: the server decides.
	profile := in.Profile
	if e := u.email(); e != "" {
		profile = profile.Set("primaryEmail", strings.ToLower(e))
	}
	primary, _ := pstr(profile, "primaryEmail")
	if backup, ok := pstr(profile, "backupEmail"); ok && backup != "" && strings.EqualFold(backup, primary) {
		return nil, identityErr("The backup email must be different from your account email.", "RESIDENT_BACKUP_EMAIL_SAME", http.StatusUnprocessableEntity)
	}
	if u.email() == "" {
		st, err := s.emailStatus(ctx, u.ID, primary)
		if err != nil {
			return nil, err
		}
		if st == "TAKEN" {
			return nil, identityErr("That email is already used by another account. Use a different one.", "RESIDENT_EMAIL_TAKEN", http.StatusConflict)
		}
	}
	existing, err := s.profileOf(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	firstCard := existing == nil || existing.CompletedAt == nil
	phone, _ := pstr(profile, "primaryPhone")
	hash := s.phoneHash(phone)
	if existing == nil || existing.PrimaryPhoneHash == nil || *existing.PrimaryPhoneHash != hash {
		st, err := s.phoneStatus(ctx, u.ID, phone)
		if err != nil {
			return nil, err
		}
		if st == "TAKEN" {
			return nil, identityErr("That phone number is already used by another account. Use your own number.", "RESIDENT_PHONE_TAKEN", http.StatusConflict)
		}
	}
	// Checked before the id is minted, so a refused save leaves no half-card.
	var photo, sigImage *ownedAsset
	if in.PhotoAssetID != "" {
		if photo, err = s.ownedImage(ctx, u.ID, in.PhotoAssetID, "photo"); err != nil {
			return nil, err
		}
	}
	if photo == nil && (existing == nil || existing.PhotoAssetID == nil) {
		return nil, identityErr("Add a photo of yourself — it goes on the front of your card.", "PHOTO_REQUIRED", http.StatusUnprocessableEntity)
	}
	if in.SignatureAssetID != "" {
		if sigImage, err = s.ownedImage(ctx, u.ID, in.SignatureAssetID, "signature"); err != nil {
			return nil, err
		}
	}
	drawn, _ := pstr(profile, "signature")
	if drawn == "" && sigImage == nil && (existing == nil || existing.SignatureAssetID == nil) {
		return nil, identityErr("Sign your card — draw it on the screen or photograph your signature on paper.", "SIGNATURE_REQUIRED", http.StatusUnprocessableEntity)
	}
	card := u.card()
	if card == "" {
		if card, err = s.mintCard(ctx, u.ID); err != nil {
			return nil, err
		}
	}
	plain, err := json.Marshal(profile)
	if err != nil {
		return nil, err
	}
	sealed, err := s.Personal.Encrypt(plain)
	if err != nil {
		return nil, err
	}
	at := now()
	set := bson.D{{Key: "completedAt", Value: at}, {Key: "encryptedData", Value: sealed}, {Key: "isDeleted", Value: false}, {Key: "payloadVersion", Value: 1},
		{Key: "primaryEmailHash", Value: s.Personal.LookupHash(primary)}, {Key: "primaryPhoneHash", Value: hash}, {Key: "sharingEnabled", Value: in.SharingEnabled},
		{Key: "updatedBy", Value: u.ID}, {Key: "updatedAt", Value: at}}
	if photo != nil {
		set = append(set, bson.E{Key: "photoAssetId", Value: photo.ID}, bson.E{Key: "photoUpdatedAt", Value: at})
	}
	if sigImage != nil {
		set = append(set, bson.E{Key: "signatureAssetId", Value: sigImage.ID}, bson.E{Key: "signatureUpdatedAt", Value: at})
	}
	update := bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: u.ID}, {Key: "createdAt", Value: at}, {Key: "shareCount", Value: 0}}}}
	// Back to a drawn signature removes the photographed one's handle, so the card shows one.
	if drawn != "" {
		update = append(update, bson.E{Key: "$unset", Value: bson.D{{Key: "signatureAssetId", Value: ""}, {Key: "signatureUpdatedAt", Value: ""}}})
	}
	if _, err := profiles(s).UpdateOne(ctx, bson.D{{Key: "userId", Value: u.ID}}, update, options.UpdateOne().SetUpsert(true)); err != nil {
		return nil, err
	}
	if photo != nil {
		if err := s.syncAvatar(ctx, u.ID, &at); err != nil {
			return nil, err
		}
	}
	if err := s.Audit.Write(ctx, audit.Entry{Action: "RESIDENT_PROFILE_SAVED", ActorID: u.ID, EntityID: card, EntityType: "UserResidentProfile",
		Metadata: bson.D{{Key: "sharingEnabled", Value: in.SharingEnabled}}}); err != nil {
		return nil, err
	}
	if firstCard {
		// Only the first completed save mails a card; later edits are just edits.
		s.after(ctx, func(ctx context.Context) error { s.SendIDCard(ctx, u.ID, "RESIDENT"); return nil })
	}
	return s.Identity(ctx, u.ID)
}

func (s *Service) after(ctx context.Context, fn func(context.Context) error) {
	if s.After == nil {
		_ = fn(ctx)
		return
	}
	s.After(ctx, fn)
}

// SetSharing is setResidentIdentitySharing.
func (s *Service) SetSharing(ctx context.Context, user bson.ObjectID, enabled bool) (ordered.Map, error) {
	res, err := profiles(s).UpdateOne(ctx, bson.D{liveUser, {Key: "userId", Value: user}}, bson.D{{Key: "$set", Value: bson.D{{Key: "sharingEnabled", Value: enabled}, {Key: "updatedAt", Value: now()}}}})
	if err != nil {
		return nil, err
	}
	if res.MatchedCount == 0 {
		return nil, missingProfile("You have not saved a resident profile yet.")
	}
	return s.Identity(ctx, user)
}

// SetPhoto is setResidentIdentityPhoto.
func (s *Service) SetPhoto(ctx context.Context, user bson.ObjectID, assetID string) (ordered.Map, error) {
	a, err := s.ownedImage(ctx, user, assetID, "photo")
	if err != nil {
		return nil, err
	}
	at := now()
	res, err := profiles(s).UpdateOne(ctx, bson.D{liveUser, {Key: "userId", Value: user}}, bson.D{{Key: "$set", Value: bson.D{{Key: "photoAssetId", Value: a.ID}, {Key: "photoUpdatedAt", Value: at}, {Key: "updatedAt", Value: at}}}})
	if err != nil {
		return nil, err
	}
	if res.MatchedCount == 0 {
		return nil, missingProfile("Save your resident details first, then add a photo.")
	}
	if err := s.syncAvatar(ctx, user, &at); err != nil {
		return nil, err
	}
	return s.Identity(ctx, user)
}

// ClearPhoto is clearResidentIdentityPhoto.
func (s *Service) ClearPhoto(ctx context.Context, user bson.ObjectID) (ordered.Map, error) {
	res, err := profiles(s).UpdateOne(ctx, bson.D{liveUser, {Key: "userId", Value: user}},
		bson.D{{Key: "$unset", Value: bson.D{{Key: "photoAssetId", Value: ""}, {Key: "photoUpdatedAt", Value: ""}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now()}}}})
	if err != nil {
		return nil, err
	}
	if res.MatchedCount == 0 {
		return nil, missingProfile("You have not saved a resident profile yet.")
	}
	if err := s.syncAvatar(ctx, user, nil); err != nil {
		return nil, err
	}
	return s.Identity(ctx, user)
}

// cardAsset is streamCardPhoto with the caller's own words for missing and unavailable.
func (s *Service) cardAsset(ctx context.Context, id bson.ObjectID, missing, unavailable string) (photoStream, string, error) {
	rd, mime, err := s.streamAsset(ctx, id)
	switch httpx.Code(err) {
	case "PHOTO_MISSING":
		return nil, "", identityErr(missing, "PHOTO_MISSING", http.StatusNotFound)
	case "PHOTO_UNAVAILABLE":
		return nil, "", identityErr(unavailable, "PHOTO_UNAVAILABLE", http.StatusBadGateway)
	}
	return rd, mime, err
}

// OwnPhoto is readResidentIdentityPhoto; OwnSignature is readResidentIdentitySignature.
func (s *Service) OwnPhoto(ctx context.Context, user bson.ObjectID) (photoStream, string, error) {
	rec, err := s.profileOf(ctx, user)
	if err != nil {
		return nil, "", err
	}
	if rec == nil || rec.PhotoAssetID == nil {
		return nil, "", identityErr("You have not added a photo yet.", "PHOTO_MISSING", http.StatusNotFound)
	}
	return s.cardAsset(ctx, *rec.PhotoAssetID, "Your photo is no longer available. Please upload it again.", "Could not load your photo right now.")
}

func (s *Service) OwnSignature(ctx context.Context, user bson.ObjectID) (photoStream, string, error) {
	rec, err := s.profileOf(ctx, user)
	if err != nil {
		return nil, "", err
	}
	if rec == nil || rec.SignatureAssetID == nil {
		return nil, "", identityErr("You have not photographed a signature.", "SIGNATURE_MISSING", http.StatusNotFound)
	}
	return s.cardAsset(ctx, *rec.SignatureAssetID, "Your signature is no longer available. Photograph it again.", "Could not load your signature right now.")
}

// Avatar is readAccountAvatarPhoto: only the photo an account presents as its avatar.
func (s *Service) Avatar(ctx context.Context, user bson.ObjectID) (photoStream, string, error) {
	none := identityErr("That account has no photo.", "PHOTO_MISSING", http.StatusNotFound)
	var u struct {
		Image *string `bson:"image"`
	}
	err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: user}, liveUser}, options.FindOne().SetProjection(bson.D{{Key: "image", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && !isCardPhotoImage(u.Image)) {
		return nil, "", none
	}
	if err != nil {
		return nil, "", err
	}
	rec, err := s.profileOf(ctx, user)
	if err != nil {
		return nil, "", err
	}
	if rec == nil || rec.PhotoAssetID == nil {
		return nil, "", none
	}
	return s.cardAsset(ctx, *rec.PhotoAssetID, "That photo is no longer available.", "Could not load that photo right now.")
}

func readAll(rd photoStream, _ string, err error) []byte {
	if err != nil {
		return nil
	}
	defer rd.Close()
	b, _ := io.ReadAll(rd)
	return b
}

var cardLabels = map[string]string{"HOSTEL_OWNER": "Hostel Owner", "RESIDENT": "Resident", "SERVICE_PROVIDER": "Service Provider"}

// SendIDCard is sendIdCardEmail: best-effort, never fails the flow that called it.
func (s *Service) SendIDCard(ctx context.Context, user bson.ObjectID, cardType string) {
	fail := func(err error) {
		slog.ErrorContext(ctx, "id_card_email_failed", "cardType", cardType, "message", err.Error())
	}
	got, err := s.Identity(ctx, user)
	if err != nil {
		fail(err)
		return
	}
	idv, _ := got.Get("identity")
	id := idv.(ordered.Map)
	pv, _ := got.Get("profile")
	profile, _ := pv.(ordered.Map)
	str := func(m ordered.Map, k string) string { v, _ := pstr(m, k); return v }
	recipient := str(profile, "primaryEmail")
	if recipient == "" {
		recipient = str(id, "accountEmail")
	}
	hasProfile, _ := id.Get("hasProfile")
	card := str(id, "residentId")
	if recipient == "" || card == "" || hasProfile != true {
		return
	}
	siteName := platformName
	if cfg, err := s.Config.SiteConfig(ctx); err == nil {
		if v, ok := cfg.Get("identity"); ok {
			if n := str(v.(ordered.Map), "siteName"); n != "" {
				siteName = n
			}
		}
	}
	d := idcard.Data{CardType: cardType, BrandName: siteName, ResidentID: card,
		DateOfBirth: str(profile, "dateOfBirth"), Phone: str(profile, "primaryPhone"), Signature: str(profile, "signature")}
	if bg := str(profile, "bloodGroup"); bg != "UNKNOWN" {
		d.BloodGroup = bg
	}
	d.Email = str(profile, "primaryEmail")
	if d.Email == "" {
		d.Email = str(id, "accountEmail")
	}
	d.FullName = str(profile, "fullName")
	if d.FullName == "" {
		d.FullName = str(id, "accountName")
	}
	issued := now()
	if t, err := time.Parse(time.RFC3339, str(id, "updatedAt")); err == nil {
		issued = t
	}
	d.IssuedOn = issued.UTC().Format("02 Jan 2006")
	d.Role = cardLabels[cardType]
	for _, r := range []string{str(id, "cardRole"), str(profile, "courseOrDesignation"), str(profile, "institution")} {
		if r != "" {
			d.Role = r
			break
		}
	}
	if u, err := url.Parse(s.SiteURL); err == nil {
		d.SiteLabel = u.Host
	}
	d.Photo = readAll(s.OwnPhoto(ctx, user))
	if share := str(id, "shareUrl"); share != "" {
		d.QR, _ = qr.PNG(share, qr.Options{Width: 420, Margin: 1, SetMargin: true})
	}
	if has, _ := id.Get("hasSignatureImage"); has == true {
		d.SignatureImage = readAll(s.OwnSignature(ctx, user))
	}
	front, err := idcard.Render(d, "front")
	if err != nil {
		return
	}
	slug := strings.ToLower(card)
	att := []email.Attachment{{Content: front, Filename: slug + "-card-front.png"}}
	if back, err := idcard.Render(d, "back"); err == nil {
		att = append(att, email.Attachment{Content: back, Filename: slug + "-card-back.png"})
	}
	c := email.IDCardIssued(cardLabels[cardType], d.FullName, card, siteName)
	if r := s.Mail.Send(ctx, email.Message{Category: c.Category, To: []string{recipient}, Subject: c.Subject, HTML: c.HTML, Attachments: att}); !r.Sent && r.Reason != "" {
		fail(errors.New(r.Reason))
	}
}

// editorDefaults are what the card editors read a draft into without a guard.
var editorDefaults = ordered.Map{{Key: "bloodGroup", Value: "UNKNOWN"}, {Key: "dietaryPreference", Value: "NO_PREFERENCE"}, {Key: "fullName", Value: ""},
	{Key: "gender", Value: ""}, {Key: "guardianName", Value: ""}, {Key: "guardianPhone", Value: ""}, {Key: "guardianRelation", Value: ""},
	{Key: "interests", Value: []any{}}, {Key: "occupation", Value: "STUDENT"}, {Key: "primaryPhone", Value: ""}}

// cardFromDetails maps the admission form onto the card's profile, in TS key order.
func cardFromDetails(d ordered.Map, mail string, r *Resident) ordered.Map {
	get := func(m ordered.Map, k string) any {
		if v, ok := m.Get(k); ok {
			return v
		}
		return nil
	}
	var family []ordered.Map
	if f, ok := d.Get("family"); ok {
		for _, p := range f.([]any) {
			if m, ok := p.(ordered.Map); ok {
				family = append(family, m)
			}
		}
	}
	var guardian, second ordered.Map
	gi := -1
	for i, p := range family {
		if ph, _ := pstr(p, "phone"); ph != "" {
			gi = i
			break
		}
	}
	if gi < 0 && len(family) > 0 {
		gi = 0
	}
	if gi >= 0 {
		guardian = family[gi]
		for i, p := range family {
			if i != gi {
				second = p
				break
			}
		}
	}
	local, _ := get(d, "localGuardian").(ordered.Map)
	var idType any
	if n, _ := pstr(d, "citizenshipNo"); n != "" {
		idType = "CITIZENSHIP"
	}
	var occupation any
	if r.ResidentType != nil {
		occupation = *r.ResidentType
	}
	pairs := []ordered.Pair{
		{Key: "bloodGroup", Value: get(d, "bloodGroup")}, {Key: "city", Value: get(d, "municipality")}, {Key: "classTime", Value: get(d, "classTime")},
		{Key: "dateOfBirth", Value: get(d, "dateOfBirth")}, {Key: "dietaryPreference", Value: get(d, "food")}, {Key: "district", Value: get(d, "district")},
		{Key: "emergencyContactAddress", Value: get(local, "address")}, {Key: "emergencyContactName", Value: get(local, "name")},
		{Key: "emergencyContactOccupation", Value: get(local, "occupation")}, {Key: "emergencyContactPhone", Value: get(local, "phone")},
		{Key: "emergencyContactRelation", Value: get(local, "relation")}, {Key: "fullName", Value: strings.TrimSpace(r.FirstName + " " + r.LastName)},
		{Key: "gender", Value: get(d, "gender")}, {Key: "governmentIdIssuedAt", Value: get(d, "citizenshipIssuedAt")},
		{Key: "governmentIdIssuedOn", Value: get(d, "citizenshipIssuedOn")}, {Key: "governmentIdNumber", Value: get(d, "citizenshipNo")},
		{Key: "governmentIdType", Value: idType}, {Key: "guardianName", Value: get(guardian, "name")}, {Key: "guardianOccupation", Value: get(guardian, "occupation")},
		{Key: "guardianPhone", Value: get(guardian, "phone")}, {Key: "guardianRelation", Value: get(guardian, "relation")},
		{Key: "institution", Value: get(d, "institution")}, {Key: "levelOfStudy", Value: get(d, "levelOfStudy")}, {Key: "medicalNotes", Value: get(d, "medicalNotes")},
		{Key: "occupation", Value: occupation}, {Key: "permanentAddress", Value: get(d, "tole")}, {Key: "primaryEmail", Value: mail},
		{Key: "primaryPhone", Value: r.Phone}, {Key: "secondGuardianName", Value: get(second, "name")}, {Key: "secondGuardianOccupation", Value: get(second, "occupation")},
		{Key: "secondGuardianPhone", Value: get(second, "phone")}, {Key: "secondGuardianRelation", Value: get(second, "relation")},
		{Key: "signature", Value: get(d, "signature")}, {Key: "wardNo", Value: get(d, "wardNo")},
	}
	var out ordered.Map
	for _, p := range pairs {
		if p.Value != nil { // undefined keys dropped
			out = append(out, p)
		}
	}
	return out
}

// toBody turns an ordered profile back into the decoded-JSON shape the schema reads.
func toBody(m ordered.Map) map[string]any {
	out := map[string]any{}
	for _, p := range m {
		out[p.Key] = p.Value
	}
	return out
}

// CardFromForm is cardFromAdmissionForm (RES-16): the admission form becomes the
// holder's ID card, or a draft the editor opens filled in. Never fails the caller.
func (s *Service) CardFromForm(ctx context.Context, residentID, owner bson.ObjectID) string {
	if s.Personal == nil {
		return "SKIPPED"
	}
	var r Resident
	if err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: residentID}}).Decode(&r); err != nil {
		return "SKIPPED"
	}
	u, err := s.identityUser(ctx, owner)
	if err != nil {
		return "SKIPPED"
	}
	existing, err := s.profileOf(ctx, owner)
	if err != nil {
		return "SKIPPED"
	}
	details, _ := s.openDetails(r.DetailsData).(ordered.Map)
	mail := strings.ToLower(strings.TrimSpace(u.email()))
	if details == nil || mail == "" {
		return "SKIPPED"
	}
	if existing != nil && existing.CompletedAt != nil {
		return "KEPT"
	}
	profile := cardFromDetails(details, mail, &r)
	// The card shows only a photo its holder owns; the form's photo is theirs.
	if r.PhotoAssetID != nil {
		if _, err := s.DB.Collection("fileassets").UpdateOne(ctx, bson.D{{Key: "_id", Value: *r.PhotoAssetID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "ownerId", Value: owner}}}}); err != nil {
			return "SKIPPED"
		}
	}
	f := &valid.Form{M: toBody(profile)}
	parsed := parseProfile(f)
	if len(f.Is) == 0 && r.PhotoAssetID != nil {
		if sig, _ := pstr(parsed, "signature"); sig != "" {
			if _, err := s.SaveIdentity(ctx, owner, IdentityInput{PhotoAssetID: r.PhotoAssetID.Hex(), Profile: parsed, SharingEnabled: true}); err == nil {
				return "MADE"
			}
			// Saved, and only the card mail after it failed: it is a card, not a draft.
			if rec, err := s.profileOf(ctx, owner); err == nil && rec != nil && rec.CompletedAt != nil {
				return "MADE"
			}
			// Otherwise their phone is on somebody else's card, say: they settle it in the editor.
		}
	}
	// `{ ...EDITOR_DEFAULTS, ...profile }`: defaults keep their place, the profile's values win.
	draft := append(ordered.Map{}, editorDefaults...)
	for _, p := range profile {
		draft = draft.Set(p.Key, p.Value)
	}
	plain, err := json.Marshal(draft)
	if err != nil {
		return "SKIPPED"
	}
	sealed, err := s.Personal.Encrypt(plain)
	if err != nil {
		return "SKIPPED"
	}
	at := now()
	set := bson.D{{Key: "encryptedData", Value: sealed}, {Key: "isDeleted", Value: false}, {Key: "payloadVersion", Value: 1},
		{Key: "primaryEmailHash", Value: s.Personal.LookupHash(mail)}, {Key: "sharingEnabled", Value: true}, {Key: "updatedBy", Value: owner}, {Key: "updatedAt", Value: at}}
	if r.PhotoAssetID != nil {
		set = append(set, bson.E{Key: "photoAssetId", Value: *r.PhotoAssetID}, bson.E{Key: "photoUpdatedAt", Value: at})
	}
	// Only a card they had deleted reaches here with one; a draft is not a card.
	if _, err := profiles(s).UpdateOne(ctx, bson.D{{Key: "userId", Value: owner}}, bson.D{{Key: "$set", Value: set},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdBy", Value: owner}, {Key: "createdAt", Value: at}, {Key: "shareCount", Value: 0}}},
		{Key: "$unset", Value: bson.D{{Key: "completedAt", Value: ""}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return "SKIPPED"
	}
	return "DRAFT"
}
