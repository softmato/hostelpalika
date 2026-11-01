// Package notices: the resident's side of modules/notices. Publishing lands with Phase 6.
package notices

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/cache"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Cache  *cache.Cache
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	v1.GET("/resident/notices", h.list)
	v1.POST("/resident/notices/read-all", h.readAll)
	v1.PATCH("/resident/notices/:id/read", h.read)
}

// Row is a stored notice, the fields a reader sees.
type Row struct {
	ID             bson.ObjectID `bson:"_id"`
	Category       string        `bson:"category"`
	Content        string        `bson:"content"`
	CreatedAt      *time.Time    `bson:"createdAt"`
	ExpiresAt      *time.Time    `bson:"expiresAt"`
	HostelID       bson.ObjectID `bson:"hostelId"`
	IsUrgent       bool          `bson:"isUrgent"`
	PublishedAt    *time.Time    `bson:"publishedAt"`
	TargetAudience string        `bson:"targetAudience"`
	Title          string        `bson:"title"`
	UpdatedAt      *time.Time    `bson:"updatedAt"`
}

func iso(t *time.Time) any {
	if t == nil {
		return ordered.Undefined
	}
	return httpx.ISO(*t)
}

func serialize(n *Row, readAt *time.Time) ordered.Map {
	audience := n.TargetAudience
	if audience == "" {
		audience = "ALL"
	}
	return ordered.Map{{Key: "category", Value: n.Category}, {Key: "content", Value: n.Content}, {Key: "createdAt", Value: iso(n.CreatedAt)}, {Key: "expiresAt", Value: iso(n.ExpiresAt)},
		{Key: "hostelId", Value: n.HostelID.Hex()}, {Key: "id", Value: n.ID.Hex()}, {Key: "isRead", Value: readAt != nil}, {Key: "isUrgent", Value: n.IsUrgent},
		{Key: "publishedAt", Value: iso(n.PublishedAt)}, {Key: "readAt", Value: iso(readAt)}, {Key: "targetAudience", Value: audience}, {Key: "title", Value: n.Title}, {Key: "updatedAt", Value: iso(n.UpdatedAt)}}
}

// ResidentFilter is residentNoticeFilter: published, for residents, not expired.
func ResidentFilter(hostelID bson.ObjectID) bson.D {
	now := time.Now()
	return bson.D{{Key: "hostelId", Value: hostelID}, {Key: "publishedAt", Value: bson.D{{Key: "$lte", Value: now}}},
		{Key: "targetAudience", Value: bson.D{{Key: "$in", Value: bson.A{"ALL", "RESIDENTS"}}}},
		{Key: "$or", Value: bson.A{bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$exists", Value: false}}}}, bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$gt", Value: now}}}}}}}
}

type listOut struct {
	Notices    []ordered.Map   `json:"notices"`
	Pagination pagination.Meta `json:"pagination"`
	Resident   ordered.Map     `json:"resident"`
}

// ReadAts maps notice id → when this user read it.
func ReadAts(ctx context.Context, db *mongo.Database, ids bson.A, uid bson.ObjectID) (map[string]time.Time, error) {
	cur, err := db.Collection("noticereadstatuses").Find(ctx, bson.D{{Key: "noticeId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "userId", Value: uid}})
	if err != nil {
		return nil, err
	}
	var rows []struct {
		NoticeID bson.ObjectID `bson:"noticeId"`
		ReadAt   time.Time     `bson:"readAt"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make(map[string]time.Time, len(rows))
	for _, r := range rows {
		out[r.NoticeID.Hex()] = r.ReadAt
	}
	return out, nil
}

func (h *Handler) list(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cache.Respond(c, h.Cache, p.HostelIDs, p.UserID, "resident-notices", "Resident notices loaded", func() (listOut, error) {
		r, err := residents.Current(c, h.DB, p)
		if err != nil {
			return listOut{}, err
		}
		uid, err := httpx.OID(p.UserID, "user id")
		if err != nil {
			return listOut{}, err
		}
		size := pagination.MaxPageSize
		q := pagination.Query{PageSize: &size}
		rng := pagination.RangeOf(q)
		filter := ResidentFilter(r.HostelID)
		coll := h.DB.Collection("notices")
		cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "isUrgent", Value: -1}, {Key: "publishedAt", Value: -1}}).SetSkip(int64(rng.Skip)).SetLimit(int64(rng.Limit)))
		if err != nil {
			return listOut{}, err
		}
		var rows []Row
		if err := cur.All(c, &rows); err != nil {
			return listOut{}, err
		}
		total, err := coll.CountDocuments(c, filter)
		if err != nil {
			return listOut{}, err
		}
		ids := bson.A{}
		for _, n := range rows {
			ids = append(ids, n.ID)
		}
		reads, err := ReadAts(c, h.DB, ids, uid)
		if err != nil {
			return listOut{}, err
		}
		out := listOut{Notices: []ordered.Map{}, Pagination: pagination.MetaOf(q, int(total)), Resident: residents.Summary(r)}
		for i := range rows {
			var at *time.Time
			if t, ok := reads[rows[i].ID.Hex()]; ok {
				at = &t
			}
			out.Notices = append(out.Notices, serialize(&rows[i], at))
		}
		return out, nil
	})
}

type readOut struct {
	Notice   ordered.Map `json:"notice"`
	Resident ordered.Map `json:"resident"`
}

func (h *Handler) read(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("id"), "notice id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var n Row
	err = h.DB.Collection("notices").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: r.HostelID}}).Decode(&n)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, httpx.NewError(http.StatusNotFound, "NOTICE_NOT_FOUND", "Notice was not found.", nil))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var st struct {
		ReadAt time.Time `bson:"readAt"`
	}
	err = h.DB.Collection("noticereadstatuses").FindOneAndUpdate(c, bson.D{{Key: "noticeId", Value: n.ID}, {Key: "userId", Value: uid}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "readAt", Value: now}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&st)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, readOut{serialize(&n, &st.ReadAt), residents.Summary(r)}, "Notice marked as read")
}

type marked struct {
	Marked int `json:"marked"`
}

// readAll is idempotent by the unique (noticeId, userId) index: a racing double
// tap inserts once, the loser's duplicate is the state already wanted.
func (h *Handler) readAll(c *gin.Context) {
	p, err := h.Guards.RequireResident(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	r, err := residents.Current(c, h.DB, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.DB.Collection("notices").Find(c, ResidentFilter(r.HostelID), options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := bson.A{}
	for _, x := range rows {
		ids = append(ids, x.ID)
	}
	reads, err := ReadAts(c, h.DB, ids, uid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	writes := []mongo.WriteModel{}
	for _, x := range rows {
		if _, done := reads[x.ID.Hex()]; !done {
			writes = append(writes, mongo.NewUpdateOneModel().SetFilter(bson.D{{Key: "noticeId", Value: x.ID}, {Key: "userId", Value: uid}}).
				SetUpdate(bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "readAt", Value: now}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}}).SetUpsert(true))
		}
	}
	if len(writes) > 0 {
		if _, err := h.DB.Collection("noticereadstatuses").BulkWrite(c, writes, options.BulkWrite().SetOrdered(false)); err != nil && !mongo.IsDuplicateKeyError(err) {
			httpx.Fail(c, err)
			return
		}
	}
	httpx.OK(c, marked{len(writes)}, "Notices marked as read")
}
