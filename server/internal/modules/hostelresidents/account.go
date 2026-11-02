package hostelresidents

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/bookings"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// IntakeAccount is IntakeAccount: the account an intake is about, or why none.
type IntakeAccount struct {
	Email  string
	Reason string
	UserID *bson.ObjectID
}

type accountRow struct {
	ID    bson.ObjectID `bson:"_id"`
	Email string        `bson:"email"`
	Role  string        `bson:"role"`
}

func (a accountRow) account() IntakeAccount {
	id := a.ID
	return IntakeAccount{Email: strings.ToLower(strings.TrimSpace(a.Email)), UserID: &id}
}

var liveUser = bson.E{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}

func (s *Service) userByFilter(ctx context.Context, filter bson.D) (*accountRow, error) {
	var u accountRow
	err := s.DB.Collection("users").FindOne(ctx, filter, options.FindOne().SetProjection(bson.D{{Key: "email", Value: 1}})).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return &u, err
}

// FindAccountForIntake is findAccountForIntake: the scanned card, then the form's
// submitter, then the address; the account's own address is the one returned.
func (s *Service) FindAccountForIntake(ctx context.Context, intakeEmail, scanned string, submitter *bson.ObjectID) (IntakeAccount, error) {
	if card := bookings.NormalizeResidentID(scanned); scanned != "" && card != "" {
		u, err := s.userByFilter(ctx, bson.D{liveUser, {Key: "userResidentId", Value: card}})
		if err != nil {
			return IntakeAccount{}, err
		}
		if u != nil && strings.TrimSpace(u.Email) != "" {
			return u.account(), nil
		}
		if u != nil {
			return IntakeAccount{Reason: "ACCOUNT_HAS_NO_EMAIL"}, nil
		}
	}
	if submitter != nil {
		u, err := s.userByFilter(ctx, bson.D{{Key: "_id", Value: *submitter}, liveUser})
		if err != nil {
			return IntakeAccount{}, err
		}
		if u != nil && strings.TrimSpace(u.Email) != "" {
			return u.account(), nil
		}
	}
	addr := strings.ToLower(strings.TrimSpace(intakeEmail))
	if addr == "" {
		return IntakeAccount{Reason: "NO_EMAIL"}, nil
	}
	cur, err := s.DB.Collection("users").Find(ctx, bson.D{{Key: "email", Value: addr}, liveUser}, options.Find().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "role", Value: 1}}))
	if err != nil {
		return IntakeAccount{}, err
	}
	var rows []accountRow
	if err := cur.All(ctx, &rows); err != nil {
		return IntakeAccount{}, err
	}
	pick := func(role string) *accountRow {
		for i := range rows {
			if rows[i].Role == role {
				return &rows[i]
			}
		}
		return nil
	}
	best := pick("RESIDENT")
	if best == nil {
		best = pick("PUBLIC")
	}
	if best == nil && len(rows) > 0 {
		best = &rows[0]
	}
	if best == nil {
		return IntakeAccount{Reason: "NO_ACCOUNT"}, nil
	}
	a := best.account()
	if a.Email == "" {
		a.Email = addr
	}
	return a, nil
}

// OpenLogin is openResidentLogin: a password-less PUBLIC account on the address.
func (s *Service) OpenLogin(ctx context.Context, addr, name string) (IntakeAccount, error) {
	existing, err := s.FindAccountForIntake(ctx, addr, "", nil)
	if err != nil || existing.Reason != "NO_ACCOUNT" {
		return existing, err
	}
	at := now()
	name = strings.TrimSpace(name)
	if name == "" {
		name = addr
	}
	id := bson.NewObjectID()
	doc := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "email", Value: addr}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: false},
		{Key: "authProvider", Value: "LOCAL"}, {Key: "role", Value: "PUBLIC"}, {Key: "mustChangePassword", Value: false}, {Key: "lockPinSetAt", Value: nil}, {Key: "lockPinFailures", Value: 0},
		{Key: "tokenVersion", Value: 0}, {Key: "hostelIds", Value: bson.A{}}, {Key: "status", Value: "ACTIVE"}, {Key: "isDemoData", Value: false}, {Key: "isDeleted", Value: false},
		{Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}
	if _, err := s.DB.Collection("users").InsertOne(ctx, doc); err != nil {
		// Their own sign-up landed first: that account is them.
		return s.FindAccountForIntake(ctx, addr, "", nil)
	}
	return IntakeAccount{Email: addr, UserID: &id}, nil
}

// AccountLink is ResidentAccountLink.
type AccountLink struct {
	Cleared *residents.Promoted
	Emailed bool
	Linked  bool
	Reason  string
	UserID  string
}

// JSON keeps the TS key order (alphabetical, absent keys left out).
func (l AccountLink) JSON() ordered.Map {
	m := ordered.Map{}
	if l.Cleared != nil {
		memberships := make([]any, 0, len(l.Cleared.ClearedMemberships))
		for _, c := range l.Cleared.ClearedMemberships {
			memberships = append(memberships, ordered.Map{{Key: "hostelName", Value: c.HostelName}, {Key: "role", Value: c.Role}})
		}
		var role any
		if l.Cleared.ClearedRole != "" {
			role = l.Cleared.ClearedRole
		}
		m = append(m, ordered.Pair{Key: "cleared", Value: ordered.Map{{Key: "activatedInvite", Value: l.Cleared.ActivatedInvite}, {Key: "clearedMemberships", Value: memberships}, {Key: "clearedRole", Value: role}}})
	}
	m = append(m, ordered.Pair{Key: "emailed", Value: l.Emailed}, ordered.Pair{Key: "linked", Value: l.Linked})
	if l.Reason != "" {
		m = append(m, ordered.Pair{Key: "reason", Value: l.Reason})
	}
	if l.UserID != "" {
		m = append(m, ordered.Pair{Key: "userId", Value: l.UserID})
	}
	return m
}

// LinkAccount is linkResidentAccount with the account resolved by the caller
// (or looked up from the resident's own email). Never fails the registration.
func (s *Service) LinkAccount(ctx context.Context, r *Resident, p *authz.Principal, scanned string, sendWelcome bool, resolved *IntakeAccount) AccountLink {
	acct := IntakeAccount{}
	if resolved != nil {
		acct = *resolved
	} else {
		a, err := s.FindAccountForIntake(ctx, r.Email, scanned, nil)
		if err != nil {
			return AccountLink{Reason: "ACCOUNT_LINK_FAILED"}
		}
		acct = a
	}
	if acct.UserID == nil {
		return AccountLink{Reason: acct.Reason}
	}
	uid, by := *acct.UserID, bsonUser(p)
	residentsC := s.DB.Collection("residents")
	err := residentsC.FindOne(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: r.ID}}}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}, {Key: "userId", Value: uid}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if err == nil {
		return AccountLink{Reason: "ACCOUNT_ALREADY_LINKED"}
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return AccountLink{Reason: "ACCOUNT_LINK_FAILED"}
	}
	at := now()
	if _, err := residentsC.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "updatedBy", Value: by}, {Key: "userId", Value: uid}, {Key: "updatedAt", Value: at}}}}); err != nil {
		return AccountLink{Reason: "ACCOUNT_LINK_FAILED"}
	}
	up, err := residents.PromoteAccountToResident(ctx, s.DB, s.Audit, residents.Promotion{HostelID: r.HostelID, Name: r.name(), PerformedBy: by, Phone: r.Phone, UserID: uid}, at)
	if err != nil {
		if _, undo := residentsC.UpdateOne(ctx, bson.D{{Key: "_id", Value: r.ID}, {Key: "userId", Value: uid}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: at}}}, {Key: "$unset", Value: bson.D{{Key: "userId", Value: ""}}}}); undo != nil {
			slog.ErrorContext(ctx, "account link undo failed; the resident stays linked", "resident", r.ID.Hex(), "error", undo)
		}
		if code := httpx.Code(err); code != "" {
			return AccountLink{Reason: code}
		}
		return AccountLink{Reason: "ACCOUNT_LINK_FAILED"}
	}
	var clearedRole any
	if up.ClearedRole != "" {
		clearedRole = up.ClearedRole
	}
	_ = s.auditResident(ctx, p, r.HostelID, r.ID, "RESIDENT_ACCOUNT_LINKED", bson.D{{Key: "clearedMemberships", Value: len(up.ClearedMemberships)}, {Key: "clearedRole", Value: clearedRole}, {Key: "email", Value: acct.Email}, {Key: "upgraded", Value: up.Upgraded}})
	hostel := s.hostelName(ctx, r.HostelID)
	link := AccountLink{Linked: true, UserID: uid.Hex()}
	if sendWelcome {
		c := email.ResidentLinked(s.AppURL("/resident/dashboard"), hostel, r.FirstName)
		// sendEmail only throws on a transport fault, which Send logs: the TS flag reads true after any attempt.
		s.Mail.Send(ctx, email.Message{Category: c.Category, To: []string{acct.Email}, Subject: c.Subject, HTML: c.HTML})
		link.Emailed = true
	}
	if up.Cleared() {
		rows := make([]email.ClearedMembership, len(up.ClearedMemberships))
		for i, m := range up.ClearedMemberships {
			rows[i] = email.ClearedMembership{HostelName: m.HostelName, Role: m.Role}
		}
		c := email.ResidentAccessCleared(rows, up.ClearedRole, hostel, up.ActivatedInvite, r.FirstName)
		s.Mail.Send(ctx, email.Message{Category: c.Category, To: []string{acct.Email}, Subject: c.Subject, HTML: c.HTML})
	}
	link.Cleared = &up
	return link
}
