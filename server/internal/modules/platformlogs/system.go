package platformlogs

import (
	"os"
	"runtime"
	"runtime/debug"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	applog "github.com/softmato/hostelpalika/server/internal/platform/log"
	"github.com/softmato/hostelpalika/server/internal/platform/obs"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// The superadmin's system tabs beside the log page: the health strip, the
// process itself, and who was active. Go-only routes (goOnlyAllowed).

func (h *Handler) health(c *gin.Context) {
	if _, err := h.guards.RequireSuperadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := obs.ReadHealth()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"health": out}, "Server health loaded")
}

func commit() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" {
				return s.Value
			}
		}
	}
	return ""
}

// process is this API instance: build, runtime, Mongo, and the stored lines
// that tell its story (boot, jobs, database, redis, recovered panics).
func (h *Handler) process(c *gin.Context) {
	if _, err := h.guards.RequireSuperadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	host, _ := os.Hostname()
	started := obs.StartedAt()
	var lastPause float64
	if ms.NumGC > 0 {
		lastPause = float64(ms.PauseNs[(ms.NumGC+255)%256]) / 1e6
	}
	pingStart := time.Now()
	pingErr := h.coll.Database().Client().Ping(c, nil)
	mongoState := gin.H{"ok": pingErr == nil, "pingMs": float64(time.Since(pingStart).Microseconds()) / 1000}
	if hl, err := obs.ReadHealth(); err == nil {
		mongoState["poolInUse"] = hl.MongoPoolInUse
		mongoState["checkoutFailures"] = hl.MongoCheckoutFailures
	}
	cur, err := h.coll.Find(c, bson.D{{Key: "$or", Value: bson.A{
		bson.D{{Key: "category", Value: bson.D{{Key: "$in", Value: bson.A{"jobs", "database", "redis"}}}}},
		bson.D{{Key: "message", Value: bson.D{{Key: "$regex", Value: "panic"}, {Key: "$options", Value: "i"}}}},
	}}}, options.Find().SetSort(bson.D{{Key: "_id", Value: -1}}).SetLimit(50))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	recent := []applog.Entry{}
	if err := cur.All(c, &recent); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{
		"instance": gin.H{"hostname": host, "pid": os.Getpid(), "startedAt": httpx.ISO(started), "uptimeSeconds": time.Since(started).Seconds(),
			"goVersion": runtime.Version(), "commit": commit(), "goMaxProcs": runtime.GOMAXPROCS(0), "numCPU": runtime.NumCPU()},
		"runtime": gin.H{"goroutines": runtime.NumGoroutine(), "heapAllocBytes": ms.HeapAlloc, "heapSysBytes": ms.HeapSys, "sysBytes": ms.Sys,
			"nextGCBytes": ms.NextGC, "numGC": ms.NumGC, "lastPauseMs": lastPause, "pauseTotalMs": float64(ms.PauseTotalNs) / 1e6},
		"mongo":  mongoState,
		"recent": recent,
	}, "Process loaded")
}

// kathmandu is the hostel day (UTC+5:45); a day key is that calendar date.
var kathmandu = time.FixedZone("Asia/Kathmandu", 5*3600+45*60)

type dayRow struct {
	Day      string         `json:"day"`
	Users    int            `json:"users"`
	ByRole   map[string]int `json:"byRole"`
	ByClient map[string]int `json:"byClient"`
}

type activePerson struct {
	UserID     string    `json:"userId"`
	Name       string    `json:"name"`
	Role       string    `json:"role"`
	HostelID   *string   `json:"hostelId"`
	HostelName *string   `json:"hostelName"`
	FirstSeen  time.Time `json:"firstSeen"`
	LastSeen   time.Time `json:"lastSeen"`
	Opens      int       `json:"opens"`
	Clients    []string  `json:"clients"`
}

// activeUsers is DAU/WAU/MAU per Kathmandu day, by role and client, and who
// was active on one day: an aggregation over usageevents, so history reaches
// back as far as the usage TTL.
// ponytail: one row per user-day comes back to Go; fine at hostel scale (≤ 90
// days), a $setWindowFields pipeline when it is not.
func (h *Handler) activeUsers(c *gin.Context) {
	if _, err := h.guards.RequireSuperadmin(c); err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	days := 30
	if v := valid.QueryNumber(q, "days", true, &is); v != nil {
		days = max(1, min(90, int(*v)))
	}
	day := time.Now().In(kathmandu).Format("2006-01-02")
	if raw, ok := q["day"]; ok {
		if _, err := time.ParseInLocation("2006-01-02", raw, kathmandu); err != nil {
			is.Add("day", "Use YYYY-MM-DD")
		} else {
			day = raw
		}
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	dayStart, _ := time.ParseInLocation("2006-01-02", day, kathmandu)
	end := dayStart.Add(24 * time.Hour)
	from := end.Add(-time.Duration(max(days, 30)) * 24 * time.Hour)
	db := h.coll.Database()
	events := db.Collection("usageevents")
	dayKey := bson.D{{Key: "$dateToString", Value: bson.D{{Key: "format", Value: "%Y-%m-%d"}, {Key: "date", Value: "$at"}, {Key: "timezone", Value: "+0545"}}}}
	cur, err := events.Aggregate(c, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "at", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lt", Value: end}}}}}},
		{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{{Key: "d", Value: dayKey}, {Key: "u", Value: "$userId"}}},
			{Key: "role", Value: bson.D{{Key: "$first", Value: "$role"}}},
			{Key: "clients", Value: bson.D{{Key: "$addToSet", Value: "$client"}}},
		}}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID struct {
			D string        `bson:"d"`
			U bson.ObjectID `bson:"u"`
		} `bson:"_id"`
		Role    string   `bson:"role"`
		Clients []string `bson:"clients"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	weekFrom := end.Add(-7 * 24 * time.Hour).In(kathmandu).Format("2006-01-02")
	seriesFrom := end.Add(-time.Duration(days) * 24 * time.Hour).In(kathmandu).Format("2006-01-02")
	byDay := map[string]*dayRow{}
	week, month := map[bson.ObjectID]bool{}, map[bson.ObjectID]bool{}
	for _, r := range rows {
		month[r.ID.U] = true
		if r.ID.D >= weekFrom {
			week[r.ID.U] = true
		}
		if r.ID.D < seriesFrom {
			continue
		}
		d := byDay[r.ID.D]
		if d == nil {
			d = &dayRow{Day: r.ID.D, ByRole: map[string]int{}, ByClient: map[string]int{}}
			byDay[r.ID.D] = d
		}
		d.Users++
		d.ByRole[r.Role]++
		for _, cl := range r.Clients {
			d.ByClient[cl]++
		}
	}
	series := make([]dayRow, 0, days)
	for t := end.Add(-time.Duration(days) * 24 * time.Hour); t.Before(end); t = t.Add(24 * time.Hour) {
		key := t.In(kathmandu).Format("2006-01-02")
		if d := byDay[key]; d != nil {
			series = append(series, *d)
		} else {
			series = append(series, dayRow{Day: key, ByRole: map[string]int{}, ByClient: map[string]int{}})
		}
	}
	people, err := h.activeOn(c, events, db, dayStart, end)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"day": day, "dau": len(people), "wau": len(week), "mau": len(month), "series": series, "people": people}, "Active users loaded")
}

func (h *Handler) activeOn(c *gin.Context, events *mongo.Collection, db *mongo.Database, from, to time.Time) ([]activePerson, error) {
	cur, err := events.Aggregate(c, mongo.Pipeline{
		{{Key: "$match", Value: bson.D{{Key: "at", Value: bson.D{{Key: "$gte", Value: from}, {Key: "$lt", Value: to}}}}}},
		{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$userId"}, {Key: "role", Value: bson.D{{Key: "$first", Value: "$role"}}}, {Key: "hostel", Value: bson.D{{Key: "$first", Value: "$hostelId"}}},
			{Key: "first", Value: bson.D{{Key: "$min", Value: "$at"}}}, {Key: "last", Value: bson.D{{Key: "$max", Value: "$at"}}},
			{Key: "opens", Value: bson.D{{Key: "$sum", Value: bson.D{{Key: "$cond", Value: bson.A{bson.D{{Key: "$eq", Value: bson.A{"$kind", "open"}}}, 1, 0}}}}}},
			{Key: "clients", Value: bson.D{{Key: "$addToSet", Value: "$client"}}}}}},
		{{Key: "$sort", Value: bson.D{{Key: "last", Value: -1}}}},
		{{Key: "$limit", Value: 500}},
	})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID      bson.ObjectID  `bson:"_id"`
		Role    string         `bson:"role"`
		Hostel  *bson.ObjectID `bson:"hostel"`
		First   time.Time      `bson:"first"`
		Last    time.Time      `bson:"last"`
		Opens   int            `bson:"opens"`
		Clients []string       `bson:"clients"`
	}
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}
	users, hostels := bson.A{}, bson.A{}
	for _, r := range rows {
		users = append(users, r.ID)
		if r.Hostel != nil {
			hostels = append(hostels, *r.Hostel)
		}
	}
	names, err := namesOf(c, db.Collection("users"), users)
	if err != nil {
		return nil, err
	}
	hostelNames, err := namesOf(c, db.Collection("hostels"), hostels)
	if err != nil {
		return nil, err
	}
	out := make([]activePerson, 0, len(rows))
	for _, r := range rows {
		p := activePerson{UserID: r.ID.Hex(), Name: names[r.ID], Role: r.Role, FirstSeen: r.First, LastSeen: r.Last, Opens: r.Opens, Clients: r.Clients}
		sort.Strings(p.Clients)
		if r.Hostel != nil {
			id, name := r.Hostel.Hex(), hostelNames[*r.Hostel]
			p.HostelID, p.HostelName = &id, &name
		}
		out = append(out, p)
	}
	return out, nil
}

func namesOf(c *gin.Context, coll *mongo.Collection, ids bson.A) (map[bson.ObjectID]string, error) {
	out := map[bson.ObjectID]string{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := coll.Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
	}
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = r.Name
	}
	return out, nil
}
