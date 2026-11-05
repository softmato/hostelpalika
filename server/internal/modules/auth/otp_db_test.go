package auth

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/contract/fixture"
	"github.com/softmato/hostelpalika/server/internal/platform/config"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// A parallel burst of OTP requests sends one code, not one per request (P11-16).
func TestOTPBurstSendsOnce(t *testing.T) {
	ctx := context.Background()
	client, _, err := appmongo.Connect(ctx, fixture.URI)
	if err != nil {
		t.Skip("contract Mongo not running:", err)
	}
	db := client.Database("hostelpalika_contract_otp")
	if err := db.Drop(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Drop(ctx); _ = client.Disconnect(ctx) })
	s := &Service{db: db, now: time.Now, cfg: &config.Config{Env: "development", OTP: config.OTP{
		TTL: 10 * time.Minute, ResendCooldown: time.Minute, RateLimitWindow: time.Hour, RateLimitMax: 5, HashSecret: "x"}}}

	var wg sync.WaitGroup
	var mu sync.Mutex
	sent := 0
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.OTPRequest(ctx, "email", "burst@contract.test", "login", reqCtx{}); err == nil {
				mu.Lock()
				sent++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	rows, err := db.Collection("otpchallenges").CountDocuments(ctx, bson.D{})
	if err != nil {
		t.Fatal(err)
	}
	if sent != 1 || rows != 1 {
		t.Fatalf("sent %d codes, %d rows left; want 1 and 1", sent, rows)
	}
}
