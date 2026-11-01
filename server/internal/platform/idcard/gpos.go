package idcard

import (
	"encoding/binary"

	"golang.org/x/image/font/sfnt"
)

// kerning is Inter's GPOS `kern` feature: pair adjustments only. x/image reads
// just the legacy `kern` table, which Inter does not have, and without these a
// line measures wider than Skia's and wraps at a different word.
type kerning struct {
	data    []byte
	lookups [][]int // subtable offsets per lookup
}

func u16(b []byte, off int) int {
	if off < 0 || off+2 > len(b) {
		return 0
	}
	return int(binary.BigEndian.Uint16(b[off:]))
}

func u32(b []byte, off int) int {
	if off < 0 || off+4 > len(b) {
		return 0
	}
	return int(binary.BigEndian.Uint32(b[off:]))
}

// parseKerning finds GPOS and collects the PairPos subtables of its `kern` lookups.
func parseKerning(file []byte) *kerning {
	gpos := 0
	for i := range u16(file, 4) {
		rec := 12 + i*16
		if rec+16 <= len(file) && string(file[rec:rec+4]) == "GPOS" {
			gpos = u32(file, rec+8)
		}
	}
	if gpos == 0 {
		return &kerning{}
	}
	k := &kerning{data: file}
	features := gpos + u16(file, gpos+6)
	lookupList := gpos + u16(file, gpos+8)
	seen := map[int]bool{}
	for i := range u16(file, features) {
		rec := features + 2 + i*6
		if string(file[rec:rec+4]) != "kern" {
			continue
		}
		feature := features + u16(file, rec+4)
		for j := range u16(file, feature+2) {
			idx := u16(file, feature+4+j*2)
			if seen[idx] {
				continue
			}
			seen[idx] = true
			lookup := lookupList + u16(file, lookupList+2+idx*2)
			kind := u16(file, lookup)
			var subs []int
			for s := range u16(file, lookup+4) {
				sub := lookup + u16(file, lookup+6+s*2)
				if kind == 9 { // Extension: the real type and a 32-bit offset
					if u16(file, sub+2) != 2 {
						continue
					}
					subs = append(subs, sub+u32(file, sub+4))
				} else if kind == 2 {
					subs = append(subs, sub)
				}
			}
			if len(subs) > 0 {
				k.lookups = append(k.lookups, subs)
			}
		}
	}
	return k
}

func (k *kerning) coverage(off, glyph int) int {
	b := k.data
	switch u16(b, off) {
	case 1:
		for i := range u16(b, off+2) {
			if u16(b, off+4+i*2) == glyph {
				return i
			}
		}
	case 2:
		for i := range u16(b, off+2) {
			rec := off + 4 + i*6
			if glyph >= u16(b, rec) && glyph <= u16(b, rec+2) {
				return u16(b, rec+4) + glyph - u16(b, rec)
			}
		}
	}
	return -1
}

func (k *kerning) class(off, glyph int) int {
	b := k.data
	switch u16(b, off) {
	case 1:
		first := u16(b, off+2)
		if glyph >= first && glyph < first+u16(b, off+4) {
			return u16(b, off+6+(glyph-first)*2)
		}
	case 2:
		for i := range u16(b, off+2) {
			rec := off + 4 + i*6
			if glyph >= u16(b, rec) && glyph <= u16(b, rec+2) {
				return u16(b, rec+4)
			}
		}
	}
	return 0
}

// popcount16 is how many int16 fields a ValueRecord of this format carries.
func popcount16(v int) (n int) {
	for ; v != 0; v &= v - 1 {
		n++
	}
	return n
}

// xAdvance reads XAdvance from a ValueRecord at off (bit 2 of the format).
func (k *kerning) xAdvance(off, format int) int {
	if format&4 == 0 {
		return 0
	}
	skip := popcount16(format & 3)
	return int(int16(u16(k.data, off+skip*2)))
}

// pair is the summed first-glyph XAdvance adjustment, in font units.
func (k *kerning) pair(left, right sfnt.GlyphIndex) int {
	total := 0
	g1, g2 := int(left), int(right)
	b := k.data
	for _, subs := range k.lookups {
		for _, sub := range subs {
			cov := k.coverage(sub+u16(b, sub+2), g1)
			if cov < 0 {
				continue
			}
			f1, f2 := u16(b, sub+4), u16(b, sub+6)
			size1, size2 := popcount16(f1)*2, popcount16(f2)*2
			if u16(b, sub) == 1 {
				set := sub + u16(b, sub+10+cov*2)
				matched := false
				for i := range u16(b, set) {
					rec := set + 2 + i*(2+size1+size2)
					if u16(b, rec) == g2 {
						total += k.xAdvance(rec+2, f1)
						matched = true
						break
					}
				}
				if matched {
					break
				}
				continue
			}
			if u16(b, sub) == 2 {
				c1 := k.class(sub+u16(b, sub+8), g1)
				c2 := k.class(sub+u16(b, sub+10), g2)
				count2 := u16(b, sub+14)
				rec := sub + 16 + (c1*count2+c2)*(size1+size2)
				total += k.xAdvance(rec, f1)
				break
			}
		}
	}
	return total
}
