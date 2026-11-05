// Package pdfin reads a PDF's text layer through poppler's pdftotext (the
// runtime image ships poppler-utils), replacing unpdf's extractText with
// mergePages. Readers of the text (evidence autofill, statement import) match
// on words and numbers, never on pdf.js's exact whitespace.
package pdfin

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// MaxBytes refuses anything larger before a process is started.
const MaxBytes = 20 << 20

const timeout = 15 * time.Second

// maxText bounds what pdftotext may print: a small PDF can expand to gigabytes of
// text (repeated content streams), and all of it was held in memory (P11-18).
const maxText = 8 << 20

// capped keeps up to max bytes, then fails the write, which ends pdftotext.
type capped struct {
	bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if c.Len()+len(p) > c.max {
		return 0, errors.New("pdfin: text past maxText")
	}
	return c.Buffer.Write(p)
}

// ErrNoText covers every failure: TS's readPdfText answers null for all of them.
var ErrNoText = errors.New("no readable text in this PDF")

// Text is the whole document's text, pages joined by newlines, trimmed.
func Text(ctx context.Context, pdf []byte) (string, error) {
	if len(pdf) == 0 || len(pdf) > MaxBytes || !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		return "", ErrNoText
	}
	// A temp file, not stdin: xpdf's pdftotext (dev machines) cannot read a pipe.
	f, err := os.CreateTemp("", "pdfin-*.pdf")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(pdf); err != nil {
		f.Close()
		return "", err
	}
	f.Close()

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out := capped{max: maxText}
	cmd := exec.CommandContext(ctx, "pdftotext", "-q", "-enc", "UTF-8", f.Name(), "-")
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", ErrNoText
	}
	text := strings.TrimSpace(strings.ReplaceAll(out.String(), "\f", "\n"))
	if text == "" {
		return "", ErrNoText
	}
	return text, nil
}
