// Package backup is backup.service.ts: the owner's encrypted backup to their own
// Google Drive. Owner only, everywhere. Connecting Drive and backing up need the
// Pro plan or above; downloading and restoring what was already backed up do not,
// so a lapsed plan never holds a hostel's own data hostage.
package backup

import (
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/billing"
	"github.com/softmato/hostelpalika/server/internal/modules/hostels"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/plans"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

const (
	planFloor    = "pro"
	keepOnDrive  = 30 // older Drive files are deleted, their history rows stay
	stateTTL     = 10 * time.Minute
	tokenPurpose = "DRIVE_REFRESH_TOKEN"
	appReturn    = "hostelpalika://manage/backup"
)

type Handler struct {
	DB        *mongo.Database
	Guards    *authz.Guards
	Audit     *audit.Log
	Config    *platformconfig.Service
	Drive     *Drive
	AppURL    string // no trailing slash
	JWTSecret string // JWT_ACCESS_SECRET, keys the OAuth state
	// FINANCE_MASTER_KEY(_PREV): the Drive refresh token is sealed like a gateway secret.
	FinanceKey, FinancePrev string
	Now                     func() time.Time
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/backup/drive/callback", h.callback)
	g := v1.Group("/hostel-admin/backup", authz.Use(h.Guards.RequireHostelAdmin))
	g.GET("", h.overview)
	g.POST("", h.backUpNow)
	g.POST("/drive", h.connect)
	g.DELETE("/drive", h.disconnect)
	g.PUT("/key", h.setKey)
	g.POST("/key", h.confirmKit)
	g.POST("/restore", h.restore)
	g.GET("/runs/:runId/file", h.file)
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func fail(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

func (h *Handler) redirectURI() string {
	return h.AppURL + "/api/v1/hostel-admin/backup/drive/callback"
}

// ownerHostel: only the owner; a warden runs the hostel, its whole archive is not theirs.
func (h *Handler) ownerHostel(c *gin.Context) (bson.ObjectID, error) {
	p := authz.From(c)
	id, err := hostels.AdminHostel(p, c.Query("hostelId"))
	if err != nil {
		return id, err
	}
	_, err = hostels.ResolveOwned(c, h.DB, id.Hex(), p.UserID)
	return id, err
}

func (h *Handler) planAllows(ctx context.Context, hostelID bson.ObjectID) (bool, error) {
	billed, err := billing.BillingHostelID(ctx, h.DB, hostelID)
	if err != nil {
		return false, err
	}
	var sub struct {
		PlanID string `bson:"planId"`
	}
	err = h.DB.Collection("hostelsubscriptions").FindOne(ctx, bson.D{{Key: "hostelId", Value: billed}}, options.FindOne().SetProjection(bson.D{{Key: "planId", Value: 1}})).Decode(&sub)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && sub.PlanID == "") {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	raw, err := h.Config.Section(ctx, "plans")
	if err != nil {
		return false, err
	}
	var catalog plans.Catalog
	if err := platformconfig.Decode(raw, &catalog); err != nil {
		return false, err
	}
	floor := plans.PlanRank(catalog, planFloor)
	return floor >= 0 && plans.PlanRank(catalog, sub.PlanID) >= floor, nil
}

func (h *Handler) assertPlan(ctx context.Context, hostelID bson.ObjectID) error {
	ok, err := h.planAllows(ctx, hostelID)
	if err == nil && !ok {
		err = fail(403, "BACKUP_NEEDS_PRO", "Backup to Google Drive comes with the Pro plan and up.")
	}
	return err
}

// audit never fails the request, as TS's .catch(() => {}).
func (h *Handler) audit(ctx context.Context, actor string, hostelID bson.ObjectID, action string, meta bson.D) {
	e := audit.Entry{Action: action, ActorType: "SYSTEM", EntityID: hostelID.Hex(), EntityType: "HostelBackup", HostelID: hostelID, Metadata: meta}
	if oid, err := bson.ObjectIDFromHex(actor); err == nil {
		e.ActorID, e.ActorType = oid, "USER"
	}
	if err := h.Audit.Write(ctx, e); err != nil {
		slog.WarnContext(ctx, "backup audit failed", "action", action, "err", err)
	}
}

func (h *Handler) touch(ctx context.Context, filter, update bson.D, upsert bool) (*mongo.UpdateResult, error) {
	now := h.now()
	for i, e := range update {
		if e.Key == "$set" {
			update[i].Value = append(e.Value.(bson.D), bson.E{Key: "updatedAt", Value: now})
		}
	}
	opts := options.UpdateOne()
	if upsert {
		opts.SetUpsert(true)
		update = append(update, bson.E{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}}})
	}
	return h.DB.Collection("hostelbackups").UpdateOne(ctx, filter, update, opts)
}

/* ── Overview ── */

type backupRow struct {
	Drive *struct {
		ConnectedAt *time.Time       `bson:"connectedAt"`
		Email       *string          `bson:"email"`
		Error       *string          `bson:"error"`
		Status      string           `bson:"status"`
		Token       *crypto.Envelope `bson:"token"`
	} `bson:"drive"`
	KeyFingerprint *string    `bson:"keyFingerprint"`
	KeySetAt       *time.Time `bson:"keySetAt"`
	KitConfirmedAt *time.Time `bson:"kitConfirmedAt"`
	PublicKey      string     `bson:"publicKey"`
}

type runRow struct {
	ID             bson.ObjectID `bson:"_id"`
	Bytes          *int64        `bson:"bytes"`
	Checked        bool          `bson:"checked"`
	Counts         bson.D        `bson:"counts"`
	CreatedAt      time.Time     `bson:"createdAt"`
	DriveFileID    string        `bson:"driveFileId"`
	Error          *string       `bson:"error"`
	FileName       *string       `bson:"fileName"`
	KeyFingerprint *string       `bson:"keyFingerprint"`
	SHA512         *string       `bson:"sha512"`
	Status         string        `bson:"status"`
	Trigger        string        `bson:"trigger"`
	Chunks         []packedChunk `bson:"chunks"`
}

func isoPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := httpx.ISO(*t)
	return &s
}

func (h *Handler) overview(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	allowed, err := h.planAllows(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var cfg backupRow
	if err := h.DB.Collection("hostelbackups").FindOne(c, bson.D{{Key: "hostelId", Value: id}},
		options.FindOne().SetProjection(bson.D{{Key: "drive.token", Value: 0}})).Decode(&cfg); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.DB.Collection("hostelbackupruns").Find(c, bson.D{{Key: "hostelId", Value: id}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(60).SetProjection(bson.D{{Key: "chunks", Value: 0}}))
	var runs []runRow
	if err == nil {
		err = cur.All(c, &runs)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	type driveView struct {
		ConnectedAt *string `json:"connectedAt"`
		Email       *string `json:"email"`
		Error       *string `json:"error"`
		Ready       bool    `json:"ready"`
		Status      string  `json:"status"`
	}
	type keyView struct {
		Fingerprint    *string `json:"fingerprint"`
		KitConfirmedAt *string `json:"kitConfirmedAt"`
		SetAt          *string `json:"setAt"`
	}
	type runView struct {
		Bytes          *int64    `json:"bytes"`
		Checked        bool      `json:"checked"`
		Counts         countList `json:"counts"`
		CreatedAt      string    `json:"createdAt"`
		Error          *string   `json:"error"`
		FileName       *string   `json:"fileName"`
		ID             string    `json:"id"`
		KeyFingerprint *string   `json:"keyFingerprint"`
		OnDrive        bool      `json:"onDrive"`
		SHA512         *string   `json:"sha512"`
		Status         string    `json:"status"`
		Trigger        string    `json:"trigger"`
	}
	dv := driveView{Ready: h.Drive.Configured(), Status: "NOT_CONNECTED"}
	if d := cfg.Drive; d != nil {
		dv.ConnectedAt, dv.Email, dv.Error = isoPtr(d.ConnectedAt), d.Email, d.Error
		if d.Status != "" {
			dv.Status = d.Status
		}
	}
	var key *keyView
	if cfg.PublicKey != "" {
		key = &keyView{cfg.KeyFingerprint, isoPtr(cfg.KitConfirmedAt), isoPtr(cfg.KeySetAt)}
	}
	views := make([]runView, len(runs))
	for i, r := range runs {
		trigger := r.Trigger
		if trigger == "" {
			trigger = "SCHEDULE"
		}
		counts := countList(r.Counts)
		if counts == nil {
			counts = countList{}
		}
		views[i] = runView{r.Bytes, r.Checked, counts, httpx.ISO(r.CreatedAt), r.Error, r.FileName, r.ID.Hex(), r.KeyFingerprint, r.DriveFileID != "", r.SHA512, r.Status, trigger}
	}
	httpx.OK(c, struct {
		Allowed  bool      `json:"allowed"`
		Drive    driveView `json:"drive"`
		HostelID string    `json:"hostelId"`
		Key      *keyView  `json:"key"`
		Runs     []runView `json:"runs"`
	}{allowed, dv, id.Hex(), key, views}, "Backup loaded")
}

/* ── Key ── */

// setKey: the public half of the key the owner's phone made. Replacing it means
// older backups still need the older recovery kit; each run records its key's fingerprint.
func (h *Handler) setKey(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	publicKey, _ := f.Str("publicKey", valid.S{Min: 40, Max: 60})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	raw := crypto.FromBase64(publicKey)
	if len(raw) != 32 {
		httpx.Fail(c, fail(422, "BACKUP_KEY_INVALID", "That is not a backup key."))
		return
	}
	fp := crypto.KeyFingerprint(raw)
	p := authz.From(c)
	actor, _ := bson.ObjectIDFromHex(p.UserID)
	if _, err := h.touch(c, bson.D{{Key: "hostelId", Value: id}}, bson.D{
		{Key: "$set", Value: bson.D{{Key: "keyFingerprint", Value: fp}, {Key: "keySetAt", Value: h.now()}, {Key: "keySetBy", Value: actor}, {Key: "publicKey", Value: publicKey}}},
		{Key: "$unset", Value: bson.D{{Key: "kitConfirmedAt", Value: 1}}},
	}, true); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.audit(c, p.UserID, id, "BACKUP_KEY_SET", bson.D{{Key: "fingerprint", Value: fp}})
	httpx.OK(c, gin.H{"fingerprint": fp}, "Recovery key saved")
}

// confirmKit: the owner says the recovery kit for this exact key is saved.
func (h *Handler) confirmKit(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	fp, _ := f.Str("fingerprint", valid.S{Min: 4, Max: 40})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	res, err := h.touch(c, bson.D{{Key: "hostelId", Value: id}, {Key: "keyFingerprint", Value: fp}}, bson.D{{Key: "$set", Value: bson.D{{Key: "kitConfirmedAt", Value: h.now()}}}}, false)
	if err == nil && res.MatchedCount == 0 {
		err = fail(409, "BACKUP_KEY_MISMATCH", "That recovery kit is for a different key.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.audit(c, authz.From(c).UserID, id, "BACKUP_KIT_CONFIRMED", bson.D{{Key: "fingerprint", Value: fp}})
	httpx.OK(c, gin.H{"confirmed": true}, "Recovery kit noted")
}

/* ── Drive connection ── */

// oauthState is TS's OAuthState, fields in its JSON order.
type oauthState struct {
	E int64  `json:"e"`
	F string `json:"f"`
	H string `json:"h"`
	U string `json:"u"`
}

func (h *Handler) stateKey() ([]byte, error) {
	if h.JWTSecret == "" {
		return nil, fail(500, "AUTH_NOT_CONFIGURED", "Sign-in is not configured.")
	}
	k := sha256.Sum256([]byte("drive-oauth-state|" + h.JWTSecret))
	return k[:], nil
}

func (h *Handler) signState(s oauthState) (string, error) {
	key, err := h.stateKey()
	if err != nil {
		return "", err
	}
	raw, _ := json.Marshal(s)
	body := base64.RawURLEncoding.EncodeToString(raw)
	m := hmac.New(sha256.New, key)
	m.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil)), nil
}

func (h *Handler) readState(value string) *oauthState {
	body, mac, ok := strings.Cut(value, ".")
	key, err := h.stateKey()
	if !ok || body == "" || mac == "" || err != nil {
		return nil
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte(body))
	given, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.SplitN(mac, ".", 2)[0], "="))
	if err != nil || !hmac.Equal(given, m.Sum(nil)) {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(body, "="))
	var s oauthState
	if err != nil || json.Unmarshal(raw, &s) != nil || s.E <= h.now().UnixMilli() {
		return nil
	}
	return &s
}

func (h *Handler) connect(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// request.json().catch(() => ({})): a missing or broken body means the default.
	body, err := valid.Body(c)
	if err != nil {
		body = map[string]any{}
	}
	f := valid.NewForm(body)
	web := "web"
	from, _ := f.Enum("from", true, &web, "app", "web")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.assertPlan(c, id); err != nil {
		httpx.Fail(c, err)
		return
	}
	state, err := h.signState(oauthState{h.now().Add(stateTTL).UnixMilli(), from, id.Hex(), authz.From(c).UserID})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	link, err := h.Drive.AuthLink(state, h.redirectURI())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"url": link}, "Open Google to connect Drive")
}

// callback is Google's redirect back. No session rides on it: the signed state
// says who started it, and ownership and plan are checked again. Only a word goes
// back in the URL, never a code or token.
func (h *Handler) callback(c *gin.Context) {
	code, state := c.Query("code"), c.Query("state")
	// Read only to pick where to send the owner back; the signature is checked below.
	target := h.AppURL + "/hostel-admin/backup"
	if raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.SplitN(state, ".", 2)[0], "=")); err == nil {
		var s oauthState
		if json.Unmarshal(raw, &s) == nil && s.F == "app" {
			target = appReturn
		}
	}
	word := "connected"
	if code == "" || h.completeConnect(c, code, state) != nil {
		word = "failed"
	}
	// NextResponse.redirect: a bare 307, no body.
	c.Header("Location", target+"?drive="+word)
	c.Status(307)
	c.Writer.WriteHeaderNow()
}

func (h *Handler) completeConnect(ctx context.Context, code, value string) error {
	s := h.readState(value)
	if s == nil {
		return fail(400, "DRIVE_STATE_INVALID", "That Drive link has expired. Start again from Backup.")
	}
	id, err := bson.ObjectIDFromHex(s.H)
	if err != nil {
		return err
	}
	if _, err := hostels.ResolveOwned(ctx, h.DB, s.H, s.U); err != nil {
		return err
	}
	if err := h.assertPlan(ctx, id); err != nil {
		return err
	}
	email, refresh, err := h.Drive.Exchange(ctx, code, h.redirectURI())
	if err != nil {
		return err
	}
	keys, err := crypto.MasterKeys(h.FinanceKey, h.FinancePrev)
	if err != nil {
		return err
	}
	sealed, err := crypto.EncryptSecret(refresh, crypto.Scope{HostelID: s.H, Purpose: tokenPurpose}, keys[0])
	if err != nil {
		return err
	}
	set := bson.D{{Key: "drive.connectedAt", Value: h.now()}}
	if email != "" {
		set = append(set, bson.E{Key: "drive.email", Value: email})
	}
	set = append(set, bson.E{Key: "drive.status", Value: "CONNECTED"}, bson.E{Key: "drive.token", Value: sealed})
	if _, err := h.touch(ctx, bson.D{{Key: "hostelId", Value: id}}, bson.D{{Key: "$set", Value: set}, {Key: "$unset", Value: bson.D{{Key: "drive.error", Value: 1}}}}, true); err != nil {
		return err
	}
	var mail any
	if email != "" {
		mail = email
	}
	h.audit(ctx, s.U, id, "BACKUP_DRIVE_CONNECTED", bson.D{{Key: "email", Value: mail}})
	return nil
}

func (h *Handler) refreshToken(ctx context.Context, hostelID bson.ObjectID) (string, error) {
	var row backupRow
	err := h.DB.Collection("hostelbackups").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && (row.Drive == nil || row.Drive.Token == nil)) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	keys, err := crypto.MasterKeys(h.FinanceKey, h.FinancePrev)
	if err != nil {
		return "", err
	}
	return crypto.DecryptSecret(*row.Drive.Token, crypto.Scope{HostelID: hostelID.Hex(), Purpose: tokenPurpose}, keys)
}

func (h *Handler) disconnect(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if token, err := h.refreshToken(c, id); err == nil && token != "" {
		h.Drive.Revoke(c, token)
	}
	if _, err := h.touch(c, bson.D{{Key: "hostelId", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "drive.status", Value: "NOT_CONNECTED"}}},
		{Key: "$unset", Value: bson.D{{Key: "drive.email", Value: 1}, {Key: "drive.error", Value: 1}, {Key: "drive.token", Value: 1}}}}, false); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.audit(c, authz.From(c).UserID, id, "BACKUP_DRIVE_DISCONNECTED", nil)
	httpx.OK(c, gin.H{"disconnected": true}, "Drive disconnected")
}

// noteDriveError records what Drive said, so the screen can offer Reconnect or say the Drive is full.
func (h *Handler) noteDriveError(ctx context.Context, hostelID bson.ObjectID, err error) {
	var e *httpx.Error
	if !errors.As(err, &e) {
		return
	}
	status := "ERROR"
	if e.ErrorCode == "REVOKED" || e.ErrorCode == "QUOTA_FULL" {
		status = e.ErrorCode
	}
	if _, err := h.touch(ctx, bson.D{{Key: "hostelId", Value: hostelID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "drive.error", Value: e.Message}, {Key: "drive.status", Value: status}}}}, false); err != nil {
		slog.WarnContext(ctx, "backup drive error not noted", "err", err)
	}
}

func (h *Handler) accessToken(ctx context.Context, hostelID bson.ObjectID) (string, error) {
	refresh, err := h.refreshToken(ctx, hostelID)
	if err != nil {
		return "", err
	}
	if refresh == "" {
		return "", driveErr("REVOKED", "Google Drive is not connected.")
	}
	access, err := h.Drive.AccessToken(ctx, refresh)
	if driveCode(err) != "" {
		h.noteDriveError(ctx, hostelID, err)
	}
	return access, err
}

/* ── Backing up ── */

type runResult struct {
	Checked bool
	ID      string
	Error   string
	OK      bool
}

type restored struct {
	Added      int  `json:"added"`
	Kept       int  `json:"kept"`
	Refused    int  `json:"refused"`
	Restorable bool `json:"restorable"`
}

func (h *Handler) insertRun(ctx context.Context, fields bson.D) (bson.ObjectID, error) {
	now := h.now()
	id := bson.NewObjectID()
	doc := append(bson.D{{Key: "_id", Value: id}}, fields...)
	doc = append(doc, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	_, err := h.DB.Collection("hostelbackupruns").InsertOne(ctx, doc)
	return id, err
}

// Run is runHostelBackup: export, seal, upload, record. A failure is a FAILED run
// row and {ok:false}, not an error, so the screen shows it in the history.
func (h *Handler) Run(ctx context.Context, hostelID bson.ObjectID, trigger, actor string) (*runResult, error) {
	var cfg backupRow
	err := h.DB.Collection("hostelbackups").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}, options.FindOne().SetProjection(bson.D{{Key: "drive.token", Value: 0}})).Decode(&cfg)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if cfg.PublicKey == "" {
		return nil, fail(409, "BACKUP_KEY_MISSING", "Set up the recovery key first.")
	}
	if err := h.assertPlan(ctx, hostelID); err != nil {
		return nil, err
	}
	if _, err := h.touch(ctx, bson.D{{Key: "hostelId", Value: hostelID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lastRunAt", Value: h.now()}}}}, false); err != nil {
		return nil, err
	}
	res, err := h.make(ctx, hostelID, trigger, actor, &cfg)
	if err == nil {
		return res, nil
	}
	message := "The backup could not be made."
	if driveCode(err) != "" {
		message = err.Error()
		h.noteDriveError(ctx, hostelID, err)
	} else {
		slog.ErrorContext(ctx, "backup failed", "hostelId", hostelID.Hex(), "err", err)
	}
	if _, err := h.insertRun(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: "FAILED"}, {Key: "trigger", Value: trigger},
		{Key: "chunks", Value: bson.A{}}, {Key: "keyFingerprint", Value: cfg.KeyFingerprint}, {Key: "checked", Value: false}, {Key: "error", Value: message}}); err != nil {
		return nil, err
	}
	return &runResult{Error: message}, nil
}

func (h *Handler) make(ctx context.Context, hostelID bson.ObjectID, trigger, actor string, cfg *backupRow) (*runResult, error) {
	public := crypto.FromBase64(cfg.PublicKey)
	plain, chunks, counts, createdAt, err := buildArchive(ctx, h.DB, hostelID, h.now())
	if err != nil {
		return nil, err
	}
	file, err := crypto.SealArchive(plain, public, hostelID.Hex(), createdAt)
	clear(plain) // the plaintext is gone before anything leaves the server
	if err != nil {
		return nil, err
	}
	name := "hostelpalika-backup-" + strings.NewReplacer(":", "-", "T", "-").Replace(createdAt[:16]) + ".hpbk"
	access, err := h.accessToken(ctx, hostelID)
	if err != nil {
		return nil, err
	}
	up, err := h.Drive.Upload(ctx, access, name, file)
	if err != nil {
		return nil, err
	}
	sum := md5.Sum(file)
	checked := up.MD5Checksum == hex.EncodeToString(sum[:]) && up.Size == strconv.Itoa(len(file))
	digest := sha512.Sum512(file)
	runID, err := h.insertRun(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "status", Value: "OK"}, {Key: "trigger", Value: trigger}, {Key: "fileName", Value: name},
		{Key: "bytes", Value: len(file)}, {Key: "sha512", Value: hex.EncodeToString(digest[:])}, {Key: "chunks", Value: chunks}, {Key: "keyFingerprint", Value: cfg.KeyFingerprint},
		{Key: "driveFileId", Value: up.ID}, {Key: "checked", Value: checked}, {Key: "counts", Value: bson.D(counts)}})
	if err != nil {
		return nil, err
	}
	if _, err := h.touch(ctx, bson.D{{Key: "hostelId", Value: hostelID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "drive.status", Value: "CONNECTED"}}}, {Key: "$unset", Value: bson.D{{Key: "drive.error", Value: 1}}}}, false); err != nil {
		return nil, err
	}
	h.audit(ctx, actor, hostelID, "BACKUP_MADE", bson.D{{Key: "bytes", Value: len(file)}, {Key: "checked", Value: checked}, {Key: "runId", Value: runID.Hex()}, {Key: "trigger", Value: trigger}})
	if err := h.prune(ctx, hostelID, access); err != nil {
		slog.WarnContext(ctx, "backup prune failed", "hostelId", hostelID.Hex(), "err", err)
	}
	return &runResult{Checked: checked, ID: runID.Hex(), OK: true}, nil
}

// prune keeps the newest keepOnDrive files; older history rows stay, marked as no longer on Drive.
func (h *Handler) prune(ctx context.Context, hostelID bson.ObjectID, access string) error {
	runs := h.DB.Collection("hostelbackupruns")
	cur, err := runs.Find(ctx, bson.D{{Key: "driveFileId", Value: bson.D{{Key: "$exists", Value: true}}}, {Key: "hostelId", Value: hostelID}, {Key: "status", Value: "OK"}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(keepOnDrive).SetProjection(bson.D{{Key: "driveFileId", Value: 1}}))
	if err != nil {
		return err
	}
	var old []runRow
	if err := cur.All(ctx, &old); err != nil {
		return err
	}
	for _, r := range old {
		if err := h.Drive.Delete(ctx, access, r.DriveFileID); err != nil {
			return err
		}
		if _, err := runs.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$unset", Value: bson.D{{Key: "driveFileId", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: h.now()}}}}); err != nil {
			return err
		}
	}
	return nil
}

func (h *Handler) backUpNow(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	res, err := h.Run(c, id, "MANUAL", authz.From(c).UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.OK {
		httpx.OK(c, struct {
			Checked bool   `json:"checked"`
			ID      string `json:"id"`
			OK      bool   `json:"ok"`
		}{res.Checked, res.ID, true}, "Backup finished")
		return
	}
	httpx.OK(c, struct {
		Error string `json:"error"`
		OK    bool   `json:"ok"`
	}{res.Error, false}, "Backup finished")
}

/* ── Download and restore ── */

// ownRun is scoped in the query: another hostel's run is simply not found.
func (h *Handler) ownRun(ctx context.Context, hostelID bson.ObjectID, runID string, projection bson.D) (*runRow, error) {
	oid, err := bson.ObjectIDFromHex(runID)
	if err != nil {
		return nil, fail(404, "BACKUP_NOT_FOUND", "Backup not found.")
	}
	var r runRow
	err = h.DB.Collection("hostelbackupruns").FindOne(ctx, bson.D{{Key: "_id", Value: oid}, {Key: "hostelId", Value: hostelID}, {Key: "status", Value: "OK"}},
		options.FindOne().SetProjection(projection)).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, fail(404, "BACKUP_NOT_FOUND", "Backup not found.")
	}
	return &r, err
}

// file streams the encrypted file from Drive. It is ciphertext: we cannot read it,
// neither can anyone without the kit.
func (h *Handler) file(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := h.ownRun(c, id, c.Param("runId"), bson.D{{Key: "driveFileId", Value: 1}, {Key: "fileName", Value: 1}, {Key: "bytes", Value: 1}, {Key: "sha512", Value: 1}})
	if err == nil && r.DriveFileID == "" {
		err = fail(410, "BACKUP_NOT_ON_DRIVE", "This backup is no longer kept in Drive.")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	access, err := h.accessToken(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	res, err := h.Drive.Download(c, access, r.DriveFileID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	defer res.Body.Close()
	name, sum := "backup.hpbk", ""
	if r.FileName != nil {
		name = *r.FileName
	}
	if r.SHA512 != nil {
		sum = *r.SHA512
	}
	w := c.Writer
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Backup-Sha512", sum)
	if r.Bytes != nil && *r.Bytes > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(*r.Bytes, 10))
	}
	w.WriteHeader(200)
	if _, err := io.Copy(w, res.Body); err != nil {
		slog.WarnContext(c, "backup download cut", "err", err)
	}
}

// restore takes one chunk of a decrypted backup, sent back by the owner's phone.
// Accepted only when its hash is the one recorded for this hostel's run, and every
// row's hostel is still this hostel or its branch. Only missing rows are added;
// nothing existing is changed or deleted.
func (h *Handler) restore(c *gin.Context) {
	id, err := h.ownerHostel(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	coll, _ := f.Str("collection", valid.S{Min: 1, Max: 60})
	data, _ := f.Str("data", valid.S{Min: 2})
	index, _ := f.Num("index", valid.N{Int: true, Min: valid.P(0)})
	runID, _ := f.Str("runId", valid.S{Min: 1})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	run, err := h.ownRun(c, id, runID, bson.D{{Key: "chunks", Value: 1}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var recorded *packedChunk
	for i := range run.Chunks {
		if run.Chunks[i].Collection == coll && float64(run.Chunks[i].Index) == index {
			recorded = &run.Chunks[i]
			break
		}
	}
	if recorded == nil || recorded.SHA256 != sha256Hex([]byte(data)) {
		httpx.Fail(c, fail(422, "BACKUP_CHUNK_MISMATCH", "This part of the backup does not match what was backed up."))
		return
	}
	entry := findCollection(coll)
	if entry == nil || !entry.Restore {
		httpx.OK(c, restored{0, recorded.Rows, 0, false}, "Restored")
		return
	}
	rows, err := parseChunk(data)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ids, err := tenantHostelIDs(c, h.DB, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	allowed := map[bson.ObjectID]bool{}
	for _, x := range ids {
		allowed[x] = true
	}
	rowIDs := make(bson.A, len(rows))
	for i, row := range rows {
		owner, ok := row.Lookup(entry.Key).ObjectIDOK()
		if !ok || !allowed[owner] {
			httpx.Fail(c, fail(422, "BACKUP_OTHER_HOSTEL", "This backup holds rows of a hostel that is not yours."))
			return
		}
		rowIDs[i] = row.Lookup("_id")
	}
	target := h.DB.Collection(entry.Coll)
	cur, err := target.Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: rowIDs}}}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	var present []bson.Raw
	if err == nil {
		err = cur.All(c, &present)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	have := map[string]bool{}
	for _, p := range present {
		have[p.Lookup("_id").String()] = true
	}
	var missing []any
	for _, row := range rows {
		if !have[row.Lookup("_id").String()] {
			missing = append(missing, row)
		}
	}
	added := 0
	if len(missing) > 0 {
		_, err := target.InsertMany(c, missing, options.InsertMany().SetOrdered(false))
		added = len(missing)
		var bwe mongo.BulkWriteException
		if errors.As(err, &bwe) && bwe.WriteConcernError == nil {
			// A unique index refused some rows (a newer row took their place); the rest went in.
			added -= len(bwe.WriteErrors)
		} else if err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	h.audit(c, authz.From(c).UserID, id, "BACKUP_RESTORED", bson.D{{Key: "added", Value: added}, {Key: "collection", Value: coll}, {Key: "index", Value: int(index)}, {Key: "runId", Value: runID}})
	httpx.OK(c, restored{added, len(rows) - len(missing), len(missing) - added, true}, "Restored")
}
