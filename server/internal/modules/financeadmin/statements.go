package financeadmin

// Statement import and reconciliation: read a provider's export, run every credit
// through the matching ladder, settle what a reference code proves, and leave the rest
// for the owner (reconcile.service.ts and statement-import.service.ts in TS).

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/softmato/hostelpalika/server/internal/modules/finance"
	"github.com/softmato/hostelpalika/server/internal/modules/ledger"
	"github.com/softmato/hostelpalika/server/internal/modules/opsscope"
	"github.com/softmato/hostelpalika/server/internal/platform/audit"
	"github.com/softmato/hostelpalika/server/internal/platform/authz"
	"github.com/softmato/hostelpalika/server/internal/platform/httpx"
	"github.com/softmato/hostelpalika/server/internal/platform/money"
	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
	"github.com/softmato/hostelpalika/server/internal/platform/realtime"
	"github.com/softmato/hostelpalika/server/internal/platform/valid"
)

func (h *Handler) registerStatements(v1 *gin.RouterGroup) {
	v1.GET("/hostel-admin/finance/statements", httpx.ETag(), h.listStatements)
	v1.POST("/hostel-admin/finance/statements", h.importStatement)
	v1.GET("/hostel-admin/finance/statements/:id", httpx.ETag(), h.getStatement)
	v1.POST("/hostel-admin/finance/statements/:id/approve-matched", h.approveMatched)
	v1.POST("/hostel-admin/finance/events/:id/assign", h.assignOrphan)
	v1.POST("/hostel-admin/finance/events/:id/ask-resident", h.askResident)
}

func (h *Handler) publishPayments(ctx context.Context, hostel bson.ObjectID) {
	realtime.PublishResourceChange(ctx, h.RT, h.Cache, realtime.Change{HostelIDs: []string{hostel.Hex()}, Topics: []realtime.Topic{realtime.Payments}})
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// ---- list ----

type importRow struct {
	ErrorDetail    *string `json:"errorDetail"`
	FileName       *string `json:"fileName"`
	MatchedCount   int64   `json:"matchedCount"`
	OrphanCount    int64   `json:"orphanCount"`
	Provider       string  `json:"provider"`
	RowCount       int64   `json:"rowCount"`
	StatementID    string  `json:"statementImportId"`
	Status         string  `json:"status"`
	SuggestedCount int64   `json:"suggestedCount"`
	UploadedAt     string  `json:"uploadedAt"`
}

func (h *Handler) listStatements(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	q := valid.Query(c)
	raw := map[string]any{}
	for k, v := range q {
		raw[k] = v
	}
	f := valid.NewForm(raw)
	f.Str("hostelId", valid.S{Opt: true})
	limit, _ := f.Num("limit", valid.N{Opt: true, Int: true, Coerce: true, Min: valid.P(1), Max: valid.P(50), Default: valid.P(20)})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, q["hostelId"])
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cur, err := h.DB.Collection("statementimports").Find(c, bson.D{{Key: "hostelId", Value: hostel}}, options.Find().SetSort(bson.D{{Key: "uploadedAt", Value: -1}}).SetLimit(int64(limit)))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var rows []struct {
		ID             bson.ObjectID `bson:"_id"`
		ErrorDetail    *string       `bson:"errorDetail"`
		FileName       *string       `bson:"fileName"`
		MatchedCount   int64         `bson:"matchedCount"`
		OrphanCount    int64         `bson:"orphanCount"`
		Provider       string        `bson:"provider"`
		RowCount       int64         `bson:"rowCount"`
		Status         string        `bson:"status"`
		SuggestedCount int64         `bson:"suggestedCount"`
		UploadedAt     time.Time     `bson:"uploadedAt"`
	}
	if err := cur.All(c, &rows); err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]importRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, importRow{r.ErrorDetail, r.FileName, r.MatchedCount, r.OrphanCount, r.Provider, r.RowCount, r.ID.Hex(), r.Status, r.SuggestedCount, httpx.ISO(r.UploadedAt)})
	}
	httpx.OK(c, struct {
		Imports []importRow `json:"imports"`
	}{out}, "Statement imports")
}

// ---- import ----

const maxStatementBytes = 10 * 1024 * 1024

type statementAsset struct {
	ID       bson.ObjectID  `bson:"_id"`
	Bucket   string         `bson:"bucket"`
	FileName *string        `bson:"fileName"`
	HostelID *bson.ObjectID `bson:"hostelId"`
	Key      string         `bson:"key"`
	Size     int64          `bson:"sizeBytes"`
	Uploaded *time.Time     `bson:"uploadCompletedAt"`
}

func (h *Handler) loadStatementAsset(ctx context.Context, raw string, hostel bson.ObjectID) (*statementAsset, error) {
	var a *statementAsset
	if id, err := bson.ObjectIDFromHex(raw); err == nil {
		var row statementAsset
		err := h.DB.Collection("fileassets").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "isDeleted", Value: false}, {Key: "status", Value: "ACTIVE"}}).Decode(&row)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			return nil, err
		}
		if err == nil {
			a = &row
		}
	}
	if a == nil || a.HostelID == nil || *a.HostelID != hostel {
		return nil, finance.Err("ASSET_NOT_OWNED", "That file does not belong to this hostel. Upload the statement again.")
	}
	if a.Uploaded == nil {
		return nil, finance.Err("ASSET_UPLOAD_INCOMPLETE", "That file did not finish uploading. Please upload the statement again.")
	}
	if a.Size > maxStatementBytes {
		return nil, finance.Err("AMOUNT_OUT_OF_BOUNDS", "That statement is too large to read. Export a shorter date range.")
	}
	return a, nil
}

// runRecorder is withRun's recorder: counters in first-seen order and the findings.
type runRecorder struct {
	counts   bson.D
	findings []bson.D
	worst    string
}

func (r *runRecorder) count(name string, by int64) {
	for i := range r.counts {
		if r.counts[i].Key == name {
			r.counts[i].Value = r.counts[i].Value.(int64) + by
			return
		}
	}
	r.counts = append(r.counts, bson.E{Key: name, Value: by})
}

func (r *runRecorder) finding(severity, code, detail string) {
	if len(r.findings) < 200 {
		r.findings = append(r.findings, bson.D{{Key: "code", Value: code}, {Key: "detail", Value: detail}, {Key: "entityId", Value: nil}, {Key: "entityType", Value: ""}, {Key: "severity", Value: severity}})
	}
	if severity != "INFO" {
		r.worst = "WARN"
	}
}

func jsCounts(d bson.D) bson.D {
	out := make(bson.D, len(d))
	for i, e := range d {
		out[i] = bson.E{Key: e.Key, Value: ledger.JSInt(e.Value.(int64))}
	}
	return out
}

func parseFailure(err error) string {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Message
	}
	return "This file could not be read."
}

type importSummary struct {
	CreditCount    int     `json:"creditCount"`
	DuplicateCount int     `json:"duplicateCount"`
	FileName       *string `json:"fileName"`
	MatchedCount   int     `json:"matchedCount"`
	OrphanCount    int     `json:"orphanCount"`
	ParserVersion  string  `json:"parserVersion"`
	PeriodEnd      string  `json:"periodEnd"`
	PeriodStart    string  `json:"periodStart"`
	Provider       string  `json:"provider"`
	RowCount       int     `json:"rowCount"`
	RunID          string  `json:"runId"`
	StatementID    string  `json:"statementImportId"`
	Status         string  `json:"status"`
	SuggestedCount int     `json:"suggestedCount"`
}

func (h *Handler) importStatement(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
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
	assetID, _ := f.Str("assetId", valid.S{Trim: true, Min: 1})
	requested, _ := f.Str("hostelId", valid.S{Opt: true})
	provider, _ := f.Enum("provider", false, nil, "ESEWA", "KHALTI", "BANK")
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	hostel, err := opsscope.HostelID(p, requested)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.runImport(c, p, hostel, assetID, provider)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Statement read")
}

func (h *Handler) runImport(ctx context.Context, p *authz.Principal, hostel bson.ObjectID, assetID, provider string) (*importSummary, error) {
	asset, err := h.loadStatementAsset(ctx, assetID, hostel)
	if err != nil {
		return nil, err
	}
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		return nil, err
	}
	imports := h.DB.Collection("statementimports")
	at := nowMS()
	var fileName any
	if asset.FileName != nil {
		fileName = *asset.FileName
	}
	id := bson.NewObjectID()
	if _, err := imports.InsertOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: hostel}, {Key: "uploadedBy", Value: me}, {Key: "uploadedAt", Value: at}, {Key: "sourceAssetId", Value: asset.ID},
		{Key: "fileName", Value: fileName}, {Key: "provider", Value: provider}, {Key: "parserVersion", Value: "unknown"}, {Key: "rowCount", Value: 0}, {Key: "creditCount", Value: 0}, {Key: "duplicateCount", Value: 0},
		{Key: "matchedCount", Value: 0}, {Key: "suggestedCount", Value: 0}, {Key: "orphanCount", Value: 0}, {Key: "status", Value: "PARSING"}, {Key: "createdAt", Value: at}, {Key: "updatedAt", Value: at}, {Key: "__v", Value: 0}}); err != nil {
		return nil, err
	}
	// fail closes the import so it never sits in PARSING (TS left it there when a row threw).
	fail := func(err error) error {
		done := nowMS()
		if _, uerr := imports.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "completedAt", Value: done}, {Key: "errorDetail", Value: parseFailure(err)}, {Key: "status", Value: "FAILED"}, {Key: "updatedAt", Value: done}}}}); uerr != nil {
			slog.ErrorContext(ctx, "could not mark statement import failed", "id", id.Hex(), "error", uerr)
		}
		return err
	}
	rd, err := h.R2.Get(ctx, asset.Bucket, asset.Key)
	if err != nil {
		return nil, fail(err)
	}
	bytes, err := io.ReadAll(rd)
	rd.Close()
	if err != nil || len(bytes) == 0 {
		return nil, fail(finance.Err("STATEMENT_UNREADABLE", "The uploaded statement could not be read back."))
	}
	parser, err := finance.ResolveStmtParser(provider, bytes)
	if err != nil {
		return nil, fail(err)
	}
	table, err := finance.ReadStmtTable(bytes, parser.Anchors)
	if err != nil {
		return nil, fail(err)
	}
	rows, err := parser.Parse(table)
	if err != nil {
		return nil, fail(err)
	}
	if _, err := imports.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "parserVersion", Value: parser.Version}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		return nil, fail(err)
	}
	var credits []finance.StmtRow
	start, end := rows[0].OccurredAt, rows[0].OccurredAt
	for _, r := range rows {
		if r.Direction == "CREDIT" {
			credits = append(credits, r)
		}
		if r.OccurredAt.Before(start) {
			start = r.OccurredAt
		}
		if r.OccurredAt.After(end) {
			end = r.OccurredAt
		}
	}

	runs := h.DB.Collection("reconciliationruns")
	runID := bson.NewObjectID()
	started := nowMS()
	if _, err := runs.InsertOne(ctx, bson.D{{Key: "_id", Value: runID}, {Key: "hostelId", Value: hostel}, {Key: "kind", Value: "STATEMENT_MATCH"}, {Key: "startedAt", Value: started}, {Key: "status", Value: "RUNNING"},
		{Key: "counters", Value: bson.D{}}, {Key: "findings", Value: bson.A{}}, {Key: "triggeredBy", Value: p.UserID}, {Key: "createdAt", Value: started}, {Key: "updatedAt", Value: started}, {Key: "__v", Value: 0}}); err != nil {
		return nil, fail(err)
	}
	rec := &runRecorder{}
	closeRun := func(status, detail string) {
		finished := nowMS()
		set := bson.D{{Key: "counters", Value: jsCounts(rec.counts)}, {Key: "findings", Value: orEmpty(rec.findings)}, {Key: "finishedAt", Value: finished}, {Key: "status", Value: status}, {Key: "updatedAt", Value: finished}}
		if detail != "" {
			set = append(set, bson.E{Key: "errorDetail", Value: detail})
		}
		if _, err := runs.UpdateOne(ctx, bson.D{{Key: "_id", Value: runID}}, bson.D{{Key: "$set", Value: set}}); err != nil {
			slog.ErrorContext(ctx, "could not close reconciliation run", "id", runID.Hex(), "error", err)
		}
	}
	rec.count("scanned", int64(len(rows)))
	rec.count("credits", int64(len(credits)))
	known, err := h.knownTxnIDs(ctx, hostel, provider, credits)
	if err != nil {
		closeRun("FAIL", err.Error())
		return nil, fail(err)
	}
	var fresh []finance.StmtRow
	for _, r := range credits {
		if !known[r.ProviderTxnID] {
			fresh = append(fresh, r)
		}
	}
	duplicates := len(credits) - len(fresh)
	rec.count("duplicates", int64(duplicates))
	mc, err := finance.LoadMatchContext(ctx, h.DB, hostel)
	if err != nil {
		closeRun("FAIL", err.Error())
		return nil, fail(err)
	}
	var matched, orphan, suggested int
	for i := range fresh {
		row := &fresh[i]
		cl := finance.ClassifyCredit(row, mc)
		// One bad row must not strand the rest of the file: it is a finding, and an
		// event already written stays PENDING for "Approve all" to finish.
		if err := h.ingestRow(ctx, p, hostel, id, provider, row, cl); err != nil {
			rec.count("failed", 1)
			rec.finding("ERROR", "ROW_FAILED", "row "+itoa(row.RowNumber)+" ("+row.ProviderTxnID+"): "+parseFailure(err))
			slog.ErrorContext(ctx, "statement row failed", "statement", id.Hex(), "row", row.RowNumber, "error", err)
			continue
		}
		switch cl.Tier {
		case "B":
			matched++
			rec.count("matched", 1)
		case "C":
			suggested++
			rec.count("suggested", 1)
		default:
			orphan++
			rec.count("orphan", 1)
			rec.finding("WARN", "UNMATCHED_CREDIT", itoa(int(row.Amount))+" on "+row.OccurredAt.Format("2006-01-02")+": "+cl.Why)
		}
	}
	status := "OK"
	if rec.worst != "" {
		status = rec.worst
	}
	closeRun(status, "")

	done := nowMS()
	if _, err := imports.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}}, bson.D{{Key: "$set", Value: bson.D{{Key: "completedAt", Value: done}, {Key: "creditCount", Value: len(credits)}, {Key: "duplicateCount", Value: duplicates},
		{Key: "matchedCount", Value: matched}, {Key: "orphanCount", Value: orphan}, {Key: "periodEnd", Value: end}, {Key: "periodStart", Value: start}, {Key: "rowCount", Value: len(rows)}, {Key: "status", Value: "READY"},
		{Key: "suggestedCount", Value: suggested}, {Key: "updatedAt", Value: done}}}}); err != nil {
		return nil, fail(err)
	}
	if _, err := h.DB.Collection("hostelpaymentprofiles").UpdateOne(ctx, bson.D{{Key: "hostelId", Value: hostel}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lastStatementUploadAt", Value: done}, {Key: "updatedAt", Value: done}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "hostelId", Value: hostel}, {Key: "createdAt", Value: done}, {Key: "__v", Value: 0}}}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return nil, err
	}
	if err := h.Audit.WriteFinance(ctx, me, string(p.Role), audit.Finance{Action: "STATEMENT_IMPORTED", EntityID: id.Hex(), EntityType: "StatementImport", HostelID: hostel, Source: "STATEMENT_IMPORT"}); err != nil {
		return nil, err
	}
	h.publishPayments(ctx, hostel)
	return &importSummary{CreditCount: len(credits), DuplicateCount: duplicates, FileName: asset.FileName, MatchedCount: matched, OrphanCount: orphan, ParserVersion: parser.Version, PeriodEnd: httpx.ISO(end), PeriodStart: httpx.ISO(start),
		Provider: provider, RowCount: len(rows), RunID: runID.Hex(), StatementID: id.Hex(), Status: "READY", SuggestedCount: suggested}, nil
}

func (h *Handler) knownTxnIDs(ctx context.Context, hostel bson.ObjectID, provider string, credits []finance.StmtRow) (map[string]bool, error) {
	out := map[string]bool{}
	if len(credits) == 0 {
		return out, nil
	}
	ids := make(bson.A, 0, len(credits))
	for _, r := range credits {
		ids = append(ids, r.ProviderTxnID)
	}
	cur, err := h.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "hostelId", Value: hostel}, {Key: "provider", Value: provider}, {Key: "providerTxnId", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "providerTxnId", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID *string `bson:"providerTxnId"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		if r.ID != nil && *r.ID != "" {
			out[*r.ID] = true
		}
	}
	return out, nil
}

func oidPtr(s string) *bson.ObjectID {
	if id, err := bson.ObjectIDFromHex(s); err == nil && s != "" {
		return &id
	}
	return nil
}

// ingestRow records one credit as a PENDING event and, when the ladder proves it, settles it.
func (h *Handler) ingestRow(ctx context.Context, p *authz.Principal, hostel, statement bson.ObjectID, provider string, row *finance.StmtRow, cl finance.Classification) error {
	var invoice, resident *bson.ObjectID
	ref := ""
	var claim *finance.Claim
	switch cl.Tier {
	case "B":
		invoice, resident, ref = oidPtr(cl.Invoice.InvoiceID), oidPtr(cl.Invoice.ResidentID), *cl.Invoice.ReferenceCode
	case "C":
		claim = cl.Claim
		if claim != nil {
			invoice, resident = oidPtr(claim.InvoiceID), oidPtr(claim.ResidentID)
		}
	}
	rowDoc := bson.D{}
	for _, k := range row.Raw.Keys {
		rowDoc = append(rowDoc, bson.E{Key: k, Value: row.Raw.Vals[k]})
	}
	var party, remarks any
	if row.CounterpartyName != nil {
		party = *row.CounterpartyName
	}
	if row.Remarks != nil {
		remarks = *row.Remarks
	}
	sugg := bson.A{}
	if cl.Tier == "C" {
		for _, s := range cl.Suggestions {
			sugg = append(sugg, bson.D{{Key: "confidence", Value: s.Confidence}, {Key: "invoiceId", Value: s.Candidate.InvoiceID}, {Key: "residentId", Value: s.Candidate.ResidentID},
				{Key: "residentName", Value: s.Candidate.ResidentName}, {Key: "score", Value: s.Score}, {Key: "why", Value: s.Why}})
		}
	}
	raw := bson.D{{Key: "counterpartyName", Value: party}, {Key: "ladderTier", Value: cl.Tier}, {Key: "ladderWhy", Value: cl.Why}, {Key: "remarks", Value: remarks}, {Key: "row", Value: rowDoc},
		{Key: "rowNumber", Value: row.RowNumber}, {Key: "suggestions", Value: sugg}}
	if claim != nil {
		raw = append(raw, bson.E{Key: "claimEventId", Value: claim.EventID})
		if claim.Settled {
			raw = append(raw, bson.E{Key: "confirmsClaimEventId", Value: claim.EventID})
		}
	}
	ev, created, err := h.Ledger.AppendEvent(ctx, ledger.AppendInput{Amount: row.Amount, Confirmation: "UNCONFIRMED", HostelID: hostel,
		IdempotencyKey: "statement:" + statement.Hex() + ":" + provider + ":" + row.ProviderTxnID, InvoiceID: invoice, OccurredAt: row.OccurredAt, Provider: provider, ProviderTxnID: row.ProviderTxnID,
		RawPayload: raw, ReferenceCode: ref, ResidentID: resident, Source: "STATEMENT_IMPORT", StatementID: &statement, Status: "PENDING"})
	if err != nil || !created {
		return err
	}
	if claim != nil && claim.Settled {
		cid, err := bson.ObjectIDFromHex(claim.EventID)
		if err != nil {
			return err
		}
		_, err = h.Ledger.ConfirmByStatement(ctx, cid, &statement, p)
		return err
	}
	if cl.Tier != "B" {
		return nil
	}
	_, err = h.Ledger.SettleEvent(ctx, ev.ID, ledger.SettleOptions{Confirmation: "STATEMENT_MATCH", Principal: p, SettledAt: row.OccurredAt})
	return err
}

// ---- reconciliation ----

type matchedRow struct {
	Amount        int64   `json:"amount"`
	ClaimEventID  *string `json:"claimEventId"`
	ConfirmsClaim bool    `json:"confirmsClaim"`
	EventID       string  `json:"eventId"`
	OccurredAt    string  `json:"occurredAt"`
	Period        *string `json:"period"`
	ProviderTxn   *string `json:"providerTxnId"`
	ReferenceCode *string `json:"referenceCode"`
	ResidentName  string  `json:"residentName"`
	Status        string  `json:"status"`
	Why           string  `json:"why"`
}

type orphanRow struct {
	Amount       int64   `json:"amount"`
	Counterparty any     `json:"counterpartyName"`
	EventID      string  `json:"eventId"`
	OccurredAt   string  `json:"occurredAt"`
	ProviderTxn  *string `json:"providerTxnId"`
	Remarks      any     `json:"remarks"`
	Suggestions  any     `json:"suggestions"`
}

type claimedRow struct {
	Amount          int64   `json:"amount"`
	BedLabel        any     `json:"bedLabel"`
	ClaimEventID    string  `json:"claimEventId"`
	Period          *string `json:"period"`
	ResidentID      string  `json:"residentId"`
	ResidentName    string  `json:"residentName"`
	TransactionCode any     `json:"transactionCode"`
	Why             string  `json:"why"`
}

type approvedRow struct {
	Amount          int64   `json:"amount"`
	ApprovedAt      any     `json:"approvedAt"`
	ApprovedByName  any     `json:"approvedByName"`
	ClaimEventID    string  `json:"claimEventId"`
	Period          *string `json:"period"`
	ResidentID      string  `json:"residentId"`
	ResidentName    string  `json:"residentName"`
	TransactionCode any     `json:"transactionCode"`
	Why             string  `json:"why"`
}

type buckets struct {
	Approved []approvedRow `json:"approvedNotInStatement"`
	Claimed  []claimedRow  `json:"claimedNoTransaction"`
	Matched  []matchedRow  `json:"matched"`
	Orphans  []orphanRow   `json:"orphans"`
}

type reconciliation struct {
	Buckets       buckets `json:"buckets"`
	FileName      *string `json:"fileName"`
	MatchedTotal  int64   `json:"matchedTotal"`
	ParserVersion string  `json:"parserVersion"`
	PeriodEnd     any     `json:"periodEnd"`
	PeriodStart   any     `json:"periodStart"`
	Provider      string  `json:"provider"`
	RowCount      int64   `json:"rowCount"`
	StatementID   string  `json:"statementImportId"`
	Status        string  `json:"status"`
	UploadedAt    string  `json:"uploadedAt"`
}

func optStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (h *Handler) settledAmong(ctx context.Context, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	var oids bson.A
	for _, s := range ids {
		if id, err := bson.ObjectIDFromHex(s); err == nil {
			oids = append(oids, id)
		}
	}
	if len(oids) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: oids}}}, {Key: "status", Value: "SETTLED"}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID bson.ObjectID `bson:"_id"`
	}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID.Hex()] = true
	}
	return out, nil
}

func (h *Handler) getReconciliation(ctx context.Context, rawID string, p *authz.Principal) (*reconciliation, bson.ObjectID, error) {
	var zero bson.ObjectID
	id, err := bson.ObjectIDFromHex(rawID)
	if err != nil {
		id = bson.NewObjectID() // as TS: an unusable id is "not found", not a 404 cast error
	}
	var rec struct {
		ID            bson.ObjectID `bson:"_id"`
		FileName      *string       `bson:"fileName"`
		HostelID      bson.ObjectID `bson:"hostelId"`
		ParserVersion string        `bson:"parserVersion"`
		PeriodEnd     *time.Time    `bson:"periodEnd"`
		PeriodStart   *time.Time    `bson:"periodStart"`
		Provider      string        `bson:"provider"`
		RowCount      int64         `bson:"rowCount"`
		Status        string        `bson:"status"`
		UploadedAt    time.Time     `bson:"uploadedAt"`
	}
	err = h.DB.Collection("statementimports").FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeOf(p)}}}}).Decode(&rec)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, zero, finance.Err("STATEMENT_NOT_FOUND", "That statement import was not found.")
	}
	if err != nil {
		return nil, zero, err
	}
	if rec.Status != "READY" {
		if rec.Status == "FAILED" {
			return nil, zero, finance.Err("STATEMENT_NOT_READY", "That statement could not be read, so it has nothing to reconcile.")
		}
		return nil, zero, finance.Err("STATEMENT_NOT_READY", "That statement is still being read.")
	}
	cur, err := h.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "statementImportId", Value: rec.ID}}, options.Find().SetSort(bson.D{{Key: "occurredAt", Value: 1}}))
	if err != nil {
		return nil, zero, err
	}
	var events []struct {
		ID            bson.ObjectID  `bson:"_id"`
		Amount        int64          `bson:"amount"`
		InvoiceID     *bson.ObjectID `bson:"invoiceId"`
		OccurredAt    time.Time      `bson:"occurredAt"`
		ProviderTxnID *string        `bson:"providerTxnId"`
		Raw           bson.Raw       `bson:"rawPayload"`
		ReferenceCode *string        `bson:"referenceCode"`
		ResidentID    *bson.ObjectID `bson:"residentId"`
		Status        string         `bson:"status"`
	}
	if err := cur.All(ctx, &events); err != nil {
		return nil, zero, err
	}
	var resIDs, invIDs bson.A
	var claimIDs []string
	for _, e := range events {
		if e.ResidentID != nil {
			resIDs = append(resIDs, *e.ResidentID)
		}
		if e.InvoiceID != nil {
			invIDs = append(invIDs, *e.InvoiceID)
		}
		if s, ok := e.Raw.Lookup("claimEventId").StringValueOK(); ok && s != "" {
			claimIDs = append(claimIDs, s)
		}
	}
	names, err := h.residentNames(ctx, resIDs)
	if err != nil {
		return nil, zero, err
	}
	periods := map[string]*string{}
	if len(invIDs) > 0 {
		cur, err := h.DB.Collection("invoices").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: invIDs}}}}, options.Find().SetProjection(bson.D{{Key: "period", Value: 1}}))
		if err != nil {
			return nil, zero, err
		}
		var rows []struct {
			ID     bson.ObjectID `bson:"_id"`
			Period *string       `bson:"period"`
		}
		if err := cur.All(ctx, &rows); err != nil {
			return nil, zero, err
		}
		for _, r := range rows {
			periods[r.ID.Hex()] = r.Period
		}
	}
	settledClaims, err := h.settledAmong(ctx, claimIDs)
	if err != nil {
		return nil, zero, err
	}
	str := func(raw bson.Raw, key string) (string, bool) { return raw.Lookup(key).StringValueOK() }
	bk := buckets{Approved: []approvedRow{}, Claimed: []claimedRow{}, Matched: []matchedRow{}, Orphans: []orphanRow{}}
	var rows []finance.StmtRow
	for _, e := range events {
		tier, _ := str(e.Raw, "ladderTier")
		claimID, hasClaim := str(e.Raw, "claimEventId")
		hasClaim = hasClaim && claimID != ""
		cid, _ := str(e.Raw, "confirmsClaimEventId")
		confirms := cid != ""
		var party, remarks *string
		if s, ok := str(e.Raw, "counterpartyName"); ok {
			party = &s
		}
		if s, ok := str(e.Raw, "remarks"); ok {
			remarks = &s
		}
		txn := ""
		if e.ProviderTxnID != nil {
			txn = *e.ProviderTxnID
		}
		rows = append(rows, finance.StmtRow{Amount: e.Amount, CounterpartyName: party, Direction: "CREDIT", OccurredAt: e.OccurredAt, ProviderTxnID: txn, Remarks: remarks})
		if tier == "B" || hasClaim {
			m := matchedRow{Amount: e.Amount, ConfirmsClaim: confirms || hasClaim && settledClaims[claimID], EventID: e.ID.Hex(), OccurredAt: httpx.ISO(e.OccurredAt), ProviderTxn: e.ProviderTxnID, ReferenceCode: e.ReferenceCode, Status: e.Status}
			if hasClaim {
				m.ClaimEventID = &claimID
			}
			if e.InvoiceID != nil {
				m.Period = periods[e.InvoiceID.Hex()]
			}
			if e.ResidentID != nil {
				m.ResidentName = names[e.ResidentID.Hex()]
			}
			m.Why, _ = str(e.Raw, "ladderWhy")
			bk.Matched = append(bk.Matched, m)
			continue
		}
		if e.Status == "PENDING" {
			o := orphanRow{Amount: e.Amount, EventID: e.ID.Hex(), OccurredAt: httpx.ISO(e.OccurredAt), ProviderTxn: e.ProviderTxnID, Suggestions: []any{}}
			if party != nil {
				o.Counterparty = *party
			}
			if remarks != nil {
				o.Remarks = *remarks
			}
			if rv := e.Raw.Lookup("suggestions"); rv.Type == bson.TypeArray {
				o.Suggestions = ordered.FromBSON(rv)
			}
			bk.Orphans = append(bk.Orphans, o)
		}
	}
	mc, err := finance.LoadMatchContext(ctx, h.DB, rec.HostelID)
	if err != nil {
		return nil, zero, err
	}
	unmatched := finance.FindOrphanClaims(mc, rows, rec.PeriodEnd)
	var approvedIDs []string
	for _, o := range unmatched {
		if o.Claim.Settled {
			approvedIDs = append(approvedIDs, o.Claim.EventID)
		}
	}
	approvers, err := h.approverNames(ctx, approvedIDs)
	if err != nil {
		return nil, zero, err
	}
	for _, o := range unmatched {
		cl := o.Claim
		if !cl.Settled {
			var bed any
			for _, inv := range mc.Open {
				if inv.ResidentID == cl.ResidentID {
					bed = inv.BedLabel
					break
				}
			}
			bk.Claimed = append(bk.Claimed, claimedRow{cl.Amount, bed, cl.EventID, cl.Period, cl.ResidentID, cl.ResidentName, optStr(cl.TransactionCode), o.Why})
			continue
		}
		a := approvers[cl.EventID]
		bk.Approved = append(bk.Approved, approvedRow{cl.Amount, a.at, a.name, cl.EventID, cl.Period, cl.ResidentID, cl.ResidentName, optStr(cl.TransactionCode), o.Why})
	}
	var total int64
	for _, m := range bk.Matched {
		total += m.Amount
	}
	out := &reconciliation{Buckets: bk, FileName: rec.FileName, MatchedTotal: total, ParserVersion: rec.ParserVersion, Provider: rec.Provider, RowCount: rec.RowCount, StatementID: rec.ID.Hex(), Status: rec.Status, UploadedAt: httpx.ISO(rec.UploadedAt)}
	out.PeriodEnd, out.PeriodStart = isoOrNil(rec.PeriodEnd), isoOrNil(rec.PeriodStart)
	return out, rec.HostelID, nil
}

type approver struct{ name, at any }

func (h *Handler) approverNames(ctx context.Context, eventIDs []string) (map[string]approver, error) {
	out := map[string]approver{}
	var oids bson.A
	for _, s := range eventIDs {
		if id, err := bson.ObjectIDFromHex(s); err == nil {
			oids = append(oids, id)
		}
	}
	if len(oids) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection("paymentevents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: oids}}}}, options.Find().SetProjection(bson.D{{Key: "reviewedAt", Value: 1}, {Key: "reviewedBy", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var evs []struct {
		ID         bson.ObjectID  `bson:"_id"`
		ReviewedAt *time.Time     `bson:"reviewedAt"`
		ReviewedBy *bson.ObjectID `bson:"reviewedBy"`
	}
	if err := cur.All(ctx, &evs); err != nil {
		return nil, err
	}
	var uids bson.A
	for _, e := range evs {
		if e.ReviewedBy != nil {
			uids = append(uids, *e.ReviewedBy)
		}
	}
	names := map[string]*string{}
	if len(uids) > 0 {
		cur, err := h.DB.Collection("users").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: uids}}}}, options.Find().SetProjection(bson.D{{Key: "name", Value: 1}}))
		if err != nil {
			return nil, err
		}
		var us []struct {
			ID   bson.ObjectID `bson:"_id"`
			Name *string       `bson:"name"`
		}
		if err := cur.All(ctx, &us); err != nil {
			return nil, err
		}
		for _, u := range us {
			names[u.ID.Hex()] = u.Name
		}
	}
	for _, e := range evs {
		a := approver{}
		if e.ReviewedBy != nil {
			if n := names[e.ReviewedBy.Hex()]; n != nil {
				a.name = *n
			}
		}
		a.at = isoOrNil(e.ReviewedAt)
		out[e.ID.Hex()] = a
	}
	return out, nil
}

func (h *Handler) residentNames(ctx context.Context, ids bson.A) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := h.DB.Collection("residents").Find(ctx, bson.D{{Key: "_id", Value: bson.D{{Key: "$in", Value: ids}}}}, options.Find().SetProjection(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rs []struct {
		ID    bson.ObjectID `bson:"_id"`
		First string        `bson:"firstName"`
		Last  string        `bson:"lastName"`
	}
	if err := cur.All(ctx, &rs); err != nil {
		return nil, err
	}
	for _, r := range rs {
		n := r.First
		if r.First != "" && r.Last != "" {
			n += " "
		}
		out[r.ID.Hex()] = n + r.Last
	}
	return out, nil
}

func (h *Handler) getStatement(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, _, err := h.getReconciliation(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out, "Reconciliation")
}

func (h *Handler) approveMatched(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	view, _, err := h.getReconciliation(c, c.Param("id"), p)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var pending []matchedRow
	var claimIDs []string
	for _, m := range view.Buckets.Matched {
		if m.Status == "PENDING" && !m.ConfirmsClaim {
			pending = append(pending, m)
			if m.ClaimEventID != nil {
				claimIDs = append(claimIDs, *m.ClaimEventID)
			}
		}
	}
	settled, err := h.settledAmong(c, claimIDs)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	approved, skipped := 0, 0
	for _, m := range pending {
		if m.ClaimEventID != nil && settled[*m.ClaimEventID] {
			skipped++
			continue
		}
		id, err := bson.ObjectIDFromHex(m.EventID)
		if err == nil {
			_, err = h.Ledger.SettleEvent(c, id, ledger.SettleOptions{Confirmation: "STATEMENT_MATCH", Principal: p})
		}
		if err != nil {
			skipped++
			if !errors.Is(err, ledger.ErrNotPending) {
				slog.WarnContext(c, "approve-matched skipped a row", "event", m.EventID, "error", err)
			}
			continue
		}
		approved++
	}
	httpx.OK(c, struct {
		Approved int `json:"approved"`
		Skipped  int `json:"skipped"`
	}{approved, skipped}, "Payments approved")
}

func (h *Handler) assignOrphan(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "approvePayments")
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
	f.Str("hostelId", valid.S{Opt: true})
	invoiceRaw, _ := f.Str("invoiceId", valid.S{Trim: true, Min: 1})
	if err := f.Err(); err != nil {
		httpx.Fail(c, err)
		return
	}
	eid, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		eid = bson.NewObjectID()
	}
	var ev struct {
		ID       bson.ObjectID `bson:"_id"`
		Amount   int64         `bson:"amount"`
		HostelID bson.ObjectID `bson:"hostelId"`
		Status   string        `bson:"status"`
	}
	err = h.DB.Collection("paymentevents").FindOne(c, bson.D{{Key: "_id", Value: eid}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeOf(p)}}}, {Key: "source", Value: "STATEMENT_IMPORT"}}).Decode(&ev)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, finance.Err("EVENT_NOT_FOUND", "That payment was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if ev.Status != "PENDING" {
		httpx.Fail(c, finance.Err("EVENT_ALREADY_ASSIGNED", "That payment has already been assigned."))
		return
	}
	iid, err := bson.ObjectIDFromHex(invoiceRaw)
	if err != nil {
		iid = bson.NewObjectID()
	}
	var inv struct {
		ID         bson.ObjectID `bson:"_id"`
		ResidentID bson.ObjectID `bson:"residentId"`
	}
	err = h.DB.Collection("invoices").FindOne(c, bson.D{{Key: "_id", Value: iid}, {Key: "hostelId", Value: ev.HostelID}}).Decode(&inv)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, finance.Err("INVOICE_NOT_FOUND", "That invoice was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if _, err := h.DB.Collection("paymentevents").UpdateOne(c, bson.D{{Key: "_id", Value: ev.ID}, {Key: "status", Value: "PENDING"}}, bson.D{{Key: "$set", Value: bson.D{{Key: "invoiceId", Value: inv.ID}, {Key: "residentId", Value: inv.ResidentID}, {Key: "updatedAt", Value: nowMS()}}}}); err != nil {
		httpx.Fail(c, err)
		return
	}
	s, err := h.Ledger.SettleEvent(c, ev.ID, ledger.SettleOptions{Confirmation: "MANUAL_REVIEW", Principal: p})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.publishPayments(c, ev.HostelID)
	settled := ev.Amount
	if s.Balance != nil {
		settled = s.Balance.SettledAmount
	}
	httpx.OK(c, struct {
		EventID       string `json:"eventId"`
		SettledAmount int64  `json:"settledAmount"`
	}{ev.ID.Hex(), settled}, "Payment assigned")
}

func (h *Handler) askResident(c *gin.Context) {
	p, err := h.Guards.RequireHostelCapability(c, "viewPayments")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		id = bson.NewObjectID()
	}
	var cl struct {
		ID         bson.ObjectID  `bson:"_id"`
		Amount     int64          `bson:"amount"`
		HostelID   bson.ObjectID  `bson:"hostelId"`
		ResidentID *bson.ObjectID `bson:"residentId"`
	}
	err = h.DB.Collection("paymentevents").FindOne(c, bson.D{{Key: "_id", Value: id}, {Key: "hostelId", Value: bson.D{{Key: "$in", Value: scopeOf(p)}}}, {Key: "source", Value: "RESIDENT_CLAIM"}}).Decode(&cl)
	if errors.Is(err, mongo.ErrNoDocuments) {
		httpx.Fail(c, finance.Err("CLAIM_NOT_FOUND", "Payment claim was not found."))
		return
	}
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	type notified struct {
		Notified bool `json:"notified"`
	}
	var res struct {
		UserID *bson.ObjectID `bson:"userId"`
	}
	if cl.ResidentID != nil {
		err := h.DB.Collection("residents").FindOne(c, bson.D{{Key: "_id", Value: *cl.ResidentID}, {Key: "isDeleted", Value: false}}, options.FindOne().SetProjection(bson.D{{Key: "userId", Value: 1}})).Decode(&res)
		if err != nil && !errors.Is(err, mongo.ErrNoDocuments) {
			httpx.Fail(c, err)
			return
		}
	}
	if res.UserID == nil {
		httpx.OK(c, notified{false}, "Resident asked")
		return
	}
	h.Ledger.NotifyResident(c, cl.HostelID, *cl.ResidentID, "Please confirm your payment details",
		"We could not find your payment of NPR "+money.GroupIN(cl.Amount)+" in our account statement. Please check the transaction ID and send a clearer screenshot.", nil)
	me, err := httpx.OID(p.UserID, "user id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.Audit.WriteFinance(c, me, string(p.Role), audit.Finance{Action: "PAYMENT_CLAIM_QUERIED", AmountBefore: cl.Amount, AmountAfter: cl.Amount, EntityID: cl.ID.Hex(), EntityType: "PaymentEvent", EventID: cl.ID.Hex(), HostelID: cl.HostelID, Source: "STATEMENT_RECONCILE"}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, notified{true}, "Resident asked")
}
