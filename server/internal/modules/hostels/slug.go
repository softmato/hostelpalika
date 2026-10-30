package hostels

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var (
	slugRun  = regexp.MustCompile(`[^a-z0-9]+`)
	slugEdge = regexp.MustCompile(`^-+|-+$`)
)

// OverallSlug is the all-branches workspace's URL, never a hostel's.
const OverallSlug = "overall"

// Slugify is slugify: lower-case, runs of anything else become one hyphen.
func Slugify(v string) string {
	return slugEdge.ReplaceAllString(slugRun.ReplaceAllString(strings.ToLower(v), "-"), "")
}

// UniqueSlug is uniqueSlug: name-area, then name-area-2, -3 … until free.
func UniqueSlug(ctx context.Context, db *mongo.Database, name, area string) (string, error) {
	base := Slugify(name + "-" + area)
	if base == "" {
		base = fmt.Sprintf("hostel-%d", time.Now().UnixMilli())
	}
	candidate := base
	for suffix := 2; ; suffix++ {
		if candidate != OverallSlug {
			n, err := db.Collection("hostels").CountDocuments(ctx, bson.D{{Key: "slug", Value: candidate}}, options.Count().SetLimit(1))
			if err != nil {
				return "", err
			}
			if n == 0 {
				return candidate, nil
			}
		}
		candidate = base + "-" + strconv.Itoa(suffix)
	}
}
