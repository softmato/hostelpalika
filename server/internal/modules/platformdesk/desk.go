// Package platformdesk is the superadmin portal's read-only desks: people,
// complaints, audit log, backup status, usage analytics, and the upload URL for
// the Android APK and promo films.
package platformdesk

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/storage"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	R2     *storage.R2
	Now    func() time.Time
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	e := httpx.ETag()
	staff := authz.Use(h.Guards.RequirePlatform)
	super := authz.Use(h.Guards.RequireSuperadmin)
	v1.GET("/platform/users", staff, e, h.directory)
	v1.GET("/platform/complaints", staff, e, h.complaints)
	v1.GET("/platform/audit-logs", staff, e, h.auditLogs)
	v1.GET("/platform/backup-status", super, h.backupStatus)
	v1.GET("/platform/usage", super, h.usage)
	v1.POST("/platform/app-apk", super, h.appUpload)
}

// listLimit is LIST_LIMIT: the directory and complaints show the newest 250.
const listLimit = 250

func iso(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.ISO(*t)
}

func (h *Handler) names(ctx context.Context, coll string, ids []bson.ObjectID) (map[bson.ObjectID]struct{ Name, Email *string }, error) {
	out := map[bson.ObjectID]struct{ Name, Email *string }{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection(coll).Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "email", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID    bson.ObjectID `bson:"_id"`
		Name  *string       `bson:"name"`
		Email *string       `bson:"email"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = struct{ Name, Email *string }{r.Name, r.Email}
	}
	return out, nil
}

func (h *Handler) hostelName(m map[bson.ObjectID]struct{ Name, Email *string }, id bson.ObjectID) string {
	if r, ok := m[id]; ok && r.Name != nil {
		return *r.Name
	}
	return "—"
}

// countInOrder is a JS object count: keys in the order first seen.
type countInOrder struct {
	keys []string
	n    map[string]int
}

func (c *countInOrder) add(k string) {
	if c.n == nil {
		c.n = map[string]int{}
	}
	if _, ok := c.n[k]; !ok {
		c.keys = append(c.keys, k)
	}
	c.n[k]++
}

func (c *countInOrder) out() ordered.Map {
	m := ordered.Map{}
	for _, k := range c.keys {
		m = append(m, ordered.Pair{Key: k, Value: c.n[k]})
	}
	return m
}

// ---- people ----

type residentRow struct {
	ID        bson.ObjectID  `bson:"_id"`
	CreatedAt *time.Time     `bson:"createdAt"`
	Email     *string        `bson:"email"`
	FirstName string         `bson:"firstName"`
	LastName  string         `bson:"lastName"`
	HostelID  bson.ObjectID  `bson:"hostelId"`
	MoveIn    *time.Time     `bson:"moveInDate"`
	Phone     string         `bson:"phone"`
	RoomType  *string        `bson:"roomType"`
	Status    string         `bson:"status"`
	UserID    *bson.ObjectID `bson:"userId"`
}

// firstBy reads rows newest-first and keeps the first per resident.
func firstBy[T any](ctx context.Context, db *mongo.Database, coll string, ids bson.A, sort bson.D, key func(T) bson.ObjectID) (map[bson.ObjectID]T, error) {
	cur, err := db.Collection(coll).Find(ctx, bson.D{{Key: "residentId", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetSort(sort))
	if err != nil {
		return nil, err
	}
	var rows []T
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := map[bson.ObjectID]T{}
	for _, r := range rows {
		if _, ok := out[key(r)]; !ok {
			out[key(r)] = r
		}
	}
	return out, nil
}

// directory is listPlatformDirectory: every account, and residents with none,
// with the resident facts a platform admin answers calls about.
func (h *Handler) directory(c *gin.Context) {
	ucur, err := h.DB.Collection("users").Find(c, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(listLimit))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var users []struct {
		ID        bson.ObjectID   `bson:"_id"`
		CreatedAt *time.Time      `bson:"createdAt"`
		DemoLabel *string         `bson:"demoDataLabel"`
		Email     *string         `bson:"email"`
		HostelIDs []bson.ObjectID `bson:"hostelIds"`
		IsDemo    bool            `bson:"isDemoData"`
		LastLogin *time.Time      `bson:"lastLoginAt"`
		Name      *string         `bson:"name"`
		Phone     *string         `bson:"phone"`
		Role      *string         `bson:"role"`
		Status    *string         `bson:"status"`
	}
	if err := ucur.All(c, &users); err != nil {
		httpx.Fail(c, err)
		return
	}
	rcur, err := h.DB.Collection("residents").Find(c, bson.D{{Key: "isDeleted", Value: false}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(listLimit))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var residents []residentRow
	if err := rcur.All(c, &residents); err != nil {
		httpx.Fail(c, err)
		return
	}
	rids := bson.A{}
	for _, r := range residents {
		rids = append(rids, r.ID)
	}
	type guardian struct {
		Resident  bson.ObjectID `bson:"residentId"`
		FirstName string        `bson:"firstName"`
		LastName  string        `bson:"lastName"`
		Phone     string        `bson:"phone"`
		Relation  string        `bson:"relation"`
	}
	type contact struct {
		Resident bson.ObjectID `bson:"residentId"`
		Name     string        `bson:"name"`
		Phone    string        `bson:"phone"`
		Relation string        `bson:"relation"`
	}
	type night struct {
		Resident bson.ObjectID `bson:"residentId"`
		Status   string        `bson:"status"`
	}
	type activation struct {
		Resident bson.ObjectID `bson:"residentId"`
		Status   string        `bson:"status"`
	}
	primaryFirst := bson.D{{Key: "isPrimary", Value: -1}, {Key: "createdAt", Value: -1}}
	guardians, err := firstBy(c, h.DB, "guardians", rids, primaryFirst, func(g guardian) bson.ObjectID { return g.Resident })
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	contacts, err := firstBy(c, h.DB, "emergencycontacts", rids, primaryFirst, func(g contact) bson.ObjectID { return g.Resident })
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	nights, err := firstBy(c, h.DB, "nightstatuses", rids, bson.D{{Key: "checkedAt", Value: -1}}, func(g night) bson.ObjectID { return g.Resident })
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	activations, err := firstBy(c, h.DB, "qractivations", rids, bson.D{{Key: "createdAt", Value: -1}}, func(g activation) bson.ObjectID { return g.Resident })
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	latest := map[string]finance.LedgerInvoice{}
	if len(rids) > 0 {
		invs, err := finance.ListLedger(c, h.DB, finance.UnvoidedMatch(bson.D{{Key: "residentId", Value: bson.D{{Key: "$in", Value: rids}}}}), bson.D{{Key: "dueDate", Value: -1}}, 0)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, inv := range invs {
			if _, ok := latest[inv.ResidentID]; !ok {
				latest[inv.ResidentID] = inv
			}
		}
	}
	hostelIDs := []bson.ObjectID{}
	for _, r := range residents {
		hostelIDs = append(hostelIDs, r.HostelID)
	}
	for _, u := range users {
		hostelIDs = append(hostelIDs, u.HostelIDs...)
	}
	hostels, err := h.names(c, "hostels", hostelIDs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byUser := map[bson.ObjectID]*residentRow{}
	for i := range residents {
		if residents[i].UserID != nil {
			byUser[*residents[i].UserID] = &residents[i]
		}
	}
	enrich := func(r *residentRow) ordered.Map {
		if r == nil {
			return ordered.Map{{Key: "activationStatus", Value: ""}, {Key: "emergencyContact", Value: nil}, {Key: "feeMonth", Value: ""}, {Key: "feeStatus", Value: ""},
				{Key: "guardian", Value: nil}, {Key: "moveInDate", Value: nil}, {Key: "nightStatus", Value: ""}, {Key: "residentId", Value: nil}, {Key: "residentStatus", Value: ""}, {Key: "stayType", Value: ""}}
		}
		act := "NOT_GENERATED"
		if a, ok := activations[r.ID]; ok {
			act = a.Status
		}
		var emergency, guard any
		if e, ok := contacts[r.ID]; ok {
			emergency = ordered.Map{{Key: "name", Value: e.Name}, {Key: "phone", Value: e.Phone}, {Key: "relation", Value: e.Relation}}
		}
		if g, ok := guardians[r.ID]; ok {
			guard = ordered.Map{{Key: "name", Value: strings.TrimSpace(g.FirstName + " " + g.LastName)}, {Key: "phone", Value: g.Phone}, {Key: "relation", Value: g.Relation}}
		}
		month, fee := "", ""
		if inv, ok := latest[r.ID.Hex()]; ok {
			if inv.Period != nil {
				month = *inv.Period
			}
			fee = inv.Status
		}
		nightStatus := ""
		if n, ok := nights[r.ID]; ok {
			nightStatus = n.Status
		}
		stay := ""
		if r.RoomType != nil {
			stay = *r.RoomType
		}
		return ordered.Map{{Key: "activationStatus", Value: act}, {Key: "emergencyContact", Value: emergency}, {Key: "feeMonth", Value: month}, {Key: "feeStatus", Value: fee},
			{Key: "guardian", Value: guard}, {Key: "moveInDate", Value: iso(r.MoveIn)}, {Key: "nightStatus", Value: nightStatus}, {Key: "residentId", Value: r.ID.Hex()},
			{Key: "residentStatus", Value: r.Status}, {Key: "stayType", Value: stay}}
	}
	or := func(s *string, d string) string {
		if s == nil {
			return d
		}
		return *s
	}
	people := []ordered.Map{}
	var roles countInOrder
	linked := map[bson.ObjectID]bool{}
	for _, u := range users {
		r := byUser[u.ID]
		hostelID := ""
		email, phone := or(u.Email, ""), or(u.Phone, "")
		if r != nil {
			hostelID = r.HostelID.Hex()
			linked[r.ID] = true
			if u.Email == nil && r.Email != nil {
				email = *r.Email
			}
			if u.Phone == nil {
				phone = r.Phone
			}
		} else if len(u.HostelIDs) > 0 {
			hostelID = u.HostelIDs[0].Hex()
		}
		hostelName := ""
		if hostelID != "" {
			hid, _ := bson.ObjectIDFromHex(hostelID)
			hostelName = h.hostelName(hostels, hid)
		}
		role := or(u.Role, "PUBLIC")
		roles.add(role)
		people = append(people, append(ordered.Map{{Key: "createdAt", Value: iso(u.CreatedAt)}, {Key: "demoDataLabel", Value: or(u.DemoLabel, "")}, {Key: "email", Value: email},
			{Key: "hostelCount", Value: len(u.HostelIDs)}, {Key: "hostelId", Value: hostelID}, {Key: "hostelName", Value: hostelName}, {Key: "id", Value: u.ID.Hex()},
			{Key: "isDemoData", Value: u.IsDemo}, {Key: "lastLoginAt", Value: iso(u.LastLogin)}, {Key: "name", Value: or(u.Name, "Unnamed user")}, {Key: "phone", Value: phone},
			{Key: "role", Value: role}, {Key: "status", Value: or(u.Status, "ACTIVE")}}, enrich(r)...))
	}
	for i := range residents {
		r := &residents[i]
		if linked[r.ID] {
			continue
		}
		roles.add("RESIDENT")
		people = append(people, append(ordered.Map{{Key: "createdAt", Value: iso(r.CreatedAt)}, {Key: "demoDataLabel", Value: ""}, {Key: "email", Value: or(r.Email, "")},
			{Key: "hostelCount", Value: 1}, {Key: "hostelId", Value: r.HostelID.Hex()}, {Key: "hostelName", Value: h.hostelName(hostels, r.HostelID)}, {Key: "id", Value: "resident:" + r.ID.Hex()},
			{Key: "isDemoData", Value: false}, {Key: "lastLoginAt", Value: nil}, {Key: "name", Value: strings.TrimSpace(r.FirstName + " " + r.LastName)}, {Key: "phone", Value: r.Phone},
			{Key: "role", Value: "RESIDENT"}, {Key: "status", Value: r.Status}}, enrich(r)...))
	}
	httpx.OK(c, ordered.Map{{Key: "people", Value: people}, {Key: "roleCounts", Value: roles.out()}, {Key: "total", Value: len(people)}}, "Users loaded")
}

func (h *Handler) complaints(c *gin.Context) {
	cur, err := h.DB.Collection("complaints").Find(c, bson.D{}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(listLimit))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID         bson.ObjectID `bson:"_id"`
		Category   string        `bson:"category"`
		CreatedAt  *time.Time    `bson:"createdAt"`
		HostelID   bson.ObjectID `bson:"hostelId"`
		Anonymous  bool          `bson:"isAnonymous"`
		ResolvedAt *time.Time    `bson:"resolvedAt"`
		SLADueAt   *time.Time    `bson:"slaDueAt"`
		Status     string        `bson:"status"`
		Title      string        `bson:"title"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := make([]bson.ObjectID, len(rows))
	for i, r := range rows {
		ids[i] = r.HostelID
	}
	hostels, err := h.names(c, "hostels", ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now()
	var counts countInOrder
	out := make([]ordered.Map, len(rows))
	for i, r := range rows {
		counts.add(r.Status)
		overdue := r.Status != "RESOLVED" && r.Status != "REJECTED" && r.SLADueAt != nil && r.SLADueAt.Before(now)
		out[i] = ordered.Map{{Key: "category", Value: r.Category}, {Key: "createdAt", Value: iso(r.CreatedAt)}, {Key: "hostelId", Value: r.HostelID.Hex()},
			{Key: "hostelName", Value: h.hostelName(hostels, r.HostelID)}, {Key: "id", Value: r.ID.Hex()}, {Key: "isAnonymous", Value: r.Anonymous}, {Key: "isOverdue", Value: overdue},
			{Key: "resolvedAt", Value: iso(r.ResolvedAt)}, {Key: "slaDueAt", Value: iso(r.SLADueAt)}, {Key: "status", Value: r.Status}, {Key: "title", Value: r.Title}}
	}
	httpx.OK(c, ordered.Map{{Key: "complaints", Value: out}, {Key: "statusCounts", Value: counts.out()}, {Key: "total", Value: len(rows)}}, "Complaints loaded")
}

// ---- audit log ----

func (h *Handler) auditLogs(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	action := valid.QueryString(q, "action", 1, 0, &is)
	entity := valid.QueryString(q, "entityType", 1, 0, &is)
	limit := 100
	if v := valid.QueryNumber(q, "limit", false, &is); v != nil {
		switch {
		case *v != float64(int(*v)):
			is.Add("limit", valid.Type("int", "number"))
		case *v < 1:
			is.Add("limit", valid.TooSmall("number", 1, true))
		case *v > 250:
			is.Add("limit", valid.TooBig("number", 250, true))
		default:
			limit = int(*v)
		}
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	filter := bson.D{}
	if action != nil {
		filter = append(filter, bson.E{Key: "action", Value: *action})
	}
	if entity != nil {
		filter = append(filter, bson.E{Key: "entityType", Value: *entity})
	}
	cur, err := h.DB.Collection("auditlogs").Find(c, filter, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(int64(limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID        bson.ObjectID  `bson:"_id"`
		Action    string         `bson:"action"`
		ActorID   *bson.ObjectID `bson:"actorId"`
		CreatedAt *time.Time     `bson:"createdAt"`
		EntityID  string         `bson:"entityId"`
		Entity    string         `bson:"entityType"`
		HostelID  *bson.ObjectID `bson:"hostelId"`
		IP        *string        `bson:"ipAddress"`
		Metadata  bson.RawValue  `bson:"metadata"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	var actorIDs, hostelIDs []bson.ObjectID
	for _, r := range rows {
		if r.ActorID != nil {
			actorIDs = append(actorIDs, *r.ActorID)
		}
		if r.HostelID != nil {
			hostelIDs = append(hostelIDs, *r.HostelID)
		}
	}
	actors, err := h.names(c, "users", actorIDs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostels, err := h.names(c, "hostels", hostelIDs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]ordered.Map, len(rows))
	for i, r := range rows {
		var actorID, hostelID, hostelLabel, ip any
		label := "Unknown actor"
		if r.ActorID != nil {
			actorID, label = r.ActorID.Hex(), r.ActorID.Hex()
			if a, ok := actors[*r.ActorID]; ok {
				if a.Email != nil && *a.Email != "" {
					label = *a.Email
				}
				if a.Name != nil && *a.Name != "" {
					label = *a.Name
				}
			}
		}
		if r.HostelID != nil {
			hostelID = r.HostelID.Hex()
			if hn, ok := hostels[*r.HostelID]; ok && hn.Name != nil {
				hostelLabel = *hn.Name
			}
		}
		if r.IP != nil {
			ip = *r.IP
		}
		meta := any(ordered.Map{})
		if r.Metadata.Type == bson.TypeEmbeddedDocument {
			meta = ordered.FromBSON(r.Metadata)
		}
		out[i] = ordered.Map{{Key: "action", Value: r.Action}, {Key: "actorId", Value: actorID}, {Key: "actorLabel", Value: label}, {Key: "createdAt", Value: iso(r.CreatedAt)},
			{Key: "entityId", Value: r.EntityID}, {Key: "entityType", Value: r.Entity}, {Key: "hostelId", Value: hostelID}, {Key: "hostelLabel", Value: hostelLabel},
			{Key: "id", Value: r.ID.Hex()}, {Key: "ipAddress", Value: ip}, {Key: "metadata", Value: meta}}
	}
	httpx.OK(c, ordered.Map{{Key: "logs", Value: out}}, "Audit logs loaded")
}

// ---- backup status ----

func (h *Handler) backupStatus(c *gin.Context) {
	type report struct {
		ArchivedAt  *time.Time `bson:"archivedAt"`
		Bytes       *int64     `bson:"bytes"`
		Collections *int64     `bson:"collections"`
		CreatedAt   time.Time  `bson:"createdAt"`
		Documents   *int64     `bson:"documents"`
		File        string     `bson:"file"`
		Mismatches  []struct {
			Actual     int64  `bson:"actual" json:"actual"`
			Collection string `bson:"collection" json:"collection"`
			Expected   int64  `bson:"expected" json:"expected"`
		} `bson:"mismatches"`
		OK bool `bson:"ok"`
	}
	latest := func(filter bson.D) (*report, error) {
		var r report
		err := h.DB.Collection("platformbackupreports").FindOne(c, filter, options.FindOne().SetSort(bson.D{{Key: "createdAt", Value: -1}})).Decode(&r)
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return &r, err
	}
	backup, err := latest(bson.D{{Key: "kind", Value: "BACKUP"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	drill, err := latest(bson.D{{Key: "kind", Value: "DRILL"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	passed, err := latest(bson.D{{Key: "kind", Value: "DRILL"}, {Key: "ok", Value: true}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	num := func(n *int64) int64 {
		if n == nil {
			return 0
		}
		return *n
	}
	var backupOut, drillOut, passedOut any
	if backup != nil {
		at := backup.CreatedAt
		if backup.ArchivedAt != nil {
			at = *backup.ArchivedAt
		}
		var bytes any
		if backup.Bytes != nil {
			bytes = *backup.Bytes
		}
		backupOut = ordered.Map{{Key: "at", Value: httpx.ISO(at)}, {Key: "bytes", Value: bytes}, {Key: "collections", Value: num(backup.Collections)}, {Key: "documents", Value: num(backup.Documents)},
			{Key: "file", Value: backup.File}, {Key: "stale", Value: time.Since(at) > 30*time.Hour}}
	}
	if drill != nil {
		mm := any(drill.Mismatches)
		if drill.Mismatches == nil {
			mm = []any{}
		}
		drillOut = ordered.Map{{Key: "at", Value: httpx.ISO(drill.CreatedAt)}, {Key: "file", Value: drill.File}, {Key: "mismatches", Value: mm}, {Key: "ok", Value: drill.OK}}
	}
	if passed != nil {
		passedOut = ordered.Map{{Key: "at", Value: httpx.ISO(passed.CreatedAt)}, {Key: "file", Value: passed.File}}
	}
	httpx.OK(c, ordered.Map{{Key: "backup", Value: backupOut}, {Key: "drill", Value: drillOut}, {Key: "lastPassedDrill", Value: passedOut}}, "Backup status loaded")
}

// ---- usage analytics ----

var hex24 = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

func sums() bson.D {
	return bson.D{{Key: "durationMs", Value: bson.D{{Key: "$sum", Value: "$durationMs"}}}, {Key: "opens", Value: bson.D{{Key: "$sum", Value: "$opens"}}},
		{Key: "userSet", Value: bson.D{{Key: "$addToSet", Value: "$userId"}}}, {Key: "uses", Value: bson.D{{Key: "$sum", Value: "$uses"}}}, {Key: "views", Value: bson.D{{Key: "$sum", Value: "$views"}}}}
}

var countUsers = bson.D{{Key: "$set", Value: bson.D{{Key: "users", Value: bson.D{{Key: "$size", Value: "$userSet"}}}}}}

type grouped struct {
	ID         bson.RawValue `bson:"_id"`
	DurationMs int64         `bson:"durationMs"`
	Opens      int64         `bson:"opens"`
	Users      int64         `bson:"users"`
	Uses       int64         `bson:"uses"`
	Views      int64         `bson:"views"`
	HostelID   bson.RawValue `bson:"hostelId"`
	LastDay    string        `bson:"lastDay"`
	Role       string        `bson:"role"`
}

// row is a $group row as Mongo returns it: the sums in spec order, then the
// users count the $set appended.
func (g grouped) row() ordered.Map {
	return ordered.Map{{Key: "durationMs", Value: g.DurationMs}, {Key: "opens", Value: g.Opens}, {Key: "uses", Value: g.Uses}, {Key: "views", Value: g.Views}, {Key: "users", Value: g.Users}}
}

func idString(v bson.RawValue) string {
	switch v.Type {
	case bson.TypeObjectID:
		return v.ObjectID().Hex()
	case bson.TypeString:
		return v.StringValue()
	case bson.TypeNull, 0:
		return "null"
	}
	return v.String()
}

func (h *Handler) usage(c *gin.Context) {
	q := valid.Query(c)
	var is valid.Issues
	days := 30
	if v := valid.QueryNumber(q, "days", false, &is); v != nil {
		switch {
		case *v != float64(int(*v)):
			is.Add("days", valid.Type("int", "number"))
		case *v < 1:
			is.Add("days", valid.TooSmall("number", 1, true))
		case *v > 365:
			is.Add("days", valid.TooBig("number", 365, true))
		default:
			days = int(*v)
		}
	}
	userID, hasUser := q["userId"]
	if hasUser && !hex24.MatchString(userID) {
		is.Add("userId", "Invalid object id.")
	}
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	from := bs.CalendarDay(time.Now().Add(-time.Duration(days-1) * 24 * time.Hour)).Format("2006-01-02")
	base := bson.D{{Key: "day", Value: bson.D{{Key: "$gte", Value: from}}}}
	var user bson.ObjectID
	if hasUser {
		user, _ = bson.ObjectIDFromHex(userID)
		base = append(base, bson.E{Key: "userId", Value: user})
	}
	coll := h.DB.Collection("usagedailies")
	run := func(stages bson.A) ([]grouped, error) {
		cur, err := coll.Aggregate(c, stages)
		if err != nil {
			return nil, err
		}
		var out []grouped
		return out, cur.All(c, &out)
	}
	with := func(more ...bson.E) bson.D { return append(append(bson.D{}, base...), more...) }
	groupBy := func(field string, match bson.D, sort string, limit int) bson.A {
		return bson.A{bson.D{{Key: "$match", Value: match}}, bson.D{{Key: "$group", Value: append(bson.D{{Key: "_id", Value: "$" + field}}, sums()...)}}, countUsers,
			bson.D{{Key: "$project", Value: bson.D{{Key: "userSet", Value: 0}}}}, bson.D{{Key: "$sort", Value: bson.D{{Key: sort, Value: -1}}}}, bson.D{{Key: "$limit", Value: limit}}}
	}
	totals, err := run(bson.A{bson.D{{Key: "$match", Value: base}}, bson.D{{Key: "$group", Value: append(bson.D{{Key: "_id", Value: nil}}, sums()...)}}, countUsers})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	users, err := run(bson.A{bson.D{{Key: "$match", Value: base}}, bson.D{{Key: "$sort", Value: bson.D{{Key: "day", Value: 1}}}},
		bson.D{{Key: "$group", Value: append(append(bson.D{{Key: "_id", Value: "$userId"}}, sums()...), bson.E{Key: "hostelId", Value: bson.D{{Key: "$last", Value: "$hostelId"}}},
			bson.E{Key: "lastDay", Value: bson.D{{Key: "$last", Value: "$day"}}}, bson.E{Key: "role", Value: bson.D{{Key: "$last", Value: "$role"}}})}},
		countUsers, bson.D{{Key: "$project", Value: bson.D{{Key: "userSet", Value: 0}}}}, bson.D{{Key: "$sort", Value: bson.D{{Key: "opens", Value: -1}, {Key: "durationMs", Value: -1}}}}, bson.D{{Key: "$limit", Value: 100}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	screens, err := run(groupBy("screen", with(bson.E{Key: "screen", Value: bson.D{{Key: "$ne", Value: ""}}}), "durationMs", 40))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	features, err := run(groupBy("feature", with(bson.E{Key: "feature", Value: bson.D{{Key: "$ne", Value: ""}}}), "uses", 40))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byRole, err := run(groupBy("role", base, "opens", 20))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byHostel, err := run(groupBy("hostelId", with(bson.E{Key: "hostelId", Value: bson.D{{Key: "$ne", Value: nil}}}), "opens", 40))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	daily, err := run(bson.A{bson.D{{Key: "$match", Value: base}}, bson.D{{Key: "$group", Value: append(bson.D{{Key: "_id", Value: "$day"}}, sums()...)}}, countUsers,
		bson.D{{Key: "$project", Value: bson.D{{Key: "userSet", Value: 0}}}}, bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var peopleIDs, hostelIDs []bson.ObjectID
	for _, u := range users {
		if u.ID.Type == bson.TypeObjectID {
			peopleIDs = append(peopleIDs, u.ID.ObjectID())
		}
		if u.HostelID.Type == bson.TypeObjectID {
			hostelIDs = append(hostelIDs, u.HostelID.ObjectID())
		}
	}
	if hasUser {
		peopleIDs = append(peopleIDs, user)
	}
	for _, r := range byHostel {
		if r.ID.Type == bson.TypeObjectID {
			hostelIDs = append(hostelIDs, r.ID.ObjectID())
		}
	}
	people, err := h.names(c, "users", peopleIDs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	hostels, err := h.names(c, "hostels", hostelIDs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	nameOf := func(m map[bson.ObjectID]struct{ Name, Email *string }, v bson.RawValue, fallback any) (name, mail any) {
		name, mail = fallback, nil
		if v.Type == bson.TypeObjectID {
			if r, ok := m[v.ObjectID()]; ok {
				if r.Name != nil {
					name = *r.Name
				}
				if r.Email != nil {
					mail = *r.Email
				}
			}
		}
		return
	}
	rows := func(gs []grouped, key string) []ordered.Map {
		out := make([]ordered.Map, len(gs))
		for i, g := range gs {
			out[i] = append(g.row(), ordered.Pair{Key: key, Value: idString(g.ID)})
		}
		return out
	}
	hostelRows := make([]ordered.Map, len(byHostel))
	for i, g := range byHostel {
		name, _ := nameOf(hostels, g.ID, "Removed hostel")
		hostelRows[i] = append(g.row(), ordered.Pair{Key: "hostelId", Value: idString(g.ID)}, ordered.Pair{Key: "hostelName", Value: name})
	}
	recent := []ordered.Map{}
	if hasUser {
		cur, err := h.DB.Collection("usageevents").Find(c, bson.D{{Key: "userId", Value: user}}, options.Find().SetSort(bson.D{{Key: "at", Value: -1}}).SetLimit(60))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var evs []struct {
			At         time.Time `bson:"at"`
			Client     string    `bson:"client"`
			Kind       string    `bson:"kind"`
			Screen     string    `bson:"screen"`
			Feature    string    `bson:"feature"`
			DurationMs int64     `bson:"durationMs"`
		}
		if err := cur.All(c, &evs); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, e := range evs {
			recent = append(recent, ordered.Map{{Key: "at", Value: httpx.ISO(e.At)}, {Key: "client", Value: e.Client}, {Key: "kind", Value: e.Kind}, {Key: "screen", Value: e.Screen},
				{Key: "feature", Value: e.Feature}, {Key: "durationMs", Value: e.DurationMs}})
		}
	}
	total := grouped{}
	if len(totals) > 0 {
		total = totals[0]
	}
	var userOut any
	if hasUser {
		name, mail := nameOf(people, bson.RawValue{Type: bson.TypeObjectID, Value: user[:]}, "Removed account")
		userOut = ordered.Map{{Key: "email", Value: mail}, {Key: "name", Value: name}, {Key: "userId", Value: userID}}
	}
	userRows := make([]ordered.Map, len(users))
	for i, u := range users {
		name, mail := nameOf(people, u.ID, "Removed account")
		var hostelName any
		if u.HostelID.Type == bson.TypeObjectID {
			hostelName, _ = nameOf(hostels, u.HostelID, nil)
		}
		userRows[i] = ordered.Map{{Key: "durationMs", Value: u.DurationMs}, {Key: "opens", Value: u.Opens}, {Key: "uses", Value: u.Uses}, {Key: "views", Value: u.Views},
			{Key: "lastDay", Value: u.LastDay}, {Key: "role", Value: u.Role}, {Key: "users", Value: u.Users}, {Key: "email", Value: mail},
			{Key: "hostelName", Value: hostelName}, {Key: "name", Value: name}, {Key: "userId", Value: idString(u.ID)}}
	}
	httpx.OK(c, ordered.Map{{Key: "byHostel", Value: hostelRows}, {Key: "byRole", Value: rows(byRole, "role")}, {Key: "daily", Value: rows(daily, "day")}, {Key: "days", Value: days},
		{Key: "features", Value: rows(features, "feature")}, {Key: "from", Value: from}, {Key: "recent", Value: recent}, {Key: "screens", Value: rows(screens, "screen")},
		{Key: "totals", Value: ordered.Map{{Key: "durationMs", Value: total.DurationMs}, {Key: "opens", Value: total.Opens}, {Key: "users", Value: total.Users}, {Key: "uses", Value: total.Uses}, {Key: "views", Value: total.Views}}}, {Key: "user", Value: userOut}, {Key: "users", Value: userRows}}, "Usage analytics loaded")
}

// ---- app upload ----

var (
	uploadKinds = map[string][2]string{"apk": {"application/vnd.android.package-archive", "app"}, "mp4": {"video/mp4", "video"}, "webm": {"video/webm", "video"}}
	uploadExt   = regexp.MustCompile(`(?i)\.(apk|mp4|webm)$`)
	stemUnsafe  = regexp.MustCompile(`[^\w.-]+`)
	lastExt     = regexp.MustCompile(`\.[^.]+$`)
)

// appUpload is POST /platform/app-apk: a presigned PUT into the public bucket for
// the Android APK or a promo film.
func (h *Handler) appUpload(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	name, _ := f.Str("fileName", valid.S{Trim: true, Re: uploadExt, ReMsg: "Choose an .apk, .mp4 or .webm file."})
	f.Num("size", valid.N{Int: true, Max: valid.P(300 * 1024 * 1024), MaxMsg: "A file over 300 MB is too big."})
	if v, ok := f.M["size"].(float64); ok && v <= 0 {
		f.Is.Add("size", valid.TooSmall("number", 0, false))
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	ext := strings.ToLower(name[strings.LastIndex(name, ".")+1:])
	kind := uploadKinds[ext]
	stem := stemUnsafe.ReplaceAllString(lastExt.ReplaceAllString(name, ""), "-")
	key := h.R2.WithKeyPrefix(kind[1] + "/" + stem + "-" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "." + ext)
	bucket, err := h.R2.PublicBucket()
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	upload, err := h.R2.PresignUpload(c, bucket, key, kind[0])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	public, err := h.R2.PublicURL(key)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "contentType", Value: kind[0]}, {Key: "uploadUrl", Value: upload}, {Key: "url", Value: public}}, "Upload URL ready")
}
