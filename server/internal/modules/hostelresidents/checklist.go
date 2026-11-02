package hostelresidents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/movechecklist"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

func (s *Service) money() *movechecklist.Money {
	return &movechecklist.Money{DB: s.DB, Ledger: s.Ledger, Audit: s.Audit}
}

func (r *Resident) mover() movechecklist.Resident {
	return movechecklist.Resident{ID: r.ID, BillingCycle: r.BillingCycle, HostelID: r.HostelID, MoveInDate: &r.MoveInDate}
}

// summary is serializeResidentSummary.
func (r *Resident) summary(status string) ordered.Map {
	rec := &residents.Record{ID: r.ID, CreatedAt: r.CreatedAt, DepositAmount: &r.DepositAmount, Email: r.Email, FirstName: r.FirstName, HostelID: r.HostelID,
		LastName: r.LastName, MoveInDate: &r.MoveInDate, Phone: r.Phone, RoomType: r.RoomType, Status: status, UpdatedAt: r.UpdatedAt, UserID: r.UserID}
	if r.ResidentType != nil {
		rec.ResidentType = *r.ResidentType
	}
	return residents.Summary(rec)
}

func (s *Service) auditMove(ctx context.Context, p *authz.Principal, r *Resident, action string, meta bson.D) error {
	return s.Audit.Write(ctx, audit.Entry{ActorID: bsonUser(p), HostelID: r.HostelID, Action: action, EntityType: "ResidentMoveChecklist", EntityID: r.ID.Hex(), Metadata: meta})
}

// MoveInIn is moveInChecklistSchema.
type MoveInIn struct {
	BedCondition, RoomCondition *string
	DepositAmount               float64
	DocumentsCollected          []string
	ItemsProvided               []string
	RoomPhotoAssetIDs           []string
	RulesAccepted               bool
}

type moveInRow struct {
	ID                 bson.ObjectID `bson:"_id"`
	BedCondition       string        `bson:"bedCondition"`
	CompletedAt        *time.Time    `bson:"completedAt"`
	DepositAmount      *float64      `bson:"depositAmount"`
	DocumentsCollected []string      `bson:"documentsCollected"`
	HostelID           bson.ObjectID `bson:"hostelId"`
	ItemsProvided      []string      `bson:"itemsProvided"`
	ResidentID         bson.ObjectID `bson:"residentId"`
	RoomCondition      string        `bson:"roomCondition"`
	RoomPhotoAssetIDs  []string      `bson:"roomPhotoAssetIds"`
	RulesAccepted      *bool         `bson:"rulesAccepted"`
}

func strs(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// or drops a field the stored row never had, as JSON.stringify drops undefined.
func opt[T any](p *T) any {
	if p == nil {
		return ordered.Undefined
	}
	return *p
}

func optList(v []string) any {
	if v == nil {
		return ordered.Undefined
	}
	return v
}

func (m *moveInRow) json() any {
	if m == nil {
		return nil
	}
	return ordered.Map{{Key: "bedCondition", Value: m.BedCondition}, {Key: "completedAt", Value: undefinedTime(m.CompletedAt)}, {Key: "depositAmount", Value: opt(m.DepositAmount)},
		{Key: "documentsCollected", Value: optList(m.DocumentsCollected)}, {Key: "hostelId", Value: m.HostelID.Hex()}, {Key: "id", Value: m.ID.Hex()}, {Key: "itemsProvided", Value: optList(m.ItemsProvided)},
		{Key: "residentId", Value: m.ResidentID.Hex()}, {Key: "roomCondition", Value: m.RoomCondition}, {Key: "roomPhotoAssetIds", Value: optList(m.RoomPhotoAssetIDs)}, {Key: "rulesAccepted", Value: opt(m.RulesAccepted)}}
}

type moveOutRow struct {
	ID                    bson.ObjectID `bson:"_id"`
	CompletedAt           *time.Time    `bson:"completedAt"`
	DamageNotes           string        `bson:"damageNotes"`
	DepositRefundAmount   *float64      `bson:"depositRefundAmount"`
	DepositRefundDecision *string       `bson:"depositRefundDecision"`
	FinalReceiptAssetID   string        `bson:"finalReceiptAssetId"`
	HostelID              bson.ObjectID `bson:"hostelId"`
	ItemReturnNotes       string        `bson:"itemReturnNotes"`
	PendingFeeAmount      *float64      `bson:"pendingFeeAmount"`
	ResidentID            bson.ObjectID `bson:"residentId"`
}

func (m *moveOutRow) json() any {
	if m == nil {
		return nil
	}
	return ordered.Map{{Key: "completedAt", Value: undefinedTime(m.CompletedAt)}, {Key: "damageNotes", Value: m.DamageNotes}, {Key: "depositRefundAmount", Value: opt(m.DepositRefundAmount)},
		{Key: "depositRefundDecision", Value: opt(m.DepositRefundDecision)}, {Key: "finalReceiptAssetId", Value: m.FinalReceiptAssetID}, {Key: "hostelId", Value: m.HostelID.Hex()}, {Key: "id", Value: m.ID.Hex()},
		{Key: "itemReturnNotes", Value: m.ItemReturnNotes}, {Key: "pendingFeeAmount", Value: opt(m.PendingFeeAmount)}, {Key: "residentId", Value: m.ResidentID.Hex()}}
}

func (s *Service) loadMoveIn(ctx context.Context, r *Resident) (*moveInRow, error) {
	var row moveInRow
	err := s.DB.Collection("moveinchecklists").FindOne(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &row, err
}

// MoveIn is getMoveInChecklist.
func (s *Service) MoveIn(ctx context.Context, id, hostelID string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	row, err := s.loadMoveIn(ctx, r)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "checklist", Value: row.json()}, {Key: "resident", Value: r.summary(r.Status)}}, nil
}

// SaveMoveIn is createMoveInChecklist.
func (s *Service) SaveMoveIn(ctx context.Context, id, hostelID string, in MoveInIn, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	by, at := bsonUser(p), now()
	set := bson.D{}
	if in.BedCondition != nil {
		set = append(set, bson.E{Key: "bedCondition", Value: *in.BedCondition})
	}
	set = append(set, bson.E{Key: "depositAmount", Value: in.DepositAmount}, bson.E{Key: "documentsCollected", Value: strs(in.DocumentsCollected)}, bson.E{Key: "itemsProvided", Value: strs(in.ItemsProvided)})
	if in.RoomCondition != nil {
		set = append(set, bson.E{Key: "roomCondition", Value: *in.RoomCondition})
	}
	set = append(set, bson.E{Key: "roomPhotoAssetIds", Value: strs(in.RoomPhotoAssetIDs)}, bson.E{Key: "rulesAccepted", Value: in.RulesAccepted},
		bson.E{Key: "completedAt", Value: at}, bson.E{Key: "completedBy", Value: by}, bson.E{Key: "createdBy", Value: by}, bson.E{Key: "hostelId", Value: r.HostelID},
		bson.E{Key: "residentId", Value: r.ID}, bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "updatedAt", Value: at})
	var row moveInRow
	err = s.DB.Collection("moveinchecklists").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}},
		bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		return nil, rerr("Move-in checklist could not be saved.", "MOVE_IN_SAVE_FAILED", http.StatusInternalServerError)
	}
	items := s.DB.Collection("provideditems")
	if _, err := items.DeleteMany(ctx, bson.D{{Key: "checklistId", Value: row.ID}}); err != nil {
		return nil, err
	}
	if len(in.ItemsProvided) > 0 {
		docs := make([]any, 0, len(in.ItemsProvided))
		for _, name := range in.ItemsProvided {
			docs = append(docs, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "checklistId", Value: row.ID},
				{Key: "name", Value: name}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
		}
		if _, err := items.InsertMany(ctx, docs); err != nil {
			return nil, err
		}
	}
	if err := s.auditMove(ctx, p, r, "MOVE_IN_COMPLETED", nil); err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "checklist", Value: row.json()}, {Key: "resident", Value: r.summary(r.Status)}}, nil
}

// MoveOut is getMoveOutChecklist.
func (s *Service) MoveOut(ctx context.Context, id, hostelID, date string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	var row moveOutRow
	var checklist any
	err = s.DB.Collection("moveoutchecklists").FindOne(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}}).Decode(&row)
	if err == nil {
		checklist = row.json()
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	owed, err := s.money().Outstanding(ctx, r.HostelID, r.ID)
	if err != nil {
		return nil, err
	}
	var preview any
	if r.Status != "MOVED_OUT" {
		pv, err := s.money().Preview(ctx, r.mover(), owed, date)
		if err != nil {
			return nil, err
		}
		preview = pv
	}
	return ordered.Map{{Key: "checklist", Value: checklist}, {Key: "pendingFeeAmount", Value: owed}, {Key: "preview", Value: preview}, {Key: "resident", Value: r.summary(r.Status)}}, nil
}

// MoveOutIn is moveOutChecklistSchema.
type MoveOutIn struct {
	DamageNotes, FinalReceiptAssetID, ItemReturnNotes *string
	DepositRefundAmount                               float64
	DepositRefundDecision                             string
	Dues                                              string
	LastMonthCharge                                   string
	MoveOutDate                                       string
}

// SaveMoveOut is createMoveOutChecklist.
func (s *Service) SaveMoveOut(ctx context.Context, id, hostelID string, in MoveOutIn, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	if in.DepositRefundDecision == "PARTIAL" && in.DepositRefundAmount > r.DepositAmount {
		return nil, rerr("A partial refund cannot be more than the deposit held.", "REFUND_OVER_DEPOSIT", http.StatusBadRequest)
	}
	refund := 0.0
	switch in.DepositRefundDecision {
	case "APPROVED":
		refund = r.DepositAmount
	case "PARTIAL":
		refund = in.DepositRefundAmount
	}
	by := bsonUser(p)
	leavingNow := r.Status != "MOVED_OUT"
	leftOn := movechecklist.MoveOutDay(in.MoveOutDate)
	if leavingNow && leftOn.Before(bs.CalendarDay(r.MoveInDate)) {
		return nil, rerr("They can't leave before the day they moved in.", "MOVE_OUT_BEFORE_MOVE_IN", http.StatusBadRequest)
	}
	m := s.money()
	if leavingNow {
		charge := in.LastMonthCharge
		if charge == "" {
			if charge, err = m.DefaultLastMonthCharge(ctx, r.HostelID); err != nil {
				return nil, err
			}
		}
		if _, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "lastMonthCharge", Value: charge}, {Key: "moveOutDate", Value: leftOn}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: now()}}}}); err != nil {
			return nil, err
		}
		if err := m.SettleLeavingMonth(ctx, r.mover(), leftOn, charge, p); err != nil {
			return nil, err
		}
	}
	var written float64
	if in.Dues == "WRITE_OFF" {
		if written, err = m.WriteOffDues(ctx, r.mover(), p, "Written off at move-out"); err != nil {
			return nil, err
		}
	}
	pending, err := m.Outstanding(ctx, r.HostelID, r.ID)
	if err != nil {
		return nil, err
	}
	at := now()
	set := bson.D{}
	if in.DamageNotes != nil {
		set = append(set, bson.E{Key: "damageNotes", Value: *in.DamageNotes})
	}
	set = append(set, bson.E{Key: "depositRefundDecision", Value: in.DepositRefundDecision})
	if in.FinalReceiptAssetID != nil {
		set = append(set, bson.E{Key: "finalReceiptAssetId", Value: *in.FinalReceiptAssetID})
	}
	if in.ItemReturnNotes != nil {
		set = append(set, bson.E{Key: "itemReturnNotes", Value: *in.ItemReturnNotes})
	}
	set = append(set, bson.E{Key: "depositRefundAmount", Value: refund}, bson.E{Key: "completedAt", Value: at}, bson.E{Key: "completedBy", Value: by}, bson.E{Key: "createdBy", Value: by},
		bson.E{Key: "hostelId", Value: r.HostelID}, bson.E{Key: "pendingFeeAmount", Value: pending}, bson.E{Key: "residentId", Value: r.ID}, bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "updatedAt", Value: at})
	var row moveOutRow
	err = s.DB.Collection("moveoutchecklists").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}},
		bson.D{{Key: "$set", Value: set}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&row)
	if err != nil {
		return nil, rerr("Move-out checklist could not be saved.", "MOVE_OUT_SAVE_FAILED", http.StatusInternalServerError)
	}
	if _, err := s.DB.Collection("depositrefunds").UpdateOne(ctx, bson.D{{Key: "moveOutChecklistId", Value: row.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "amount", Value: refund}, {Key: "decidedAt", Value: at}, {Key: "decidedBy", Value: by}, {Key: "decision", Value: in.DepositRefundDecision},
			{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}, {Key: "updatedAt", Value: at}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: at}, {Key: "__v", Value: 0}}}},
		options.UpdateOne().SetUpsert(true)); err != nil {
		return nil, err
	}
	if _, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "leavingOn", Value: nil}, {Key: "status", Value: "MOVED_OUT"}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: at}}}}); err != nil {
		return nil, err
	}
	if leavingNow {
		if err := s.Cap.Release(ctx, r.HostelID, r.RoomType); err != nil {
			return nil, err
		}
		if err := s.releaseAccount(ctx, r.UserID, r.HostelID); err != nil {
			return nil, err
		}
	}
	if err := s.auditMove(ctx, p, r, "MOVE_OUT_COMPLETED", bson.D{{Key: "pendingFeeAmount", Value: pending}, {Key: "writtenOff", Value: written}}); err != nil {
		return nil, err
	}
	s.moveOutDone(ctx, r, refund, in.DepositRefundDecision)
	return ordered.Map{{Key: "checklist", Value: row.json()}, {Key: "resident", Value: r.summary("MOVED_OUT")}, {Key: "writtenOff", Value: written}}, nil
}

func describeDeposit(decision string, amount float64) string {
	m := "NPR " + money.GroupUS(int64(amount))
	switch decision {
	case "APPROVED":
		if amount > 0 {
			return "Your deposit of " + m + " is approved for refund."
		}
		return ""
	case "PARTIAL":
		return m + " of your deposit is approved for refund; the rest is held against what was owed."
	case "FORFEITED":
		return "Your deposit has been forfeited. Speak to the hostel office if that is unexpected."
	}
	return "Your deposit is still being settled."
}

// moveOutDone is notifyMoveOutCompleted: never fails the move-out.
func (s *Service) moveOutDone(ctx context.Context, r *Resident, amount float64, decision string) {
	if r.UserID == nil {
		return
	}
	body := strings.TrimSpace(fmt.Sprintf("Your stay at %s has been closed. %s", s.hostelName(ctx, r.HostelID), describeDeposit(decision, amount)))
	if _, err := s.Notify.CreateInApp(ctx, notifications.Input{Body: body, Category: "PAYMENT",
		Data: ordered.Map{{Key: "depositAmount", Value: amount}, {Key: "depositDecision", Value: decision}, {Key: "kind", Value: "MOVE_OUT_COMPLETED"}}, HostelID: r.HostelID.Hex(), Priority: "NORMAL",
		Title: "Your stay has ended", UserID: r.UserID.Hex()}); err != nil {
		slog.WarnContext(ctx, "move_out_notification_failed", "error", err)
	}
}

// WriteOff is writeOffResidentDues.
func (s *Service) WriteOff(ctx context.Context, id, hostelID, reason string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	if r.Status != "MOVED_OUT" {
		return nil, rerr("Only what a moved-out resident owes can be written off. Move them out first.", "RESIDENT_STILL_HERE", http.StatusConflict)
	}
	written, err := s.money().WriteOffDues(ctx, r.mover(), p, reason)
	if err != nil {
		return nil, err
	}
	pending, err := s.money().Outstanding(ctx, r.HostelID, r.ID)
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.Collection("moveoutchecklists").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: r.HostelID}, {Key: "residentId", Value: r.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "pendingFeeAmount", Value: pending}, {Key: "updatedBy", Value: bsonUser(p)}, {Key: "updatedAt", Value: now()}}}}); err != nil {
		return nil, err
	}
	if err := s.auditMove(ctx, p, r, "DUES_WRITTEN_OFF", bson.D{{Key: "writtenOff", Value: written}}); err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "writtenOff", Value: written}}, nil
}

var _ = httpx.ISO
