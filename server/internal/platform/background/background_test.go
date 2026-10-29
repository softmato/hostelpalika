package background

import (
	"context"
	"errors"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestAfterRunsOnceTheHandlerIsDone(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	var r Runner
	var handlerDone, ranAfter, ranOutside atomic.Bool
	release := make(chan struct{})

	e := gin.New()
	e.Use(r.Middleware())
	e.GET("/", func(c *gin.Context) {
		r.After(c, func(context.Context) error {
			if !handlerDone.Load() {
				t.Error("after work ran before the handler finished")
			}
			<-release
			ranAfter.Store(true)
			return nil
		})
		r.After(c, func(context.Context) error { panic("boom") }) // never takes the process down
		r.After(c, func(context.Context) error { return errors.New("logged") })
		handlerDone.Store(true)
		c.Status(204)
	})
	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 204 {
		t.Fatal(w.Code)
	}

	// Outside a request: runs now.
	r.After(context.Background(), func(context.Context) error { ranOutside.Store(true); return nil })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if r.Wait(ctx) == nil {
		t.Fatal("Wait must block on unfinished work")
	}
	close(release)
	if err := r.Wait(context.Background()); err != nil || !ranAfter.Load() || !ranOutside.Load() {
		t.Fatal("drain", err)
	}
}
