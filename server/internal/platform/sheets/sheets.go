// Package sheets reads and writes spreadsheets the way SheetJS does for this
// codebase: every cell as its displayed text (raw:false), dates as
// "yyyy-mm-dd hh:mm:ss" (the dateNF every reader passes), blank rows kept and
// every row padded to the sheet's width (defval ""). xlsx through excelize,
// legacy .xls (BIFF8, still what several Nepali banks export) through shakinm/xlsReader.
// Held to testdata/vectors/sheets.json, which SheetJS wrote and read.
package sheets

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"

	xlsreader "github.com/shakinm/xlsReader/xls"
	"github.com/shakinm/xlsReader/xls/structure"
	"github.com/xuri/excelize/v2"
)

// Sheet is one worksheet as text.
type Sheet struct {
	Name string
	Rows [][]string
}

// ErrUnreadable wraps any failure to open the bytes as a workbook.
var ErrUnreadable = errors.New("not a readable spreadsheet")

// Read opens xlsx or xls bytes. maxRows > 0 stops each sheet early (sheetRows).
func Read(b []byte, maxRows int) ([]Sheet, error) {
	switch {
	case bytes.HasPrefix(b, []byte("PK")):
		return readXLSX(b, maxRows)
	case bytes.HasPrefix(b, []byte("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")):
		return readXLS(b, maxRows)
	}
	return nil, fmt.Errorf("%w: unknown format", ErrUnreadable)
}

// Cells is how many cells a sheet spans (rows × widest row), for size limits.
func (s Sheet) Cells() int {
	if len(s.Rows) == 0 {
		return 0
	}
	return len(s.Rows) * len(s.Rows[0])
}

// dateLayout is the dateNF every TS reader passes.
const dateLayout = "2006-01-02 15:04:05"

// builtinDateFormats are the numFmt ids SheetJS replaces with dateNF.
var builtinDateFormats = map[int]bool{14: true, 22: true}

func readXLSX(b []byte, maxRows int) ([]Sheet, error) {
	f, err := excelize.OpenReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreadable, err)
	}
	defer f.Close()
	var out []Sheet
	for _, name := range f.GetSheetList() {
		rows, err := f.GetRows(name, excelize.Options{RawCellValue: true})
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnreadable, err)
		}
		for r, row := range rows {
			for c, raw := range row {
				ref, _ := excelize.CoordinatesToCellName(c+1, r+1)
				row[c] = xlsxText(f, name, ref, raw)
			}
		}
		// sheet_to_json walks the declared range (!ref): trailing blank rows
		// inside it are kept, and columns/rows before its start are not read.
		startCol, startRow, endCol, endRow := 1, 1, 0, len(rows)
		if dim, err := f.GetSheetDimension(name); err == nil && dim != "" {
			from, to, _ := strings.Cut(dim, ":")
			if to == "" {
				to = from
			}
			startCol, startRow, _ = excelize.CellNameToCoordinates(from)
			endCol, endRow, _ = excelize.CellNameToCoordinates(to)
		}
		for len(rows) < endRow {
			rows = append(rows, nil)
		}
		rows = rows[min(startRow-1, len(rows)):]
		for i, row := range rows {
			rows[i] = row[min(startCol-1, len(row)):]
		}
		if maxRows > 0 && len(rows) > maxRows {
			rows = rows[:maxRows]
		}
		rows = pad(rows)
		if width := endCol - startCol + 1; endCol > 0 && len(rows) > 0 && len(rows[0]) < width {
			for i := range rows {
				for len(rows[i]) < width {
					rows[i] = append(rows[i], "")
				}
			}
		}
		out = append(out, Sheet{Name: name, Rows: rows})
	}
	return out, nil
}

// xlsxText is the cell's displayed text, with SheetJS's choices where Excel's differ.
func xlsxText(f *excelize.File, sheet, ref, raw string) string {
	typ, _ := f.GetCellType(sheet, ref)
	switch typ {
	case excelize.CellTypeBool:
		if raw == "1" {
			return "TRUE"
		}
		return "FALSE"
	case excelize.CellTypeNumber, excelize.CellTypeUnset:
		style, _ := f.GetCellStyle(sheet, ref)
		fmtID := 0
		if s, err := f.GetStyle(style); err == nil && s != nil {
			fmtID = s.NumFmt
		}
		if serial, err := strconv.ParseFloat(raw, 64); err == nil && builtinDateFormats[fmtID] {
			if t, err := excelize.ExcelDateToTime(serial, false); err == nil {
				return t.Round(1e9).Format(dateLayout)
			}
		}
		if fmtID == 0 {
			return raw
		}
		shown, _ := f.GetCellValue(sheet, ref)
		return shown
	}
	return raw
}

func readXLS(b []byte, maxRows int) (out []Sheet, err error) {
	// A BIFF parser walks attacker-supplied offsets; a malformed file must be an
	// error, never a crashed request.
	defer func() {
		if r := recover(); r != nil {
			out, err = nil, fmt.Errorf("%w: %v", ErrUnreadable, r)
		}
	}()
	wb, err := xlsreader.OpenReader(bytes.NewReader(rootEntryNamed(b)))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreadable, err)
	}
	for _, ws := range wb.GetSheets() {
		var rows [][]string
		for r := 0; r < ws.GetNumberRows(); r++ {
			if maxRows > 0 && r >= maxRows {
				break
			}
			var cells []string
			if row, err := ws.GetRow(r); err == nil && row != nil {
				for _, cell := range row.GetCols() {
					cells = append(cells, xlsText(&wb, cell))
				}
			}
			rows = append(rows, cells)
		}
		out = append(out, Sheet{Name: ws.GetName(), Rows: pad(rows)})
	}
	return out, nil
}

// rootEntryNamed returns b with CFB directory entry 0 named "Root Entry".
// Excel always writes that name; SheetJS writes "R", and xlsReader finds the
// root by name. Only the 66 name bytes of entry 0 change, on a copy.
func rootEntryNamed(b []byte) []byte {
	if len(b) < 512 {
		return b
	}
	sectorSize := 1 << binary.LittleEndian.Uint16(b[30:32])
	at := (int(binary.LittleEndian.Uint32(b[48:52])) + 1) * sectorSize
	if sectorSize < 512 || at+68 > len(b) {
		return b
	}
	want := append(utf16.Encode([]rune("Root Entry")), 0) // NUL-terminated, as CFB stores names
	if binary.LittleEndian.Uint16(b[at+64:at+66]) == uint16(len(want)*2) {
		return b // already named; nothing to do
	}
	out := bytes.Clone(b)
	clear(out[at : at+64])
	for i, u := range want {
		binary.LittleEndian.PutUint16(out[at+2*i:], u)
	}
	binary.LittleEndian.PutUint16(out[at+64:], uint16(len(want)*2))
	return out
}

func xlsText(wb *xlsreader.Workbook, cell structure.CellData) string {
	if cell == nil {
		return ""
	}
	switch cell.GetType() {
	case "*record.Number", "*record.Rk", "*record.MulRk", "*record.Formula":
		f := cell.GetFloat64()
		xf := wb.GetXFbyIndex(cell.GetXFIndex())
		fmtID := xf.GetFormatIndex()
		if builtinDateFormats[fmtID] {
			if t, err := excelize.ExcelDateToTime(f, false); err == nil {
				return t.Round(1e9).Format(dateLayout)
			}
		}
		if fmtID == 0 {
			return strconv.FormatFloat(f, 'f', -1, 64)
		}
	case "*record.BoolErr":
		switch cell.GetString() {
		case "1", "true", "TRUE":
			return "TRUE"
		case "0", "false", "FALSE":
			return "FALSE"
		}
	}
	return cell.GetString()
}

func pad(rows [][]string) [][]string {
	width := 0
	for _, r := range rows {
		width = max(width, len(r))
	}
	for i, r := range rows {
		for len(r) < width {
			r = append(r, "")
		}
		rows[i] = r
	}
	return rows
}

// WriteSheet is one sheet to write; AutoFilter puts a filter on the header row.
type WriteSheet struct {
	Name       string
	Rows       [][]any
	AutoFilter bool
}

// Write builds an xlsx (aoa_to_sheet + book_append_sheet + write).
func Write(sheets []WriteSheet) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()
	for i, s := range sheets {
		if i == 0 {
			if err := f.SetSheetName("Sheet1", s.Name); err != nil {
				return nil, err
			}
		} else if _, err := f.NewSheet(s.Name); err != nil {
			return nil, err
		}
		for r, row := range s.Rows {
			ref, _ := excelize.CoordinatesToCellName(1, r+1)
			if err := f.SetSheetRow(s.Name, ref, &row); err != nil {
				return nil, err
			}
		}
		if s.AutoFilter && len(s.Rows) > 0 && len(s.Rows[0]) > 0 {
			end, _ := excelize.CoordinatesToCellName(len(s.Rows[0]), max(1, len(s.Rows)))
			if err := f.AutoFilter(s.Name, "A1:"+end, nil); err != nil {
				return nil, err
			}
		}
	}
	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
