package hostelresidents

import (
	"context"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

const platformName = "HostelPalika" // PLATFORM_NAME

const scanQuiet = 10 * time.Minute

// Ledger is getResidentLedger: nil when the resident is not this hostel's.
type Ledger func(ctx context.Context, hostel bson.ObjectID, residentID string) (ordered.Map, error)

func identityErr(msg, code string, status int) error { return httpx.NewError(status, code, msg, nil) }

type scanUser struct {
	ID    bson.ObjectID `bson:"_id"`
	Email *string       `bson:"email"`
	Name  string        `bson:"name"`
}

type profileRec struct {
	ID                     bson.ObjectID  `bson:"_id"`
	CompletedAt            *time.Time     `bson:"completedAt"`
	EncryptedData          string         `bson:"encryptedData"`
	LastSharedAt           *time.Time     `bson:"lastSharedAt"`
	LastSharedWithHostelID *bson.ObjectID `bson:"lastSharedWithHostelId"`
	PhotoAssetID           *bson.ObjectID `bson:"photoAssetId"`
	PhotoUpdatedAt         *time.Time     `bson:"photoUpdatedAt"`
	SharingEnabled         *bool          `bson:"sharingEnabled"`
}

const badID = "That does not look like a resident ID. It should read like HH-4K7M-9XQ2."

func (s *Service) userByCard(ctx context.Context, card string) (*scanUser, error) {
	var u scanUser
	err := s.DB.Collection("users").FindOne(ctx, bson.D{liveUser, {Key: "userResidentId", Value: card}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &u, err
}

func (s *Service) profileOf(ctx context.Context, user bson.ObjectID) (*profileRec, error) {
	var r profileRec
	err := s.DB.Collection("userresidentprofiles").FindOne(ctx, bson.D{liveUser, {Key: "userId", Value: user}}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &r, err
}

// cardKind is resolvePlatformIdCard.
func (s *Service) cardKind(ctx context.Context, user bson.ObjectID) (role any, kind string, err error) {
	var u struct {
		Role string `bson:"role"`
	}
	if err := s.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: user}}, options.FindOne().SetProjection(bson.D{{Key: "role", Value: 1}})).Decode(&u); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, "", err
	}
	if u.Role == "HOSTEL_ADMIN" {
		return "Hostel Owner", "HOSTEL_OWNER", nil
	}
	var sp struct {
		Category string `bson:"category"`
	}
	err = s.DB.Collection("serviceproviders").FindOne(ctx, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: "APPROVED"}, {Key: "userId", Value: user}}, options.FindOne().SetProjection(bson.D{{Key: "category", Value: 1}})).Decode(&sp)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, "RESIDENT", nil
	}
	if err != nil {
		return nil, "", err
	}
	if sp.Category == "" {
		return "Service Provider", "SERVICE_PROVIDER", nil
	}
	words := strings.Split(strings.ToLower(sp.Category), "_")
	for i, w := range words {
		if w != "" {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " "), "SERVICE_PROVIDER", nil
}

func (s *Service) readProfile(rec *profileRec) (ordered.Map, error) {
	if s.Personal == nil {
		return nil, errors.New("PERSONAL_DATA_ENCRYPTION_KEY is required to store or read resident profiles. Generate one with: openssl rand -base64 32")
	}
	raw, err := s.Personal.Decrypt(rec.EncryptedData)
	if err != nil {
		return nil, err
	}
	v, err := ordered.FromJSON(raw)
	if err != nil {
		return nil, err
	}
	m, _ := v.(ordered.Map)
	return m, nil
}

func pstr(m ordered.Map, key string) (string, bool) {
	v, ok := m.Get(key)
	s, isStr := v.(string)
	return s, ok && isStr
}

func pval(m ordered.Map, key string) any {
	v, _ := m.Get(key)
	return v
}

func orNull(m ordered.Map, key string) any {
	if v, ok := m.Get(key); ok {
		return v
	}
	return nil
}

// age is ageFromDateOfBirth.
func age(dob string) any {
	born, err := time.Parse("2006-01-02", dob)
	if dob == "" || err != nil {
		if t, e2 := time.Parse(time.RFC3339, dob); e2 == nil && dob != "" {
			born, err = t, nil
		} else {
			return nil
		}
	}
	n := time.Now()
	a := n.Year() - born.Year()
	if d := int(n.Month()) - int(born.Month()); d < 0 || (d == 0 && n.Day() < born.Day()) {
		a--
	}
	if a >= 0 && a < 130 {
		return a
	}
	return nil
}

func putStr(out *ordered.Map, key string, m ordered.Map, from string) {
	if v, ok := m.Get(from); ok && v != nil {
		*out = append(*out, ordered.Pair{Key: key, Value: v})
	}
}

// detailsFromCard is detailsFromCard: the ID card's facts as the application form.
func detailsFromCard(p ordered.Map) ordered.Map {
	person := func(name, occ, phone, rel any) ordered.Map {
		m := ordered.Map{}
		for _, e := range []ordered.Pair{{Key: "name", Value: name}, {Key: "occupation", Value: occ}, {Key: "phone", Value: phone}, {Key: "relation", Value: rel}} {
			if e.Value != nil {
				m = append(m, e)
			}
		}
		return m
	}
	family := []any{person(pval(p, "guardianName"), pval(p, "guardianOccupation"), pval(p, "guardianPhone"), pval(p, "guardianRelation"))}
	if n, ok := pstr(p, "secondGuardianName"); ok && n != "" {
		rel := any("Guardian")
		if r := pval(p, "secondGuardianRelation"); r != nil {
			rel = r
		}
		family = append(family, person(n, pval(p, "secondGuardianOccupation"), pval(p, "secondGuardianPhone"), rel))
	}
	out := ordered.Map{}
	if b, _ := pstr(p, "bloodGroup"); b != "UNKNOWN" {
		putStr(&out, "bloodGroup", p, "bloodGroup")
	}
	putStr(&out, "citizenshipIssuedAt", p, "governmentIdIssuedAt")
	putStr(&out, "citizenshipIssuedOn", p, "governmentIdIssuedOn")
	putStr(&out, "citizenshipNo", p, "governmentIdNumber")
	putStr(&out, "classTime", p, "classTime")
	putStr(&out, "dateOfBirth", p, "dateOfBirth")
	putStr(&out, "district", p, "district")
	out = append(out, ordered.Pair{Key: "family", Value: family})
	if f, _ := pstr(p, "dietaryPreference"); f != "NO_PREFERENCE" {
		putStr(&out, "food", p, "dietaryPreference")
	}
	putStr(&out, "gender", p, "gender")
	putStr(&out, "institution", p, "institution")
	if v := pval(p, "levelOfStudy"); v != nil {
		out = append(out, ordered.Pair{Key: "levelOfStudy", Value: v})
	} else {
		putStr(&out, "levelOfStudy", p, "courseOrDesignation")
	}
	if n, ok := pstr(p, "emergencyContactName"); ok && n != "" {
		rel := any("Local guardian")
		if r := pval(p, "emergencyContactRelation"); r != nil {
			rel = r
		}
		lg := ordered.Map{}
		for _, e := range []ordered.Pair{{Key: "address", Value: pval(p, "emergencyContactAddress")}, {Key: "name", Value: n}, {Key: "occupation", Value: pval(p, "emergencyContactOccupation")}, {Key: "phone", Value: pval(p, "emergencyContactPhone")}, {Key: "relation", Value: rel}} {
			if e.Value != nil {
				lg = append(lg, e)
			}
		}
		out = append(out, ordered.Pair{Key: "localGuardian", Value: lg})
	}
	putStr(&out, "medicalNotes", p, "medicalNotes")
	putStr(&out, "municipality", p, "city")
	putStr(&out, "tole", p, "permanentAddress")
	putStr(&out, "wardNo", p, "wardNo")
	return out
}

func splitName(v string) (string, string) {
	parts := strings.Fields(v)
	if len(parts) == 0 {
		return v, v
	}
	last := strings.Join(parts[1:], " ")
	if last == "" {
		last = parts[0]
	}
	return parts[0], last
}

func prefill(p ordered.Map) ordered.Map {
	gName, _ := pstr(p, "guardianName")
	gf, gl := splitName(gName)
	mk := func(pairs ...ordered.Pair) ordered.Map {
		m := ordered.Map{}
		for _, e := range pairs {
			if e.Value != nil {
				m = append(m, e)
			}
		}
		return m
	}
	guardians := []any{mk(ordered.Pair{Key: "email", Value: pval(p, "guardianEmail")}, ordered.Pair{Key: "firstName", Value: gf}, ordered.Pair{Key: "lastName", Value: gl}, ordered.Pair{Key: "isPrimary", Value: true},
		ordered.Pair{Key: "phone", Value: pval(p, "guardianPhone")}, ordered.Pair{Key: "relation", Value: pval(p, "guardianRelation")})}
	if n, ok := pstr(p, "secondGuardianName"); ok && n != "" {
		if ph, ok := pstr(p, "secondGuardianPhone"); ok && ph != "" {
			f, l := splitName(n)
			rel := any("Guardian")
			if r := pval(p, "secondGuardianRelation"); r != nil {
				rel = r
			}
			guardians = append(guardians, mk(ordered.Pair{Key: "email", Value: pval(p, "secondGuardianEmail")}, ordered.Pair{Key: "firstName", Value: f}, ordered.Pair{Key: "lastName", Value: l}, ordered.Pair{Key: "isPrimary", Value: false},
				ordered.Pair{Key: "phone", Value: ph}, ordered.Pair{Key: "relation", Value: rel}))
		}
	}
	var emergency ordered.Map
	en, _ := pstr(p, "emergencyContactName")
	ep, _ := pstr(p, "emergencyContactPhone")
	if en != "" && ep != "" {
		rel := any("Emergency contact")
		if r := pval(p, "emergencyContactRelation"); r != nil {
			rel = r
		}
		emergency = mk(ordered.Pair{Key: "isPrimary", Value: true}, ordered.Pair{Key: "name", Value: en}, ordered.Pair{Key: "phone", Value: ep}, ordered.Pair{Key: "relation", Value: rel})
	} else {
		emergency = mk(ordered.Pair{Key: "isPrimary", Value: true}, ordered.Pair{Key: "name", Value: pval(p, "guardianName")}, ordered.Pair{Key: "phone", Value: pval(p, "guardianPhone")}, ordered.Pair{Key: "relation", Value: pval(p, "guardianRelation")})
	}
	full, _ := pstr(p, "fullName")
	parts := strings.Fields(full)
	first, rest := full, ""
	if len(parts) > 0 {
		first, rest = parts[0], strings.Join(parts[1:], " ")
	}
	last := rest
	if last == "" {
		last = first
	}
	dob, _ := pstr(p, "dateOfBirth")
	return ordered.Map{
		{Key: "emergencyContact", Value: emergency},
		{Key: "form", Value: detailsFromCard(p)},
		{Key: "guardians", Value: guardians},
		{Key: "resident", Value: mk(ordered.Pair{Key: "email", Value: pval(p, "primaryEmail")}, ordered.Pair{Key: "firstName", Value: first}, ordered.Pair{Key: "lastName", Value: last},
			ordered.Pair{Key: "phone", Value: pval(p, "primaryPhone")}, ordered.Pair{Key: "residentType", Value: pval(p, "occupation")})},
		{Key: "details", Value: ordered.Map{
			{Key: "age", Value: age(dob)}, {Key: "alternatePhone", Value: orNull(p, "alternatePhone")}, {Key: "backupEmail", Value: orNull(p, "backupEmail")}, {Key: "bloodGroup", Value: pval(p, "bloodGroup")},
			{Key: "budgetRange", Value: orNull(p, "budgetRange")}, {Key: "city", Value: orNull(p, "city")}, {Key: "courseOrDesignation", Value: orNull(p, "courseOrDesignation")}, {Key: "dateOfBirth", Value: orNull(p, "dateOfBirth")},
			{Key: "dietaryPreference", Value: pval(p, "dietaryPreference")}, {Key: "gender", Value: pval(p, "gender")}, {Key: "governmentIdNumber", Value: orNull(p, "governmentIdNumber")}, {Key: "governmentIdType", Value: orNull(p, "governmentIdType")},
			{Key: "institution", Value: orNull(p, "institution")}, {Key: "interests", Value: pval(p, "interests")}, {Key: "medicalNotes", Value: orNull(p, "medicalNotes")}, {Key: "permanentAddress", Value: orNull(p, "permanentAddress")},
			{Key: "province", Value: orNull(p, "province")}}},
	}
}

// Lookup is lookupResidentProfile.
func (s *Service) Lookup(ctx context.Context, input string, p *authz.Principal, hostelID string) (ordered.Map, error) {
	card := bookings.NormalizeResidentID(input)
	if card == "" {
		return nil, identityErr(badID, "RESIDENT_ID_INVALID", http.StatusUnprocessableEntity)
	}
	user, err := s.userByCard(ctx, card)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, identityErr("No resident profile matches that ID.", "RESIDENT_PROFILE_NOT_FOUND", http.StatusNotFound)
	}
	_, kind, err := s.cardKind(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	if kind != "RESIDENT" {
		who := "hostel owner"
		if kind == "SERVICE_PROVIDER" {
			who = "service provider"
		}
		return nil, identityErr("That is a "+who+" ID card, not a resident one. It cannot be used to register a resident.", "ID_CARD_NOT_A_RESIDENT", http.StatusConflict)
	}
	rec, err := s.profileOf(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	if rec == nil || rec.CompletedAt == nil {
		return nil, identityErr("That resident has not finished their profile yet.", "RESIDENT_PROFILE_INCOMPLETE", http.StatusNotFound)
	}
	if rec.SharingEnabled != nil && !*rec.SharingEnabled {
		return nil, identityErr("That resident has turned off profile sharing.", "RESIDENT_PROFILE_SHARING_DISABLED", http.StatusForbidden)
	}
	var scoped *bson.ObjectID
	if id, e := bson.ObjectIDFromHex(hostelID); e == nil && len(hostelID) == 24 {
		scoped = &id
	} else if len(p.HostelIDs) > 0 {
		if id, e := bson.ObjectIDFromHex(p.HostelIDs[0]); e == nil {
			scoped = &id
		}
	}
	at := now()
	set := bson.D{{Key: "lastSharedAt", Value: at}}
	if scoped != nil {
		set = append(set, bson.E{Key: "lastSharedWithHostelId", Value: *scoped})
	}
	if _, err := s.DB.Collection("userresidentprofiles").UpdateOne(ctx, bson.D{{Key: "_id", Value: rec.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "shareCount", Value: 1}}}, {Key: "$set", Value: set}}); err != nil {
		return nil, err
	}
	actor := bsonUser(p)
	var host bson.ObjectID
	if scoped != nil {
		host = *scoped
	}
	if err := s.Audit.Write(ctx, audit.Entry{Action: "RESIDENT_PROFILE_SHARED", ActorID: actor, EntityID: card, EntityType: "UserResidentProfile", HostelID: host,
		Metadata: bson.D{{Key: "residentId", Value: card}, {Key: "subjectUserId", Value: user.ID.Hex()}}}); err != nil {
		return nil, err
	}
	in := notifications.Input{Body: "A hostel used your resident ID to fill in your details. If this was not you, turn off sharing from your profile menu.", Category: "ACCOUNT",
		Data: ordered.Map{{Key: "residentId", Value: card}}, Title: "Your resident profile was shared", UserID: user.ID.Hex()}
	if scoped != nil {
		in.HostelID = scoped.Hex()
	}
	_, _ = s.Notify.CreateInApp(ctx, in)
	profile, err := s.readProfile(rec)
	if err != nil {
		return nil, err
	}
	addr := ""
	if user.Email != nil {
		addr = *user.Email
	}
	pe, _ := pstr(profile, "primaryEmail")
	var asking bson.ObjectID
	if scoped != nil {
		asking = *scoped
	}
	occ, err := s.FindLiveResidency(ctx, []string{addr, pe}, []bson.ObjectID{user.ID}, asking)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "occupancy", Value: occ.JSON()}, {Key: "photo", Value: ordered.Map{{Key: "hasPhoto", Value: rec.PhotoAssetID != nil}, {Key: "updatedAt", Value: isoOrNull(rec.PhotoUpdatedAt)}}},
		{Key: "prefill", Value: prefill(profile)}, {Key: "residentId", Value: card}, {Key: "sharedAt", Value: iso(time.Now().UTC())}}, nil
}

func iso(t time.Time) string { return httpx.ISO(t) }

type scanned struct {
	user       *scanUser
	rec        *profileRec
	card       string
	disclosure bool
}

func (s *Service) findScanned(ctx context.Context, input string) (*scanned, error) {
	card := bookings.NormalizeResidentID(input)
	if card == "" {
		return nil, identityErr(badID, "RESIDENT_ID_INVALID", http.StatusUnprocessableEntity)
	}
	user, err := s.userByCard(ctx, card)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, identityErr("No "+platformName+" account carries that ID card.", "RESIDENT_PROFILE_NOT_FOUND", http.StatusNotFound)
	}
	rec, err := s.profileOf(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	ok := rec != nil && rec.CompletedAt != nil && (rec.SharingEnabled == nil || *rec.SharingEnabled)
	return &scanned{user: user, rec: rec, card: card, disclosure: ok}, nil
}

// ScanPhoto is readScannedResidentPhoto.
func (s *Service) ScanPhoto(ctx context.Context, input string) (photoStream, string, error) {
	sc, err := s.findScanned(ctx, input)
	if err != nil {
		return nil, "", err
	}
	missing := identityErr("That card has no photo to show.", "PHOTO_MISSING", http.StatusNotFound)
	if !sc.disclosure || sc.rec.PhotoAssetID == nil {
		return nil, "", missing
	}
	rd, mime, err := s.streamAsset(ctx, *sc.rec.PhotoAssetID)
	if httpx.Code(err) == "PHOTO_MISSING" {
		return nil, "", missing
	}
	return rd, mime, err
}

// Scan is scanResidentForHostel.
func (s *Service) Scan(ctx context.Context, input string, p *authz.Principal, canViewPayments bool, hostelID string) (ordered.Map, error) {
	sc, err := s.findScanned(ctx, input)
	if err != nil {
		return nil, err
	}
	role, kind, err := s.cardKind(ctx, sc.user.ID)
	if err != nil {
		return nil, err
	}
	var profile ordered.Map
	if sc.disclosure && sc.rec != nil {
		if profile, err = s.readProfile(sc.rec); err != nil {
			return nil, err
		}
	}
	var notice string
	switch {
	case profile != nil:
	case sc.rec != nil && sc.rec.CompletedAt != nil:
		notice = "They have turned profile sharing off. They can switch it back on from their ID card screen."
	default:
		notice = "They have not filled in their " + platformName + " profile, so the card carries nothing but the number."
	}
	var scope []bson.ObjectID
	if hostelID != "" {
		if id, e := bson.ObjectIDFromHex(hostelID); e == nil && len(hostelID) == 24 {
			scope = append(scope, id)
		}
	} else {
		for _, h := range p.HostelIDs {
			if id, e := bson.ObjectIDFromHex(h); e == nil && len(h) == 24 {
				scope = append(scope, id)
			}
		}
	}
	var membership ordered.Map
	var memberHostel bson.ObjectID
	if len(scope) > 0 {
		if membership, memberHostel, err = s.membership(ctx, canViewPayments, profile, scope, sc.user); err != nil {
			return nil, err
		}
	}
	var membershipNotice any
	if membership == nil {
		membershipNotice = "They are not on your roll. Register them and the form fills itself in from this card."
	}
	if profile != nil && sc.rec != nil {
		var host *bson.ObjectID
		if membership != nil {
			host = &memberHostel
		} else if len(scope) > 0 {
			host = &scope[0]
		}
		repeat := sc.rec.LastSharedAt != nil && time.Since(*sc.rec.LastSharedAt) < scanQuiet &&
			((sc.rec.LastSharedWithHostelID == nil && host == nil) || (sc.rec.LastSharedWithHostelID != nil && host != nil && *sc.rec.LastSharedWithHostelID == *host))
		set := bson.D{{Key: "lastSharedAt", Value: now()}}
		var hid bson.ObjectID
		if host != nil {
			set = append(set, bson.E{Key: "lastSharedWithHostelId", Value: *host})
			hid = *host
		}
		if _, err := s.DB.Collection("userresidentprofiles").UpdateOne(ctx, bson.D{{Key: "_id", Value: sc.rec.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "shareCount", Value: 1}}}, {Key: "$set", Value: set}}); err != nil {
			return nil, err
		}
		if err := s.Audit.Write(ctx, audit.Entry{Action: "RESIDENT_PROFILE_SCANNED", ActorID: bsonUser(p), EntityID: sc.card, EntityType: "UserResidentProfile", HostelID: hid,
			Metadata: bson.D{{Key: "residentId", Value: sc.card}, {Key: "subjectUserId", Value: sc.user.ID.Hex()}}}); err != nil {
			return nil, err
		}
		if !repeat {
			in := notifications.Input{Body: "A hostel scanned your ID card and read your profile. If that was not you, turn sharing off from your ID card screen.", Category: "ACCOUNT",
				Data: ordered.Map{{Key: "residentId", Value: sc.card}}, Title: "Your ID card was scanned", UserID: sc.user.ID.Hex()}
			if host != nil {
				in.HostelID = host.Hex()
			}
			_, _ = s.Notify.CreateInApp(ctx, in)
		}
	}
	var email any
	if sc.user.Email != nil {
		email = *sc.user.Email
	}
	var photoAt any
	if sc.rec != nil {
		photoAt = isoOrNull(sc.rec.PhotoUpdatedAt)
	}
	var profOut any
	if profile != nil {
		dob, _ := pstr(profile, "dateOfBirth")
		profOut = append(append(ordered.Map{}, profile...), ordered.Pair{Key: "age", Value: age(dob)})
	}
	var noticeOut any
	if notice != "" {
		noticeOut = notice
	}
	return ordered.Map{
		{Key: "account", Value: ordered.Map{{Key: "cardRole", Value: role}, {Key: "cardType", Value: kind}, {Key: "email", Value: email},
			{Key: "hasPhoto", Value: sc.disclosure && sc.rec != nil && sc.rec.PhotoAssetID != nil}, {Key: "name", Value: sc.user.Name}, {Key: "photoUpdatedAt", Value: photoAt}}},
		{Key: "membership", Value: orNilMap(membership)}, {Key: "membershipNotice", Value: membershipNotice}, {Key: "profile", Value: profOut}, {Key: "profileNotice", Value: noticeOut},
		{Key: "residentId", Value: sc.card}, {Key: "scannedAt", Value: iso(time.Now().UTC())},
	}, nil
}

func orNilMap(m ordered.Map) any {
	if m == nil {
		return nil
	}
	return m
}

func (h *Handler) readQuery(c *gin.Context) (string, string, bool) {
	q := valid.Query(c)
	var is valid.Issues
	var id *string
	if _, present := q["residentId"]; present {
		id = valid.QueryString(q, "residentId", 8, 300, &is)
	} else {
		is.Add("residentId", valid.Type("string", valid.Received(nil, true)))
	}
	hid := ""
	if raw, ok := q["hostelId"]; ok {
		hid = raw
		if !objectIDRe.MatchString(raw) {
			is.Add("hostelId", "Invalid string: must match pattern /^[a-f\\d]{24}$/i")
		}
	}
	if fail(c, is.Err()) {
		return "", "", false
	}
	if id == nil {
		return "", hid, true
	}
	return *id, hid, true
}

func (h *Handler) scanLimit(c *gin.Context, ns string) bool {
	if h.Limiter == nil {
		return true
	}
	return !fail(c, h.Limiter.Check(c, ns, 20, h.Limiter.FormWindow))
}

func (h *Handler) scan(c *gin.Context) {
	if !h.scanLimit(c, "resident-scan") {
		return
	}
	p := authz.From(c)
	id, hid, ok := h.readQuery(c)
	if !ok {
		return
	}
	_, perr := h.Guards.RequireHostelCapability(c, "viewPayments")
	out, err := h.Scan(c, id, p, perr == nil, hid)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident card read")
}

func (h *Handler) scanPhoto(c *gin.Context) {
	id, _, ok := h.readQuery(c)
	if !ok {
		return
	}
	rd, mime, err := h.ScanPhoto(c, id)
	if fail(c, err) {
		return
	}
	defer rd.Close()
	c.Header("Cache-Control", "private, max-age=300")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Type", mime)
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, rd)
}

func (h *Handler) lookup(c *gin.Context) {
	if !h.scanLimit(c, "resident-profile-lookup") {
		return
	}
	id, hid, ok := h.readQuery(c)
	if !ok {
		return
	}
	out, err := h.Lookup(c, id, authz.From(c), hid)
	if fail(c, err) {
		return
	}
	httpx.OK(c, out, "Resident profile loaded")
}
