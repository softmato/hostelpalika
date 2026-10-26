# SEO progress

The detailed tracker is `docs/SEO.md` (items 1–10). This is the one-screen view.

## Done (in code, branch `claude/nifty-carson-9ntj7l`)

- ☑ Gold / Platinum ranking actually implemented (the plan page already promised it), badge on cards and hostel pages, paid placement disclosed
- ☑ "Full" no longer shown for hostels with no bed data; "Ask for rent" instead of "NPR 0"
- ☑ `/hostels/near` + `/hostels/near/[place]` from each hostel's own nearby-places data
- ☑ "Best … / & Nearby" titles on city, type and area pages; intro, order note, type/area links and nearby hostels rendered
- ☑ `/hostels`, `/hostels/in`, home and software page titles; Organization description
- ☑ Software page: roles section, PIN/fingerprint section, "best software for Nepal" section, four FAQs, role links
- ☑ Role pages `/for/owners|wardens|cooks|residents|parents` with FAQPage
- ☑ Home FAQ with FAQPage, computed from live listings
- ☑ `/llms.txt`, `/llms-full.txt`
- ☑ Sitemap: near pages, role pages. Footer: "The app" (roles) and "Hostels near colleges"
- ☑ Audit, data-quality, content roadmap, implementation report

## Needs a person (outside the code)

- ☐ Deploy, then check Website Config → SEO: clear or update saved titles for `home`, `hostels`, `software` and the saved software page so the new copy shows
- ☐ Resubmit `sitemap.xml` in Search Console; request indexing for `/`, `/hostels`, `/hostels/in/kathmandu`, `/hostel-management-software`, `/for/owners`
- ☐ Leave the "Excluded by noindex" validation to fail: those are sample listings and inquiry URLs, `noindex` on purpose
- ☐ `www` → apex redirect to 308 in Vercel
- ☐ Google Business Profile, social links (`sameAs`), software directories, softmato.com product page renamed from HostelHub and linking here (SEO.md "Outside the code")
- ☐ Decide the AI-crawler policy (robots.txt allows all today)

## Blocked / open

- ◐ Area spelling variants (Koteshwor / Koteshwar) — needs a reviewed data rename (production data; approval required)
- ◐ `NEPAL_COLLEGES` label and pin corrections — needs a map check
- ◐ Guides in `seo-content-roadmap.md` — need an author with first-hand knowledge
