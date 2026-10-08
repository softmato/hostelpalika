# SEO — HostelPalika

The tracker and the keyword map for search. Work one item at a time: code it, verify it
(`web:typecheck`, `web:lint`, `web:test`), then flip `☐` to `☑`. `◐` = partial, with a note.

## Who searches, and which page answers

HostelPalika is two-sided, so it ranks for two very different audiences.

| Intent | Typical searches (Nepal) | Page that answers |
|---|---|---|
| Owner, ready to buy (BOFU) | hostel management software nepal · hostel management system · hostel software | `/hostel-management-software` |
| Owner, one job | hostel billing / fee collection software · hostel mess management · hostel attendance app | `/features/[module]`, `/plans-pricing/[service]` |
| Owner, comparing | hostel management in excel · hostel register book | `/vs/[slug]` |
| Owner, pricing | hostel software price nepal | `/plans-pricing` |
| Student / parent | hostels in kathmandu · girls hostel in lalitpur · boys hostel baneshwor | `/hostels/in/[city]`, `/hostels/in/[city]/[filter]` |
| Student / parent, one hostel | "<hostel name>" · "<hostel name> reviews" | `/hostels/[slug]` |
| Brand | hostelpalika · hostel palika login | `/`, `/about`, `/login` |

Rules every page follows:

- The title names the page and the brand (`<page> · HostelPalika`); the description says what is on
  the page in plain words. Both come from **Platform → Website Config → SEO** where the page is
  static, and from the data where it is not (hostels, cities, services).
- Structured data only states what the page shows. No invented ratings, counts or prices.
- A programmatic page with nothing on it (a city with no hostels yet) renders, but is `noindex` and
  stays out of the sitemap until it has something to show.
- Private and one-person pages (portals, invites, checkouts, IDs) are `noindex`.

## Work items

1. ☑ **Foundation** — `lib/seo.ts` (metadata builder, signed `/og` card URLs, `NOINDEX`),
   `lib/json-ld.ts` (Organization, WebSite, SoftwareApplication, Hostel, BreadcrumbList, FAQPage,
   ItemList; `</script>`-safe serializer), `components/json-ld.tsx`; `lib/seo.test.ts` 8/8.
2. ☑ **SEO config section** — `seo` in site config: per-page titles/descriptions (blank = shipped
   text, `{siteName}`/`{fromPrice}` filled at render), brand spellings (`alternateName`), keywords,
   Google + Bing verification, the software page (sections, how-it-works steps, owner FAQ), feature
   pages and comparisons. Shipped copy in `seo.defaults.ts`; editor at Platform → Website Config →
   SEO (`/platform/config/seo`); resolver `lib/seo-config.ts`. Tests guard that the shipped copy
   passes its own schema and every feature page names a real plan module.
3. ☑ **Site-wide defaults** — root metadata from the `home` SEO entry (title template, keywords,
   `max-image-preview: large`, Twitter card, Google/Bing verification, author/publisher Softmato);
   `manifest.ts` (`display: browser` so Chrome never offers the website as a second app);
   `/og` signed social card in Inter (`og-card.test.ts` renders a 1200×630 PNG, tampered text falls
   back to the brand card); Organization (alternate names, parent Softmato with legal name) +
   WebSite (sitelinks search → `/hostels?search=`) JSON-LD on every public page;
   `/hostel-management-system` → `/hostel-management-software` 308.
4. ☑ **Every existing page** — home, hostels, map, compare, community, plans & pricing, register
   hostel, service providers, offer program, about, contact, privacy, terms, log in and sign up read
   their title/description from the SEO section. Services get "<name> for Hostels" titles with the
   plan price; badges and community posts get their own (posts under 80 characters are `noindex`).
   `noindex`: every portal layout (`PORTAL_ROBOTS`), a new `(auth)` layout (log in / sign up opt
   back in), the registration form, checkout return, `/hostels/register` and `/inquiry`. JSON-LD:
   SoftwareApplication (one `@id`, real plan prices) + BreadcrumbList on pricing, BreadcrumbList on
   services, FAQPage on contact (answers shared with the page via `resolveWebFaq`).
5. ☑ **Hostel pages render on the server** — `hostels/[slug]/page.tsx` reads the hostel once
   (`cache`, shared with metadata) and hands it to `PublicHostelDetailPage` as `initialHostel`, which
   no longer refetches it; a missing hostel is a real 404, other failures a 5xx. Titles read
   "<name> — Boys Hostel in Baneshwor, Kathmandu"; descriptions lead with type, place, rent and
   rating; the cover photo is the social image. JSON-LD: `Hostel` (address, geo, phone, amenities,
   room offers, rating only with reviews) + BreadcrumbList through the city page.
6. ☑ **City landing pages** — `/hostels/in` (every city), `/hostels/in/[city]` and
   `/hostels/in/[city]/[boys|girls|co-living|area]`, server-rendered. Cities = Website Config →
   Locations plus any city a published hostel names (`listPublicHostelLocations`, `buildCityIndex`,
   4 tests); the listing query gained an exact `city` filter. Count, rent range, areas, FAQ and
   links are computed from live listings (`lib/location-pages.ts`); a page with no hostels is
   `noindex`; a DB failure is a 5xx, never an empty 200. JSON-LD: BreadcrumbList, ItemList, FAQPage.
   Live data on 2026-09-15: Education Light Hostel (Ghattekulo) and Study Sanjal (Koteshwar), both
   boys hostels in Kathmandu. Hostel pages also declare "<name> Hostel" as `alternateName` when the
   name lacks the word. Known wrinkle: config "Koteshwor" and a hostel's "Koteshwar" are two areas.
7. ☑ **SaaS pages** — `/hostel-management-software` (headline, intro, the 9 modules, Nepal-specific
   sections, how-it-works steps, live plan prices, comparisons, 18-question owner FAQ, "A product
   of Softmato" credit with its logo), `/features` hub, `/features/[slug]` (one per plan module,
   every service with its plan price, linked to its `/plans-pricing` page), `/vs/[slug]` (honest
   comparison table, when the old way is enough, FAQ). All server-rendered from Website Config →
   SEO + the plans catalogue (`resolveSoftwarePage` / `resolveModulePages` / `resolveComparison`);
   shared blocks in `public-seo-blocks.tsx`. JSON-LD: SoftwareApplication, BreadcrumbList, FAQPage,
   ItemList. Plan payment copy says it is paid on the website (Play payments policy).
8. ☑ **Internal links + sitemap** — `components/public-footer.tsx` is now on every public page via
   `PublicShell` (the full-screen map opts out; the home page's private copy is gone): city pages,
   the software page, features, pricing, comparisons, company links, and "A product of Softmato"
   with its logo. `sitemap.ts` lists static pages without fake `lastModified`, feature pages,
   comparisons, services, badges, location pages that have hostels (`lastModified` = newest hostel)
   and hostels with up to 10 photos each — 73 URLs against live data on 2026-09-15. `robots.ts`
   fixed: the old `Disallow: /resident` prefix also blocked `/resident-offer-program`; portals are
   now closed as `/x/` + `/x$`, and `/team` and `/pay/` were added.

   ☑ Fix, 2026-09-15: after the first deploy, Search Console read the sitemap (72 pages) but flagged
   10 "Invalid URL" images. Hostel photos are stored as relative `/api/v1/files/<id>/url` paths on
   purpose, and `<image:loc>` must be absolute; `/api/` is also closed in robots.txt.
   `lib/search-image-urls.ts` now resolves every photo a crawler reads — sitemap images, the hostel
   page's `og:image` and its `Hostel.image` — to the asset's public media URL (PUBLIC + ACTIVE assets
   only, LARGE rendition when present). Live check: all 13 photos resolve to
   `https://media.softmato.com/...` and serve 200; that host's robots.txt allows Googlebot.
   After deploying, resubmit the sitemap in Search Console.

   ☑ Fix, 2026-09-15 (crawl audit of the live site, before Page indexing had data): all 72 sitemap
   URLs answered 200 with a self-canonical and no stray `noindex`, but three things would have
   shown up in the report.
   - **Soft 404s.** `hostels/loading.tsx` and `hostels/[slug]/loading.tsx` put every hostel and
     city page inside a Suspense boundary, so the 200 was sent before the page found out the slug
     did not exist: removed hostels and unknown cities answered "200 + noindex", and a database
     error would have been a 200 error page. The listing skeleton now lives in
     `hostels/(listing)/` and covers `/hostels` only; `hostels/[slug]/layout.tsx` reads the hostel
     (shared cached loaders in `load-hostel.ts`) before anything streams, so a missing hostel is a
     real 404 and a failed read a 5xx while client-side navigation keeps its skeleton. City pages
     have no loading boundary any more, like `/features` and `/vs`.
   - **Tags in `<body>` for Googlebot.** Next streams metadata to any user agent outside
     `htmlLimitedBots`, and its default list has Google's inspection and ads crawlers but not
     `Googlebot`: the canonical link sat ~140 KB into the body. `next.config.ts` extends the default
     with `Googlebot|GoogleOther`; visitors still get streamed metadata.
   - **`/hostels` was empty to Google.** Its cards (and every hostel photo) load from `/api/`, which
     robots.txt closed, and a renderer obeys robots.txt for each request a page makes. `robots.ts`
     now allows `/api/v1/public/hostels` and `/api/v1/files/`; `/api/v1/public/*` answers
     `X-Robots-Tag: noindex` so the JSON never becomes a result. The home page was already fine: its
     hostels are server-rendered.

9. ☑ **Brand queries — the favicon and the name** — 2026-09-18, from an audit of what Google
   actually returns for `hostelpalika`, `hostelpalika.com` and `softmato`.

   - **A globe instead of the logo.** `app/favicon.ico` held four sizes and Next declares the
     largest, so every page said `sizes="64x64"`. Google's favicon rule is a square that is a
     multiple of 48px; 64 is not one, so it ignored the icon and drew the generic globe.
     softmato.com ships 16/32/**48** and its logo shows — that was the only difference between the
     two heads. The 64 entry is stripped, the file is 16/32/48, and the tag now says
     `sizes="48x48"`. The URL is unchanged, so Google picks it up on its next crawl of the home page
     rather than starting a new icon history.
   - **"Palika" is an everyday Nepali word.** `hostelpalika` is answered with "results for hostel
     palika" and nothing of ours; only `hostelpalika.com` finds the site. The spellings were
     declared as `alternateName` on the Organization and WebSite records — markup a query cannot
     match — and the word "palika" appeared in visible text nowhere on the site, on any page. The
     `/about` page now carries a short **The name** section that writes the spellings out in prose,
     built from the same `seo.alternateNames` list so there is still one place to edit them.

## Waiting on the Play listing

Held back until `com.softmato.hostelpalika` is live on Google Play, so nothing links to a store page
that does not exist yet. First confirm the listing URL loads publicly, then:

Listing confirmed live 2026-10-08.

1. ☑ `lib/json-ld.ts` → `softwareApplicationJsonLd`: `operatingSystem` becomes `"Web, Android"`, and
   the Play URL is added as `installUrl`.
2. ☑ `app/manifest.ts`: add `related_applications` (platform `play`, id `com.softmato.hostelpalika`)
   and `prefer_related_applications: true`, so Chrome offers the real app.
3. ☑ A "Get it on Google Play" link, using Google's official badge, in `components/public-footer.tsx`
   and on `/hostel-management-software`.
4. ☑ The FAQ answer to "Is there a HostelPalika app?" says it is on Google Play (`seo.defaults.ts`
   and the stored SEO config). The default is changed; a FAQ already saved in Website Config → SEO
   keeps its old wording until it is edited there.

## Check it yourself

Open on the deployed site after the next deploy:

- `/hostel-management-software`, `/features`, `/features/fee-collection-billing`, `/vs/excel-spreadsheets`
- `/hostels/in`, `/hostels/in/kathmandu`, `/hostels/in/kathmandu/boys`
- `/hostels/education-light-hostel-narephat` — view source: the hostel is in the HTML, with a
  `"@type":"Hostel"` script
- `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest`, and any page's `og:image` URL
- Paste a page into Google's Rich Results Test and the Schema Markup Validator
- Platform → Website Config → SEO — every title, description and landing-page text is editable there

## Outside the code (the team does these)

Sequence matters; each step unlocks the next.

1. Verify `hostelpalika.com` in Google Search Console (Domain property, DNS TXT at Vercel DNS) and
   Bing Webmaster Tools; paste the HTML-tag codes into Website Config → SEO if using the tag method.
2. Submit `https://hostelpalika.com/sitemap.xml` in both. In Google, URL Inspection → Request
   indexing for the pages that matter most (home, `/hostel-management-software`, `/hostels`,
   `/hostels/in/kathmandu`, each hostel page) — there is a small daily quota, so not all 72.
   In Vercel → Settings → Domains, set the `www.hostelpalika.com` redirect to **308 Permanent**; it
   was 307 (temporary) on 2026-09-15.
3. Create the Google Business Profile for HostelPalika (Softmato, Kathmandu) — same name, address and
   phone as the site footer.
4. Fill Website Config → Social links; they become `sameAs` on the Organization record.
5. Replace the placeholder `supportPhone` in Site Identity with a real number before it is published
   in structured data and on the Business Profile.
6. List HostelPalika on software directories (Capterra, G2, GetApp, SaaSworthy, Software Suggest) and
   Nepali startup/tech listings; ask onboarded hostels to link to their HostelPalika page.
7. Record one short walkthrough per feature and upload it on the service's Plans & Pricing entry —
   the service pages already have a slot for it.
8. Publish real guides only when they are written; `/blog` stays `noindex` until then.
9. **softmato.com still calls this product HostelHub** (`D:\company`). `/products` links to
   `/products/hostelhub`, that page is titled "HostelHub · Softmato", and neither page links to
   `hostelpalika.com` once. softmato.com is the one domain Google already trusts for this company,
   and what it currently tells Google is that the product is called something else. Rename the page
   and its route to HostelPalika, keep a 308 from `/products/hostelhub`, and link
   `https://hostelpalika.com` from both the product page and the products index. This is the
   largest single signal available and it costs one deploy of the other repo.
10. Nothing external points here at all: `sameAs` is absent from the Organization record because
    every field in Website Config → Social is blank, the Play listing is still in review, and the
    directories in item 6 were never done. Until some of that exists, `hostelpalika` stays a
    spelling Google corrects rather than a brand it knows.
