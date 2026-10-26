# SEO audit — HostelPalika (2026-10-26)

Scope: `apps/web` (the website at hostelpalika.com). Evidence is the code on branch
`claude/nifty-carson-9ntj7l` and a screen recording of Google Search Console taken on
2026-10-26. The live site, Search Console, Bing and OpenStreetMap could **not** be reached from
the audit sandbox (proxy 403), and there was no database, so nothing below claims a live response
code or a live count unless it is quoted from the Search Console recording.

Labels: **Confirmed** = seen in code or in Search Console. **Suspected** = likely, not verified.
**Fixed** = changed in this branch.

## Architecture

| Layer | What it is |
|---|---|
| Framework | Next.js 16 (App Router), React server components; `(public)` route group for the site |
| Data | MongoDB via Mongoose (`packages/db`); hostels, subscriptions, settings |
| Rendering | Public landing pages are server components; `/hostels` listing is a client component fed by `/api/v1/public/hostels` |
| SEO plumbing | `lib/seo.ts` (metadata, signed `/og` cards), `lib/json-ld.ts`, `lib/seo-config.ts` + `seo.defaults.ts` (editable copy in Website Config → SEO), `app/sitemap.ts`, `app/robots.ts` |
| Images | Hostel photos stored as `/api/v1/files/<id>/url`, resolved to `media.softmato.com` for crawlers (`lib/search-image-urls.ts`) |
| Auth boundary | Portals behind `proxy.ts`; every portal layout `noindex, nofollow`; robots.txt closes `/platform/ /hostel-admin/ /resident/ /guardian/ /team/ /pay/ /api/` |
| Deploy | Vercel |

## Route inventory

| Family | Routes | Index? |
|---|---|---|
| Home | `/` | yes |
| Hostel detail | `/hostels/[slug]` | yes; sample (demo) listings `noindex` |
| City / type / area | `/hostels/in`, `/hostels/in/[city]`, `/hostels/in/[city]/[boys\|girls\|co-living\|area]` | yes when the page has hostels, else `noindex` |
| Near a college (new) | `/hostels/near`, `/hostels/near/[place]` | yes; a place with no hostel is a 404 |
| Search / map / compare | `/hostels`, `/map`, `/compare` | yes (canonical without query) |
| Owner product | `/hostel-management-software`, `/features`, `/features/[module]`, `/vs/[slug]`, `/plans-pricing`, `/plans-pricing/[service]`, `/plans-pricing/badge/[tier]`, `/register-hostel` | yes |
| Role pages (new) | `/for/owners`, `/for/wardens`, `/for/cooks`, `/for/residents`, `/for/parents` | yes |
| Community | `/community`, `/community/[postId]` | yes; short posts `noindex` |
| Service providers | `/service-providers` | yes |
| Info / policy | `/about`, `/contact`, `/privacy`, `/terms`, `/refund-policy`, `/how-booking-works`, `/resident-offer-program` | yes |
| Machine-readable | `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/llms-full.txt` (new, `X-Robots-Tag: noindex`) | n/a |
| Private / one-person | portals, `/login`-adjacent flows, `/inquiry`, `/join/*`, `/resident-id/*`, checkouts, `/pay/*` | `noindex` or blocked |

## Search Console baseline (from the recording, last 3 months)

- 73 clicks, 402 impressions, CTR 18.2 %, average position 18.5. Nepal 299 impressions, India 48.
  Mobile 229 / desktop 171.
- Top pages by clicks: `/` 49, `/hostels/in` 7, `/hostels/in/kathmandu` 6 (171 impressions — the
  page Google shows most), `/hostel-management-software` 5.
- Queries with impressions and no clicks: hostel in kathmandu 15, hostel maintenance 14,
  softmato 13, leeway residence 13, nepal hostel 9, hostels in kathmandu 8, hostel in nepal 7,
  hostelsinnepal.com 6, cheap hostel in kathmandu 6, hotel management software vs excel 5,
  hostels kathmandu 4, kathmandu hostels 3, coliving pg near me 2, hostel in putalisadak 2,
  hostel price in kathmandu 1, single room hostel in kathmandu 1, hostel register book 1.
- Page indexing (updated 2026-10-23): 54 indexed, 71 not indexed — `noindex` 27, page with
  redirect 3, discovered-not-indexed 38, crawled-not-indexed 3. Sitemap read 2026-10-25,
  96 discovered pages, status Success.

## Findings

| # | Severity | Status | Finding | Evidence |
|---|---|---|---|---|
| 1 | P0 | Confirmed, **Fixed** | The plan catalogue tells owners Gold/Platinum listings are "ranked above unbadged listings across search, the map and Compare"; `listPublicHostels` sorted by price only. A paid promise that was not kept. | `plans.defaults.ts`, `hostel.service.ts` |
| 2 | P0 | Confirmed, **Fixed** | A hostel with no recorded beds showed **"Full"** on its card (vacancy defaulted to 0). | `public-hostel-data.ts`, `shared.tsx` |
| 3 | P1 | Confirmed, **Fixed** | City/type/area pages computed an intro paragraph and type/area links but never rendered them — the pages carried a heading, cards and FAQ only. | `public-location-page.tsx` |
| 4 | P1 | Confirmed, expected | 27 "Excluded by noindex" are sample (demo) hostel pages and `/inquiry?hostel=` URLs. That is intended — **the "Validate fix" started on 2026-10-26 will fail for them, correctly.** | Search Console, `hostels/[slug]/page.tsx` |
| 5 | P1 | Confirmed | 38 "Discovered – currently not indexed" includes `/hostels`, `/features`, feature pages, hostel pages and `/hostels/in/kathmandu/boys`. Google knows them and has not spent crawl on them — a site-authority and internal-link signal, not a tag error. Mitigated by the new internal links (type/area chips, near links, role links, footer); the rest is external links. | Search Console |
| 6 | P1 | Confirmed, **Fixed** | Titles did not answer the most common query shapes ("best hostels in …", "hostels near …", "hostel management software Nepal best", role searches). | `seo.defaults.ts`, `location-pages.ts` |
| 7 | P2 | Confirmed | Area spellings split pages: config "Koteshwor" vs a hostel's "Koteshwar". | SEO.md item 6 |
| 8 | P2 | Confirmed | `NEPAL_COLLEGES` (listing filter) labels "Purwanchal Campus / Bhaktapur MC" — Purwanchal Campus is in Dharan — and places Kathmandu Model College (Bagbazar) about 3 km east. Not used by any indexed page; flagged for correction. | `lib/maps/nepal-colleges.ts` |
| 9 | P2 | Confirmed, **Fixed** | A hostel with no rent showed "NPR 0 / month" on its card; now "Ask for rent". | `shared.tsx` `formatMoney(hostel.price)` |
| 10 | P2 | Confirmed | Stored Website Config → SEO values override shipped titles; new defaults only appear where those fields are blank. | `lib/seo-config.ts` |
| 11 | P3 | Confirmed | robots.txt allows every user agent, including AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended). A business decision, recorded rather than changed. | `app/robots.ts` |
| 12 | P3 | Confirmed | `www` → apex redirect was 307 on 2026-09-15; should be 308 (Vercel setting). The 3 "page with redirect" rows are consistent with it and with `/hostel-management-system`. | SEO.md |
| 13 | P3 | Confirmed | No `sameAs`, no external links (directories, Google Business Profile, softmato.com still says "HostelHub"). The largest remaining ranking lever and entirely outside the code. | SEO.md "Outside the code" |

## Structured data

Organization (+ new `description`), WebSite (sitelinks search), SoftwareApplication, Hostel (rating
only with real reviews; no markup on sample listings), BreadcrumbList, ItemList, FAQPage. New:
FAQPage on home and role pages, ItemList/FAQPage on near pages. Review markup is not added for
the hostel directory as a whole: third-party review aggregation is not eligible for Google's
review rich results, and nothing on these pages is self-review markup.

## Limits of this audit

No live HTTP checks, no Rich Results Test, no Core Web Vitals field data, no database counts. Run
the checks in `seo-implementation-report.md` → "Verify after deploy".
