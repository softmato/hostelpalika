// Package community is modules/community's reader and author side: the feed,
// comments, reactions, reports, spaces and the sidebar. Moderation lands with Phase 6.
package community

import (
	"context"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/modules/residents"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/background"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/llm"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/pagination"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

type Handler struct {
	DB     *mongo.Database
	Guards *authz.Guards
	Notify *notifications.Service
	RT     *realtime.Client
	Bump   realtime.Bumper
	BG     *background.Runner
	LLM    *llm.Router
}

func (h *Handler) Register(v1 *gin.RouterGroup) {
	g := v1.Group("/community")
	g.GET("", httpx.ETag(), h.feed)
	g.POST("", h.create)
	g.GET("/sidebar", httpx.ETag(), h.sidebar)
	g.GET("/spaces", httpx.ETag(), h.spaces)
	g.POST("/sponsors/:sponsorId/click", h.sponsorClick)
	g.GET("/:postId", httpx.ETag(), h.get)
	g.DELETE("/:postId", h.remove)
	g.GET("/:postId/comments", httpx.ETag(), h.comments)
	g.POST("/:postId/comments", h.comment)
	g.DELETE("/:postId/comments/:commentId", h.removeComment)
	g.POST("/:postId/comments/:commentId/vote", h.vote)
	g.POST("/:postId/reactions", h.react)
	g.POST("/:postId/report", h.report)
}

var profanity = regexp.MustCompile(`(?i)\b(fuck|shit|bitch|bastard|asshole|randi|muji|gadha)\w*\b`)

// maskProfanity stars a blocked word, letter for letter.
func maskProfanity(s string) string {
	return profanity.ReplaceAllStringFunc(s, func(m string) string { return strings.Repeat("*", valid.JSLen(m)) })
}

type post struct {
	ID             bson.ObjectID  `bson:"_id"`
	AuthorID       *bson.ObjectID `bson:"authorId"`
	Body           string         `bson:"body"`
	CommentCount   int            `bson:"commentCount"`
	CreatedAt      *time.Time     `bson:"createdAt"`
	FlaggedAt      *time.Time     `bson:"flaggedAt"`
	HostelID       *bson.ObjectID `bson:"hostelId"`
	IsAnnouncement bool           `bson:"isAnnouncement"`
	Media          []mediaItem    `bson:"media"`
	MediaAssetIDs  []string       `bson:"mediaAssetIds"`
	ReactionCount  int            `bson:"reactionCount"`
	ReportCount    int            `bson:"reportCount"`
	SpaceType      string         `bson:"spaceType"`
	Status         string         `bson:"status"`
	Visibility     string         `bson:"visibility"`
}

type mediaItem struct {
	AssetID string `json:"assetId" bson:"assetId"`
	Kind    string `json:"kind" bson:"kind"`
}

func (p *post) media() []mediaItem {
	if len(p.Media) > 0 {
		return p.Media
	}
	out := []mediaItem{}
	for _, id := range p.MediaAssetIDs {
		out = append(out, mediaItem{id, "IMAGE"})
	}
	return out
}

func (h *Handler) publish(ctx context.Context, p *post) {
	hostelOnly := p.Visibility == "HOSTEL_ONLY" && p.HostelID != nil
	ch := realtime.Change{Global: !hostelOnly, HostelIDs: []string{}, Topics: []realtime.Topic{realtime.Community}}
	if p.HostelID != nil {
		ch.HostelIDs = []string{p.HostelID.Hex()}
	}
	realtime.PublishResourceChange(ctx, h.RT, h.Bump, ch)
}

func isPlatform(p *authz.Principal) bool {
	return p != nil && (p.Role == authz.Superadmin || p.Role == authz.PlatformModerator)
}

func viewerHostels(p *authz.Principal) bson.A {
	out := bson.A{}
	if p != nil {
		for _, id := range p.HostelIDs {
			if oid, err := bson.ObjectIDFromHex(id); err == nil {
				out = append(out, oid)
			}
		}
	}
	return out
}

func readable(p *authz.Principal) bson.D {
	if isPlatform(p) {
		return bson.D{}
	}
	or := bson.A{bson.D{{Key: "visibility", Value: "PUBLIC"}}}
	if ids := viewerHostels(p); len(ids) > 0 {
		or = append(or, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}})
	}
	return bson.D{{Key: "$or", Value: or}}
}

type author struct {
	Image *string
	Name  string
}

func (h *Handler) names(ctx context.Context, ids []*bson.ObjectID) (map[string]author, error) {
	out := map[string]author{}
	want := bson.A{}
	for _, id := range ids {
		if id != nil {
			want = append(want, *id)
		}
	}
	if len(want) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: want}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "image", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID    bson.ObjectID `bson:"_id"`
		Image *string       `bson:"image"`
		Name  *string       `bson:"name"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, u := range rows {
		name := "Member"
		if u.Name != nil {
			name = *u.Name
		}
		out[u.ID.Hex()] = author{u.Image, name}
	}
	return out, nil
}

func (h *Handler) hostelNames(ctx context.Context, ids []*bson.ObjectID) (map[string]string, error) {
	out := map[string]string{}
	want := bson.A{}
	for _, id := range ids {
		if id != nil {
			want = append(want, *id)
		}
	}
	if len(want) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: want}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name *string       `bson:"name"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, x := range rows {
		name := "Hostel"
		if x.Name != nil {
			name = *x.Name
		}
		out[x.ID.Hex()] = name
	}
	return out, nil
}

// decorate is decoratePosts: names, the viewer's reaction, and counts per type.
func (h *Handler) decorate(ctx context.Context, posts []post, p *authz.Principal) ([]ordered.Map, error) {
	ids, authors, hostels := bson.A{}, []*bson.ObjectID{}, []*bson.ObjectID{}
	for i := range posts {
		ids = append(ids, posts[i].ID)
		authors = append(authors, posts[i].AuthorID)
		hostels = append(hostels, posts[i].HostelID)
	}
	names, err := h.names(ctx, authors)
	if err != nil {
		return nil, err
	}
	hostelNames, err := h.hostelNames(ctx, hostels)
	if err != nil {
		return nil, err
	}
	viewer := map[string]string{}
	if p != nil {
		uid, err := httpx.OID(p.UserID, "user id")
		if err != nil {
			return nil, err
		}
		cur, err := h.DB.Collection("communityreactions").Find(ctx, bson.D{{Key: "postId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "userId", Value: uid}})
		if err != nil {
			return nil, err
		}
		var rows []struct {
			PostID bson.ObjectID `bson:"postId"`
			Type   string        `bson:"type"`
		}
		if err := cur.All(ctx, &rows); err != nil {
			return nil, err
		}
		for _, x := range rows {
			viewer[x.PostID.Hex()] = x.Type
		}
	}
	cur, err := h.DB.Collection("communityreactions").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "postId", Value: bson.D{{Key: "$in", Value: ids}}}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: bson.D{{Key: "postId", Value: "$postId"}, {Key: "type", Value: "$type"}}}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var tallies []struct {
		ID struct {
			PostID bson.ObjectID `bson:"postId"`
			Type   string        `bson:"type"`
		} `bson:"_id"`
		Count int `bson:"count"`
	}
	if err := cur.All(ctx, &tallies); err != nil {
		return nil, err
	}
	counts := map[string]ordered.Map{}
	for _, t := range tallies {
		key := t.ID.PostID.Hex()
		counts[key] = append(counts[key], ordered.Pair{Key: t.ID.Type, Value: t.Count})
	}
	out := make([]ordered.Map, len(posts))
	for i := range posts {
		x := &posts[i]
		var image any
		name := "Former member"
		mine := false
		if x.AuthorID != nil {
			name = "Member"
			if a, ok := names[x.AuthorID.Hex()]; ok {
				name = a.Name
				if a.Image != nil {
					image = *a.Image
				}
			}
			mine = p != nil && p.UserID == x.AuthorID.Hex()
		}
		var hostel, hostelName any
		if x.HostelID != nil {
			hostel = x.HostelID.Hex()
			hostelName = "Hostel"
			if n, ok := hostelNames[x.HostelID.Hex()]; ok {
				hostelName = n
			}
		}
		created := any(ordered.Undefined)
		if x.CreatedAt != nil {
			created = httpx.ISO(*x.CreatedAt)
		}
		var reaction any
		if v, ok := viewer[x.ID.Hex()]; ok {
			reaction = v
		}
		tally := counts[x.ID.Hex()]
		if tally == nil {
			tally = ordered.Map{}
		}
		out[i] = ordered.Map{{Key: "authorImage", Value: image}, {Key: "authorName", Value: name}, {Key: "body", Value: x.Body}, {Key: "commentCount", Value: x.CommentCount}, {Key: "createdAt", Value: created},
			{Key: "hostelId", Value: hostel}, {Key: "hostelName", Value: hostelName}, {Key: "id", Value: x.ID.Hex()}, {Key: "isAnnouncement", Value: x.IsAnnouncement}, {Key: "isMine", Value: mine}, {Key: "media", Value: x.media()},
			{Key: "reactionCount", Value: x.ReactionCount}, {Key: "reactionCounts", Value: tally}, {Key: "spaceType", Value: x.SpaceType}, {Key: "status", Value: x.Status}, {Key: "viewerReaction", Value: reaction}, {Key: "visibility", Value: x.Visibility}}
	}
	return out, nil
}

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

// readPage is paginationQuerySchema; a bad value is a validation issue.
func readPage(q map[string]string, is *valid.Issues) pagination.Query {
	out := pagination.Query{}
	read := func(key string, max float64) *int {
		v := valid.QueryNumber(q, key, false, is)
		if v == nil {
			return nil
		}
		n := *v
		if n != float64(int(n)) {
			is.Add(key, valid.Type("int", "number"))
			return nil
		}
		if n <= 0 {
			is.Add(key, valid.TooSmall("number", 0, false))
			return nil
		}
		if max > 0 && n > max {
			is.Add(key, valid.TooBig("number", max, true))
			return nil
		}
		i := int(n)
		return &i
	}
	out.Page = read("page", 0)
	out.PageSize = read("pageSize", pagination.MaxPageSize)
	return out
}

type feedOut struct {
	Pagination pagination.Meta `json:"pagination"`
	Posts      []ordered.Map   `json:"posts"`
}

func (h *Handler) feed(c *gin.Context) {
	p, err := h.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	var is valid.Issues
	page := readPage(q, &is)
	search := valid.QueryString(q, "q", 0, 120, &is)
	space := "all"
	if v, ok := q["space"]; ok {
		if v == "all" || v == "public" || v == "mine" || objectIDRe.MatchString(v) {
			space = v
		} else {
			is.Add("space", "Invalid object id.")
		}
	}
	sortBy := valid.QueryEnum(q, "sort", &is, "new", "top")
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	and := bson.A{bson.D{{Key: "status", Value: "VISIBLE"}}, readable(p)}
	switch space {
	case "public":
		and = append(and, bson.D{{Key: "spaceType", Value: "PUBLIC"}})
	case "mine":
		and = append(and, bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: viewerHostels(p)}}}})
	case "all":
		and = append(and, bson.D{})
	default:
		id, _ := bson.ObjectIDFromHex(space)
		and = append(and, bson.D{{Key: "hostelId", Value: id}})
	}
	if search != nil && valid.Trim(*search) != "" {
		and = append(and, bson.D{{Key: "body", Value: bson.Regex{Pattern: regexp.QuoteMeta(valid.Trim(*search)), Options: "i"}}})
	}
	filter := bson.D{{Key: "$and", Value: and}}
	order := bson.D{{Key: "isAnnouncement", Value: -1}}
	if sortBy != nil && *sortBy == "top" {
		order = append(order, bson.E{Key: "reactionCount", Value: -1}, bson.E{Key: "commentCount", Value: -1})
	}
	order = append(order, bson.E{Key: "createdAt", Value: -1})
	rng := pagination.RangeOf(page)
	coll := h.DB.Collection("communityposts")
	cur, err := coll.Find(c, filter, options.Find().SetSort(order).SetSkip(int64(rng.Skip)).SetLimit(int64(rng.Limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []post
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	total, err := coll.CountDocuments(c, filter)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	posts, err := h.decorate(c, rows, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, feedOut{pagination.MetaOf(page, int(total)), posts}, "Community feed loaded")
}

type postOut struct {
	Post ordered.Map `json:"post"`
}

// authorSpace is resolveAuthorSpace: a post lands in the author's first hostel, or public.
func authorSpace(p *authz.Principal) (*bson.ObjectID, string, error) {
	if len(p.HostelIDs) == 0 {
		return nil, "PUBLIC", nil
	}
	id, err := httpx.OID(p.HostelIDs[0], "hostel id")
	if err != nil {
		return nil, "", err
	}
	return &id, "HOSTEL", nil
}

func (h *Handler) create(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	text, _ := f.Str("body", valid.S{Trim: true, Min: 1, Max: 4000})
	public := "PUBLIC"
	visibility, _ := f.Enum("visibility", false, &public, "PUBLIC", "HOSTEL_ONLY")
	media := []mediaItem{}
	if list, ok := f.Array("media", false, true); ok {
		for i, raw := range list {
			m, isObj := raw.(map[string]any)
			if !isObj {
				f.Is.Add("media."+strconv.Itoa(i), valid.Type("object", valid.Received(raw, false)))
				continue
			}
			sub := &valid.Form{M: m}
			asset, _ := sub.Str("assetId", valid.S{Trim: true, Min: 1})
			kind, _ := sub.Enum("kind", false, nil, "IMAGE", "VIDEO")
			media = append(media, mediaItem{asset, kind})
			f.Join("media."+strconv.Itoa(i), sub)
		}
		f.Size("media", len(list), 0, 6, "", false)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostelID, spaceType, err := authorSpace(p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	filterOn := false
	if hostelID != nil {
		enabled, profanityOn := h.settings(c, *hostelID)
		if !enabled {
			httpx.Fail(c, httpx.NewError(403, "COMMUNITY_DISABLED", "The community feed is turned off for this hostel.", nil))
			return
		}
		filterOn = profanityOn
	}
	if filterOn {
		text = maskProfanity(text)
	}
	if spaceType == "PUBLIC" {
		visibility = "PUBLIC"
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := post{ID: bson.NewObjectID(), AuthorID: &uid, Body: text, CreatedAt: &now, HostelID: hostelID, Media: media, SpaceType: spaceType, Status: "VISIBLE", Visibility: visibility}
	var hostel any
	if hostelID != nil {
		hostel = *hostelID
	}
	stored := bson.A{}
	for _, m := range media {
		stored = append(stored, bson.D{{Key: "assetId", Value: m.AssetID}, {Key: "kind", Value: m.Kind}})
	}
	if _, err := h.DB.Collection("communityposts").InsertOne(c, bson.D{{Key: "_id", Value: row.ID}, {Key: "spaceType", Value: spaceType}, {Key: "hostelId", Value: hostel}, {Key: "authorId", Value: uid}, {Key: "body", Value: text}, {Key: "media", Value: stored},
		{Key: "visibility", Value: visibility}, {Key: "isAnnouncement", Value: false}, {Key: "status", Value: "VISIBLE"}, {Key: "reportCount", Value: 0}, {Key: "commentCount", Value: 0}, {Key: "reactionCount", Value: 0}, {Key: "isDemoData", Value: false},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	decorated, err := h.decorate(c, []post{row}, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.publish(c, &row)
	authorName, _ := decorated[0].Get("authorName")
	hostelName, _ := decorated[0].Get("hostelName")
	name, _ := authorName.(string)
	where, _ := hostelName.(string)
	userID := p.UserID
	notify := func(ctx context.Context) error {
		h.notifyNewPost(ctx, name, userID, text, hostelID, where, row.ID.Hex())
		return nil
	}
	if h.BG != nil {
		h.BG.After(c, notify)
	} else {
		_ = notify(c)
	}
	httpx.Write(c, 201, postOut{decorated[0]}, "Post published")
}

func (h *Handler) settings(ctx context.Context, hostelID bson.ObjectID) (enabled, profanityOn bool) {
	var row struct {
		Community struct {
			Enabled   *bool `bson:"enabled"`
			Profanity *bool `bson:"profanityFilterEnabled"`
		} `bson:"community"`
	}
	if err := h.DB.Collection("hostelsettings").FindOne(ctx, bson.D{{Key: "hostelId", Value: hostelID}}).Decode(&row); err != nil {
		return true, true
	}
	return row.Community.Enabled == nil || *row.Community.Enabled, row.Community.Profanity == nil || *row.Community.Profanity
}

const previewChars = 110

var runs = regexp.MustCompile(`\s+`)

func postPreview(body string) string {
	text := valid.Trim(runs.ReplaceAllString(body, " "))
	if valid.JSLen(text) > previewChars {
		return valid.JSPrefix(text, previewChars-1) + "…"
	}
	return text
}

// notifyNewPost is notifyHostelOfNewPost: staff, cooks and residents of the
// hostel, or every active account for a public post. A category mute stops the
// push, not the bell row.
func (h *Handler) notifyNewPost(ctx context.Context, authorName, authorID, body string, hostelID *bson.ObjectID, hostelName, postID string) {
	audience := []string{}
	if hostelID != nil {
		staff, err := residents.HostelStaffUserIDs(ctx, h.DB, *hostelID, false)
		if err != nil {
			return
		}
		audience = staff
		for _, q := range []struct {
			coll   string
			filter bson.D
		}{
			{"cookaccounts", bson.D{{Key: "hostelId", Value: *hostelID}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}}},
			{"residents", bson.D{{Key: "hostelId", Value: *hostelID}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}}},
		} {
			cur, err := h.DB.Collection(q.coll).Find(ctx, q.filter, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
			if err != nil {
				return
			}
			var rows []struct {
				UserID *bson.ObjectID `bson:"userId"`
			}
			if err := cur.All(ctx, &rows); err != nil {
				return
			}
			for _, x := range rows {
				if x.UserID != nil && !slices.Contains(audience, x.UserID.Hex()) {
					audience = append(audience, x.UserID.Hex())
				}
			}
		}
	} else {
		cur, err := h.DB.Collection("users").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
		if err != nil {
			return
		}
		var rows []struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cur.All(ctx, &rows); err != nil {
			return
		}
		for _, x := range rows {
			audience = append(audience, x.ID.Hex())
		}
	}
	recipients := slices.DeleteFunc(audience, func(id string) bool { return id == authorID })
	muted := map[string]bool{}
	ids := bson.A{}
	for _, id := range recipients {
		if oid, err := bson.ObjectIDFromHex(id); err == nil {
			ids = append(ids, oid)
		}
	}
	if cur, err := h.DB.Collection("notificationpreferences").Find(ctx, bson.D{{Key: "mutedCategories", Value: "COMMUNITY_POST"}, {Key: "userId", Value: bson.D{{Key: "$in", Value: ids}}}}); err == nil {
		var rows []struct {
			UserID bson.ObjectID `bson:"userId"`
		}
		if cur.All(ctx, &rows) == nil {
			for _, x := range rows {
				muted[x.UserID.Hex()] = true
			}
		}
	}
	hostel := ""
	if hostelID != nil {
		hostel = hostelID.Hex()
	}
	for _, id := range recipients {
		_, _ = h.Notify.CreateInApp(ctx, notifications.Input{Body: postPreview(body), Category: "COMMUNITY", Data: ordered.Map{{Key: "postId", Value: postID}}, HostelID: hostel, NoPush: muted[id], Priority: "NORMAL", Title: authorName + " posted", UserID: id})
	}
}

func errPost() error { return httpx.NewError(404, "POST_NOT_FOUND", "Post was not found.", nil) }

func (h *Handler) readablePost(c *gin.Context, p *authz.Principal) (*post, error) {
	id, err := httpx.OID(c.Param("postId"), "post id")
	if err != nil {
		return nil, err
	}
	var row post
	err = h.DB.Collection("communityposts").FindOne(c, bson.D{{Key: "$and", Value: bson.A{bson.D{{Key: "_id", Value: id}, {Key: "status", Value: "VISIBLE"}}, readable(p)}}}).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return nil, errPost()
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (h *Handler) get(c *gin.Context) {
	p, err := h.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := h.readablePost(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.decorate(c, []post{*row}, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, postOut{out[0]}, "Post loaded")
}

type removedPost struct {
	PostID string `json:"postId"`
	Status string `json:"status"`
}

func (h *Handler) remove(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("postId"), "post id")
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
	var row post
	err = h.DB.Collection("communityposts").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "authorId", Value: uid}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "hiddenAt", Value: now}, {Key: "hiddenReason", Value: "Removed by author"}, {Key: "status", Value: "HIDDEN"}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&row)
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, errPost())
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.publish(c, &row)
	httpx.OK(c, removedPost{c.Param("postId"), "HIDDEN"}, "Post deleted")
}

// --- comments -------------------------------------------------------------------

type commentRow struct {
	ID        bson.ObjectID  `bson:"_id"`
	AuthorID  *bson.ObjectID `bson:"authorId"`
	Body      string         `bson:"body"`
	CreatedAt *time.Time     `bson:"createdAt"`
	ParentID  *bson.ObjectID `bson:"parentId"`
	PostID    bson.ObjectID  `bson:"postId"`
	Score     int            `bson:"score"`
	Status    string         `bson:"status"`
}

func serializeComment(x *commentRow, a *author, viewer string, vote int) ordered.Map {
	var image any
	name := "Former member"
	mine := false
	if x.AuthorID != nil {
		name = "Member"
		if a != nil {
			name = a.Name
			if a.Image != nil {
				image = *a.Image
			}
		}
		mine = viewer == x.AuthorID.Hex()
	}
	created := any(ordered.Undefined)
	if x.CreatedAt != nil {
		created = httpx.ISO(*x.CreatedAt)
	}
	var parent any
	if x.ParentID != nil {
		parent = x.ParentID.Hex()
	}
	return ordered.Map{{Key: "authorImage", Value: image}, {Key: "authorName", Value: name}, {Key: "body", Value: x.Body}, {Key: "createdAt", Value: created}, {Key: "id", Value: x.ID.Hex()},
		{Key: "isDeleted", Value: false}, {Key: "isMine", Value: mine}, {Key: "parentId", Value: parent}, {Key: "score", Value: x.Score}, {Key: "viewerVote", Value: vote}}
}

type commentsOut struct {
	Comments   []ordered.Map   `json:"comments"`
	Pagination pagination.Meta `json:"pagination"`
}

func (h *Handler) comments(c *gin.Context) {
	p, err := h.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var is valid.Issues
	page := readPage(valid.Query(c), &is)
	if err := is.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := h.readablePost(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	size := pagination.MaxPageSize
	cur, err := h.DB.Collection("communitycomments").Find(c, bson.D{{Key: "postId", Value: row.ID}}, options.Find().SetSort(bson.D{{Key: "score", Value: -1}, {Key: "createdAt", Value: 1}}).SetLimit(int64(size)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []commentRow
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := []*bson.ObjectID{}
	for i := range rows {
		ids = append(ids, rows[i].AuthorID)
	}
	names, err := h.names(c, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	votes := map[string]int{}
	viewer := ""
	if p != nil {
		viewer = p.UserID
		uid, err := httpx.OID(p.UserID, "user id")
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		cur, err := h.DB.Collection("communitycommentvotes").Find(c, bson.D{{Key: "postId", Value: row.ID}, {Key: "userId", Value: uid}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var vs []struct {
			CommentID bson.ObjectID `bson:"commentId"`
			Value     int           `bson:"value"`
		}
		if err := cur.All(c, &vs); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, v := range vs {
			votes[v.CommentID.Hex()] = v.Value
		}
	}
	byParent := map[string][]*commentRow{}
	for i := range rows {
		key := "root"
		if rows[i].ParentID != nil {
			key = rows[i].ParentID.Hex()
		}
		byParent[key] = append(byParent[key], &rows[i])
	}
	live := map[string]bool{}
	var hasLive func(string) bool
	hasLive = func(id string) bool {
		if v, ok := live[id]; ok {
			return v
		}
		result := false
		for _, reply := range byParent[id] {
			if reply.Status == "VISIBLE" || hasLive(reply.ID.Hex()) {
				result = true
				break
			}
		}
		live[id] = result
		return result
	}
	out := []ordered.Map{}
	var walk func(string, int)
	walk = func(parent string, depth int) {
		for _, x := range byParent[parent] {
			id := x.ID.Hex()
			deleted := x.Status != "VISIBLE"
			if deleted && !hasLive(id) {
				continue
			}
			var line ordered.Map
			if deleted {
				blank := *x
				blank.AuthorID, blank.Body, blank.Score = nil, "", 0
				line = serializeComment(&blank, nil, "", 0).Set("authorName", "Deleted").Set("isDeleted", true)
			} else {
				var a *author
				if x.AuthorID != nil {
					if v, ok := names[x.AuthorID.Hex()]; ok {
						a = &v
					}
				}
				line = serializeComment(x, a, viewer, votes[id])
			}
			out = append(out, append(line, ordered.Pair{Key: "depth", Value: min(depth, 5)}))
			walk(id, depth+1)
		}
	}
	walk("root", 0)
	meta := page
	meta.PageSize = &size
	httpx.OK(c, commentsOut{out, pagination.MetaOf(meta, len(out))}, "Comments loaded")
}

type commentOut struct {
	Comment ordered.Map `json:"comment"`
}

func (h *Handler) comment(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	text, _ := f.Str("body", valid.S{Trim: true, Min: 1, Max: 2000})
	parent := ""
	if v, present := f.M["parentId"]; present {
		parent, _ = valid.ObjectID(v, "parentId", "", &f.Is, false)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := h.readablePost(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	coll := h.DB.Collection("communitycomments")
	var parentID *bson.ObjectID
	var parentAuthor *bson.ObjectID
	if parent != "" {
		id, _ := bson.ObjectIDFromHex(parent)
		var pr commentRow
		err := coll.FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "postId", Value: row.ID}, {Key: "status", Value: "VISIBLE"}}).Decode(&pr)
		if err == mongo.ErrNoDocuments {
			httpx.Fail(c, httpx.NewError(404, "COMMENT_NOT_FOUND", "The comment you replied to was not found.", nil))
			return
		}
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		parentID, parentAuthor = &pr.ID, pr.AuthorID
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	x := commentRow{ID: bson.NewObjectID(), AuthorID: &uid, Body: maskProfanity(text), CreatedAt: &now, ParentID: parentID, PostID: row.ID, Status: "VISIBLE"}
	var hostel, parentVal any
	if row.HostelID != nil {
		hostel = *row.HostelID
	}
	if parentID != nil {
		parentVal = *parentID
	}
	if _, err := coll.InsertOne(c, bson.D{{Key: "_id", Value: x.ID}, {Key: "postId", Value: row.ID}, {Key: "parentId", Value: parentVal}, {Key: "score", Value: 0}, {Key: "hostelId", Value: hostel}, {Key: "authorId", Value: uid}, {Key: "body", Value: x.Body},
		{Key: "status", Value: "VISIBLE"}, {Key: "isDemoData", Value: false}, {Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.DB.Collection("communityposts").UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "commentCount", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	recipient := row.AuthorID
	bodyText, title := "Someone commented on your community post.", "New comment"
	if parentID != nil {
		recipient, bodyText, title = parentAuthor, "Someone replied to your comment.", "New reply"
	}
	if recipient != nil && recipient.Hex() != p.UserID {
		hostelHex := ""
		if row.HostelID != nil {
			hostelHex = row.HostelID.Hex()
		}
		_, _ = h.Notify.CreateInApp(c, notifications.Input{Body: bodyText, Category: "COMMUNITY", Data: ordered.Map{{Key: "postId", Value: row.ID.Hex()}}, HostelID: hostelHex, Title: title, UserID: recipient.Hex()})
	}
	names, err := h.names(c, []*bson.ObjectID{&uid})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.publish(c, row)
	var a *author
	if v, ok := names[uid.Hex()]; ok {
		a = &v
	}
	httpx.Write(c, 201, commentOut{serializeComment(&x, a, p.UserID, 0)}, "Comment added")
}

func errComment() error {
	return httpx.NewError(404, "COMMENT_NOT_FOUND", "Comment was not found.", nil)
}

type removedComment struct {
	CommentID string `json:"commentId"`
	Status    string `json:"status"`
}

func (h *Handler) removeComment(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := h.readablePost(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("commentId"), "comment id")
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
	res, err := h.DB.Collection("communitycomments").UpdateOne(c, bson.D{{Key: "_id", Value: id}, {Key: "authorId", Value: uid}, {Key: "postId", Value: row.ID}, {Key: "status", Value: "VISIBLE"}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "hiddenAt", Value: now}, {Key: "hiddenBy", Value: uid}, {Key: "status", Value: "HIDDEN"}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MatchedCount == 0 {
		httpx.Fail(c, errComment())
		return
	}
	if _, err := h.DB.Collection("communityposts").UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}, {Key: "commentCount", Value: bson.D{{Key: "$gt", Value: 0}}}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "commentCount", Value: -1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.publish(c, row)
	httpx.OK(c, removedComment{c.Param("commentId"), "HIDDEN"}, "Comment deleted")
}

type voted struct {
	CommentID  string `json:"commentId"`
	Score      int    `json:"score"`
	ViewerVote int    `json:"viewerVote"`
}

func (h *Handler) vote(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	value := 0
	if f.M != nil {
		v, ok := f.M["value"].(float64)
		if !ok || v != -1 && v != 0 && v != 1 {
			f.Is.Add("value", "Invalid input")
		}
		value = int(v)
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := h.readablePost(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := httpx.OID(c.Param("commentId"), "comment id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	comments := h.DB.Collection("communitycomments")
	err = comments.FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "postId", Value: row.ID}, {Key: "status", Value: "VISIBLE"}}).Err()
	if err == mongo.ErrNoDocuments {
		httpx.Fail(c, errComment())
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
	votes := h.DB.Collection("communitycommentvotes")
	now := time.Now().UTC().Truncate(time.Millisecond)
	if value == 0 {
		_, err = votes.DeleteOne(c, bson.D{{Key: "commentId", Value: id}, {Key: "userId", Value: uid}})
	} else {
		_, err = votes.UpdateOne(c, bson.D{{Key: "commentId", Value: id}, {Key: "userId", Value: uid}},
			bson.D{{Key: "$set", Value: bson.D{{Key: "postId", Value: row.ID}, {Key: "value", Value: value}, {Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "isDemoData", Value: false}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
			options.UpdateOne().SetUpsert(true))
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := votes.Aggregate(c, bson.A{bson.D{{Key: "$match", Value: bson.D{{Key: "commentId", Value: id}}}}, bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: nil}, {Key: "score", Value: bson.D{{Key: "$sum", Value: "$value"}}}}}}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var totals []struct {
		Score int `bson:"score"`
	}
	if err := cur.All(c, &totals); err != nil {
		httpx.Fail(c, err)
		return
	}
	score := 0
	if len(totals) > 0 {
		score = totals[0].Score
	}
	if _, err := comments.UpdateOne(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "score", Value: score}, {Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, voted{c.Param("commentId"), score, value}, "Vote saved")
}

// --- reactions and reports -------------------------------------------------------

type reacted struct {
	Reaction any `json:"reaction"`
}

func (h *Handler) react(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	kind, _ := f.Enum("type", false, nil, "LIKE", "LOVE", "LAUGH", "SAD", "ANGRY", "SUPPORT")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := h.readablePost(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	reactions := h.DB.Collection("communityreactions")
	posts := h.DB.Collection("communityposts")
	now := time.Now().UTC().Truncate(time.Millisecond)
	var existing struct {
		ID   bson.ObjectID `bson:"_id"`
		Type string        `bson:"type"`
	}
	err = reactions.FindOne(c, bson.D{{Key: "postId", Value: row.ID}, {Key: "userId", Value: uid}}).Decode(&existing)
	found := err == nil
	if err != nil && err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	if found && existing.Type == kind {
		if _, err := reactions.DeleteOne(c, bson.D{{Key: "_id", Value: existing.ID}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		if _, err := posts.UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "reactionCount", Value: -1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		h.publish(c, row)
		httpx.OK(c, reacted{nil}, "Reaction saved")
		return
	}
	var hostel any
	if row.HostelID != nil {
		hostel = *row.HostelID
	}
	if _, err := reactions.UpdateOne(c, bson.D{{Key: "postId", Value: row.ID}, {Key: "userId", Value: uid}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "hostelId", Value: hostel}, {Key: "type", Value: kind}, {Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "isDemoData", Value: false}, {Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
		options.UpdateOne().SetUpsert(true)); err != nil {
		httpx.Fail(c, err)
		return
	}
	if !found {
		if _, err := posts.UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "reactionCount", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
		h.notifyReaction(c, row, p.UserID)
	}
	h.publish(c, row)
	httpx.OK(c, reacted{kind}, "Reaction saved")
}

func (h *Handler) notifyReaction(ctx context.Context, row *post, actor string) {
	if row.AuthorID == nil || row.AuthorID.Hex() == actor {
		return
	}
	n, err := h.DB.Collection("communityreactions").CountDocuments(ctx, bson.D{{Key: "postId", Value: row.ID}})
	if err != nil {
		return
	}
	text := "Someone reacted to your community post."
	if n != 1 {
		text = strconv.FormatInt(n, 10) + " people reacted to your community post."
	}
	hostel := ""
	if row.HostelID != nil {
		hostel = row.HostelID.Hex()
	}
	_ = h.Notify.CreateOrUpdateBatched(ctx, notifications.BatchedInput{Body: text, Category: "COMMUNITY",
		Data: ordered.Map{{Key: "postId", Value: row.ID.Hex()}, {Key: "reactionCount", Value: n}}, DedupeKey: "community-reaction:" + row.ID.Hex(), HostelID: hostel, Title: "New reaction", UserID: row.AuthorID.Hex()})
}

type reported struct {
	Reported bool `json:"reported"`
}

const reportQueueThreshold = 3

func (h *Handler) report(c *gin.Context) {
	p, err := h.Guards.Require(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	reason, _ := f.Str("reason", valid.S{Trim: true, Min: 3, Max: 500})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	row, err := h.readablePost(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	uid, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	reports := h.DB.Collection("communityreports")
	err = reports.FindOne(c, bson.D{{Key: "postId", Value: row.ID}, {Key: "reportedBy", Value: uid}}).Err()
	if err == nil {
		httpx.Write(c, 201, reported{true}, "Report submitted")
		return
	}
	if err != mongo.ErrNoDocuments {
		httpx.Fail(c, err)
		return
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var hostel any
	if row.HostelID != nil {
		hostel = *row.HostelID
	}
	if _, err := reports.InsertOne(c, bson.D{{Key: "postId", Value: row.ID}, {Key: "hostelId", Value: hostel}, {Key: "reportedBy", Value: uid}, {Key: "reason", Value: reason}, {Key: "status", Value: "OPEN"},
		{Key: "createdAt", Value: now}, {Key: "updatedAt", Value: now}, {Key: "__v", Value: 0}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.DB.Collection("communityposts").UpdateOne(c, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "reportCount", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	if row.FlaggedAt == nil {
		if err := h.queueIfWarranted(c, row, row.ReportCount+1); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	httpx.Write(c, 201, reported{true}, "Report submitted")
}

func (h *Handler) flag(ctx context.Context, row *post, reason string) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	_, err := h.DB.Collection("communityposts").UpdateOne(ctx, bson.D{{Key: "_id", Value: row.ID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "flaggedAt", Value: now}, {Key: "flaggedReason", Value: reason}, {Key: "updatedAt", Value: now}}}})
	return err
}

const triageSystem = "You are a content moderator for a student hostel community app in Nepal. " +
	"You judge whether a reported post plausibly breaks the rules. You are " +
	"conservative: disagreement, criticism of a hostel, complaints, and blunt " +
	"language are all allowed."

func (h *Handler) queueIfWarranted(ctx context.Context, row *post, count int) error {
	if count >= reportQueueThreshold {
		return h.flag(ctx, row, "Reported by "+strconv.Itoa(count)+" people.")
	}
	if h.LLM == nil || !h.LLM.Configured() {
		return nil
	}
	cur, err := h.DB.Collection("communityreports").Find(ctx, bson.D{{Key: "postId", Value: row.ID}}, options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(5))
	if err != nil {
		return nil // a triage failure never fails the report
	}
	var reasons []struct {
		Reason string `bson:"reason"`
	}
	if cur.All(ctx, &reasons) != nil {
		return nil
	}
	lines := []string{"A post was reported. Decide whether a human moderator should review it.", "", "POST:", valid.JSPrefix(row.Body, 2000), "", "REPORT REASONS:"}
	for _, x := range reasons {
		lines = append(lines, "- "+valid.JSPrefix(x.Reason, 300))
	}
	lines = append(lines, "", `Answer with JSON only: { "shouldQueue": boolean, "reason": string }`, "", "Rules:",
		"- shouldQueue true only for: harassment or threats of a named person,", "  hate speech, sexual content, doxxing, scams, or spam advertising.",
		"- A negative opinion about a hostel, its food, or its staff is NOT a", "  reason to queue. Neither is bad grammar, a joke, or a heated argument.",
		"- If the report reasons look like retaliation against an opinion, answer", "  false.",
		"- reason: one short sentence, max 120 characters, naming the rule at stake.")
	zero := 0.0
	raw := h.LLM.Generate(ctx, strings.Join(lines, "\n"), llm.Options{JSON: true, MaxTokens: 200, SystemPrompt: triageSystem, Temperature: &zero})
	if valid.Trim(raw) == "" {
		return nil
	}
	parsed, ok := llm.ParseModelJSON(raw, "triageReportedPost")
	if !ok {
		return nil
	}
	m, _ := parsed.(map[string]any)
	queue, isBool := m["shouldQueue"].(bool)
	if !isBool || !queue {
		return nil
	}
	reason, _ := m["reason"].(string)
	reason = valid.JSPrefix(valid.Trim(reason), 120)
	if reason == "" {
		reason = "Flagged by automated review."
	}
	_ = h.flag(ctx, row, reason)
	return nil
}

// --- spaces, sidebar, sponsors ---------------------------------------------------

type spaceOut struct {
	ID        string `json:"id"`
	IsMine    bool   `json:"isMine"`
	Name      string `json:"name"`
	PostCount int64  `json:"postCount"`
}

type viewerOut struct {
	CanPost    bool `json:"canPost"`
	HostelID   any  `json:"hostelId"`
	HostelName any  `json:"hostelName"`
	SpaceType  any  `json:"spaceType"`
}

type spacesOut struct {
	Spaces []spaceOut `json:"spaces"`
	Viewer viewerOut  `json:"viewer"`
}

func (h *Handler) spaces(c *gin.Context) {
	p, err := h.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	viewer := viewerOut{CanPost: p != nil}
	if p != nil {
		id, kind, err := authorSpace(p)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		viewer.SpaceType = kind
		if id != nil {
			names, err := h.hostelNames(c, []*bson.ObjectID{id})
			if err != nil {
				httpx.Fail(c, err)
				return
			}
			name, ok := names[id.Hex()]
			if !ok {
				name = "Hostel"
			}
			viewer.HostelID, viewer.HostelName = id.Hex(), name
		}
	}
	coll := h.DB.Collection("communityposts")
	cur, err := coll.Aggregate(c, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "$and", Value: bson.A{bson.D{{Key: "status", Value: "VISIBLE"}}, readable(p), bson.D{{Key: "spaceType", Value: "HOSTEL"}}}}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$hostelId"}, {Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}}}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}},
		bson.D{{Key: "$limit", Value: 50}},
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID    *bson.ObjectID `bson:"_id"`
		Count int64          `bson:"count"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	ids := []*bson.ObjectID{}
	for i := range rows {
		ids = append(ids, rows[i].ID)
	}
	names, err := h.hostelNames(c, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	public, err := coll.CountDocuments(c, bson.D{{Key: "spaceType", Value: "PUBLIC"}, {Key: "status", Value: "VISIBLE"}})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := spacesOut{[]spaceOut{{"public", false, "Public", public}}, viewer}
	for _, x := range rows {
		id := "public"
		mine := false
		name := "Hostel"
		if x.ID != nil {
			id = x.ID.Hex()
			mine = p != nil && slices.Contains(p.HostelIDs, id)
			if n, ok := names[id]; ok {
				name = n
			}
		}
		out.Spaces = append(out.Spaces, spaceOut{id, mine, name, x.Count})
	}
	httpx.OK(c, out, "Community spaces loaded")
}

type sponsorOut struct {
	AccentColor string `json:"accentColor"`
	CtaLabel    string `json:"ctaLabel"`
	Highlight   string `json:"highlight"`
	ID          string `json:"id"`
	ImageAsset  string `json:"imageAssetId"`
	ImageURL    string `json:"imageUrl"`
	Kind        string `json:"kind,omitempty"`
	LinkURL     string `json:"linkUrl"`
	Name        string `json:"name"`
	Subtitle    string `json:"subtitle"`
}

func (h *Handler) liveSponsors(c *gin.Context) ([]sponsorOut, error) {
	now := time.Now()
	filter := bson.D{{Key: "$and", Value: bson.A{
		bson.D{{Key: "isActive", Value: true}},
		bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "startsAt", Value: bson.D{{Key: "$lte", Value: now}}}}, bson.D{{Key: "startsAt", Value: nil}}}}},
		bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "endsAt", Value: bson.D{{Key: "$gte", Value: now}}}}, bson.D{{Key: "endsAt", Value: nil}}}}},
	}}}
	coll := h.DB.Collection("sponsors")
	cur, err := coll.Find(c, filter, options.Find().SetSort(bson.D{{Key: "priority", Value: -1}, {Key: "createdAt", Value: -1}}).SetLimit(4))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID          bson.ObjectID `bson:"_id"`
		AccentColor *string       `bson:"accentColor"`
		CtaLabel    *string       `bson:"ctaLabel"`
		Highlight   string        `bson:"highlight"`
		ImageAsset  string        `bson:"imageAssetId"`
		ImageURL    string        `bson:"imageUrl"`
		Kind        string        `bson:"kind"`
		LinkURL     string        `bson:"linkUrl"`
		Name        string        `bson:"name"`
		Subtitle    string        `bson:"subtitle"`
	}
	if err := cur.All(c, &rows); err != nil {
		return nil, err
	}
	out := []sponsorOut{}
	ids := bson.A{}
	for _, x := range rows {
		accent, cta := "#0a8a4b", "View"
		if x.AccentColor != nil {
			accent = *x.AccentColor
		}
		if x.CtaLabel != nil {
			cta = *x.CtaLabel
		}
		ids = append(ids, x.ID)
		out = append(out, sponsorOut{accent, cta, x.Highlight, x.ID.Hex(), x.ImageAsset, x.ImageURL, x.Kind, x.LinkURL, x.Name, x.Subtitle})
	}
	if len(ids) > 0 && h.BG != nil {
		// Every sponsor shown gets its count. TS used updateOne, so only the first did.
		h.BG.After(c, func(ctx context.Context) error {
			_, err := coll.UpdateMany(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "impressionCount", Value: 1}}}})
			return err
		})
	}
	return out, nil
}

var hashTag = regexp.MustCompile(`#[\p{L}\p{N}_]{2,30}`)

type tagCount struct {
	Count int    `json:"count"`
	Tag   string `json:"tag"`
}

func (h *Handler) trendingTags(ctx context.Context, p *authz.Principal) ([]tagCount, error) {
	cur, err := h.DB.Collection("communityposts").Find(ctx, bson.D{{Key: "$and", Value: bson.A{bson.D{{Key: "status", Value: "VISIBLE"}}, readable(p)}}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(200).SetProjection(bson.D{{Key: "body", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Body string `bson:"body"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, x := range rows {
		seen := map[string]bool{}
		for _, tag := range hashTag.FindAllString(x.Body, -1) {
			seen[strings.ToLower(tag)] = true
		}
		for tag := range seen {
			counts[tag]++
		}
	}
	out := make([]tagCount, 0, len(counts))
	for tag, n := range counts {
		out = append(out, tagCount{n, tag})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	if len(out) > 6 {
		out = out[:6]
	}
	return out, nil
}

type popularHostel struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Rating *float64 `json:"rating"`
	Slug   string   `json:"slug"`
}

func (h *Handler) popular(ctx context.Context) ([]popularHostel, error) {
	cur, err := h.DB.Collection("hostels").Find(ctx, bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "PUBLISHED"}},
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(25).SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "slug", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID   bson.ObjectID `bson:"_id"`
		Name *string       `bson:"name"`
		Slug string        `bson:"slug"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := []popularHostel{}
	if len(rows) == 0 {
		return out, nil
	}
	ids := bson.A{}
	for _, x := range rows {
		ids = append(ids, x.ID)
	}
	cur, err = h.DB.Collection("ratingreviews").Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "hostelId", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "status", Value: "VISIBLE"}}}},
		bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$hostelId"}, {Key: "average", Value: bson.D{{Key: "$avg", Value: "$overallRating"}}}}}},
	})
	if err != nil {
		return nil, err
	}
	var ratings []struct {
		ID      bson.ObjectID `bson:"_id"`
		Average float64       `bson:"average"`
	}
	if err := cur.All(ctx, &ratings); err != nil {
		return nil, err
	}
	avg := map[string]float64{}
	for _, x := range ratings {
		avg[x.ID.Hex()] = x.Average
	}
	for _, x := range rows {
		name := "Hostel"
		if x.Name != nil {
			name = *x.Name
		}
		var rating *float64
		if a, ok := avg[x.ID.Hex()]; ok && a != 0 {
			v, _ := strconv.ParseFloat(strconv.FormatFloat(a, 'f', 1, 64), 64)
			rating = &v
		}
		out = append(out, popularHostel{x.ID.Hex(), name, rating, x.Slug})
	}
	val := func(p popularHostel) float64 {
		if p.Rating == nil {
			return 0
		}
		return *p.Rating
	}
	sort.SliceStable(out, func(i, j int) bool { return val(out[i]) > val(out[j]) })
	if len(out) > 4 {
		out = out[:4]
	}
	return out, nil
}

type sidebarOut struct {
	PopularHostels []popularHostel `json:"popularHostels"`
	Sponsors       []sponsorOut    `json:"sponsors"`
	TrendingTags   []tagCount      `json:"trendingTags"`
}

func (h *Handler) sidebar(c *gin.Context) {
	p, err := h.Guards.Load(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	sponsors, err := h.liveSponsors(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	tags, err := h.trendingTags(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	popular, err := h.popular(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, sidebarOut{popular, sponsors, tags}, "Community sidebar loaded")
}

type recorded struct {
	Recorded bool `json:"recorded"`
}

func (h *Handler) sponsorClick(c *gin.Context) {
	id, err := httpx.OID(c.Param("sponsorId"), "sponsor id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.DB.Collection("sponsors").UpdateOne(c, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$inc", Value: bson.D{{Key: "clickCount", Value: 1}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: time.Now().UTC()}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, recorded{true}, "Click recorded")
}
