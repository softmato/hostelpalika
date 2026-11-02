// Package movechecklist is modules/move-checklist: move-in and move-out
// checklists, the money a move-out settles, leaving notices, and the move ledger.
package movechecklist

import (
	"context"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// Service holds what the move-checklist routes share.
type Service struct {
	DB *mongo.Database
}

// ledgerCap bounds the move ledger: it reads every resident a hostel ever had.
const ledgerCap = 20000

type Event struct {
	ResidentID     string `json:"residentId"`
	ResidentName   string `json:"residentName"`
	ResidentStatus string `json:"residentStatus"`
	RoomType       string `json:"roomType"`
	Date           string `json:"date"`
	Type           string `json:"type"`
}

// Events is listMoveEvents: move-ins from each resident's moveInDate, move-outs
// from the completed checklist (else the row's last update), newest first.
func (s *Service) Events(ctx context.Context, p *authz.Principal, requested string) ([]Event, error) {
	scope, err := hostelrooms.ScopeFilter(p, requested)
	if err != nil {
		return nil, err
	}
	cur, err := s.DB.Collection("residents").Find(ctx, bson.D{{Key: "isDeleted", Value: false}, scope},
		options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "moveInDate", Value: 1}, {Key: "roomType", Value: 1}, {Key: "status", Value: 1}, {Key: "updatedAt", Value: 1}}).SetLimit(ledgerCap))
	if err != nil {
		return nil, err
	}
	var residents []struct {
		ID        bson.ObjectID `bson:"_id"`
		First     string        `bson:"firstName"`
		Last      string        `bson:"lastName"`
		MoveIn    *time.Time    `bson:"moveInDate"`
		RoomType  string        `bson:"roomType"`
		Status    string        `bson:"status"`
		UpdatedAt *time.Time    `bson:"updatedAt"`
	}
	if err := cur.All(ctx, &residents); err != nil {
		return nil, err
	}
	cur, err = s.DB.Collection("moveoutchecklists").Find(ctx, bson.D{scope, {Key: "completedAt", Value: bson.D{{Key: "$ne", Value: nil}}}},
		options.Find().SetProjection(bson.D{{Key: "residentId", Value: 1}, {Key: "completedAt", Value: 1}}).SetLimit(ledgerCap))
	if err != nil {
		return nil, err
	}
	var outs []struct {
		ResidentID  bson.ObjectID `bson:"residentId"`
		CompletedAt *time.Time    `bson:"completedAt"`
	}
	if err := cur.All(ctx, &outs); err != nil {
		return nil, err
	}
	done := map[bson.ObjectID]*time.Time{}
	for _, o := range outs {
		done[o.ResidentID] = o.CompletedAt
	}
	events := []Event{}
	for _, r := range residents {
		name := strings.TrimSpace(r.First + " " + r.Last)
		if r.MoveIn != nil {
			events = append(events, Event{r.ID.Hex(), name, r.Status, r.RoomType, httpx.ISO(*r.MoveIn), "MOVE_IN"})
		}
		if r.Status == "MOVED_OUT" {
			at := done[r.ID]
			if at == nil {
				at = r.UpdatedAt
			}
			if at != nil {
				events = append(events, Event{r.ID.Hex(), name, r.Status, r.RoomType, httpx.ISO(*at), "MOVE_OUT"})
			}
		}
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Date > events[j].Date })
	return events, nil
}
