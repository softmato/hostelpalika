package guide

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/softmato/hostelpalika/server/internal/platform/ordered"
)

// The goldens are what the TS functions give for the same fixture
// (scripts/guide-golden.ts), so this compares bytes: values and key order.
func TestForReaderMatchesTS(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "content.json"))
	if err != nil {
		t.Fatal(err)
	}
	content, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(content)

	for _, reader := range []string{"visitor", "resident", "warden", "owner"} {
		t.Run(reader, func(t *testing.T) {
			want, err := os.ReadFile(filepath.Join("testdata", reader+".json"))
			if err != nil {
				t.Fatal(err)
			}
			got, err := json.Marshal(ordered.Map{
				{Key: "guide", Value: WithPictureURLs(ForReader(content, reader), func(src string) string { return "signed:" + PictureName(src) })},
				{Key: "locked", Value: Locked(content, reader)},
			})
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, bytes.TrimSpace(want)) {
				t.Errorf("%s differs from TS\n got: %s\nwant: %s", reader, got, want)
			}
		})
	}

	after, _ := json.Marshal(content)
	if !bytes.Equal(before, after) {
		t.Error("ForReader/WithPictureURLs changed the cached content")
	}
}

func TestPrivateTextNeverReachesAVisitor(t *testing.T) {
	raw, _ := os.ReadFile(filepath.Join("testdata", "content.json"))
	content, _ := Parse(raw)
	got, _ := json.Marshal(ForReader(content, "visitor"))
	if strings.Contains(string(got), "Petty cash") || strings.Contains(string(got), "Food") {
		t.Errorf("visitor got staff-only text: %s", got)
	}
	if !strings.Contains(string(got), "Sign in on HostelPalika.") {
		t.Errorf("{platform} not filled in: %s", got)
	}
}

func TestReaderForRole(t *testing.T) {
	for role, want := range map[string]string{
		"HOSTEL_ADMIN": "owner", "WARDEN": "warden", "COOK": "cook", "RESIDENT": "resident",
		"GUARDIAN": "guardian", "SUPERADMIN": "all", "PLATFORM_AGENT": "all", "PUBLIC": "visitor", "": "visitor",
	} {
		if got := ReaderForRole(role); got != want {
			t.Errorf("%q → %q, want %q", role, got, want)
		}
	}
}
