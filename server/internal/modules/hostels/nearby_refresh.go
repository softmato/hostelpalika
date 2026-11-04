package hostels

import (
	"context"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/maps"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

const (
	nearbyRefreshBatch = 5
	nearbyMaxAge       = 7 * 24 * time.Hour
	nearbyPoliteness   = 2 * time.Second // between hostels: Overpass and Nominatim are shared services
)

type geoLocation struct {
	Address, Area, City, Country, Province string
	Lat, Lng                               *float64
	LocationSource                         string `bson:"locationSource"`
}

// RefreshStaleNearby is refreshStaleNearbyPlaces (the refresh-nearby-places
// job): a few live hostels whose nearby cache is missing or a week old get
// their coordinates and nearby places rebuilt, one at a time.
func RefreshStaleNearby(ctx context.Context, db *mongo.Database, m *maps.Client) (ordered.Map, error) {
	cur, err := db.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: false}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"APPROVED", "PUBLISHED"}}}},
		{Key: "$or", Value: bson.A{bson.D{{Key: "nearbyPlacesLastUpdated", Value: bson.D{{Key: "$exists", Value: false}}}},
			bson.D{{Key: "nearbyPlacesLastUpdated", Value: bson.D{{Key: "$lt", Value: time.Now().Add(-nearbyMaxAge)}}}}}}},
		options.Find().SetProjection(bson.D{{Key: "location", Value: 1}}).SetLimit(nearbyRefreshBatch))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID       bson.ObjectID `bson:"_id"`
		Location *geoLocation  `bson:"location"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	refreshed := 0
	for i, r := range rows {
		if r.Location != nil && refreshNearby(ctx, db, m, r.ID, r.Location) {
			refreshed++
		}
		if i < len(rows)-1 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(nearbyPoliteness):
			}
		}
	}
	return ordered.Map{{Key: "refreshed", Value: refreshed}, {Key: "scanned", Value: len(rows)}}, nil
}

// refreshNearby is geocodeAndCacheHostel: a MANUAL pin stays, anything else is
// geocoded again; the nearby cache is replaced only when a provider answered.
func refreshNearby(ctx context.Context, db *mongo.Database, m *maps.Client, id bson.ObjectID, l *geoLocation) bool {
	var at maps.Coordinates
	set := bson.D{}
	if l.LocationSource == "MANUAL" && l.Lat != nil && l.Lng != nil {
		at = maps.Coordinates{Lat: *l.Lat, Lng: *l.Lng}
	} else {
		g := m.Geocode(ctx, maps.AddressParts{Address: l.Address, Area: l.Area, City: l.City, Country: l.Country, Province: l.Province}, l.Country != "")
		if g == nil {
			return false
		}
		at = g.Coordinates
		set = append(set, bson.E{Key: "location.lat", Value: at.Lat}, bson.E{Key: "location.lng", Value: at.Lng}, bson.E{Key: "location.locationSource", Value: "GEOCODED"})
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	nearby := m.Nearby(ctx, at)
	if nearby != nil {
		set = append(set, bson.E{Key: "nearbyPlaces", Value: nearby}, bson.E{Key: "nearbyPlacesLastUpdated", Value: now})
	}
	set = append(set, bson.E{Key: "updatedAt", Value: now})
	if _, err := db.Collection("hostels").UpdateByID(ctx, id, bson.D{{Key: "$set", Value: set}}); err != nil {
		slog.WarnContext(ctx, "hostel_geo_refresh_failed", "hostelId", id.Hex(), "error", err.Error())
		return false
	}
	return nearby != nil
}
