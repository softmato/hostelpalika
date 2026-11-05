package storage

import "testing"

func TestSafeExt(t *testing.T) {
	for in, want := range map[string]string{"a.PNG": "png", "doc.pdf": "pdf", "x./../../y": "bin", "noext": "noext",
		"a.toolongextension": "bin", "a.": "bin", "a.jp g": "bin", "a.tar.gz": "gz"} {
		if got := SafeExt(in); got != want {
			t.Errorf("SafeExt(%q) = %q, want %q", in, got, want)
		}
	}
}
