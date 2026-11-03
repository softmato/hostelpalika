package team

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	appmongo "github.com/softmato/hostelpalika/server/internal/platform/mongo"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// The hostel agreement track sheet: registration-track-sheet(.service).ts.

var sheetRun = bson.D{{Key: "fiscalYear", Value: "LIFETIME"}, {Key: "kind", Value: "HOSTEL_AGREEMENT"}}

type agreementRow struct {
	ID         bson.ObjectID  `bson:"_id"`
	CreatedBy  *bson.ObjectID `bson:"createdBy"`
	HostelName string         `bson:"hostelName"`
	Location   *string        `bson:"location"`
	Notes      *string        `bson:"notes"`
	OwnerName  *string        `bson:"ownerName"`
	Phone      *string        `bson:"phone"`
	RefCode    string         `bson:"refCode"`
	SignedOn   time.Time      `bson:"signedOn"`
	Status     string         `bson:"status"`
}

// agreementRef is SMT/HP/<Gregorian year of the Nepal day>/007.
func agreementRef(seq int, now time.Time) string {
	y, _, _ := bs.DayParts(now)
	return fmt.Sprintf("SMT/HP/%d/%03d", y, seq)
}

func (h *Handler) sheetView(ctx context.Context, p *authz.Principal) (ordered.Map, error) {
	rows, err := findAll[agreementRow](ctx, h.col("hostelagreements"), bson.D{{Key: "deletedAt", Value: nil}}, options.Find().SetSort(bson.D{{Key: "sequence", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var run struct {
		Sequence int `bson:"sequence"`
	}
	_ = h.col("platformdocumentsequences").FindOne(ctx, sheetRun).Decode(&run) // none yet is sequence 0
	viewer, _ := bson.ObjectIDFromHex(p.UserID)
	ids := bson.A{viewer}
	for _, r := range rows {
		if r.CreatedBy != nil {
			ids = append(ids, *r.CreatedBy)
		}
	}
	users, err := findAll[struct {
		ID   bson.ObjectID `bson:"_id"`
		Name string        `bson:"name"`
	}](ctx, h.col("users"), bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	names := map[bson.ObjectID]string{}
	for _, u := range users {
		names[u.ID] = u.Name
	}
	out := make([]ordered.Map, len(rows))
	for i, r := range rows {
		by, mine := "", false
		if r.CreatedBy != nil {
			by, mine = names[*r.CreatedBy], *r.CreatedBy == viewer
		}
		out[i] = ordered.Map{{Key: "canEdit", Value: p.Role == authz.Superadmin || mine}, {Key: "hostelName", Value: r.HostelName}, {Key: "id", Value: r.ID.Hex()},
			{Key: "location", Value: str(r.Location, "")}, {Key: "notes", Value: str(r.Notes, "")}, {Key: "ownerName", Value: str(r.OwnerName, "")}, {Key: "phone", Value: str(r.Phone, "")},
			{Key: "refCode", Value: r.RefCode}, {Key: "signedBy", Value: by}, {Key: "signedOn", Value: httpx.ISO(r.SignedOn)}, {Key: "status", Value: r.Status}}
	}
	return ordered.Map{{Key: "nextSequence", Value: run.Sequence + 1}, {Key: "rows", Value: out}, {Key: "you", Value: names[viewer]}}, nil
}

func (h *Handler) trackSheet(c *gin.Context) {
	out, err := h.sheetView(c, authz.From(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Track sheet loaded")
}

var objectIDRe = regexp.MustCompile(`(?i)^[a-f\d]{24}$`)

type sheetLine struct {
	id     *bson.ObjectID
	fields bson.D
}

func readSheet(body any) ([]sheetLine, []bson.ObjectID, error) {
	f := valid.NewForm(body)
	var removed []bson.ObjectID
	if arr, ok := f.Array("removed", false, true); ok {
		f.Size("removed", len(arr), 0, 500, "", false)
		for i, v := range arr {
			s, isStr := v.(string)
			if !isStr || !objectIDRe.MatchString(s) {
				f.Is.Add("removed."+strconv.Itoa(i), "Invalid string: must match pattern /^[a-f\\d]{24}$/i")
				continue
			}
			id, _ := bson.ObjectIDFromHex(s)
			removed = append(removed, id)
		}
	}
	var lines []sheetLine
	if arr, ok := f.Array("rows", false, false); ok {
		f.Size("rows", len(arr), 0, 500, "", false)
		for i, raw := range arr {
			sub := valid.NewForm(raw)
			var l sheetLine
			if v, ok := sub.Str("id", valid.S{Opt: true, Re: objectIDRe, ReSrc: `/^[a-f\d]{24}$/i`}); ok {
				id, _ := bson.ObjectIDFromHex(v)
				l.id = &id
			}
			name, _ := sub.Str("hostelName", valid.S{Trim: true, Min: 1, MinMsg: "Write the hostel name.", Max: 160})
			text := func(k string, max int) string {
				if !sub.Present(k) {
					return ""
				}
				v, _ := sub.Str(k, valid.S{Trim: true, Max: max})
				return v
			}
			loc, notes, owner, phone := text("location", 160), text("notes", 500), text("ownerName", 120), text("phone", 24)
			var signed time.Time
			switch v := sub.M["signedOn"].(type) {
			case string:
				t, err := time.Parse(time.RFC3339Nano, v)
				if err != nil {
					t, err = time.Parse("2006-01-02", v)
				}
				if err != nil {
					sub.Is.Add("signedOn", "Invalid input: expected date, received Date")
				}
				signed = t
			case float64:
				signed = time.UnixMilli(int64(v)).UTC()
			default:
				sub.Is.Add("signedOn", "Invalid input: expected date, received Date")
			}
			status, _ := sub.Enum("status", false, nil, "SIGNED", "ACTIVE", "ENDED")
			f.Join("rows."+strconv.Itoa(i), sub)
			l.fields = bson.D{{Key: "hostelName", Value: name}, {Key: "location", Value: loc}, {Key: "notes", Value: notes}, {Key: "ownerName", Value: owner},
				{Key: "phone", Value: phone}, {Key: "signedOn", Value: signed.UTC()}, {Key: "status", Value: status}}
			lines = append(lines, l)
		}
	}
	return lines, removed, f.Err()
}

// saveTrackSheet: updates, soft deletes and new lines (numbered off one run)
// in one transaction; an agent may only touch lines they signed.
func (h *Handler) saveTrackSheet(c *gin.Context) {
	p := authz.From(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	lines, removed, err := readSheet(body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	by, _ := bson.ObjectIDFromHex(p.UserID)
	now := h.Now().UTC().Truncate(time.Millisecond)
	own := bson.D{}
	if p.Role != authz.Superadmin {
		own = bson.D{{Key: "createdBy", Value: by}}
	}
	touched := bson.A{}
	for _, l := range lines {
		if l.id != nil {
			touched = append(touched, *l.id)
		}
	}
	for _, id := range removed {
		touched = append(touched, id)
	}
	coll := h.col("hostelagreements")
	if p.Role != authz.Superadmin && len(touched) > 0 {
		n, err := coll.CountDocuments(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: touched}}}, {Key: "createdBy", Value: bson.D{{Key: "$ne", Value: by}}}})
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		if n > 0 {
			httpx.Fail(c, httpx.NewError(403, "AGREEMENT_NOT_YOURS", "Only a superadmin or the team member who signed a line can change it.", nil))
			return
		}
	}
	err = appmongo.InTx(c, h.DB, func(ctx context.Context) error {
		var creates []sheetLine
		for _, l := range lines {
			if l.id == nil {
				creates = append(creates, l)
				continue
			}
			filter := append(bson.D{{Key: "_id", Value: *l.id}, {Key: "deletedAt", Value: nil}}, own...)
			set := append(append(bson.D{}, l.fields...), bson.E{Key: "updatedBy", Value: by}, bson.E{Key: "updatedAt", Value: now})
			if _, err := coll.UpdateOne(ctx, filter, bson.D{{Key: "$set", Value: set}}); err != nil {
				return err
			}
		}
		if len(removed) > 0 {
			if _, err := coll.UpdateMany(ctx, append(bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: removed}}}, {Key: "deletedAt", Value: nil}}, own...),
				bson.D{{Key: "$set", Value: bson.D{{Key: "deletedAt", Value: now}, {Key: "updatedBy", Value: by}, {Key: "updatedAt", Value: now}}}}); err != nil {
				return err
			}
		}
		if len(creates) == 0 {
			return nil
		}
		var run struct {
			Sequence int `bson:"sequence"`
		}
		if err := h.col("platformdocumentsequences").FindOneAndUpdate(ctx, sheetRun,
			bson.D{{Key: "$inc", Value: bson.D{{Key: "sequence", Value: len(creates)}}}, {Key: "$set", Value: bson.D{{Key: "updatedAt", Value: now}}}, {Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: now}, {Key: "__v", Value: 0}}}},
			options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&run); err != nil {
			return err
		}
		first := run.Sequence - len(creates) + 1
		docs := make([]any, len(creates))
		for i, l := range creates {
			seq := first + i
			docs[i] = append(append(bson.D{{Key: "_id", Value: bson.NewObjectID()}, {Key: "sequence", Value: seq}, {Key: "refCode", Value: agreementRef(seq, now)}}, l.fields...),
				bson.E{Key: "deletedAt", Value: nil}, bson.E{Key: "createdBy", Value: by}, bson.E{Key: "updatedBy", Value: by},
				bson.E{Key: "createdAt", Value: now}, bson.E{Key: "updatedAt", Value: now}, bson.E{Key: "__v", Value: 0})
		}
		_, err := coll.InsertMany(ctx, docs)
		return err
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.RT.PublishTrackSheet(c, realtime.TrackSheetSaved, ordered.Map{{Key: "userId", Value: p.UserID}})
	out, err := h.sheetView(c, p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Track sheet saved")
}

var lineRe = regexp.MustCompile(`(?i)^([a-f\d]{24}|new-\d{1,4})$`)

func (h *Handler) focus(c *gin.Context) {
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	at := float64(h.Now().UnixMilli())
	if f.Present("at") {
		v, ok := f.Num("at", valid.N{Int: true})
		if ok && v <= 0 {
			f.Is.Add("at", valid.TooSmall("number", 0, false))
		}
		at = v
	}
	var line any
	if raw, ok := f.M["line"]; !ok || raw != nil {
		if v, ok := f.Str("line", valid.S{Re: lineRe, ReSrc: `/^([a-f\d]{24}|new-\d{1,4})$/i`}); ok {
			line = v
		}
	}
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	place := ordered.Map{{Key: "at", Value: int64(at)}, {Key: "line", Value: line}}
	h.RT.PublishTrackSheet(c, realtime.TrackSheetFocus, append(append(ordered.Map{}, place...), ordered.Pair{Key: "userId", Value: authz.From(c).UserID}))
	httpx.OK(c, place, "Line shared")
}

var _ mongo.Pipeline
