package hostelresidents

import (
	"context"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/hostelrooms"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

type leaver struct {
	ID         string  `json:"id"`
	LeavingOn  string  `json:"leavingOn"`
	Name       string  `json:"name"`
	RoomNumber *string `json:"roomNumber"`
}

// LeavingToday is listLeavingToday: still here, leaving day today or past.
func (s *Service) LeavingToday(ctx context.Context, hostel bson.ObjectID) ([]leaver, error) {
	cur, err := s.DB.Collection("residents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "leavingOn", Value: bson.D{{Key: "$lte", Value: bs.Today(now())}}}, {Key: "status", Value: "ACTIVE"}},
		options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "leavingOn", Value: 1}, {Key: "roomNumber", Value: 1}}).SetLimit(1000))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID         bson.ObjectID `bson:"_id"`
		First      string        `bson:"firstName"`
		Last       string        `bson:"lastName"`
		LeavingOn  bson.DateTime `bson:"leavingOn"`
		RoomNumber *string       `bson:"roomNumber"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]leaver, 0, len(rows))
	for _, r := range rows {
		out = append(out, leaver{r.ID.Hex(), r.LeavingOn.Time().UTC().Format("2006-01-02"), strings.TrimSpace(r.First + " " + r.Last), r.RoomNumber})
	}
	return out, nil
}

// SetFee is setResidentMonthlyFee. residentIDs nil = everyone in scope; a
// given list, even an empty one, is exactly those residents (RES-14).
func (s *Service) SetFee(ctx context.Context, hostel bson.ObjectID, fee *int64, reason string, residentIDs []string, p *authz.Principal) (ordered.Map, error) {
	filter := bson.D{{Key: "hostelId", Value: hostel}, {Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "PENDING"}}}}}
	if residentIDs != nil {
		ids := bson.A{}
		for _, v := range residentIDs {
			if id, err := bson.ObjectIDFromHex(v); err == nil && len(v) == 24 {
				ids = append(ids, id)
			}
		}
		filter = append(filter, bson.E{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}})
	}
	by := hostelrooms.UserID(p)
	set := bson.D{{Key: "monthlyFee", Value: nil}, {Key: "updatedBy", Value: by}}
	var after int64
	if fee != nil {
		after = *fee
		set[0].Value = *fee
		r := reason
		if r == "" {
			r = "set by hostel admin"
		}
		set = append(set, bson.E{Key: "feeOverrideReason", Value: r}, bson.E{Key: "feeOverrideSetAt", Value: now()})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now()})
	res, err := s.DB.Collection("residents").UpdateMany(ctx, filter, bson.D{{Key: "$set", Value: set}})
	if err != nil {
		return nil, err
	}
	why := reason
	if why == "" {
		why = "applied to " + itoa(res.ModifiedCount) + " residents"
	}
	if err := s.Audit.WriteFinance(ctx, by, string(p.Role), audit.Finance{Action: "RESIDENT_MONTHLY_FEE_SET", AmountAfter: after, EntityID: hostel.Hex(), EntityType: "Resident",
		HostelID: hostel, Reason: why, Source: "RESIDENT_FEE_EDITOR"}); err != nil {
		return nil, err
	}
	var f any
	if fee != nil {
		f = *fee
	}
	return ordered.Map{{Key: "monthlyFee", Value: f}, {Key: "updatedCount", Value: res.ModifiedCount}}, nil
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
