// Package mongo owns the process's single Mongo client.
package mongo

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/x/mongo/driver/connstring"
)

// Connect opens the pool and pings it, so a bad URI fails boot rather than the
// first request. The database is the one named in the URI, as with mongoose.
//
// TS caps each Vercel instance at 5 sockets because M0 refuses connections at
// 500 cluster-wide and a burst of instances held the whole budget (2026-09-22).
// Here there is one process, so it gets a real pool with warm sockets.
// ponytail: 50 is a guess sized under M0's 500 while TS instances still share
// it; size from Atlas's connection graph once Go carries the traffic.
func Connect(ctx context.Context, uri string) (*mongo.Client, *mongo.Database, error) {
	cs, err := connstring.ParseAndValidate(uri)
	if err != nil {
		return nil, nil, fmt.Errorf("mongo: %w", err)
	}
	if cs.Database == "" {
		return nil, nil, fmt.Errorf("mongo: MONGODB_URI names no database")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri).
		SetMinPoolSize(5).
		SetMaxPoolSize(50).
		SetMaxConnIdleTime(5 * time.Minute).
		SetServerSelectionTimeout(10 * time.Second))
	if err != nil {
		return nil, nil, fmt.Errorf("mongo: %w", err)
	}
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Ping(pctx, nil); err != nil {
		_ = client.Disconnect(context.Background()) // already failing; the ping error is the one to report
		return nil, nil, fmt.Errorf("mongo: ping: %w", err)
	}
	return client, client.Database(cs.Database), nil
}
