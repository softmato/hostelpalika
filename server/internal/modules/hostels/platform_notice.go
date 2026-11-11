package hostels

import (
	"slices"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/softmato/hostelpalika/server/internal/modules/notifications"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

// notice is POST /platform/hostels/notice (sendPlatformHostelNotice): a
// personal (one hostel) or group notice to hostel owners, by email (one batched
// send), push (bell row + device push), or both. Archived hostels count as not
// found. A failed send never fails the request; each result says who was reached.
func (p *Platform) notice(c *gin.Context) {
	_, actor := actorOf(c)
	body, err := valid.Body(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	f := valid.NewForm(body)
	text, _ := f.Str("body", valid.S{Trim: true, Min: 2, Max: 2000})
	chList, _ := f.Array("channels", false, false)
	channels := make([]string, 0, len(chList))
	for i, v := range chList {
		sub := valid.NewForm(map[string]any{"c": v})
		if ch, ok := sub.Enum("c", false, nil, "EMAIL", "PUSH"); ok {
			channels = append(channels, ch)
		}
		f.JoinScalar("channels."+strconv.Itoa(i), sub)
	}
	f.Size("channels", len(chList), 1, 2, "Pick email, push or both.", false)
	idList, _ := f.Array("hostelIds", false, false)
	ids := make([]string, 0, len(idList))
	for i, v := range idList {
		sub := valid.NewForm(map[string]any{"h": v})
		if h, ok := sub.Str("h", valid.S{Re: objectIDRe, ReMsg: "Invalid object id."}); ok && objectIDRe.MatchString(h) {
			if h = strings.ToLower(h); !slices.Contains(ids, h) {
				ids = append(ids, h)
			}
		}
		f.JoinScalar("hostelIds."+strconv.Itoa(i), sub)
	}
	f.Size("hostelIds", len(idList), 1, 200, "Pick at least one hostel.", false)
	title, _ := f.Str("title", valid.S{Trim: true, Min: 2, Max: 120})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	wantEmail, wantPush := slices.Contains(channels, "EMAIL"), slices.Contains(channels, "PUSH")

	oids := make([]bson.ObjectID, 0, len(ids))
	for _, id := range ids {
		oid, _ := bson.ObjectIDFromHex(id)
		oids = append(oids, oid)
	}
	type hostelRow struct {
		ID      bson.ObjectID  `bson:"_id"`
		Name    string         `bson:"name"`
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	var hostels []hostelRow
	cur, err := p.DB.Collection("hostels").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: oids}}}, {Key: "isArchived", Value: bson.D{{Key: "$ne", Value: true}}}})
	if err == nil {
		err = cur.All(c, &hostels)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ownerIDs := make([]bson.ObjectID, 0, len(hostels))
	hostelByID := make(map[string]hostelRow, len(hostels))
	for _, h := range hostels {
		hostelByID[h.ID.Hex()] = h
		if h.OwnerID != nil {
			ownerIDs = append(ownerIDs, *h.OwnerID)
		}
	}
	type ownerRow struct {
		ID    bson.ObjectID `bson:"_id"`
		Email string        `bson:"email"`
		Name  string        `bson:"name"`
	}
	var owners []ownerRow
	cur, err = p.DB.Collection("users").Find(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ownerIDs}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}})
	if err == nil {
		err = cur.All(c, &owners)
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ownerByID := make(map[bson.ObjectID]ownerRow, len(owners))
	for _, o := range owners {
		ownerByID[o.ID] = o
	}

	type result struct {
		id, name, reason string
		owner            ownerRow
		emailed, pushed  bool
	}
	results := make([]*result, 0, len(ids))
	var reachable []*result
	for _, id := range ids {
		r := &result{id: id}
		h, found := hostelByID[id]
		r.name = h.Name
		switch {
		case !found:
			r.reason = "not_found"
		case h.OwnerID == nil:
			r.reason = "no_owner"
		default:
			if o, ok := ownerByID[*h.OwnerID]; ok {
				r.owner = o
				reachable = append(reachable, r)
			} else {
				r.reason = "no_owner"
			}
		}
		results = append(results, r)
	}

	if wantEmail {
		var mailable []*result
		var msgs []email.Message
		for _, r := range reachable {
			if r.owner.Email == "" {
				continue
			}
			name := r.name
			if name == "" {
				name = "your hostel"
			}
			m := email.PlatformNotice(text, p.SiteURL+"/hostel-admin", name, r.owner.Name, title)
			mailable = append(mailable, r)
			msgs = append(msgs, email.Message{Category: m.Category, To: []string{r.owner.Email}, Subject: m.Subject, HTML: m.HTML})
		}
		for i, sent := range p.Mail.SendBatch(c, msgs) {
			mailable[i].emailed = sent.Sent
		}
	}
	if wantPush {
		for _, r := range reachable {
			_, err := p.Notify.CreateInApp(c, notifications.Input{ActionURL: "/hostel-admin", Body: text, Category: "GENERAL", CreatedBy: actor.Hex(),
				Data: ordered.Map{{Key: "hostelId", Value: r.id}, {Key: "type", Value: "platform_notice"}}, HostelID: r.id, Priority: "HIGH", Title: title, UserID: r.owner.ID.Hex()})
			r.pushed = err == nil
		}
	}

	flag := func(want, got bool) any {
		if !want {
			return nil
		}
		return got
	}
	emailed, pushed := 0, 0
	out := make([]ordered.Map, 0, len(results))
	for _, r := range results {
		if r.emailed {
			emailed++
		}
		if r.pushed {
			pushed++
		}
		row := ordered.Map{{Key: "emailed", Value: flag(wantEmail, r.emailed)}, {Key: "hostelId", Value: r.id}, {Key: "hostelName", Value: r.name}, {Key: "pushed", Value: flag(wantPush, r.pushed)}}
		if r.reason != "" {
			row = append(row, ordered.Pair{Key: "reason", Value: r.reason})
		}
		out = append(out, row)
	}
	for _, r := range reachable {
		hid, _ := bson.ObjectIDFromHex(r.id)
		if err := p.Audit.Write(c, audit.Entry{Action: "HOSTEL_NOTICE_SENT", ActorID: actor, EntityID: r.id, EntityType: "Hostel", HostelID: hid,
			Metadata: bson.D{{Key: "channels", Value: channels}, {Key: "emailed", Value: flag(wantEmail, r.emailed)}, {Key: "pushed", Value: flag(wantPush, r.pushed)}, {Key: "title", Value: title}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	httpx.OK(c, ordered.Map{{Key: "emailed", Value: emailed}, {Key: "pushed", Value: pushed}, {Key: "results", Value: out}, {Key: "total", Value: len(results)}}, "Notice sent")
}
