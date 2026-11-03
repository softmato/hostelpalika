package hostelleave

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/email"
	"github.com/softmato/hostelpalika/server/internal/platform/export"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// rowCap is LEAVE_EXPORT_ROW_CAP: keeps the email under Resend's 40 MB.
// ponytail: split a sheet across files if a hostel ever outgrows it.
const rowCap = 100_000

// leaveSections is HOSTEL_LEAVE_SECTIONS: what the approval form can tick, in order.
var leaveSections = []struct{ key, label, description string }{
	{"residents", "Residents", "Everyone who has lived here, current and moved out."},
	{"rooms", "Rooms and beds", "Each room, its floor, type and number of beds."},
	{"bills", "Rent bills", "Every bill raised to a resident, what was paid on it and its status."},
	{"payments", "Payments", "Every payment in and refund out, with how it was paid."},
	{"receipts", "Receipts", "Every receipt issued, with its number."},
	{"deposits", "Deposits", "Security deposits taken and refunded."},
	{"khata", "Khata", "Items residents took on account."},
	{"expenses", "Expenses", "Money the hostel spent."},
	{"stock", "Stock", "Stock bought, used, moved and counted, one line per item."},
	{"food", "Food menu", "The weekly menu and meal times."},
	{"complaints", "Complaints", "Complaints from residents and your replies."},
	{"repairs", "Repairs", "Repair and maintenance jobs."},
	{"attendance", "Attendance", "Check-ins: the zone only, never a location."},
	{"notices", "Notices", "Notices sent to residents."},
	{"files", "Files list", "Every file uploaded: photos, documents and receipts, by name."},
}

func sectionKeys() []string {
	out := make([]string, len(leaveSections))
	for i, s := range leaveSections {
		out[i] = s.key
	}
	return out
}

type xcol struct{ key, header string }
type xrow map[string]any

// --- cell helpers, as hostel-leave-export.ts ---------------------------------------

func toTime(v any) (time.Time, bool) {
	switch x := v.(type) {
	case bson.DateTime:
		return x.Time().UTC(), true
	case time.Time:
		return x.UTC(), true
	case string:
		if x == "" {
			return time.Time{}, false
		}
		if t, ok := parseDate(x); ok {
			return t, true
		}
	}
	return time.Time{}, false
}

func parseDate(s string) (time.Time, bool) {
	for _, l := range []string{time.RFC3339Nano, "2006-01-02"} {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func adDate(v any) any {
	t, ok := toTime(v)
	if !ok {
		return nil
	}
	return bs.CalendarDay(t).Format("2006-01-02")
}

func bsDate(v any) any {
	t, ok := toTime(v)
	if !ok {
		return nil
	}
	d, err := bs.ToBs(t)
	if err != nil {
		return nil
	}
	return fmt.Sprintf("%d-%02d-%02d", d.Year, d.Month, d.Day)
}

func adDateTime(v any) any {
	t, ok := toTime(v)
	if !ok {
		return nil
	}
	return t.Add(345 * time.Minute).Format("2006-01-02 15:04")
}

func words(v any) any {
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	spaced := strings.ToLower(strings.ReplaceAll(s, "_", " "))
	return strings.ToUpper(spaced[:1]) + spaced[1:]
}

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int32:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}

func amount(v any) any {
	if n, ok := num(v); ok {
		return n
	}
	return nil
}

func text(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		if x == "" {
			return nil
		}
		return x
	case bson.ObjectID:
		return x.Hex()
	}
	if n, ok := num(v); ok {
		return export.CellText(n)
	}
	return fmt.Sprint(v)
}

func ident(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case bson.ObjectID:
		if x.IsZero() {
			return nil
		}
		return x.Hex()
	case string:
		if x == "" {
			return nil
		}
		return x
	}
	return fmt.Sprint(v)
}

func fullName(m bson.M) string {
	f, _ := m["firstName"].(string)
	l, _ := m["lastName"].(string)
	return strings.TrimSpace(f + " " + l)
}

func or(a, b any) any {
	if a == nil {
		return b
	}
	if s, ok := a.(string); ok && s == "" {
		return b
	}
	return a
}

type lookup struct{ hostels, residents map[string]string }

func (l lookup) hostel(v any) string {
	if id, ok := v.(bson.ObjectID); ok {
		return l.hostels[id.Hex()]
	}
	return ""
}

func (l lookup) resident(v any) string {
	if id, ok := v.(bson.ObjectID); ok {
		return l.residents[id.Hex()]
	}
	return ""
}

// --- sections ------------------------------------------------------------------------

type sectionSpec struct {
	columns []xcol
	rows    func(ctx context.Context, db *mongo.Database, ids bson.A, l lookup) ([]xrow, error)
}

var hostelCol = xcol{"hostel", "Hostel"}

func find(ctx context.Context, db *mongo.Database, coll string, filter bson.D, sort bson.D, project []string) ([]bson.M, error) {
	o := options.Find().SetSort(sort).SetLimit(rowCap)
	if len(project) > 0 {
		p := bson.D{}
		for _, k := range project {
			p = append(p, bson.E{Key: k, Value: 1})
		}
		o.SetProjection(p)
	}
	cur, err := db.Collection(coll).Find(ctx, filter, o)
	if err != nil {
		return nil, err
	}
	var out []bson.M
	return out, cur.All(ctx, &out)
}

func in(ids bson.A) bson.D { return bson.D{{Key: "$in", Value: ids}} }

var notDeleted = bson.E{Key: "isDeleted", Value: bson.D{{Key: "$ne", Value: true}}}

// simple is a section read from one collection by hostelId, oldest first.
func simple(coll, sortKey string, project []string, live bool, row func(m bson.M, l lookup) xrow) func(context.Context, *mongo.Database, bson.A, lookup) ([]xrow, error) {
	return func(ctx context.Context, db *mongo.Database, ids bson.A, l lookup) ([]xrow, error) {
		f := bson.D{{Key: "hostelId", Value: in(ids)}}
		if live {
			f = append(f, notDeleted)
		}
		rows, err := find(ctx, db, coll, f, bson.D{{Key: sortKey, Value: 1}}, project)
		if err != nil {
			return nil, err
		}
		out := make([]xrow, len(rows))
		for i, m := range rows {
			out[i] = row(m, l)
		}
		return out, nil
	}
}

func cols(pairs ...string) []xcol {
	out := make([]xcol, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i] == "hostel" {
			out = append(out, hostelCol)
			continue
		}
		out = append(out, xcol{pairs[i], pairs[i+1]})
	}
	return out
}

func numberOrNil(v any) any {
	if n, ok := num(v); ok {
		return n
	}
	return nil
}

var specs = map[string]sectionSpec{
	"residents": {cols("resident_id", "Resident ID", "hostel", "", "name", "Name", "phone", "Phone", "email", "Email", "resident_type", "Type", "room", "Room", "floor", "Floor", "status", "Status",
		"moved_in", "Moved in", "moved_in_bs", "Moved in (BS)", "moved_out", "Moved out", "monthly_fee", "Monthly fee (Rs)", "deposit", "Deposit (Rs)", "admission_fee", "Admission fee (Rs)", "paid_till", "Paid till"),
		simple("residents", "moveInDate", strings.Fields("hostelId firstName lastName phone email residentType roomNumber floor status moveInDate moveOutDate monthlyFee depositAmount admissionFee paidTill isDeleted"), false,
			func(m bson.M, l lookup) xrow {
				status := words(m["status"])
				if d, _ := m["isDeleted"].(bool); d {
					status = "Removed"
				}
				return xrow{"admission_fee": amount(m["admissionFee"]), "deposit": amount(m["depositAmount"]), "email": text(m["email"]), "floor": text(m["floor"]), "hostel": l.hostel(m["hostelId"]),
					"monthly_fee": amount(m["monthlyFee"]), "moved_in": adDate(m["moveInDate"]), "moved_in_bs": bsDate(m["moveInDate"]), "moved_out": adDate(m["moveOutDate"]), "name": fullName(m),
					"paid_till": text(m["paidTill"]), "phone": text(m["phone"]), "resident_id": ident(m["_id"]), "resident_type": words(m["residentType"]), "room": text(m["roomNumber"]), "status": status}
			})},
	"rooms": {cols("hostel", "", "floor", "Floor", "room", "Room", "room_type", "Room type", "beds", "Beds"),
		func(ctx context.Context, db *mongo.Database, ids bson.A, l lookup) ([]xrow, error) {
			rows, err := find(ctx, db, "hostelrooms", bson.D{{Key: "hostelId", Value: in(ids)}, notDeleted}, bson.D{{Key: "floor", Value: 1}, {Key: "number", Value: 1}}, nil)
			out := make([]xrow, len(rows))
			for i, m := range rows {
				out[i] = xrow{"beds": numberOrNil(m["beds"]), "floor": numberOrNil(m["floor"]), "hostel": l.hostel(m["hostelId"]), "room": text(m["number"]), "room_type": words(m["roomType"])}
			}
			return out, err
		}},
	"bills": {cols("bill_id", "Bill ID", "hostel", "", "reference", "Reference", "resident_id", "Resident ID", "resident", "Resident", "month", "Month (BS)", "kind", "Kind", "issued", "Issued",
		"issued_bs", "Issued (BS)", "due", "Due", "amount", "Amount (Rs)", "paid", "Paid (Rs)", "balance", "Balance (Rs)", "status", "Status"),
		func(ctx context.Context, db *mongo.Database, ids bson.A, l lookup) ([]xrow, error) {
			invoices, err := find(ctx, db, "invoices", bson.D{{Key: "hostelId", Value: in(ids)}}, bson.D{{Key: "issuedAt", Value: 1}},
				strings.Fields("hostelId issuedAt referenceCode residentId period kind totalAmount dueDate status"))
			if err != nil {
				return nil, err
			}
			cur, err := db.Collection("paymentevents").Aggregate(ctx, bson.A{
				bson.D{{Key: "$match", Value: bson.D{{Key: "direction", Value: "CREDIT"}, {Key: "hostelId", Value: in(ids)}, {Key: "invoiceId", Value: bson.D{{Key: "$ne", Value: nil}}}, {Key: "status", Value: "SETTLED"}}}},
				bson.D{{Key: "$group", Value: bson.D{{Key: "_id", Value: "$invoiceId"}, {Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}}}}},
			})
			if err != nil {
				return nil, err
			}
			var paid []bson.M
			if err := cur.All(ctx, &paid); err != nil {
				return nil, err
			}
			by := map[any]float64{}
			for _, p := range paid {
				n, _ := num(p["total"])
				by[p["_id"]] = n
			}
			out := make([]xrow, len(invoices))
			for i, m := range invoices {
				total, _ := num(m["totalAmount"])
				settled := by[m["_id"]]
				out[i] = xrow{"amount": total, "balance": math.Max(0, total-settled), "bill_id": ident(m["_id"]), "due": adDate(m["dueDate"]), "hostel": l.hostel(m["hostelId"]),
					"issued": adDate(m["issuedAt"]), "issued_bs": bsDate(m["issuedAt"]), "kind": words(m["kind"]), "month": text(m["period"]), "paid": settled, "reference": text(m["referenceCode"]),
					"resident": l.resident(m["residentId"]), "resident_id": ident(m["residentId"]), "status": words(m["status"])}
			}
			return out, nil
		}},
	"payments": {cols("payment_id", "Payment ID", "hostel", "", "date", "Date", "date_bs", "Date (BS)", "direction", "In / out", "amount", "Amount (Rs)", "resident_id", "Resident ID", "resident", "Resident",
		"bill_id", "Bill ID", "paid_by", "Paid by", "transaction_id", "Transaction ID", "reference", "Reference", "status", "Status"),
		simple("paymentevents", "occurredAt", strings.Fields("hostelId occurredAt residentId invoiceId direction amount provider providerTxnId referenceCode status"), false,
			func(m bson.M, l lookup) xrow {
				dir := "In"
				if m["direction"] == "DEBIT" {
					dir = "Out"
				}
				return xrow{"amount": amount(m["amount"]), "bill_id": ident(m["invoiceId"]), "date": adDate(m["occurredAt"]), "date_bs": bsDate(m["occurredAt"]), "direction": dir, "hostel": l.hostel(m["hostelId"]),
					"paid_by": words(m["provider"]), "payment_id": ident(m["_id"]), "reference": text(m["referenceCode"]), "resident": l.resident(m["residentId"]), "resident_id": ident(m["residentId"]),
					"status": words(m["status"]), "transaction_id": text(m["providerTxnId"])}
			})},
	"receipts": {cols("receipt_number", "Receipt no", "hostel", "", "issued", "Issued", "issued_bs", "Issued (BS)", "month", "Month (BS)", "resident_id", "Resident ID", "resident", "Resident",
		"bill_id", "Bill ID", "payment_id", "Payment ID", "amount", "Amount (Rs)", "certification_code", "Certification code", "voided", "Voided"),
		simple("receipts", "issuedAt", nil, false, func(m bson.M, l lookup) xrow {
			return xrow{"amount": amount(m["amount"]), "bill_id": ident(m["invoiceId"]), "certification_code": text(m["certificationCode"]), "hostel": l.hostel(m["hostelId"]), "issued": adDate(m["issuedAt"]),
				"issued_bs": bsDate(m["issuedAt"]), "month": text(m["month"]), "payment_id": ident(or(m["eventId"], m["paymentId"])), "receipt_number": text(m["receiptNumber"]),
				"resident": l.resident(m["residentId"]), "resident_id": ident(m["residentId"]), "voided": adDate(m["voidedAt"])}
		})},
	"deposits": {cols("hostel", "", "resident_id", "Resident ID", "resident", "Resident", "amount", "Amount (Rs)", "paid", "Paid on", "status", "Status", "refunded", "Refunded on",
		"refunded_amount", "Refunded (Rs)", "remarks", "Remarks"),
		simple("depositrecords", "paidDate", nil, false, func(m bson.M, l lookup) xrow {
			return xrow{"amount": amount(m["amount"]), "hostel": l.hostel(m["hostelId"]), "paid": adDate(m["paidDate"]), "refunded": adDate(m["refundedDate"]), "refunded_amount": amount(m["refundedAmount"]),
				"remarks": text(m["remarks"]), "resident": l.resident(m["residentId"]), "resident_id": ident(m["residentId"]), "status": words(m["status"])}
		})},
	"khata": {cols("hostel", "", "date", "Date", "resident_id", "Resident ID", "resident", "Resident", "item", "Item", "quantity", "Quantity", "unit_price", "Price (Rs)", "amount", "Amount (Rs)",
		"bill_id", "Billed on (Bill ID)", "status", "Status", "note", "Note"),
		simple("khataentries", "createdAt", nil, false, func(m bson.M, l lookup) xrow {
			return xrow{"amount": amount(m["amount"]), "bill_id": ident(m["invoiceId"]), "date": adDate(m["createdAt"]), "hostel": l.hostel(m["hostelId"]), "item": text(m["name"]), "note": text(m["note"]),
				"quantity": numberOrNil(m["quantity"]), "resident": l.resident(m["residentId"]), "resident_id": ident(m["residentId"]), "status": words(m["status"]), "unit_price": amount(m["unitPrice"])}
		})},
	"expenses": {cols("hostel", "", "date", "Date", "date_bs", "Date (BS)", "category", "Category", "what", "What", "amount", "Amount (Rs)", "paid_by", "Paid by", "recorded_by", "Recorded by", "status", "Status"),
		simple("expenses", "spentOn", strings.Fields("hostelId spentOn category what amount paidBy recordedByName status"), false, func(m bson.M, l lookup) xrow {
			return xrow{"amount": amount(m["amount"]), "category": words(m["category"]), "date": adDate(m["spentOn"]), "date_bs": bsDate(m["spentOn"]), "hostel": l.hostel(m["hostelId"]),
				"paid_by": words(m["paidBy"]), "recorded_by": text(m["recordedByName"]), "status": words(m["status"]), "what": text(m["what"])}
		})},
	"stock": {cols("hostel", "", "date", "Date", "date_bs", "Date (BS)", "kind", "Kind", "item", "Item", "quantity", "Quantity", "unit", "Unit", "rate", "Rate (Rs)", "supplier", "Supplier",
		"bill_no", "Bill no", "status", "Status"),
		func(ctx context.Context, db *mongo.Database, ids bson.A, l lookup) ([]xrow, error) {
			entries, err := find(ctx, db, "stockentries", bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "groupHostelId", Value: in(ids)}}, bson.D{{Key: "hostelId", Value: in(ids)}}}}}, bson.D{{Key: "on", Value: 1}}, nil)
			var out []xrow
			// One row per item on an entry: a bill of five things is five lines.
			for _, e := range entries {
				on := or(e["on"], e["createdAt"])
				lines, _ := e["lines"].(bson.A)
				for _, raw := range lines {
					ln, _ := raw.(bson.M)
					out = append(out, xrow{"bill_no": text(e["billNo"]), "date": adDate(on), "date_bs": bsDate(on), "hostel": l.hostel(e["hostelId"]), "item": text(ln["name"]), "kind": words(e["kind"]),
						"quantity": numberOrNil(ln["qty"]), "rate": amount(ln["rate"]), "status": words(e["status"]), "supplier": text(e["supplier"]), "unit": text(ln["unit"])})
				}
			}
			return out, err
		}},
	"food": {cols("hostel", "", "day", "Day", "meal", "Meal", "time", "Time", "items", "Items", "note", "Note"),
		func(ctx context.Context, db *mongo.Database, ids bson.A, l lookup) ([]xrow, error) {
			cur, err := db.Collection("foodroutines").Find(ctx, bson.D{{Key: "hostelId", Value: in(ids)}})
			if err != nil {
				return nil, err
			}
			var routines []bson.M
			if err := cur.All(ctx, &routines); err != nil {
				return nil, err
			}
			joined := func(v any) any {
				a, _ := v.(bson.A)
				parts := make([]string, 0, len(a))
				for _, x := range a {
					parts = append(parts, fmt.Sprint(x))
				}
				if len(parts) == 0 {
					return nil
				}
				return strings.Join(parts, ", ")
			}
			var out []xrow
			for _, r := range routines {
				timings, _ := r["timings"].(bson.M)
				meals, _ := r["meals"].(bson.A)
				for _, raw := range meals {
					m, _ := raw.(bson.M)
					meal, _ := m["mealType"].(string)
					out = append(out, xrow{"day": words(m["dayOfWeek"]), "hostel": l.hostel(r["hostelId"]), "items": joined(m["items"]), "meal": words(meal), "note": text(m["note"]), "time": text(timings[meal])})
				}
				if sp, ok := r["monthEndSpecial"].(bson.M); ok && joined(sp["items"]) != nil {
					out = append(out, xrow{"day": "Last day of the month", "hostel": l.hostel(r["hostelId"]), "items": joined(sp["items"]), "meal": "Special", "note": text(sp["note"]), "time": nil})
				}
			}
			return out, nil
		}},
	"complaints": {cols("hostel", "", "date", "Date", "date_bs", "Date (BS)", "resident_id", "Resident ID", "resident", "Resident", "category", "Category", "title", "Title", "details", "Details",
		"status", "Status", "reply", "Your reply", "resolved", "Resolved"),
		simple("complaints", "createdAt", nil, false, func(m bson.M, l lookup) xrow {
			var who, whoID any = l.resident(m["residentId"]), ident(m["residentId"])
			if a, _ := m["isAnonymous"].(bool); a {
				who, whoID = "Anonymous", nil
			}
			return xrow{"category": words(m["category"]), "date": adDate(m["createdAt"]), "date_bs": bsDate(m["createdAt"]), "details": text(m["description"]), "hostel": l.hostel(m["hostelId"]),
				"reply": text(m["adminResponse"]), "resident": who, "resident_id": whoID, "resolved": adDate(m["resolvedAt"]), "status": words(m["status"]), "title": text(m["title"])}
		})},
	"repairs": {cols("hostel", "", "date", "Date", "date_bs", "Date (BS)", "trade", "Trade", "title", "Title", "where", "Where", "priority", "Priority", "status", "Status", "completed", "Completed",
		"cost_note", "Cost note"),
		simple("maintenancerequests", "createdAt", nil, true, func(m bson.M, l lookup) xrow {
			return xrow{"completed": adDate(m["completedAt"]), "cost_note": text(m["costNote"]), "date": adDate(m["createdAt"]), "date_bs": bsDate(m["createdAt"]), "hostel": l.hostel(m["hostelId"]),
				"priority": words(m["priority"]), "status": words(m["status"]), "title": text(m["title"]), "trade": words(m["category"]), "where": text(m["location"])}
		})},
	"attendance": {cols("hostel", "", "day", "Day", "recorded", "Recorded (Nepal time)", "resident_id", "Resident ID", "resident", "Resident", "zone", "Zone", "source", "How"),
		simple("attendancelogs", "recordedAt", strings.Fields("hostelId day recordedAt residentId zone source"), false, func(m bson.M, l lookup) xrow {
			return xrow{"day": adDate(or(m["day"], m["recordedAt"])), "hostel": l.hostel(m["hostelId"]), "recorded": adDateTime(m["recordedAt"]), "resident": l.resident(m["residentId"]),
				"resident_id": ident(m["residentId"]), "source": words(m["source"]), "zone": words(m["zone"])}
		})},
	"notices": {cols("hostel", "", "published", "Published", "published_bs", "Published (BS)", "title", "Title", "category", "Category", "notice", "Notice"),
		simple("notices", "createdAt", nil, false, func(m bson.M, l lookup) xrow {
			at := or(m["publishedAt"], m["createdAt"])
			return xrow{"category": words(m["category"]), "hostel": l.hostel(m["hostelId"]), "notice": text(m["content"]), "published": adDate(at), "published_bs": bsDate(at), "title": text(m["title"])}
		})},
	"files": {cols("hostel", "", "uploaded", "Uploaded", "kind", "Kind", "file_name", "File name", "type", "Type", "size_kb", "Size (KB)"),
		simple("fileassets", "createdAt", strings.Fields("hostelId createdAt kind fileName mimeType sizeBytes"), true, func(m bson.M, l lookup) xrow {
			var kb any
			if n, ok := num(m["sizeBytes"]); ok {
				kb = math.Ceil(n / 1024)
			}
			return xrow{"file_name": text(m["fileName"]), "hostel": l.hostel(m["hostelId"]), "kind": words(m["kind"]), "size_kb": kb, "type": text(m["mimeType"]), "uploaded": adDate(m["createdAt"])}
		})},
}

// --- the build ------------------------------------------------------------------------

type sheet struct {
	columns   []xcol
	key       string
	label     string
	rows      []xrow
	truncated bool
}

type exported struct {
	attachments []email.Attachment // workbook + JSON, emailed
	csvZip      email.Attachment
	csvFiles    []email.Attachment
	sheets      []sheet
}

// baseName is leaveExportBaseName: `sunrise-hostel-data-2026-10-21`.
func baseName(slug string, at time.Time) string {
	if slug == "" {
		slug = "hostel"
	}
	return slug + "-data-" + adDate(at).(string)
}

func strField(m bson.M, path ...string) string {
	cur := m
	for i, k := range path {
		if i == len(path)-1 {
			s, _ := cur[k].(string)
			return s
		}
		cur, _ = cur[k].(bson.M)
	}
	return ""
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// buildExport is buildLeaveExport: the workbook and the JSON for the ticked
// sections, in the form's order, plus one CSV per section and their ZIP. A section
// with no rows is still a sheet: "you had none" is an answer.
func buildExport(ctx context.Context, db *mongo.Database, ids []bson.ObjectID, sections []string, slug string) (*exported, error) {
	all := make(bson.A, len(ids))
	for i, id := range ids {
		all[i] = id
	}
	hs, err := find(ctx, db, "hostels", bson.D{{Key: "_id", Value: in(all)}}, bson.D{}, strings.Fields("name location contact panNumber createdAt ownerId"))
	if err != nil {
		return nil, err
	}
	rs, err := find(ctx, db, "residents", bson.D{{Key: "hostelId", Value: in(all)}}, bson.D{}, strings.Fields("firstName lastName"))
	if err != nil {
		return nil, err
	}
	l := lookup{map[string]string{}, map[string]string{}}
	var main bson.M
	for _, h := range hs {
		id, _ := h["_id"].(bson.ObjectID)
		name, _ := h["name"].(string)
		l.hostels[id.Hex()] = name
		if id == ids[0] {
			main = h
		}
	}
	if main == nil && len(hs) > 0 {
		main = hs[0]
	}
	for _, r := range rs {
		id, _ := r["_id"].(bson.ObjectID)
		l.residents[id.Hex()] = fullName(r)
	}
	var owner bson.M
	if oid, ok := main["ownerId"].(bson.ObjectID); ok {
		var o bson.M
		if err := db.Collection("users").FindOne(ctx, bson.D{{Key: "_id", Value: oid}}, options.FindOne().SetProjection(bson.D{{Key: "name", Value: 1}, {Key: "email", Value: 1}, {Key: "phone", Value: 1}})).Decode(&o); err == nil {
			owner = o
		}
	}
	several := len(ids) > 1
	now := time.Now()
	ticked := map[string]bool{}
	for _, s := range sections {
		ticked[s] = true
	}
	var sheets []sheet
	for _, sec := range leaveSections {
		if !ticked[sec.key] {
			continue
		}
		spec := specs[sec.key]
		rows, err := spec.rows(ctx, db, all, l)
		if err != nil {
			return nil, err
		}
		var columns []xcol
		for _, c := range spec.columns {
			if several || c.key != "hostel" {
				columns = append(columns, c)
			}
		}
		sheets = append(sheets, sheet{columns, sec.key, sec.label, rows, len(rows) >= rowCap})
	}

	var addr []string
	for _, k := range []string{"address", "area", "city"} {
		if v := strField(main, "location", k); v != "" {
			addr = append(addr, v)
		}
	}
	buildings := make([]string, len(hs))
	for i, h := range hs {
		buildings[i], _ = h["name"].(string)
	}
	hostelName := strField(main, "name")
	phone := nilIfEmpty(strField(main, "contact", "phone"))
	if phone == nil {
		phone = nilIfEmpty(strField(owner, "phone"))
	}
	coversFrom := adDate(main["createdAt"])
	about := ordered.Map{{Key: "address", Value: nilIfEmpty(strings.Join(addr, ", "))}, {Key: "buildings", Value: buildings}, {Key: "covers_from", Value: coversFrom},
		{Key: "covers_to", Value: adDate(now)}, {Key: "exported_at", Value: adDateTime(now)}, {Key: "hostel", Value: hostelName}, {Key: "owner", Value: nilIfEmpty(strField(owner, "name"))},
		{Key: "owner_email", Value: nilIfEmpty(strField(owner, "email"))}, {Key: "phone", Value: phone}, {Key: "pan", Value: nilIfEmpty(strField(main, "panNumber"))}}

	base := baseName(slug, now)
	book, err := workbook(about, sheets, several, base)
	if err != nil {
		return nil, err
	}
	sectionsJSON := ordered.Map{}
	for _, s := range sheets {
		rows := make([]ordered.Map, len(s.rows))
		for i, r := range s.rows {
			m := make(ordered.Map, 0, len(s.columns))
			for _, c := range s.columns {
				m = append(m, ordered.Pair{Key: c.key, Value: r[c.key]})
			}
			rows[i] = m
		}
		sectionsJSON = append(sectionsJSON, ordered.Pair{Key: s.key, Value: rows})
	}
	doc := ordered.Map{{Key: "about", Value: about}, {Key: "format", Value: ordered.Map{{Key: "dates", Value: "YYYY-MM-DD (Nepal day)"}, {Key: "money", Value: "NPR whole rupees"}, {Key: "months", Value: "Bikram Sambat YYYY-MM"}}},
		{Key: "sections", Value: sectionsJSON}}
	compact, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, compact, "", "  "); err != nil {
		return nil, err
	}

	out := &exported{attachments: []email.Attachment{{Content: book, Filename: base + ".xlsx"}, {Content: pretty.Bytes(), Filename: base + ".json"}}, sheets: sheets}
	for _, s := range sheets {
		columns := make([]export.Column, len(s.columns))
		for i, c := range s.columns {
			columns[i] = export.Column{Key: c.key, Label: c.header}
		}
		rows := make([]map[string]any, len(s.rows))
		for i, r := range s.rows {
			rows[i] = r
		}
		out.csvFiles = append(out.csvFiles, email.Attachment{Content: []byte("\ufeff" + export.CSV(columns, rows)), Filename: base + "-" + s.key + ".csv"})
	}
	var zipped bytes.Buffer
	err = export.Zip(&zipped, func(yield func(export.Entry) bool) {
		for _, f := range out.csvFiles {
			body := f.Content
			if !yield(export.Entry{Name: f.Filename, Date: now, Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }}) {
				return
			}
		}
	})
	if err != nil {
		return nil, err
	}
	out.csvZip = email.Attachment{Content: zipped.Bytes(), Filename: base + "-csv.zip"}
	return out, nil
}

func workbook(about ordered.Map, sheets []sheet, several bool, base string) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()
	get := func(k string) any { v, _ := about.Get(k); return v }
	str := func(v any) string { s, _ := v.(string); return s }
	if err := f.SetSheetName("Sheet1", "About"); err != nil {
		return nil, err
	}
	owner := []string{}
	for _, v := range []any{get("owner"), get("owner_email")} {
		if s := str(v); s != "" {
			owner = append(owner, s)
		}
	}
	from := str(get("covers_from"))
	if from == "" {
		from = "first day"
	}
	grid := [][]any{{str(get("hostel")) + " — data from HostelPalika"}, {}, {"Hostel", get("hostel")}}
	if several {
		grid = append(grid, []any{"Buildings", strings.Join(get("buildings").([]string), ", ")})
	}
	var ownerCell any
	if len(owner) > 0 {
		ownerCell = strings.Join(owner, " · ")
	}
	grid = append(grid, []any{"Address", get("address")}, []any{"Phone", get("phone")}, []any{"PAN / VAT", get("pan")}, []any{"Owner", ownerCell},
		[]any{"Covers", from + " to " + str(get("covers_to"))}, []any{"Exported", str(get("exported_at")) + " (Nepal time)"}, []any{}, []any{"Sheet", "What it holds", "Rows"})
	for _, s := range sheets {
		desc := ""
		for _, sec := range leaveSections {
			if sec.key == s.key {
				desc = sec.description
			}
		}
		var rows any = len(s.rows)
		if s.truncated {
			rows = fmt.Sprintf("%d (first %d only)", len(s.rows), rowCap)
		}
		grid = append(grid, []any{s.label, desc, rows})
	}
	grid = append(grid, []any{}, []any{"How to read it"},
		[]any{"Dates", "YYYY-MM-DD, the day in Nepal. Columns marked (BS) give the same day in Bikram Sambat."},
		[]any{"Months", "Bikram Sambat, YYYY-MM (2083-05 is Bhadra 2083)."},
		[]any{"Money", "Nepali rupees, whole numbers."},
		[]any{"Linking", "Resident ID joins Residents to Bills, Payments, Receipts, Deposits, Khata, Complaints and Attendance. Bill ID and Payment ID join Bills, Payments and Receipts."},
		[]any{"Other software", "The " + base + ".json file attached with this one holds the same data for import."})
	if err := writeGrid(f, "About", grid, []float64{18, 90, 12}); err != nil {
		return nil, err
	}
	for _, s := range sheets {
		if _, err := f.NewSheet(s.label); err != nil {
			return nil, err
		}
		head := make([]any, len(s.columns))
		for i, c := range s.columns {
			head[i] = c.header
		}
		rows := [][]any{head}
		for _, r := range s.rows {
			line := make([]any, len(s.columns))
			for i, c := range s.columns {
				line[i] = r[c.key]
			}
			rows = append(rows, line)
		}
		// Widths from the longest value in the first 500 rows, as columnWidths.
		widths := make([]float64, len(s.columns))
		for i, c := range s.columns {
			w := len([]rune(c.header))
			for j, r := range s.rows {
				if j >= 500 {
					break
				}
				if v := r[c.key]; v != nil {
					w = max(w, len([]rune(export.CellText(v))))
				}
			}
			widths[i] = float64(min(60, w+2))
		}
		if err := writeGrid(f, s.label, rows, widths); err != nil {
			return nil, err
		}
		if len(s.columns) > 0 {
			last, _ := excelize.CoordinatesToCellName(len(s.columns), max(1, len(s.rows)+1))
			_ = f.AutoFilter(s.label, "A1:"+last, nil)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// writeGrid streams the rows, so a 100 000-row sheet is not built cell by cell in memory.
func writeGrid(f *excelize.File, name string, grid [][]any, widths []float64) error {
	sw, err := f.NewStreamWriter(name)
	if err != nil {
		return err
	}
	for i, w := range widths {
		if err := sw.SetColWidth(i+1, i+1, w); err != nil {
			return err
		}
	}
	for i, row := range grid {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := sw.SetRow(cell, row); err != nil {
			return err
		}
	}
	return sw.Flush()
}

// --- keeping the files ---------------------------------------------------------------

func mimeOf(name string) string {
	switch {
	case strings.HasSuffix(name, ".json"):
		return "application/json"
	case strings.HasSuffix(name, ".zip"):
		return "application/zip"
	case strings.HasSuffix(name, ".csv"):
		return "text/csv"
	}
	return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

// storeFiles is storeExportFiles: the records kept in the private bucket for the
// files page. A rebuilt set replaces the old one, whose objects are deleted.
func (h *Handler) storeFiles(ctx context.Context, requestID bson.ObjectID, files []email.Attachment) error {
	if h.R2 == nil {
		return fmt.Errorf("storage not configured")
	}
	bucket, err := h.R2.PrivateBucket()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	stored := make(bson.A, len(files))
	keys := map[string]bool{}
	errs := make(chan error, len(files))
	for i, file := range files {
		key := h.R2.WithKeyPrefix("hostel-leave/" + requestID.Hex() + "/" + file.Filename)
		keys[key] = true
		stored[i] = bson.D{{Key: "bucket", Value: bucket}, {Key: "createdAt", Value: now}, {Key: "fileName", Value: file.Filename}, {Key: "key", Value: key},
			{Key: "mimeType", Value: mimeOf(file.Filename)}, {Key: "sizeBytes", Value: len(file.Content)}, {Key: "_id", Value: bson.NewObjectID()}}
		go func(content []byte, name string) { errs <- h.R2.Put(ctx, bucket, key, content, mimeOf(name), "") }(file.Content, file.Filename)
	}
	for range files {
		if e := <-errs; e != nil && err == nil {
			err = e
		}
	}
	if err != nil {
		return err
	}
	var prev request
	if err := h.DB.Collection("hostelleaverequests").FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: requestID}}, bson.D{{Key: "$set", Value: bson.D{{Key: "exportFiles", Value: stored}}}}).Decode(&prev); err != nil {
		return err
	}
	for _, f := range prev.ExportFiles {
		if f.Key != "" && !keys[f.Key] {
			_ = h.R2.Delete(ctx, f.Bucket, f.Key)
		}
	}
	return nil
}

// scheduleBuild is scheduleExportBuild: at most one build at a time and one every
// ten minutes, after the response. False when the records cannot be built.
func (h *Handler) scheduleBuild(ctx context.Context, req *request) (bool, error) {
	if len(req.Sections) == 0 || h.BG == nil {
		return false, nil
	}
	var hostel struct {
		Slug string `bson:"slug"`
	}
	err := h.DB.Collection("hostels").FindOne(ctx, bson.D{{Key: "_id", Value: req.HostelID}}, options.FindOne().SetProjection(bson.D{{Key: "slug", Value: 1}})).Decode(&hostel)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	res, err := h.DB.Collection("hostelleaverequests").UpdateOne(ctx, bson.D{{Key: "$or", Value: bson.A{bson.D{{Key: "exportBuildStartedAt", Value: bson.D{{Key: "$exists", Value: false}}}},
		bson.D{{Key: "exportBuildStartedAt", Value: bson.D{{Key: "$lt", Value: now.Add(-10 * time.Minute)}}}}}}, {Key: "_id", Value: req.ID}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "exportBuildStartedAt", Value: now}}}})
	if err != nil {
		return false, err
	}
	if res.ModifiedCount == 1 {
		ids := append([]bson.ObjectID{req.HostelID}, req.BranchIDs...)
		id, sections := req.ID, req.Sections
		h.BG.After(ctx, func(ctx context.Context) error {
			out, err := buildExport(ctx, h.DB, ids, sections, hostel.Slug)
			if err == nil {
				err = h.storeFiles(ctx, id, append(append(append([]email.Attachment{}, out.attachments...), out.csvZip), out.csvFiles...))
			}
			if err != nil {
				slog.ErrorContext(ctx, "hostel_leave_records_build_failed", "error", err.Error(), "requestId", id.Hex())
			}
			return nil
		})
	}
	return true, nil
}
