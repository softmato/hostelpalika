package finance

// Statement parsers: eSewa, Khalti and bank exports read into rows (statements/parsers
// in the TS server). A table is a header row found inside the first lines of a sheet
// or CSV; the provider's parser then reads each row, refusing anything it does not
// fully understand rather than guessing.

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
)

// StmtRow is one transaction line of a statement.
type StmtRow struct {
	Amount           int64
	CounterpartyName *string
	Direction        string // CREDIT | DEBIT
	OccurredAt       time.Time
	ProviderTxnID    string
	Raw              *StmtRecord
	Remarks          *string
	RowNumber        int
}

// StmtRecord is one table row: values by header, in header order.
type StmtRecord struct {
	Keys []string
	Vals map[string]string
}

// StmtTable is a header row and the records under it.
type StmtTable struct {
	Headers []string
	Rows    []*StmtRecord
}

// StmtParser reads one provider's table.
type StmtParser struct {
	Anchors  []string
	Detect   func(headers []string) bool
	Label    string
	Parse    func(t *StmtTable) ([]StmtRow, error)
	Provider string
	Version  string
}

// StmtParseError is StatementParseError: a 422 STATEMENT_UNREADABLE.
func stmtErr(row int, format string, a ...any) error {
	_ = row
	return Err("STATEMENT_UNREADABLE", fmt.Sprintf(format, a...))
}

var stmtNonAlnum = regexp.MustCompile(`[^a-z0-9]`)

func isAlnum(b byte) bool { return b >= 'a' && b <= 'z' || b >= '0' && b <= '9' }

// NormalizeHeader lowercases and keeps letters and digits; a lone + or - becomes a word.
func NormalizeHeader(h string) string {
	h = strings.ToLower(h)
	rep := func(s string, ch byte, word string) string {
		var b strings.Builder
		for i := 0; i < len(s); i++ {
			if s[i] == ch && (i == 0 || !isAlnum(s[i-1])) && (i == len(s)-1 || !isAlnum(s[i+1])) {
				b.WriteString(word)
				continue
			}
			b.WriteByte(s[i])
		}
		return b.String()
	}
	return stmtNonAlnum.ReplaceAllString(rep(rep(h, '+', "plus"), '-', "minus"), "")
}

func (r *StmtRecord) find(aliases []string) *string {
	norm := map[string]string{}
	for _, k := range r.Keys {
		norm[NormalizeHeader(k)] = r.Vals[k]
	}
	for _, a := range aliases {
		if v, ok := norm[NormalizeHeader(a)]; ok && strings.TrimSpace(v) != "" {
			t := strings.TrimSpace(v)
			return &t
		}
	}
	return nil
}

func (r *StmtRecord) require(aliases []string, row int, label string) (string, error) {
	v := r.find(aliases)
	if v == nil {
		return "", stmtErr(row, "Row %d has no %s. The statement format may have changed.", row, label)
	}
	return *v, nil
}

func hasAny(headers, aliases []string) bool {
	set := map[string]bool{}
	for _, h := range headers {
		set[NormalizeHeader(h)] = true
	}
	for _, a := range aliases {
		if set[NormalizeHeader(a)] {
			return true
		}
	}
	return false
}

var settledStatus = map[string]bool{"complete": true, "completed": true, "success": true, "successful": true}
var unsettledStatus = map[string]bool{"cancel": true, "canceled": true, "cancelled": true, "expired": true, "fail": true, "failed": true, "initiated": true, "pending": true, "processing": true, "refunded": true, "reversed": true, "timeout": true}
var summaryLabels = map[string]bool{"balance": true, "canceled": true, "cancelled": true, "closingbalance": true, "complete": true, "completed": true, "expired": true, "failed": true, "grandtotal": true, "openingbalance": true, "pending": true, "subtotal": true, "summary": true, "timeout": true, "total": true}

var nonLetter = regexp.MustCompile(`[^a-z]`)

func isSettled(r *StmtRecord, aliases []string, row int) (bool, error) {
	s := r.find(aliases)
	if s == nil {
		return true, nil
	}
	n := nonLetter.ReplaceAllString(strings.ToLower(*s), "")
	if settledStatus[n] {
		return true, nil
	}
	if unsettledStatus[n] {
		return false, nil
	}
	return false, stmtErr(row, `Row %d has a status this parser does not recognise ("%s"), so it cannot tell whether the money moved.`, row, *s)
}

// classify is classifyRow: a data line, or a footer/summary to skip.
func classify(r *StmtRecord, dates, ids []string, row int) (data bool, err error) {
	id, date := r.find(ids), r.find(dates)
	for _, k := range r.Keys {
		if v := r.Vals[k]; strings.TrimSpace(v) != "" {
			if summaryLabels[NormalizeHeader(v)] {
				return false, nil
			}
			break
		}
	}
	if len(ids) == 0 {
		if date != nil {
			return true, nil
		}
	} else if id != nil && date != nil {
		return true, nil
	}
	if id == nil && date == nil {
		return false, nil
	}
	if date != nil {
		return false, stmtErr(row, "Row %d has a date but no transaction id, so this file was not fully understood.", row)
	}
	return false, stmtErr(row, "Row %d has a transaction id but no readable date, so this file was not fully understood.", row)
}

var (
	reParen    = regexp.MustCompile(`^\(.*\)$`)
	reCurrency = regexp.MustCompile(`(?i)(npr|rs\.?|nrs\.?|₹|रु)`)
	reNumber   = regexp.MustCompile(`^-?\d+(\.\d+)?$`)
	reSpace    = regexp.MustCompile(`\s`)
)

func parseAmount(raw string, row int) (amount int64, negative bool, err error) {
	t := strings.TrimSpace(raw)
	paren := reParen.MatchString(t)
	c := strings.NewReplacer("(", "", ")", "").Replace(t)
	c = reCurrency.ReplaceAllString(c, "")
	c = strings.ReplaceAll(c, ",", "")
	c = reSpace.ReplaceAllString(c, "")
	if !reNumber.MatchString(c) {
		return 0, false, stmtErr(row, `Row %d has an amount this parser cannot read: "%s".`, row, raw)
	}
	v, _ := strconv.ParseFloat(c, 64)
	m := math.Abs(v)
	if m != math.Floor(m) {
		return 0, false, stmtErr(row, "Row %d has a part-rupee amount (%s). This system records whole rupees only.", row, raw)
	}
	if m == 0 {
		return 0, false, stmtErr(row, "Row %d has a zero amount.", row)
	}
	return int64(m), paren || v < 0, nil
}

var (
	reISO      = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?`)
	reDayFirst = regexp.MustCompile(`^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?`)
)

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func parseStatementDate(raw string, row int) (time.Time, error) {
	t := strings.TrimSpace(raw)
	build := func(y, mo, d, h, mi, s string) (time.Time, error) {
		out := time.Date(atoi(y), time.Month(atoi(mo)), atoi(d), atoi(h), atoi(mi), atoi(s), 0, time.UTC)
		if int(out.Month()) != atoi(mo) || out.Day() != atoi(d) {
			return time.Time{}, stmtErr(row, `Row %d has an impossible date: "%s".`, row, raw)
		}
		return out, nil
	}
	if m := reISO.FindStringSubmatch(t); m != nil {
		return build(m[1], m[2], m[3], m[4], m[5], m[6])
	}
	if m := reDayFirst.FindStringSubmatch(t); m != nil {
		return build(m[3], m[2], m[1], m[4], m[5], m[6])
	}
	return time.Time{}, stmtErr(row, `Row %d has a date this parser cannot read: "%s".`, row, raw)
}

func nonZero(v *string) *string {
	if v == nil {
		return nil
	}
	n, err := strconv.ParseFloat(strings.NewReplacer(",", "", " ", "", "\t", "", "\n", "").Replace(*v), 64)
	if err == nil && n == 0 {
		return nil
	}
	return v
}

func strp(s string) *string { return &s }

// ---- table building ----

const maxPreamble = 25

func tableFromGrid(grid [][]string, anchors []string) (*StmtTable, error) {
	want := map[string]bool{}
	for _, a := range anchors {
		want[NormalizeHeader(a)] = true
	}
	limit := min(len(grid), maxPreamble)
	for i := 0; i < limit; i++ {
		for _, c := range grid[i] {
			if want[NormalizeHeader(c)] {
				return buildTable(grid, i)
			}
		}
	}
	return nil, stmtErr(0, "No recognisable column header was found in this file. The statement format may have changed.")
}

func buildTable(grid [][]string, at int) (*StmtTable, error) {
	raw := make([]string, len(grid[at]))
	for i, c := range grid[at] {
		raw[i] = strings.TrimSpace(c)
	}
	w := len(raw)
	for w > 0 && raw[w-1] == "" {
		w--
	}
	headers := raw[:w]
	if len(headers) == 0 {
		return nil, stmtErr(0, "This file has no column headers.")
	}
	for i, h := range headers {
		if h == "" {
			return nil, stmtErr(0, "Column %d of the header row has no name, so the columns cannot be read reliably.", i+1)
		}
	}
	var keys []string
	seen := map[string]bool{}
	for _, h := range headers {
		if !seen[h] {
			seen[h] = true
			keys = append(keys, h)
		}
	}
	t := &StmtTable{Headers: headers}
	for i := at + 1; i < len(grid); i++ {
		cells := grid[i]
		blank := true
		for _, c := range cells {
			if strings.TrimSpace(c) != "" {
				blank = false
				break
			}
		}
		if blank {
			continue
		}
		if len(cells) > len(headers) {
			for _, c := range cells[len(headers):] {
				if strings.TrimSpace(c) != "" {
					return nil, stmtErr(len(t.Rows)+1, "Row %d has more values than the header has columns, so this file was not fully understood.", len(t.Rows)+1)
				}
			}
		}
		rec := &StmtRecord{Keys: keys, Vals: map[string]string{}}
		for col, h := range headers {
			v := ""
			if col < len(cells) {
				v = strings.TrimSpace(cells[col])
			}
			rec.Vals[h] = v
		}
		t.Rows = append(t.Rows, rec)
	}
	if len(t.Rows) == 0 {
		return nil, stmtErr(0, "This statement has no transaction rows.")
	}
	return t, nil
}

// ---- sources ----

func isWorkbook(b []byte) bool {
	return len(b) >= 4 && (b[0] == 0xd0 && b[1] == 0xcf && b[2] == 0x11 && b[3] == 0xe0 || b[0] == 0x50 && b[1] == 0x4b && b[2] == 0x03 && b[3] == 0x04)
}

func decodeText(b []byte) (string, error) {
	if !utf8.Valid(b) || bytes.Contains(b, []byte("\xef\xbf\xbd")) {
		return "", stmtErr(0, "This file is not valid UTF-8 text. Re-export it, or upload the original .xls or .xlsx instead.")
	}
	return strings.TrimPrefix(string(b), "\ufeff"), nil
}

func csvGrid(text string) ([][]string, error) {
	r := csv.NewReader(strings.NewReader(text))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var grid [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			return grid, nil
		}
		if err != nil {
			return nil, stmtErr(0, "This file could not be read as CSV: %s. The statement format may have changed.", err.Error())
		}
		grid = append(grid, rec)
	}
}

// sheets is every sheet of a workbook as a grid of text, xlsx or legacy xls.
func sheets(b []byte, maxRows int) (names []string, grids [][][]string, err error) {
	if b[0] == 0x50 {
		f, e := excelize.OpenReader(bytes.NewReader(b))
		if e != nil {
			return nil, nil, stmtErr(0, "This file could not be opened as a spreadsheet: %s.", e.Error())
		}
		defer f.Close()
		for _, n := range f.GetSheetList() {
			rows, e := f.GetRows(n)
			if e != nil {
				return nil, nil, stmtErr(0, "This file could not be opened as a spreadsheet: %s.", e.Error())
			}
			if maxRows > 0 && len(rows) > maxRows {
				rows = rows[:maxRows]
			}
			names, grids = append(names, n), append(grids, rows)
		}
		return names, grids, nil
	}
	return readXLS(b, maxRows)
}

const maxCells = 200_000

// ReadStmtTable is readStatementTable.
func ReadStmtTable(b []byte, anchors []string) (*StmtTable, error) {
	if !isWorkbook(b) {
		text, err := decodeText(b)
		if err != nil {
			return nil, err
		}
		g, err := csvGrid(text)
		if err != nil {
			return nil, err
		}
		return tableFromGrid(g, anchors)
	}
	names, grids, err := sheets(b, 0)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, a := range anchors {
		want[stmtNonAlnum.ReplaceAllString(strings.ToLower(a), "")] = true
	}
	var hit []int
	for i, g := range grids {
	scan:
		for _, row := range g {
			for _, c := range row {
				if want[stmtNonAlnum.ReplaceAllString(strings.ToLower(c), "")] {
					hit = append(hit, i)
					break scan
				}
			}
		}
	}
	if len(hit) == 0 {
		return nil, stmtErr(0, "No recognisable column header was found in this file. The statement format may have changed.")
	}
	if len(hit) > 1 {
		var n []string
		for _, i := range hit {
			n = append(n, names[i])
		}
		return nil, stmtErr(0, "This workbook has %d sheets that look like statements (%s). Upload one sheet at a time.", len(hit), strings.Join(n, ", "))
	}
	g := grids[hit[0]]
	cols := 0
	for _, r := range g {
		cols = max(cols, len(r))
	}
	if len(g) == 0 {
		return nil, stmtErr(0, "This sheet is empty.")
	}
	if len(g)*cols > maxCells {
		return nil, stmtErr(0, "This spreadsheet is too large to read. Export a shorter date range.")
	}
	return tableFromGrid(g, anchors)
}

// PeekStmtHeaders is peekStatementHeaders: the cells of the first lines, for detection.
func PeekStmtHeaders(b []byte) []string {
	var out []string
	if !isWorkbook(b) {
		text, err := decodeText(b)
		if err != nil {
			return nil
		}
		lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
		lines = lines[:min(len(lines), maxPreamble)]
		for _, l := range lines {
			if strings.TrimSpace(l) == "" {
				continue
			}
			r := csv.NewReader(strings.NewReader(l))
			r.FieldsPerRecord = -1
			r.LazyQuotes = true
			rec, _ := r.Read()
			for _, c := range rec {
				if c = strings.TrimSpace(c); c != "" {
					out = append(out, c)
				}
			}
		}
		return out
	}
	_, grids, err := sheets(b, maxPreamble)
	if err != nil {
		return nil
	}
	for _, g := range grids {
		for _, row := range g {
			for _, c := range row {
				if c = strings.TrimSpace(c); c != "" {
					out = append(out, c)
				}
			}
		}
	}
	return out
}

// ---- providers ----

var (
	eswTxn     = []string{"Reference Code", "Transaction Code", "Transaction Id", "Txn Id", "Transaction Number", "Reference Id"}
	eswDate    = []string{"Date Time", "Date", "Transaction Date", "Datetime"}
	eswCredit  = []string{"Cr.", "Cr", "Credit", "Cr Amount", "Credit Amount", "Received"}
	eswDebit   = []string{"Dr.", "Dr", "Debit", "Dr Amount", "Debit Amount", "Paid"}
	eswAmount  = []string{"Amount", "Transaction Amount"}
	eswName    = []string{"Name", "Counterparty", "Sender Name", "Payer Name", "From", "Sender"}
	eswRemarks = []string{"Remarks", "Remark", "Description", "Particulars", "Purpose", "Narration"}
	eswStatus  = []string{"Status", "Transaction Status", "State"}
	eswParty   = regexp.MustCompile(`(?i)(?:transferred|received|payment|paid|sent)\s+(?:by|from|to|for)\s+(.+)$`)
)

// creditDebit is the shared credit/debit column read of the eSewa and Khalti parsers.
func creditDebit(r *StmtRecord, credit, debit []string, row int, both, none string) (amount int64, dir string, ok bool, err error) {
	c, d := nonZero(r.find(credit)), nonZero(r.find(debit))
	if c != nil && d != nil {
		return 0, "", false, stmtErr(row, "Row %d has both a credit and a debit amount, which this parser cannot interpret.", row)
	}
	pick := func(v *string, dir string) (int64, string, bool, error) {
		a, _, e := parseAmount(*v, row)
		return a, dir, true, e
	}
	if c != nil {
		return pick(c, "CREDIT")
	}
	if d != nil {
		return pick(d, "DEBIT")
	}
	if r.find(credit) != nil || r.find(debit) != nil {
		return 0, "", false, stmtErr(row, "Row %d has a zero amount on both the %s sides.", row, none)
	}
	_ = both
	return 0, "", false, nil
}

func trimParty(d *string) *string {
	if d == nil {
		return nil
	}
	if m := eswParty.FindStringSubmatch(strings.TrimSpace(*d)); m != nil {
		if s := strings.TrimSpace(m[1]); s != "" {
			return &s
		}
	}
	return nil
}

var EsewaParser = &StmtParser{
	Anchors: eswTxn, Label: "eSewa statement", Provider: "ESEWA", Version: "esewa@2",
	Detect: func(h []string) bool {
		return hasAny(h, eswTxn) && (hasAny(h, eswCredit) || hasAny(h, eswAmount))
	},
	Parse: func(t *StmtTable) ([]StmtRow, error) {
		var out []StmtRow
		footer := false
		for i, r := range t.Rows {
			n := i + 1
			data, err := classify(r, eswDate, eswTxn, n)
			if err != nil {
				return nil, err
			}
			if !data {
				footer = true
				continue
			}
			if footer {
				return nil, stmtErr(n, "Row %d is a transaction below this statement's totals row, so this file was not fully understood.", n)
			}
			ok, err := isSettled(r, eswStatus, n)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			id, err := r.require(eswTxn, n, "transaction id")
			if err != nil {
				return nil, err
			}
			ds, err := r.require(eswDate, n, "date")
			if err != nil {
				return nil, err
			}
			at, err := parseStatementDate(ds, n)
			if err != nil {
				return nil, err
			}
			amount, dir, found, err := creditDebit(r, eswCredit, eswDebit, n, "", "debit and credit")
			if err != nil {
				return nil, err
			}
			if !found {
				s, err := r.require(eswAmount, n, "amount")
				if err != nil {
					return nil, err
				}
				a, neg, err := parseAmount(s, n)
				if err != nil {
					return nil, err
				}
				amount, dir = a, "CREDIT"
				if neg {
					dir = "DEBIT"
				}
			}
			desc := r.find(eswRemarks)
			who := r.find(eswName)
			if who == nil {
				who = trimParty(desc)
			}
			out = append(out, StmtRow{Amount: amount, CounterpartyName: who, Direction: dir, OccurredAt: at, ProviderTxnID: id, Raw: r, Remarks: desc, RowNumber: n})
		}
		if len(out) == 0 {
			return nil, stmtErr(0, "This statement has no completed transactions in it.")
		}
		return out, nil
	},
}

var (
	khTxn     = []string{"Transaction ID", "Transaction Id", "Txn Id", "Idx", "Transaction Code", "Purchase Order Id"}
	khDate    = []string{"Transaction Date", "Created On", "Date", "Created At"}
	khTime    = []string{"Transaction Time", "Time"}
	khState   = []string{"Transaction State", "Status", "Transaction Status", "State"}
	khCredit  = []string{"Amount(+) Rs", "Amount(+)", "Credit", "Cr Amount", "Received"}
	khDebit   = []string{"Amount(-) Rs", "Amount(-)", "Debit", "Dr Amount", "Sent"}
	khAmount  = []string{"Amount", "Total Amount", "Transaction Amount"}
	khType    = []string{"Type", "Direction"}
	khFrom    = []string{"From", "Sender", "Payer"}
	khTo      = []string{"To", "Receiver", "Payee"}
	khName    = []string{"Name", "Customer Name", "Fullname", "Username", "Mobile"}
	khRemarks = []string{"Remarks", "Purpose", "Reference", "Detail", "Product Name"}
	khDesc    = []string{"Description", "Service", "Transaction Type"}
	khCrWords = []string{"credit", "cr", "received", "receive", "in", "deposit", "payment received"}
	khDrWords = []string{"debit", "dr", "sent", "send", "out", "withdraw", "withdrawal", "payment"}
	reTail    = regexp.MustCompile(`\s*\([^)]*\)\s*$`)
	reClock   = regexp.MustCompile(`\d:\d`)
)

var KhaltiParser = &StmtParser{
	Anchors: khTxn, Label: "Khalti statement", Provider: "KHALTI", Version: "khalti@2",
	Detect: func(h []string) bool {
		return hasAny(h, khTxn) && hasAny(h, khDate) && (hasAny(h, khAmount) || hasAny(h, khCredit) || hasAny(h, khDebit))
	},
	Parse: func(t *StmtTable) ([]StmtRow, error) {
		var out []StmtRow
		for i, r := range t.Rows {
			n := i + 1
			data, err := classify(r, khDate, khTxn, n)
			if err != nil {
				return nil, err
			}
			if !data {
				continue
			}
			ok, err := isSettled(r, khState, n)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			amount, dir, found, err := creditDebit(r, khCredit, khDebit, n, "", "credit and debit")
			if err != nil {
				return nil, err
			}
			if !found {
				s, err := r.require(khAmount, n, "amount")
				if err != nil {
					return nil, err
				}
				a, neg, err := parseAmount(s, n)
				if err != nil {
					return nil, err
				}
				amount = a
				dir = "CREDIT"
				if ty := r.find(khType); ty == nil {
					if neg {
						dir = "DEBIT"
					}
				} else if w := strings.ToLower(strings.TrimSpace(*ty)); has(khCrWords, w) {
					dir = "CREDIT"
				} else if has(khDrWords, w) {
					dir = "DEBIT"
				} else {
					return nil, stmtErr(n, `Row %d has a transaction type this parser does not recognise: "%s".`, n, *ty)
				}
			}
			var who *string
			if dir == "CREDIT" {
				who = r.find(khFrom)
			} else {
				who = r.find(khTo)
			}
			if who == nil {
				who = r.find(khName)
			}
			if who != nil {
				s := strings.TrimSpace(reTail.ReplaceAllString(*who, ""))
				if s == "" {
					s = strings.TrimSpace(*who)
				}
				who = &s
			}
			var remarks *string
			var typed, seen []string
			for _, a := range khRemarks {
				if v := r.find([]string{a}); v != nil && !has(seen, *v) {
					seen = append(seen, *v)
					typed = append(typed, *v)
				}
			}
			if len(typed) > 0 {
				remarks = strp(strings.Join(typed, " · "))
			} else {
				remarks = r.find(khDesc)
			}
			date, err := r.require(khDate, n, "date")
			if err != nil {
				return nil, err
			}
			if tm := r.find(khTime); tm != nil && !reClock.MatchString(date) {
				date += " " + *tm
			}
			at, err := parseStatementDate(date, n)
			if err != nil {
				return nil, err
			}
			id, err := r.require(khTxn, n, "transaction id")
			if err != nil {
				return nil, err
			}
			out = append(out, StmtRow{Amount: amount, CounterpartyName: who, Direction: dir, OccurredAt: at, ProviderTxnID: id, Raw: r, Remarks: remarks, RowNumber: n})
		}
		if len(out) == 0 {
			return nil, stmtErr(0, "This statement has no completed transactions in it.")
		}
		return out, nil
	},
}

var (
	bkTxn       = []string{"Transaction Id", "Txn Id", "Reference No", "Reference Number", "Transaction Reference", "Tran Id"}
	bkDate      = []string{"Date", "Transaction Date", "Value Date", "Txn Date", "Posting Date"}
	bkNarration = []string{"Narration", "Description", "Particulars", "Remarks", "Transaction Remarks", "Details"}
	bkDeposit   = []string{"Deposit", "Credit", "Cr Amount", "Deposit Amount", "Credit Amount"}
	bkWithdraw  = []string{"Withdrawal", "Debit", "Dr Amount", "Withdrawal Amount", "Debit Amount"}
	bkBalance   = []string{"Balance", "Running Balance", "Closing Balance"}
	bkMarkers   = []string{"Narration", "Particulars", "Details", "Deposit", "Withdrawal", "Value Date"}
	reWS        = regexp.MustCompile(`\s+`)
	reBalStrip  = regexp.MustCompile(`[,\s]`)
)

var BankParser = &StmtParser{
	Anchors: bkDate, Label: "bank statement", Provider: "BANK", Version: "bank@2",
	Detect: func(h []string) bool {
		return hasAny(h, bkDate) && hasAny(h, bkDeposit) && hasAny(h, bkWithdraw) && hasAny(h, bkMarkers)
	},
	Parse: func(t *StmtTable) ([]StmtRow, error) {
		seen := map[string]int{}
		var out []StmtRow
		for i, r := range t.Rows {
			n := i + 1
			data, err := classify(r, bkDate, nil, n)
			if err != nil {
				return nil, err
			}
			if !data {
				continue
			}
			ds, err := r.require(bkDate, n, "date")
			if err != nil {
				return nil, err
			}
			at, err := parseStatementDate(ds, n)
			if err != nil {
				return nil, err
			}
			dep, wd := nonZero(r.find(bkDeposit)), nonZero(r.find(bkWithdraw))
			if dep != nil && wd != nil {
				return nil, stmtErr(n, "Row %d has both a deposit and a withdrawal, which this parser cannot interpret.", n)
			}
			if dep == nil && wd == nil {
				return nil, stmtErr(n, "Row %d has neither a deposit nor a withdrawal amount.", n)
			}
			narr := r.find(bkNarration)
			pick := dep
			dir := "CREDIT"
			if dep == nil {
				pick, dir = wd, "DEBIT"
			}
			amt, _, err := parseAmount(*pick, n)
			if err != nil {
				return nil, err
			}
			id := ""
			if v := r.find(bkTxn); v != nil {
				id = *v
			} else {
				bal := ""
				if b := r.find(bkBalance); b != nil {
					bal = reBalStrip.ReplaceAllString(*b, "")
				}
				nar := ""
				if narr != nil {
					nar = strings.TrimSpace(reWS.ReplaceAllString(strings.ToUpper(*narr), " "))
				}
				base := strings.Join([]string{at.Format("2006-01-02"), strconv.FormatInt(amt, 10), nar, bal}, "|")
				seen[base]++
				id = fmt.Sprintf("derived:%s#%d", base, seen[base])
			}
			out = append(out, StmtRow{Amount: amt, CounterpartyName: narr, Direction: dir, OccurredAt: at, ProviderTxnID: id, Raw: r, Remarks: narr, RowNumber: n})
		}
		if len(out) == 0 {
			return nil, stmtErr(0, "This statement has no transaction rows in it.")
		}
		return out, nil
	},
}

var currentParsers = []*StmtParser{EsewaParser, KhaltiParser, BankParser}

// ResolveStmtParser is resolveParser: the owner's choice, guarded by detection.
func ResolveStmtParser(provider string, b []byte) (*StmtParser, error) {
	var p *StmtParser
	for _, c := range currentParsers {
		if c.Provider == provider {
			p = c
		}
	}
	if p == nil {
		return nil, stmtErr(0, "No statement parser is available for %s yet.", provider)
	}
	headers := PeekStmtHeaders(b)
	if p.Detect(headers) {
		return p, nil
	}
	var labels []string
	for _, c := range currentParsers {
		if c != p && c.Detect(headers) {
			labels = append(labels, c.Label)
		}
	}
	hint := " The statement format may have changed."
	if len(labels) > 0 {
		hint = " This file looks like a " + strings.Join(labels, " or ") + "."
	}
	return nil, stmtErr(0, "This file does not look like a %s.%s", p.Label, hint)
}
