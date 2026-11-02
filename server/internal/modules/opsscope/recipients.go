package opsscope

import (
	"context"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Recipient is a ResidentRecipient: someone with an address to mail, a user
// account to notify, or both. A bell row needs only UserID; mail needs Email.
type Recipient struct {
	Email, Name, ResidentID, UserID string
}

// ActiveResidents is resolveActiveResidentRecipients (resident-notify.ts): the
// hostel's active residents who can be reached, the resident's own address
// first and the linked account's second. One users read for the lot, not one
// per resident.
func ActiveResidents(ctx context.Context, db *mongo.Database, hostelID bson.ObjectID) ([]Recipient, error) {
	cur, err := db.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "userId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	type row struct {
		ID        bson.ObjectID  `bson:"_id"`
		Email     string         `bson:"email"`
		FirstName string         `bson:"firstName"`
		LastName  string         `bson:"lastName"`
		UserID    *bson.ObjectID `bson:"userId"`
	}
	var rows []row
	need := bson.A{}
	for cur.Next(ctx) {
		var r row
		if err := cur.Decode(&r); err != nil {
			return nil, err
		}
		rows = append(rows, r)
		if r.Email == "" && r.UserID != nil {
			need = append(need, *r.UserID)
		}
	}
	if err := cur.Err(); err != nil {
		return nil, err
	}
	users := map[bson.ObjectID]struct{ Email, Name string }{}
	if len(need) > 0 {
		uc, err := db.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: need}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}},
			options.Find().SetProjection(bson.D{{Key: "email", Value: 1}, {Key: "name", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var us []struct {
			ID    bson.ObjectID `bson:"_id"`
			Email string        `bson:"email"`
			Name  *string       `bson:"name"`
		}
		if err := uc.All(ctx, &us); err != nil {
			return nil, err
		}
		for _, u := range us {
			name := ""
			if u.Name != nil {
				name = *u.Name
			}
			users[u.ID] = struct{ Email, Name string }{u.Email, name}
		}
	}
	out := make([]Recipient, 0, len(rows))
	for _, r := range rows {
		name := valid.Trim(r.FirstName + " " + r.LastName)
		rec := Recipient{Email: r.Email, Name: name, ResidentID: r.ID.Hex()}
		if r.UserID != nil {
			rec.UserID = r.UserID.Hex()
		}
		if r.Email == "" {
			u, ok := users[*nilSafe(r.UserID)]
			if r.UserID == nil || !ok || u.Email == "" {
				continue
			}
			rec.Email = u.Email
			if u.Name != "" {
				rec.Name = u.Name
			}
		}
		out = append(out, rec)
	}
	return out, nil
}

func nilSafe(id *bson.ObjectID) *bson.ObjectID {
	if id == nil {
		return &bson.ObjectID{}
	}
	return id
}

// Each runs fn for 0..n-1 with at most limit at once and waits for all.
func Each(n, limit int, fn func(i int)) {
	sem := make(chan struct{}, max(limit, 1))
	var wg sync.WaitGroup
	for i := range n {
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem; _ = recover() }()
			fn(i)
		}()
	}
	wg.Wait()
}

// OptDate is `z.coerce.date().optional()` read from a body.
func OptDate(f *valid.Form, key string) (*time.Time, bool) {
	v, present := f.M[key]
	if !present {
		return nil, false
	}
	t, ok := valid.CoerceDate(v)
	if !ok {
		f.Hard = true
		f.Is.Add(key, valid.Type("date", "Date"))
		return nil, false
	}
	return &t, true
}
