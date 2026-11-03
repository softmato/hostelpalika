package hostelresidents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// Upload is an applicant photo or a document: the asset and its claim token.
type Upload struct{ AssetID, Token, Kind string }

// CreateIn is residentCreateSchema, parsed.
type CreateIn struct {
	HostelID                                         string
	MonthlyFee, AdmissionFee, FormFee, DepositAmount *float64
	FeeReason, RoomID, Email, First, Last, Phone     string
	MoveInDate                                       time.Time
	ReferralCode, ResidentType, RoomType, Status     string
	BillingCycle                                     *string
	UserResidentID, AdmissionFormID                  string
	Details                                          ordered.Map
	Photo                                            *Upload
	Documents                                        []Upload
}

var photoTypes = []string{"image/jpeg", "image/png", "image/webp"}

// nonFatal is nonFatal: bookkeeping about a resident who already exists must not fail the write.
func nonFatal(ctx context.Context, err error) {
	if err != nil {
		slog.ErrorContext(ctx, "Post-registration step failed; the resident is registered.", "error", err.Error())
	}
}

// liveResidency is LiveResidency.
type liveResidency struct {
	HostelName string
	SameHostel bool
}

// FindLiveResidency is findLiveResidency: where this person already lives, by account or address.
func (s *Service) FindLiveResidency(ctx context.Context, emails []string, userIDs []bson.ObjectID, asking bson.ObjectID) (*liveResidency, error) {
	seen, list := map[string]bool{}, bson.A{}
	for _, e := range emails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" && !seen[e] {
			seen[e] = true
			list = append(list, e)
		}
	}
	if (len(list) == 0 && len(userIDs) == 0) || seen[residents.DemoResidentEmail] {
		return nil, nil
	}
	or := bson.A{}
	if len(userIDs) > 0 {
		ids := bson.A{}
		for _, id := range userIDs {
			ids = append(ids, id)
		}
		or = append(or, bson.D{{Key: "userId", Value: bson.D{{Key: "$in", Value: ids}}}})
	}
	if len(list) > 0 {
		or = append(or, bson.D{{Key: "email", Value: bson.D{{Key: "$in", Value: list}}}})
	}
	cur, err := s.DB.Collection("residents").Find(ctx, bson.D{{Key: "$or", Value: or}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING", "SUSPENDED"}}}}},
		options.Find().SetLimit(5).SetProjection(bson.D{{Key: "hostelId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		HostelID bson.ObjectID `bson:"hostelId"`
	}
	if err := cur.All(ctx, &rows); err != nil || len(rows) == 0 {
		return nil, err
	}
	row, same := rows[0], false
	for _, r := range rows {
		if r.HostelID == asking {
			row, same = r, true
			break
		}
	}
	name := s.hostelName(ctx, row.HostelID)
	if name == "your hostel" {
		name = "another hostel"
	}
	return &liveResidency{HostelName: name, SameHostel: same}, nil
}

func liveResidencyMessage(name string, l *liveResidency) string {
	who := strings.TrimSpace(name)
	if who == "" {
		who = "This person"
	}
	if l.SameHostel {
		return who + " already lives in your hostel. Open their record instead of adding them again."
	}
	return fmt.Sprintf("%s already lives at %s. They can't be added here until %s moves them out.", who, l.HostelName, l.HostelName)
}

func (s *Service) removeDemoResident(ctx context.Context, p *authz.Principal) error {
	cur, err := s.DB.Collection("residents").Find(ctx, bson.D{{Key: "email", Value: residents.DemoResidentEmail}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}})
	if err != nil {
		return err
	}
	var rows []Resident
	if err := cur.All(ctx, &rows); err != nil {
		return err
	}
	by, at := bsonUser(p), now()
	for _, r := range rows {
		if _, err := s.DB.Collection("residents").UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "deletedAt", Value: at}, {Key: "deletedBy", Value: by}, {Key: "isDeleted", Value: true}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: at}}}}); err != nil {
			return err
		}
		if r.Status != "MOVED_OUT" {
			if err := s.Cap.Release(ctx, r.HostelID, r.RoomType); err != nil {
				return err
			}
		}
		if r.UserID != nil {
			if _, err := s.DB.Collection("users").UpdateOne(ctx, bson.D{{Key: "_id", Value: *r.UserID}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: r.HostelID}}}}); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) takeHeld(ctx context.Context, b *bookings.Booking, roomType string) error {
	if !b.BedHeld {
		return s.Cap.Claim(ctx, b.HostelID, roomType)
	}
	if b.RoomType != roomType {
		return s.Cap.Move(ctx, b.HostelID, b.RoomType, roomType)
	}
	return nil
}

func (s *Service) returnHeld(ctx context.Context, b *bookings.Booking, roomType string) error {
	if !b.BedHeld {
		return s.Cap.Release(ctx, b.HostelID, roomType)
	}
	if b.RoomType != roomType {
		return s.Cap.Move(ctx, b.HostelID, roomType, b.RoomType)
	}
	return nil
}

func (s *Service) seal(d ordered.Map) (any, error) {
	if d == nil || residents.DetailsEmpty(d) {
		return nil, nil
	}
	if s.Personal == nil {
		return nil, crypto.ErrPersonalKeyMissing
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	return s.Personal.Encrypt(raw)
}

func (s *Service) claimUploads(ctx context.Context, in CreateIn, hostel bson.ObjectID) (photo *bson.ObjectID, docs []formUpload, err error) {
	if in.Photo != nil {
		id, err := s.Claims.ClaimToHostel(ctx, s.DB, in.Photo.AssetID, in.Photo.Token, hostel, photoTypes, "photo")
		if err != nil {
			return nil, nil, err
		}
		photo = &id
	}
	var kinds []string
	byKind := map[string]Upload{}
	for _, d := range in.Documents {
		if _, seen := byKind[d.Kind]; !seen {
			kinds = append(kinds, d.Kind)
		}
		byKind[d.Kind] = d
	}
	for _, k := range kinds {
		d := byKind[k]
		id, err := s.Claims.ClaimToHostel(ctx, s.DB, d.AssetID, d.Token, hostel, append(append([]string{}, photoTypes...), "application/pdf"), "document")
		if err != nil {
			return nil, nil, err
		}
		docs = append(docs, formUpload{FileAssetID: id, Kind: k})
	}
	return photo, docs, nil
}

// linkReferral is linkReferralOnRegistration.
func (s *Service) linkReferral(ctx context.Context, code string, hostel, resident bson.ObjectID, name, phone string, p *authz.Principal) (ordered.Map, error) {
	var rc struct {
		ID         bson.ObjectID `bson:"_id"`
		Code       string        `bson:"code"`
		ResidentID bson.ObjectID `bson:"residentId"`
	}
	err := s.DB.Collection("referralcodes").FindOne(ctx, bson.D{{Key: "code", Value: strings.ToUpper(strings.TrimSpace(code))}, {Key: "status", Value: "ACTIVE"}, {Key: "hostelId", Value: hostel}}).Decode(&rc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, rerr("Referral code was not found.", "REFERRAL_CODE_NOT_FOUND", http.StatusNotFound)
	}
	if err != nil {
		return nil, err
	}
	if rc.ResidentID == resident {
		return nil, rerr("A resident cannot refer themselves.", "REFERRAL_SELF_REFERENCE", http.StatusUnprocessableEntity)
	}
	by, at := bsonUser(p), now()
	refs := s.DB.Collection("referrals")
	var existing struct {
		ID     bson.ObjectID `bson:"_id"`
		Status string        `bson:"status"`
	}
	err = refs.FindOne(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}, {Key: "phone", Value: phone}, {Key: "referralCodeId", Value: rc.ID}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "CANCELLED"}}}}).Decode(&existing)
	found := err == nil
	if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var refID bson.ObjectID
	if found {
		refID = existing.ID
		if _, err := refs.UpdateOne(ctx, bson.D{{Key: "_id", Value: refID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "confirmedAt", Value: at}, {Key: "confirmedBy", Value: by}, {Key: "joinedResidentId", Value: resident}, {Key: "status", Value: "JOINED"}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: at}}}}); err != nil {
			return nil, err
		}
	} else {
		refID = bson.NewObjectID()
		if _, err := refs.InsertOne(ctx, bson.D{{Key: "_id", Value: refID}, {Key: "confirmedAt", Value: at}, {Key: "confirmedBy", Value: by}, {Key: "createdBy", Value: by}, {Key: "hostelId", Value: hostel}, {Key: "joinedResidentId", Value: resident},
			{Key: "name", Value: name}, {Key: "phone", Value: phone}, {Key: "referralCodeId", Value: rc.ID}, {Key: "referrerResidentId", Value: rc.ResidentID}, {Key: "status", Value: "JOINED"}, {Key: "converted", Value: false}, {Key: "isDeleted", Value: false},
			{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
			return nil, err
		}
	}
	if !found || existing.Status == "INQUIRY_CREATED" {
		if _, err := s.DB.Collection("referralcodes").UpdateOne(ctx, bson.D{{Key: "_id", Value: rc.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "joinedCount", Value: 1}}}}); err != nil {
			return nil, err
		}
	}
	if err := s.Audit.Write(ctx, audit.Entry{Action: "REFERRAL_JOINED_ON_REGISTRATION", ActorID: by, EntityID: refID.Hex(), EntityType: "Referral", HostelID: hostel, Metadata: bson.D{{Key: "referralCode", Value: rc.Code}}}); err != nil {
		return nil, err
	}
	return ordered.Map{{Key: "code", Value: rc.Code}, {Key: "referralId", Value: refID.Hex()}, {Key: "referrerResidentId", Value: rc.ResidentID.Hex()}}, nil
}

func (s *Service) financeAudit(ctx context.Context, p *authz.Principal, hostel, resident bson.ObjectID, action string, after, before float64, reason string) {
	id, _ := bson.ObjectIDFromHex(p.UserID)
	nonFatal(ctx, s.Audit.WriteFinance(ctx, id, string(p.Role), audit.Finance{Action: action, AmountAfter: int64(after), AmountBefore: int64(before), EntityID: resident.Hex(), EntityType: "Resident", HostelID: hostel, Reason: reason, Source: "RESIDENT_INTAKE"}))
}

func dupMessage(err error, email, phone string) error {
	text := err.Error()
	if strings.Contains(text, "email") {
		return rerr("Someone is already registered here with the email "+email+".", "RESIDENT_EMAIL_TAKEN", http.StatusConflict)
	}
	return rerr("Someone is already registered here with the phone "+phone+".", "RESIDENT_PHONE_TAKEN", http.StatusConflict)
}

// Create is createResident.
func (s *Service) Create(ctx context.Context, hostel bson.ObjectID, in CreateIn, p *authz.Principal) (ordered.Map, error) {
	var err error
	addr := normalizedEmail(in.Email)
	if addr == residents.DemoResidentEmail {
		if err := s.removeDemoResident(ctx, p); err != nil {
			return nil, err
		}
	}
	filter := bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: bson.D{{Key: "$ne", Value: "MOVED_OUT"}}}}
	if addr != "" {
		filter = append(filter, bson.E{Key: "$or", Value: bson.A{bson.D{{Key: "phone", Value: in.Phone}}, bson.D{{Key: "email", Value: addr}}}})
	} else {
		filter = append(filter, bson.E{Key: "phone", Value: in.Phone})
	}
	var dup Resident
	err = s.DB.Collection("residents").FindOne(ctx, filter).Decode(&dup)
	if err == nil {
		if dup.Phone == in.Phone {
			return nil, rerr(fmt.Sprintf("%s %s is already registered here with the phone %s.", dup.FirstName, dup.LastName, in.Phone), "RESIDENT_PHONE_TAKEN", http.StatusConflict)
		}
		return nil, rerr(fmt.Sprintf("%s %s is already registered here with the email %s. Use a different address, or edit the resident that already exists.", dup.FirstName, dup.LastName, addr), "RESIDENT_EMAIL_TAKEN", http.StatusConflict)
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}
	var submitter *bson.ObjectID
	if in.AdmissionFormID != "" {
		submitter = s.formSubmitter(ctx, hostel, in.AdmissionFormID)
	}
	acct, err := s.FindAccountForIntake(ctx, addr, in.UserResidentID, submitter)
	if err != nil {
		return nil, err
	}
	var userIDs []bson.ObjectID
	if acct.UserID != nil {
		userIDs = append(userIDs, *acct.UserID)
	}
	if live, err := s.FindLiveResidency(ctx, []string{addr, acct.Email}, userIDs, hostel); err != nil {
		return nil, err
	} else if live != nil {
		code := "RESIDENT_LIVES_ELSEWHERE"
		if live.SameHostel {
			code = "RESIDENT_ALREADY_HERE"
		}
		return nil, rerr(liveResidencyMessage(in.First+" "+in.Last, live), code, http.StatusConflict)
	}
	if in.ReferralCode != "" {
		ok, err := s.activeReferral(ctx, hostel, strings.ToUpper(strings.TrimSpace(in.ReferralCode)))
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, rerr("Referral code was not found.", "REFERRAL_CODE_NOT_FOUND", http.StatusNotFound)
		}
	}
	quote, err := s.Quote(ctx, hostel, QuoteIn{AdmissionFee: in.AdmissionFee, BillingCycle: in.BillingCycle, DepositAmount: in.DepositAmount, FormFee: in.FormFee, MonthlyFee: in.MonthlyFee,
		MoveInDate: in.MoveInDate, ReferralCode: in.ReferralCode, RoomType: in.RoomType})
	if err != nil {
		return nil, err
	}
	var held *bookings.Booking
	if in.UserResidentID != "" && acct.UserID != nil {
		if held, err = s.Bookings.FindHeld(ctx, hostel, *acct.UserID, time.Now().UTC()); err != nil {
			return nil, err
		}
	}
	if err := s.Limits.AssertRoom(ctx, hostel, "residents", 1); err != nil {
		return nil, err
	}
	var room *roomPick
	if in.RoomID != "" {
		rid, _ := bson.ObjectIDFromHex(in.RoomID)
		r, err := s.Rooms.Resolve(ctx, hostel, rid, nil)
		if err != nil {
			return nil, err
		}
		room = &roomPick{ID: r.ID, Floor: r.Floor, Number: r.Number, RoomType: r.RoomType}
	}
	photoID, scans, err := s.claimUploads(ctx, in, hostel)
	if err != nil {
		return nil, err
	}
	if room != nil && room.RoomType != in.RoomType {
		return nil, rerr(fmt.Sprintf("Room %s is %s, not %s.", room.Number, hostelrooms.TypeLabel(room.RoomType), hostelrooms.TypeLabel(in.RoomType)), "ROOM_TYPE_MISMATCH", http.StatusConflict)
	}
	var stay *bookings.Stay
	if held != nil {
		stay = held.Stay
		if err := s.takeHeld(ctx, held, in.RoomType); err != nil {
			return nil, err
		}
	} else if err := s.Cap.Claim(ctx, hostel, in.RoomType); err != nil {
		return nil, err
	}
	giveBack := func() {
		var e error
		if held != nil {
			e = s.returnHeld(ctx, held, in.RoomType)
		} else {
			e = s.Cap.Release(ctx, hostel, in.RoomType)
		}
		nonFatal(ctx, e)
	}
	sealed, err := s.seal(in.Details)
	if err != nil {
		giveBack()
		return nil, err
	}
	by, at := bsonUser(p), now()
	id := bson.NewObjectID()
	cycle := "CALENDAR_MONTH"
	if in.BillingCycle != nil {
		cycle = *in.BillingCycle
	}
	admissionFee, deposit, stayEnds := any(nil), any(quote.DepositAmount), any(nil)
	if quote.AdmissionFee > 0 {
		admissionFee = quote.AdmissionFee
	}
	if stay != nil {
		admissionFee, deposit, stayEnds = nil, 0, bs.DayEnd(stay.MoveOut, 0)
	}
	doc := bson.D{{Key: "_id", Value: id}, {Key: "firstName", Value: in.First}, {Key: "lastName", Value: in.Last}, {Key: "phone", Value: in.Phone}}
	if addr != "" {
		doc = append(doc, bson.E{Key: "email", Value: addr})
	}
	doc = append(doc, bson.E{Key: "moveInDate", Value: in.MoveInDate}, bson.E{Key: "billingCycle", Value: cycle}, bson.E{Key: "residentType", Value: in.ResidentType}, bson.E{Key: "roomType", Value: in.RoomType}, bson.E{Key: "status", Value: in.Status})
	if photoID != nil {
		doc = append(doc, bson.E{Key: "photoAssetId", Value: *photoID})
	} else {
		doc = append(doc, bson.E{Key: "photoAssetId", Value: nil})
	}
	doc = append(doc, bson.E{Key: "detailsData", Value: sealed})
	if in.AdmissionFormID != "" {
		fid, _ := bson.ObjectIDFromHex(in.AdmissionFormID)
		doc = append(doc, bson.E{Key: "admissionFormId", Value: fid})
	} else {
		doc = append(doc, bson.E{Key: "admissionFormId", Value: nil})
	}
	if in.MonthlyFee != nil {
		doc = append(doc, bson.E{Key: "feeOverrideReason", Value: in.FeeReason}, bson.E{Key: "feeOverrideSetAt", Value: at}, bson.E{Key: "feeOverrideSetBy", Value: by}, bson.E{Key: "monthlyFee", Value: *in.MonthlyFee})
	} else {
		doc = append(doc, bson.E{Key: "monthlyFee", Value: nil})
	}
	if room != nil {
		doc = append(doc, bson.E{Key: "floor", Value: room.Floor}, bson.E{Key: "roomId", Value: room.ID}, bson.E{Key: "roomNumber", Value: room.Number})
	} else {
		doc = append(doc, bson.E{Key: "roomId", Value: nil}, bson.E{Key: "floor", Value: nil}, bson.E{Key: "roomNumber", Value: nil})
	}
	doc = append(doc, bson.E{Key: "deskIntake", Value: in.UserResidentID == "" && addr != ""}, bson.E{Key: "admissionFee", Value: admissionFee}, bson.E{Key: "admissionFeeDiscount", Value: quote.ReferralDiscount},
		bson.E{Key: "createdBy", Value: by}, bson.E{Key: "depositAmount", Value: deposit}, bson.E{Key: "hostelId", Value: hostel}, bson.E{Key: "isDeleted", Value: false})
	if quote.ReferralCode != "" {
		doc = append(doc, bson.E{Key: "referralCode", Value: strings.ToUpper(quote.ReferralCode)})
	}
	doc = append(doc, bson.E{Key: "stayEndsAt", Value: stayEnds}, bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "bedType", Value: nil}, bson.E{Key: "paidTill", Value: nil},
		bson.E{Key: "accountLinkDeclinedAt", Value: nil}, bson.E{Key: "accountLinkDeclinedBy", Value: nil}, bson.E{Key: "moveOutDate", Value: nil}, bson.E{Key: "lastMonthCharge", Value: nil},
		bson.E{Key: "leavingOn", Value: nil}, bson.E{Key: "leavingReason", Value: nil}, bson.E{Key: "leavingNoticeAt", Value: nil}, bson.E{Key: "existingListId", Value: nil}, bson.E{Key: "isDemoData", Value: false},
		bson.E{Key: "createdAt", Value: at}, bson.E{Key: "updatedAt", Value: at}, bson.E{Key: "__v", Value: 0})
	if _, err := s.DB.Collection("residents").InsertOne(ctx, doc); err != nil {
		giveBack()
		if mongo.IsDuplicateKeyError(err) {
			return nil, dupMessage(err, addr, in.Phone)
		}
		return nil, err
	}
	var r Resident
	if err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&r); err != nil {
		return nil, err
	}
	nonFatal(ctx, s.auditResident(ctx, p, hostel, id, "RESIDENT_CREATED", bson.D{{Key: "roomType", Value: in.RoomType}}))
	if in.MonthlyFee != nil {
		s.financeAudit(ctx, p, hostel, id, "RESIDENT_MONTHLY_FEE_SET", *in.MonthlyFee, zeroIfNil(quote.StandardRent), in.FeeReason)
	}
	for _, c := range []struct {
		action string
		after  *float64
		before float64
	}{{"RESIDENT_ADMISSION_FEE_SET", in.AdmissionFee, quote.StdAdmission}, {"RESIDENT_FORM_FEE_SET", in.FormFee, quote.StdForm}, {"RESIDENT_DEPOSIT_SET", in.DepositAmount, quote.StdDeposit}} {
		if c.after != nil && *c.after != c.before {
			s.financeAudit(ctx, p, hostel, id, c.action, *c.after, c.before, in.FeeReason)
		}
	}
	nonFatal(ctx, s.saveDocuments(ctx, id, hostel, scans, by))
	if in.AdmissionFormID != "" {
		nonFatal(ctx, s.markFormAdded(ctx, hostel, in.AdmissionFormID, id, p))
	}
	if held != nil {
		_, err := s.Bookings.CheckIn(ctx, held, by, id, time.Now().UTC(), func(c context.Context) error { return s.Cap.Claim(c, held.HostelID, held.RoomType) })
		nonFatal(ctx, err)
	}
	var referral any
	if in.ReferralCode != "" {
		ref, err := s.linkReferral(ctx, in.ReferralCode, hostel, id, strings.TrimSpace(in.First+" "+in.Last), in.Phone, p)
		nonFatal(ctx, err)
		if err == nil {
			referral = ref
		}
	}
	var admission, first ordered.Map
	var admissionRes Admission
	var firstRes FirstInvoice
	if stay != nil {
		admission = ordered.Map{{Key: "raised", Value: false}, {Key: "reason", Value: "A short stay is paid through its booking."}}
		first = admission
		admissionRes, firstRes = Admission{Reason: "A short stay is paid through its booking."}, FirstInvoice{Reason: "A short stay is paid through its booking."}
	} else {
		admissionRes = s.RaiseAdmission(ctx, hostel, id, in.MoveInDate, quote, in.FeeReason, p)
		firstRes = s.RaiseFirstMonth(ctx, hostel, id, in.MoveInDate, p)
		admission, first = admissionRes.JSON(), firstRes.JSON()
	}
	var newLogin *IntakeAccount
	if acct.Reason == "NO_ACCOUNT" && addr != "" && in.UserResidentID == "" {
		a, err := s.OpenLogin(ctx, addr, in.First+" "+in.Last)
		nonFatal(ctx, err)
		if err == nil {
			newLogin = &a
		}
	}
	use := acct
	if newLogin != nil {
		use = *newLogin
	}
	link := s.LinkAccount(ctx, &r, p, in.UserResidentID, false, &use)
	// ponytail: cardFromAdmissionForm (the form becomes their ID card) needs resident-identity, ported with resident-scan.
	s.notifyAfter(ctx, registeredNotice{
		admissionFee: quote.AdmissionPayable, deposit: r.DepositAmount, hostel: hostel, first: firstRes, prorated: quote.FirstMonth != nil && quote.FirstMonth.Prorated,
		monthlyRent: quote.MonthlyRent, resident: r, moveIn: in.MoveInDate, newLogin: newLogin != nil && newLogin.UserID != nil && link.Linked, userID: link.UserID,
	})
	var howToPay any
	if s.PayMethods != nil {
		amount := int64(0)
		if admissionRes.Raised {
			amount += int64(admissionRes.Amount)
		}
		if firstRes.Raised {
			amount += firstRes.Amount
		}
		if m, err := s.PayMethods(ctx, hostel, amount); err == nil {
			howToPay = m
		} else {
			nonFatal(ctx, err)
		}
	}
	out := r
	if link.Linked {
		if err := s.DB.Collection("residents").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&out); err != nil {
			return nil, err
		}
	}
	return ordered.Map{{Key: "accountLink", Value: link.JSON()}, {Key: "admission", Value: admission}, {Key: "firstMonth", Value: first}, {Key: "howToPay", Value: howToPay},
		{Key: "quote", Value: quote.JSON()}, {Key: "referral", Value: referral}, {Key: "resident", Value: Serialize(&out)}}, nil
}

type roomPick struct {
	ID               bson.ObjectID
	Floor            int
	Number, RoomType string
}
