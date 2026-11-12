package hostels

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/files"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// kycSteps is KYC_STEPS, in the order the ring shows them.
var kycSteps = []string{"details", "photos", "rates", "rooms", "documents", "payout", "payments", "opening", "food", "rules", "facilities", "location", "agreement"}

// kycRequired is KYC_REQUIRED_STEPS: what must be done before Submit.
var kycRequired = []string{"details", "photos", "rates", "documents", "location", "agreement"}

// kycMinPhotos is enough to fill the listing's cover and a first look inside.
const kycMinPhotos = 3

type kycDetails struct {
	Address    string `json:"address"`
	Area       string `json:"area"`
	City       string `json:"city"`
	HostelType string `json:"hostelType"`
}

type kycDocument struct {
	CanRemove       bool    `json:"canRemove"`
	FileAssetID     *string `json:"fileAssetId"`
	FileName        *string `json:"fileName"`
	ID              string  `json:"id"`
	MimeType        *string `json:"mimeType"`
	RejectionReason *string `json:"rejectionReason"`
	Status          string  `json:"status"`
	Type            string  `json:"type"`
}

type kycReview struct {
	CanSubmit   bool     `json:"canSubmit"`
	Missing     []string `json:"missing"`
	Note        *string  `json:"note"`
	Status      string   `json:"status"`
	SubmittedAt *string  `json:"submittedAt"`
}

type kycStep struct {
	Done     bool   `json:"done"`
	Key      string `json:"key"`
	Required bool   `json:"required"`
}

type kycOut struct {
	Details    kycDetails    `json:"details"`
	Documents  []kycDocument `json:"documents"`
	Facilities []string      `json:"facilities"`
	MinPhotos  int           `json:"minPhotos"`
	Percent    int           `json:"percent"`
	PhotoCount int           `json:"photoCount"`
	Review     *kycReview    `json:"review"`
	Rules      []string      `json:"rules"`
	Steps      []kycStep     `json:"steps"`
}

type kycHostel struct {
	Facilities []string `bson:"facilities"`
	HostelType string   `bson:"hostelType"`
	Kyc        *struct {
		Note        *string    `bson:"note"`
		Required    bool       `bson:"required"`
		Status      *string    `bson:"status"`
		SubmittedAt *time.Time `bson:"submittedAt"`
	} `bson:"kyc"`
	Location struct {
		Address        string   `bson:"address"`
		Area           string   `bson:"area"`
		City           string   `bson:"city"`
		Lat            *float64 `bson:"lat"`
		LocationSource string   `bson:"locationSource"`
	} `bson:"location"`
	Photos []struct {
		URL string `bson:"url"`
	} `bson:"photos"`
	Rules              []string `bson:"rules"`
	Status             string   `bson:"status"`
	VerificationStatus string   `bson:"verificationStatus"`
}

// profileUsable is isPaymentProfileUsable: the same test the resident pay screen
// uses, so the tick and "can pay" agree.
func profileUsable(ctx context.Context, db *mongo.Database, id bson.ObjectID) (bool, error) {
	var p struct {
		StaticQR      any    `bson:"staticQrAssetId"`
		Esewa         string `bson:"esewaId"`
		Khalti        string `bson:"khaltiId"`
		Bank          string `bson:"bankAccountNumber"`
		ExtraAccounts bson.A `bson:"extraAccounts"`
		Gateways      []struct {
			EnabledAt    *time.Time `bson:"enabledAt"`
			AccountKind  string     `bson:"accountKind"`
			Provider     string     `bson:"provider"`
			MerchantCode string     `bson:"merchantCode"`
		} `bson:"gateways"`
	}
	err := db.Collection("hostelpaymentprofiles").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}, options.FindOne().SetProjection(bson.D{
		{Key: "staticQrAssetId", Value: 1}, {Key: "esewaId", Value: 1}, {Key: "khaltiId", Value: 1}, {Key: "bankAccountNumber", Value: 1}, {Key: "extraAccounts", Value: 1}, {Key: "gateways", Value: 1}})).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if p.StaticQR != nil || p.Esewa != "" || p.Khalti != "" || p.Bank != "" || len(p.ExtraAccounts) > 0 {
		return true, nil
	}
	for _, g := range p.Gateways {
		if g.EnabledAt != nil && g.AccountKind != "PERSONAL" && (g.Provider == "KHALTI" || g.MerchantCode != "") {
			return true, nil
		}
	}
	return false, nil
}

func (a *Admin) exists(ctx context.Context, coll string, filter bson.D) (bool, error) {
	err := a.DB.Collection(coll).FindOne(ctx, filter, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	return err == nil, err
}

// kycOf is getHostelKyc: everything is read from where it already lives, so filling
// it in anywhere ticks it off.
func (a *Admin) kycOf(ctx context.Context, id bson.ObjectID, viewerID string) (*kycOut, error) {
	var h kycHostel
	err := a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{
		{Key: "photos", Value: 1}, {Key: "rules", Value: 1}, {Key: "facilities", Value: 1}, {Key: "location", Value: 1}, {Key: "hostelType", Value: 1}, {Key: "kyc", Value: 1}, {Key: "status", Value: 1}, {Key: "verificationStatus", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
	}
	if err != nil {
		return nil, err
	}
	cur, err := a.DB.Collection("hosteldocuments").Find(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(200).SetProjection(bson.D{
			{Key: "documentType", Value: 1}, {Key: "status", Value: 1}, {Key: "fileAssetId", Value: 1}, {Key: "rejectionReason", Value: 1}, {Key: "createdBy", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var docs []struct {
		ID        bson.ObjectID  `bson:"_id"`
		CreatedBy *bson.ObjectID `bson:"createdBy"`
		Type      string         `bson:"documentType"`
		FileAsset *bson.ObjectID `bson:"fileAssetId"`
		Rejection *string        `bson:"rejectionReason"`
		Status    string         `bson:"status"`
	}
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}
	fileIDs := bson.A{}
	for _, d := range docs {
		if d.FileAsset != nil {
			fileIDs = append(fileIDs, *d.FileAsset)
		}
	}
	type fileRow struct {
		ID       bson.ObjectID `bson:"_id"`
		FileName *string       `bson:"fileName"`
		MimeType *string       `bson:"mimeType"`
	}
	var fileRows []fileRow
	if len(fileIDs) > 0 {
		cur, err := a.DB.Collection("fileassets").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: fileIDs}}}},
			options.Find().SetProjection(bson.D{{Key: "fileName", Value: 1}, {Key: "mimeType", Value: 1}}))
		if err != nil {
			return nil, err
		}
		if err := cur.All(ctx, &fileRows); err != nil {
			return nil, err
		}
	}
	fileByID := make(map[bson.ObjectID]fileRow, len(fileRows))
	for _, f := range fileRows {
		fileByID[f.ID] = f
	}

	byHostel := bson.D{{Key: "hostelId", Value: id}}
	payout, err := a.exists(ctx, "hostelpayoutaccounts", byHostel)
	if err != nil {
		return nil, err
	}
	usable, err := profileUsable(ctx, a.DB, id)
	if err != nil {
		return nil, err
	}
	food, err := a.exists(ctx, "foodroutines", bson.D{{Key: "hostelId", Value: id}, {Key: "meals.0", Value: bson.D{{Key: "$exists", Value: true}}}})
	if err != nil {
		return nil, err
	}
	rooms, err := a.exists(ctx, "hostelrooms", bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}})
	if err != nil {
		return nil, err
	}
	var settings struct {
		OpeningBalance any   `bson:"openingBalance"`
		RoomTracking   *bool `bson:"roomTracking"`
	}
	err = a.DB.Collection("hostelsettings").FindOne(ctx, byHostel, options.FindOne().SetProjection(bson.D{{Key: "openingBalance", Value: 1}, {Key: "roomTracking", Value: 1}})).Decode(&settings)
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	rates, err := a.exists(ctx, "feeschedules", bson.D{{Key: "effectiveTo", Value: nil}, {Key: "hostelId", Value: id}, {Key: "rates.0", Value: bson.D{{Key: "$exists", Value: true}}}})
	if err != nil {
		return nil, err
	}
	signed, err := a.exists(ctx, "hostelagreementsignatures", byHostel)
	if err != nil {
		return nil, err
	}

	photoCount := 0
	for _, p := range h.Photos {
		if p.URL != "" {
			photoCount++
		}
	}
	done := map[string]bool{
		"agreement":  signed,
		"details":    strings.TrimSpace(h.Location.Area) != "" && strings.TrimSpace(h.Location.City) != "",
		"documents":  len(docs) > 0,
		"facilities": len(h.Facilities) > 0,
		"food":       food,
		// A geocoded point is a guess at the neighbourhood; only a placed pin counts.
		"location": h.Location.Lat != nil && h.Location.LocationSource == "MANUAL",
		"payments": usable,
		"payout":   payout,
		"photos":   photoCount >= kycMinPhotos,
		"rates":    rates,
		"rules":    len(h.Rules) > 0,
		// Not floor-wise (the default until chosen): nothing to number.
		"rooms":   settings.RoomTracking == nil || !*settings.RoomTracking || rooms,
		"opening": settings.OpeningBalance != nil,
	}

	out := &kycOut{
		Details:    kycDetails{h.Location.Address, h.Location.Area, h.Location.City, h.HostelType},
		Documents:  make([]kycDocument, 0, len(docs)),
		Facilities: h.Facilities,
		MinPhotos:  kycMinPhotos,
		PhotoCount: photoCount,
		Rules:      h.Rules,
		Steps:      make([]kycStep, 0, len(kycSteps)),
	}
	if out.Details.HostelType == "" {
		out.Details.HostelType = "CO_LIVING"
	}
	if out.Facilities == nil {
		out.Facilities = []string{}
	}
	if out.Rules == nil {
		out.Rules = []string{}
	}
	for _, d := range docs {
		row := kycDocument{ID: d.ID.Hex(), RejectionReason: d.Rejection, Status: d.Status, Type: d.Type,
			// Only the uploader, and only until a platform admin approves it.
			CanRemove: viewerID != "" && d.CreatedBy != nil && d.CreatedBy.Hex() == viewerID && d.Status != "APPROVED"}
		if d.FileAsset != nil {
			hex := d.FileAsset.Hex()
			row.FileAssetID = &hex
			if f, ok := fileByID[*d.FileAsset]; ok {
				row.FileName, row.MimeType = f.FileName, f.MimeType
			}
		}
		out.Documents = append(out.Documents, row)
	}
	// A quick sign-up always has a review. Any other hostel gets one until it is
	// verified, so a branch or an admin-created hostel can send its KYC too.
	isRequired := h.Kyc != nil && h.Kyc.Required
	needsReview := isRequired || (h.VerificationStatus != "" && h.VerificationStatus != "VERIFIED")
	doneCount := 0
	for _, key := range kycSteps {
		if done[key] {
			doneCount++
		}
		required := false
		if needsReview {
			for _, r := range kycRequired {
				required = required || r == key
			}
		}
		out.Steps = append(out.Steps, kycStep{done[key], key, required})
	}
	out.Percent = int(math.Round(100 * float64(doneCount) / float64(len(kycSteps))))
	if needsReview {
		status := "DRAFT"
		if h.Kyc != nil && h.Kyc.Status != nil {
			status = *h.Kyc.Status
		}
		if !isRequired && h.Status == "REJECTED" {
			status = "REJECTED"
		}
		missing := []string{}
		for _, key := range kycRequired {
			if !done[key] {
				missing = append(missing, key)
			}
		}
		r := &kycReview{CanSubmit: len(missing) == 0 && (status == "DRAFT" || status == "REJECTED"), Missing: missing, Status: status}
		if status == "REJECTED" && h.Kyc != nil {
			r.Note = h.Kyc.Note
		}
		if h.Kyc != nil && h.Kyc.SubmittedAt != nil {
			s := h.Kyc.SubmittedAt.UTC().Format("2006-01-02T15:04:05.000Z")
			r.SubmittedAt = &s
		}
		out.Review = r
	}
	return out, nil
}

type kycWrap struct {
	Kyc *kycOut `json:"kyc"`
}

func (a *Admin) kycGet(c *gin.Context) {
	p := authz.From(c)
	id, err := AdminHostel(p, c.Query("hostelId"))
	if err == nil {
		var kyc *kycOut
		if kyc, err = a.kycOf(c, id, p.UserID); err == nil {
			httpx.OK(c, kycWrap{kyc}, "Hostel KYC")
			return
		}
	}
	httpx.Fail(c, err)
}

func (a *Admin) kycAddDocuments(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := AdminHostel(p, optionalHostel(body))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	docs := files.ParseSubmitted(f, "documents", false, 1, "Upload at least one document.")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	var h struct {
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	if err := a.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "ownerId", Value: 1}})).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
		}
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	claimed, err := a.Claims.Claim(c, a.DB, docs, actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	rows := make([]any, 0, len(claimed))
	for _, d := range claimed {
		rows = append(rows, bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelId", Value: id}, {Key: "ownerId", Value: h.OwnerID}, {Key: "documentType", Value: d.DocumentType},
			{Key: "fileAssetId", Value: d.FileAssetID}, {Key: "status", Value: "PENDING"}, {Key: "createdBy", Value: actor}, {Key: "updatedBy", Value: actor},
			{Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}})
	}
	if _, err := a.DB.Collection("hosteldocuments").InsertMany(c, rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	kyc, err := a.kycOf(c, id, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, kycWrap{kyc}, "Document added")
}

func (a *Admin) kycRemoveDocument(c *gin.Context) {
	p := authz.From(c)
	id, err := AdminHostel(p, c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	docID, err := bson.ObjectIDFromHex(c.Query("documentId"))
	if err != nil {
		httpx.Fail(c, httpx.NewError(404, "DOCUMENT_NOT_FOUND", "Document was not found.", nil))
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	res, err := a.DB.Collection("hosteldocuments").UpdateOne(c, bson.D{{Key: "_id", Value: docID}, {Key: "createdBy", Value: actor}, {Key: "hostelId", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "APPROVED"}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "deletedAt", Value: now}, {Key: "deletedBy", Value: actor}, {Key: "isDeleted", Value: true}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}}})
	if err == nil && res.MatchedCount == 0 {
		err = httpx.NewError(404, "DOCUMENT_NOT_REMOVABLE", "Only your own document can be removed, and only before it is approved.", nil)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	kyc, err := a.kycOf(c, id, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, kycWrap{kyc}, "Document removed")
}

// kycSubmit is submitHostelKyc: the hostel joins the platform's review queue and
// stays editable until a decision lands.
func (a *Admin) kycSubmit(c *gin.Context) {
	p := authz.From(c)
	var body any
	_ = c.ShouldBindJSON(&body) // `request.json().catch(() => ({}))`: an empty body is fine.
	id, err := AdminHostel(p, optionalHostel(body))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	kyc, err := a.submitKyc(c, id, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, kycWrap{kyc}, "KYC submitted")
}

func (a *Admin) submitKyc(ctx context.Context, id bson.ObjectID, userID string) (*kycOut, error) {
	kyc, err := a.kycOf(ctx, id, userID)
	if err != nil {
		return nil, err
	}
	switch {
	case kyc.Review == nil:
		return nil, httpx.NewError(409, "KYC_NOT_REQUIRED", "This hostel is already verified.", nil)
	case kyc.Review.Status == "SUBMITTED":
		return kyc, nil
	case kyc.Review.Status == "APPROVED":
		return nil, httpx.NewError(409, "KYC_ALREADY_APPROVED", "Your KYC is already approved.", nil)
	case len(kyc.Review.Missing) > 0:
		return nil, httpx.NewError(422, "KYC_INCOMPLETE", "Finish every required section before you submit.", nil)
	}
	actor, err := httpx.OID(userID, "user id")
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var h struct {
		Contact struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
		Location struct {
			City string `bson:"city"`
		} `bson:"location"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	// A hostel that is already approved or listed keeps its status while its KYC is checked.
	var cur struct {
		Status string `bson:"status"`
	}
	if err := a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "status", Value: 1}})).Decode(&cur); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	set := bson.D{{Key: "kyc.note", Value: nil}, {Key: "kyc.status", Value: "SUBMITTED"}, {Key: "kyc.submittedAt", Value: now}}
	if cur.Status == "" || cur.Status == "DRAFT" || cur.Status == "REJECTED" || cur.Status == "PENDING_APPROVAL" {
		set = append(set, bson.E{Key: "status", Value: "PENDING_APPROVAL"})
	}
	set = append(set, bson.E{Key: "updatedBy", Value: actor}, bson.E{Key: "verificationStatus", Value: "PENDING"}, bson.E{Key: "updatedAt", Value: now})
	err = a.DB.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "kyc.status", Value: bson.D{{Key: "$ne", Value: "APPROVED"}}}, {Key: "verificationStatus", Value: bson.D{{Key: "$ne", Value: "VERIFIED"}}}},
		bson.D{{Key: "$set", Value: set}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
	}
	if err != nil {
		return nil, err
	}
	var owner struct {
		Email string `bson:"email"`
		Name  string `bson:"name"`
		Phone string `bson:"phone"`
	}
	if h.OwnerID != nil {
		if err := a.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *h.OwnerID}}, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}, {Key: "phone", Value: 1}})).Decode(&owner); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
	}
	phone := owner.Phone
	if phone == "" {
		phone = h.Contact.Phone
	}
	snapshot := bson.D{{Key: "applicant", Value: bson.D{{Key: "email", Value: owner.Email}, {Key: "name", Value: owner.Name}, {Key: "phone", Value: phone}}}, {Key: "name", Value: h.Name}, {Key: "via", Value: "KYC"}}
	// The queue reads the newest application per hostel: one row, re-opened on every submit.
	if err := a.DB.Collection("hostelapplications").FindOneAndUpdate(ctx, bson.D{{Key: "hostelId", Value: id}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "reviewedAt", Value: nil}, {Key: "snapshot", Value: snapshot}, {Key: "status", Value: "PENDING"}, {Key: "submittedBy", Value: actor}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "applicantId", Value: h.OwnerID}, {Key: "hostelId", Value: id}, {Key: "source", Value: "PUBLIC"}, {Key: "submittedByAgentId", Value: nil}, {Key: "requestedDocuments", Value: bson.A{}}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetUpsert(true)).Err(); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	if _, err := a.DB.Collection("hostelverifications").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: id}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "status", Value: "PENDING"}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "checklist", Value: bson.A{}}, {Key: "createdBy", Value: actor}, {Key: "isDeleted", Value: false}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, upsert); err != nil {
		return nil, err
	}
	if err := a.Audit.Write(ctx, audit.Entry{Action: "HOSTEL_KYC_SUBMITTED", ActorID: actor, EntityID: id.Hex(), EntityType: "Hostel", HostelID: id}); err != nil {
		return nil, err
	}
	(&Registration{DB: a.DB, Mail: a.Mail, Notify: a.Notify, RT: a.RT, Cache: a.Cache, Outbound: a.Outbound}).notifyPlatform(ctx, id, h.Name, h.Location.City, Applicant{Email: &owner.Email, Name: owner.Name})
	return a.kycOf(ctx, id, userID)
}
