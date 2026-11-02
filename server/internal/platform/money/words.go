package money

import "strings"

var (
	wordOnes = []string{"", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"}
	wordTens = []string{"", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"}
)

func underHundred(v int64) string {
	if v < 20 {
		return wordOnes[v]
	}
	if o := wordOnes[v%10]; o != "" {
		return wordTens[v/10] + " " + o
	}
	return wordTens[v/10]
}

func underThousand(v int64) string {
	rest := underHundred(v % 100)
	if v/100 == 0 {
		return rest
	}
	lead := wordOnes[v/100] + " Hundred"
	if rest != "" {
		return lead + " " + rest
	}
	return lead
}

// amountInWords is amountInWords: lakh and crore, the way Nepal groups.
func AmountInWords(rupees int64) string {
	if rupees == 0 {
		return "Zero Rupees Only"
	}
	var parts []string
	rest := rupees
	for _, g := range []struct {
		div  int64
		name string
		two  bool
	}{{10_000_000, "Crore", false}, {100_000, "Lakh", true}, {1_000, "Thousand", false}} {
		if n := rest / g.div; n > 0 {
			spoken := underThousand(n)
			if g.two {
				spoken = underHundred(n)
			}
			parts = append(parts, spoken+" "+g.name)
			rest -= n * g.div
		}
	}
	if rest > 0 {
		parts = append(parts, underThousand(rest))
	}
	return strings.Join(parts, " ") + " Rupees Only"
}
