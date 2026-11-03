package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/softmato/hostelpalika/server/internal/platform/crypto"
)

// The ID card owners for /users/resident-identity, /users/:id/avatar and
// /account/saved-hostels (group 6).
var (
	IdentityNew    = gid(6, 1) // no card yet
	IdentityCard   = gid(6, 2) // a card, a photo and the card avatar
	IdentityOther  = gid(6, 3) // owns the taken email, phone and a foreign upload
	IdentityNoMail = gid(6, 4) // signs in by phone, no email
)

func init() {
	groupSeeds["account-identity"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		at := fixedAt
		withPhone := func(row d, phone string) d {
			return append(row[:len(row)-1], e{Key: "phone", Value: phone}, row[len(row)-1])
		}
		card := cardUser(IdentityCard, "card@contract.test", "Card Holder", "HH-2345-6789", at)
		for i := range card {
			if card[i].Key == "image" {
				card[i].Value = "/api/v1/users/" + IdentityCard.Hex() + "/avatar?v=1759292100000"
			}
		}
		other := withPhone(cardUser(IdentityOther, "taken@contract.test", "Other Person", "HH-3456-789A", at), "+977 9811111111")
		noMail := cardUser(IdentityNoMail, "", "No Mail", "", at)
		for i := range noMail {
			if noMail[i].Key == "email" {
				noMail = append(noMail[:i], noMail[i+1:]...)
				break
			}
		}
		saved := withPhone(cardUser(IdentityNew, "new@contract.test", "New Person", "", at), "9800000001")
		saved = append(saved[:len(saved)-1], e{Key: "savedHostelIds", Value: bson.A{HostelPublished}}, saved[len(saved)-1])
		photo := cardProfile(IdentityCard, "Card Holder", "card@contract.test", "9822222222", true, at)
		for i := range photo {
			if photo[i].Key == "photoAssetId" {
				photo[i].Value = gid(6, 0x10)
			}
		}
		pdf := asset(gid(6, 0x12), "PRIVATE", "", nil, &IdentityNew, at)
		for i := range pdf {
			if pdf[i].Key == "mimeType" {
				pdf[i].Value = "application/pdf"
			}
		}
		otherCard := cardProfile(IdentityOther, "Other Person", "other-card@contract.test", "9833333333", true, at)
		pk, _ := crypto.NewPersonal(PersonalKey)
		otherCard = append(otherCard, e{Key: "primaryEmailHash", Value: pk.LookupHash("other-card@contract.test")}, e{Key: "primaryPhoneHash", Value: pk.LookupHash("phone:9833333333")})
		return insertAll(ctx, db, map[string][]any{
			"users":                {saved, card, other, noMail},
			"userresidentprofiles": {photo, otherCard},
			"fileassets": {
				asset(gid(6, 0x10), "PRIVATE", "", nil, &IdentityCard, at),
				asset(gid(6, 0x11), "PRIVATE", "", nil, &IdentityNew, at),
				pdf,
				asset(gid(6, 0x13), "PRIVATE", "", nil, &IdentityOther, at),
				asset(gid(6, 0x14), "PRIVATE", "", nil, &IdentityNoMail, at),
			},
		})
	}
}
