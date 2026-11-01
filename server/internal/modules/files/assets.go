package files

import (
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/images"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Assets is the signed-in side of file storage: presign, the upload door, the
// completion check, variants, and the one route that hands out read URLs.
type Assets struct {
	DB     *mongo.Database
	R2     *storage.R2
	R2Cfg  config.R2
	Limits config.Uploads
	Guards *authz.Guards
	Claims Claims
}

func (a *Assets) Register(v1 *gin.RouterGroup) {
	v1.POST("/files/presign", a.presign)
	v1.POST("/files/upload", a.upload)
	v1.POST("/files/:assetId/complete", a.complete)
	v1.POST("/files/:assetId/optimize", a.optimize)
	v1.GET("/files/:assetId/url", httpx.ETag(), a.url)
}

var (
	assetKinds     = []string{"GENERIC", "COMPLAINT_NOTE", "MAINTENANCE_NOTE", "PAYMENT_PROOF", "PAYMENT_QR", "STATEMENT", "REGISTRATION_DOCUMENT", "BOOKING_PAYMENT_PROOF", "BOOKING_TRANSFER_PROOF", "EXPENSE_RECEIPT"}
	financialKinds = []string{"PAYMENT_PROOF", "PAYMENT_QR", "STATEMENT", "EXPENSE_RECEIPT"}
	platformKinds  = []string{"BOOKING_PAYMENT_PROOF", "BOOKING_TRANSFER_PROOF"}
	staffOnlyKinds = []string{"REGISTRATION_DOCUMENT", "COMPLAINT_NOTE", "MAINTENANCE_NOTE", "PAYMENT_PROOF", "STATEMENT", "EXPENSE_RECEIPT"}
	uploadTypes    = []string{"image/jpeg", "image/png", "image/webp", "application/pdf"}
)

const uploadMax = 10 * 1024 * 1024

func errResponse(status int, code, msg string) error { return httpx.NewError(status, code, msg, nil) }

// truthyString reads a duck-typed body field the way `if (!x)` sees it.
func truthyString(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// resolveHostel is resolveAssetHostelId: "" when the asset belongs to no hostel.
func (a *Assets) resolveHostel(c *gin.Context, p *authz.Principal, requested string) (string, error) {
	if requested != "" {
		if p.Role == authz.Superadmin {
			return requested, nil
		}
		reach := p.AllHostelIDs
		if reach == nil {
			reach = p.HostelIDs
		}
		if slices.Contains(reach, requested) {
			return requested, nil
		}
		return "", nil
	}
	if p.Role == authz.Resident {
		if uid, err := bson.ObjectIDFromHex(p.UserID); err == nil {
			var row struct {
				HostelID bson.ObjectID `bson:"hostelId"`
			}
			err := a.DB.Collection("residents").FindOne(c, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: uid}}).Decode(&row)
			if err == nil && slices.Contains(p.HostelIDs, row.HostelID.Hex()) {
				return row.HostelID.Hex(), nil
			}
			if err != nil && err != mongo.ErrNoDocuments {
				return "", err
			}
		}
	}
	if len(p.HostelIDs) == 1 {
		return p.HostelIDs[0], nil
	}
	return "", nil
}

type presigned struct {
	AssetID      string `json:"assetId"`
	Key          string `json:"key"`
	PresignedURL string `json:"presignedUrl"`
}

func (a *Assets) presign(c *gin.Context) {
	p, err := a.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	raw, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, _ := raw.(map[string]any)
	fileName, mimeType := truthyString(body, "fileName"), truthyString(body, "mimeType")
	size, _ := body["sizeBytes"].(float64)
	kind, requested := truthyString(body, "kind"), truthyString(body, "hostelId")
	if fileName == "" || mimeType == "" || size == 0 {
		httpx.Fail(c, errResponse(422, "VALIDATION_ERROR", "fileName, mimeType, and sizeBytes are required"))
		return
	}
	if v := storage.ValidateMetadata(a.Limits, mimeType, int64(size)); v != "" {
		httpx.Fail(c, errResponse(422, "FILE_TYPE_NOT_ALLOWED", v))
		return
	}
	platformOnly := slices.Contains(platformKinds, kind)
	hostelID := ""
	if !platformOnly {
		if hostelID, err = a.resolveHostel(c, p, requested); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if requested != "" && hostelID == "" && !platformOnly {
		httpx.Fail(c, errResponse(403, "FORBIDDEN", "Access denied"))
		return
	}
	if slices.Contains(financialKinds, kind) && hostelID == "" {
		httpx.Fail(c, errResponse(422, "HOSTEL_SCOPE_REQUIRED", "A hostelId is required for payment-related uploads."))
		return
	}
	level := truthyString(body, "accessLevel")
	if level == "" {
		level = "PRIVATE"
	}
	bucket, err := a.R2.BucketFor(storage.AccessLevel(level))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	key := a.R2.GenerateFileKey("uploads", fileName)
	id, err := a.insert(c, bson.D{{Key: "bucket", Value: bucket}, {Key: "key", Value: key}, {Key: "fileName", Value: fileName}}, hostelID, kind, mimeType, size, level, p.UserID, nil)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	url, err := a.R2.PresignUpload(c, bucket, key, mimeType)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, presigned{id.Hex(), key, url}, "Presigned URL generated")
}

func (a *Assets) insert(c *gin.Context, head bson.D, hostelID, kind, mime string, size float64, level, userID string, extra bson.D) (bson.ObjectID, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	uid, err := httpx.OID(userID, "user id")
	if err != nil {
		return id, err
	}
	doc := bson.D{{Key: "_id", Value: id}, {Key: "storageProvider", Value: "CLOUDFLARE_R2"}}
	doc = append(doc, head...)
	if hid, err := bson.ObjectIDFromHex(hostelID); err == nil {
		doc = append(doc, bson.E{Key: "hostelId", Value: hid})
	}
	if slices.Contains(assetKinds, kind) {
		doc = append(doc, bson.E{Key: "kind", Value: kind})
	}
	doc = append(doc, bson.E{Key: "mimeType", Value: mime}, bson.E{Key: "sizeBytes", Value: size}, bson.E{Key: "accessLevel", Value: level},
		bson.E{Key: "status", Value: "ACTIVE"}, bson.E{Key: "createdBy", Value: uid}, bson.E{Key: "ownerId", Value: uid})
	doc = append(doc, extra...)
	doc = append(doc, bson.E{Key: "variants", Value: bson.A{}}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	_, err = a.DB.Collection("fileassets").InsertOne(c, doc)
	return id, err
}

// measurements is what every door records about bytes it has seen.
func measurements(b []byte, insight *images.Insight) bson.D {
	out := bson.D{}
	if insight != nil {
		out = append(out, bson.E{Key: "imageInsight", Value: bson.D{{Key: "contrast", Value: insight.Contrast}, {Key: "height", Value: insight.Height},
			{Key: "nearBlank", Value: insight.NearBlank}, {Key: "width", Value: insight.Width}}})
	}
	if p := finance.ReadProvenance(b); p != nil {
		out = append(out, bson.E{Key: "provenance", Value: p})
	}
	if h := finance.PerceptualHash(b); h != "" {
		out = append(out, bson.E{Key: "perceptualHash", Value: h})
	}
	if k := finance.SystemDocumentKind(b); k != "" {
		out = append(out, bson.E{Key: "systemDocumentKind", Value: k})
	}
	return out
}

type uploaded struct {
	URL       string `json:"url"`
	FileName  string `json:"fileName"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

func (a *Assets) upload(c *gin.Context) {
	p, err := a.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if p == nil {
		httpx.Fail(c, errResponse(401, "UNAUTHENTICATED", "Authentication required"))
		return
	}
	if err := c.Request.ParseMultipartForm(32 << 20); err != nil {
		if !errors.Is(err, http.ErrNotMultipart) || c.ContentType() != "application/x-www-form-urlencoded" {
			httpx.Fail(c, err) // request.formData() throws
			return
		}
		_ = c.Request.ParseForm()
	}
	level := "PUBLIC"
	if vals := c.Request.PostForm["accessLevel"]; len(vals) > 0 {
		level = vals[0]
	}
	if c.Request.MultipartForm != nil {
		if vals := c.Request.MultipartForm.Value["accessLevel"]; len(vals) > 0 {
			level = vals[0]
		}
	}
	if c.Request.MultipartForm == nil || firstFile(c.Request.MultipartForm.File["file"]) == nil {
		httpx.Fail(c, errResponse(422, "VALIDATION_ERROR", "File is required"))
		return
	}
	header := firstFile(c.Request.MultipartForm.File["file"])
	mimeType := header.Header.Get("Content-Type")
	if !slices.Contains(uploadTypes, mimeType) {
		httpx.Fail(c, errResponse(422, "FILE_TYPE_NOT_ALLOWED", "File type not allowed. Accepted: JPEG, PNG, WebP, PDF"))
		return
	}
	if header.Size > uploadMax {
		httpx.Fail(c, errResponse(422, "FILE_TOO_LARGE", "File size exceeds 10 MB limit"))
		return
	}
	f, err := header.Open()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	buf, err := io.ReadAll(f)
	_ = f.Close()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if m := storage.ContentTypeMismatch(mimeType, buf); m != "" {
		httpx.Fail(c, errResponse(422, "UPLOAD_CONTENT_MISMATCH", m))
		return
	}
	var insight *images.Insight
	if images.IsInspectable(mimeType) {
		if insight = images.Inspect(buf); insight == nil {
			httpx.Fail(c, errResponse(422, "UPLOAD_IMAGE_UNDECODABLE", undecodable))
			return
		}
	}
	// ponytail: TS falls back to Next's public/uploads when R2 is off; the Go server
	// has no such directory (same call as the public door). Production always has R2.
	bucket, err := a.R2.BucketFor(storage.AccessLevel(level))
	if err != nil {
		httpx.Fail(c, errResponse(http.StatusServiceUnavailable, "STORAGE_NOT_CONFIGURED", "Document storage is not configured on this deployment."))
		return
	}
	key := a.R2.GenerateFileKey("uploads", header.Filename)
	if err := a.R2.Put(c, bucket, key, buf, mimeType, ""); err != nil {
		httpx.Fail(c, err)
		return
	}
	url := key
	if level == "PUBLIC" && a.R2Cfg.PublicURL != "" {
		url = strings.TrimRight(a.R2Cfg.PublicURL, "/") + "/" + key
	}
	extra := append(bson.D{{Key: "contentHash", Value: storage.HashBytes(buf)}}, measurements(buf, insight)...)
	extra = append(extra, bson.E{Key: "uploadCompletedAt", Value: time.Now().UTC()})
	if _, err := a.insert(c, bson.D{{Key: "bucket", Value: bucket}, {Key: "key", Value: key}, {Key: "fileName", Value: header.Filename}}, "", "", mimeType, float64(header.Size), level, p.UserID, extra); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, uploaded{url, header.Filename, mimeType, header.Size}, "File uploaded")
}

const undecodable = "This image could not be opened — it may be damaged or incomplete. Please upload it again."

type assetRow struct {
	ID                bson.ObjectID          `bson:"_id"`
	AccessLevel       string                 `bson:"accessLevel"`
	Bucket            string                 `bson:"bucket"`
	ContentHash       *string                `bson:"contentHash"`
	HostelID          *bson.ObjectID         `bson:"hostelId"`
	Key               string                 `bson:"key"`
	Kind              string                 `bson:"kind"`
	MimeType          string                 `bson:"mimeType"`
	OwnerID           *bson.ObjectID         `bson:"ownerId"`
	SizeBytes         int64                  `bson:"sizeBytes"`
	UploadCompletedAt *time.Time             `bson:"uploadCompletedAt"`
	Variants          []images.VariantRecord `bson:"variants"`
}

// loadAsset is FileAssetModel.findOne({_id, isDeleted: false, status: "ACTIVE"}).
// A malformed id throws a CastError in TS, which handleRouteError turns into a 500.
func (a *Assets) loadAsset(c *gin.Context) (*assetRow, error) {
	id, err := bson.ObjectIDFromHex(c.Param("assetId"))
	if err != nil {
		return nil, err
	}
	var row assetRow
	err = a.DB.Collection("fileassets").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return nil, errResponse(404, "NOT_FOUND", "File asset not found")
	}
	return &row, err
}

func (a *Assets) signedIn(c *gin.Context) *authz.Principal {
	p, err := a.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return nil
	}
	if p == nil {
		httpx.Fail(c, errResponse(401, "UNAUTHENTICATED", "Authentication required"))
	}
	return p
}

type completed struct {
	AssetID     string  `json:"assetId"`
	ContentHash *string `json:"contentHash,omitempty"`
	MimeType    string  `json:"mimeType"`
	SizeBytes   int64   `json:"sizeBytes"`
}

// complete closes a presigned upload: read the object back, reject it if it
// contradicts the declaration, record what was measured.
func (a *Assets) complete(c *gin.Context) {
	p := a.signedIn(c)
	if p == nil {
		return
	}
	row, err := a.loadAsset(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if row.OwnerID == nil || row.OwnerID.Hex() != p.UserID {
		httpx.Fail(c, errResponse(403, "FORBIDDEN", "Access denied"))
		return
	}
	if row.UploadCompletedAt != nil {
		httpx.OK(c, completed{row.ID.Hex(), row.ContentHash, row.MimeType, row.SizeBytes}, "Upload already verified")
		return
	}
	coll := a.DB.Collection("fileassets")
	tombstone := func() error {
		now := time.Now().UTC()
		_, err := coll.UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: true}, {Key: "status", Value: "DELETED"}, {Key: "deletedAt", Value: now}, {Key: "updatedAt", Value: now}}}})
		return err
	}
	v, err := a.R2.VerifyUploadedObject(c, a.Limits, row.Bucket, row.Key, row.MimeType, row.SizeBytes)
	if err != nil {
		var ve *storage.VerificationError
		if errors.As(err, &ve) {
			if err := tombstone(); err != nil {
				httpx.Fail(c, err)
				return
			}
			httpx.Fail(c, errResponse(422, ve.Code, ve.Message))
			return
		}
		httpx.Fail(c, err)
		return
	}
	var insight *images.Insight
	if images.IsInspectable(v.MimeType) {
		if insight = images.Inspect(v.Bytes); insight == nil {
			if err := tombstone(); err != nil {
				httpx.Fail(c, err)
				return
			}
			httpx.Fail(c, errResponse(422, "UPLOAD_IMAGE_UNDECODABLE", undecodable))
			return
		}
	}
	now := time.Now().UTC()
	set := append(measurements(v.Bytes, insight), bson.E{Key: "contentHash", Value: v.ContentHash}, bson.E{Key: "mimeType", Value: v.MimeType},
		bson.E{Key: "sizeBytes", Value: v.SizeBytes}, bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "updatedAt", Value: now})
	if _, err := coll.UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	hash := v.ContentHash
	httpx.OK(c, completed{row.ID.Hex(), &hash, v.MimeType, v.SizeBytes}, "Upload verified")
}

type originalOut struct {
	Key       string `json:"key"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

type variantOut struct {
	Variant   images.VariantName `json:"variant"`
	Width     int                `json:"width"`
	Height    int                `json:"height"`
	SizeBytes int                `json:"sizeBytes"`
	MimeType  string             `json:"mimeType"`
}

type optimized struct {
	AssetID  string       `json:"assetId"`
	Original originalOut  `json:"original"`
	Variants []variantOut `json:"variants"`
}

func (a *Assets) optimize(c *gin.Context) {
	p := a.signedIn(c)
	if p == nil {
		return
	}
	row, err := a.loadAsset(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if (row.OwnerID == nil || row.OwnerID.Hex() != p.UserID) && p.Role != authz.Superadmin {
		httpx.Fail(c, errResponse(403, "FORBIDDEN", "Access denied"))
		return
	}
	variants, err := images.OptimizeStored(c, a.R2, row.Bucket, row.Key, row.MimeType)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if len(variants) == 0 {
		httpx.Fail(c, errResponse(422, "NOT_OPTIMIZABLE", "File type does not support optimization"))
		return
	}
	stored := bson.A{}
	out := optimized{AssetID: row.ID.Hex(), Original: originalOut{row.Key, row.MimeType, row.SizeBytes}}
	for _, v := range variants {
		stored = append(stored, v)
		out.Variants = append(out.Variants, variantOut{v.Variant, v.Width, v.Height, v.SizeBytes, v.MimeType})
	}
	_, err = a.DB.Collection("fileassets").UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "variants", Value: stored}, {Key: "updatedAt", Value: time.Now().UTC()}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Image optimized")
}

func variantKey(row *assetRow, variant string) string {
	if variant != "ORIGINAL" {
		for _, v := range row.Variants {
			if string(v.Variant) == variant {
				return v.Key
			}
		}
	}
	return row.Key
}

// assignedProvider is the one grant outside a hostel: a MAINTENANCE_NOTE, an
// approved provider, a live request naming this asset, assigned to that provider.
func (a *Assets) assignedProvider(c *gin.Context, row *assetRow, userID string) (bool, error) {
	uid, err := bson.ObjectIDFromHex(userID)
	if row.Kind != "MAINTENANCE_NOTE" || err != nil {
		return false, nil
	}
	var prov struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err = a.DB.Collection("serviceproviders").FindOne(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "APPROVED"}, {Key: "userId", Value: uid}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&prov)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = a.DB.Collection("maintenancerequests").FindOne(c, bson.D{{Key: "isDeleted", Value: false}, {Key: "providerId", Value: prov.ID}, {Key: "voiceNoteAssetId", Value: row.ID}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	return err == nil, err
}

type resolved struct {
	URL string `json:"url"`
}

func (a *Assets) url(c *gin.Context) {
	raw := c.Query("variant")
	if _, present := c.GetQuery("variant"); !present {
		raw = "ORIGINAL"
	}
	variant := strings.ToUpper(raw)
	if !slices.Contains([]string{"ORIGINAL", "THUMBNAIL", "MEDIUM", "LARGE"}, variant) {
		httpx.Fail(c, errResponse(422, "INVALID_VARIANT", "Invalid variant. Must be one of: ORIGINAL, THUMBNAIL, MEDIUM, LARGE"))
		return
	}
	row, err := a.loadAsset(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	target := ""
	if row.AccessLevel == "PUBLIC" && a.R2Cfg.PublicURL != "" {
		target = a.R2Cfg.PublicURL + "/" + variantKey(row, variant)
	}
	if claim := c.Query("claim"); target == "" && claim != "" && row.Kind == "REGISTRATION_DOCUMENT" && row.OwnerID == nil && a.Claims.Valid(row.ID.Hex(), claim) {
		if target, err = a.R2.PresignRead(c, row.Bucket, variantKey(row, variant), ""); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if target == "" {
		p, err := a.Guards.Load(c)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if p == nil {
			httpx.Fail(c, errResponse(401, "UNAUTHENTICATED", "Authentication required for private assets"))
			return
		}
		allowed := row.OwnerID != nil && row.OwnerID.Hex() == p.UserID || slices.Contains(authz.PlatformRoles, p.Role) ||
			row.HostelID != nil && slices.Contains(p.HostelIDs, row.HostelID.Hex()) && (!slices.Contains(staffOnlyKinds, row.Kind) || slices.Contains(authz.HostelStaffRoles, p.Role))
		if !allowed {
			if allowed, err = a.assignedProvider(c, row, p.UserID); err != nil {
				httpx.Fail(c, err)
				return
			}
		}
		if !allowed {
			httpx.Fail(c, errResponse(403, "FORBIDDEN", "Access denied"))
			return
		}
		if target, err = a.R2.PresignRead(c, row.Bucket, variantKey(row, variant), ""); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if c.Query("format") == "json" {
		httpx.OK(c, resolved{target}, "File URL resolved")
		return
	}
	if row.AccessLevel == "PUBLIC" && a.R2Cfg.PublicURL != "" {
		c.Header("Cache-Control", "public, max-age=86400, s-maxage=86400")
	}
	c.Redirect(http.StatusFound, target)
}
