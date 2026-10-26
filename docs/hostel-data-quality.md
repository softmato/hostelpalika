# Hostel data quality — sources of truth

Every fact a public page, its metadata, its JSON-LD, the sitemap or `/llms-full.txt` states about a
hostel comes from one place and is computed one way. This file says where, and what happens when
the value is missing. Written 2026-10-26 from the code; no production records were read or changed.

## Visibility

A hostel is public only when `isDeleted: false`, `status: "PUBLISHED"`,
`verificationStatus: "VERIFIED"` (`listPublicHostels`, `getPublicHostelBySlug`,
`listPublicHostelLocations`, `listPublishedHostelSlugs`, `listPublicNearbyPlaces`). Sample
listings from `demo-hostels.json` (`isDemoData`) are shown in the listing after real ones, never
counted on location pages, never in JSON-LD, never in `llms-full.txt`, and their pages are
`noindex`.

## Field by field

| Fact | Source of truth | Rule | When missing |
|---|---|---|---|
| Name, slug | `Hostel.name`, `Hostel.slug` | Slug is the canonical URL | — |
| Main hostel vs branch | `Hostel.parentHostelId` | A branch has its own page; it bills to its main hostel | — |
| City, area | `Hostel.location.city/area` (owner-typed) | Matched to URLs by `locationSlug`, never by URL spelling | Area omitted from place names |
| Type | `Hostel.hostelType` (`BOYS`/`GIRLS`/`CO_LIVING`) | `hostelTypeLabel` | Treated as co-living |
| Map pin | `location.lat/lng`, `locationSource` | MANUAL pins are never re-geocoded | No pin → no distance, not on near pages |
| Nearby places | `Hostel.nearbyPlaces` (Google Places or OpenStreetMap, ≤ 1.5 km from the pin) | Near pages use these only; campus-name filter; shortest distance per hostel | Hostel absent from near pages |
| Rent | `pricing.monthlyRentMin/Max`; per room in `roomConfigurations[].monthlyRent` | "From" = `monthlyRentMin`; ranges are min of mins to max of maxes | Card says "Ask for rent"; rent questions dropped from FAQs |
| Room sharing | `roomConfigurations[].bedsPerRoom` | 1 = single room | Single-room FAQ says none listed |
| Vacant beds | `capacitySummary.vacantBeds` (or `comparison.vacancy`) | Shown only when recorded | Card shows nothing (was "Full"); detail says "Ask" |
| Rating | `ratingSummariesFor` (reviews by residents who stayed) | Shown and marked up only when `total > 0` | "New", no `aggregateRating` |
| Verification | `verificationStatus === "VERIFIED"` after document review | Pages say "verified" because nothing else is public | — |
| Badge (Gold/Platinum) | Plan catalogue `listingTier` × `HostelSubscription` (ACTIVE or PAST_DUE, `currentPeriodEnd` in the future) | Derived on every read; branch inherits main hostel | No badge |
| Photos | `Hostel.photos` → public media URL | Only PUBLIC + ACTIVE assets reach crawlers | Default image on cards, brand card for social |

## Definitions

- **Total beds** — `capacitySummary.totalBeds`, the beds the hostel has set up.
- **Vacant beds** — `capacitySummary.vacantBeds`, beds with nobody allocated, as the hostel's own
  room map last recorded. Not a promise of availability: the page says to contact the hostel.
- **Occupied** — total minus vacant. Never published on its own.
- **Badge** — a paid placement, not a quality rating; every page that orders by it says so.

## Invariants guarded by tests

- `listing-tier.test.ts` — the shipped catalogue gives Max → Gold and Pro → Platinum; higher plan
  ranks first; ties keep the existing order; a plan that loses its badge stops ranking.
- `near-places.test.ts` — schools are not campuses; spellings merge; one hostel counts once at its
  shortest distance; distances outside 0–1500 m and missing distances are dropped.
- `home-faq.test.ts` — Kathmandu rent never includes sample listings; questions without data are
  left out; badges and plans are named from the catalogue.
- `llms-txt.test.ts` — cities without hostels are not linked; a hostel without rent or reviews is
  not given either.
- `role-pages.test.ts` — no "balance sheet" claim; every footer link has a page.

## Open issues

1. Area spelling variants (Koteshwor / Koteshwar) produce two area pages. Fix at the source: an
   area picker from Website Config → Locations in the registration form, plus a one-time,
   reviewed rename of existing records (needs approval — it changes production data).
2. `NEPAL_COLLEGES` has a wrong label (Purwanchal Campus is in Dharan) and an off pin (Kathmandu
   Model College). Used only by the listing's "Near my college" filter; correct the entries from a
   map.
3. `capacitySummary` is owner-maintained. A "last confirmed" date next to vacant beds would let
   pages say how fresh the number is; there is no such field today.
4. Geocoded pins (not MANUAL) can be off by a block; near pages say distances are straight-line from
   the pin and ask readers to check the route.
