package push

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const (
	receiptBatch      = 1000 // Expo's cap per getReceipts call
	receiptsPerRun    = 3000
	receiptReadyAfter = time.Minute
	receiptExpiresAt  = 24 * time.Hour // Expo keeps receipts a day
)

type expoReceipt struct {
	Details *struct {
		Error string          `json:"error"`
		FCM   json.RawMessage `json:"fcm"`
	} `json:"details"`
	Message string `json:"message"`
	Status  string `json:"status"`
}

// receiptsURL is the getReceipts endpoint beside the send endpoint, so a test
// or the local proof that fakes one fakes both.
func (s *Sender) receiptsURL() string {
	return strings.TrimSuffix(s.Endpoint, "/send") + "/getReceipts"
}

func (s *Sender) fetchReceipts(ctx context.Context, ids []string) map[string]expoReceipt {
	body, _ := json.Marshal(map[string]any{"ids": ids})
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.receiptsURL(), bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("accept", "application/json")
	req.Header.Set("content-type", "application/json")
	if s.ExpoToken != "" {
		req.Header.Set("authorization", "Bearer "+s.ExpoToken)
	}
	res, err := s.HTTP.Do(req)
	if err != nil {
		slog.ErrorContext(ctx, "Expo receipt lookup threw", "action", "push_receipts_request_failed", "error", err)
		return nil
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		slog.ErrorContext(ctx, "Expo receipt lookup failed", "action", "push_receipts_http_error", "status", res.StatusCode)
		return nil
	}
	var payload struct {
		Data map[string]expoReceipt `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		slog.ErrorContext(ctx, "Expo receipt lookup threw", "action", "push_receipts_request_failed", "error", err)
		return nil
	}
	return payload.Data
}

func fcmText(r expoReceipt) string {
	if r.Details == nil || len(r.Details.FCM) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(r.Details.FCM, &s) == nil {
		return s
	}
	return string(r.Details.FCM)
}

// configurationFailure: Expo reached FCM and FCM refused our credentials.
func configurationFailure(r expoReceipt) bool {
	d := fcmText(r)
	return (r.Details != nil && r.Details.Error == "DeveloperError") ||
		strings.Contains(d, "PERMISSION_DENIED") || strings.Contains(d, "UNAUTHENTICATED") || strings.Contains(d, "SenderId")
}

// SweepReceipts is sweepPushReceipts (the push-receipts job): Expo's ticket ids
// from the last day are read back, dead device tokens revoked, and a transport
// refusing everything logged loudly.
func (s *Sender) SweepReceipts(ctx context.Context) (ordered.Map, error) {
	now := time.Now().UTC()
	tickets := s.DB.Collection("pushtickets")
	expired, err := tickets.DeleteMany(ctx, bson.D{{Key: "createdAt", Value: bson.D{{Key: "$lt", Value: now.Add(-receiptExpiresAt)}}}, {Key: "status", Value: "PENDING"}})
	if err != nil {
		return nil, err
	}
	// Oldest first (TS read in no order), so a backlog drains before it expires.
	cur, err := tickets.Find(ctx, bson.D{{Key: "createdAt", Value: bson.D{{Key: "$lte", Value: now.Add(-receiptReadyAfter)}}}, {Key: "status", Value: "PENDING"}},
		options.Find().SetProjection(bson.D{{Key: "ticketId", Value: 1}, {Key: "token", Value: 1}}).SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetLimit(receiptsPerRun))
	if err != nil {
		return nil, err
	}
	var pending []struct {
		TicketID string `bson:"ticketId"`
		Token    string `bson:"token"`
	}
	if err := cur.All(ctx, &pending); err != nil {
		return nil, err
	}
	checked, delivered, failed := 0, 0, 0
	var revoked int64
	out := func() ordered.Map {
		return ordered.Map{{Key: "checked", Value: checked}, {Key: "delivered", Value: delivered}, {Key: "expired", Value: expired.DeletedCount}, {Key: "failed", Value: failed}, {Key: "revoked", Value: revoked}}
	}
	if len(pending) == 0 {
		return out(), nil
	}
	tokenOf := make(map[string]string, len(pending))
	for _, p := range pending {
		tokenOf[p.TicketID] = p.Token
	}
	var dead []string
	codes := map[string]int{}
	config, detail := 0, ""
	for start := 0; start < len(pending); start += receiptBatch {
		batch := pending[start:min(start+receiptBatch, len(pending))]
		ids := make([]string, len(batch))
		for i, p := range batch {
			ids[i] = p.TicketID
		}
		receipts := s.fetchReceipts(ctx, ids)
		seen := make(bson.A, 0, len(receipts))
		for id, r := range receipts {
			seen = append(seen, id)
			checked++
			if r.Status == "ok" {
				delivered++
				continue
			}
			failed++
			code := "Unknown"
			if r.Details != nil && r.Details.Error != "" {
				code = r.Details.Error
			}
			codes[code]++
			if configurationFailure(r) {
				config++
				if detail == "" {
					if detail = fcmText(r); detail == "" {
						detail = r.Message
					}
				}
			}
			if code == "DeviceNotRegistered" && tokenOf[id] != "" {
				dead = append(dead, tokenOf[id])
			}
		}
		if len(seen) > 0 {
			if _, err := tickets.UpdateMany(ctx, bson.D{{Key: "ticketId", Value: bson.D{{Key: "$in", Value: seen}}}},
				bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "CHECKED"}, {Key: "updatedAt", Value: now}}}}); err != nil {
				slog.WarnContext(ctx, "Push tickets not marked checked", "error", err)
			}
		}
	}
	if len(dead) > 0 {
		res, err := s.DB.Collection("devicetokens").UpdateMany(ctx, bson.D{{Key: "token", Value: bson.D{{Key: "$in", Value: dead}}}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "REVOKED"}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			slog.WarnContext(ctx, "Dead device tokens not revoked", "error", err)
		} else {
			revoked = res.ModifiedCount
		}
	}
	if failed > 0 {
		slog.ErrorContext(ctx, "Push notifications were not delivered", "action", "push_receipts_delivery_failed", "codes", codes, "failed", failed, "checked", checked)
	}
	if config > 0 {
		if len(detail) > 800 {
			detail = detail[:800]
		}
		slog.ErrorContext(ctx, "Push transport is rejecting every message — FCM credentials are wrong", "action", "push_transport_misconfigured", "count", config, "detail", detail,
			"remedy", "Re-upload the FCM V1 service account key to the EAS project (eas credentials) and grant it the Firebase Cloud Messaging API Admin role on the Firebase project.")
	}
	return out(), nil
}
