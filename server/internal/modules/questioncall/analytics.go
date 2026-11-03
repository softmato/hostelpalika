package questioncall

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// Analytics is GET /platform/questioncall/analytics: clicks and conversions per
// hostel and per UTC day. A moderator reads it; the CSV is a superadmin export.
type Analytics struct {
	DB     *mongo.Database
	Guards *authz.Guards
}

func (a *Analytics) Register(v1 *gin.RouterGroup) {
	v1.GET("/platform/questioncall/analytics", authz.Use(a.Guards.RequirePlatform), httpx.ETag(), a.get)
}

var csvColumns = []export.Column{{Key: "hostelName", Label: "Hostel"}, {Key: "clicks", Label: "Clicks"},
	{Key: "conversions", Label: "Conversions"}, {Key: "conversionRatePercent", Label: "Conversion rate (%)"}}

type hostelCount struct {
	ID          bson.ObjectID `bson:"_id"`
	Clicks      int64         `bson:"clicks"`
	Conversions int64         `bson:"conversions"`
}

type dayCount struct {
	Date        string `bson:"_id"`
	Clicks      int64  `bson:"clicks"`
	Conversions int64  `bson:"conversions"`
}

func (a *Analytics) get(c *gin.Context) {
	// The guard runs before the query is read (TS parsed first, P7-35).
	q := valid.Query(c)
	var is valid.Issues
	// Issues in the schema's key order: endDate, format, hostelId, startDate.
	window := bson.D{}
	date := func(key, op string) {
		raw, ok := q[key]
		if !ok {
			return
		}
		if t, ok := valid.CoerceDate(raw); ok {
			window = append(window, bson.E{Key: op, Value: t})
		} else {
			is.Add(key, "Invalid input: expected date, received Date")
		}
	}
	date("endDate", "$lte")
	format := "json"
	if f := valid.QueryEnum(q, "format", &is, "json", "csv"); f != nil {
		format = *f
	}
	match := bson.D{}
	if raw, ok := q["hostelId"]; ok {
		if id, ok := valid.ObjectID(raw, "hostelId", "", &is, false); ok {
			oid, _ := bson.ObjectIDFromHex(id)
			match = append(match, bson.E{Key: "hostelId", Value: oid})
		}
	}
	date("startDate", "$gte")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	if format == "csv" {
		if _, err := a.Guards.RequireSuperadmin(c); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	if len(window) > 0 {
		match = append(match, bson.E{Key: "clickedAt", Value: window})
	}
	// One pass in Mongo, every click counted (TS read the newest 5,000 and
	// summed those, so a busy month undercounted silently, P7-36).
	converted := bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$converted", true}}}, 1, 0}}}
	counts := bson.D{{Key: "clicks", Value: bson.D{{Key: "$sum", Value: 1}}}, {Key: "conversions", Value: bson.D{{Key: "$sum", Value: converted}}}}
	group := func(id any, extra ...bson.E) bson.D {
		return bson.D{{Key: "$group", Value: append(append(bson.D{{Key: "_id", Value: id}}, counts...), extra...)}}
	}
	pipeline := bson.A{bson.D{{Key: "$match", Value: match}}, bson.D{{Key: "$facet", Value: bson.D{
		// Ties keep TS's order: the hostel clicked most recently first.
		{Key: "hostels", Value: bson.A{group("$hostelId", bson.E{Key: "last", Value: bson.D{{Key: "$max", Value: "$clickedAt"}}}),
			bson.D{{Key: "$sort", Value: bson.D{{Key: "clicks", Value: -1}, {Key: "last", Value: -1}}}}}},
		{Key: "days", Value: bson.A{group(bson.D{{Key: "$dateToString", Value: bson.D{{Key: "format", Value: "%Y-%m-%d"}, {Key: "date", Value: "$clickedAt"}}}}),
			bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}}}},
		{Key: "total", Value: bson.A{group(nil)}},
		{Key: "users", Value: bson.A{bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$userId"}}}}, bson.D{{Key: "$count", Value: "n"}}}},
	}}}}
	cur, err := a.DB.Collection("questioncallclicks").Aggregate(c, pipeline)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var out []struct {
		Hostels []hostelCount `bson:"hostels"`
		Days    []dayCount    `bson:"days"`
		Total   []dayCount    `bson:"total"`
		Users   []struct {
			N int64 `bson:"n"`
		} `bson:"users"`
	}
	if err := cur.All(c, &out); err != nil {
		httpx.Fail(c, err)
		return
	}
	res := out[0]
	names, err := a.hostelNames(c, res.Hostels)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rate := func(conv, clicks int64) float64 {
		if clicks == 0 {
			return 0
		}
		return float64(conv) / float64(clicks)
	}
	if format == "csv" {
		rows := make([]map[string]any, len(res.Hostels))
		for i, h := range res.Hostels {
			rows[i] = map[string]any{"hostelName": names(h.ID), "clicks": h.Clicks, "conversions": h.Conversions,
				"conversionRatePercent": strconv.FormatFloat(rate(h.Conversions, h.Clicks)*100, 'f', 1, 64)}
		}
		export.WriteCSV(c.Writer, export.CSV(csvColumns, rows), export.CSVFilename("questioncall-analytics", time.Now()))
		return
	}
	byHostel := make([]ordered.Map, len(res.Hostels))
	for i, h := range res.Hostels {
		byHostel[i] = ordered.Map{{Key: "clicks", Value: h.Clicks}, {Key: "conversionRate", Value: rate(h.Conversions, h.Clicks)}, {Key: "conversions", Value: h.Conversions},
			{Key: "hostelId", Value: h.ID.Hex()}, {Key: "hostelName", Value: names(h.ID)}}
	}
	byDay := make([]ordered.Map, len(res.Days))
	for i, d := range res.Days {
		byDay[i] = ordered.Map{{Key: "clicks", Value: d.Clicks}, {Key: "conversions", Value: d.Conversions}, {Key: "date", Value: d.Date}}
	}
	var total dayCount
	if len(res.Total) > 0 {
		total = res.Total[0]
	}
	var unique int64
	if len(res.Users) > 0 {
		unique = res.Users[0].N
	}
	httpx.OK(c, ordered.Map{{Key: "byDay", Value: byDay}, {Key: "byHostel", Value: byHostel}, {Key: "summary", Value: ordered.Map{
		{Key: "conversionRate", Value: rate(total.Conversions, total.Clicks)}, {Key: "conversions", Value: total.Conversions},
		{Key: "totalClicks", Value: total.Clicks}, {Key: "uniqueResidents", Value: unique}}}}, "QuestionCall analytics loaded")
}

func (a *Analytics) hostelNames(c *gin.Context, rows []hostelCount) (func(bson.ObjectID) string, error) {
	ids := bson.A{}
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	names := map[bson.ObjectID]string{}
	if len(ids) > 0 {
		cur, err := a.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var hs []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name string        `bson:"name"`
		}
		if err := cur.All(c, &hs); err != nil {
			return nil, err
		}
		for _, h := range hs {
			names[h.ID] = h.Name
		}
	}
	return func(id bson.ObjectID) string {
		if n, ok := names[id]; ok {
			return n
		}
		return "Unknown hostel"
	}, nil
}
