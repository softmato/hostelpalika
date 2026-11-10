package feedback

import (
	"regexp"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// "Is this page useful?" on the public guide (modules/feedback/guide-feedback).
// Anyone may vote; a signed-in reader's id and role ride along. Platform staff
// read the tally per page and the reasons behind each "No".

var guidePage = regexp.MustCompile(`^/guide(/[a-z0-9-]{1,80}){0,2}$`)

const guideColl = "guidefeedbacks"

func (h *Handler) createGuide(c *gin.Context) {
	if err := h.limiter.Check(c, "guide-feedback", 10, time.Minute); err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	page, _ := f.Str("page", valid.S{Trim: true, Min: 1, Max: 200})
	helpful, _ := f.Bool("helpful", false, nil)
	reason, hasReason := f.Str("reason", valid.S{Opt: true, Trim: true, Max: 1000})
	if page != "" && !guidePage.MatchString(page) {
		f.Is.Add("page", "Unknown page.")
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	// Optional sign-in: a reader whose token fails is still a reader.
	p, _ := h.guards.Load(c)
	now := time.Now().UTC().Truncate(time.Millisecond)
	id := bson.NewObjectID()
	row := bson.D{{Key: "_id", Value: id}, {Key: "page", Value: page}, {Key: "helpful", Value: helpful}}
	if hasReason && reason != "" && !helpful {
		row = append(row, bson.E{Key: "reason", Value: reason})
	}
	if p != nil {
		if uid, err := bson.ObjectIDFromHex(p.UserID); err == nil {
			row = append(row, bson.E{Key: "userId", Value: uid}, bson.E{Key: "role", Value: string(p.Role)})
		}
	}
	row = append(row, bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
	if _, err := h.db.Collection(guideColl).InsertOne(c, row); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "id", Value: id.Hex()}}, "Thanks for telling us.")
}

func (h *Handler) guideInbox(c *gin.Context) {
	coll := h.db.Collection(guideColl)
	// ponytail: tallies scan the whole collection; add a {page:1} index if it grows past a few hundred thousand votes.
	cur, err := coll.Aggregate(c, bson.A{
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$page"},
			{Key: "helpful", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{"$helpful", 1, 0}}}}}},
			{Key: "notHelpful", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{"$helpful", 0, 1}}}}}},
		}}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var tallies []struct {
		Page       string `bson:"_id"`
		Helpful    int    `bson:"helpful"`
		NotHelpful int    `bson:"notHelpful"`
	}
	if err := cur.All(c, &tallies); err != nil {
		httpx.Fail(c, err)
		return
	}
	// Worst pages first; ties settle on the path so the answer is stable.
	sort.Slice(tallies, func(i, j int) bool {
		a, b := tallies[i], tallies[j]
		if a.NotHelpful != b.NotHelpful {
			return a.NotHelpful > b.NotHelpful
		}
		if a.Helpful != b.Helpful {
			return a.Helpful > b.Helpful
		}
		return a.Page < b.Page
	})
	pages := []ordered.Map{}
	for _, t := range tallies {
		pages = append(pages, ordered.Map{{Key: "page", Value: t.Page}, {Key: "helpful", Value: t.Helpful}, {Key: "notHelpful", Value: t.NotHelpful}})
	}

	rcur, err := coll.Find(c, bson.D{{Key: "reason", Value: bson.D{{Key: "$exists", Value: true}}}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(200))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID        bson.ObjectID `bson:"_id"`
		CreatedAt time.Time     `bson:"createdAt"`
		Page      string        `bson:"page"`
		Reason    string        `bson:"reason"`
		Role      *string       `bson:"role"`
	}
	if err := rcur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	reasons := []ordered.Map{}
	for _, r := range rows {
		reasons = append(reasons, ordered.Map{
			{Key: "createdAt", Value: r.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z")},
			{Key: "id", Value: r.ID.Hex()},
			{Key: "page", Value: r.Page},
			{Key: "reason", Value: r.Reason},
			{Key: "role", Value: r.Role},
		})
	}
	httpx.OK(c, ordered.Map{{Key: "pages", Value: pages}, {Key: "reasons", Value: reasons}}, "")
}
