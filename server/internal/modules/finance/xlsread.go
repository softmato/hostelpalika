package finance

// A reader for legacy .xls (an OLE2 compound file holding a BIFF8 workbook): text and
// number cells only, which is all a statement export carries. Numbers render the way
// a General-format cell does; date-formatted numbers are not interpreted.
// ponytail: no XF/FORMAT parsing, add if an export ever stores real date serials.

import (
	"encoding/binary"
	"errors"
	"math"
	"strconv"
	"unicode/utf16"
)

func le16(b []byte, o int) int { return int(binary.LittleEndian.Uint16(b[o:])) }
func le32(b []byte, o int) int { return int(binary.LittleEndian.Uint32(b[o:])) }

// cfbStream returns the named stream of a compound file.
func cfbStream(b []byte, names ...string) ([]byte, error) {
	bad := errors.New("not a compound file")
	if len(b) < 512 || le32(b, 0) != 0xE011CFD0 {
		return nil, bad
	}
	ss, mss := 1<<le16(b, 0x1E), 1<<le16(b, 0x20)
	sector := func(n int) []byte {
		o := (n + 1) * ss
		if n < 0 || o+ss > len(b) {
			return nil
		}
		return b[o : o+ss]
	}
	var fat []int
	addFat := func(s []byte) {
		for i := 0; i+4 <= len(s); i += 4 {
			fat = append(fat, le32(s, i))
		}
	}
	for i := 0; i < min(109, le32(b, 0x2C)); i++ {
		if s := sector(le32(b, 0x4C+i*4)); s != nil {
			addFat(s)
		}
	}
	for d, n := le32(b, 0x44), 0; d < 0xFFFFFFFA && n < 1<<16; n++ {
		s := sector(d)
		if s == nil {
			break
		}
		for i := 0; i < ss/4-1; i++ {
			if f := sector(le32(s, i*4)); f != nil {
				addFat(f)
			}
		}
		d = le32(s, ss-4)
	}
	chain := func(start int, size int) []byte {
		var out []byte
		for n := 0; start < 0xFFFFFFFA && start < len(fat) && n < len(fat)+1; n++ {
			s := sector(start)
			if s == nil {
				break
			}
			out = append(out, s...)
			start = fat[start]
		}
		if size >= 0 && size < len(out) {
			out = out[:size]
		}
		return out
	}
	dir := chain(le32(b, 0x30), -1)
	type entry struct {
		name             string
		typ, start, size int
	}
	var entries []entry
	for o := 0; o+128 <= len(dir); o += 128 {
		nl := le16(dir, o+64)
		if nl < 2 || nl > 64 {
			entries = append(entries, entry{})
			continue
		}
		u := make([]uint16, nl/2-1)
		for i := range u {
			u[i] = uint16(le16(dir, o+i*2))
		}
		entries = append(entries, entry{string(utf16.Decode(u)), int(dir[o+66]), le32(dir, o+116), le32(dir, o+120)})
	}
	if len(entries) == 0 || entries[0].typ != 5 {
		return nil, bad
	}
	var mini []int
	mf := chain(le32(b, 0x3C), -1)
	for i := 0; i+4 <= len(mf); i += 4 {
		mini = append(mini, le32(mf, i))
	}
	root := chain(entries[0].start, entries[0].size)
	for _, e := range entries {
		for _, want := range names {
			if e.typ != 2 || e.name != want {
				continue
			}
			if e.size >= le32(b, 0x38) {
				return chain(e.start, e.size), nil
			}
			var out []byte
			for s, n := e.start, 0; s < 0xFFFFFFFA && s < len(mini) && n <= len(mini); n++ {
				o := s * mss
				if o+mss > len(root) {
					break
				}
				out = append(out, root[o:o+mss]...)
				s = mini[s]
			}
			return out[:min(e.size, len(out))], nil
		}
	}
	return nil, errors.New("no workbook stream")
}

type biff struct {
	id   int
	data []byte
}

func biffRecords(b []byte, from int) []biff {
	var out []biff
	for o := from; o+4 <= len(b); {
		id, n := le16(b, o), le16(b, o+2)
		if o+4+n > len(b) {
			break
		}
		out = append(out, biff{id, b[o+4 : o+4+n]})
		o += 4 + n
	}
	return out
}

// biffReader reads BIFF8 unicode strings; a CONTINUE chunk mid-string starts with a flag byte.
type biffReader struct {
	chunks [][]byte
	ci, pi int
}

func (r *biffReader) take(n int) []byte {
	var out []byte
	for len(out) < n && r.ci < len(r.chunks) {
		if r.pi >= len(r.chunks[r.ci]) {
			r.ci++
			r.pi = 0
			continue
		}
		c := min(n-len(out), len(r.chunks[r.ci])-r.pi)
		out = append(out, r.chunks[r.ci][r.pi:r.pi+c]...)
		r.pi += c
	}
	return out
}

func (r *biffReader) u8() int {
	if v := r.take(1); len(v) == 1 {
		return int(v[0])
	}
	return 0
}

func (r *biffReader) u16() int {
	if v := r.take(2); len(v) == 2 {
		return le16(v, 0)
	}
	return 0
}

func (r *biffReader) u32() int {
	if v := r.take(4); len(v) == 4 {
		return le32(v, 0)
	}
	return 0
}

func (r *biffReader) str(chars int, wide bool, rich, ext int) string {
	var runes []uint16
	for len(runes) < chars {
		if r.ci < len(r.chunks) && r.pi >= len(r.chunks[r.ci]) { // a CONTINUE restarts with its own flag byte
			r.ci++
			r.pi = 0
			wide = r.u8()&1 == 1
		}
		if r.ci >= len(r.chunks) {
			break
		}
		if wide {
			v := r.take(2)
			if len(v) < 2 {
				break
			}
			runes = append(runes, uint16(le16(v, 0)))
		} else {
			runes = append(runes, uint16(r.u8()))
		}
	}
	r.take(rich*4 + ext)
	return string(utf16.Decode(runes))
}

func (r *biffReader) ustr() string {
	chars, flags := r.u16(), r.u8()
	rich, ext := 0, 0
	if flags&8 != 0 {
		rich = r.u16()
	}
	if flags&4 != 0 {
		ext = r.u32()
	}
	return r.str(chars, flags&1 == 1, rich, ext)
}

func rkValue(rk int) float64 {
	var v float64
	if rk&2 != 0 {
		v = float64(int32(uint32(rk)) >> 2)
	} else {
		v = math.Float64frombits(uint64(uint32(rk)&0xFFFFFFFC) << 32)
	}
	if rk&1 != 0 {
		v /= 100
	}
	return v
}

func numText(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// readXLS returns each sheet's name and grid of text, up to maxRows rows (0 = all).
func readXLS(b []byte, maxRows int) (names []string, grids [][][]string, err error) {
	book, err := cfbStream(b, "Workbook", "Book")
	if err != nil {
		return nil, nil, err
	}
	recs := biffRecords(book, 0)
	var sst []string
	var offsets []int
	for i := 0; i < len(recs); i++ {
		switch r := recs[i]; r.id {
		case 0x0085:
			if len(r.data) < 8 {
				continue
			}
			wide := r.data[7]&1 == 1
			n := int(r.data[6])
			var name string
			if wide && len(r.data) >= 8+n*2 {
				u := make([]uint16, n)
				for k := range u {
					u[k] = uint16(le16(r.data, 8+k*2))
				}
				name = string(utf16.Decode(u))
			} else if len(r.data) >= 8+n {
				name = string(r.data[8 : 8+n])
			}
			names, offsets = append(names, name), append(offsets, le32(r.data, 0))
		case 0x00FC:
			chunks := [][]byte{r.data[8:]}
			for i+1 < len(recs) && recs[i+1].id == 0x003C {
				i++
				chunks = append(chunks, recs[i].data)
			}
			rd := &biffReader{chunks: chunks}
			for k := 0; k < le32(r.data, 4); k++ {
				if rd.ci >= len(rd.chunks) {
					break
				}
				sst = append(sst, rd.ustr())
			}
		}
	}
	for _, off := range offsets {
		var cells = map[[2]int]string{}
		maxR, maxC := -1, -1
		put := func(row, col int, v string) {
			cells[[2]int{row, col}] = v
			maxR, maxC = max(maxR, row), max(maxC, col)
		}
		sheet := biffRecords(book, off)
		for i := 1; i < len(sheet) && sheet[i].id != 0x000A; i++ {
			d := sheet[i].data
			switch sheet[i].id {
			case 0x00FD:
				if len(d) >= 10 {
					if k := le32(d, 6); k < len(sst) {
						put(le16(d, 0), le16(d, 2), sst[k])
					}
				}
			case 0x0204:
				if len(d) >= 8 {
					rd := &biffReader{chunks: [][]byte{d[6:]}}
					put(le16(d, 0), le16(d, 2), rd.ustr())
				}
			case 0x0203:
				if len(d) >= 14 {
					put(le16(d, 0), le16(d, 2), numText(math.Float64frombits(binary.LittleEndian.Uint64(d[6:]))))
				}
			case 0x027E:
				if len(d) >= 10 {
					put(le16(d, 0), le16(d, 2), numText(rkValue(le32(d, 6))))
				}
			case 0x00BD:
				if len(d) >= 6 {
					row, first := le16(d, 0), le16(d, 2)
					for k := 0; 4+k*6+6 <= len(d)-2; k++ {
						put(row, first+k, numText(rkValue(le32(d, 4+k*6+2))))
					}
				}
			case 0x0006:
				if len(d) >= 14 {
					if le16(d, 12) == 0xFFFF && d[6] == 0 && i+1 < len(sheet) && sheet[i+1].id == 0x0207 {
						i++
						rd := &biffReader{chunks: [][]byte{sheet[i].data}}
						put(le16(d, 0), le16(d, 2), rd.ustr())
					} else if le16(d, 12) != 0xFFFF {
						put(le16(d, 0), le16(d, 2), numText(math.Float64frombits(binary.LittleEndian.Uint64(d[6:]))))
					}
				}
			}
		}
		rows := maxR + 1
		if maxRows > 0 {
			rows = min(rows, maxRows)
		}
		grid := make([][]string, rows)
		for r := range grid {
			grid[r] = make([]string, maxC+1)
		}
		for k, v := range cells {
			if k[0] < rows {
				grid[k[0]][k[1]] = v
			}
		}
		grids = append(grids, grid)
	}
	return names, grids, nil
}
