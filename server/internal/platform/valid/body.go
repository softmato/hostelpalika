package valid

import (
	"encoding/json"
	"io"

	"github.com/gin-gonic/gin"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Body reads the request as JSON into any. An empty body is not JSON either.
func Body(c *gin.Context) (any, error) {
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return nil, err
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil, httpx.ErrBadJSON
	}
	return v, nil
}

// Object is z.object's own check: nil plus a root issue when v is not an object.
// Unknown keys are ignored (zod strips them).
func Object(v any, is *Issues) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		is.Add("", Type("object", Received(v, false)))
	}
	return m
}

// String reads key as z.string(). ok=false: absent and optional (no issue), or
// an issue was added.
func String(m map[string]any, key string, optional bool, is *Issues) (string, bool) {
	v, present := m[key]
	if !present && optional {
		return "", false
	}
	s, isStr := v.(string)
	if !isStr {
		is.Add(key, Type("string", Received(v, !present)))
		return "", false
	}
	return s, true
}
