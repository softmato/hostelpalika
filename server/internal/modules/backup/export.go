package backup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
)

// tenant-export.ts: one hostel's data, everything of it, as Extended JSON rows for a
// restore. Scope is decided here: the root hostel plus its branches when it is a
// main hostel; a branch exports only itself. Each collection is read with its tenant
// key $in those ids and nothing else. File bytes stay in our storage.

const (
	exportFormat  = "hostelpalika-tenant-export"
	exportVersion = 1
	chunkBytes    = 1_000_000
)

type tenantCollection struct {
	Name, Coll, Key string
	// Restore may add missing rows back; false = platform state the hostel cannot write.
	Restore bool
}

// tenantCollections is TENANT_COLLECTIONS, in its order (counts keep it).
var tenantCollections = []tenantCollection{
	{"Resident", "residents", "hostelId", true},
	{"ResidentApplication", "residentapplications", "hostelId", true},
	{"ResidentDocument", "residentdocuments", "hostelId", true},
	{"ResidentJoinLink", "residentjoinlinks", "hostelId", true},
	{"ResidentLeave", "residentleaves", "hostelId", true},
	{"AdmissionForm", "admissionforms", "hostelId", true},
	{"AdmissionFormLink", "admissionformlinks", "hostelId", true},
	{"ExistingResidentList", "existingresidentlists", "hostelId", true},
	{"EmergencyContact", "emergencycontacts", "hostelId", true},
	{"Guardian", "guardians", "hostelId", true},
	{"GuardianAccess", "guardianaccesses", "hostelId", true},
	{"GuardianPermission", "guardianpermissions", "hostelId", true},
	{"MoveInChecklist", "moveinchecklists", "hostelId", true},
	{"MoveOutChecklist", "moveoutchecklists", "hostelId", true},
	{"QRActivation", "qractivations", "hostelId", true},
	{"Booking", "bookings", "hostelId", true},
	{"BookingPayment", "bookingpayments", "hostelId", true},
	{"BookingTransfer", "bookingtransfers", "hostelId", true},
	{"Inquiry", "inquiries", "hostelId", true},
	{"InquiryNote", "inquirynotes", "hostelId", true},
	{"HostelRoom", "hostelrooms", "hostelId", true},
	{"RoomChangeRequest", "roomchangerequests", "hostelId", true},
	{"RoomConditionPhoto", "roomconditionphotos", "hostelId", true},
	{"ProvidedItem", "provideditems", "hostelId", true},
	{"Invoice", "invoices", "hostelId", true},
	{"InvoiceBalance", "invoicebalances", "hostelId", true},
	{"PaymentEvent", "paymentevents", "hostelId", true},
	{"Receipt", "receipts", "hostelId", true},
	{"ReceiptCounter", "receiptcounters", "hostelId", true},
	{"DepositRecord", "depositrecords", "hostelId", true},
	{"DepositRefund", "depositrefunds", "hostelId", true},
	{"CreditBalance", "creditbalances", "hostelId", true},
	{"FeeSchedule", "feeschedules", "hostelId", true},
	{"RentConcession", "rentconcessions", "hostelId", true},
	{"KhataEntry", "khataentries", "hostelId", true},
	{"Expense", "expenses", "hostelId", true},
	{"HostelExpenseCategory", "hostelexpensecategories", "hostelId", true},
	{"StatementImport", "statementimports", "hostelId", true},
	{"StockEntry", "stockentries", "hostelId", true},
	{"StockPayment", "stockpayments", "hostelId", true},
	{"StockItem", "stockitems", "groupHostelId", true},
	{"StockSupplier", "stocksuppliers", "groupHostelId", true},
	{"HostelMember", "hostelmembers", "hostelId", true},
	{"CookAccount", "cookaccounts", "hostelId", true},
	{"RolePermission", "rolepermissions", "hostelId", true},
	{"HostelSettings", "hostelsettings", "hostelId", true},
	{"HostelDocument", "hosteldocuments", "hostelId", true},
	{"FileAsset", "fileassets", "hostelId", true},
	{"AttendanceLog", "attendancelogs", "hostelId", true},
	{"AttendanceAlert", "attendancealerts", "hostelId", true},
	{"ManualStatusOverride", "manualstatusoverrides", "hostelId", true},
	{"NightStatus", "nightstatuses", "hostelId", true},
	{"NightStatusLog", "nightstatuslogs", "hostelId", true},
	{"NightStatusPrompt", "nightstatusprompts", "hostelId", true},
	{"Complaint", "complaints", "hostelId", true},
	{"ComplaintAttachment", "complaintattachments", "hostelId", true},
	{"ComplaintUpdate", "complaintupdates", "hostelId", true},
	{"MaintenanceRequest", "maintenancerequests", "hostelId", true},
	{"MaintenanceComment", "maintenancecomments", "hostelId", true},
	{"MaintenanceHistory", "maintenancehistories", "hostelId", true},
	{"IncidentLog", "incidentlogs", "hostelId", true},
	{"SOSAlert", "sosalerts", "hostelId", true},
	{"Notice", "notices", "hostelId", true},
	{"NoticePush", "noticepushes", "hostelId", true},
	{"CommunityPost", "communityposts", "hostelId", true},
	{"CommunityComment", "communitycomments", "hostelId", true},
	{"CommunityReaction", "communityreactions", "hostelId", true},
	{"FoodRoutine", "foodroutines", "hostelId", true},
	{"FoodReadyLog", "foodreadylogs", "hostelId", true},
	{"FoodPhoto", "foodphotos", "hostelId", true},
	{"FoodFeedback", "foodfeedbacks", "hostelId", true},
	{"MealCallReminder", "mealcallreminders", "hostelId", true},
	{"Hostel", "hostels", "_id", false},
	{"User", "users", "hostelIds", false},
	{"AuditLog", "auditlogs", "hostelId", false},
	{"HostelSubscription", "hostelsubscriptions", "hostelId", false},
	{"SubscriptionInvoice", "subscriptioninvoices", "hostelId", false},
	{"SubscriptionPayment", "subscriptionpayments", "hostelId", false},
	{"HostelVerification", "hostelverifications", "hostelId", false},
	{"HostelApplication", "hostelapplications", "hostelId", false},
	{"HostelAgreementSignature", "hostelagreementsignatures", "hostelId", false},
	{"HostelLeaveRequest", "hostelleaverequests", "hostelId", false},
	{"HostelPaymentProfile", "hostelpaymentprofiles", "hostelId", false},
	{"HostelPayoutAccount", "hostelpayoutaccounts", "hostelId", false},
	{"PaymentIntent", "paymentintents", "hostelId", false},
	{"OfferAward", "offerawards", "hostelId", false},
	{"RatingReview", "ratingreviews", "hostelId", false},
	{"StoreCart", "storecarts", "hostelId", false},
	{"StoreOrder", "storeorders", "hostelId", false},
}

// hidden are each model's select:false fields: they stay out, as in TS. Users get
// USER_FIELDS only: who they are and their role here, never a credential.
var hidden = map[string]bson.D{
	"QRActivation": {{Key: "codeHash", Value: 0}},
	"CookAccount":  {{Key: "invitationToken", Value: 0}},
	"User": {{Key: "name", Value: 1}, {Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}, {Key: "email", Value: 1}, {Key: "phone", Value: 1},
		{Key: "role", Value: 1}, {Key: "status", Value: 1}, {Key: "hostelIds", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "updatedAt", Value: 1}},
}

func findCollection(name string) *tenantCollection {
	for i := range tenantCollections {
		if tenantCollections[i].Name == name {
			return &tenantCollections[i]
		}
	}
	return nil
}

// tenantHostelIDs is the root hostel plus, for a main hostel, its branches.
func tenantHostelIDs(ctx context.Context, db *mongo.Database, root bson.ObjectID) ([]bson.ObjectID, error) {
	var h struct {
		Parent *bson.ObjectID `bson:"parentHostelId"`
	}
	err := db.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: root}}, options.FindOne().SetProjection(bson.D{{Key: "parentHostelId", Value: 1}})).Decode(&h)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if h.Parent != nil {
		return []bson.ObjectID{root}, nil
	}
	cur, err := db.Collection("hostels").Find(ctx, bson.D{{Key: "parentHostelId", Value: root}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var branches []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &branches); err != nil {
		return nil, err
	}
	ids := []bson.ObjectID{root}
	for _, b := range branches {
		ids = append(ids, b.ID)
	}
	return ids, nil
}

type packedChunk struct {
	Collection string `bson:"collection" json:"collection"`
	Index      int    `bson:"index" json:"index"`
	Rows       int    `bson:"rows" json:"rows"`
	SHA256     string `bson:"sha256" json:"sha256"`
}

type archiveChunk struct {
	Collection string `json:"collection"`
	Data       string `json:"data"`
	Index      int    `json:"index"`
}

type packedArchive struct {
	Counts    countList      `json:"counts"`
	CreatedAt string         `json:"createdAt"`
	Format    string         `json:"format"`
	HostelID  string         `json:"hostelId"`
	HostelIDs []string       `json:"hostelIds"`
	Version   int            `json:"version"`
	Chunks    []archiveChunk `json:"chunks"`
}

// countList keeps TENANT_COLLECTIONS order in JSON and in Mongo.
type countList bson.D

func (l countList) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range l {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(e.Key)
		v, _ := json.Marshal(e.Value)
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func sha256Hex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// buildArchive is buildTenantExport + packTenantExport in one pass: rows become
// canonical Extended JSON, cut into chunks of about 1 MB, each chunk hashed so a
// restore can prove it is what was backed up.
func buildArchive(ctx context.Context, db *mongo.Database, root bson.ObjectID, now time.Time) ([]byte, []packedChunk, countList, string, error) {
	ids, err := tenantHostelIDs(ctx, db, root)
	if err != nil {
		return nil, nil, nil, "", err
	}
	if len(ids) == 0 {
		return nil, nil, nil, "", httpx.NewError(404, "HOSTEL_NOT_FOUND", "Hostel was not found.", nil)
	}
	own := map[bson.ObjectID]bool{}
	hexIDs := make([]string, len(ids))
	for i, id := range ids {
		own[id] = true
		hexIDs[i] = id.Hex()
	}
	createdAt := httpx.ISO(now)
	out := packedArchive{CreatedAt: createdAt, Format: exportFormat, HostelID: root.Hex(), HostelIDs: hexIDs, Version: exportVersion, Chunks: []archiveChunk{}}
	chunks := []packedChunk{}
	for _, entry := range tenantCollections {
		opts := options.Find()
		if p, ok := hidden[entry.Name]; ok {
			opts.SetProjection(p)
		}
		cur, err := db.Collection(entry.Coll).Find(ctx, bson.D{{Key: entry.Key, Value: bson.D{{Key: "$in", Value: ids}}}}, opts)
		if err != nil {
			return nil, nil, nil, "", err
		}
		var parts [][]byte
		size, index, count := 0, 0, 0
		flush := func() {
			if len(parts) == 0 {
				return
			}
			text := "[" + string(bytes.Join(parts, []byte(","))) + "]"
			out.Chunks = append(out.Chunks, archiveChunk{entry.Name, text, index})
			chunks = append(chunks, packedChunk{entry.Name, index, len(parts), sha256Hex([]byte(text))})
			index++
			parts, size = nil, 0
		}
		for cur.Next(ctx) {
			doc := cur.Current
			if entry.Key == "hostelIds" {
				// A person working at two hostels: keep only this hostel's ids on their row.
				var d bson.D
				if err := bson.Unmarshal(doc, &d); err != nil {
					cur.Close(ctx)
					return nil, nil, nil, "", err
				}
				for i, e := range d {
					if e.Key == "hostelIds" {
						if arr, ok := e.Value.(bson.A); ok {
							kept := bson.A{}
							for _, v := range arr {
								if oid, ok := v.(bson.ObjectID); ok && own[oid] {
									kept = append(kept, v)
								}
							}
							d[i].Value = kept
						}
					}
				}
				if doc, err = bson.Marshal(d); err != nil {
					cur.Close(ctx)
					return nil, nil, nil, "", err
				}
			}
			text, err := bson.MarshalExtJSON(doc, true, false)
			if err != nil {
				cur.Close(ctx)
				return nil, nil, nil, "", err
			}
			if size+len(text) > chunkBytes {
				flush()
			}
			parts = append(parts, text)
			size += len(text)
			count++
		}
		err = cur.Err()
		cur.Close(ctx)
		if err != nil {
			return nil, nil, nil, "", err
		}
		flush()
		out.Counts = append(out.Counts, bson.E{Key: entry.Name, Value: count})
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		return nil, nil, nil, "", err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), chunks, out.Counts, createdAt, nil
}

// parseChunk is one chunk's rows, with ObjectIds and dates as they left.
func parseChunk(data string) ([]bson.Raw, error) {
	var wrap struct {
		R []bson.Raw `bson:"r"`
	}
	if err := bson.UnmarshalExtJSON([]byte(`{"r":`+data+`}`), false, &wrap); err != nil {
		return nil, err
	}
	return wrap.R, nil
}
