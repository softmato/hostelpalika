package hostels

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/platformconfig"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// The company's contact details exactly as the printed letterhead shows them, not
// the `issuer` config, which serves invoices and can drift from fixed paper.
const (
	letterheadAddress = "Mid-Baneshwor, Kathmandu"
	letterheadEmail   = "work@softmato.com"
	letterheadPhone   = "9819748466"
	agreementTitle    = "HostelPalika Service Agreement"
)

//go:embed agreement-letterhead.pdf
var agreementLetterhead []byte

// The field order is part of the fingerprint: JSON.stringify of these in this order.
type agreementCompany struct {
	Address      string `bson:"address" json:"address"`
	Email        string `bson:"email" json:"email"`
	Phone        string `bson:"phone" json:"phone"`
	LegalName    string `bson:"legalName" json:"legalName"`
	Pan          string `bson:"pan" json:"pan"`
	SupportPhone string `bson:"supportPhone" json:"supportPhone"`
}

type agreementHostel struct {
	Address string `bson:"address" json:"address"`
	Name    string `bson:"name" json:"name"`
}

type agreementOwner struct {
	Email string `bson:"email" json:"email"`
	Name  string `bson:"name" json:"name"`
	Phone string `bson:"phone" json:"phone"`
}

type agreementParties struct {
	Company agreementCompany `bson:"company" json:"company"`
	Hostel  agreementHostel  `bson:"hostel" json:"hostel"`
	Owner   agreementOwner   `bson:"owner" json:"owner"`
}

func agreementIntro(p agreementParties) string {
	who := "the owner of the hostel named above"
	if p.Owner.Name != "" {
		who = p.Owner.Name + ", the owner of " + p.Hostel.Name
	}
	return "This agreement is between " + p.Company.LegalName + `, the company that runs HostelPalika ("HostelPalika", "we", "us"), and ` + who +
		` ("you", "your hostel"). It says what each of us gives, what each of us promises, and how your data is kept safe. We wrote it in simple words so it is easy to read.`
}

func termsFor(p agreementParties) []agreementSection {
	var support []string
	if p.Company.SupportPhone != "" {
		support = append(support, p.Company.SupportPhone)
	} else if p.Company.Phone != "" {
		support = append(support, p.Company.Phone)
	}
	if p.Company.Email != "" {
		support = append(support, p.Company.Email)
	}
	return agreementTerms(strings.Join(support, " or "), p.Company.Email)
}

type agreementIssuer struct {
	LegalName   string `json:"legalName"`
	Pan         string `json:"pan"`
	ProductName string `json:"productName"`
}

func (a *Admin) loadAgreementIssuer(ctx context.Context) (agreementIssuer, error) {
	var i agreementIssuer
	v, err := a.Config.Section(ctx, "issuer")
	if err != nil {
		return i, err
	}
	return i, platformconfig.Decode(v, &i)
}

func (a *Admin) agreementParties(ctx context.Context, id bson.ObjectID) (string, agreementParties, error) {
	var p agreementParties
	var h struct {
		Contact struct {
			Phone string `bson:"phone"`
		} `bson:"contact"`
		Location struct {
			Address string `bson:"address"`
			Area    string `bson:"area"`
			City    string `bson:"city"`
		} `bson:"location"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	err := a.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "ownerId", Value: 1}, {Key: "location", Value: 1}, {Key: "contact", Value: 1}})).Decode(&h)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", p, httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
	}
	if err != nil {
		return "", p, err
	}
	var owner agreementOwner
	ownerID := ""
	if h.OwnerID != nil {
		ownerID = h.OwnerID.Hex()
		if err := a.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: *h.OwnerID}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "email", Value: 1}, {Key: "phone", Value: 1}})).Decode(&owner); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return "", p, err
		}
	}
	if owner.Phone == "" {
		owner.Phone = h.Contact.Phone
	}
	issuer, err := a.loadAgreementIssuer(ctx)
	if err != nil {
		return "", p, err
	}
	var identity struct {
		SupportPhone string `json:"supportPhone"`
	}
	v, err := a.Config.Section(ctx, "identity")
	if err != nil {
		return "", p, err
	}
	if err := platformconfig.Decode(v, &identity); err != nil {
		return "", p, err
	}
	if identity.SupportPhone == "" {
		identity.SupportPhone = letterheadPhone
	}
	var place []string
	for _, part := range []string{h.Location.Address, h.Location.Area, h.Location.City} {
		if part = strings.TrimSpace(part); part != "" {
			place = append(place, part)
		}
	}
	return ownerID, agreementParties{
		Company: agreementCompany{letterheadAddress, letterheadEmail, letterheadPhone, issuer.LegalName, issuer.Pan, identity.SupportPhone},
		Hostel:  agreementHostel{strings.Join(place, ", "), h.Name},
		Owner:   owner,
	}, nil
}

// agreementFingerprint is SHA-256 of JSON.stringify({intro, parties, terms}), so the
// hash of an agreement signed through either server verifies on the other.
func agreementFingerprint(p agreementParties, terms []agreementSection) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(struct {
		Intro   string             `json:"intro"`
		Parties agreementParties   `json:"parties"`
		Terms   []agreementSection `json:"terms"`
	}{agreementIntro(p), p, terms}); err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes.TrimRight(buf.Bytes(), "\n"))
	return hex.EncodeToString(sum[:]), nil
}

type signatureRecord struct {
	ApprovedByName string             `bson:"approvedByName"`
	IP             string             `bson:"ip"`
	IssuedAt       *time.Time         `bson:"issuedAt"`
	Parties        agreementParties   `bson:"parties"`
	RefCode        *string            `bson:"refCode"`
	SentAt         *time.Time         `bson:"sentAt"`
	Signature      string             `bson:"signature"`
	SignedAt       time.Time          `bson:"signedAt"`
	SignerName     string             `bson:"signerName"`
	Terms          []agreementSection `bson:"terms"`
	TextHash       string             `bson:"textHash"`
	UserAgent      string             `bson:"userAgent"`
}

func (a *Admin) signatureOf(ctx context.Context, id bson.ObjectID) (*signatureRecord, error) {
	var r signatureRecord
	err := a.DB.Collection("hostelagreementsignatures").FindOne(ctx, bson.D{{Key: "hostelId", Value: id}}).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

type signedOut struct {
	IssuedAt   *string `json:"issuedAt"`
	RefCode    *string `json:"refCode"`
	SentAt     *string `json:"sentAt"`
	Signature  string  `json:"signature"`
	SignedAt   string  `json:"signedAt"`
	SignerName string  `json:"signerName"`
}

type agreementOut struct {
	Intro   string             `json:"intro"`
	Parties agreementParties   `json:"parties"`
	Signed  *signedOut         `json:"signed"`
	Terms   []agreementSection `json:"terms"`
	Title   string             `json:"title"`
}

func isoPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := httpx.ISO(*t)
	return &s
}

// agreementOf is getHostelAgreement: the text to read, and the signature once given.
func (a *Admin) agreementOf(ctx context.Context, id bson.ObjectID) (*agreementOut, error) {
	signed, err := a.signatureOf(ctx, id)
	if err != nil {
		return nil, err
	}
	_, current, err := a.agreementParties(ctx, id)
	if err != nil {
		return nil, err
	}
	if signed == nil {
		return &agreementOut{agreementIntro(current), current, nil, termsFor(current), agreementTitle}, nil
	}
	return &agreementOut{agreementIntro(signed.Parties), signed.Parties, &signedOut{isoPtr(signed.IssuedAt), signed.RefCode, isoPtr(signed.SentAt), signed.Signature, httpx.ISO(signed.SignedAt), signed.SignerName}, signed.Terms, agreementTitle}, nil
}

type agreementWrap struct {
	Agreement *agreementOut `json:"agreement"`
}

func (a *Admin) agreementGet(c *gin.Context) {
	id, err := AdminHostel(authz.From(c), c.Query("hostelId"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if c.Query("format") == "pdf" {
		a.agreementDownload(c, id)
		return
	}
	out, err := a.agreementOf(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, agreementWrap{out}, "Agreement")
}

func (a *Admin) agreementDownload(c *gin.Context, id bson.ObjectID) {
	issued, err := a.exists(c, "hostelagreementsignatures", bson.D{{Key: "hostelId", Value: id}, {Key: "refCode", Value: bson.D{{Key: "$ne", Value: nil}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if !issued {
		c.JSON(404, gin.H{"message": "Your agreement is sent once your KYC is approved.", "success": false})
		return
	}
	file, _, err := a.IssueAgreement(c, id, "")
	if err == nil && file == nil {
		err = errors.New("issued agreement disappeared")
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.Header("Content-Disposition", `attachment; filename="`+file.Filename+`"`)
	c.Data(200, "application/pdf", file.Content)
}

var signaturePattern = regexp.MustCompile(`^(?:[ML]\d{1,3} \d{1,3})+$`)
var signaturePoint = regexp.MustCompile(`([ML])(\d+) (\d+)`)

// signatureStrokes parses lib/signature.ts's `M x yL x y…` format.
func signatureStrokes(value string) [][][2]float64 {
	var strokes [][][2]float64
	for _, m := range signaturePoint.FindAllStringSubmatch(value, -1) {
		x, _ := strconv.Atoi(m[2])
		y, _ := strconv.Atoi(m[3])
		point := [2]float64{float64(x), float64(y)}
		if m[1] == "M" || len(strokes) == 0 {
			strokes = append(strokes, [][2]float64{point})
		} else {
			strokes[len(strokes)-1] = append(strokes[len(strokes)-1], point)
		}
	}
	return strokes
}

func parseSignature(f *valid.Form) string {
	const unsigned = "Sign in the box before saving."
	s, ok := f.M["signature"].(string)
	if !ok {
		f.Is.Add("signature", unsigned)
		return ""
	}
	if valid.JSLen(s) > 16000 {
		f.Is.Add("signature", "That signature is too detailed. Clear it and sign again.")
	}
	if !signaturePattern.MatchString(s) {
		f.Is.Add("signature", "That signature could not be read. Clear it and sign again.")
	}
	count := 0
	inBox := true
	for _, stroke := range signatureStrokes(s) {
		count += len(stroke)
		for _, p := range stroke {
			inBox = inBox && p[0] <= 600 && p[1] <= 200
		}
	}
	if count < 8 || !inBox {
		f.Is.Add("signature", unsigned)
	}
	return s
}

// agreementSign: they can sign again until it is issued; after that it is final, and
// the PDF in their inbox is the agreement.
func (a *Admin) agreementSign(c *gin.Context) {
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
	if f.M["agree"] != true {
		f.Is.Add("agree", "Tick that you have read and agree to the agreement.")
	}
	signature := parseSignature(f)
	name, _ := f.Str("signerName", valid.S{Trim: true, Min: 2, MinMsg: "Type your full name.", Max: 80})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	ownerID, parties, err := a.agreementParties(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if ownerID != p.UserID {
		httpx.Fail(c, httpx.NewError(403, "AGREEMENT_OWNER_ONLY", "Only the hostel owner can sign the agreement.", nil))
		return
	}
	final := httpx.NewError(409, "AGREEMENT_FINAL", "Your agreement is already signed and sent.", nil)
	issued, err := a.exists(c, "hostelagreementsignatures", bson.D{{Key: "hostelId", Value: id}, {Key: "refCode", Value: bson.D{{Key: "$ne", Value: nil}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if issued {
		httpx.Fail(c, final)
		return
	}
	terms := termsFor(parties)
	hash, err := agreementFingerprint(parties, terms)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	actor, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ip := strings.TrimSpace(strings.Split(c.GetHeader("x-forwarded-for"), ",")[0])
	if ip == "" {
		ip = c.GetHeader("x-real-ip")
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err = a.DB.Collection("hostelagreementsignatures").UpdateOne(c, bson.D{{Key: "hostelId", Value: id}, {Key: "refCode", Value: nil}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "ip", Value: clip(ip, 64)}, {Key: "parties", Value: parties}, {Key: "signature", Value: signature}, {Key: "signedAt", Value: now}, {Key: "signedBy", Value: actor},
			{Key: "signerName", Value: name}, {Key: "terms", Value: terms}, {Key: "textHash", Value: hash}, {Key: "userAgent", Value: clip(c.GetHeader("user-agent"), 300)}, {Key: "updatedAt", Value: now}}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "hostelId", Value: id}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}, upsert)
	if mongo.IsDuplicateKeyError(err) {
		// The unique index refuses the upsert once a signed row has its code.
		err = final
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := a.Audit.Write(c, audit.Entry{Action: "HOSTEL_AGREEMENT_SIGNED", ActorID: actor, EntityID: id.Hex(), EntityType: "Hostel", HostelID: id}); err != nil {
		httpx.Fail(c, err)
		return
	}
	// Verified already (no KYC review, or approved before this step existed): send it now.
	var h struct {
		Kyc struct {
			Required bool   `bson:"required"`
			Status   string `bson:"status"`
		} `bson:"kyc"`
	}
	if err := a.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: id}}, options.FindOne().SetProjection(bson.D{{Key: "kyc", Value: 1}})).Decode(&h); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !h.Kyc.Required || h.Kyc.Status == "APPROVED" {
		if err := a.sendAgreement(c, id); err != nil {
			slog.ErrorContext(c, "hostel_agreement_send_failed", "hostelId", id.Hex(), "error", err.Error())
		}
	}
	out, err := a.agreementOf(c, id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, agreementWrap{out}, "Agreement signed")
}

// IssueAgreement is issueHostelAgreement: gives the signed agreement its number and
// returns the PDF. nil when the owner has not signed. An issued one keeps its number.
func (a *Admin) IssueAgreement(ctx context.Context, id bson.ObjectID, approverID string) (*email.Attachment, string, error) {
	record, err := a.signatureOf(ctx, id)
	if err != nil || record == nil {
		return nil, "", err
	}
	if record.RefCode == nil {
		var approver struct {
			Name string `bson:"name"`
		}
		var createdBy any
		if oid, err := bson.ObjectIDFromHex(approverID); err == nil {
			createdBy = oid
			if err := a.DB.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}})).Decode(&approver); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
				return nil, "", err
			}
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		var run struct {
			Sequence int `bson:"sequence"`
		}
		if err := a.DB.Collection("platformdocumentsequences").FindOneAndUpdate(ctx, bson.D{{Key: "fiscalYear", Value: "LIFETIME"}, {Key: "kind", Value: "HOSTEL_AGREEMENT"}},
			bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
			options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&run); err != nil {
			return nil, "", err
		}
		refCode := fmt.Sprintf("SMT/HP/%d/%03d", bs.CalendarDay(now).Year(), run.Sequence)
		// A racing issue loses here and burns its number: a gap, never a code given twice.
		res, err := a.DB.Collection("hostelagreementsignatures").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: id}, {Key: "refCode", Value: nil}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "approvedByName", Value: approver.Name}, {Key: "issuedAt", Value: now}, {Key: "refCode", Value: refCode}, {Key: "updatedAt", Value: now}}}})
		if err != nil {
			return nil, "", err
		}
		if res.ModifiedCount == 1 {
			row := bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "hostelName", Value: record.Parties.Hostel.Name}, {Key: "location", Value: record.Parties.Hostel.Address}, {Key: "notes", Value: "Signed electronically at KYC"},
				{Key: "ownerName", Value: record.SignerName}, {Key: "phone", Value: record.Parties.Owner.Phone}, {Key: "refCode", Value: refCode}, {Key: "sequence", Value: run.Sequence},
				{Key: "signedOn", Value: bs.CalendarDay(record.SignedAt)}, {Key: "status", Value: "SIGNED"}, {Key: "deletedAt", Value: nil}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}
			if createdBy != nil {
				row = append(row, bson.E{Key: "createdBy", Value: createdBy})
			}
			if _, err := a.DB.Collection("hostelagreements").InsertOne(ctx, row); err != nil {
				return nil, "", err
			}
		}
		if record, err = a.signatureOf(ctx, id); err != nil {
			return nil, "", err
		}
		if record == nil || record.RefCode == nil {
			return nil, "", nil
		}
	}
	file, err := a.renderSignature(ctx, record)
	if err != nil {
		return nil, "", err
	}
	return file, *record.RefCode, nil
}

// sendAgreement issues the agreement and emails it on its own, for a hostel already verified.
func (a *Admin) sendAgreement(ctx context.Context, id bson.ObjectID) error {
	file, refCode, err := a.IssueAgreement(ctx, id, "")
	if err != nil || file == nil {
		return err
	}
	record, err := a.signatureOf(ctx, id)
	if err != nil || record == nil || record.Parties.Owner.Email == "" || record.SentAt != nil {
		return err
	}
	to := record.Parties.Owner.Email
	m := email.HostelAgreement(record.Parties.Hostel.Name, record.SignerName, refCode)
	if !a.Mail.Send(ctx, email.Message{Category: m.Category, To: []string{to}, Subject: m.Subject, HTML: m.HTML, Attachments: []email.Attachment{*file}}).Sent {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err = a.DB.Collection("hostelagreementsignatures").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "sentAt", Value: now}, {Key: "sentTo", Value: to}, {Key: "updatedAt", Value: now}}}})
	return err
}

type agreementSeal struct {
	file, name, title string
}

var agreementSigners = []agreementSeal{{"signature-jiwan.png", "Jiwan Mijhar", "Founder"}, {"signature-siddhant.png", "Siddhant Yadav", "Founder"}}

// sealCache holds the founders' signatures and the stamp, which live only in the private
// bucket (the repo is public) and never change between deploys. A missing file is skipped
// and not cached: the agreement still goes out, and the next render tries again.
type sealCache struct {
	mu    sync.Mutex
	files map[string][]byte
}

var seals sealCache

func (a *Admin) seal(ctx context.Context, file string) []byte {
	seals.mu.Lock()
	defer seals.mu.Unlock()
	if b, ok := seals.files[file]; ok {
		return b
	}
	if a.R2 == nil {
		return nil
	}
	bucket, err := a.R2.PrivateBucket()
	if err != nil {
		return nil
	}
	body, err := a.R2.Get(ctx, bucket, a.R2.WithKeyPrefix("platform/agreement-seals/"+file))
	if err != nil {
		slog.ErrorContext(ctx, "agreement_seal_missing", "file", file, "error", err.Error())
		return nil
	}
	defer body.Close()
	b, err := io.ReadAll(body)
	if err != nil {
		return nil
	}
	if seals.files == nil {
		seals.files = map[string][]byte{}
	}
	seals.files[file] = b
	return b
}

// renderSignature prints one record: issued with its number and the founders' side, or
// a preview with the company's side left empty.
func (a *Admin) renderSignature(ctx context.Context, r *signatureRecord) (*email.Attachment, error) {
	issuer, err := a.loadAgreementIssuer(ctx)
	if err != nil {
		return nil, err
	}
	in := agreementPrint{record: r, issuer: issuer}
	if r.RefCode != nil {
		in.stamp = a.seal(ctx, "stamp.png")
		for _, s := range agreementSigners {
			if img := a.seal(ctx, s.file); img != nil {
				in.signers = append(in.signers, printedSigner{img, s.name, s.title})
			}
		}
	}
	content, err := in.render()
	if err != nil {
		return nil, err
	}
	name := "preview.pdf"
	if r.RefCode != nil {
		name = strings.ReplaceAll(*r.RefCode, "/", "-") + ".pdf"
	}
	return &email.Attachment{Content: content, Filename: "HostelPalika-Agreement-" + name}, nil
}
