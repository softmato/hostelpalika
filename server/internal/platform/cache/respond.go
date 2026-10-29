package cache

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	goredis "github.com/redis/go-redis/v9"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Respond is a TS route's withEtag(successResponse(await cachedRead(…), message))
// in one step, with the 304 answered before any work (DESIGN.md §3.2–3): the
// finished envelope is cached with its tag beside it under
// r:{hostel}:{version}:{user}:{key}, so a revalidation costs two Redis GETs —
// no Mongo, no decode, no re-encode — and a hit is copied to the socket.
//
// The tag is TS's own (FNV-1a of the body), not one derived from the version
// alone: a change that does not bump the version must still show within the
// 60 s TTL, and a tag a client got from TS keeps matching after cut-over.
// Not cached (load + tag only) without Redis or for several hostels, as cachedRead.
func Respond[T any](c *gin.Context, ch *Cache, hostelIDs []string, userID, key, message string, load func() (T, error)) {
	build := func() ([]byte, error) {
		v, err := load()
		if err != nil {
			return nil, err
		}
		return httpx.Envelope(v, message)
	}
	if ch == nil || ch.Redis == nil || len(hostelIDs) != 1 {
		body, err := build()
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		send(c, httpx.ETagOf(body), body)
		return
	}
	rkey, ok := ch.responseKey(c, hostelIDs[0], userID, key)
	if ok {
		tctx, cancel := context.WithTimeout(c, Timeout)
		raw, err := ch.Redis.Get(tctx, rkey).Bytes()
		cancel()
		if err == nil {
			if tag, body, found := bytes.Cut(raw, []byte("\n")); found {
				send(c, string(tag), body)
				return
			}
		} else if !errors.Is(err, goredis.Nil) {
			ok = false // Redis trouble: straight to the database
		}
	}
	if !ok {
		body, err := build()
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		send(c, httpx.ETagOf(body), body)
		return
	}
	v, err, _ := ch.group.Do(rkey, func() (any, error) {
		body, err := build()
		if err != nil {
			return nil, err
		}
		tag := httpx.ETagOf(body)
		sctx, cancel := context.WithTimeout(context.WithoutCancel(c), Timeout)
		_ = ch.Redis.Set(sctx, rkey, append([]byte(tag+"\n"), body...), TTL).Err()
		cancel()
		return [2][]byte{[]byte(tag), body}, nil
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	pair := v.([2][]byte)
	send(c, string(pair[0]), pair[1])
}

// responseKey reads the hostel version; ok=false means Redis is not answering.
func (ch *Cache) responseKey(ctx context.Context, hostelID, userID, key string) (string, bool) {
	tctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	version, err := ch.Redis.Get(tctx, versionKey(hostelID)).Result()
	if errors.Is(err, goredis.Nil) {
		version, err = "0", nil
	}
	if err != nil {
		return "", false
	}
	if _, err := strconv.ParseInt(version, 10, 64); err != nil {
		return "", false
	}
	return "r:" + hostelID + ":" + version + ":" + userID + ":" + key, true
}

// send is withEtag's answer: the tag always, a bodiless 304 when it matches.
func send(c *gin.Context, tag string, body []byte) {
	c.Header("ETag", tag)
	if c.Request.Method == http.MethodGet && c.GetHeader("If-None-Match") == tag {
		c.Status(http.StatusNotModified)
		c.Writer.WriteHeaderNow()
		return
	}
	c.Data(http.StatusOK, "application/json", body)
}
