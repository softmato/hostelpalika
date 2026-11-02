package fixture

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// extendGroup adds rows to a group already seeded by a file sorted before this one.
func extendGroup(group string, more func(now time.Time) map[string][]any) {
	base := groupSeeds[group]
	groupSeeds[group] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		if base != nil {
			if err := base(ctx, db, now); err != nil {
				return err
			}
		}
		return insertAll(ctx, db, more(now))
	}
}

// The ops group's complaints, safety and community rows. Ids from 0x60.
//
//	complaint 60 open · 61 overdue · 62 the other hostel's
//	sos       68 active · 69 the other hostel's
//	night     6a Ana inside
//	post      70 flagged · 71 hidden · 72 plain · 73 the other hostel's · report 74 on 70
func init() {
	extendGroup("admin-ops", func(now time.Time) map[string][]any {
		day := 24 * time.Hour
		complaint := func(n int, hostel bson.ObjectID, resident int, title string, due time.Time) bson.D {
			return bson.D{{Key: "_id", Value: gid(2, n)}, {Key: "hostelId", Value: hostel}, {Key: "residentId", Value: gid(2, resident)}, {Key: "title", Value: title}, {Key: "description", Value: "Details of " + title},
				{Key: "category", Value: "OTHER"}, {Key: "status", Value: "PENDING"}, {Key: "isAnonymous", Value: false}, {Key: "adminResponse", Value: ""}, {Key: "slaDueAt", Value: due}, {Key: "createdAt", Value: now.Add(-3 * day)}, {Key: "updatedAt", Value: now.Add(-3 * day)}}
		}
		post := func(n int, hostel bson.ObjectID, status string, extra ...bson.E) bson.D {
			d := bson.D{{Key: "_id", Value: gid(2, n)}, {Key: "authorId", Value: OpsResidentUser}, {Key: "body", Value: "Post body"}, {Key: "hostelId", Value: hostel}, {Key: "spaceType", Value: "HOSTEL"}, {Key: "status", Value: status},
				{Key: "visibility", Value: "HOSTEL_ONLY"}, {Key: "isAnnouncement", Value: false}, {Key: "media", Value: bson.A{}}, {Key: "commentCount", Value: 0}, {Key: "reactionCount", Value: 0}, {Key: "reportCount", Value: 0}, {Key: "createdAt", Value: now.Add(-time.Duration(n) * time.Hour)}, {Key: "updatedAt", Value: now}}
			return append(d, extra...)
		}
		sos := func(n int, hostel bson.ObjectID, resident int) bson.D {
			return bson.D{{Key: "_id", Value: gid(2, n)}, {Key: "hostelId", Value: hostel}, {Key: "residentId", Value: gid(2, resident)}, {Key: "triggeredBy", Value: OpsResidentUser}, {Key: "status", Value: "ACTIVE"}, {Key: "message", Value: "Help"},
				{Key: "guardianAlertEnabled", Value: false}, {Key: "createdAt", Value: now.Add(-time.Hour)}, {Key: "updatedAt", Value: now.Add(-time.Hour)}}
		}
		return map[string][]any{
			"complaints": {complaint(0x60, OpsHostelA, 0x30, "Tap leaks", now.Add(day)), complaint(0x61, OpsHostelA, 0x31, "Fan broken", now.Add(-day)), complaint(0x62, OpsHostelB, 0x34, "Elsewhere", now.Add(day))},
			"sosalerts":  {sos(0x68, OpsHostelA, 0x30), sos(0x69, OpsHostelB, 0x34)},
			"communityposts": {
				post(0x70, OpsHostelA, "VISIBLE", bson.E{Key: "flaggedAt", Value: now.Add(-time.Hour)}, bson.E{Key: "flaggedReason", Value: "Reported"}),
				post(0x71, OpsHostelA, "HIDDEN", bson.E{Key: "hiddenReason", Value: "Rude"}),
				post(0x72, OpsHostelA, "VISIBLE"), post(0x73, OpsHostelB, "VISIBLE"),
			},
			"communityreports": {bson.D{{Key: "_id", Value: gid(2, 0x74)}, {Key: "postId", Value: gid(2, 0x70)}, {Key: "reporterId", Value: OpsResidentUser}, {Key: "reason", Value: "SPAM"}, {Key: "status", Value: "OPEN"}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}}},
		}
	})
}
