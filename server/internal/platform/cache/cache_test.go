package cache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

type row struct {
	Name string `json:"name"`
}

func TestNoRedis(t *testing.T) {
	n := 0
	for i := 0; i < 2; i++ {
		_, _ = Read(context.Background(), New(nil), []string{"h"}, "u", "k", func() (row, error) { n++; return row{}, nil })
	}
	if n != 2 {
		t.Fatal("no Redis = no cache")
	}
}

// Against the compose Redis; skipped when it is down.
func TestRead(t *testing.T) {
	ctx := context.Background()
	rdb := goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:6380"})
	if rdb.Ping(ctx).Err() != nil {
		t.Skip("local Redis not running")
	}
	defer rdb.Close()
	c := New(rdb)
	hostel := "test-" + time.Now().Format("150405.000000")
	defer rdb.Del(ctx, versionKey(hostel))

	var loads atomic.Int32
	load := func() (*row, error) { loads.Add(1); time.Sleep(200 * time.Millisecond); return &row{"a"}, nil }
	read := func(hostels ...string) *row {
		v, err := Read(ctx, c, hostels, "u1", "list", load)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}

	// Concurrent misses share one load (singleflight).
	// Released together, so every miss lands inside the first load's window.
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; read(hostel) }()
	}
	close(start)
	wg.Wait()
	if loads.Load() != 1 {
		t.Fatalf("loads %d", loads.Load())
	}
	raw, _ := rdb.Get(ctx, "c:"+hostel+":0:u1:list").Result()
	if raw != `{"value":{"name":"a"}}` {
		t.Fatalf("stored %q (TS format is {\"value\": …})", raw)
	}
	if read(hostel).Name != "a" || loads.Load() != 1 {
		t.Fatal("hit must skip the loader")
	}
	c.Bump(ctx, hostel, hostel, "")
	if read(hostel); loads.Load() != 2 {
		t.Fatal("a bump skips the cached read")
	}
	if v, _ := rdb.Get(ctx, versionKey(hostel)).Int(); v != 1 {
		t.Fatalf("duplicate ids bump once: %d", v)
	}
	rdb.Del(ctx, "c:"+hostel+":0:u1:list", "c:"+hostel+":1:u1:list")

	if read(hostel, "other"); loads.Load() != 3 {
		t.Fatal("several hostels are not cached")
	}

	// A cached null is a hit.
	n := 0
	nilLoad := func() (*row, error) { n++; return nil, nil }
	for i := 0; i < 2; i++ {
		_, _ = Read(ctx, c, []string{hostel}, "u2", "nil", nilLoad)
	}
	rdb.Del(ctx, "c:"+hostel+":1:u2:nil")
	if n != 1 {
		t.Fatalf("cached null loads %d", n)
	}

	// Errors are returned, never cached.
	boom := errors.New("boom")
	if _, err := Read(ctx, c, []string{hostel}, "u3", "err", func() (int, error) { return 0, boom }); err != boom {
		t.Fatal(err)
	}
	if rdb.Exists(ctx, "c:"+hostel+":1:u3:err").Val() != 0 {
		t.Fatal("an error was cached")
	}
}
