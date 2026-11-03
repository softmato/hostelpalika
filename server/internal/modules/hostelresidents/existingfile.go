package hostelresidents

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/xuri/excelize/v2"

	"github.com/softmato/hostelpalika/server/internal/platform/bs"
	"github.com/softmato/hostelpalika/server/internal/platform/sheets"
)

// Cell readers: existing-residents-cells.ts.

const devanagariDigits = "०१२३४५६७८९"

func westernDigits(text string) string {
	return strings.Map(func(r rune) rune {
		if i := strings.IndexRune(devanagariDigits, r); i >= 0 {
			return rune('0' + i/len("०"))
		}
		return r
	}, text)
}

var (
	rupeeNoise = regexp.MustCompile(`(?i)rs\.?|npr|रु\.?|रू\.?|,|\s`)
	decimalRe  = regexp.MustCompile(`^\d+(\.\d+)?$`)
)

// readRupees: ok=false is "could not read" (undefined); nil is blank.
func readRupees(text string) (v *int64, ok bool) {
	cleaned := strings.TrimSpace(rupeeNoise.ReplaceAllString(westernDigits(text), ""))
	if cleaned == "" {
		return nil, true
	}
	if !decimalRe.MatchString(cleaned) {
		return nil, false
	}
	f, _ := strconv.ParseFloat(cleaned, 64)
	n := int64(math.Floor(f + 0.5))
	return &n, true
}

var monthSpellings = [][]string{
	{"baisakh", "baishakh", "baisakha", "baishak", "vaisakh", "वैशाख", "बैशाख", "बैसाख"},
	{"jestha", "jeth", "jeshtha", "jyestha", "जेठ", "जेष्ठ", "ज्येष्ठ"},
	{"asar", "asadh", "ashadh", "ashar", "asad", "असार", "आषाढ", "आषाढ़"},
	{"shrawan", "saun", "sawan", "srawan", "shravan", "sharwan", "साउन", "श्रावण"},
	{"bhadra", "bhadau", "bhado", "भदौ", "भाद्र"},
	{"aswin", "asoj", "ashwin", "asoj", "ashoj", "असोज", "आश्विन"},
	{"kartik", "kattik", "kartika", "कात्तिक", "कार्तिक"},
	{"mangsir", "mangshir", "marga", "mansir", "मंसिर", "मङ्सिर", "मार्ग"},
	{"poush", "push", "paush", "pus", "पुस", "पौष", "पुष"},
	{"magh", "माघ"},
	{"falgun", "fagun", "phalgun", "phagun", "फागुन", "फाल्गुन"},
	{"chaitra", "chait", "chaita", "चैत", "चैत्र"},
}

func monthFromWord(word string) int {
	key := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= 'ऀ' && r <= 'ॿ') {
			return unicode.ToLower(r)
		}
		return -1
	}, word)
	if key == "" {
		return 0
	}
	for i, spellings := range monthSpellings {
		for _, s := range spellings {
			if s == key {
				return i + 1
			}
		}
	}
	return 0
}

func fullYear(text string) int {
	v, err := strconv.Atoi(text)
	if err != nil {
		return 0
	}
	if len(text) == 2 {
		v += 2000
	}
	if v >= 2070 && v <= 2090 {
		return v
	}
	return 0
}

var (
	numericMonth = regexp.MustCompile(`^(\d{4})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*\d{1,2})?$`)
	splitWords   = regexp.MustCompile(`[\s,\-/]+`)
	allDigits    = regexp.MustCompile(`^\d+$`)
	joinedRe     = regexp.MustCompile(`^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})`)
)

// readBsMonth: "" with ok is blank; ok=false is unreadable.
func readBsMonth(text string) (string, bool) {
	cleaned := strings.TrimSpace(westernDigits(text))
	if cleaned == "" {
		return "", true
	}
	if m := numericMonth.FindStringSubmatch(cleaned); m != nil {
		y, mo := fullYear(m[1]), 0
		mo, _ = strconv.Atoi(m[2])
		if y != 0 && mo >= 1 && mo <= 12 {
			return bs.FormatPeriodKey(y, mo), true
		}
		return "", false
	}
	var parts []string
	for _, p := range splitWords.Split(cleaned, -1) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) != 2 {
		return "", false
	}
	month := monthFromWord(parts[0])
	if month == 0 {
		month = monthFromWord(parts[1])
	}
	year := 0
	if allDigits.MatchString(parts[0]) {
		year = fullYear(parts[0])
	} else {
		year = fullYear(parts[1])
	}
	if month != 0 && year != 0 {
		return bs.FormatPeriodKey(year, month), true
	}
	return "", false
}

var monthsDueRe = regexp.MustCompile(`^\d{1,2}$`)
var trailingZeros = regexp.MustCompile(`\.0+$`)

// readMonthsDue: nil blank, ok=false unreadable.
func readMonthsDue(text string) (*int, bool) {
	cleaned := trailingZeros.ReplaceAllString(strings.TrimSpace(westernDigits(text)), "")
	if cleaned == "" {
		return nil, true
	}
	if !monthsDueRe.MatchString(cleaned) {
		return nil, false
	}
	n, _ := strconv.Atoi(cleaned)
	return &n, true
}

// readJoinedDate: nil blank, ok=false unreadable.
func readJoinedDate(text string) (*time.Time, bool) {
	cleaned := strings.TrimSpace(westernDigits(text))
	if cleaned == "" {
		return nil, true
	}
	m := joinedRe.FindStringSubmatch(cleaned)
	if m == nil {
		return nil, false
	}
	year, _ := strconv.Atoi(m[1])
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])
	if month < 1 || month > 12 || day < 1 || day > 32 {
		return nil, false
	}
	switch {
	case year >= 2060 && year <= 2090:
		t, err := bs.FromBs(bs.Date{Day: day, Month: month, Year: year})
		if err != nil {
			return nil, false
		}
		return &t, true
	case year >= 2000 && year <= 2040:
		t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
		if int(t.Month()) != month {
			return nil, false
		}
		return &t, true
	}
	return nil, false
}

// defaultJoinedDate is the 1st of the earlier of the month paid till and this month.
func defaultJoinedDate(paidTill, current string) time.Time {
	p := current
	if paidTill < current {
		p = paidTill
	}
	y, m, _ := bs.PeriodParts(p)
	t, _ := bs.FromBs(bs.Date{Day: 1, Month: m, Year: y})
	return t
}

func readPhone(text string) string {
	cleaned := trailingZeros.ReplaceAllString(strings.TrimSpace(westernDigits(text)), "")
	plus := ""
	if strings.HasPrefix(cleaned, "+") {
		plus = "+"
	}
	return plus + strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, cleaned)
}

// File reading and the blank template: existing-residents-file.ts.

type fileRow struct {
	DepositPaid int64
	Email       string
	FullName    string
	JoinedDate  *time.Time
	OldDues     int64
	PaidTill    string
	Phone       string
	RoomNumber  string
	RoomType    string
}

type fileColumn struct{ key, label string }

var existingColumns = []fileColumn{
	{"fullName", "Full name"}, {"phone", "Phone"}, {"roomType", "Room type"}, {"monthlyRent", "Monthly rent (Rs)"}, {"depositPaid", "Deposit paid (Rs)"},
	{"monthsDue", "Months due"}, {"oldDues", "Old dues (Rs)"}, {"joinedDate", "Joined date"}, {"email", "Email"},
}

var roomNumberColumn = fileColumn{"roomNumber", "Room no."}

var extraColumns = []fileColumn{{"paidTill", "Rent paid till"}, roomNumberColumn}

var headerAliases = map[string][]string{
	"depositPaid": {"depositpaid", "deposit", "securitydeposit", "depositamount"},
	"email":       {"email", "emailaddress", "mail"},
	"fullName":    {"fullname", "name", "residentname", "studentname"},
	"joinedDate":  {"joineddate", "joined", "joiningdate", "joindate", "moveindate", "admissiondate"},
	"monthlyRent": {"monthlyrent", "rent", "monthlyfee", "fee", "rentamount"},
	"monthsDue":   {"monthsdue", "monthdue", "monthsnotpaid", "unpaidmonths", "duemonths", "monthsunpaid"},
	"oldDues":     {"olddues", "dues", "due", "dueamount", "remaining", "baki"},
	"paidTill":    {"rentpaidtill", "paidtill", "paiduntil", "rentpaidupto", "paidupto", "paidtillmonth"},
	"phone":       {"phone", "phonenumber", "mobile", "mobilenumber", "contact", "contactnumber"},
	"roomNumber":  {"roomno", "roomnumber", "roomnum", "roomnos"},
	"roomType":    {"roomtype", "room", "roomcategory"},
}

const (
	maxFileRows  = 500
	maxFileBytes = 2 * 1024 * 1024
)

var (
	parenRe   = regexp.MustCompile(`\(.*?\)`)
	notLetter = regexp.MustCompile(`[^a-z]`)
)

func columnFor(header string) string {
	key := notLetter.ReplaceAllString(parenRe.ReplaceAllString(strings.ToLower(header), ""), "")
	if key == "" {
		return ""
	}
	for _, c := range append(append([]fileColumn{}, existingColumns...), extraColumns...) {
		for _, a := range headerAliases[c.key] {
			if a == key {
				return c.key
			}
		}
	}
	return ""
}

// headerColumns maps column index to key; a key is taken once.
func headerColumns(row []string) map[int]string {
	out := map[int]string{}
	taken := map[string]bool{}
	for i, cell := range row {
		if k := columnFor(cell); k != "" && !taken[k] {
			out[i], taken[k] = k, true
		}
	}
	return out
}

func fileErr(msg string) error { return rerr(msg, "EXISTING_RESIDENTS_FILE_UNREADABLE", 422) }

func gridFromBytes(b []byte) ([][]string, error) {
	var grids [][][]string
	if shs, err := sheets.Read(b, 0); err == nil {
		for _, s := range shs {
			grids = append(grids, s.Rows)
		}
	} else if !errors.Is(err, sheets.ErrUnreadable) || bytes.HasPrefix(b, []byte("PK")) || bytes.HasPrefix(b, []byte("\xd0\xcf\x11\xe0")) {
		return nil, fileErr("This file could not be opened. Upload the Excel file you downloaded, or a CSV file.")
	} else {
		r := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(b), "\ufeff")))
		r.FieldsPerRecord = -1
		r.LazyQuotes = true
		var grid [][]string
		for {
			rec, err := r.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, fileErr("This file could not be opened. Upload the Excel file you downloaded, or a CSV file.")
			}
			grid = append(grid, rec)
		}
		grids = append(grids, grid)
	}
	for _, grid := range grids {
		for i := 0; i < len(grid) && i < 10; i++ {
			if len(headerColumns(grid[i])) >= 2 {
				return grid, nil
			}
		}
	}
	return nil, fileErr(`We could not find the "Full name" and "Phone" columns. Use the Excel file you downloaded and keep its first row.`)
}

// readExistingFile is readExistingResidentsFile.
func readExistingFile(b []byte, currentPeriod string) (rows []fileRow, notes []string, err error) {
	if len(b) == 0 {
		return nil, nil, fileErr("This file is empty.")
	}
	if len(b) > maxFileBytes {
		return nil, nil, fileErr("This file is too big. Keep it under 2 MB.")
	}
	grid, err := gridFromBytes(b)
	if err != nil {
		return nil, nil, err
	}
	header := -1
	for i := 0; i < len(grid) && i < 10; i++ {
		if len(headerColumns(grid[i])) >= 2 {
			header = i
			break
		}
	}
	columns := headerColumns(grid[header])
	found := map[string]bool{}
	for _, k := range columns {
		found[k] = true
	}
	if !found["fullName"] || !found["phone"] {
		return nil, nil, fileErr(`The file needs a "Full name" column and a "Phone" column in its first row.`)
	}
	for index := header + 1; index < len(grid); index++ {
		cells := grid[index]
		value := func(key string) string {
			for col, k := range columns {
				if k == key && col < len(cells) {
					return strings.TrimSpace(cells[col])
				}
			}
			return ""
		}
		blank := true
		for col := range columns {
			if col < len(cells) && strings.TrimSpace(cells[col]) != "" {
				blank = false
			}
		}
		if blank {
			continue
		}
		if len(rows) >= maxFileRows {
			notes = append(notes, fmt.Sprintf("Only the first %d residents were read. Upload the rest in a second file.", maxFileRows))
			break
		}
		line := index + 1
		cannot := func(label, text string) {
			notes = append(notes, fmt.Sprintf(`Line %d: could not read %s "%s".`, line, label, text))
		}
		deposit, depOK := readRupees(value("depositPaid"))
		dues, duesOK := readRupees(value("oldDues"))
		monthsDue, monthsOK := readMonthsDue(value("monthsDue"))
		paidTillText, paidOK := readBsMonth(value("paidTill"))
		paidTill := paidTillText
		if monthsDue != nil {
			paidTill, _ = bs.AddMonths(currentPeriod, -*monthsDue)
		}
		joined, joinOK := readJoinedDate(value("joinedDate"))
		if !depOK {
			cannot("Deposit paid", value("depositPaid"))
		}
		if !duesOK {
			cannot("Old dues", value("oldDues"))
		}
		if !monthsOK {
			cannot("Months due", value("monthsDue"))
		}
		if monthsDue == nil && monthsOK && !paidOK {
			cannot("Rent paid till", value("paidTill"))
		}
		if !joinOK {
			cannot("Joined date", value("joinedDate"))
		}
		row := fileRow{Email: strings.ToLower(value("email")), FullName: strings.Join(strings.Fields(value("fullName")), " "), JoinedDate: joined, PaidTill: paidTill,
			Phone: readPhone(value("phone")), RoomNumber: value("roomNumber"), RoomType: value("roomType")}
		if deposit != nil {
			row.DepositPaid = *deposit
		}
		if dues != nil {
			row.OldDues = *dues
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, nil, fileErr("No residents were found in this file.")
	}
	return rows, notes, nil
}

type templateRoom struct {
	MonthlyRent *int64
	RoomType    string
}

// buildTemplate is buildExistingResidentsTemplate: the blank workbook with the
// hostel's room types on its help sheet.
func buildTemplate(currentMonth, hostelName string, roomNumbers []string, roomTypes []templateRoom) ([]byte, error) {
	withRooms := len(roomNumbers) > 0
	columns := append([]fileColumn{}, existingColumns...)
	if withRooms {
		columns = append(columns, roomNumberColumn)
	}
	var exampleRooms []string
	if withRooms {
		second := roomNumbers[0]
		if len(roomNumbers) > 1 {
			second = roomNumbers[1]
		}
		exampleRooms = []string{roomNumbers[0], second}
	}
	rentOf := func(r templateRoom) any {
		if r.MonthlyRent == nil {
			return ""
		}
		return *r.MonthlyRent
	}
	firstType, firstRent := "Double", any("")
	if len(roomTypes) > 0 {
		firstType, firstRent = roomTypes[0].RoomType, rentOf(roomTypes[0])
	}
	labels := make([]any, len(columns))
	for i, c := range columns {
		labels[i] = c.label
	}
	help := [][]any{
		{"Residents already living in " + hostelName}, {}, {"Fill one line for each resident on the Residents sheet. Do not change the first line."}, {},
		{"Column", "What to write", "Needed"},
		{"Full name", "First and last name", "Yes"}, {"Phone", "Mobile number", "Yes"},
		{"Room type", "One of the room types below, written the same way", "Yes"},
		{"Monthly rent (Rs)", "Fills itself from the room type, from the rate card. Do not type in it", "Auto"},
		{"Deposit paid (Rs)", "Security deposit you are holding for them", "No"},
		{"Months due", fmt.Sprintf("Months of rent not paid. 0 = %[1]s is paid. 1 = only %[1]s is not paid. 2 = this month and last month are not paid.", currentMonth), "Yes"},
		{"Old dues (Rs)", "Any other money they still owe you from before", "No"},
		{"Joined date", "Date they joined, like 2082-04-15 (Nepali date). Empty = the 1st of the month their rent is paid till", "No"},
		{"Email", "Their email, if they use one", "No"},
	}
	if withRooms {
		help = append(help, []any{"Room no.", fmt.Sprintf("Their room number, like %s. The room type can be left empty then", roomNumbers[0]), "Yes"})
	}
	ex1 := []any{"Ram Thapa", "9841234567", firstType, firstRent, "10000", "1", "2500", "2082-04-15", ""}
	ex2 := []any{"Sita KC", "9801234567", firstType, firstRent, "10000", "0", "", "", ""}
	if withRooms {
		ex1, ex2 = append(ex1, exampleRooms[0]), append(ex2, exampleRooms[1])
	}
	help = append(help, []any{}, []any{"Example"}, labels, ex1, ex2, []any{}, []any{"Room types in this hostel", "Monthly rent from the rate card (Rs)"})
	roomsFrom := len(help) + 1
	for _, r := range roomTypes {
		help = append(help, []any{r.RoomType, rentOf(r)})
	}
	help = append(help, []any{}, []any{"Paid in advance? Write 0, then change it in the list after you upload."})
	roomsTo := roomsFrom + len(roomTypes) - 1

	f := excelize.NewFile()
	defer f.Close()
	if err := f.SetSheetName("Sheet1", "Residents"); err != nil {
		return nil, err
	}
	if _, err := f.NewSheet("How to fill"); err != nil {
		return nil, err
	}
	if err := f.SetSheetRow("Residents", "A1", &labels); err != nil {
		return nil, err
	}
	if len(roomTypes) > 0 {
		for line := 2; line <= maxFileRows+1; line++ {
			cell := "D" + strconv.Itoa(line)
			formula := fmt.Sprintf(`IF($C%[1]d="","",IFERROR(VLOOKUP($C%[1]d,'How to fill'!$A$%[2]d:$B$%[3]d,2,FALSE),""))`, line, roomsFrom, roomsTo)
			if err := f.SetCellFormula("Residents", cell, formula); err != nil {
				return nil, err
			}
		}
	}
	widths := []float64{26, 15, 18, 18, 18, 16, 15, 14, 28}
	if withRooms {
		widths = append(widths, 10)
	}
	for i, w := range widths {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth("Residents", col, col, w)
	}
	for r, row := range help {
		ref, _ := excelize.CoordinatesToCellName(1, r+1)
		if len(row) == 0 {
			continue
		}
		if err := f.SetSheetRow("How to fill", ref, &row); err != nil {
			return nil, err
		}
	}
	for i, w := range []float64{26, 60, 10} {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth("How to fill", col, col, w)
	}
	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
