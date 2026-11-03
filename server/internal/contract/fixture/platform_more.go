package fixture

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// The rest of the superadmin portal (group 14). Moderation reads the base rows
// (feedback, reviews, posts, providers, sponsors); config adds two platform admin
// invitations; money adds a plan payment claim and a field cash filing on top of
// the admin-setup plan rows; programs adds a hostel's leave request and a partner
// referral whose commission is owed.
var (
	InviteNew       = gid(14, 1)
	InviteExpired   = gid(14, 2)
	MoneyClaim      = gid(14, 3)
	MoneyCash       = gid(14, 4)
	LeaveCheap      = gid(14, 5)
	ReferralOwed    = gid(14, 6)
	ReferralPaid    = gid(14, 7)
	InviteTokenNew  = "contract-invite-new"
	InviteTokenOld  = "contract-invite-old"
	InviteTokenUser = "contract-invite-user"
	InviteExisting  = gid(14, 8)
)

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func init() {
	groupSeeds["platform-moderation"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := ownBaseHostels(ctx, db); err != nil {
			return err
		}
		return insertAll(ctx, db, map[string][]any{"users": platformStaff(fixedAt)})
	}
	groupSeeds["platform-config"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := ownBaseHostels(ctx, db); err != nil {
			return err
		}
		day := 24 * time.Hour
		invite := func(id bson.ObjectID, email, role, token string, expires time.Time) d {
			return d{{Key: "_id", Value: id}, {Key: "email", Value: email}, {Key: "name", Value: "Invitee"}, {Key: "role", Value: role}, {Key: "tokenHash", Value: tokenHash(token)},
				{Key: "expiresAt", Value: expires}, {Key: "status", Value: "PENDING"}, {Key: "invitedBy", Value: UserSuperadmin}, {Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}
		}
		return insertAll(ctx, db, map[string][]any{
			"users": platformStaff(fixedAt),
			"platformadmininvites": {
				invite(InviteNew, "invitee@contract.test", "PLATFORM_MODERATOR", InviteTokenNew, now.Add(5*day)),
				invite(InviteExpired, "late@contract.test", "SUPERADMIN", InviteTokenOld, now.Add(-day)),
				invite(InviteExisting, "public@contract.test", "PLATFORM_MODERATOR", InviteTokenUser, now.Add(5*day)),
			},
		})
	}
	groupSeeds["platform-money"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := ownBaseHostels(ctx, db); err != nil {
			return err
		}
		if err := groupSeeds["admin-setup"](ctx, db, now); err != nil {
			return err
		}
		h, s, inv := gid(4, 70), gid(4, 72), gid(4, 73)
		pay := func(id bson.ObjectID, method, status string, extra ...e) d {
			row := d{{Key: "_id", Value: id}, {Key: "amount", Value: 3900}, {Key: "currency", Value: "NPR"}, {Key: "hostelId", Value: h}, {Key: "invoiceId", Value: inv},
				{Key: "method", Value: method}, {Key: "status", Value: status}, {Key: "subscriptionId", Value: s}, {Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}
			return append(row, extra...)
		}
		return insertAll(ctx, db, map[string][]any{
			"users": platformStaff(fixedAt),
			"subscriptionpayments": {
				pay(MoneyClaim, "MANUAL", "IN_REVIEW", e{Key: "claimedAt", Value: fixedAt}, e{Key: "claimNote", Value: "Paid by QR"}, e{Key: "gatewayReference", Value: "QR-REF-77"},
					e{Key: "proofAssetId", Value: gid(4, 110)}),
				pay(MoneyCash, "CASH", "PENDING", e{Key: "collectedBy", Value: UserSuperadmin}, e{Key: "gatewayReference", Value: "CASH-77"}),
			},
		})
	}
	groupSeeds["platform-programs"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if err := ownBaseHostels(ctx, db); err != nil {
			return err
		}
		day := 24 * time.Hour
		referral := func(id bson.ObjectID, status string) d {
			return d{{Key: "_id", Value: id}, {Key: "kind", Value: "PARTNER"}, {Key: "code", Value: "PARTNER1"}, {Key: "codeId", Value: oid("a7")}, {Key: "refereeHostelId", Value: HostelCheap},
				{Key: "referrerHostelId", Value: nil}, {Key: "refereeReward", Value: d{{Key: "days", Value: 10}, {Key: "months", Value: 2}}}, {Key: "referrerReward", Value: d{{Key: "days", Value: 0}, {Key: "months", Value: 0}}},
				{Key: "commission", Value: d{{Key: "amount", Value: 500}, {Key: "paidAt", Value: nil}, {Key: "status", Value: status}}},
				{Key: "status", Value: "LIVE"}, {Key: "liveAt", Value: fixedAt}, {Key: "createdAt", Value: fixedAt}, {Key: "updatedAt", Value: fixedAt}, {Key: "__v", Value: 0}}
		}
		leave := leaveRequest("00", HostelCheap, OwnerCheap, "PENDING", now.Add(10*day), now.Add(40*day),
			e{Key: "ownerEmail", Value: "cheap@contract.test"}, e{Key: "ownerName", Value: "Cheap Owner"}, e{Key: "exportSections", Value: bson.A{}})
		leave[0].Value = LeaveCheap
		return insertAll(ctx, db, map[string][]any{
			"users":               platformStaff(fixedAt),
			"hostelleaverequests": {leave},
			"hostelreferrals":     {referral(ReferralOwed, "EARNED"), referral(ReferralPaid, "PAID")},
		})
	}
}
