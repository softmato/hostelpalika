package audit

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
)

// Golden: two consecutive live entries written by TS (local copy of prod).
func TestIntegrityHashMatchesTS(t *testing.T) {
	at, _ := time.Parse(time.RFC3339Nano, "2026-10-29T00:37:50.450Z")
	got := IntegrityHash("c8ae10b707a5dc64fcda9a797c70837fe99aff3b80c7a5204bda8e5bb308d3b6",
		"EXPENSE_RECORDED", "6ae2955ef742cd12fedf4d5f", 9, at)
	if got != "fc7cb841c28355a3bedc061a8d9b87311a00089cc3aae9225fdc343791fc3fe2" {
		t.Fatal(got)
	}
}

// Against the compose Mongo in a throwaway db; skipped when it is down.
func TestWriters(t *testing.T) {
	ctx := context.Background()
	client, db, err := appmongo.Connect(ctx, "mongodb://127.0.0.1:27018/hostelpalika_audittest?directConnection=true")
	if err != nil {
		t.Skip("local Mongo not running:", err)
	}
	defer func() { _ = db.Drop(ctx); _ = client.Disconnect(ctx) }()
	l := New(db)

	if l.Write(ctx, Entry{Action: "A", EntityType: "E", EntityID: "1"}) != ErrActorRequired {
		t.Fatal("a USER entry needs its user")
	}
	if err := l.Write(ctx, Entry{ActorType: "SYSTEM", Action: "A", EntityType: "E", EntityID: "1"}); err != nil {
		t.Fatal(err)
	}
	var sys bson.M
	_ = l.c.FindOne(ctx, bson.D{{Key: "actorType", Value: "SYSTEM"}}).Decode(&sys)
	if _, has := sys["metadata"]; has || sys["actorId"] != nil || sys["__v"] != int32(0) {
		t.Fatalf("system row %v", sys)
	}

	hostel, actor := bson.NewObjectID(), bson.NewObjectID()
	fin := Finance{Action: "PAY", AmountAfter: 500, EntityID: "e1", EntityType: "Invoice", HostelID: hostel, Source: "TEST"}
	for i := 0; i < 2; i++ {
		if err := l.WriteFinance(ctx, actor, "HOSTEL_ADMIN", fin); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}
	cur, _ := l.c.Find(ctx, bson.D{{Key: "hostelId", Value: hostel}})
	var rows []struct {
		CreatedAt        time.Time `bson:"createdAt"`
		FinanceIntegrity string    `bson:"financeIntegrity"`
		Metadata         bson.M    `bson:"metadata"`
	}
	_ = cur.All(ctx, &rows)
	if len(rows) != 2 {
		t.Fatal(len(rows))
	}
	if rows[0].FinanceIntegrity != IntegrityHash("", "PAY", "e1", 500, rows[0].CreatedAt) ||
		rows[1].FinanceIntegrity != IntegrityHash(rows[0].FinanceIntegrity, "PAY", "e1", 500, rows[1].CreatedAt) {
		t.Fatal("chain")
	}
	if _, has := rows[0].Metadata["eventId"]; has || rows[0].Metadata["currency"] != "NPR" {
		t.Fatalf("metadata %v", rows[0].Metadata)
	}

	for want := int64(1); want <= 2; want++ {
		if n, err := CountUsage(ctx, db, "VISION_OCR", time.Now()); err != nil || n != want {
			t.Fatal(n, err)
		}
	}
}
