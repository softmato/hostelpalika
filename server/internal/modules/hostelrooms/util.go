package hostelrooms

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/softmato/hostelpalika/server/internal/platform/email"
)

// TypeLabel is roomTypeLabel.
func TypeLabel(roomType string) string { return email.RoomTypeLabel(roomType) }

var (
	bedsByType = map[string]int{"Single Room": 1, "Double Sharing": 2, "Triple Sharing": 3, "Four Sharing": 4}
	bedWords   = map[string]int{"single": 1, "double": 2, "two": 2, "triple": 3, "three": 3, "four": 4, "quad": 4, "five": 5, "six": 6, "dorm": 6, "dormitory": 6}
	digits12   = regexp.MustCompile(`(\d{1,2})`)
	nonLetters = regexp.MustCompile(`[^a-z]+`)
)

// BedsFor is bedsForRoomType: beds in one room of a type, read off its name.
func BedsFor(roomType string) int {
	base := strings.TrimSuffix(roomType, " — Attached Bathroom")
	if n, ok := bedsByType[base]; ok {
		return n
	}
	if m := digits12.FindStringSubmatch(roomType); m != nil {
		n, _ := strconv.Atoi(m[1])
		return max(1, n)
	}
	for _, part := range nonLetters.Split(strings.ToLower(roomType), -1) {
		if n, ok := bedWords[part]; ok {
			return n
		}
	}
	return 1
}

// Floor is floorLabel: "Ground floor", "1st floor", "Basement".
func Floor(floor int) string {
	switch {
	case floor == 0:
		return "Ground floor"
	case floor == -1:
		return "Basement"
	case floor < 0:
		return "Basement " + strconv.Itoa(-floor)
	}
	suffix := "th"
	if tens := floor % 100; tens < 11 || tens > 13 {
		switch floor % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return strconv.Itoa(floor) + suffix + " floor"
}

// jsLess is `a.localeCompare(b, undefined, {numeric: true}) < 0`: digit runs
// compare as numbers, letters ignore case first. ponytail: not full ICU
// collation; ties on case fall back to lowercase-first, punctuation sorts by
// code point.
func jsLess(a, b string) bool { return numericCompare(a, b) < 0 }

func numericCompare(a, b string) int {
	ar, br := []rune(a), []rune(b)
	i, j := 0, 0
	for i < len(ar) && j < len(br) {
		if unicode.IsDigit(ar[i]) && unicode.IsDigit(br[j]) {
			si, sj := i, j
			for i < len(ar) && unicode.IsDigit(ar[i]) {
				i++
			}
			for j < len(br) && unicode.IsDigit(br[j]) {
				j++
			}
			x := strings.TrimLeft(string(ar[si:i]), "0")
			y := strings.TrimLeft(string(br[sj:j]), "0")
			if len(x) != len(y) {
				if len(x) < len(y) {
					return -1
				}
				return 1
			}
			if c := strings.Compare(x, y); c != 0 {
				return c
			}
			continue
		}
		x, y := unicode.ToLower(ar[i]), unicode.ToLower(br[j])
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
		i++
		j++
	}
	switch {
	case i < len(ar):
		return 1
	case j < len(br):
		return -1
	}
	// Same letters: lowercase sorts before uppercase.
	for k := 0; k < len(ar) && k < len(br); k++ {
		if ar[k] != br[k] {
			if unicode.IsLower(ar[k]) {
				return -1
			}
			return 1
		}
	}
	return 0
}
