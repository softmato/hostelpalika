package finance

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"strings"

	"github.com/ledongthuc/pdf"

	"github.com/softmato/hostelpalika/server/internal/platform/images"
)

const (
	hashWidth, hashHeight = 9, 8
	systemDocumentMarker  = "HOSTELDAYS-SYSTEM-DOCUMENT"
)

// PerceptualHash is computePerceptualHash: a 64-bit dHash as 16 hex characters;
// "" when the bytes cannot be decoded (no similarity check, not a failure).
func PerceptualHash(b []byte) string {
	px, err := images.GreyPixels(b, hashWidth, hashHeight)
	if err != nil || len(px) < hashWidth*hashHeight {
		return ""
	}
	var out strings.Builder
	nibble, bits := 0, 0
	for row := 0; row < hashHeight; row++ {
		for col := 0; col < hashWidth-1; col++ {
			nibble <<= 1
			if px[row*hashWidth+col] > px[row*hashWidth+col+1] {
				nibble |= 1
			}
			if bits++; bits == 4 {
				fmt.Fprintf(&out, "%x", nibble)
				nibble, bits = 0, 0
			}
		}
	}
	return out.String()
}

// SystemDocumentKind is systemDocumentKind: RECEIPT or STATEMENT for a PDF we
// stamped, read through its metadata; "" for anything else, unparseable included.
func SystemDocumentKind(b []byte) (kind string) {
	if len(b) < 5 || string(b[:5]) != "%PDF-" {
		return ""
	}
	defer func() { // the parser panics on malformed files
		if recover() != nil {
			kind = ""
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return ""
	}
	info := r.Trailer().Key("Info")
	for _, k := range []string{"Subject", "Creator", "Keywords"} {
		v := info.Key(k).Text()
		if strings.Contains(v, systemDocumentMarker) {
			if strings.Contains(v, systemDocumentMarker+"-STATEMENT") {
				return "STATEMENT"
			}
			return "RECEIPT"
		}
	}
	return ""
}

// Provenance is EvidenceProvenance; nil pointers are null, in the schema's fields.
type Provenance struct {
	Container           string  `bson:"container"`
	EditorSignature     *string `bson:"editorSignature"`
	HasCameraExif       bool    `bson:"hasCameraExif"`
	JpegQuality         *int    `bson:"jpegQuality"`
	QuantTablesStandard *bool   `bson:"quantTablesStandard"`
	ScreenshotShape     *bool   `bson:"screenshotShape"`
	SoftwareTag         *string `bson:"softwareTag"`
}

var editorMarkers = []string{"adobe imageready", "adobe lightroom", "adobe photoshop", "affinity photo", "canva", "figma", "gimp", "inkscape", "inshot",
	"krita", "lunapic", "meitu", "paint 3d", "paint.net", "photo editor", "photopea", "photoscape", "picsart", "pixelmator", "pixlr", "remini", "sketch", "snapseed"}

func isScreenShape(w, h int) bool {
	if w <= 0 || h <= 0 {
		return false
	}
	r := float64(w) / float64(h)
	return r >= 0.4 && r <= 0.72 || r >= 1.3 && r <= 2.5
}

var standardLuminance = [64]int{16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40,
	57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35,
	55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99}

var zigzag = [64]int{0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41,
	34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30,
	37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63}

// ijgEntry is libjpeg's table scaling; the float division matches JS's floor of a double.
func ijgEntry(standard, quality int) int {
	var scale float64
	if quality < 50 {
		scale = 5000 / float64(quality)
	} else {
		scale = float64(200 - quality*2)
	}
	return min(255, max(1, int(math.Floor((float64(standard)*scale+50)/100))))
}

func analyseLuminance(table []int) (int, bool) {
	var natural [64]int
	for i := 0; i < 64; i++ {
		natural[zigzag[i]] = table[i]
	}
	bestQ, bestErr := 0, -1
	for q := 1; q <= 100; q++ {
		e := 0
		for i := 0; i < 64; i++ {
			d := ijgEntry(standardLuminance[i], q) - natural[i]
			if d < 0 {
				d = -d
			}
			e += d
		}
		if bestErr < 0 || e < bestErr {
			bestErr, bestQ = e, q
		}
	}
	return bestQ, bestErr <= 2
}

type jpegSegment struct{ end, marker, start int }

type jpegScan struct {
	w, h     int
	hasSize  bool
	table    []int
	segments []jpegSegment
}

func scanJpeg(b []byte) *jpegScan {
	if len(b) < 4 || b[0] != 0xff || b[1] != 0xd8 {
		return nil
	}
	s := &jpegScan{}
	off := 2
	for off+3 < len(b) {
		if b[off] != 0xff {
			off++
			continue
		}
		m := int(b[off+1])
		if m == 0xff || m == 0x01 || m >= 0xd0 && m <= 0xd9 {
			off += 2
			continue
		}
		if m == 0xda {
			break
		}
		length := int(b[off+2])<<8 | int(b[off+3])
		if length < 2 || off+2+length > len(b) {
			break
		}
		start, end := off+4, off+2+length
		s.segments = append(s.segments, jpegSegment{end, m, start})
		if m >= 0xc0 && m <= 0xcf && m != 0xc4 && m != 0xc8 && m != 0xcc && !s.hasSize && start+5 < len(b) {
			s.h = int(b[start+1])<<8 | int(b[start+2])
			s.w = int(b[start+3])<<8 | int(b[start+4])
			s.hasSize = true
		}
		if m == 0xdb {
			for cur := start; cur < end; {
				spec := int(b[cur])
				precision, id := spec>>4, spec&0x0f
				size := 128
				if precision == 0 {
					size = 64
				}
				cur++
				if cur+size > end {
					break
				}
				if id == 0 && s.table == nil {
					t := make([]int, 64)
					for i := range t {
						if precision == 0 {
							t[i] = int(b[cur+i])
						} else {
							t[i] = int(b[cur+i*2])<<8 | int(b[cur+i*2+1])
						}
					}
					s.table = t
				}
				cur += size
			}
		}
		off = end
	}
	return s
}

func readExif(b []byte, start, end int) (camera bool, software *string) {
	tiff := start + 6
	if tiff+8 > end {
		return
	}
	var order binary.ByteOrder
	switch int(b[tiff])<<8 | int(b[tiff+1]) {
	case 0x4949:
		order = binary.LittleEndian
	case 0x4d4d:
		order = binary.BigEndian
	default:
		return
	}
	var readIFD func(off uint32, depth int)
	readIFD = func(off uint32, depth int) {
		at := tiff + int(off)
		if depth > 2 || at+2 > end {
			return
		}
		count := int(order.Uint16(b[at:]))
		if count > 512 {
			return
		}
		for i := 0; i < count; i++ {
			e := at + 2 + i*12
			if e+12 > end {
				return
			}
			tag, typ, length := order.Uint16(b[e:]), order.Uint16(b[e+2:]), order.Uint32(b[e+4:])
			switch tag {
			case 0x829a, 0x920a, 0x829d, 0x8827, 0xa434, 0x010f, 0x0110:
				camera = true
			}
			if tag == 0x8769 && typ == 4 {
				readIFD(order.Uint32(b[e+8:]), depth+1)
			}
			if tag == 0x0131 && typ == 2 && length > 0 {
				valueAt := e + 8
				if length > 4 {
					valueAt = tiff + int(order.Uint32(b[e+8:]))
				}
				if valueAt >= 0 && valueAt+int(length) <= end {
					var text strings.Builder
					for c := 0; c < min(int(length), 128); c++ {
						if b[valueAt+c] == 0 {
							break
						}
						text.WriteRune(rune(b[valueAt+c]))
					}
					if t := strings.TrimSpace(text.String()); t != "" {
						software = &t
					} else {
						software = nil
					}
				}
			}
		}
	}
	readIFD(order.Uint32(b[tiff+4:]), 0)
	return
}

func scanPng(b []byte) (ok bool, w, h int, hasSize bool, software *string) {
	if len(b) < 8 || !bytes.Equal(b[:8], []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}) {
		return
	}
	ok = true
	off := 8
	for off+8 <= len(b) {
		length := int(binary.BigEndian.Uint32(b[off:]))
		typ := string(b[off+4 : off+8])
		start := off + 8
		end := start + length
		if end > len(b) {
			break
		}
		if typ == "IHDR" && length >= 8 {
			w, h = int(binary.BigEndian.Uint32(b[start:])), int(binary.BigEndian.Uint32(b[start+4:]))
			hasSize = true
		}
		if (typ == "iTXt" || typ == "tEXt") && software == nil {
			var text strings.Builder
			for c := start; c < min(end, start+512); c++ {
				text.WriteRune(rune(b[c]))
			}
			parts := strings.Split(text.String(), "\x00")
			if strings.ToLower(strings.TrimSpace(parts[0])) == "software" {
				for _, p := range parts[1:] {
					if t := strings.TrimSpace(p); len([]rune(t)) > 1 {
						v := t
						software = &v
					}
				}
			}
		}
		if typ == "IEND" {
			break
		}
		off = end + 4
	}
	return
}

func containerOf(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff:
		return "jpeg"
	case len(b) >= 8 && b[0] == 0x89 && b[1] == 0x50:
		return "png"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "webp"
	case len(b) >= 5 && string(b[:5]) == "%PDF-":
		return "pdf"
	}
	return "other"
}

// ReadProvenance is readEvidenceProvenance: what the file says about how it was
// made. A container walk: it cannot fail an upload.
func ReadProvenance(b []byte) (p *Provenance) {
	p = &Provenance{Container: containerOf(b)}
	defer func() { // a truncated header reads as "no signal"
		if recover() != nil {
			out := *p
			p = &out
		}
	}()
	boolP := func(v bool) *bool { return &v }
	switch p.Container {
	case "jpeg":
		s := scanJpeg(b)
		if s == nil {
			return p
		}
		for _, seg := range s.segments {
			if seg.marker == 0xe1 && seg.start+6 <= len(b) && string(b[seg.start:seg.start+4]) == "Exif" {
				camera, software := readExif(b, seg.start, seg.end)
				p.HasCameraExif = p.HasCameraExif || camera
				if p.SoftwareTag == nil {
					p.SoftwareTag = software
				}
			}
		}
		if s.table != nil {
			q, std := analyseLuminance(s.table)
			p.JpegQuality, p.QuantTablesStandard = &q, &std
		}
		if s.hasSize {
			p.ScreenshotShape = boolP(isScreenShape(s.w, s.h))
		}
	case "png":
		ok, w, h, hasSize, software := scanPng(b)
		if !ok {
			return p
		}
		p.SoftwareTag = software
		if hasSize {
			p.ScreenshotShape = boolP(isScreenShape(w, h))
		}
	}
	if p.SoftwareTag != nil {
		hay := strings.ToLower(*p.SoftwareTag)
		for _, m := range editorMarkers {
			if strings.Contains(hay, m) {
				p.EditorSignature = p.SoftwareTag
				break
			}
		}
	}
	return p
}
