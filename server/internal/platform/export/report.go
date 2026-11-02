package export

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/pdf"
)

// Report is ReportExport: one table, ready for CSV or the branded PDF.
type Report struct {
	Columns        []Column
	Rows           []map[string]any
	FilenamePrefix string
	Period         string
}

const (
	portraitW, portraitH = 595.28, 841.89
	reportMargin         = 36.0
	rowHeight            = 20.0
	bodySize             = 8.5
	headSize             = 8.0
	cellPad              = 6.0
	footerSpace          = 30.0
	bandHeight           = 74.0
)

var (
	reportBrand = pdf.RGB{R: 10.0 / 255, G: 138.0 / 255, B: 75.0 / 255}
	reportInk   = pdf.RGB{R: 0.09, G: 0.11, B: 0.1}
	reportMuted = pdf.RGB{R: 0.42, G: 0.45, B: 0.44}
	reportRule  = pdf.RGB{R: 0.87, G: 0.89, B: 0.88}
	stripeFill  = pdf.RGB{R: 0.965, G: 0.975, B: 0.97}
	headFill    = pdf.RGB{R: 0.91, G: 0.96, B: 0.93}
	reportWhite = pdf.RGB{R: 1, G: 1, B: 1}
	numericCell = regexp.MustCompile(`^-?[\d,]+(\.\d+)?%?$`)
	notWinAnsi  = regexp.MustCompile(`[^\x20-\x7E·]`)
)

// Sanitize is report-pdf's sanitize: what the standard fonts can draw.
func Sanitize(s string) string {
	return notWinAnsi.ReplaceAllString(strings.NewReplacer("‘", "'", "’", "'", "“", `"`, "”", `"`, "–", "-", "—", "-").Replace(s), "")
}

func fitText(d *pdf.Doc, text string, width float64, font pdf.Font, size float64) string {
	if d.Width(text, font, size) <= width {
		return text
	}
	clipped := []rune(text)
	for len(clipped) > 1 && d.Width(string(clipped)+"...", font, size) > width {
		clipped = clipped[:len(clipped)-1]
	}
	return string(clipped) + "..."
}

func reportTitle(prefix string) string {
	words := []string{}
	for _, w := range strings.Split(prefix, "-") {
		if w != "" {
			words = append(words, w)
		}
	}
	if len(words) == 0 {
		return "Report"
	}
	first := strings.ToUpper(words[0][:1]) + words[0][1:]
	if len(words) == 1 {
		return first
	}
	return first + " " + strings.Join(words[1:], " ")
}

// RenderPDF is renderReportPdf.
func RenderPDF(r Report, scopeName string, at time.Time) ([]byte, error) {
	w, h := portraitW, portraitH
	if len(r.Columns) > 6 {
		w, h = portraitH, portraitW
	}
	usable := w - reportMargin*2
	d := pdf.NewSized(w, h)
	title := Sanitize(reportTitle(r.FilenamePrefix))
	d.SetMeta(title, "HostelPalika", "HostelPalika")
	rows := make([][]string, len(r.Rows))
	for i, row := range r.Rows {
		cells := make([]string, len(r.Columns))
		for j, col := range r.Columns {
			cells[j] = Sanitize(CellText(row[col.Key]))
		}
		rows[i] = cells
	}
	heads := make([]string, len(r.Columns))
	numeric := make([]bool, len(r.Columns))
	natural := make([]float64, len(r.Columns))
	var total float64
	for j, col := range r.Columns {
		heads[j] = strings.ToUpper(Sanitize(col.Label))
		filled := 0
		allNumbers := true
		widest := d.Width(heads[j], pdf.Bold, headSize)
		for i, row := range rows {
			if row[j] != "" {
				filled++
				allNumbers = allNumbers && numericCell.MatchString(row[j])
			}
			if i < 300 {
				if v := d.Width(row[j], pdf.Regular, bodySize); v > widest {
					widest = v
				}
			}
		}
		numeric[j] = filled > 0 && allNumbers
		natural[j] = min(max(widest+cellPad*2, 44), 220)
		total += natural[j]
	}
	widths := make([]float64, len(natural))
	xs := make([]float64, len(natural))
	x := reportMargin
	for j := range natural {
		widths[j] = natural[j] / total * usable
		xs[j] = x
		x += widths[j]
	}
	cell := func(value string, j int, y float64, font pdf.Font, size float64, color pdf.RGB) {
		shown := fitText(d, value, widths[j]-cellPad*2, font, size)
		at := xs[j] + cellPad
		if numeric[j] {
			at = xs[j] + widths[j] - cellPad - d.Width(shown, font, size)
		}
		d.Text(at, y, shown, font, size, color)
	}
	var cursor float64
	drawHead := func() {
		d.Rect(reportMargin, cursor-rowHeight, usable, rowHeight, nil, 0, &headFill)
		for j, head := range heads {
			cell(head, j, cursor-13.5, pdf.Bold, headSize, reportBrand)
		}
		cursor -= rowHeight
	}
	d.Rect(0, h-bandHeight, w, bandHeight, nil, 0, &reportBrand)
	d.Text(reportMargin, h-26, "HostelPalika", pdf.Bold, 10, reportWhite)
	d.Text(reportMargin, h-50, title, pdf.Bold, 20, reportWhite)
	if scopeName != "" {
		scope := fitText(d, Sanitize(scopeName), usable/2, pdf.Regular, 10)
		d.Text(w-reportMargin-d.Width(scope, pdf.Regular, 10), h-26, scope, pdf.Regular, 10, reportWhite)
	}
	cursor = h - bandHeight - 22
	parts := []string{"Generated " + bs.FormatHostelDateTime(at, "")}
	if r.Period != "" {
		parts = append(parts, "Period: "+r.Period)
	}
	noun := "rows"
	if len(rows) == 1 {
		noun = "row"
	}
	parts = append(parts, strconv.Itoa(len(rows))+" "+noun)
	d.Text(reportMargin, cursor, Sanitize(strings.Join(parts, "   |   ")), pdf.Regular, 9, reportMuted)
	cursor -= 16
	drawHead()
	if len(rows) == 0 {
		d.Text(reportMargin+cellPad, cursor-16, "Nothing to report for this period.", pdf.Regular, 10, reportMuted)
	}
	for i, row := range rows {
		if cursor-rowHeight < reportMargin+footerSpace {
			d.AddPage()
			cursor = h - reportMargin
			d.Text(reportMargin, cursor-4, title, pdf.Bold, 11, reportInk)
			cursor -= 18
			drawHead()
		}
		if i%2 == 1 {
			d.Rect(reportMargin, cursor-rowHeight, usable, rowHeight, nil, 0, &stripeFill)
		}
		for j, value := range row {
			cell(value, j, cursor-13.5, pdf.Regular, bodySize, reportInk)
		}
		d.Line(reportMargin, cursor-rowHeight, reportMargin+usable, cursor-rowHeight, 0.5, reportRule)
		cursor -= rowHeight
	}
	pages := d.Pages()
	for n := 1; n <= pages; n++ {
		d.GoToPage(n)
		label := "Page " + strconv.Itoa(n) + " of " + strconv.Itoa(pages)
		d.Line(reportMargin, reportMargin+12, w-reportMargin, reportMargin+12, 0.5, reportRule)
		d.Text(reportMargin, reportMargin, "HostelPalika · "+title, pdf.Regular, 8, reportMuted)
		d.Text(w-reportMargin-d.Width(label, pdf.Regular, 8), reportMargin, label, pdf.Regular, 8, reportMuted)
	}
	return d.Bytes()
}

// WriteReport is reportExportResponse: never cached, a snapshot of today's figures.
func WriteReport(w http.ResponseWriter, r Report, format, scopeName string, at time.Time) error {
	if format == "csv" {
		WriteCSV(w, CSV(r.Columns, r.Rows), CSVFilename(r.FilenamePrefix, at))
		return nil
	}
	body, err := RenderPDF(r, scopeName, at)
	if err != nil {
		return err
	}
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("content-disposition", `attachment; filename="`+r.FilenamePrefix+"-"+at.UTC().Format("2006-01-02")+`.pdf"`)
	w.Header().Set("content-type", "application/pdf")
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(body)
	return err
}
