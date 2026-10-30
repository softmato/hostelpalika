// Package files: so far the registration-document door (lib/registration-documents.ts
// and public/files/upload). The signed-in presign/confirm routes land with Phase 5.
//
// A registration document is uploaded privately before the application exists,
// so its FileAsset has no owner. The upload answers with a claim token — an
// HMAC of the id that only that response contains — and submitting the
// application claims the file with it. A bare id is never enough: ObjectIds are
// close to sequential, and accepting one would let an applicant name a file
// uploaded moments before theirs and become its owner.
package files

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Claims signs and checks claim tokens with JWT_ACCESS_SECRET.
type Claims struct{ Secret string }

const claimContext = "registration-document"

// Issue is issueDocumentClaimToken.
func (c Claims) Issue(assetID string) string {
	mac := hmac.New(sha256.New, []byte(c.Secret))
	mac.Write([]byte(claimContext + ":" + assetID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Valid is isValidDocumentClaimToken.
func (c Claims) Valid(assetID, token string) bool {
	return hmac.Equal([]byte(token), []byte(c.Issue(assetID)))
}

// Submitted is one document as an application form names it.
type Submitted struct {
	ClaimToken   string
	DocumentType string
	FileAssetID  string
}

// Claimed is what may be stored for a claimed document.
type Claimed struct {
	DocumentType string
	FileAssetID  bson.ObjectID
}

func docErr(msg string) *httpx.Error {
	return httpx.NewError(http.StatusUnprocessableEntity, "REGISTRATION_DOCUMENT_INVALID", msg, nil)
}

// Claim attaches each uploaded document to owner and returns what may be
// stored. Call it before the application is written, so a rejected document
// never leaves a half-created hostel or provider behind. Safe to repeat for the
// same owner: a retried submission re-claims the files it already holds.
func (c Claims) Claim(ctx context.Context, db *mongo.Database, docs []Submitted, owner bson.ObjectID) ([]Claimed, error) {
	claimed := make([]Claimed, 0, len(docs))
	for _, d := range docs {
		if !c.Valid(d.FileAssetID, d.ClaimToken) {
			return nil, docErr(`"` + d.DocumentType + `" could not be verified. Upload it again.`)
		}
		id, err := bson.ObjectIDFromHex(d.FileAssetID)
		if err != nil {
			return nil, docErr(`"` + d.DocumentType + `" is no longer available. Upload it again.`)
		}
		var asset struct {
			ID bson.ObjectID `bson:"_id"`
		}
		err = db.Collection("fileassets").FindOneAndUpdate(ctx, bson.D{
			{Key: "_id", Value: id},
			{Key: "$or", Value: bson.A{bson.D{{Key: "ownerId", Value: bson.D{{Key: "$exists", Value: false}}}}, bson.D{{Key: "ownerId", Value: nil}}, bson.D{{Key: "ownerId", Value: owner}}}},
			{Key: "accessLevel", Value: "PRIVATE"}, {Key: "isDeleted", Value: false}, {Key: "kind", Value: "REGISTRATION_DOCUMENT"}, {Key: "status", Value: "ACTIVE"},
		}, bson.D{{Key: "$set", Value: bson.D{{Key: "ownerId", Value: owner}, {Key: "updatedBy", Value: owner}, {Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}}},
			options.FindOneAndUpdate().SetReturnDocument(options.After).SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&asset)
		if err == mongo.ErrNoDocuments {
			return nil, docErr(`"` + d.DocumentType + `" is no longer available. Upload it again.`)
		}
		if err != nil {
			return nil, err
		}
		claimed = append(claimed, Claimed{d.DocumentType, asset.ID})
	}
	return claimed, nil
}

// ParseSubmitted is `z.array(registrationDocumentSchema).max(12)` (+ `.min(min, minMsg)`
// when min > 0, `.default([])` when def) read from f's key.
func ParseSubmitted(f *valid.Form, key string, def bool, min int, minMsg string) []Submitted {
	return ParseSubmittedN(f, key, def, min, minMsg, 120, 12)
}

// ParseSubmittedN is ParseSubmitted with the document-type length and the
// array's size limit of the schema in question.
func ParseSubmittedN(f *valid.Form, key string, def bool, min int, minMsg string, maxType, maxItems int) []Submitted {
	items, ok := f.Array(key, false, def)
	if !ok {
		return nil
	}
	var out []Submitted
	aborted := false
	for i, raw := range items {
		p := key + "." + strconv.Itoa(i)
		m, isObj := raw.(map[string]any)
		if !isObj {
			aborted = true
			f.Is.Add(p, valid.Type("object", valid.Received(raw, false)))
			continue
		}
		sub := &valid.Form{M: m}
		var d Submitted
		d.ClaimToken, _ = sub.Str("claimToken", valid.S{Trim: true, Min: 20, Max: 200})
		d.DocumentType, _ = sub.Str("documentType", valid.S{Trim: true, Min: 2, Max: maxType})
		if v, present := m["fileAssetId"]; true {
			d.FileAssetID, _ = valid.ObjectID(v, "fileAssetId", "", &sub.Is, !present)
		}
		for _, is := range sub.Is {
			f.Is.Add(p+"."+is.Path, is.Message)
		}
		out = append(out, d)
	}
	f.Size(key, len(items), min, maxItems, minMsg, aborted)
	return out
}

// ClaimToHostel is applicant-photo.ts' claimUpload: an anonymous private upload
// tied to a hostel once the form that names it arrives. what is "photo" or "document".
func (c Claims) ClaimToHostel(ctx context.Context, db *mongo.Database, assetID, token string, hostelID bson.ObjectID, types []string, what string) (bson.ObjectID, error) {
	bad := func(msg string) error {
		return httpx.NewError(http.StatusUnprocessableEntity, "APPLICANT_PHOTO_INVALID", msg, nil)
	}
	if !c.Valid(assetID, token) {
		return bson.ObjectID{}, bad("That " + what + " could not be checked. Add it again.")
	}
	id, err := bson.ObjectIDFromHex(assetID)
	if err != nil {
		return bson.ObjectID{}, bad("That " + what + " is no longer available. Add it again.")
	}
	in := bson.A{}
	for _, t := range types {
		in = append(in, t)
	}
	var asset struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err = db.Collection("fileassets").FindOneAndUpdate(ctx, bson.D{
		{Key: "_id", Value: id},
		{Key: "$or", Value: bson.A{bson.D{{Key: "hostelId", Value: bson.D{{Key: "$exists", Value: false}}}}, bson.D{{Key: "hostelId", Value: nil}}, bson.D{{Key: "hostelId", Value: hostelID}}}},
		{Key: "accessLevel", Value: "PRIVATE"}, {Key: "isDeleted", Value: false}, {Key: "kind", Value: "REGISTRATION_DOCUMENT"},
		{Key: "mimeType", Value: bson.D{{Key: "$in", Value: in}}}, {Key: "status", Value: "ACTIVE"},
	}, bson.D{{Key: "$set", Value: bson.D{{Key: "hostelId", Value: hostelID}, {Key: "updatedAt", Value: time.Now().UTC().Truncate(time.Millisecond)}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After).SetProjection(bson.D{{Key: "_id", Value: 1}})).Decode(&asset)
	if err == mongo.ErrNoDocuments {
		return bson.ObjectID{}, bad("That " + what + " is no longer available. Add it again.")
	}
	if err != nil {
		return bson.ObjectID{}, err
	}
	return asset.ID, nil
}
