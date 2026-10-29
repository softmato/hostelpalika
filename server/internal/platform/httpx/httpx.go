// Package httpx writes the response envelope of apps/web/src/lib/api-response.ts,
// byte for byte: success → {success, message, data}; error → {success, message,
// errorCode, details?} with details absent (not null) when there are none.
package httpx

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/bytedance/sonic"
	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const defaultMessage = "Request successful"

// enc matches JSON.stringify: no HTML escaping, so ">=" stays ">=" instead of
// Gin's ">=". Every envelope goes through write, never c.JSON.
var enc = sonic.ConfigDefault

// write sends v with Next's exact content type (NextResponse.json sets no charset).
func write(c *gin.Context, status int, v any) {
	b, err := enc.Marshal(v)
	if err != nil { // only a handler bug (a func or channel in data) gets here
		slog.ErrorContext(c, "response encode failed", "error", err, "path", c.FullPath())
		status, b = http.StatusInternalServerError, []byte(`{"success":false,"message":"Internal server error","errorCode":"INTERNAL_SERVER_ERROR"}`)
	}
	c.Data(status, "application/json", b)
}

// abort is write for a refusal: later handlers in the chain don't run.
func abort(c *gin.Context, status int, v any) {
	c.Abort()
	write(c, status, v)
}

type success struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    any    `json:"data"`
}

type failure struct {
	Success   bool   `json:"success"`
	Message   string `json:"message"`
	ErrorCode string `json:"errorCode"`
	Details   any    `json:"details,omitempty"`
}

// Error is what services return for an expected refusal; TS throws the same
// shape (status + errorCode + optional details).
type Error struct {
	Status    int
	ErrorCode string
	Message   string
	Details   any
}

func (e *Error) Error() string { return e.Message }

func NewError(status int, errorCode, message string, details any) *Error {
	return &Error{Status: status, ErrorCode: errorCode, Message: message, Details: details}
}

// OK writes a 200 success envelope; an empty message becomes TS's default.
func OK(c *gin.Context, data any, message string) {
	if message == "" {
		message = defaultMessage
	}
	write(c, http.StatusOK, success{true, message, data})
}

// Envelope is the success envelope's bytes, exactly as write sends them.
func Envelope(data any, message string) ([]byte, error) {
	if message == "" {
		message = defaultMessage
	}
	return enc.Marshal(success{true, message, data})
}

// Write is successResponse with a status (201 for a create).
func Write(c *gin.Context, status int, data any, message string) {
	if message == "" {
		message = defaultMessage
	}
	write(c, status, success{true, message, data})
}

// Fail maps err to the error envelope, in handleRouteError's order:
// validation → 422, *Error → its own status, Softmato refusal → 502, unique
// index → 409. Anything else is a 500 whose reason goes to the log, never the body.
func Fail(c *gin.Context, err error) {
	var (
		v *ValidationError
		e *Error
		s softmatoRejection
	)
	switch {
	case errors.As(err, &v):
		slog.WarnContext(c, "Request validation failed", "issues", v.Issues)
		abort(c, http.StatusUnprocessableEntity, failure{false, "Validation failed", "VALIDATION_ERROR", v.details()})
	case errors.As(err, &e):
		abort(c, e.Status, failure{false, e.Message, e.ErrorCode, e.Details})
	case errors.As(err, &s):
		slog.ErrorContext(c, "Softmato refused a request", "error", err)
		abort(c, http.StatusBadGateway, failure{false, "Our payment server could not accept this: " + s.Error(), "SOFTMATO_REJECTED", nil})
	case mongo.IsDuplicateKeyError(err):
		slog.WarnContext(c, "Duplicate value refused", "error", err)
		msg, ok := duplicateMessages[duplicateField(err)]
		if !ok {
			msg = "This is already saved. Refresh and check before adding it again."
		}
		abort(c, http.StatusConflict, failure{false, msg, "DUPLICATE_VALUE", nil})
	default:
		slog.ErrorContext(c, "Unhandled API route error", "error", err, "path", c.FullPath())
		abort(c, http.StatusInternalServerError, failure{false, "Internal server error", "INTERNAL_SERVER_ERROR", nil})
	}
}

// softmatoRejection is implemented by the Softmato client's error type (ported
// with the client). Matched by behaviour so httpx doesn't import the client,
// as TS matches SoftmatoApiError by name.
type softmatoRejection interface {
	error
	SoftmatoRejection()
}

var duplicateMessages = map[string]string{
	"email": "This email is already used by another account.",
	"phone": "This phone number is already used by another account.",
}

// duplicateField is the first key of the server's keyPattern, as TS reads
// error.keyPattern. Single writes carry it per write error; findAndModify and
// friends carry it on the command error.
func duplicateField(err error) string {
	var raws []bson.Raw
	var we mongo.WriteException
	if errors.As(err, &we) {
		for _, w := range we.WriteErrors {
			raws = append(raws, w.Raw)
		}
	}
	var be mongo.BulkWriteException
	if errors.As(err, &be) {
		for _, w := range be.WriteErrors {
			raws = append(raws, w.Raw)
		}
	}
	var ce mongo.CommandError
	if errors.As(err, &ce) {
		raws = append(raws, ce.Raw)
	}
	for _, r := range raws {
		if kp, ok := r.Lookup("keyPattern").DocumentOK(); ok {
			if els, _ := kp.Elements(); len(els) > 0 {
				return els[0].Key()
			}
		}
	}
	return ""
}

// Issue is one zod issue as TS sends it: message plus the dotted path.
type Issue struct {
	Message string `json:"message"`
	Path    string `json:"path"`
}

// ValidationError is what a request schema returns; Fail answers it with
// zod's 422 envelope. Build it with package valid, which carries zod's messages.
type ValidationError struct{ Issues []Issue }

func (v *ValidationError) Error() string { return "validation failed" }

// details is `{ ...error.flatten(), issues }`: root issues are formErrors,
// the rest bucket by top-level key in first-seen order.
func (v *ValidationError) details() validationDetails {
	d := validationDetails{FormErrors: []string{}, Issues: v.Issues}
	for _, is := range v.Issues {
		if is.Path == "" {
			d.FormErrors = append(d.FormErrors, is.Message)
			continue
		}
		key, _, _ := strings.Cut(is.Path, ".")
		d.FieldErrors.add(key, is.Message)
	}
	return d
}

type validationDetails struct {
	FormErrors  []string    `json:"formErrors"`
	FieldErrors fieldErrors `json:"fieldErrors"`
	Issues      []Issue     `json:"issues"`
}

// fieldErrors keeps insertion order, as a JS object does for string keys.
// ponytail: JS puts integer-like keys first; only matters for a root array schema.
type fieldErrors struct {
	keys []string
	msgs map[string][]string
}

func (f *fieldErrors) add(key, msg string) {
	if f.msgs == nil {
		f.msgs = map[string][]string{}
	}
	if _, ok := f.msgs[key]; !ok {
		f.keys = append(f.keys, key)
	}
	f.msgs[key] = append(f.msgs[key], msg)
}

func (f fieldErrors) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range f.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := enc.Marshal(k)         // a string never fails to marshal
		vb, _ := enc.Marshal(f.msgs[k]) // nor does []string
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Recover turns a panic into the same 500 envelope instead of a dropped
// connection. It is for bugs only; services never panic for control flow.
func Recover() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler { // client went away mid-stream; nothing to answer
					panic(v)
				}
				slog.ErrorContext(c, "panic in handler", "panic", v, "path", c.FullPath())
				if !c.Writer.Written() {
					abort(c, http.StatusInternalServerError, failure{false, "Internal server error", "INTERNAL_SERVER_ERROR", nil})
				}
			}
		}()
		c.Next()
	}
}

// ISO is Date#toISOString: UTC, milliseconds, Z.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// PublicCache is PUBLIC_CACHE: shared-cache only, so a browser still
// revalidates. Never on an authed route.
func PublicCache(c *gin.Context) {
	c.Header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600")
}
