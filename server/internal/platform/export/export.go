// Package export is CSV and streamed zip output (lib/csv.ts, lib/zip-stream.ts),
// held to testdata/vectors/csv.json.
package export

import (
	"archive/zip"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
)

var isoInstant = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`)

// CellText is exportCellText: dates in the platform's one format, the rest as String() would.
func CellText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case time.Time:
		return bs.FormatHostelDate(x, "")
	case *time.Time:
		if x == nil {
			return ""
		}
		return bs.FormatHostelDate(*x, "")
	case string:
		if isoInstant.MatchString(x) {
			// ponytail: RFC 3339 only; JS Date also reads zone-less local forms, which Vercel ran as UTC.
			if t, err := time.Parse(time.RFC3339Nano, x); err == nil {
				return bs.FormatHostelDate(t, x)
			}
		}
		return x
	case bool:
		return strconv.FormatBool(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return jsNumber(x)
	}
	return ""
}

// jsNumber is String(n): exponent form only at JS's own thresholds.
func jsNumber(f float64) string {
	if a := math.Abs(f); a != 0 && (a >= 1e21 || a < 1e-6) {
		return strconv.FormatFloat(f, 'g', -1, 64)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

var needsQuotes = regexp.MustCompile(`[",\n\r]|^\s|\s$`)

// Cell quotes a value for CSV and defuses spreadsheet formulas in strings.
func Cell(v any) string {
	if v == nil {
		return ""
	}
	raw := CellText(v)
	if _, ok := v.(string); ok && raw != "" && strings.ContainsRune("=+-@\t\r", rune(raw[0])) {
		raw = "'" + raw
	}
	if needsQuotes.MatchString(raw) {
		return `"` + strings.ReplaceAll(raw, `"`, `""`) + `"`
	}
	return raw
}

// Column is one CSV column.
type Column struct{ Key, Label string }

// CSV is toCsv: CRLF rows, a trailing CRLF.
func CSV(columns []Column, rows []map[string]any) string {
	var b strings.Builder
	line := func(cells []string) { b.WriteString(strings.Join(cells, ",") + "\r\n") }
	head := make([]string, len(columns))
	for i, c := range columns {
		head[i] = Cell(c.Label)
	}
	line(head)
	for _, row := range rows {
		cells := make([]string, len(columns))
		for i, c := range columns {
			cells[i] = Cell(row[c.Key])
		}
		line(cells)
	}
	return b.String()
}

// CSVFilename is <prefix>-YYYY-MM-DD.csv (UTC date, as toISOString).
func CSVFilename(prefix string, at time.Time) string {
	return prefix + "-" + at.UTC().Format("2006-01-02") + ".csv"
}

// WriteCSV sends a CSV download the way csvResponse does.
func WriteCSV(w http.ResponseWriter, body, filename string) {
	h := w.Header()
	h.Set("cache-control", "no-store")
	h.Set("content-disposition", `attachment; filename="`+filename+`"`)
	h.Set("content-type", "text/csv; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
}

// Entry is one zipped file; Open is called only when it is its turn.
type Entry struct {
	Name string
	Date time.Time
	Open func() (io.ReadCloser, error)
}

// Zip streams stored (uncompressed) entries to w without holding any of them in memory.
func Zip(w io.Writer, entries func(yield func(Entry) bool)) error {
	z := zip.NewWriter(w)
	var failed error
	entries(func(e Entry) bool {
		dst, err := z.CreateHeader(&zip.FileHeader{Name: e.Name, Method: zip.Store, Modified: e.Date.UTC()})
		if err != nil {
			failed = err
			return false
		}
		src, err := e.Open()
		if err != nil {
			failed = err
			return false
		}
		_, err = io.Copy(dst, src)
		_ = src.Close()
		if err != nil {
			failed = err
			return false
		}
		return true
	})
	if failed != nil {
		return failed
	}
	return z.Close()
}

var (
	unsafeName = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
	spaces     = regexp.MustCompile(`\s+`)
)

// SafeEntryName is safeEntryName: a file name any unzipper accepts, ≤120 chars.
func SafeEntryName(v string) string {
	cleaned := strings.TrimSpace(spaces.ReplaceAllString(unsafeName.ReplaceAllString(v, "-"), " "))
	if r := []rune(cleaned); len(r) > 120 {
		cleaned = string(r[:120])
	}
	if cleaned == "" {
		return "file"
	}
	return cleaned
}
