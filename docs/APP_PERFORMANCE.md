# App performance — the rendering side

`PERFORMANCE.md` was a **server** plan: where the data comes from and how fast
it arrives. It is done, and it moved the app's critical path from
Kathmandu → Washington → Frankfurt to Kathmandu → Mumbai → Mumbai.

This is the other half: what the app does **after** the data lands. Nothing in
here is about the network.

Tick a box only after the change is in and verified. See `RULES.md` — plan docs
are trackers, not proposals.

---

## Read this before proposing a single fix

**Nothing in this document has been measured.** The findings below are a static
read of the code on 2026-09-20; not one of them has been observed as slowness on
a real device. That is the same mistake `PERFORMANCE.md` was built to avoid, and
it is why Phase A exists and comes first.

Phase A₀ is the exception and is already done: the two things in it are not
guesses about speed but behaviour readable in the code — a save that blanked its
own screen, and reads that re-asked and re-spun on every visit. Neither needed a
stopwatch to confirm. Everything from Phase A down still does.

The app may already feel fine. The server work alone removed ~90 ms from every
database round trip and ~200 ms from every request, and the dashboard makes about
twenty round trips. If the app is now fast enough, the correct outcome of Phase A
is **closing this document**, not working through it.

---

## What is already done — do not redo it

`lib/query-cache.ts` does disk persistence, in-flight dedup, prefetch warming and
topic invalidation. The machinery is finished and is not the thing to go looking
at.

**The claim that used to sit here — that every `useResource` call passed a
`cacheKey` except the store's search box — was wrong.** It was true of the five
portals that had a `*-queries.ts` registry and false everywhere else: 37 of 119
call sites had no key at all. See Phase A₀ below, which is what that turned into.

---

## What a static read found

### Exactly one list in the app is virtualized

**Corrected 2026-09-21 — this heading used to say "no list".**
`components/community-board.tsx` draws its feed with `Animated.FlatList`, and `components/ui/screen.tsx` has an `ownScroll`
mode built for exactly that. `SectionList` and `FlashList` are still absent.
Every *other* list is `.map()` inside a `<ScrollView>`, which renders **every row
on mount** — so mount cost grows linearly with the data, and the memory is held
for rows nobody has scrolled to. The board is also the proof that the
`ListHeaderComponent` restructure Phase B describes is possible here, because it
has already been done once.

Screens with a `<ScrollView>` and three or more `.map()` calls:

| Screen                            | `.map()` | Lines |
| --------------------------------- | -------- | ----- |
| `app/hostel/[slug]/index.tsx`     | 18       | 990   |
| `app/manage/maintenance.tsx`      | 11       | 1322  |
| `app/id-card/edit.tsx`            | 11       | 1848  |
| `components/hostel-browser.tsx`   | 8        | 857   |
| `app/notifications.tsx`           | 8        | 621   |
| `components/public-home.tsx`      | 6        | 828   |
| `app/map.tsx`                     | 5        | 1437  |
| `app/manage/settings.tsx`         | 5        | 1236  |
| `app/manage/rooms.tsx`            | 5        | 724   |
| `components/hostel-compare.tsx`   | 4        | 318   |
| `app/(resident)/notices.tsx`      | 4        | 430   |
| `components/store/store-ui.tsx`   | 3        | 1167  |
| `app/manage/notices.tsx`          | 3        | 682   |

**That table is a list of places to look, not a list of things to fix.** Most of
those `.map()` calls render *bounded* sets — facility chips, room types, form
options, a photo strip — and a `FlatList` around six chips is slower than the
`.map()`, not faster, and much harder to read. The detail and form screens near
the top are almost certainly in that category despite their counts.

**The ones that matter are the lists whose length is driven by how much data the
hostel has.** Separating the two is the first real task, and it cannot be done by
counting `.map()` calls — it needs reading each one.

### The known worst case

`app/notifications.tsx`. Production holds **396 notifications**, and the server's
`MAX_PAGE_SIZE` is **100** (`lib/pagination.ts`), so one page mounts a hundred
rows at once, each with its own icon, tint and date formatting.

### What is already right, and what is available

- **`expo-image` is already used everywhere** — 40 imports against 6 remaining
  raw `<Image>` tags. Image decoding and caching is not the gap.
- **`react-native-reanimated` 4.5.1** is installed, so animation can move off the
  JS thread where it has not already.
- **`@shopify/flash-list` is not installed.** `FlatList` ships with React Native
  and handles a few hundred rows; reach for a dependency only if it does not.

---

## Phase A₀ — What did not need a device

Four faults that are not performance guesses and did not need Phase A to justify
them: every one is visible in the code as behaviour, not as a suspicion about
speed. Done, and here for the record.

### ☑ A mutation no longer blanks the screen it changed

`useResource` exposes two ways to re-ask: `refresh()` keeps what is on screen and
toasts a failure, `reload()` sets `loading` and is documented in the hook as the
`<ErrorState>` retry button. **47 post-mutation call sites across 21 screens
called `reload()`**, and every one of those screens branches
`if (x.loading) return <LoadingState/>` — so saving a hostel's settings replaced
a 1,236-line form with a centred spinner and rebuilt it, and the same on
maintenance, wardens, rooms, notices, the cook roster, money and statements.

All 47 now call `refresh()`. `reload()` is left where it belongs — behind
`onRetry`. The statements screen's manual "Refresh" button moved its spinner from
`loading` to `refreshing` to match.

That is the blanking gone. Skipping the round trip as well is the next item.

### ☑ 37 reads had no `cacheKey`, so they re-asked and re-spun every visit

A read with no key holds its payload in component state and loses it on unmount:
empty screen, full spinner, every single visit. The registries fixed this for the
portals that had one; the screens below had never been through it.

The worst of them were **detail screens refetching the list they were opened
from** — `complaints/[id]`, `invoice/[id]`, `job/[id]` and the ID card all have
no endpoint of their own and find their row inside the parent payload, so a tap
threw that payload away and asked for it again behind a spinner:

| Read | Was asked by | Now |
| --- | --- | --- |
| `listPublicHostels()` | home, map, Saved, browser | `publicQuery.hostels()` |
| `getOwnProvider()` | provider card, Profile tab, `/service-providers` | `providerQuery.application()` |
| `listProviderJobs()` | provider home, `job/[id]` | `providerQuery.jobs()` |
| `getFinanceView()` | `invoice/[id]`, certified receipts | `residentQuery.finance()` |
| `getResidentComplaints()` | complaints list, `complaints/[id]` | `residentQuery.complaints()` |
| `getIdentity()` | ID card, its editor | `residentQuery.identity()` |
| `getResidentProfile()` | profile, review | `residentQuery.profile()` |
| `getSiteConfig()` | public home, `use-site-config` | `publicQuery.siteConfig()` |
| `listNotifications("unread")` | the community board's own bell | `notificationQuery.feed("all")` |

Two new registries, matching the six that existed: `lib/public-queries.ts` (the
signed-out catalogue, comparison and site config) and `lib/provider-queries.ts`
(the last portal without one). `adminQuery` gained `attendanceSettings`,
`existingResidents`, `gateways`, `reconciliation` and `residentScan`; the rest
took a key inline.

Three reads are keyed **only when signed in** — the provider application on two
screens, the community bell, the hostel applications list. The empty value a
signed-out shell renders is a placeholder, and writing it to the shared entry
would show a signed-in reader an empty answer being quietly revalidated.

**One read is still deliberately uncached besides the store's search box:**
`app/map.tsx:279`, the road route, whose answer depends on the phone's live
coordinates. A key per coordinate is cache garbage on a disk-persisted store.

---

### ☑ 39 spinners where the layout was already known

`docs/DESIGN.md` §5 says skeleton, not spinner, for cards and tables, and
`components/ui/skeleton.tsx` says the same in more useful terms: `LoadingState`
is right when the screen has **no idea what shape it will be**, and a skeleton is
right when it does — because the page then does not jump when the data lands,
and a jump is what makes an app feel slower than it is even when it is faster.

39 `<LoadingState>` call sites across 37 files sat on screens whose shape was
known: admin forms, resident detail screens, the store, the public browser. All
39 are now skeletons, and `<LoadingState>` has no call sites left.

The shape was chosen per screen rather than swept, because a skeleton that does
not match what replaces it is worse than the spinner — it promises a layout and
then reflows out of it:

| What the screen loads into | What it now shows |
| --- | --- |
| A stack of separate cards (`gap-3`) | `SkeletonRows` |
| One `<Card>` of rows | `SkeletonCard` |
| A `<Segmented>` strip above either | `Skeleton height={40} radius={20}` first |
| A `<StatTile>` grid | `SkeletonTiles` |
| Prose sections | `SkeletonText` |
| A photo card list (hostels, products) | `Skeleton` at the card's own height |

Two screens needed a shape the kit does not have, and both got a local component
rather than a near-duplicate export: `app/sos.tsx` renders rows **inside** a
`<Card>` the screen already draws, where `SkeletonCard` would put a second border
inside the first; and the community feed is flat posts split by a hairline, where
`SkeletonRows`' bordered boxes are the wrong thing entirely.

`LoadingState` is left exported and documented. It is the right answer for a
screen whose shape genuinely is not known yet, and deleting it would leave the
skeleton file's own comparison pointing at nothing.

---

### ☑ The saves whose answer is the new row no longer wait for a second read

`refresh()` removed the blanking, but the change still arrived a round trip after
the tap. For a mutation that **answers with the row it just wrote**, that second
read is redundant: the authoritative value is already in hand, and
`use-resource`'s `setData` files it to the cache as well — so every screen on
that key moves at once.

Nine endpoints answer that way, and their screens now write the response
straight in:

| Endpoint | Answers with | Screen |
| --- | --- | --- |
| `updateManagedHostel` | the hostel | `manage/settings` (every panel), `manage/rooms` |
| `updateCommunitySettings` | the settings | `manage/settings` |
| `updateAttendanceSettings` | the settings | `manage/settings` |
| `updatePaymentProfile` | the profile | `manage/finance/payment-setup` |
| `updateCook` | the cook (+ new credentials) | `manage/cook` — rename and rotate |
| `saveRentConcession` | the concession | `manage/finance/month-discounts` |
| `deleteRentConcession` | the id it deleted | `manage/finance/month-discounts` |
| `updateGuardianPermissions` | the settled permissions | `guardians` |
| `setLocationConsent` | the consent | `attendance` |
| `updateProviderJobStatus` | confirms the status | `job/[id]`, shared with the provider's home |

`manage/settings` is the one worth naming: it is the app's heaviest form, every
panel on it saves through one `patch()`, and that save now costs no request after
the PATCH at all.

**Where the response does not settle the question, the `refresh()` stays.**
`addHostelPhoto`, `deleteHostelPhoto`, `setInquiryStatus`, `updateManagedNotice`,
`createNoticePush`, `recordCashPayment`, `voidInvoice`, `confirmReferral`,
`updateWarden` and the maintenance mutations all answer with nothing, so the only
way to know the new state is to read it. Guessing it locally would be optimism in
the bad sense — a screen showing a change the server may not have made.

`removeCook` is the interesting refusal: it *does* answer with a cook, but with
the frozen “Previous ‹hostel› cook” the removal leaves behind, and nothing in
that answer says whether the roster still lists the row. It re-reads.

Two screens already did this before today and were left alone: `night-status`
writes the status the POST returns, and `complaints/[id]` splices the complaint
`confirmComplaintResolution` hands back.

---

## Phase A — Measure, before changing anything

Nothing below this phase should start until it produces a number and a name. The
whole point of the server work landing first was to make this measurable; that
advantage is wasted by guessing now.

- [ ] Run the app on a real Redmi against production and use it normally. Name
      the screens that feel slow, and say **how** — slow to appear, janky while
      scrolling, or slow to respond to a tap. Those are three different faults
      with three different causes and only the middle one is about lists.
- [ ] For each named screen, get a number before touching it: time to first
      paint after the tap, and frames dropped while scrolling. React DevTools
      Profiler or the Expo performance monitor — whichever gives a figure that
      can be repeated afterwards.
- [ ] **If no screen feels slow, close this document.** Record that it was
      checked and found fine. A rewrite nobody asked for that fixes nothing is
      worse than the `.map()` it replaced.

### 2026-10-21 — named on a device (screen recordings from the user)

Not yet a number, but a name and a *how*, which is the first half of the
first box:

- **Tab bar → Search: slow to respond to the tap.** ~0.6s between the press and
  the cross-fade starting. The tab held all 60 result cards (`.map()` in a
  ScrollView, each a photo and a dozen SVG icons), re-attached on every visit
  and reconciled on every keystroke.
- **Search → Map: blank.** The embedded MapLibre view was a GLSurfaceView
  inside a rounded, cross-fading tab card and never drew a tile. Not a speed
  fault — a surface ignores its parent's clip and fade.
- **Home: janky on scroll.** A scroll-linked colour fade on the header and a
  drift/scale/fade on the shortcut card, re-run every frame.

What changed in answer, all in code that every screen shares or on the two
screens named:

- ☑ `HostelBrowser`'s results are an `Animated.FlatList` (`initialNumToRender`
  3, `windowSize` 7) — Phase B's first real case. Header controls are pinned in
  `Screen`'s `header`, not `ListHeaderComponent`, so the field never scrolls away.
- ☑ `HostelCard` and `Glyph` are `memo`. Every caller passes primitives and
  stable handlers, so a parent re-render no longer rebuilds the SVG trees.
- ☑ `Screen` mounts its body one frame after its header, so every push starts
  its fade on the tap and the heavy render runs under the native animation.
- ☑ Home's search text lives in `DiscoveryHeader`; typing re-rendered all of Home.
- ☑ `useNearby.refresh` keeps the old coordinates under 50 m of jitter; a new
  object on every Home focus re-sorted and re-rendered the page mid-tab-change.
- ☑ `HostelMap` renders through a TextureView and shows a skeleton until
  `onDidFinishLoadingMap`.
- ☐ Re-record the same three paths on the Redmi after these land, and get the
  tap-to-fade number this box asks for.

---

## Phase B — Virtualize the lists that grow with data

Only the screens Phase A named, and only the `.map()` calls inside them whose
length comes from a server payload rather than a constant.

- [ ] Read each candidate `.map()` and classify it: **bounded** (facilities,
      tabs, filters, form options, a fixed photo strip) or **data-driven** (a
      roster, a ledger, a notice feed, a product grid). Write the classification
      down in this file. Bounded ones stay `.map()`.
- [ ] `app/notifications.tsx` first — it is the one with a hundred rows on a
      page and a known production volume behind it.
- [ ] Nested scrolling is the trap. A `FlatList` inside a `ScrollView` warns and
      loses virtualization entirely, so a screen with a header above a long list
      has to invert: the list becomes the scroller and the header becomes
      `ListHeaderComponent`. That is a real restructure, not a swap, and it is
      why this is per-screen work rather than a find-and-replace.
- [ ] Keep the interaction vocabulary. `ui_inspiration_folder/app_recordings/NOTES.md`
      is binding: lists group by date with the heading **outside** the card, and
      loading is **skeletons**, not spinners. `ListHeaderComponent` and
      `SectionList` sections have to preserve that, not flatten it.

---

## Phase C — Only if Phase A points here

Candidates, unranked, none of them confirmed:

- **Re-render cost.** A 1,300-line screen re-rendering wholly on every keystroke
  is a different fault from an unvirtualized list and is fixed with memoisation,
  not `FlatList`. Phase A's "slow to respond to a tap" symptom points here.
- **Screen mount cost.** The largest files (`id-card/edit.tsx` at 1,848 lines,
  `map.tsx` at 1,437) may be doing work at mount that could be deferred.
- **Startup.** Time from tap to first usable frame, and what the boot path awaits
  before it. See `mobile-app-plan` on the no-flash splash boot.
- **The six remaining raw `<Image>` tags**, if any of them sit on a hot screen.

---

## Deliberately not doing

- **`@shopify/flash-list`.** A new dependency for a problem `FlatList` has not
  been shown to fail at. Revisit only with a measurement where it does.
- **A blanket `.map()` → `FlatList` sweep.** It would wrap dozens of six-item
  chip rows in a virtualized list, making them slower and harder to read, and it
  would touch every screen in the app for no measured gain.
- **Anything in `PERFORMANCE.md`.** That work is done. Two items remain there and
  both are infrastructure: deleting old Vercel deployments, and deleting the
  Frankfurt cluster once it has been cold long enough.
