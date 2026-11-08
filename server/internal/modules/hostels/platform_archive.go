package hostels

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// archiveGraceDays is HOSTEL_ARCHIVE_GRACE_DAYS: how long an archived hostel can be restored.
const archiveGraceDays = 60

func (p *Platform) archive(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	reason, ok := reasonBody(c)
	if !ok {
		return
	}
	h, revoked, err := p.Archive(c, id, reason, actor, archiveGraceDays, nil)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	msg := "Hostel archived"
	if revoked > 0 {
		s := "s"
		if revoked == 1 {
			s = ""
		}
		msg = fmt.Sprintf("Hostel archived, and %d session%s signed out", revoked, s)
	}
	httpx.OK(c, ordered.Map{{Key: "hostel", Value: p.serialize(h)}, {Key: "sessionsRevoked", Value: revoked}}, msg)
}

// Archive is archivePlatformHostel. A leaving hostel passes its own data hold for
// graceDays and its owner in keep: they leave, they are not signed out.
func (p *Platform) Archive(ctx context.Context, id bson.ObjectID, reason string, actor bson.ObjectID, graceDays int, keep []bson.ObjectID) (bson.Raw, int64, error) {
	now := p.now()
	purgeAt := now.Add(time.Duration(graceDays) * 24 * time.Hour)
	h, err := p.DB.Collection("hostels").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "archiveReason", Value: reason}, {Key: "deletedAt", Value: now}, {Key: "deletedBy", Value: actor}, {Key: "isDeleted", Value: true},
			{Key: "purgeScheduledAt", Value: purgeAt}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: now}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, 0, httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found, or is already archived.", nil)
	}
	if err != nil {
		return nil, 0, err
	}
	revoked, err := p.revokeArchivedSessions(ctx, id, now, keep)
	if err != nil {
		return nil, 0, err
	}
	if _, err := p.DB.Collection("users").UpdateMany(ctx, bson.D{{Key: "hostelIds", Value: id}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: id}}}}); err != nil {
		return nil, 0, err
	}
	if err := p.auditHostel(ctx, actor, id, "HOSTEL_ARCHIVED", bson.D{{Key: "purgeScheduledAt", Value: httpx.ISO(purgeAt)}, {Key: "reason", Value: reason}, {Key: "sessionsRevoked", Value: revoked}}); err != nil {
		return nil, 0, err
	}
	p.Cache.PublicChanged(ctx)
	return h, revoked, nil
}

// revokeArchivedSessions is revokeSessionsForArchivedHostel: everyone whose only
// tie was this hostel is signed out; anyone still attached to a live hostel is not.
func (p *Platform) revokeArchivedSessions(ctx context.Context, id bson.ObjectID, now time.Time, keep []bson.ObjectID) (int64, error) {
	candidates := map[bson.ObjectID]bool{}
	var h struct {
		OwnerID *bson.ObjectID `bson:"ownerId"`
	}
	if err := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&h); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return 0, err
	}
	if h.OwnerID != nil {
		candidates[*h.OwnerID] = true
	}
	userIDs := func(coll string, filter bson.D) ([]struct {
		HostelID bson.ObjectID `bson:"hostelId"`
		UserID   bson.ObjectID `bson:"userId"`
	}, error) {
		cur, err := p.DB.Collection(coll).Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: "hostelId", Value: 1}, {Key: "userId", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			HostelID bson.ObjectID `bson:"hostelId"`
			UserID   bson.ObjectID `bson:"userId"`
		}
		return rows, cur.All(ctx, &rows)
	}
	live := bson.D{{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}
	withUser := bson.D{{Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}}
	for _, src := range []struct {
		coll   string
		filter bson.D
	}{{"hostelmembers", append(bson.D{{Key: "hostelId", Value: id}}, live...)}, {"residents", append(append(bson.D{{Key: "hostelId", Value: id}}, live...), withUser...)}, {"cookaccounts", append(bson.D{{Key: "hostelId", Value: id}}, withUser...)}} {
		rows, err := userIDs(src.coll, src.filter)
		if err != nil {
			return 0, err
		}
		for _, r := range rows {
			if !r.UserID.IsZero() {
				candidates[r.UserID] = true
			}
		}
	}
	if len(candidates) == 0 {
		return 0, nil
	}
	ids := bson.A{}
	for u := range candidates {
		ids = append(ids, u)
	}
	attached := map[bson.ObjectID]bool{}
	cur, err := p.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: id}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "ownerId", Value: bson.D{{Key: "$in", Value: ids}}}},
		options.Find().SetProjection(bson.D{{Key: "ownerId", Value: 1}}))
	if err != nil {
		return 0, err
	}
	var owned []struct {
		OwnerID bson.ObjectID `bson:"ownerId"`
	}
	if err := cur.All(ctx, &owned); err != nil {
		return 0, err
	}
	for _, o := range owned {
		attached[o.OwnerID] = true
	}
	for _, coll := range []string{"hostelmembers", "residents"} {
		rows, err := userIDs(coll, append(bson.D{{Key: "hostelId", Value: bson.D{{Key: "$ne", Value: id}}}, {Key: "userId", Value: bson.D{{Key: "$in", Value: ids}}}}, live...))
		if err != nil {
			return 0, err
		}
		if len(rows) == 0 {
			continue
		}
		liveIDs, err := p.liveHostels(ctx, rows)
		if err != nil {
			return 0, err
		}
		for _, r := range rows {
			if liveIDs[r.HostelID] {
				attached[r.UserID] = true
			}
		}
	}
	for _, u := range keep {
		attached[u] = true
	}
	revoke := bson.A{}
	for u := range candidates {
		if !attached[u] {
			revoke = append(revoke, u)
		}
	}
	if len(revoke) == 0 {
		return 0, nil
	}
	res, err := p.DB.Collection("sessions").UpdateMany(ctx, bson.D{{Key: "revokedAt", Value: nil}, {Key: "userId", Value: bson.D{{Key: "$in", Value: revoke}}}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "refreshTokenHash", Value: nil}, {Key: "revokedAt", Value: now}, {Key: "updatedAt", Value: now}}}})
	if err != nil {
		return 0, err
	}
	return res.ModifiedCount, nil
}

// liveHostels: which of the rows' hostels are not archived. TS loaded every live
// hostel on the platform to answer this; only the ones in question are read here.
func (p *Platform) liveHostels(ctx context.Context, rows []struct {
	HostelID bson.ObjectID `bson:"hostelId"`
	UserID   bson.ObjectID `bson:"userId"`
}) (map[bson.ObjectID]bool, error) {
	ids := bson.A{}
	for _, r := range rows {
		ids = append(ids, r.HostelID)
	}
	cur, err := p.DB.Collection("hostels").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var hs []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &hs); err != nil {
		return nil, err
	}
	out := map[bson.ObjectID]bool{}
	for _, h := range hs {
		out[h.ID] = true
	}
	return out, nil
}

func (p *Platform) restore(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	notArchived := httpx.NewError(http.StatusNotFound, "HOSTEL_NOT_FOUND", "Hostel was not found, or is not archived.", nil)
	var existing struct {
		Slug      string         `bson:"slug"`
		RefPrefix *string        `bson:"referencePrefix"`
		PurgeAt   *time.Time     `bson:"purgeScheduledAt"`
		DeletedAt *time.Time     `bson:"deletedAt"`
		OwnerID   *bson.ObjectID `bson:"ownerId"`
	}
	if err := p.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: true}}).Decode(&existing); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = notArchived
		}
		httpx.Fail(c, err)
		return
	}
	if existing.PurgeAt != nil && !existing.PurgeAt.After(time.Now()) {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "HOSTEL_PURGE_DUE", "This hostel's grace period has run out and it is queued for erasure. It can no longer be restored.", nil))
		return
	}
	or := bson.A{bson.D{{Key: "slug", Value: existing.Slug}}}
	if existing.RefPrefix != nil && *existing.RefPrefix != "" {
		or = append(or, bson.D{{Key: "referencePrefix", Value: *existing.RefPrefix}})
	}
	var clash struct {
		Name *string `bson:"name"`
		Slug string  `bson:"slug"`
	}
	err := p.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$ne", Value: id}}}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "$or", Value: or}}).Decode(&clash)
	if err == nil {
		name := clash.Slug
		if clash.Name != nil && *clash.Name != "" {
			name = *clash.Name
		}
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "HOSTEL_SLUG_TAKEN", `Its address or reference code is now held by "`+name+`". Rename that hostel before restoring this one.`, nil))
		return
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, err)
		return
	}
	h, err := p.DB.Collection("hostels").FindOneAndUpdate(c, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: true}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "isDeleted", Value: false}, {Key: "updatedBy", Value: actor}, {Key: "updatedAt", Value: p.now()}}},
			{Key: "$unset", Value: bson.D{{Key: "archiveReason", Value: ""}, {Key: "deletedAt", Value: ""}, {Key: "deletedBy", Value: ""}, {Key: "purgeScheduledAt", Value: ""}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Raw()
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, notArchived)
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// Archiving pulled the hostel from every account; TS put it back for the owner
	// and staff only, leaving its residents and cooks locked out (P7-16).
	back := bson.A{}
	if existing.OwnerID != nil {
		back = append(back, *existing.OwnerID)
	}
	for _, src := range []struct {
		coll   string
		filter bson.D
	}{
		{"hostelmembers", bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}}},
		{"residents", bson.D{{Key: "hostelId", Value: id}, {Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "status", Value: "ACTIVE"}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}}},
		{"cookaccounts", bson.D{{Key: "hostelId", Value: id}, {Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"ACTIVE", "INVITED"}}}}, {Key: "userId", Value: bson.D{{Key: "$ne", Value: nil}}}}},
	} {
		cur, err := p.DB.Collection(src.coll).Find(c, src.filter, options.Find().SetProjection(bson.D{{Key: "userId", Value: 1}}))
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		var rows []struct {
			UserID *bson.ObjectID `bson:"userId"`
		}
		if err := cur.All(c, &rows); err != nil {
			httpx.Fail(c, err)
			return
		}
		for _, r := range rows {
			if r.UserID != nil {
				back = append(back, *r.UserID)
			}
		}
	}
	if len(back) > 0 {
		if _, err := p.DB.Collection("users").UpdateMany(c, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: back}}}}, bson.D{{Key: "$addToSet", Value: bson.D{{Key: "hostelIds", Value: id}}}}); err != nil {
			httpx.Fail(c, err)
			return
		}
	}
	var archivedAt any
	if existing.DeletedAt != nil {
		archivedAt = httpx.ISO(*existing.DeletedAt)
	}
	if err := p.auditHostel(c, actor, id, "HOSTEL_RESTORED", bson.D{{Key: "archivedAt", Value: archivedAt}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ordered.Map{{Key: "hostel", Value: p.serialize(h)}}, "Hostel restored")
}

// erasedByHostelID is ERASED_BY_HOSTEL_ID's collections. Bookings, agreements,
// leave requests, free-plan claims, wallet entries and the audit log are kept
// (RETAINED_BY_HOSTEL_ID says why).
var erasedByHostelID = []string{
	"attendancealerts", "attendancelogs", "communitycomments", "communityposts", "communityreactions", "communityreports", "complaints", "complaintattachments",
	"complaintupdates", "consentlogs", "cookaccounts", "creditbalances", "depositrecords", "depositrefunds", "duplicatecheckresults", "emergencycontacts",
	"encryptedsecrets", "existingresidentlists", "expenses", "feedbacks", "residentapplications", "residentjoinlinks", "admissionforms", "admissionformlinks",
	"feeschedules", "fileassets", "foodfeedbacks", "foodphotos", "foodreadylogs", "foodroutines", "guardians", "guardianaccesses", "guardianpermissions",
	"hostelapplications", "hosteldocuments", "hostelexpensecategories", "hostellistingimpressions", "hostelmembers", "hostelbackups", "hostelbackupruns",
	"hostelpageviews", "hostelpaymentprofiles", "hostelpayoutaccounts", "hostelrooms", "hostelsettings", "hostelsubscriptions", "hostelverifications",
	"incidentlogs", "inquiries", "inquirynotes", "invoices", "khataentries", "invoicebalances", "listingflags", "maintenancecomments", "maintenancehistories",
	"maintenancerequests", "manualstatusoverrides", "mealcallreminders", "moveinchecklists", "moveoutchecklists", "nightstatuses", "nightstatuslogs",
	"nightstatusprompts", "notices", "noticepushes", "notifications", "notificationcampaigns", "offerawards", "paymentevents", "paymentintents", "provideditems",
	"qractivations", "questioncallclicks", "ratingreviews", "receipts", "receiptcounters", "reconciliationruns", "referrals", "referralcodes",
	"hostelreferralcodes", "referralrewards", "rentconcessions", "residents", "residentdocuments", "residentleaves", "reviewmoderationlogs", "rolepermissions",
	"roomchangerequests", "roomconditionphotos", "sosalerts", "statementimports", "stockentries", "stockpayments", "storecarts", "storeorders",
	"subscriptioninvoices", "subscriptionpayments", "teamprepayments", "usagedailies", "usageevents",
}

func (p *Platform) purge(c *gin.Context) {
	_, actor := actorOf(c)
	id, ok := p.hostelID(c)
	if !ok {
		return
	}
	var h struct {
		IsDeleted bool    `bson:"isDeleted"`
		Name      *string `bson:"name"`
	}
	if err := p.DB.Collection("hostels").FindOne(c, bson.D{{Key: "_id", Value: id}}).Decode(&h); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = hostelErr404()
		}
		httpx.Fail(c, err)
		return
	}
	if !h.IsDeleted {
		httpx.Fail(c, httpx.NewError(http.StatusConflict, "HOSTEL_NOT_ARCHIVED", "Archive this hostel first. A live hostel cannot be erased directly.", nil))
		return
	}
	res, err := p.PurgeHostel(c, id, &actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	name := ""
	if h.Name != nil {
		name = *h.Name
	}
	httpx.OK(c, ordered.Map{{Key: "name", Value: name}, {Key: "documentsDeleted", Value: res.Documents}, {Key: "objectsDeleted", Value: res.Objects}, {Key: "objectsFailed", Value: res.Failed}},
		fmt.Sprintf(`"%s" erased permanently — %d records and %d files.`, name, res.Documents, res.Objects))
}

// PurgeResult is purgeHostel's answer.
type PurgeResult struct{ Documents, Objects, Failed int64 }

type assetKeys struct {
	Bucket   string `bson:"bucket"`
	Key      string `bson:"key"`
	Variants []struct {
		Key string `bson:"key"`
	} `bson:"variants"`
}

// PurgeHostel is purgeHostel: every row keyed to the hostel and its stored files.
// The file list is read first and the files go last (P7-18): TS deleted the
// objects before the rows, so a failure part way left rows pointing at files
// that no longer existed.
func (p *Platform) PurgeHostel(ctx context.Context, id bson.ObjectID, actor *bson.ObjectID) (PurgeResult, error) {
	keep, err := p.keepFilesForLeave(ctx, id, time.Now())
	if err != nil {
		return PurgeResult{}, err
	}
	cur, err := p.DB.Collection("fileassets").Find(ctx, bson.D{{Key: "hostelId", Value: id}}, options.Find().SetProjection(bson.D{{Key: "bucket", Value: 1}, {Key: "key", Value: 1}, {Key: "variants", Value: 1}}))
	if err != nil {
		return PurgeResult{}, err
	}
	var assets []assetKeys
	if err := cur.All(ctx, &assets); err != nil {
		return PurgeResult{}, err
	}
	var h struct {
		Name *string `bson:"name"`
		Slug *string `bson:"slug"`
	}
	if err := p.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: id}}).Decode(&h); err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
		return PurgeResult{}, err
	}
	ids := func(coll string) (bson.A, error) {
		cur, err := p.DB.Collection(coll).Find(ctx, bson.D{{Key: "hostelId", Value: id}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var rows []struct {
			ID bson.ObjectID `bson:"_id"`
		}
		if err := cur.All(ctx, &rows); err != nil {
			return nil, err
		}
		out := bson.A{}
		for _, r := range rows {
			out = append(out, r.ID)
		}
		return out, nil
	}
	notices, err := ids("notices")
	if err != nil {
		return PurgeResult{}, err
	}
	posts, err := ids("communityposts")
	if err != nil {
		return PurgeResult{}, err
	}
	var res PurgeResult
	for _, coll := range erasedByHostelID {
		r, err := p.DB.Collection(coll).DeleteMany(ctx, bson.D{{Key: "hostelId", Value: id}})
		if err != nil {
			return res, err
		}
		res.Documents += r.DeletedCount
	}
	for _, x := range []struct {
		coll   string
		filter bson.D
	}{
		{"noticereadstatuses", bson.D{{Key: "noticeId", Value: bson.D{{Key: "$in", Value: notices}}}}},
		{"communitycommentvotes", bson.D{{Key: "postId", Value: bson.D{{Key: "$in", Value: posts}}}}},
		{"stockitems", bson.D{{Key: "groupHostelId", Value: id}}}, {"stockentries", bson.D{{Key: "groupHostelId", Value: id}}},
		{"stocksuppliers", bson.D{{Key: "groupHostelId", Value: id}}}, {"stockpayments", bson.D{{Key: "groupHostelId", Value: id}}},
	} {
		r, err := p.DB.Collection(x.coll).DeleteMany(ctx, x.filter)
		if err != nil {
			return res, err
		}
		res.Documents += r.DeletedCount
	}
	for _, coll := range []string{"accountdeletionrequests", "notificationcampaigns", "users"} {
		if _, err := p.DB.Collection(coll).UpdateMany(ctx, bson.D{{Key: "hostelIds", Value: id}}, bson.D{{Key: "$pull", Value: bson.D{{Key: "hostelIds", Value: id}}}}); err != nil {
			return res, err
		}
	}
	if _, err := p.DB.Collection("hostels").DeleteOne(ctx, bson.D{{Key: "_id", Value: id}}); err != nil {
		return res, err
	}
	for _, a := range assets {
		if a.Bucket == "" || p.R2 == nil {
			continue
		}
		keys := []string{}
		if !keep[a.Bucket+"/"+a.Key] {
			keys = append(keys, a.Key)
		}
		for _, v := range a.Variants {
			keys = append(keys, v.Key)
		}
		for _, k := range keys {
			if k == "" {
				continue
			}
			if err := p.R2.Delete(ctx, a.Bucket, k); err != nil {
				res.Failed++
			} else {
				res.Objects++
			}
		}
	}
	trigger := "CRON"
	entry := audit.Entry{Action: "HOSTEL_PURGED", ActorType: "SYSTEM", EntityID: id.Hex(), EntityType: "Hostel"}
	if actor != nil {
		trigger, entry.ActorID, entry.ActorType = "MANUAL", *actor, "USER"
	}
	var name, slug any
	if h.Name != nil {
		name = *h.Name
	}
	if h.Slug != nil {
		slug = *h.Slug
	}
	entry.Metadata = bson.D{{Key: "trigger", Value: trigger}, {Key: "documentsDeleted", Value: res.Documents}, {Key: "name", Value: name}, {Key: "objectsDeleted", Value: res.Objects},
		{Key: "objectsFailed", Value: res.Failed}, {Key: "slug", Value: slug}}
	_ = p.Audit.Write(ctx, entry)
	return res, nil
}

// keepFilesForLeave: an approved leave keeps the hostel's files until its own
// deadline, recorded on the request so the leave sweep can erase them later.
func (p *Platform) keepFilesForLeave(ctx context.Context, id bson.ObjectID, now time.Time) (map[string]bool, error) {
	keep := map[string]bool{}
	var req struct {
		ID bson.ObjectID `bson:"_id"`
	}
	err := p.DB.Collection("hostelleaverequests").FindOne(ctx, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "hostelId", Value: id}}, bson.D{{Key: "branchIds", Value: id}}}},
		{Key: "filesUntil", Value: bson.D{{Key: "$gt", Value: now}}}, {Key: "status", Value: "APPROVED"}}).Decode(&req)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return keep, nil
	}
	if err != nil {
		return nil, err
	}
	cur, err := p.DB.Collection("fileassets").Find(ctx, bson.D{{Key: "bucket", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: ""}}}, {Key: "hostelId", Value: id},
		{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}, {Key: "key", Value: bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: ""}}}},
		options.Find().SetProjection(bson.D{{Key: "bucket", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "fileName", Value: 1}, {Key: "key", Value: 1}, {Key: "kind", Value: 1}, {Key: "mimeType", Value: 1}, {Key: "sizeBytes", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []bson.Raw
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return keep, nil
	}
	kept := bson.A{}
	for _, r := range rows {
		d := hostelDoc{r}
		keep[d.str("bucket")+"/"+d.str("key")] = true
		row := bson.D{{Key: "_id", Value: r.Lookup("_id")}, {Key: "bucket", Value: d.str("bucket")}}
		for _, k := range []string{"createdAt", "fileName"} {
			if v := r.Lookup(k); !nullish(v) {
				row = append(row, bson.E{Key: k, Value: v})
			}
		}
		row = append(row, bson.E{Key: "hostelId", Value: id}, bson.E{Key: "key", Value: d.str("key")})
		for _, k := range []string{"kind", "mimeType", "sizeBytes"} {
			if v := r.Lookup(k); !nullish(v) {
				row = append(row, bson.E{Key: k, Value: v})
			}
		}
		kept = append(kept, row)
	}
	_, err = p.DB.Collection("hostelleaverequests").UpdateOne(ctx, bson.D{{Key: "_id", Value: req.ID}}, bson.D{{Key: "$push", Value: bson.D{{Key: "keptFiles", Value: bson.D{{Key: "$each", Value: kept}}}}}})
	return keep, err
}
