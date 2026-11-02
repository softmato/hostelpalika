package hostelresidents

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
)

// ListQuery is residentListQuerySchema.
type ListQuery struct {
	HostelID     string
	Page         pagination.Query
	Q            string
	ResidentType string
	Status       string
}

// ListOut is what listResidents returns.
type ListOut struct {
	Pagination pagination.Meta `json:"pagination"`
	Residents  []ordered.Map   `json:"residents"`
}

// List is listResidents.
func (s *Service) List(ctx context.Context, q ListQuery, p *authz.Principal) (*ListOut, error) {
	scope, err := hostelrooms.ScopeFilter(p, q.HostelID)
	if err != nil {
		return nil, err
	}
	filter := bson.D{{Key: "isDeleted", Value: false}, scope}
	if q.Status != "" {
		filter = append(filter, bson.E{Key: "status", Value: q.Status})
	}
	if q.ResidentType != "" {
		filter = append(filter, bson.E{Key: "residentType", Value: q.ResidentType})
	}
	if q.Q != "" {
		re := bson.Regex{Pattern: regexp.QuoteMeta(q.Q), Options: "i"}
		filter = append(filter, bson.E{Key: "$or", Value: bson.A{
			bson.D{{Key: "firstName", Value: re}}, bson.D{{Key: "lastName", Value: re}},
			bson.D{{Key: "phone", Value: re}}, bson.D{{Key: "email", Value: re}},
		}})
	}
	rng := pagination.RangeOf(q.Page)
	coll := s.DB.Collection("residents")
	cur, err := coll.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetSkip(int64(rng.Skip)).SetLimit(int64(rng.Limit)))
	if err != nil {
		return nil, err
	}
	var rows []Resident
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	total, err := coll.CountDocuments(ctx, filter)
	if err != nil {
		return nil, err
	}
	accts, err := s.accounts(ctx, rows)
	if err != nil {
		return nil, err
	}
	out := &ListOut{Pagination: pagination.MetaOf(q.Page, int(total)), Residents: make([]ordered.Map, 0, len(rows))}
	for i := range rows {
		out.Residents = append(out.Residents, withAccount(Serialize(&rows[i]), &rows[i], accts))
	}
	return out, nil
}

// openDetails never fails: a blob that will not open reads as nothing on file.
func (s *Service) openDetails(blob *string) any {
	if blob == nil || *blob == "" || s.Personal == nil {
		return nil
	}
	raw, err := s.Personal.Decrypt(*blob)
	if err != nil || !json.Valid(raw) {
		return nil
	}
	return json.RawMessage(raw)
}

var documentLabels = map[string]string{"APPLICANT_ID": "Citizenship or ID", "GUARDIAN_ID": "Guardian's citizenship or ID"}

type document struct {
	AssetID string `json:"assetId"`
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`
}

// documents is listResidentDocuments.
func (s *Service) documents(ctx context.Context, id bson.ObjectID) ([]document, error) {
	cur, err := s.DB.Collection("residentdocuments").Find(ctx, bson.D{{Key: "residentId", Value: id}}, options.Find().SetSort(bson.D{{Key: "uploadedAt", Value: 1}}).SetLimit(50))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID           bson.ObjectID `bson:"_id"`
		DocumentType string        `bson:"documentType"`
		FileAssetID  bson.ObjectID `bson:"fileAssetId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]document, 0, len(rows))
	for _, r := range rows {
		label, ok := documentLabels[r.DocumentType]
		if !ok {
			label = r.DocumentType
		}
		out = append(out, document{r.FileAssetID.Hex(), r.ID.Hex(), r.DocumentType, label})
	}
	return out, nil
}

// Get is getResidentById.
func (s *Service) Get(ctx context.Context, id, hostelID string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	accts, err := s.accounts(ctx, []Resident{*r})
	if err != nil {
		return nil, err
	}
	docs, err := s.documents(ctx, r.ID)
	if err != nil {
		return nil, err
	}
	m := Serialize(r)
	m = append(m, ordered.Pair{Key: "details", Value: s.openDetails(r.DetailsData)}, ordered.Pair{Key: "documents", Value: docs})
	return ordered.Map{{Key: "resident", Value: withAccount(m, r, accts)}}, nil
}

func serializeContact(row bson.M, fields ...string) ordered.Map {
	out := ordered.Map{}
	for _, f := range fields {
		switch f {
		case "createdAt", "updatedAt":
			if t, ok := row[f].(bson.DateTime); ok {
				out = append(out, ordered.Pair{Key: f, Value: httpx.ISO(t.Time())})
			} else {
				out = append(out, ordered.Pair{Key: f, Value: ordered.Undefined})
			}
		case "hostelId", "residentId":
			out = append(out, ordered.Pair{Key: f, Value: idHex(row[f])})
		case "id":
			out = append(out, ordered.Pair{Key: "id", Value: idHex(row["_id"])})
		case "isPrimary":
			b, _ := row[f].(bool)
			out = append(out, ordered.Pair{Key: f, Value: b})
		default: // email is "" when unset, as `?? ""`
			s, _ := row[f].(string)
			out = append(out, ordered.Pair{Key: f, Value: s})
		}
	}
	return out
}

func idHex(v any) string {
	if id, ok := v.(bson.ObjectID); ok {
		return id.Hex()
	}
	return ""
}

var (
	guardianFields  = []string{"createdAt", "email", "firstName", "hostelId", "id", "isPrimary", "lastName", "phone", "relation", "residentId", "updatedAt"}
	emergencyFields = []string{"createdAt", "hostelId", "id", "isPrimary", "name", "phone", "relation", "residentId", "updatedAt"}
	contactsSort    = bson.D{{Key: "isPrimary", Value: -1}, {Key: "createdAt", Value: 1}}
	contactsPerKind = int64(100)
)

func (s *Service) contacts(ctx context.Context, coll string, id bson.ObjectID, fields []string) ([]ordered.Map, error) {
	cur, err := s.DB.Collection(coll).Find(ctx, bson.D{{Key: "residentId", Value: id}}, options.Find().SetSort(contactsSort).SetLimit(contactsPerKind))
	if err != nil {
		return nil, err
	}
	var rows []bson.M
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(rows))
	for _, r := range rows {
		out = append(out, serializeContact(r, fields...))
	}
	return out, nil
}

// Contacts is listResidentContacts.
func (s *Service) Contacts(ctx context.Context, id, hostelID string, p *authz.Principal) (ordered.Map, error) {
	r, err := s.find(ctx, id, p, hostelID)
	if err != nil {
		return nil, err
	}
	em, err := s.contacts(ctx, "emergencycontacts", r.ID, emergencyFields)
	if err != nil {
		return nil, err
	}
	g, err := s.contacts(ctx, "guardians", r.ID, guardianFields)
	if err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "emergencyContacts", Value: em}, {Key: "guardians", Value: g}}, nil
}

// Photo is readResidentPhoto + streamCardPhoto: the bytes and their type.
func (s *Service) Photo(ctx context.Context, id string, p *authz.Principal) (body interface {
	Read([]byte) (int, error)
	Close() error
}, contentType string, err error) {
	r, err := s.find(ctx, id, p, "")
	if err != nil {
		return nil, "", err
	}
	if r.PhotoAssetID == nil {
		return nil, "", rerr("No photo on file.", "PHOTO_MISSING", http.StatusNotFound)
	}
	var asset struct {
		Bucket   string `bson:"bucket"`
		Key      string `bson:"key"`
		MimeType string `bson:"mimeType"`
	}
	err = s.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: *r.PhotoAssetID}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}}).Decode(&asset)
	if err != nil {
		return nil, "", rerr("That photo is no longer available.", "PHOTO_MISSING", http.StatusNotFound)
	}
	rd, gerr := s.R2.Get(ctx, asset.Bucket, asset.Key)
	if gerr != nil {
		return nil, "", rerr("Could not load that photo right now.", "PHOTO_UNAVAILABLE", http.StatusBadGateway)
	}
	if asset.MimeType == "" {
		asset.MimeType = "application/octet-stream"
	}
	return rd, asset.MimeType, nil
}
