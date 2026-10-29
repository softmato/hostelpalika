package fixture

import (
	"context"
	"os"
	"testing"

	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// FIXTURE_RESET=1 go test ./internal/contract/fixture -run Reset writes the
// contract database by hand (cmd/dev record -fixture does it per file).
func TestReset(t *testing.T) {
	if os.Getenv("FIXTURE_RESET") == "" {
		t.Skip("set FIXTURE_RESET=1")
	}
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, URI)
	if err != nil {
		t.Skip("contract Mongo not running:", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()
	if err := Reset(ctx, db); err != nil {
		t.Fatal(err)
	}
}
