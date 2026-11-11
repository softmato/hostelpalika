package email

import (
	"strings"
	"testing"
)

// The notice text is the platform team's own: escaped, paragraphs on blank
// lines, single breaks kept — same rules as platformNoticeEmail in TS.
func TestPlatformNoticeEscapesAndSplits(t *testing.T) {
	m := PlatformNotice("Add <b>photos</b>.\nThree at least.\n\n\nThanks", "https://x/hostel-admin", "Sun & Moon", "Sita", "Fix listing")
	if m.Subject != "Fix listing — Sun & Moon" || m.Category != Info {
		t.Fatalf("subject/category: %q %q", m.Subject, m.Category)
	}
	for _, want := range []string{"Add &lt;b&gt;photos&lt;/b&gt;.<br>Three at least.</p>", ">Thanks</p>", "Hi Sita,", "https://x/hostel-admin"} {
		if !strings.Contains(m.HTML, want) {
			t.Errorf("html missing %q", want)
		}
	}
	if strings.Contains(m.HTML, "<b>photos") {
		t.Error("notice body was not escaped")
	}
}
