package finance

import (
	"regexp"
	"strings"
	"unicode"
)

// qr-payee.ts: the payee a hostel's printed QR names, read from its OCR text.

var (
	qrNameLabels   = regexp.MustCompile(`(?i)(?:^|\n)[ \t|]*(?:merchant(?:'s)?\s+name|account\s+(?:holder(?:'s)?\s+)?name|a/?c\s+name|beneficiary(?:'s)?\s+name|payee(?:'s)?\s+name|holder(?:'s)?\s+name|account\s+holder|name)[ \t|]*[:\-–]?[ \t|]*(?:\n[ \t|]*)?([^\n]{2,80})`)
	qrNumberLabels = regexp.MustCompile(`(?i)(?:^|\n)[ \t|]*(?:account\s+(?:no|number)|a/?c\s+(?:no|number)|esewa\s+id|khalti\s+id|wallet\s+(?:id|no|number)|mobile\s+(?:no|number)|contact\s+(?:no|number))[ \t|.]*[:\-–]?[ \t|]*(?:\n[ \t|]*)?([^\n]{2,60})`)
	qrReceive      = regexp.MustCompile(`(?i)(?:show\s+this\s+qr|receive\s+money|scan\s*(?:&|and)?\s*pay|scan\s+to\s+pay|scan\s+me|merchant\s+qr|payment\s+qr|fonepay|nepalpay|esewa|khalti|ime\s*pay|connect\s*ips)`)
	qrNotAccount   = regexp.MustCompile(`(?i)(?:help\s*line|helpline|customer\s+(?:care|service)|support|toll\s*free|contact\s+us|call\s+us|hotline|branch\s+code|swift|pan\b|vat\b)`)
	qrStandalone   = regexp.MustCompile(`^[\s|]*([\d०-९][\d०-९\s-]{7,24})[\s|.]*$`)
	qrWordmark     = regexp.MustCompile(`(?i)^(?:e[\s-]?sewa|khalti|fonepay|nepalpay|ime\s*pay|connect\s*ips|prabhu\s*pay|nic\s*asia|nabil|global\s*ime|everest|siddhartha|machhapuchchhre|kumari|sanima|laxmi|nmb|citizens?)\b`)
	qrNotName      = regexp.MustCompile(`(?i)https?:|www\.|@|rs\.?\s*\d|npr|\d{4,}`)
	qrNameTail     = regexp.MustCompile(`\d[\d\s-]{5,}.*$`)
	qrSpaces       = regexp.MustCompile(`\s{2,}`)
	qrTrailPunct   = regexp.MustCompile(`[.,;:|]+$`)
	qrLetter       = regexp.MustCompile(`[A-Za-zऀ-ॿ]`)
	qrLines        = regexp.MustCompile(`\r?\n`)
)

// QRPayee is QrPayeeRead.
type QRPayee struct {
	AccountNumber *string
	Name          *string
}

// Found is hasQrPayee.
func (q QRPayee) Found() bool { return q.AccountNumber != nil || q.Name != nil }

func qrDigits(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= '०' && r <= '९' {
			return '0' + (r - '०')
		}
		if unicode.IsDigit(r) && r < 128 {
			return r
		}
		return -1
	}, s)
}

func qrCleanName(raw string) *string {
	s := qrNameTail.ReplaceAllString(raw, "")
	s = qrSpaces.ReplaceAllString(s, " ")
	s = strings.TrimSpace(qrTrailPunct.ReplaceAllString(s, ""))
	if len([]rune(s)) < 2 || !qrLetter.MatchString(s) {
		return nil
	}
	if r := []rune(s); len(r) > 120 {
		s = string(r[:120])
	}
	return &s
}

func qrCleanNumber(raw string) *string {
	d := qrDigits(raw)
	if len(d) < 8 || len(d) > 20 {
		return nil
	}
	return &d
}

func qrLooksLikeName(line string) bool {
	v := strings.TrimSpace(line)
	n := len([]rune(v))
	if n < 3 || n > 60 || qrWordmark.MatchString(v) || qrNotAccount.MatchString(v) || qrNotName.MatchString(v) {
		return false
	}
	letters := 0
	for _, r := range v {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= 'ऀ' && r <= 'ॿ') {
			letters++
		}
	}
	return letters >= 3 && float64(letters)/float64(n) > 0.6
}

func qrUnlabelled(text string) QRPayee {
	if !qrReceive.MatchString(text) {
		return QRPayee{}
	}
	var lines []string
	for _, l := range qrLines.Split(text, -1) {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	for i, line := range lines {
		if qrNotAccount.MatchString(line) || (i > 0 && qrNotAccount.MatchString(lines[i-1])) {
			continue
		}
		m := qrStandalone.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		num := qrCleanNumber(m[1])
		if num == nil {
			continue
		}
		out := QRPayee{AccountNumber: num}
		for back := i - 1; back >= 0 && i-back <= 3; back-- {
			if qrLooksLikeName(lines[back]) {
				out.Name = qrCleanName(lines[back])
				break
			}
		}
		return out
	}
	return QRPayee{}
}

// ReadQRPayee is readQrPayee: labelled fields first, then a poster's bare number.
func ReadQRPayee(text string) QRPayee {
	if text == "" {
		return QRPayee{}
	}
	var out QRPayee
	if m := qrNumberLabels.FindStringSubmatch(text); m != nil {
		out.AccountNumber = qrCleanNumber(m[1])
	}
	if m := qrNameLabels.FindStringSubmatch(text); m != nil {
		out.Name = qrCleanName(m[1])
	}
	if out.AccountNumber != nil && out.Name != nil {
		return out
	}
	s := qrUnlabelled(text)
	if out.AccountNumber == nil {
		out.AccountNumber = s.AccountNumber
	}
	if out.Name == nil {
		out.Name = s.Name
	}
	return out
}
