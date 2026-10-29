package httpx

import (
	"bytes"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/gin-gonic/gin"
)

// ETag is withEtag (lib/etag.ts): a JSON 200 GET gets a weak ETag of its body,
// and a matching If-None-Match gets a bodiless 304. The value is the TS one
// exactly — FNV-1a over UTF-16 code units, then the UTF-16 length, base 36 —
// so a tag a client holds from TS still matches after cut-over. A cached read
// (cache.Read) builds the same body without Mongo, so its tag costs no query.
func ETag() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method != http.MethodGet {
			c.Next()
			return
		}
		w := &bufferedWriter{ResponseWriter: c.Writer, status: http.StatusOK}
		c.Writer = w
		c.Next()
		c.Writer = w.ResponseWriter

		h := w.Header()
		if w.status == http.StatusOK && strings.Contains(h.Get("Content-Type"), "application/json") {
			tag := etagOf(w.buf.Bytes())
			h.Set("ETag", tag)
			if c.GetHeader("If-None-Match") == tag {
				h.Del("Content-Length")
				h.Del("Content-Type")
				w.ResponseWriter.WriteHeader(http.StatusNotModified)
				w.ResponseWriter.WriteHeaderNow()
				return
			}
		}
		w.ResponseWriter.WriteHeader(w.status)
		_, _ = w.ResponseWriter.Write(w.buf.Bytes())
	}
}

// ETagOf is the tag withEtag gives a body.
func ETagOf(body []byte) string { return etagOf(body) }

func etagOf(body []byte) string {
	units := utf16.Encode([]rune(string(body)))
	h := uint32(0x811c9dc5)
	for _, u := range units {
		h ^= uint32(u)
		h *= 0x01000193
	}
	return `W/"` + strconv.FormatUint(uint64(h), 36) + "-" + strconv.FormatInt(int64(len(units)), 36) + `"`
}

// bufferedWriter holds the status and body until the tag is known.
type bufferedWriter struct {
	gin.ResponseWriter
	buf    bytes.Buffer
	status int
}

func (w *bufferedWriter) WriteHeader(code int)              { w.status = code }
func (w *bufferedWriter) WriteHeaderNow()                   {}
func (w *bufferedWriter) Write(b []byte) (int, error)       { return w.buf.Write(b) }
func (w *bufferedWriter) WriteString(s string) (int, error) { return w.buf.WriteString(s) }
func (w *bufferedWriter) Status() int                       { return w.status }
func (w *bufferedWriter) Size() int                         { return w.buf.Len() }
func (w *bufferedWriter) Written() bool                     { return w.buf.Len() > 0 }
