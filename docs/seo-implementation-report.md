# SEO implementation report — 2026-10-26

Companion files: `seo-audit.md` (findings), `hostel-data-quality.md` (sources of truth),
`seo-content-roadmap.md` (what to write), `seo-progress.md` (checklist), `SEO.md` item 10 (tracker).

## What was verified, and how

| Claim | How it was verified |
|---|---|
| Search demand and index state | Search Console screen recording, 2026-10-26 (figures in `seo-audit.md`) |
| Badge ranking promised but not implemented | `plans.defaults.ts` note vs `listPublicHostels` sort |
| "Full" shown for unknown vacancy | `mapPublicHostelToSummary` defaulted vacancy to 0; `HostelCard` printed "Full" for 0 |
| Intro and type/area links never rendered | `LocationPage` fields vs `PublicLocationPage` markup |
| Every role claim | Portal routes under `app/(resident)`, `app/(guardian)`, `app/(cook)`; `WARDEN_PERMISSION_KEYS` and defaults; `lock-pin.service.ts`; `guardian-invite.service.ts`; `renderStatementPdf` |
| Rendered HTML | Local dev server (no database): `/`, `/for/wardens`, `/for/residents`, `/hostel-management-software` return 200 with the new title, canonical, H1, FAQ text and FAQPage JSON-LD; `/for/residents` has no horizontal scroll at 390 px |

Not verified: anything on the live site, database-backed pages with real data (`/hostels/in/*`,
`/hostels/near/*`, `/llms*.txt` answer 5xx locally because there is no database — the intended
behaviour), Rich Results Test, Core Web Vitals.

## Changes

### P0 — promises and contradictions
- **Gold / Platinum ranking.** `lib/listing-tier.ts` (badge per plan from the catalogue, rank by
  plan position). `hostel.service.ts`: `publicListingTiers()` reads subscriptions that are ACTIVE
  or PAST_DUE with an unexpired period; branches inherit the main hostel's plan; badged hostels are
  read separately so the 60-row cap cannot drop them; failure degrades to no badges.
  `listPublicHostels` and `getPublicHostelBySlug` return `listingTier`. Client sorts keep the
  visitor's choice and use the badge only as a tie-break. Badge pill
  (`listing-tier-badge.tsx`) on grid/list cards and the hostel page; disclosure note on `/hostels`,
  location and near pages.
- **Unknown vacancy / rent.** `vacancyKnown` on `HostelSummary`; cards omit the bed fact and the
  hostel page says "Ask" when beds were never recorded; cards say "Ask for rent" instead of NPR 0.

### P1 — pages that answer the searches
- `/hostels/near`, `/hostels/near/[place]` — `lib/near-places.ts`, `lib/near-pages.ts`,
  `listPublicNearbyPlaces`, `listPublicHostelsNear`.
- Location pages (`lib/location-pages.ts`, `public-location-page.tsx`): "Best …" titles when the page
  has hostels, "& Nearby" area titles backed by a nearby-hostels section (≤ 2 km), intro and order
  note rendered, type/area/college links rendered, FAQs for cheapest hostel, single rooms and
  "which is the best hostel".
- Role pages `/for/[role]` — `lib/role-pages.ts`, `lib/role-links.ts`, `public-role-page.tsx`.
- Copy (`seo.defaults.ts`): home, `/hostels`, software title/description; software sections and
  FAQs. `/hostels/in` title. Organization `description`.
- Home FAQ (`lib/home-faq.ts`) rendered on the server into the client home page; FAQPage JSON-LD.
- `/llms.txt`, `/llms-full.txt` (`lib/llms-txt.ts`, `lib/llms-data.ts`).
- Sitemap: near pages (only places with hostels) and role pages. Footer: role links and
  "Hostels near colleges". Software page: role links.

## Files

New: `lib/listing-tier.ts`, `lib/near-places.ts`, `lib/near-pages.ts`, `lib/home-faq.ts`,
`lib/llms-txt.ts`, `lib/llms-data.ts`, `lib/role-pages.ts`, `lib/role-links.ts`,
`app/_components/listing-tier-badge.tsx`, `app/_components/public-role-page.tsx`,
`app/(public)/hostels/near/page.tsx`, `app/(public)/hostels/near/[place]/page.tsx`,
`app/(public)/for/[role]/page.tsx`, `app/llms.txt/route.ts`, `app/llms-full.txt/route.ts`, tests
for each `lib` file, and the five docs.

Changed: `hostel.service.ts` (+ its test), `location-pages.ts`, `json-ld.ts`, `seo-config.ts`,
`seo.defaults.ts`, `sitemap.ts`, `public-footer.tsx`, `public-location-page.tsx`,
`public-home-page.tsx`, `(public)/page.tsx`, `hostels/in/page.tsx`, `public-software-pages.tsx`,
`public-hostel-data.ts`, `public-hostel-types.ts`, `public-hostel-listing-page.tsx`,
`public-hostel-detail-page.tsx`, `shared.tsx`, `docs/SEO.md`.

## Tests run (actual results)

Environment note: `@softmato/sdk` is a private GitHub Packages module and `cdn.sheetjs.com` is
blocked here, so dependencies were installed with xlsx from npm and a local, uncommitted stub of
the SDK in `node_modules`. The lockfile and `package.json` were restored unchanged.

- `tsc --noEmit` (apps/web): **clean**.
- `eslint` on every changed/new file: **0 errors**, 1 pre-existing warning (`<img>` on city cards).
- New tests: `listing-tier` 4, `near-places` 12, `home-faq` 3, `llms-txt` 3, `role-pages` 3 — all
  pass. `hostel.service.test.ts` 12/12 including a new badge-ranking test (it needed mocks for the
  subscription model and the settings reader).
- Full `vitest run`: **3414 passed, 11 failed** (7 files). The same 11 fail on the untouched base
  branch in this sandbox: `output-tracing`, `platform-id-card.server`, `email-preference`,
  `existing-residents-file` (xlsx 0.18 instead of 0.20 / environment), `platform-field-index`
  (`platform-bookings-page.tsx`, unrelated), `softmato/webhook` (SDK stub),
  `mobile-registration-contract` (needs the Expo tsconfig).

## Decisions that need approval

1. **"Best" in titles.** Used because it is how people search; every page with it says how its list
   is ordered, and that badges are paid. Remove the word in `location-pages.ts` /
   `seo.defaults.ts` if you would rather not use it.
2. **Paid placement order.** Badged hostels lead the default order and the location/near pages
   (including their ItemList). Explicit sorts stay honest.
3. **AI crawlers.** robots.txt allows all, including training crawlers. Blocking
   `GPTBot`/`Google-Extended`/`CCBot` while keeping search crawlers is a one-line change if wanted.
4. **Area renames** (Koteshwor/Koteshwar) touch production data — not done.

## Verify after deploy

1. Website Config → SEO: saved values override the new defaults (see `seo-progress.md`).
2. View source of `/hostels/in/kathmandu`, an area page, `/hostels/near`, one near page,
   `/for/owners`, `/`: the intro, FAQ and JSON-LD are in the HTML.
3. `/llms.txt` and `/llms-full.txt` answer 200 `text/plain` with real hostels.
4. Rich Results Test and Schema Markup Validator on `/`, a city page, a near page, a role page.
5. `/hostels` "Recommended": a hostel on a paid Max/Pro plan leads, with its badge.
6. Search Console: resubmit the sitemap; watch "Discovered – currently not indexed" and the
   queries listed in `seo-audit.md`. Rankings are not promised; links from outside the site
   (SEO.md "Outside the code") are now the largest lever.
