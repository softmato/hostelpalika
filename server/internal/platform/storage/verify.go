package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
)

/* Sniffing: the bytes must be the type the upload claimed (lib/uploads/sniff.ts). */

// Family is a file's real kind, read from its first bytes.
type Family string

const (
	JPEG     Family = "IMAGE_JPEG"
	PNG      Family = "IMAGE_PNG"
	WEBP     Family = "IMAGE_WEBP"
	PDF      Family = "PDF"
	OLE      Family = "OLE"
	ZIP      Family = "ZIP"
	ISOMedia Family = "ISO_MEDIA"
	Matroska Family = "MATROSKA"
	Text     Family = "TEXT"
)

var allowedFamilies = map[string][]Family{
	"application/pdf": {PDF},
	"audio/aac":       {ISOMedia}, "audio/m4a": {ISOMedia}, "audio/mp4": {ISOMedia}, "audio/x-m4a": {ISOMedia},
	"audio/webm":               {Matroska},
	"application/vnd.ms-excel": {OLE, ZIP},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {ZIP},
	"image/jpeg": {JPEG}, "image/png": {PNG}, "image/webp": {WEBP},
	"text/csv": {Text}, "text/plain": {Text},
	"video/mp4": {ISOMedia}, "video/quicktime": {ISOMedia}, "video/webm": {Matroska},
}

func at(b []byte, offset int, s string) bool {
	return len(b) >= offset+len(s) && string(b[offset:offset+len(s)]) == s
}

// SniffFamily reads the first 64 bytes; "" when nothing matches.
func SniffFamily(b []byte) Family {
	b = b[:min(len(b), 64)]
	switch {
	case len(b) < 4:
		return ""
	case at(b, 0, "\xff\xd8\xff"):
		return JPEG
	case at(b, 0, "\x89PNG\r\n\x1a\n"):
		return PNG
	case at(b, 0, "RIFF") && at(b, 8, "WEBP"):
		return WEBP
	case at(b, 0, "%PDF-"):
		return PDF
	case at(b, 0, "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
		return OLE
	case at(b, 0, "PK"):
		return ZIP
	case at(b, 4, "ftyp"):
		return ISOMedia
	case at(b, 0, "\x1a\x45\xdf\xa3"):
		return Matroska
	}
	return ""
}

// LooksTextual: no NUL byte in the first 8 KiB.
func LooksTextual(b []byte) bool { return bytes.IndexByte(b[:min(len(b), 8192)], 0) < 0 }

// ContentTypeMismatch is the reason the bytes are not the declared type, or "".
// An unknown declared type is not this check's business.
func ContentTypeMismatch(declared string, b []byte) string {
	allowed, ok := allowedFamilies[strings.ToLower(declared)]
	if !ok {
		return ""
	}
	if slices.Contains(allowed, Text) {
		if LooksTextual(b) {
			return ""
		}
		return "The uploaded file is not text, though it was sent as a text file."
	}
	family := SniffFamily(b)
	if family == "" {
		return "The uploaded file is not a recognised image, PDF or document. Please upload the original file rather than a renamed copy."
	}
	if !slices.Contains(allowed, family) {
		return "The uploaded file's contents do not match its file type. Please upload the original file rather than a renamed copy."
	}
	return ""
}

/* Metadata rules (packages/shared/src/utils/file-assets.ts) */

// ValidateMetadata is the reason a type/size is refused, or "".
func ValidateMetadata(limits config.Uploads, mimeType string, sizeBytes int64) string {
	mimeType = strings.TrimSpace(strings.ToLower(mimeType))
	if mimeType == "" {
		return "File MIME type is required."
	}
	if sizeBytes <= 0 {
		return "File size must be a positive number of bytes."
	}
	for _, rule := range []struct {
		types []string
		max   int64
		label string
	}{
		{limits.ImageMIME, limits.MaxImageBytes, "Image"},
		{limits.VideoMIME, limits.MaxVideoBytes, "Video"},
		{limits.AudioMIME, limits.MaxAudioBytes, "Audio"},
		{limits.DocumentMIME, limits.MaxDocumentBytes, "Document"},
	} {
		if slices.Contains(rule.types, mimeType) {
			if sizeBytes <= rule.max {
				return ""
			}
			return fmt.Sprintf("%s exceeds the %d byte upload limit.", rule.label, rule.max)
		}
	}
	return "File MIME type is not allowed."
}

/* Verification: what landed in the bucket is what the client declared (lib/uploads/verify.ts). */

// VerificationError maps to UploadVerificationError: Code, status 422.
type VerificationError struct{ Code, Message string }

func (e *VerificationError) Error() string { return e.Message }

// Verified is a checked upload.
type Verified struct {
	Bytes       []byte
	ContentHash string
	MimeType    string
	SizeBytes   int64
}

// HashBytes is the hex sha256 FileAsset.contentHash holds.
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func normalizeMime(v string) string {
	return strings.ToLower(strings.TrimSpace(strings.SplitN(v, ";", 2)[0]))
}

// VerifyUploadedObject checks a presigned upload's type, size, limits and bytes.
func (r *R2) VerifyUploadedObject(ctx context.Context, limits config.Uploads, bucket, key, declaredMime string, declaredSize int64) (Verified, error) {
	fail := func(code, msg string) (Verified, error) { return Verified{}, &VerificationError{code, msg} }
	if err := r.ready(); err != nil {
		return Verified{}, err
	}
	head, err := r.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return fail("UPLOAD_NOT_FOUND", "The uploaded file could not be found in storage. Please try again.")
	}
	mimeType := normalizeMime(deref(head.ContentType))
	var size int64
	if head.ContentLength != nil {
		size = *head.ContentLength
	}
	if mimeType != normalizeMime(declaredMime) {
		return fail("UPLOAD_TYPE_MISMATCH", "The uploaded file is not the type it was declared as.")
	}
	if size != declaredSize {
		return fail("UPLOAD_SIZE_MISMATCH", "The uploaded file is not the size it was declared as.")
	}
	if violation := ValidateMetadata(limits, mimeType, size); violation != "" {
		return fail("FILE_TYPE_NOT_ALLOWED", violation)
	}
	body, err := r.Get(ctx, bucket, key)
	if err != nil {
		return Verified{}, err // TS lets the GetObject error escape too
	}
	defer body.Close()
	b, err := io.ReadAll(body)
	if err != nil {
		return fail("UPLOAD_UNREADABLE", "The uploaded file could not be read back from storage. Please try again.")
	}
	if mismatch := ContentTypeMismatch(mimeType, b); mismatch != "" {
		return fail("UPLOAD_CONTENT_MISMATCH", mismatch)
	}
	return Verified{Bytes: b, ContentHash: HashBytes(b), MimeType: mimeType, SizeBytes: size}, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
