package guide

import "github.com/softmato/hostelpalika/server/internal/platform/ordered"

// readerByRole is READER_BY_ROLE in packages/shared/src/guide/guide.ts.
var readerByRole = map[string]string{
	"COOK":               "cook",
	"GUARDIAN":           "guardian",
	"HOSTEL_ADMIN":       "owner",
	"PLATFORM_AGENT":     "all",
	"PLATFORM_MODERATOR": "all",
	"RESIDENT":           "resident",
	"SUPERADMIN":         "all",
	"WARDEN":             "warden",
}

// ReaderForRole is guideReaderForRole: anyone else reads as a visitor.
func ReaderForRole(role string) string {
	if r, ok := readerByRole[role]; ok {
		return r
	}
	return "visitor"
}

// CanRead is canReadChapter: the chapter's own audience, else its group's.
func CanRead(reader string, group, chapter ordered.Map) bool {
	if reader == "all" || reader == "owner" {
		return true
	}
	audience := list(chapter, "audience")
	if audience == nil {
		audience = list(group, "audience")
	}
	for _, r := range audience {
		if r == reader {
			return true
		}
	}
	return false
}

// ForReader is guideForReader. It never changes `content` (the cached copy):
// every map it alters is cloned first.
func ForReader(content ordered.Map, reader string) ordered.Map {
	groups := []any{}
	ids := map[string]bool{}
	slugs := map[string]bool{}
	for _, g := range maps(content, "groups") {
		chapters := []any{}
		for _, c := range maps(g, "chapters") {
			if CanRead(reader, g, c) {
				chapters = append(chapters, c)
				ids[str(c, "id")] = true
			}
		}
		if len(chapters) > 0 {
			groups = append(groups, clone(g).Set("chapters", chapters))
			slugs[str(g, "slug")] = true
		}
	}
	table, trouble := ids["who-can-do-what"], ids["troubleshooting"]
	ne := mapAt(content, "ne")

	access, troubleRows := []any{}, []any{}
	neAccess := any(ordered.Map{{Key: "areas", Value: ordered.Map{}}, {Key: "cells", Value: ordered.Map{}}, {Key: "roles", Value: ordered.Map{}}})
	neTrouble := []any{}
	if table {
		access = arr(content, "access")
		neAccess = mapAt(ne, "access")
	}
	if trouble {
		troubleRows = arr(content, "trouble")
		neTrouble = arr(ne, "trouble")
	}
	return ordered.Map{
		{Key: "access", Value: access},
		{Key: "groups", Value: groups},
		{Key: "ne", Value: ordered.Map{
			{Key: "access", Value: neAccess},
			{Key: "chapters", Value: keep(mapAt(ne, "chapters"), ids)},
			{Key: "groups", Value: keep(mapAt(ne, "groups"), slugs)},
			{Key: "trouble", Value: neTrouble},
		}},
		{Key: "trouble", Value: troubleRows},
	}
}

// Locked is lockedGroups: a part with chapters, none of which the reader may open.
func Locked(content ordered.Map, reader string) []any {
	out := []any{}
	neGroups := mapAt(mapAt(content, "ne"), "groups")
	for _, g := range maps(content, "groups") {
		chapters := maps(g, "chapters")
		if len(chapters) == 0 {
			continue
		}
		open := false
		for _, c := range chapters {
			open = open || CanRead(reader, g, c)
		}
		if open {
			continue
		}
		slug := str(g, "slug")
		var labelNe any
		if l, ok := mapAt(neGroups, slug).Get("label"); ok {
			labelNe = l
		}
		audience, _ := g.Get("audience")
		out = append(out, ordered.Map{
			{Key: "audience", Value: audience},
			{Key: "first", Value: "/guide/" + slug + "/" + str(chapters[0], "id")},
			{Key: "label", Value: str(g, "label")},
			{Key: "labelNe", Value: labelNe},
			{Key: "slug", Value: slug},
		})
	}
	return out
}

// WithPictureURLs is withPictureUrls: each flow/shot becomes {...p, name, src: url(src)}.
func WithPictureURLs(guide ordered.Map, url func(src string) string) ordered.Map {
	groups := []any{}
	for _, g := range maps(guide, "groups") {
		chapters := []any{}
		for _, c := range maps(g, "chapters") {
			c = clone(c)
			for _, k := range []string{"flow", "shot"} {
				if p := mapAt(c, k); p != nil {
					src := str(p, "src")
					c = c.Set(k, clone(p).Set("name", PictureName(src)).Set("src", url(src)))
				}
			}
			chapters = append(chapters, c)
		}
		groups = append(groups, clone(g).Set("chapters", chapters))
	}
	return clone(guide).Set("groups", groups)
}

func clone(m ordered.Map) ordered.Map { return append(ordered.Map(nil), m...) }

func mapAt(m ordered.Map, key string) ordered.Map {
	v, _ := m.Get(key)
	out, _ := v.(ordered.Map)
	return out
}

func arr(m ordered.Map, key string) []any {
	v, _ := m.Get(key)
	if out, ok := v.([]any); ok {
		return out
	}
	return []any{}
}

func maps(m ordered.Map, key string) []ordered.Map {
	var out []ordered.Map
	for _, v := range arr(m, key) {
		if om, ok := v.(ordered.Map); ok {
			out = append(out, om)
		}
	}
	return out
}

func list(m ordered.Map, key string) []string {
	v, ok := m.Get(key)
	if !ok {
		return nil
	}
	items, _ := v.([]any)
	out := []string{}
	for _, it := range items {
		if s, ok := it.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func str(m ordered.Map, key string) string {
	v, _ := m.Get(key)
	s, _ := v.(string)
	return s
}

// keep is Object.fromEntries(entries.filter(([k]) => want.has(k))), order kept.
func keep(m ordered.Map, want map[string]bool) ordered.Map {
	out := ordered.Map{}
	for _, p := range m {
		if want[p.Key] {
			out = append(out, p)
		}
	}
	return out
}
