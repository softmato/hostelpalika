// Package money is the platform's money arithmetic, as int64.
//
// Finance stores whole rupees (apps/web/src/modules/finance/money.ts); the
// supply-store catalogue and Softmato's API are paisa
// (billing/softmato/money.ts). Both refuse fractions, so neither is a float here.
// Held to testdata/vectors/money.json.
package money

import (
	"errors"
	"fmt"
	"math"
	"strconv"
)

// Currency is printed before every amount.
const Currency = "NPR"

// PaisaPerRupee is Softmato's conversion factor.
const PaisaPerRupee = 100

// maxSafe is Number.MAX_SAFE_INTEGER: past it TS can no longer hold an amount exactly,
// so a total beyond it is refused on both sides.
const maxSafe = 1<<53 - 1

// ErrOutOfBounds carries the TS FinanceServiceError code AMOUNT_OUT_OF_BOUNDS.
var ErrOutOfBounds = errors.New("AMOUNT_OUT_OF_BOUNDS")

func outOfBounds(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrOutOfBounds}, args...)...)
}

// RoundToRupee rounds half away from zero — the only sanctioned way to turn a
// fractional computation into a storable amount.
func RoundToRupee(amount float64) (int64, error) {
	if math.IsNaN(amount) || math.IsInf(amount, 0) {
		return 0, outOfBounds("Cannot round a non-finite amount.")
	}
	return int64(math.Round(amount)), nil
}

// Sum adds whole-rupee amounts, refusing a total TS could not represent exactly.
func Sum(amounts []int64) (int64, error) {
	var total int64
	for _, a := range amounts {
		if a > maxSafe || a < -maxSafe {
			return 0, outOfBounds("amount is too large to represent exactly.")
		}
		total += a
	}
	if total > maxSafe || total < -maxSafe {
		return 0, outOfBounds("total is too large to represent exactly.")
	}
	return total, nil
}

// Prorate charges billableDays of a month, rounding once; a full month (or more)
// is the untouched monthly amount.
func Prorate(monthly int64, billableDays, daysInMonth int) (int64, error) {
	if daysInMonth <= 0 {
		return 0, outOfBounds("A month must have at least one day.")
	}
	if billableDays <= 0 {
		return 0, nil
	}
	if billableDays >= daysInMonth {
		return monthly, nil
	}
	return RoundToRupee(float64(monthly) / float64(daysInMonth) * float64(billableDays))
}

// Split divides amount into parts shares that sum back exactly; the remainder
// goes to the earliest shares. 1,000 three ways is [334 333 333].
func Split(amount int64, parts int) ([]int64, error) {
	if parts <= 0 {
		return nil, outOfBounds("Cannot split into a non-positive number of parts.")
	}
	base := amount / int64(parts)
	remainder := amount - base*int64(parts)
	step := int64(1)
	if remainder < 0 {
		step, remainder = -1, -remainder
	}
	out := make([]int64, parts)
	for i := range out {
		out[i] = base
		if int64(i) < remainder {
			out[i] += step
		}
	}
	return out, nil
}

// RupeesToPaisa is exact.
func RupeesToPaisa(rupees int64) int64 { return rupees * PaisaPerRupee }

// PaisaToRupees refuses an amount that is not whole rupees rather than rounding.
func PaisaToRupees(paisa int64) (int64, error) {
	if paisa%PaisaPerRupee != 0 {
		return 0, fmt.Errorf("Softmato reported %d paisa, which is not a whole number of rupees. This subscription's schema cannot hold it.", paisa)
	}
	return paisa / PaisaPerRupee, nil
}

/* Display */

// group inserts commas into a digit string: every 3 (en-US) or 3 then every 2 (en-IN lakh).
func group(digits string, lakh bool) string {
	if len(digits) <= 3 {
		return digits
	}
	head, tail := digits[:len(digits)-3], digits[len(digits)-3:]
	size := 3
	if lakh {
		size = 2
	}
	out := tail
	for len(head) > size {
		out = head[len(head)-size:] + "," + out
		head = head[:len(head)-size]
	}
	return head + "," + out
}

func grouped(n int64, lakh bool) string {
	sign := ""
	if n < 0 {
		sign = "-"
	}
	abs := strconv.FormatUint(uint64(n), 10)
	if n < 0 {
		abs = strconv.FormatUint(-uint64(n), 10)
	}
	return sign + group(abs, lakh)
}

// fixed2 formats paisa as rupees with two decimals, grouped.
func fixed2(paisa int64, lakh bool) string {
	sign := ""
	if paisa < 0 {
		sign, paisa = "-", -paisa
	}
	return fmt.Sprintf("%s%s.%02d", sign, grouped(paisa/PaisaPerRupee, lakh), paisa%PaisaPerRupee)
}

// GroupIN is a whole number with en-IN lakh grouping: 1,23,456.
func GroupIN(n int64) string { return grouped(n, true) }

// FormatNPR is "NPR 12,000" — the finance rendering, en-US grouping.
func FormatNPR(rupees int64) string { return Currency + " " + grouped(rupees, false) }

// FormatPlanRate is "NPR 1,23,456" — plan prices, en-IN grouping.
func FormatPlanRate(rupees int64) string { return Currency + " " + grouped(rupees, true) }

// FormatPaisa is 123456 → "1,234.56" (en-IN), display only.
func FormatPaisa(paisa int64) string { return fixed2(paisa, true) }

// FormatStoreNPR is the supply store's paisa price, "NPR 1,234.56" (en-NP groups like en-US).
func FormatStoreNPR(paisa int64) string { return Currency + " " + fixed2(paisa, false) }

// DocumentAmount is a whole-rupee figure on an invoice: "1,23,456.00".
func DocumentAmount(rupees int64) string { return grouped(rupees, true) + ".00" }
