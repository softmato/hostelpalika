package users

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/auth"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

var (
	issuableRoles = map[string]string{"HOSTEL_ADMIN": "Hostel Admin", "WARDEN": "Warden", "RESIDENT": "Resident", "GUARDIAN": "Guardian", "COOK": "Cook"}
	highPrivilege = map[string]bool{"HOSTEL_ADMIN": true, "SUPERADMIN": true}
)

// Issuer is registerOrUpgradeUserByEmail's dependencies.
type Issuer struct {
	DB     *mongo.Database
	Mail   *email.Sender
	Audit  *audit.Log
	AppURL string // APP_URL, no trailing slash
}

// IssueInput is RegisterOrUpgradeInput.
type IssueInput struct {
	Email, HostelID, HostelName, Name, Phone, Role string
	UserID                                         string // resolve by account instead of address
	PerformedBy                                    string
	NoEmail                                        bool // sendEmailNotification: false
	NoTemporaryPassword                            bool // issueTemporaryPassword: false
}

// Issued is its answer.
type Issued struct {
	Created, Upgraded bool
	TemporaryPassword string
	Email, ID, Role   string
}

func temporaryPassword() string {
	b := make([]byte, 9)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// RegisterOrUpgrade issues or raises an account for a role a hostel may grant:
// a new address gets an INVITED account and a temporary password; a PUBLIC one
// is raised; an account already holding that role just joins the hostel; any
// other role is refused.
func (s *Issuer) RegisterOrUpgrade(ctx context.Context, in IssueInput) (*Issued, error) {
	label, ok := issuableRoles[in.Role]
	if !ok {
		return nil, httpx.NewError(400, "ROLE_NOT_ISSUABLE", "This role cannot be issued.", nil)
	}
	requested := strings.ToLower(valid.Trim(in.Email))
	if requested == "" && in.UserID == "" {
		return nil, httpx.NewError(400, "EMAIL_REQUIRED", "Email is required.", nil)
	}
	filter := bson.D{{Key: "email", Value: requested}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}
	if in.UserID != "" {
		id, err := httpx.OID(in.UserID, "user id")
		if err != nil {
			return nil, err
		}
		filter = bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}
	}
	var existing struct {
		ID           bson.ObjectID   `bson:"_id"`
		Email        string          `bson:"email"`
		HostelIDs    []bson.ObjectID `bson:"hostelIds"`
		PasswordHash string          `bson:"passwordHash"`
		Role         string          `bson:"role"`
	}
	coll := s.DB.Collection("users")
	err := coll.FindOne(ctx, filter).Decode(&existing)
	found := err == nil
	if err != nil && err != mongo.ErrNoDocuments {
		return nil, err
	}
	if in.UserID != "" && !found {
		return nil, httpx.NewError(404, "USER_NOT_FOUND", "That account no longer exists.", nil)
	}
	addr := requested
	if e := strings.ToLower(valid.Trim(existing.Email)); e != "" {
		addr = e
	}
	hostel, hasHostel := bson.ObjectID{}, false
	if in.HostelID != "" {
		id, err := httpx.OID(in.HostelID, "hostel id")
		if err != nil {
			return nil, err
		}
		hostel, hasHostel = id, true
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	out := &Issued{Email: addr, ID: existing.ID.Hex(), Role: existing.Role}
	switch {
	case !found:
		out.TemporaryPassword = temporaryPassword()
		hash, err := auth.HashPassword(out.TemporaryPassword)
		if err != nil {
			return nil, err
		}
		name := valid.Trim(in.Name)
		if name == "" {
			name = addr
		}
		id := bson.NewObjectID()
		hostels := bson.A{}
		if hasHostel {
			hostels = append(hostels, hostel)
		}
		doc := bson.D{{Key: "_id", Value: id}, {Key: "name", Value: name}, {Key: "email", Value: addr}, {Key: "image", Value: nil}, {Key: "emailVerified", Value: true}, {Key: "emailVerifiedAt", Value: now}}
		if phone := valid.Trim(in.Phone); phone != "" {
			doc = append(doc, bson.E{Key: "phone", Value: phone})
		}
		doc = append(doc, bson.E{Key: "passwordHash", Value: hash}, bson.E{Key: "authProvider", Value: "LOCAL"}, bson.E{Key: "role", Value: in.Role}, bson.E{Key: "mustChangePassword", Value: true},
			bson.E{Key: "lockPinSetAt", Value: nil}, bson.E{Key: "lockPinFailures", Value: 0}, bson.E{Key: "tokenVersion", Value: 0}, bson.E{Key: "hostelIds", Value: hostels},
			bson.E{Key: "status", Value: "INVITED"}, bson.E{Key: "isDemoData", Value: false}, bson.E{Key: "isDeleted", Value: false},
			bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		if _, err := coll.InsertOne(ctx, doc); err != nil {
			return nil, err
		}
		out.Created, out.ID, out.Role = true, id.Hex(), in.Role
	case existing.Role == in.Role:
		if hasHostel {
			if _, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: existing.ID}},
				bson.D{{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: hostel}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}}); err != nil {
				return nil, err
			}
		}
	case existing.Role == string(authz.Public):
		set := bson.D{{Key: "role", Value: in.Role}}
		if highPrivilege[in.Role] || existing.PasswordHash == "" && !in.NoTemporaryPassword {
			out.TemporaryPassword = temporaryPassword()
			hash, err := auth.HashPassword(out.TemporaryPassword)
			if err != nil {
				return nil, err
			}
			set = append(set, bson.E{Key: "passwordHash", Value: hash}, bson.E{Key: "mustChangePassword", Value: true})
		}
		set = append(set, bson.E{Key: "updatedAt", Value: now})
		update := bson.D{{Key: "$set", Value: set}}
		if hasHostel {
			update = append(update, bson.E{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: hostel}}})
		}
		if _, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: existing.ID}}, update); err != nil {
			return nil, err
		}
		out.Upgraded, out.Role = true, in.Role
	default:
		return nil, httpx.NewError(409, "EMAIL_ALREADY_HAS_ROLE", "This email already belongs to an account with a different role.", nil)
	}
	if (out.Created || out.Upgraded) && in.PerformedBy != "" {
		actor, err := httpx.OID(in.PerformedBy, "user id")
		if err != nil {
			return nil, err
		}
		action := "USER_ROLE_UPGRADED"
		meta := bson.D{{Key: "email", Value: addr}, {Key: "role", Value: in.Role}}
		if out.Created {
			action = "USER_ACCOUNT_ISSUED"
		} else {
			meta = append(meta, bson.E{Key: "previousRole", Value: "PUBLIC"})
		}
		if err := s.Audit.Write(ctx, audit.Entry{Action: action, ActorID: actor, EntityID: out.ID, EntityType: "User", HostelID: hostel, Metadata: meta}); err != nil {
			return nil, err
		}
	}
	if !in.NoEmail && (out.Created || out.Upgraded) {
		var content email.Content
		if out.TemporaryPassword != "" {
			content = email.CredentialsIssued(label, addr, out.TemporaryPassword, s.AppURL+"/login")
		} else {
			content = email.AccountUpgraded(label, s.AppURL+authz.LandingPath(authz.Role(in.Role)), in.HostelName)
		}
		s.Mail.Send(ctx, email.Message{Category: content.Category, To: []string{addr}, Subject: content.Subject, HTML: content.HTML})
	}
	return out, nil
}
