package hostelresidents

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/qr"
)

const maxWaiting = 60

func formErr(msg, code string, status int) *httpx.Error {
	return httpx.NewError(status, code, msg, nil)
}

type formLink struct {
	ID                  bson.ObjectID `bson:"_id"`
	Enabled             bool          `bson:"enabled"`
	GuardianDocRequired bool          `bson:"guardianDocRequired"`
	Token               string        `bson:"token"`
}

// formURL is admissionFormUrl.
func (s *Service) formURL(token string) string { return s.Outbound + "/join/apply/" + token }

// linkOf finds the hostel's Form QR link, making it when there is none.
func (s *Service) linkOf(ctx context.Context, hostel bson.ObjectID, p *authz.Principal) (*formLink, error) {
	coll := s.DB.Collection("admissionformlinks")
	var l formLink
	err := coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&l)
	if err == nil {
		return &l, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	raw := make([]byte, 9)
	_, _ = rand.Read(raw)
	at := now()
	l = formLink{ID: bson.NewObjectID(), Enabled: true, Token: base64.RawURLEncoding.EncodeToString(raw)}
	_, err = coll.InsertOne(ctx, bson.D{{Key: "_id", Value: l.ID}, {Key: "hostelId", Value: hostel}, {Key: "token", Value: l.Token}, {Key: "enabled", Value: true},
		{Key: "guardianDocRequired", Value: false}, {Key: "createdBy", Value: hostelrooms.UserID(p)}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
	if mongo.IsDuplicateKeyError(err) {
		err = coll.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}).Decode(&l)
	}
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// FormLink is getAdmissionFormLink.
func (s *Service) FormLink(ctx context.Context, hostel bson.ObjectID, p *authz.Principal) (ordered.Map, error) {
	l, err := s.linkOf(ctx, hostel, p)
	if err != nil {
		return nil, err
	}
	url := s.formURL(l.Token)
	var qrData any
	if d, err := qr.DataURL(url, qr.Options{Width: 480, Margin: 1, SetMargin: true}); err == nil {
		qrData = d
	}
	return ordered.Map{{Key: "enabled", Value: l.Enabled}, {Key: "guardianDocRequired", Value: l.GuardianDocRequired}, {Key: "hostelName", Value: s.hostelNameOr(ctx, hostel, "")},
		{Key: "qrDataUrl", Value: qrData}, {Key: "url", Value: url}}, nil
}

func (s *Service) hostelNameOr(ctx context.Context, hostel bson.ObjectID, def string) string {
	var h struct {
		Name string `bson:"name"`
	}
	_ = s.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&h)
	if h.Name == "" {
		return def
	}
	return h.Name
}

// FormSettings is updateAdmissionFormSettings.
func (s *Service) FormSettings(ctx context.Context, hostel bson.ObjectID, guardianDoc bool, p *authz.Principal) (ordered.Map, error) {
	if _, err := s.linkOf(ctx, hostel, p); err != nil {
		return nil, err
	}
	if _, err := s.DB.Collection("admissionformlinks").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "guardianDocRequired", Value: guardianDoc}, {Key: "updatedAt", Value: now()}}}}); err != nil {
		return nil, err
	}
	return s.FormLink(ctx, hostel, p)
}

type formUpload struct {
	FileAssetID bson.ObjectID `bson:"fileAssetId"`
	Kind        string        `bson:"kind"`
}

type formDoc struct {
	ID           bson.ObjectID  `bson:"_id"`
	DetailsData  *string        `bson:"detailsData"`
	Documents    []formUpload   `bson:"documents"`
	Email        string         `bson:"email"`
	FirstName    string         `bson:"firstName"`
	HostelID     bson.ObjectID  `bson:"hostelId"`
	LastName     string         `bson:"lastName"`
	Phone        string         `bson:"phone"`
	PhotoAssetID *bson.ObjectID `bson:"photoAssetId"`
	ResidentID   *bson.ObjectID `bson:"residentId"`
	ResidentType string         `bson:"residentType"`
	Status       string         `bson:"status"`
	SubmittedAt  time.Time      `bson:"submittedAt"`
	UserID       *bson.ObjectID `bson:"userId"`
}

func (s *Service) formView(f *formDoc) ordered.Map {
	docs := make([]ordered.Map, 0, len(f.Documents))
	for _, d := range f.Documents {
		label, ok := documentLabels[d.Kind]
		if !ok {
			label = d.Kind
		}
		docs = append(docs, ordered.Map{{Key: "assetId", Value: d.FileAssetID.Hex()}, {Key: "kind", Value: d.Kind}, {Key: "label", Value: label}})
	}
	var photo, rid any
	if f.PhotoAssetID != nil {
		photo = "/api/v1/hostel-admin/residents/admission-forms/" + f.ID.Hex() + "/photo?v=" + f.PhotoAssetID.Hex()
	}
	if f.ResidentID != nil {
		rid = f.ResidentID.Hex()
	}
	return ordered.Map{{Key: "details", Value: s.openDetails(f.DetailsData)}, {Key: "documents", Value: docs}, {Key: "email", Value: f.Email}, {Key: "firstName", Value: f.FirstName},
		{Key: "id", Value: f.ID.Hex()}, {Key: "lastName", Value: f.LastName}, {Key: "phone", Value: f.Phone}, {Key: "photo", Value: photo}, {Key: "residentId", Value: rid},
		{Key: "residentType", Value: f.ResidentType}, {Key: "status", Value: f.Status}, {Key: "submittedAt", Value: httpx.ISO(f.SubmittedAt)}}
}

// Forms is listAdmissionForms.
func (s *Service) Forms(ctx context.Context, hostel bson.ObjectID) (ordered.Map, error) {
	cur, err := s.DB.Collection("admissionforms").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "status", Value: "PENDING"}},
		options.Find().SetSort(bson.D{{Key: "submittedAt", Value: -1}}).SetLimit(maxWaiting))
	if err != nil {
		return nil, err
	}
	var rows []formDoc
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]ordered.Map, 0, len(rows))
	for i := range rows {
		out = append(out, s.formView(&rows[i]))
	}
	return ordered.Map{{Key: "forms", Value: out}, {Key: "waiting", Value: len(rows)}}, nil
}

func (s *Service) findForm(ctx context.Context, hostel bson.ObjectID, id string) (*formDoc, error) {
	notFound := formErr("That form was not found.", "ADMISSION_FORM_NOT_FOUND", http.StatusNotFound)
	fid, err := bson.ObjectIDFromHex(id)
	if err != nil || len(id) != 24 {
		return nil, notFound
	}
	var f formDoc
	err = s.DB.Collection("admissionforms").FindOne(ctx, bson.D{{Key: "_id", Value: fid}, {Key: "hostelId", Value: hostel}}).Decode(&f)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, notFound
	}
	return &f, err
}

// Form is getAdmissionForm.
func (s *Service) Form(ctx context.Context, hostel bson.ObjectID, id string) (ordered.Map, error) {
	f, err := s.findForm(ctx, hostel, id)
	if err != nil {
		return nil, err
	}
	return s.formView(f), nil
}

// DeclineForm is declineAdmissionForm.
func (s *Service) DeclineForm(ctx context.Context, hostel bson.ObjectID, id string, p *authz.Principal) (ordered.Map, error) {
	f, err := s.findForm(ctx, hostel, id)
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.Collection("admissionforms").UpdateOne(ctx, bson.D{{Key: "_id", Value: f.ID}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: now()}, {Key: "decidedBy", Value: hostelrooms.UserID(p)}, {Key: "status", Value: "DECLINED"}, {Key: "updatedAt", Value: now()}}}}); err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "ok", Value: true}}, nil
}

// FormPhoto is readAdmissionFormPhoto.
func (s *Service) FormPhoto(ctx context.Context, hostel bson.ObjectID, id string) (photoStream, string, error) {
	f, err := s.findForm(ctx, hostel, id)
	if err != nil {
		return nil, "", err
	}
	if f.PhotoAssetID == nil {
		return nil, "", formErr("That form has no photo.", "PHOTO_MISSING", http.StatusNotFound)
	}
	return s.streamAsset(ctx, *f.PhotoAssetID)
}

// formSubmitter is admissionFormSubmitter.
func (s *Service) formSubmitter(ctx context.Context, hostel bson.ObjectID, id string) *bson.ObjectID {
	fid, err := bson.ObjectIDFromHex(id)
	if err != nil || len(id) != 24 {
		return nil
	}
	var f formDoc
	if s.DB.Collection("admissionforms").FindOne(ctx, bson.D{{Key: "_id", Value: fid}, {Key: "hostelId", Value: hostel}}, options.FindOne().SetProjection(bson.D{{Key: "userId", Value: 1}})).Decode(&f) != nil {
		return nil
	}
	return f.UserID
}

// markFormAdded is markAdmissionFormAdded.
func (s *Service) markFormAdded(ctx context.Context, hostel bson.ObjectID, id string, resident bson.ObjectID, p *authz.Principal) error {
	fid, err := bson.ObjectIDFromHex(id)
	if err != nil || len(id) != 24 {
		return nil
	}
	by := hostelrooms.UserID(p)
	var f formDoc
	err = s.DB.Collection("admissionforms").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: fid}, {Key: "hostelId", Value: hostel}, {Key: "status", Value: "PENDING"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "decidedAt", Value: now()}, {Key: "decidedBy", Value: by}, {Key: "residentId", Value: resident}, {Key: "status", Value: "ADDED"}, {Key: "updatedAt", Value: now()}}}}).Decode(&f)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil
	}
	if err != nil {
		return err
	}
	if f.PhotoAssetID != nil {
		if _, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: resident}, {Key: "photoAssetId", Value: nil}}, bson.D{{Key: "$set", Value: bson.D{{Key: "photoAssetId", Value: *f.PhotoAssetID}}}}); err != nil {
			return err
		}
	}
	return s.saveDocuments(ctx, resident, hostel, f.Documents, by)
}

// saveDocuments is saveResidentDocuments.
func (s *Service) saveDocuments(ctx context.Context, resident, hostel bson.ObjectID, docs []formUpload, by bson.ObjectID) error {
	if len(docs) == 0 {
		return nil
	}
	rows := make([]any, 0, len(docs))
	at := now()
	for _, d := range docs {
		rows = append(rows, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "residentId", Value: resident}, {Key: "hostelId", Value: hostel}, {Key: "documentType", Value: d.Kind},
			{Key: "fileAssetId", Value: d.FileAssetID}, {Key: "uploadedBy", Value: by}, {Key: "uploadedAt", Value: at}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}})
	}
	_, err := s.DB.Collection("residentdocuments").InsertMany(ctx, rows)
	return err
}
