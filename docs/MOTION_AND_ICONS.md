# Motion and our own icons

Tracker. Work one item at a time: code → verify → flip ☐ to ☑ before the next.

Two tracks, started 2026-10-16 from a screen recording of FoneBiz (Fonepay
Business). What FoneBiz has and we don't: things respond when you press them,
the active tab is a tinted pill that moves, a card grows into the screen it
opens, sheets spring, and the theme change cross-fades. We take the motion and
the layout ideas from it. We never take its colour (see `docs/DESIGN.md`).

Both tracks change rules that `docs/DESIGN.md` currently forbids ("lucide-react
exclusively", "don't animate page transitions or list additions"). Item I8 and
M0 rewrite those sections. Until then this file wins where the two disagree.

---

## Track I — our own icons, one set for web and app

**Today:** web draws 243 lucide icons across 222 files. The app draws about 200
Ionicons shapes (outline + filled) across 146 files, plus 26 lucide icons in 20
files. `packages/shared/src/constants/glyphs.ts` already holds 15 of our own
line icons, drawn by `<Glyph>` on both sides (`apps/web/src/components/glyph.tsx`,
`apps/mobile/src/components/ui/glyph.tsx`). That file becomes the whole set.

**Style rules:** 24×24 grid with a 3px live-area margin. Line icons use a 1.6
stroke with round caps and joins, and no fills. Solid icons are fill-only with
`evenodd` cut-outs, so a hole keeps its size. Every icon is drawn in
`currentColor` or a theme token and never a hex, which is how one icon works on
both the black and the white theme.

- ☑ **I1. Pick the style.** Chosen 2026-10-16: **line everywhere, solid only
  for the active or selected state**. Sample: `docs/mockups/icons/style-sample.png`.
- ☑ **I2. Schema.** `GLYPHS` (line) + `SOLID_GLYPHS` (fill, `evenodd`) in
  `glyphs.ts`. Both `<Glyph>`s take `variant`; a missing solid draws the line
  heavier. `resolveGlyph()` covers names that come from data: stored
  `bed-outline` → `bed`, unknown → a plain circle. Tested in
  `apps/web/src/lib/glyphs.test.ts`.
- ☑ **I3. Draw the set.** 287 line glyphs, 38 solid. Names follow the Ionicons
  base names, so the app swap was a suffix strip. Review it all in one picture:
  `node --experimental-strip-types packages/shared/scripts/glyph-sheet.ts` →
  `docs/mockups/icons/glyph-sheet.png`.
- ☑ **I4. Web swap.** `apps/web/src/components/icons.tsx` exports the 242 lucide
  names the portal used, each drawing a glyph. `IconComponent`/`IconProps`
  replace `LucideIcon`/`LucideProps`. 222 files changed only their import line.
  Store category icons default to glyph names now (`cube`, `bed`).
- ☑ **I5. App swap.** Every `<Ionicons>` and lucide import is now `<Glyph>`
  (about 150 files). Icon props are typed `GlyphName`. Tabs, selected action
  tiles, ticked boxes, radios, saved hearts, star ratings and the torch go solid
  on their selected state. Map turn arrows replace MaterialIcons. The Google
  button draws Google's own G.
- ☐ **I5b. Drop the packages.** Lint now blocks `lucide-react`,
  `lucide-react-native` and `@expo/vector-icons`, so nothing can import them.
  They are still listed in `package.json`. Remove them on the next dependency
  pass with npm 10, because local npm 11 rewrites the mobile lock (see the EAS
  npm note in memory).
- ☐ **I6. Spinner.** Web `Loader2` now draws our `spinner` glyph, turned by
  `animate-spin`. The app's buttons still use `ActivityIndicator`; swap it
  in M1 alongside press feedback.
- ☑ **I7. Brand marks.** The Google button uses Google's own four-colour G,
  which their sign-in rules require. WhatsApp is drawn in our line style for
  the share button (`logo-whatsapp`). eSewa and Khalti stay the image assets
  in `wallet-mark.tsx`.
- ☑ **I8. Rules.** `docs/DESIGN.md` §Icons and §10 are rewritten, and the
  expense categories note points at `glyphs.ts`.
- ☐ **I9. Device pass.** Check the app on a phone: tab bar line → solid, the
  admin home tiles, a list with chevrons, the map directions banner, and the
  Google button. It is a JS-only change, so it can go out by OTA.

## Track M — motion (app first, then web)

**Today:** Reanimated 4 is in 23 files, with a few `FadeIn`/`ZoomIn` enterings.
The tab bar slides away on scroll. Stack pushes cross-fade in 180ms. Skeletons
pulse their opacity. Sheets are gorhom, which already springs. Presses only dim
(`active:opacity-80`). The Button's `haptic` branch is empty.

- ☑ **M0. Motion tokens + rules.** Done 2026-10-20: `constants/motion.ts`,
  DESIGN.md §8 rewritten. Web uses Tailwind values directly (no `--motion-*`
  variables yet; add them when a second web animation needs the same numbers).
  Was: Put durations, springs and press scale in
  one file (`apps/mobile/src/constants/motion.ts`), with matching CSS variables
  on web. Respect the OS "reduce motion" setting (`useReducedMotion`,
  `prefers-reduced-motion`). Rewrite `docs/DESIGN.md` §8.
- ☑ **M1. Press feedback.** Done 2026-10-20: `ui/pressable-scale.tsx`. Haptics
  only on serious actions (user, 2026-10-20): `danger` buttons, the
  `openConfirm` confirm, a swipe action firing. Was: One press wrapper: scale to ~0.97 on a spring, and
  a light haptic where the press commits something. `Button`, `ListRow`,
  `CardRow`, `ActionTile`, `IconButton`, `Card` and `DataCard` all go through
  it. Fill in the empty haptic branch in `Button`.
- ☑ **M2. Tab bar.** Done 2026-10-20, **no haptic** on tab switches (user). Was: The tinted pill slides to the tapped tab on a spring. The
  icon switches line → solid with a small pop. Selection haptic. (FoneBiz
  0:14–0:20.) Needs I2 if the style is line + solid when active.
- ☑ **M3. Collapsing title.** Done 2026-10-20: `Screen` feeds its page offset
  from the same scroll handler as the tab bar into a per-screen value
  (`useScreenScroll`); a `large` `AppBar` scales its title to bar size
  (`MOTION.titleCollapse`) and fades a hairline in under itself. Used by every
  `large` tab: admin Payments + Overall tabs, cook Menu/Photos, guardian
  Payments/Safety, resident Food/Payments. Was: The large screen title shrinks into the `AppBar`
  as the list scrolls under it. `Screen` and `AppBar` share one scroll value,
  which `BottomChromeProvider` already tracks for the tab bar.
- ☑ **M4. Lists.** Done 2026-10-20: the screen body rises in once on mount
  (`Screen`), and `<Stagger>` (`ui/layout.tsx`) replaces a list's
  `<View className="gap-3">`: each direct child gets a wrapper, the first
  `MOTION.staggerRows` rise in `MOTION.stagger` ms apart, and a row leaving
  fades while the rest slide up (`LinearTransition`). Mounted rows keep their
  wrapper, so refreshes replay nothing; `from` carries the count across date
  groups. On admin Residents, Money and Alerts, Notifications, resident
  Notices, Complaints (list + manage, the latter by day) and Expenses (by day).
  Not on the community `FlatList`: recycled cells mount mid-scroll. Was: On first load, the first ~8 rows fade up one after another.
  A deleted or swiped-away row collapses instead of vanishing (`LinearTransition`).
  Refreshes don't re-animate.
- ◐ **M5. Swipe.** 2026-10-20: a light haptic when the swipe action fires. The
  spring-open and swipeable segment pages are still to do. Was: Row swipe actions spring open and tick a haptic at the
  commit point (`swipe-row.tsx`). Segmented tabs become swipeable pages, with
  the segment pill following your finger.
- ☑ **M6. Skeleton shimmer.** Done 2026-10-20. Was: Replace the opacity pulse with a light band that
  sweeps across (`expo-linear-gradient` is installed).
- ◐ **M7. Money moments.** 2026-10-20: large/display `Money` counts up once. The
  hide-amount morph is still to do. Was: Totals count up once when they first appear. The
  hide-amount eye morphs the digits into dots and back (FoneBiz 0:15).
- ☐ **M8. Card → screen.** The tapped card grows into the next screen's header
  (FoneBiz 0:34, More → My account). Reanimated's shared-element transitions
  are still behind a feature flag on the new architecture. So build our own:
  measure the source card, draw a copy over the screen, animate it to the
  header's box, then hand off to the real header.
- ☐ **M9. Theme cross-fade.** Snapshot the current frame with
  `react-native-view-shot` (installed), swap the theme underneath, then fade
  the snapshot out (FoneBiz 0:42–0:44).
- ◐ **M10. Web.** 2026-10-20: `Button` presses scale to 0.97; page fade is W3. Was: Same vocabulary: press scale on buttons and cards, a fade-up
  on page entry, springs on dialogs and sheets, and the shimmer. Use CSS first.
  `motion` is already installed for anything CSS can't do.

## Track W — web portal shell (FoneBiz web, 2026-10-16)

From a recording of FoneBiz's web portal. Every portal stays green, black and
white.

- ☑ **W1. One palette.** `--role-*` all resolve to the brand green
  (`#0a8a4b`, dark `#12a95d`) in `globals.css`, so all ~630 role-colour uses
  went green at once. The shared tone tables fold blue, cyan, purple and teal
  into green or neutral, and keep amber and rose for warning and wrong. Five
  portal pages that hard-coded sky or violet are fixed.
- ☑ **W2. Two-tier sidebar.** Past 20 destinations (platform, hostel admin) the
  shell shows a rail of sections plus a panel of the chosen section's pages.
  Sections have `icon`/`short` in `portal-nav.ts`. The active row is a green
  tint with an edge bar and a solid glyph. The panel slides shut. Smaller
  portals keep one list. Help moved into the sidebar and the footer bar is gone.
- ☑ **W3. Motion.** Pages fade up on every navigation (`.animate-page-in`,
  keyed by pathname). The panel list fades on section change. Accordions open
  to their own height. Dialogs zoom in over a blurred backdrop. Clickable stat
  tiles lift on hover. All of it respects reduced motion.
- ☑ **W4. Page header block.** `PageHero` (`components/page-hero.tsx`): a
  near-black block with a green glow, a glass tile with the page's glyph from
  its sidebar row, the title, one clamped line and actions. It wears `.dark` so
  page actions re-theme. All four header components route through it, which
  covers about 76 pages.
- ☑ **W5. Readouts.** `MetricCard` is a bare stat tile (tinted circle, number,
  small uppercase label). `EmptyState` is one mark and one line.
- ☑ **W6. Pages outside the shared parts.** Every page inside a portal shell
  now heads with `PageHero`: billing, KYC, branch detail, platform Team,
  provider jobs and the team desk, register and residents pages moved onto
  `PortalPageHeader`, and the last two header helpers (`portal-shared`'s
  `PageHeader`, `ResidentHeader`) route through it too. Stat rows on
  complaints, attendance, both referral pages, reports, branch detail and the
  team desk are `MetricCard`s; `StatTile` (report-widgets) now renders one, and
  `MetricCard`'s icon is optional for figures inside a section. Long header
  lines were cut to one. The `<h1>`s left are on public and auth routes
  (invites, checkout, join, registration), which have no portal shell.
- ☐ **W7. Browser pass.** The user checks admin, platform and resident in light
  and dark: rail and panel, collapse, page fade, a header with actions, the
  dialogs.

## Track P — portal page redesign (2026-10-17)

From the user's walk-through of the admin portal: every tab page gets the clean,
graphical treatment. The rules are in `docs/DESIGN.md` under "Portal page
patterns".

- ☑ **P0. Shell.** Rail tiles navigate to their section's first page. Sidebar
  type is a size up. Panels are white (no cream `--surface`).
- ☑ **P1. Rooms & Beds.** "Add room type" is in the header and opens a dialog.
  Rooms, beds and free beds are tiles. Room types are cover-photo cards with an
  occupancy bar and fact chips. Edit and Photos are dialogs.
- ☑ **P2. Wardens.** Permissions are four area cards of toggle chips with
  All/None. Add warden is a dialog. Wardens are avatar rows with a permission
  bar.
- ☑ **P3. Residents.** The header has Join link, a ⋯ menu and Add resident.
  Status and type sit behind `FilterButton`, and the count is quiet text.
- ☑ **P4. Hostel Profile → Overview.** Count tiles, status and type chips, icon
  rows, and facility and room-type chips.
- ☑ **P5. Hostel admin, the rest.** Floors panel, Bookings, Inquiries,
  Move-in/out, the Finance pages, Operations (food, stock, night status,
  notices, complaints, maintenance, SOS, attendance), Growth & System. Every
  standing "add" form is a header button and a dialog, filters sit behind
  `FilterButton` beside a visible search, and totals are tiles with thin
  share bars. The portal's own chips, bars and ⋯ menu are in
  `hostel-admin-page-ui.tsx`, so no shared kit changed.
  - ☑ **P5b. Finance, logos and gauges.** Real eSewa, Khalti, Fonepay and bank
    marks (`WalletMark`/`WalletBadge`) on Online Checkout, Payment Setup
    (the bank tile draws the named bank), Reconcile, Payments, Transactions
    and Expenses. Gauges after the app: "n / 4 ready" per gateway, "n / 4 ways
    to pay", a cleared bar on Reconcile, collected-of-billed on Payments,
    spent-of-in on Expenses, per-rate and per-khata bars.
- ☑ **P6. Platform portal pages.** Every PLATFORM_NAV page: header actions open dialogs,
  filters sit behind FilterButton, totals are tiles, shares are bars, facts are chips
  (`platform-page-ui.tsx`); money pages lead with a big figure and a split bar, and every
  provider, wallet or bank shows its real logo (`WalletMark`). The hostel and provider
  review sub-pages (not nav destinations) keep their old layout.
- ☑ **P7. Resident, guardian, cook, provider and team pages.** Shared pieces
  in `daily-portal-ui.tsx`: the amount owed as a big figure with a bar to its
  due date, meal tiles, notice cards, a hostel card, an icon-tile menu. Forms
  are header dialogs (complaint, guardian invite, rate a meal, khata ask, SOS,
  cook photo); filters sit behind `FilterButton`; history and job lists are
  cards or rows with bars. The four guardian routes now each show their own
  section of the one dashboard request. The shared Notifications page is
  restyled for every portal, the platform inbox included. Left as they were:
  the public `/bookings` page (public shell) and the register wizard's steps
  beyond its header, cards and alerts.
- ☐ **P8. Browser pass** by the user after each portal.

**Order:** M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9 → M10.
I1 → I2 → I3 → (I4 ∥ I5) → I6 → I8, with I7 alongside.

**Verifying motion:** a screenshot can't show motion. Check each M item on a
real phone, as an `adb shell screenrecord` clip or a hands-on pass by the user.
The phone is the user's daily handset, so ask before launching anything on it.
