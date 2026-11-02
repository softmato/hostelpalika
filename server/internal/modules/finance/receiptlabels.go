package finance

import "regexp"

// remarksLabels is each receipt template's remarks label.
var remarksLabels = map[string]string{
	"ESEWA":      `(?:remarks?|purpose|description|particulars)`,
	"KHALTI":     `(?:remarks?|purpose|reference|detail|product\s*name)`,
	"FONEPAY":    `(?:remarks?|purpose|reference|narration)`,
	"CONNECTIPS": `(?:remarks?|purpose|narration|particulars)`,
	"BANK":       `(?:remarks?|purpose|narration|particulars|description)`,
}

func init() {
	for _, s := range remarksLabels {
		labelCache[s] = [3]*regexp.Regexp{
			ci(`(?:^|\n)[ \t|]*(?:` + s + `)[ \t|]*[:\-–][ \t|]*([^\n]{1,120})`),
			ci(`(?:^|\n)[ \t|]*(?:` + s + `)[ \t|]{1,}([^\n]{1,120})`),
			ci(`(?:^|\n)[ \t|]*(?:` + s + `)[ \t|]*\n[ \t|]*([^\n]{1,120})`),
		}
	}
}

// ReceiptRemarks is parseReceipt's remarks: the typed note on a one-payment receipt.
func ReceiptRemarks(text string, r ParsedReceipt) string {
	if r.Shape != "RECEIPT" {
		return ""
	}
	return labelledValue(text, remarksLabels[r.Provider])
}

type labelled struct {
	re       *regexp.Regexp
	category string
}

var (
	billers = []labelled{{ci(`\b(nea|nepal electricity authority)\b`), "ELECTRICITY"}, {ci(`\b(kukl|kathmandu upatyaka khanepani|khanepani)\b`), "WATER"},
		{ci(`\b(worldlink|world link|vianet|subisu|classic tech|dishhome|dish home|ntc ftth|techminds)\b`), "INTERNET"}, {ci(`\b(bhat-?bhateni|big mart|salesway|daraz mart)\b`), "GROCERIES"}}
	receiptWords = []labelled{{ci(`\b(electricity|bijuli|light bill)\b`), "ELECTRICITY"}, {ci(`\b(water|jar|tanker|khanepani)\b`), "WATER"}, {ci(`\b(internet|wi-?fi|broadband|ftth)\b`), "INTERNET"}, {ci(`\b(gas|lpg|cylinder)\b`), "GAS"},
		{ci(`\b(salary|salaries|wages?|talab|tankha|payroll)\b`), "SALARY"}, {ci(`\b(rent|bhada|bhaada)\b`), "RENT"}, {ci(`\b(vegetables?|veg|tarkari|sabji|meat|masu|chicken|mutton|buff|fish|eggs?|fruits?)\b`), "VEGETABLES_MEAT"},
		{ci(`\b(grocer(?:y|ies)|kirana|mart|rice|chamal|dal|daal|oil|ration)\b`), "GROCERIES"}, {ci(`\b(repair|plumb(?:er|ing)|electrician|maintenance|marmat|hardware|paint)\b`), "REPAIR"}, {ci(`\b(clean(?:ing|er)?|sweeper|detergent|phenyl|laundry|safai)\b`), "CLEANING"}}
)

// ReceiptCategory is receiptCategory: what the typed words say first, then who was paid.
func ReceiptCategory(text, payee, remarks string) string {
	typed := remarks
	if payee != "" {
		if typed != "" {
			typed += " \n "
		}
		typed += payee
	}
	if typed != "" {
		for _, w := range receiptWords {
			if w.re.MatchString(typed) {
				return w.category
			}
		}
	}
	if text != "" {
		for _, b := range billers {
			if b.re.MatchString(text) {
				return b.category
			}
		}
	}
	return ""
}
