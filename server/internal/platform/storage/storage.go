// Package storage is R2, a port of apps/web/src/lib/r2.ts and lib/uploads/{sniff,verify}.ts.
//
// Two buckets, and the split is a security boundary: PUBLIC objects are served
// from R2_PUBLIC_URL; PRIVATE and PROTECTED ones live in the private bucket and
// are only ever read through a short presigned URL. Never build a public URL for
// a private key.
package storage

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// AccessLevel is a FileAsset's access level.
type AccessLevel string

const (
	Private   AccessLevel = "PRIVATE"
	Protected AccessLevel = "PROTECTED"
	Public    AccessLevel = "PUBLIC"
)

const (
	uploadURLTTL = 600 * time.Second
	// PrivateReadURLTTL is how long a presigned read lives.
	PrivateReadURLTTL = 900 * time.Second
)

// ErrNotConfigured is returned by every call when R2 env is missing.
var ErrNotConfigured = errors.New("R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set")

// R2 is safe for concurrent use.
type R2 struct {
	cfg     config.R2
	client  *s3.Client
	presign *s3.PresignClient
}

// New builds the client; it does not dial. A nil client field means not configured.
func New(cfg config.R2) *R2 { return newR2(cfg, false) }

// newR2's pathStyle exists for tests against a local fake; R2 itself takes either.
func newR2(cfg config.R2, pathStyle bool) *R2 {
	r := &R2{cfg: cfg}
	if cfg.Endpoint == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return r
	}
	r.client = s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(cfg.Endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		Retryer:      retry.NewStandard(func(o *retry.StandardOptions) { o.MaxAttempts = 3 }),
		HTTPClient:   &http.Client{Timeout: 30 * time.Second},
		UsePathStyle: pathStyle,
	})
	r.presign = s3.NewPresignClient(r.client)
	return r
}

func (r *R2) ready() error {
	if r.client == nil {
		return ErrNotConfigured
	}
	return nil
}

func bucketName(name, env string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("%s must be set. See docs/ENVIRONMENT.md.", env)
	}
	return name, nil
}

func (r *R2) PublicBucket() (string, error) {
	return bucketName(r.cfg.BucketPublic, "R2_BUCKET_PUBLIC")
}
func (r *R2) PrivateBucket() (string, error) {
	return bucketName(r.cfg.BucketPrivate, "R2_BUCKET_PRIVATE")
}

// BucketFor puts only PUBLIC objects in the public bucket.
func (r *R2) BucketFor(level AccessLevel) (string, error) {
	if level == Public {
		return r.PublicBucket()
	}
	return r.PrivateBucket()
}

// WithKeyPrefix scopes a key under R2_KEY_PREFIX (config already trims its slashes);
// an already-prefixed key is left alone.
func (r *R2) WithKeyPrefix(key string) string {
	bare := strings.TrimLeft(key, "/")
	prefix := r.cfg.KeyPrefix
	if prefix == "" || bare == prefix || strings.HasPrefix(bare, prefix+"/") {
		return bare
	}
	return prefix + "/" + bare
}

// GenerateFileKey is <prefix>/<uuid>.<ext>, the extension lower-cased from fileName.
func (r *R2) GenerateFileKey(prefix, fileName string) string {
	parts := strings.Split(fileName, ".")
	ext := strings.ToLower(parts[len(parts)-1])
	return r.WithKeyPrefix(prefix + "/" + uuid4() + "." + ext)
}

// PresignUpload is a PUT URL valid for ten minutes.
func (r *R2) PresignUpload(ctx context.Context, bucket, key, contentType string) (string, error) {
	if err := r.ready(); err != nil {
		return "", err
	}
	req, err := r.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: &bucket, Key: &key, ContentType: &contentType,
	}, s3.WithPresignExpires(uploadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// PresignRead is a GET URL valid for PrivateReadURLTTL; a downloadName makes it an attachment.
func (r *R2) PresignRead(ctx context.Context, bucket, key, downloadName string) (string, error) {
	if err := r.ready(); err != nil {
		return "", err
	}
	in := &s3.GetObjectInput{Bucket: &bucket, Key: &key}
	if downloadName != "" {
		in.ResponseContentDisposition = aws.String("attachment; filename*=UTF-8''" + httpx.EncodeURIComponent(downloadName))
	}
	req, err := r.presign.PresignGetObject(ctx, in, s3.WithPresignExpires(PrivateReadURLTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// PublicURL is R2_PUBLIC_URL/key — for public-bucket keys only.
func (r *R2) PublicURL(key string) (string, error) {
	if r.cfg.PublicURL == "" {
		return "", errors.New("R2_PUBLIC_URL must be set to build public object URLs")
	}
	return r.cfg.PublicURL + "/" + strings.TrimLeft(key, "/"), nil
}

// Put stores an object; cacheControl "" leaves the header off.
func (r *R2) Put(ctx context.Context, bucket, key string, body []byte, contentType, cacheControl string) error {
	if err := r.ready(); err != nil {
		return err
	}
	in := &s3.PutObjectInput{
		Bucket: &bucket, Key: &key, Body: bytes.NewReader(body), ContentType: &contentType,
		ContentLength: aws.Int64(int64(len(body))),
	}
	if cacheControl != "" {
		in.CacheControl = &cacheControl
	}
	_, err := r.client.PutObject(ctx, in)
	return err
}

// Get streams an object; the caller closes it.
func (r *R2) Get(ctx context.Context, bucket, key string) (io.ReadCloser, error) {
	if err := r.ready(); err != nil {
		return nil, err
	}
	out, err := r.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}

// ReadStoredObject is the whole object, or nil when it cannot be read.
func (r *R2) ReadStoredObject(ctx context.Context, bucket, key string) []byte {
	body, err := r.Get(ctx, bucket, key)
	if err != nil {
		return nil
	}
	defer body.Close()
	b, err := io.ReadAll(body)
	if err != nil {
		return nil
	}
	return b
}

func (r *R2) Delete(ctx context.Context, bucket, key string) error {
	if err := r.ready(); err != nil {
		return err
	}
	_, err := r.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &bucket, Key: &key})
	return err
}

// uuid4 is crypto.randomUUID().
func uuid4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
