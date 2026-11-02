// Package hostelresidents is /hostel-admin/residents: the staff's roll, one
// resident's record and contacts, registering, status, leave and fees
// (modules/residents/resident.service.ts and its neighbours). It sits above
// residents, ledger, hostelrooms and bookings so it can use all of them.
package hostelresidents

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
)

// Service holds what the resident routes share.
type Service struct {
	DB       *mongo.Database
	Cap      *hostelrooms.Capacity
	Notify   *notifications.Service
	Audit    *audit.Log
	Mail     *email.Sender
	Ledger   *ledger.Engine
	Personal *crypto.Personal
	R2       *storage.R2
	Claims   files.Claims
	AppURL   func(path string) string
	Outbound string
	Config   *platformconfig.Service
	// ActivationSecret hashes activation codes (ACTIVATION_CODE_SECRET).
	ActivationSecret string
}

// rerr is ResidentServiceError.
func rerr(msg, code string, status int) *httpx.Error { return httpx.NewError(status, code, msg, nil) }

var errNotFound = func() error { return rerr("Resident was not found.", "RESIDENT_NOT_FOUND", http.StatusNotFound) }

func objectID(v, label string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(v)
	if err != nil || len(v) != 24 {
		return id, rerr("Invalid "+label+".", "INVALID_OBJECT_ID", http.StatusUnprocessableEntity)
	}
	return id, nil
}

func now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// Resident is the ResidentRecord this module reads.
type Resident struct {
	ID                   bson.ObjectID  `bson:"_id"`
	AdmissionFee         *float64       `bson:"admissionFee"`
	AdmissionFeeDiscount *float64       `bson:"admissionFeeDiscount"`
	BillingCycle         *string        `bson:"billingCycle"`
	CreatedAt            *time.Time     `bson:"createdAt"`
	DemoDataLabel        string         `bson:"demoDataLabel"`
	DepositAmount        float64        `bson:"depositAmount"`
	DetailsData          *string        `bson:"detailsData"`
	Email                string         `bson:"email"`
	FeeOverrideReason    string         `bson:"feeOverrideReason"`
	FirstName            string         `bson:"firstName"`
	Floor                *float64       `bson:"floor"`
	HostelID             bson.ObjectID  `bson:"hostelId"`
	IsDemoData           bool           `bson:"isDemoData"`
	LastMonthCharge      *string        `bson:"lastMonthCharge"`
	LastName             string         `bson:"lastName"`
	LeavingOn            *time.Time     `bson:"leavingOn"`
	LeavingReason        *string        `bson:"leavingReason"`
	MonthlyFee           *float64       `bson:"monthlyFee"`
	MoveInDate           time.Time      `bson:"moveInDate"`
	MoveOutDate          *time.Time     `bson:"moveOutDate"`
	Phone                string         `bson:"phone"`
	PhotoAssetID         *bson.ObjectID `bson:"photoAssetId"`
	ReferralCode         string         `bson:"referralCode"`
	ResidentType         *string        `bson:"residentType"`
	RoomID               *bson.ObjectID `bson:"roomId"`
	RoomNumber           *string        `bson:"roomNumber"`
	RoomType             string         `bson:"roomType"`
	Status               string         `bson:"status"`
	UpdatedAt            *time.Time     `bson:"updatedAt"`
	UserID               *bson.ObjectID `bson:"userId"`
}

func (r *Resident) name() string { return strings.TrimSpace(r.FirstName + " " + r.LastName) }

func (r *Resident) billable() *finance.Billable {
	return &finance.Billable{ID: r.ID, BillingCycle: r.BillingCycle, MonthlyFee: r.MonthlyFee, MoveInDate: &r.MoveInDate, MoveOutDate: r.MoveOutDate, RoomType: &r.RoomType}
}

// PhotoPath is residentPhotoPath.
func PhotoPath(residentID, assetID bson.ObjectID) string {
	return hostelrooms.PhotoPath(residentID, assetID)
}

func isoOrNull(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func nullable[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

func orDefault(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

// Serialize is serializeResident, key for key.
func Serialize(r *Resident) ordered.Map {
	day := finance.BillDay(r.billable())
	if day == 0 {
		day = 1
	}
	out := ordered.Map{
		{Key: "admissionFee", Value: nullable(r.AdmissionFee)},
		{Key: "admissionFeeDiscount", Value: zeroIfNil(r.AdmissionFeeDiscount)},
		{Key: "billingCycle", Value: orDefault(r.BillingCycle, "CALENDAR_MONTH")},
		{Key: "billsOn", Value: "Bills on the " + ledger.OrdinalDay(day)},
		{Key: "leavingOn", Value: isoOrNull(r.LeavingOn)},
		{Key: "leavingReason", Value: nullable(r.LeavingReason)},
		{Key: "createdAt", Value: undefinedTime(r.CreatedAt)},
		{Key: "demoDataLabel", Value: r.DemoDataLabel},
		{Key: "depositAmount", Value: r.DepositAmount},
		{Key: "email", Value: r.Email},
		{Key: "firstName", Value: r.FirstName},
		{Key: "hostelId", Value: r.HostelID.Hex()},
		{Key: "id", Value: r.ID.Hex()},
		{Key: "isDemoData", Value: r.IsDemoData},
		{Key: "lastName", Value: r.LastName},
		{Key: "monthlyFee", Value: zeroIfNil(r.MonthlyFee)},
	}
	if r.MonthlyFee == nil {
		out = append(out, ordered.Pair{Key: "specialFee", Value: nil})
	} else {
		out = append(out, ordered.Pair{Key: "specialFee", Value: ordered.Map{{Key: "amount", Value: *r.MonthlyFee}, {Key: "reason", Value: r.FeeOverrideReason}}})
	}
	var roomID any
	if r.RoomID != nil {
		roomID = r.RoomID.Hex()
	}
	var photo any
	if r.PhotoAssetID != nil {
		photo = PhotoPath(r.ID, *r.PhotoAssetID)
	}
	out = append(out,
		ordered.Pair{Key: "floor", Value: nullable(r.Floor)},
		ordered.Pair{Key: "roomId", Value: roomID},
		ordered.Pair{Key: "roomNumber", Value: nullable(r.RoomNumber)},
		ordered.Pair{Key: "moveOutDate", Value: isoOrNull(r.MoveOutDate)},
		ordered.Pair{Key: "moveInDate", Value: httpx.ISO(r.MoveInDate)},
		ordered.Pair{Key: "phone", Value: r.Phone},
		ordered.Pair{Key: "photo", Value: photo},
		ordered.Pair{Key: "referralCode", Value: r.ReferralCode},
		ordered.Pair{Key: "residentType", Value: orDefault(r.ResidentType, "STUDENT")},
		ordered.Pair{Key: "roomType", Value: r.RoomType},
		ordered.Pair{Key: "status", Value: r.Status},
		ordered.Pair{Key: "updatedAt", Value: undefinedTime(r.UpdatedAt)},
	)
	if r.UserID != nil {
		out = append(out, ordered.Pair{Key: "userId", Value: r.UserID.Hex()})
	}
	return out
}

func zeroIfNil(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func undefinedTime(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

// Account is a resident's sign-in as the roll shows it.
type Account struct {
	Email string  `json:"email"`
	Image *string `json:"image"`
	Name  string  `json:"name"`
}

// accounts is findResidentAccounts.
func (s *Service) accounts(ctx context.Context, rows []Resident) (map[bson.ObjectID]*Account, error) {
	ids := bson.A{}
	for _, r := range rows {
		if r.UserID != nil {
			ids = append(ids, *r.UserID)
		}
	}
	out := map[bson.ObjectID]*Account{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := s.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
		options.Find().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "image", Value: 1}, {Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var users []struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
		Image *string       `bson:"image"`
		Name  string        `bson:"name"`
	}
	if err := cur.All(ctx, &users); err != nil {
		return nil, err
	}
	for _, u := range users {
		out[u.ID] = &Account{u.Email, u.Image, u.Name}
	}
	return out, nil
}

func withAccount(m ordered.Map, r *Resident, accts map[bson.ObjectID]*Account) ordered.Map {
	var a any
	if r.UserID != nil {
		if acc, ok := accts[*r.UserID]; ok {
			a = acc
		}
	}
	return append(m, ordered.Pair{Key: "account", Value: a})
}

// find is findResidentForPrincipal: outside the caller's hostels it is a 404.
func (s *Service) find(ctx context.Context, id string, p *authz.Principal, requested string) (*Resident, error) {
	rid, err := objectID(id, "resident id")
	if err != nil {
		return nil, err
	}
	scope, err := hostelrooms.ScopeFilter(p, requested)
	if err != nil {
		return nil, err
	}
	var r Resident
	err = s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: rid}, {Key: "isDeleted", Value: false}, scope}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, errNotFound()
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// audit is auditResidentAction.
func (s *Service) auditResident(ctx context.Context, p *authz.Principal, hostel, resident bson.ObjectID, action string, meta bson.D) error {
	return s.Audit.Write(ctx, audit.Entry{ActorID: hostelrooms.UserID(p), HostelID: hostel, Action: action, EntityType: "Resident", EntityID: resident.Hex(), Metadata: meta})
}

func normalizedEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }
