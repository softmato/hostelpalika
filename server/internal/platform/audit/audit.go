// Package audit writes AuditLog rows as mongoose's AuditLogModel.create does
// (68 TS call sites), the per-hostel finance hash chain (audit-finance.ts),
// and the metered-API counter (ApiUsageCounter).
package audit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Entry is one AuditLog row. Zero ActorID with ActorType USER is refused, as
// the schema validator does; SYSTEM (cron, verified webhook) needs no actor.
type Entry struct {
	ActorID    bson.ObjectID
	ActorType  string // "" = USER
	HostelID   bson.ObjectID
	Action     string
	EntityType string
	EntityID   string
	// Keys with nil values are dropped, as mongoose drops undefined; empty = no field.
	Metadata         bson.D
	FinanceIntegrity string
	IPAddress        string
	UserAgent        string
	CreatedAt        time.Time // zero = now
}

var ErrActorRequired = errors.New("actorId is required when actorType is USER")

type Log struct {
	c   *mongo.Collection
	now func() time.Time
}

func New(db *mongo.Database) *Log { return &Log{db.Collection("auditlogs"), time.Now} }

// Write inserts e in the schema's field order.
func (l *Log) Write(ctx context.Context, e Entry) error {
	if e.ActorType == "" {
		e.ActorType = "USER"
	}
	if e.ActorType == "USER" && e.ActorID.IsZero() {
		return ErrActorRequired
	}
	if e.Action == "" || e.EntityType == "" || e.EntityID == "" {
		return errors.New("audit: action, entityType and entityId are required")
	}
	if e.CreatedAt.IsZero() {
		e.CreatedAt = l.now()
	}
	var actor any // null when nothing acted
	if !e.ActorID.IsZero() {
		actor = e.ActorID
	}
	meta := bson.D{}
	for _, kv := range e.Metadata {
		if kv.Value != nil {
			meta = append(meta, kv)
		}
	}
	doc := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "actorId", Value: actor}, {Key: "actorType", Value: e.ActorType}}
	if !e.HostelID.IsZero() {
		doc = append(doc, bson.E{Key: "hostelId", Value: e.HostelID})
	}
	doc = append(doc,
		bson.E{Key: "action", Value: e.Action},
		bson.E{Key: "entityType", Value: e.EntityType},
		bson.E{Key: "entityId", Value: e.EntityID})
	if len(meta) > 0 { // mongoose's minimize drops an empty object (328 live rows have none)
		doc = append(doc, bson.E{Key: "metadata", Value: meta})
	}
	for _, kv := range []bson.E{{Key: "financeIntegrity", Value: e.FinanceIntegrity}, {Key: "ipAddress", Value: e.IPAddress}, {Key: "userAgent", Value: e.UserAgent}} {
		if kv.Value != "" {
			doc = append(doc, kv)
		}
	}
	doc = append(doc, bson.E{Key: "createdAt", Value: e.CreatedAt}, bson.E{Key: "__v", Value: 0})
	_, err := l.c.InsertOne(ctx, doc)
	return err
}

// FinanceCurrency is FINANCE_AUDIT_CURRENCY.
const FinanceCurrency = "NPR"

// Finance is FinanceAuditInput. Amounts are whole rupees and always given:
// 0, never absent, when nothing existed before.
type Finance struct {
	Action                    string
	AmountBefore, AmountAfter int64
	Currency                  string // "" = NPR
	EntityID, EntityType      string
	EventID, InvoiceID        string
	HostelID                  bson.ObjectID
	Reason                    string
	Source                    string // where the write came from, e.g. PROOF_APPROVAL
}

// IntegrityHash is financeIntegrityHash: sha256 over
// previous|action|entityId|amountAfter|createdAt(ISO, ms).
func IntegrityHash(previous, action, entityID string, amountAfter int64, createdAt time.Time) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		previous, action, entityID, strconv.FormatInt(amountAfter, 10),
		createdAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	}, "|")))
	return hex.EncodeToString(sum[:])
}

// WriteFinance is auditFinanceAction: chained to the hostel's newest finance
// entry. Detects tampering, doesn't prevent it; a race forks the chain and
// the drift job reports it (ADR-4).
func (l *Log) WriteFinance(ctx context.Context, actorID bson.ObjectID, actorRole string, in Finance) error {
	// Mongo keeps milliseconds; the hash must cover the stored value.
	createdAt := l.now().Truncate(time.Millisecond)
	var prev struct {
		FinanceIntegrity string `bson:"financeIntegrity"`
	}
	err := l.c.FindOne(ctx,
		bson.D{{Key: "financeIntegrity", Value: bson.D{{Key: "$exists", Value: true}}}, {Key: "hostelId", Value: in.HostelID}},
		options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetProjection(bson.D{{Key: "financeIntegrity", Value: 1}}),
	).Decode(&prev)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	currency := in.Currency
	if currency == "" {
		currency = FinanceCurrency
	}
	opt := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	return l.Write(ctx, Entry{
		ActorID: actorID, HostelID: in.HostelID, Action: in.Action, EntityType: in.EntityType, EntityID: in.EntityID,
		CreatedAt:        createdAt,
		FinanceIntegrity: IntegrityHash(prev.FinanceIntegrity, in.Action, in.EntityID, in.AmountAfter, createdAt),
		Metadata: bson.D{
			{Key: "actorRole", Value: actorRole},
			{Key: "amountAfter", Value: in.AmountAfter},
			{Key: "amountBefore", Value: in.AmountBefore},
			{Key: "currency", Value: currency},
			{Key: "eventId", Value: opt(in.EventID)},
			{Key: "invoiceId", Value: opt(in.InvoiceID)},
			{Key: "reason", Value: opt(in.Reason)},
			{Key: "source", Value: in.Source},
		},
	})
}

// CountUsage is the ApiUsageCounter $inc: this call counted against the UTC
// (vendor billing) month, returning the new total for the caller's cap check.
func CountUsage(ctx context.Context, db *mongo.Database, service string, now time.Time) (int64, error) {
	now = now.UTC()
	period := now.Format("2006-01")
	var row struct {
		Count int64 `bson:"count"`
	}
	err := db.Collection("apiusagecounters").FindOneAndUpdate(ctx,
		bson.D{{Key: "period", Value: period}, {Key: "service", Value: service}},
		bson.D{
			{Key: "$inc", Value: bson.D{{Key: "count", Value: 1}}},
			{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}},
		},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After),
	).Decode(&row)
	return row.Count, err
}
