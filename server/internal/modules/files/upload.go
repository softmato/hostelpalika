package files

import (
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ratelimit"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

const maxSize = 5 * 1024 * 1024

var (
	allowedTypes = []string{"image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain"}
	publicTypes  = []string{"image/jpeg", "image/png", "image/webp"}
)

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Handler is public/files/upload: unauthenticated, rate-limited uploads for the
// registration forms, where there is no hostel (and often no account) to scope
// a presign to.
type Handler struct {
	db      *mongo.Database
	r2      *storage.R2
	r2cfg   config.R2
	limiter *ratelimit.Limiter
	claims  Claims
}

func NewHandler(db *mongo.Database, r2 *storage.R2, r2cfg config.R2, limiter *ratelimit.Limiter, claims Claims) *Handler {
	return &Handler{db, r2, r2cfg, limiter, claims}
}

func (h *Handler) Register(v1 *gin.RouterGroup) { v1.POST("/public/files/upload", h.upload) }

func firstFile(h []*multipart.FileHeader) *multipart.FileHeader {
	if len(h) == 0 {
		return nil
	}
	return h[0]
}

func fail(status int, code, msg string) *httpx.Error { return httpx.NewError(status, code, msg, nil) }

type privateOut struct {
	ClaimToken  string `json:"claimToken"`
	FileAssetID string `json:"fileAssetId"`
	FileName    string `json:"fileName"`
	MimeType    string `json:"mimeType"`
	SizeBytes   int64  `json:"sizeBytes"`
}

type publicOut struct {
	URL       string `json:"url"`
	FileName  string `json:"fileName"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

// configured is r2Configured: the endpoint, the key id and that bucket's name.
func (h *Handler) configured(bucket string) bool {
	return h.r2cfg.Endpoint != "" && h.r2cfg.AccessKeyID != "" && bucket != ""
}

func (h *Handler) upload(c *gin.Context) {
	if err := h.limiter.PublicForm(c, "public-file-upload"); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := c.Request.ParseMultipartForm(8 << 20); err != nil {
		httpx.Fail(c, err) // request.formData() throws on anything else: the generic 500
		return
	}
	form := c.Request.MultipartForm
	public := len(form.Value["visibility"]) > 0 && form.Value["visibility"][0] == "public"
	var header = firstFile(form.File["file"])
	if header == nil {
		// A text field named "file" is a truthy non-File: its type is undefined.
		if v := form.Value["file"]; len(v) > 0 && v[0] != "" {
			httpx.Fail(c, fail(http.StatusUnprocessableEntity, "FILE_TYPE_NOT_ALLOWED", "File type not allowed. Accepted: JPEG, PNG, WebP, PDF, TXT"))
			return
		}
		httpx.Fail(c, fail(http.StatusUnprocessableEntity, "VALIDATION_ERROR", "File is required"))
		return
	}
	mimeType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	if !has(allowedTypes, mimeType) {
		httpx.Fail(c, fail(http.StatusUnprocessableEntity, "FILE_TYPE_NOT_ALLOWED", "File type not allowed. Accepted: JPEG, PNG, WebP, PDF, TXT"))
		return
	}
	if public && !has(publicTypes, mimeType) {
		httpx.Fail(c, fail(http.StatusUnprocessableEntity, "FILE_TYPE_NOT_ALLOWED", "Only JPEG, PNG or WebP images can be published."))
		return
	}
	if header.Size > maxSize {
		httpx.Fail(c, fail(http.StatusUnprocessableEntity, "FILE_TOO_LARGE", "File size exceeds 5 MB limit"))
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
	// `file.type` is the client's claim; the bytes decide.
	if mismatch := storage.ContentTypeMismatch(mimeType, buf); mismatch != "" {
		httpx.Fail(c, fail(http.StatusUnprocessableEntity, "UPLOAD_CONTENT_MISMATCH", mismatch))
		return
	}
	size := int64(len(buf))
	if size != header.Size {
		size = header.Size
	}
	if !public {
		// No disk fallback: a private document must never be served from our own origin.
		if !h.configured(h.r2cfg.BucketPrivate) {
			httpx.Fail(c, fail(http.StatusServiceUnavailable, "STORAGE_NOT_CONFIGURED", "Document storage is not configured on this deployment."))
			return
		}
		out, err := h.storePrivate(c, header.Filename, mimeType, buf, size)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		httpx.Write(c, http.StatusCreated, out, "File uploaded")
		return
	}
	// ponytail: TS falls back to writing under Next's public/uploads when R2 is
	// off; the Go server has no such directory, so an unconfigured public bucket
	// is a 503 here. Production always has R2.
	if !h.configured(h.r2cfg.BucketPublic) {
		httpx.Fail(c, fail(http.StatusServiceUnavailable, "STORAGE_NOT_CONFIGURED", "Document storage is not configured on this deployment."))
		return
	}
	out, err := h.storePublic(c, header.Filename, mimeType, buf, size)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Write(c, http.StatusCreated, out, "File uploaded")
}

func (h *Handler) insertAsset(c *gin.Context, level, bucket, key, name, mime, kind string, size int64) (bson.ObjectID, error) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "accessLevel", Value: level}, {Key: "bucket", Value: bucket}, {Key: "fileName", Value: name}, {Key: "key", Value: key}}
	if kind != "" {
		doc = append(doc, bson.E{Key: "kind", Value: kind})
	}
	doc = append(doc, bson.E{Key: "mimeType", Value: mime}, bson.E{Key: "sizeBytes", Value: size}, bson.E{Key: "status", Value: "ACTIVE"},
		bson.E{Key: "storageProvider", Value: "CLOUDFLARE_R2"},
		// The bytes are in hand and were just written, so the upload is complete.
		// Without this the abandoned-upload sweep would delete it.
		bson.E{Key: "uploadCompletedAt", Value: now}, bson.E{Key: "variants", Value: bson.A{}}, bson.E{Key: "isDeleted", Value: false},
		bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	_, err := h.db.Collection("fileassets").InsertOne(c, doc)
	return id, err
}

func (h *Handler) storePrivate(c *gin.Context, name, mime string, buf []byte, size int64) (privateOut, error) {
	bucket, err := h.r2.PrivateBucket()
	if err != nil {
		return privateOut{}, err
	}
	key := h.r2.GenerateFileKey("registration-documents", name)
	if err := h.r2.Put(c, bucket, key, buf, mime, ""); err != nil {
		return privateOut{}, err
	}
	id, err := h.insertAsset(c, "PRIVATE", bucket, key, name, mime, "REGISTRATION_DOCUMENT", size)
	if err != nil {
		return privateOut{}, err
	}
	return privateOut{h.claims.Issue(id.Hex()), id.Hex(), name, mime, size}, nil
}

func (h *Handler) storePublic(c *gin.Context, name, mime string, buf []byte, size int64) (publicOut, error) {
	bucket, err := h.r2.PublicBucket()
	if err != nil {
		return publicOut{}, err
	}
	key := h.r2.GenerateFileKey("public-uploads", name)
	if err := h.r2.Put(c, bucket, key, buf, mime, ""); err != nil {
		return publicOut{}, err
	}
	url := key
	if h.r2cfg.PublicURL != "" {
		url = h.r2cfg.PublicURL + "/" + key
	}
	if _, err := h.insertAsset(c, "PUBLIC", bucket, key, name, mime, "", size); err != nil {
		return publicOut{}, err
	}
	return publicOut{url, name, mime, size}, nil
}
