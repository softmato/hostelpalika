package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/platform/config"
)

// fakeS3 is just enough of S3 for PUT, HEAD and GET, path-style.
func fakeS3(t *testing.T) (*R2, map[string][]byte) {
	var mu sync.Mutex
	objects, types := map[string][]byte{}, map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path], types[r.URL.Path] = b, r.Header.Get("Content-Type")
		case http.MethodHead, http.MethodGet:
			b, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", types[r.URL.Path])
			w.Header().Set("Content-Length", strconv.Itoa(len(b)))
			if r.Method == http.MethodGet {
				_, _ = w.Write(b)
			}
		case http.MethodDelete:
			delete(objects, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	return newR2(config.R2{Endpoint: srv.URL, AccessKeyID: "id", SecretAccessKey: "secret",
		BucketPublic: "pub", BucketPrivate: "priv", KeyPrefix: "dev", PublicURL: "https://cdn.example"}, true), objects
}

var limits = config.Uploads{
	MaxImageBytes: 5 << 20, MaxDocumentBytes: 10 << 20, MaxVideoBytes: 50 << 20, MaxAudioBytes: 10 << 20,
	ImageMIME:    config.DefaultImageMIME,
	DocumentMIME: config.DefaultDocumentMIME,
	VideoMIME:    config.DefaultVideoMIME,
	AudioMIME:    config.DefaultAudioMIME,
}

func TestVerifyUploadedObject(t *testing.T) {
	r, _ := fakeS3(t)
	ctx := context.Background()
	png := []byte("\x89PNG\r\n\x1a\n rest of a png")
	_ = r.Put(ctx, "priv", "dev/a.png", png, "image/png", "")
	_ = r.Put(ctx, "priv", "dev/fake.png", []byte("%PDF-1.7 renamed"), "image/png", "")

	v, err := r.VerifyUploadedObject(ctx, limits, "priv", "dev/a.png", "image/png; charset=binary", int64(len(png)))
	if err != nil || v.ContentHash != HashBytes(png) || v.MimeType != "image/png" {
		t.Fatalf("%+v %v", v, err)
	}
	for _, c := range []struct {
		key, mime string
		size      int64
		code      string
	}{
		{"dev/missing.png", "image/png", 1, "UPLOAD_NOT_FOUND"},
		{"dev/a.png", "image/jpeg", int64(len(png)), "UPLOAD_TYPE_MISMATCH"},
		{"dev/a.png", "image/png", 3, "UPLOAD_SIZE_MISMATCH"},
		{"dev/fake.png", "image/png", 16, "UPLOAD_CONTENT_MISMATCH"},
	} {
		_, err := r.VerifyUploadedObject(ctx, limits, "priv", c.key, c.mime, c.size)
		var ve *VerificationError
		if !errors.As(err, &ve) || ve.Code != c.code {
			t.Errorf("%s: %v", c.code, err)
		}
	}
	if got := r.ReadStoredObject(ctx, "priv", "dev/a.png"); string(got) != string(png) {
		t.Error("read back")
	}
	_ = r.Delete(ctx, "priv", "dev/a.png")
	if r.ReadStoredObject(ctx, "priv", "dev/a.png") != nil {
		t.Error("delete")
	}
}

func TestPresignAndKeys(t *testing.T) {
	r, _ := fakeS3(t)
	ctx := context.Background()
	up, err := r.PresignUpload(ctx, "priv", "dev/x.pdf", "application/pdf")
	if err != nil || !strings.Contains(up, "X-Amz-Expires=600") || !strings.Contains(up, "/priv/dev/x.pdf") {
		t.Fatalf("%s %v", up, err)
	}
	read, err := r.PresignRead(ctx, "priv", "dev/x.pdf", "Bhadra (2083) bill.pdf")
	q, _ := url.Parse(read)
	if err != nil || q.Query().Get("X-Amz-Expires") != "900" ||
		q.Query().Get("response-content-disposition") != "attachment; filename*=UTF-8''Bhadra%20(2083)%20bill.pdf" {
		t.Fatalf("%s %v", read, err)
	}
	if b, _ := r.BucketFor(Protected); b != "priv" {
		t.Error("PROTECTED must live in the private bucket")
	}
	if b, _ := r.BucketFor(Public); b != "pub" {
		t.Error("public bucket")
	}
	for in, want := range map[string]string{"/a/b.png": "dev/a/b.png", "dev/a.png": "dev/a.png", "dev": "dev", "device/a": "dev/device/a"} {
		if got := r.WithKeyPrefix(in); got != want {
			t.Errorf("prefix %q: %q", in, got)
		}
	}
	if !regexp.MustCompile(`^dev/receipts/[0-9a-f-]{36}\.jpg$`).MatchString(r.GenerateFileKey("receipts", "Photo.JPG")) {
		t.Error("generated key")
	}
	if u, _ := r.PublicURL("/dev/a.png"); u != "https://cdn.example/dev/a.png" {
		t.Error(u)
	}
	if _, err := New(config.R2{}).PresignUpload(ctx, "b", "k", "t"); err != ErrNotConfigured {
		t.Error(err)
	}
}

func TestSniffAndRules(t *testing.T) {
	for b, want := range map[string]Family{
		"\xff\xd8\xff\xe0": JPEG, "RIFF\x00\x00\x00\x00WEBPVP8 ": WEBP, "PK\x03\x04": ZIP,
		"\x00\x00\x00\x18ftypmp42": ISOMedia, "\x1a\x45\xdf\xa3": Matroska, "abc": "", "plain text": "",
	} {
		if got := SniffFamily([]byte(b)); got != want {
			t.Errorf("%q: %s", b, got)
		}
	}
	if ContentTypeMismatch("text/csv", []byte("a,b\x00")) == "" || ContentTypeMismatch("text/csv", []byte("a,b")) != "" {
		t.Error("text")
	}
	if ContentTypeMismatch("application/vnd.ms-excel", []byte("PK\x03\x04")) != "" || ContentTypeMismatch("application/zip", nil) != "" {
		t.Error("allowed / unknown declared type")
	}
	for _, c := range []struct {
		mime string
		size int64
		want string
	}{
		{"", 1, "File MIME type is required."},
		{"image/png", 0, "File size must be a positive number of bytes."},
		{" IMAGE/PNG ", 5 << 20, ""},
		{"image/png", 5<<20 + 1, "Image exceeds the 5242880 byte upload limit."},
		{"application/pdf", 11 << 20, "Document exceeds the 10485760 byte upload limit."},
		{"application/zip", 1, "File MIME type is not allowed."},
	} {
		if got := ValidateMetadata(limits, c.mime, c.size); got != c.want {
			t.Errorf("%q %d: %q", c.mime, c.size, got)
		}
	}
}
