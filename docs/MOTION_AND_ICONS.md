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

- ☐ **M0. Motion tokens + rules.** Put durations, springs and press scale in
  one file (`apps/mobile/src/constants/motion.ts`), with matching CSS variables
  on web. Respect the OS "reduce motion" setting (`useReducedMotion`,
  `prefers-reduced-motion`). Rewrite `docs/DESIGN.md` §8.
- ☐ **M1. Press feedback.** One press wrapper: scale to ~0.97 on a spring, and
  a light haptic where the press commits something. `Button`, `ListRow`,
  `CardRow`, `ActionTile`, `IconButton`, `Card` and `DataCard` all go through
  it. Fill in the empty haptic branch in `Button`.
- ☐ **M2. Tab bar.** The tinted pill slides to the tapped tab on a spring. The
  icon switches line → solid with a small pop. Selection haptic. (FoneBiz
  0:14–0:20.) Needs I2 if the style is line + solid when active.
- ☐ **M3. Collapsing title.** The large screen title shrinks into the `AppBar`
  as the list scrolls under it. `Screen` and `AppBar` share one scroll value,
  which `BottomChromeProvider` already tracks for the tab bar.
- ☐ **M4. Lists.** On first load, the first ~8 rows fade up one after another.
  A deleted or swiped-away row collapses instead of vanishing (`LinearTransition`).
  Refreshes don't re-animate.
- ☐ **M5. Swipe.** Row swipe actions spring open and tick a haptic at the
  commit point (`swipe-row.tsx`). Segmented tabs become swipeable pages, with
  the segment pill following your finger.
- ☐ **M6. Skeleton shimmer.** Replace the opacity pulse with a light band that
  sweeps across (`expo-linear-gradient` is installed).
- ☐ **M7. Money moments.** Totals count up once when they first appear. The
  hide-amount eye morphs the digits into dots and back (FoneBiz 0:15).
- ☐ **M8. Card → screen.** The tapped card grows into the next screen's header
  (FoneBiz 0:34, More → My account). Reanimated's shared-element transitions
  are still behind a feature flag on the new architecture. So build our own:
  measure the source card, draw a copy over the screen, animate it to the
  header's box, then hand off to the real header.
- ☐ **M9. Theme cross-fade.** Snapshot the current frame with
  `react-native-view-shot` (installed), swap the theme underneath, then fade
  the snapshot out (FoneBiz 0:42–0:44).
- ☐ **M10. Web.** Same vocabulary: press scale on buttons and cards, a fade-up
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
- ☐ **W6. Pages outside the shared parts.** About 37 page components draw their
  own `<h1>` or stat rows. Move each onto `PageHero`/`MetricCard` and trim its
  copy to one line. Go portal by portal: admin, platform, resident.
- ☐ **W7. Browser pass.** The user checks admin, platform and resident in light
  and dark: rail and panel, collapse, page fade, a header with actions, the
  dialogs.

**Order:** M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9 → M10.
I1 → I2 → I3 → (I4 ∥ I5) → I6 → I8, with I7 alongside.

**Verifying motion:** a screenshot can't show motion. Check each M item on a
real phone, as an `adb shell screenrecord` clip or a hands-on pass by the user.
The phone is the user's daily handset, so ask before launching anything on it.
