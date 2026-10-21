# DESIGN.md — Design System & UX Guidelines

## 1. Principles

- **Trustworthy, not flashy.** Students and parents are making a "where will I live" decision — the design should read as credible and calm (think: a well-run listings/booking site), not like a flashy startup landing page.
- **Not a surveillance product.** Anywhere night-status/safety appears, the tone must be reassuring and summary-level, never map-pin-tracking-you. No red dots on a live map, no "last seen 4 minutes ago" language.
- **Boring in the right places.** Payments, receipts, complaint status — these should look like a bank/utility dashboard: clear numbers, clear status, no ambiguity. Save personality for the public discovery pages.
- **Mobile-first web.** Most students will browse on a phone even before the native app exists in Phase 6 — every public page and every portal must work cleanly at 375px width.

## 2. Foundation

Built on **shadcn/ui** + Tailwind CSS. Do not hand-roll components that shadcn/ui already provides (Button, Card, Dialog, AlertDialog, Tabs, Table, Badge, Select, Form, Toast, etc.) — extend them with variants rather than replacing them.

**Confirmations use the shadcn `AlertDialog`, never `window.confirm`.** The
native dialog ignores the theme, cannot say more than one line, and blocks the
main thread. Use the `useConfirm()` hook in
`app/_components/confirm-dialog.tsx`, which keeps the boolean-returning shape
that made `window.confirm` convenient:

```tsx
const { confirm, confirmDialog } = useConfirm();
// …
if (!(await confirm({ title: "Delete your post?", description: "…", tone: "destructive" }))) return;
// …
return <>{confirmDialog}…</>;
```

Set `tone: "destructive"` for anything that removes, revokes or cannot be
undone, and make `actionLabel` name the action ("Delete post", "Revoke access")
rather than "OK" — the button label is the last thing read before committing.

### Color tokens

**`apps/web/src/app/globals.css` is the source of truth** — it is Tailwind v4,
so tokens are plain `:root` custom properties in **oklch**, surfaced to
utilities through an `@theme inline` block, with a `.dark` override. Not the
HSL `@layer base` triplets an early draft of this file showed.

**The brand is green, not blue.** An earlier version of this document specified
`--primary: 221.2 83.2% 53.3%` (blue), copied from the stock shadcn palette and
from the UI mockups. The shipped theme is green and has been since Phase 2 —
copy a mockup's *layout*, never its colours.

Key tokens as built:

```css
:root {
  --primary: oklch(0.508 0.118 165.612);   /* green */
  --primary-foreground: oklch(0.979 0.021 166.113);
  --destructive: oklch(0.577 0.245 27.325);
  --radius: 0.625rem;

  --warning: #d97706;
  --success: #16a34a;
  --brand-teal: #0a8a4b;                   /* the brand green */
  --brand-teal-soft: rgba(10, 138, 75, 0.1);

  /* Every portal is green, black and white (2026-10-16): the role tokens all
     resolve to the brand green (#12a95d in dark). They stay as names so call
     sites keep saying which portal they belong to. */
  --role-platform | --role-admin | --role-resident | --role-guardian | --role-team: #0a8a4b;
  --role-*-soft: #e7f4ec;

  /* The page header block (PageHero) */
  --hero: #0f1512;   --hero-glow: rgba(18, 169, 93, 0.24);
}
```

Use the **role tokens** for portal chrome and the **brand token** for shared
product surfaces. Never reach for a raw hex in a component. No portal gets an
accent of its own: blue, cyan, purple and teal are not ours. Amber and red stay
only where they mean warning or wrong.

### Portal shell (web)

- **Two tiers past 20 destinations** (platform and hostel admin). A rail of
  sections (icon tile plus a one-word name) sits beside a panel with the chosen
  section's pages. Clicking a section opens its pages without navigating. A
  section with a single page is a plain link. The panel slides shut, and the
  rail is the icon view. Smaller portals keep one list.
- The **active row** is a green-tinted row with a 3px green bar on its edge,
  and its glyph turns solid. There is no filled colour pill.
- The **page header** is `PageHero`: a near-black block with a green glow, the
  page's glyph in a glass tile, the title, one clamped line and actions. Its
  glyph comes from the page's own sidebar row.
- **Stat tiles** are an icon in a tinted circle, the number, and a small
  uppercase label. **Empty states** are one mark and one line, with no dashed
  box.
- No footer bar. Help sits at the bottom of the sidebar.
- Rail tiles are links to their section's first page. Sidebar rows are 13.5px.

### Portal page patterns (web, 2026-10-17)

Set by Rooms & Beds, Wardens, Residents and Hostel Profile. Every portal page
follows them:

- **The page's main create action is a button in `PageHero`.** Its form opens
  in a dialog. No page keeps a standing "Add X" form column beside its list.
- **Edits happen in dialogs**, not in inputs that are always open on a card. A
  card shows facts; an Edit button opens the form.
- **At most three header actions**: the primary one, one or two secondary, and
  a "⋯" menu for the rest.
- **Filters**: the search box stays visible. Everything else that narrows a list
  goes behind `FilterButton` (`components/filter-panel.tsx`) as
  `FilterChoice` chips, and the button shows a count.
- **Counts are pictures**: `MetricCard` tiles for totals, a thin bar for a
  share (beds taken, permissions granted), and chips for short lists
  (facilities, room types, permissions).
- **Many on/off settings are toggle chips** grouped by area, each group a small
  card with its glyph, an "n/m" count and All/None. They are not a wall of
  checkboxes.
- **Text**: the page line is one sentence. A section title is 15px semibold.
  Body copy is 13.5px. Labels are 11px uppercase. Explanatory paragraphs go;
  if a rule matters, it is one line in the dialog where it applies.
- **Surfaces** are white cards (`--surface` is white now, no cream) with a
  quiet border and a 16px radius. Hover lifts a clickable card 2px.

### Status color mapping (use consistently everywhere)

| Status type | Green (success) | Yellow (warning) | Red (destructive) | Gray (muted) |
|---|---|---|---|---|
| Payment | Paid | Partial / Due soon | Overdue / Unpaid | — |
| Complaint | Resolved | In progress | Rejected | Pending |
| Hostel verification | Verified | Pending review | Rejected | Unverified |
| Night status | Inside Hostel | Not Verified | SOS | Outside Hostel (neutral, not alarming) |
| Bed/Room | Available | Reserved | Under repair | Occupied |
| Maintenance request | Completed | Scheduled/Contacted | Cancelled | Pending |
| Service provider | Approved | Pending | Rejected | Hidden |

**Important:** "Outside Hostel" is a **neutral** status, not a warning — students leaving the hostel is normal life, not a red flag. Only "SOS" gets urgent red treatment.

### Typography

- Two families, loaded in `app/layout.tsx` via `next/font/google`, plus a mono
  for code: **Geist** for body (`--font-geist-sans`), **Poppins** for headings
  (`--font-poppins`, exposed as the `font-heading` utility), **Geist Mono**
  (`--font-geist-mono`). Don't add a fourth. An earlier draft said "one font for
  everything"; the heading/body split shipped deliberately and is kept.
- Scale: `text-xs` (12px) → `text-sm` (14px, default body) → `text-base` (16px) → `text-lg/xl/2xl` for section headers → `text-3xl/4xl` only on the public homepage hero.
- Numbers (fees, amounts, counts) use tabular figures (`font-variant-numeric: tabular-nums`) wherever they appear in a table/list so digits align.

### Spacing

Tailwind's default scale (4px base unit). 
- Card padding: `p-4` mobile / `p-6` desktop
- Section gaps: `gap-6` to `gap-8`
- Don't invent custom spacing values outside the scale

### Icons

**Our own set, one for web and app:** `packages/shared/src/constants/glyphs.ts`.
No lucide, no Ionicons. Lint blocks both imports.

- **Line** is every icon. It sits on a 24×24 grid with a 3px margin, a 1.6
  stroke, round caps and joins, and no fills.
- **Solid** is the selected or active state only: the focused tab, a selected
  tile, a ticked box, a starred rating. It is fill-only with `evenodd`
  cut-outs. An icon with no solid drawing falls back to its line, drawn
  heavier.
- Colour comes from a theme token (`currentColor` on web), never a hex, so one
  drawing serves both themes.
- Render with `<Glyph name="…" variant="line|solid" />`. That is
  `apps/web/src/components/glyph.tsx` on web and
  `apps/mobile/src/components/ui/glyph.tsx` in the app. On web,
  `@/components/icons` also exports the old lucide names, for code that passes
  icons around as components.
- Names follow the Ionicons base names (`home`, `people`, `receipt`,
  `shield-checkmark`, `location`, `restaurant`, `build`, `warning`,
  `notifications`, `qr-code`, `bed`).
- To add an icon, draw it in `glyphs.ts`. Then check it beside the rest with
  `node --experimental-strip-types packages/shared/scripts/glyph-sheet.ts`,
  which renders `docs/mockups/icons/glyph-sheet.png`.
- Brand marks are not ours to redraw in our style. The Google button uses
  Google's own four-colour G.

---

## 3. Layout Per Portal

| Portal | Shell | Nav pattern |
|---|---|---|
| Public | Top nav + footer, full-width hero on home | Search bar prominent above the fold |
| Superadmin | Sidebar + top bar | Sidebar sections: Dashboard, Hostels, Verification, Subscriptions, Reports, Reviews, Providers, Announcements |
| Platform Moderator | Sidebar + top bar (fewer items than superadmin) | Dashboard, Hostels, Reviews, Providers, Reports |
| Hostel Admin/Warden | Sidebar + top bar (warden sees fewer sidebar items, permission-gated) | Dashboard, Profile, Rooms & Beds, Residents, Payments, Food, Notices, Complaints, Night Status, Maintenance |
| Resident (web) | Top nav with tabs or sidebar on desktop | Home, Payments, Food, Notices, Complaints, Profile |
| Resident (mobile - Phase 6) | Bottom tab nav | Home, Payments, Food, Notices, More |
| Guardian | Single-page simplified dashboard, no sidebar | Just the summary cards — simplest portal in the whole product |

---

## 4. Key Screens & Components (Build These as Shared Components)

### HostelCard
Used in: listing grid, comparison tray, search results

Fields:
- Photo (first from photos array)
- Name
- Price per bed (monthly)
- Gender-type badge (boys/girls/co-living)
- Verification badge (if verified)
- Star rating (average overall)
- Distance to college (if college filter active)

States:
- Default
- Hover (subtle shadow increase)
- Selected (for comparison - highlighted border)

### VerificationBadge
Small, consistent badge component (`shield-checkmark` glyph + label) used anywhere a hostel appears.

States:
- Verified (green bg, "Verified" text)
- Pending (yellow bg, "Pending Verification")
- Unverified (gray bg, "Unverified")

Never claim "Government Verified" — platform verification only.

### StatusBadge
Generic badge driven by the status-color mapping table above. Every status field in the product should render through this one component, not ad-hoc `<span>` colors.

Props:
- `status: string` (the raw status value)
- `type: 'payment' | 'complaint' | 'hostel' | 'nightStatus' | 'bed' | 'maintenance' | 'provider'`

Maps status to color automatically based on type.

### RoomBedMap
Visual floor → room → bed grid (source brief §7.2).

Layout:
- Floor selector (tabs or dropdown)
- Room cards in grid
- Each room shows bed tiles, color-coded by `BedStatus`:
  - Available: green
  - Occupied: gray
  - Reserved: yellow
  - Under Repair: red

Interactions:
- Click bed → shows resident info (if occupied) or "assign resident" action (if available)
- Drag-and-drop to reassign resident (Phase 5 enhancement, optional)

### PaymentSummaryCard
Used on: resident dashboard, guardian dashboard (stripped-down version)

Resident version shows:
- Month
- Amount due
- Amount paid
- Status badge
- Due date
- "Upload proof" button (if unpaid/partial)
- "View receipt" button (if paid)

Guardian version shows (if permitted):
- Month
- Amount due / paid
- Status badge
- "View receipt" link (if `accessPermissions.receipts = true`)
- NO upload proof button
- NO raw proof images

### NightStatusIndicator
A calm, single-word badge (Inside / Outside / Not Verified / SOS).

Styling:
- Inside: green, calm
- Outside: gray, neutral (NOT alarming)
- Not Verified: yellow, neutral
- SOS: red, pulsing animation, urgent

Explicitly NOT a map or timeline. Just the badge.

### ComplaintThread
Complaint + its `ComplaintUpdate` history, shown the same way in resident and hostel-admin portals (mirrored component, different permissions).

Layout:
- Original complaint at top (title, description, photo if any, timestamp, status badge)
- Updates in timeline below (admin messages + status changes)
- Input box at bottom for new update (admin only) or "mark as resolved" button (resident confirmation)

### InquiryForm
Short, 4 fields max: name, phone, email (optional), message (optional).

No login required. Submits to `/api/public/inquiries`.

Appears on every hostel detail page.

### NoticeFeed
Chronological list, filterable by `NoticeCategory`.

Used in:
- Hostel-admin portal (compose + list)
- Resident portal (read-only list)
- Guardian dashboard (if permitted, filtered to guardian-visible only)

Urgent notices have visual prominence (red accent, "Urgent" badge).

### MaintenanceRequestCard
Hostel-admin view of a request.

Shows:
- Category icon + name
- Description
- Urgency badge
- Status stepper (Pending → Contacted → Scheduled → Completed)
- Linked room/bed (if any)
- Linked provider (if any) with contact button
- Cost note (informational)

---

## 5. States Every List/Detail View Must Handle

### Loading
Use **skeleton** (not spinner) for cards/tables. shadcn/ui provides `Skeleton` component.

Example: `<Skeleton className="h-20 w-full" />`

Repeat for expected number of items.

### Empty
Short, helpful copy — never just a blank white area.

Examples:
- "No complaints yet — nice!" (resident complaints list)
- "No residents registered. Add your first resident!" (hostel admin residents list)
- "No inquiries yet. Share your hostel link to get started." (hostel admin inquiries)

Include relevant CTA button.

### Error
Show error message + "Retry" button, not just a red toast that disappears.

Use shadcn/ui `Alert` component with destructive variant.

### Populated
The actual data, paginated if list exceeds pageSize.

---

## 6. Accessibility

**Interactive Elements:**
- All keyboard-navigable (shadcn/ui/Radix gives this by default — don't override focus outlines)
- Minimum tap target 44x44px on mobile web for all buttons/icons

**Color:**
- Color is never the only signal for status — every `StatusBadge` also carries a text label, not just a color dot
- Contrast meets WCAG AA (4.5:1 for body text, 3:1 for large text)

**Forms:**
- Label every field (use shadcn/ui `Form` + `FormField` components)
- Show inline validation errors from the shared Zod schemas (RULES.md/CODING_STANDARDS.md), not just a toast
- Error messages in red, below the field

**Images:**
- Alt text on every image (hostel photos, food photos, profile pictures)
- Decorative images use empty alt (`alt=""`) so screen readers skip them

**Focus Management:**
- When modal opens, focus goes to first interactive element
- When modal closes, focus returns to trigger element
- Tab order is logical (top to bottom, left to right)

---

## 7. Responsive Breakpoints

Use Tailwind defaults:
- `sm`: 640px
- `md`: 768px
- `lg`: 1024px
- `xl`: 1280px
- `2xl`: 1536px

**Design mobile-first:**
- Base styles = mobile (375px width)
- Add `md:`/`lg:` overrides for larger screens
- Don't design desktop-first and try to squeeze it into mobile — won't work

**Critical breakpoints for this app:**
- **375px (mobile)**: Public discovery, resident dashboard, guardian dashboard
- **768px (tablet)**: Hostel admin portal switches from bottom nav to sidebar
- **1024px (desktop)**: Full sidebar + content layout for all admin portals

---

## 8. Animation & Transitions

**Use sparingly:**
- Subtle transitions on hover (shadow, border color) — 150ms duration
- **Page arrival** — the portal shell fades each new page up 6px over 240ms
  (`.animate-page-in`, keyed by pathname). Switching sidebar sections fades the
  panel list the same way.
- Modal/dialog — fade and zoom from 95% over 200ms, on a dimmed, blurred backdrop
- Accordions open to their own height (grid rows 0fr → 1fr), 200ms
- Clickable stat tiles lift 2px on hover
- Status badge changes (e.g., payment verified) — subtle scale pulse once, 300ms
- Every animation sits behind `prefers-reduced-motion`

**Don't animate:**
- Sliding whole pages sideways (arrival is a fade, not travel)
- Data loading (use skeleton, not spinner animation)

**Press** — buttons (web and app), tiles, cards and rows shrink under the
finger on a spring (web `scale-[0.97]`; app `PressableScale`, 0.96, rows
0.985) instead of dimming.

**App** (`apps/mobile/src/constants/motion.ts` holds every duration and
spring; all of them honour the phone's reduce-motion setting):
- A screen's body mounts one frame after its header and rises 10px once, with
  no fade of its own — the navigator already fades the screen. The frame's delay
  is what lets a push start on the tap instead of after the body's first render.
  Refreshes and tab switches don't replay it.
- No scroll-linked colour on the public Home: its header stays green and the
  shortcut tiles scroll like content. A header that faded to the page colour
  read as washed out on a device, and was taken back out.
- The tab bar's tinted pill slides to the tapped tab; the icon pops in solid.
- Skeletons sweep a light band across instead of pulsing.
- Large and display `Money` counts up from zero the first time it has a value.
- A `large` `AppBar` title shrinks to bar size over the first 48dp of scroll
  and a hairline fades in under the bar. It reads the page offset from
  `Screen` (`useScreenScroll`), fed by the same handler as the tab bar.
- Lists are `<Stagger>` (`ui/layout.tsx`) instead of `<View className="gap-3">`:
  the first 8 rows rise in 45ms apart on first fill, a row leaving fades while
  the rest slide up. Mounted rows don't replay on refresh. Never on a
  `FlatList`, whose cells mount mid-scroll.
- A card can grow into the next screen's header: `growFrom(view, radius, go)`
  from `components/card-grow.tsx` (or `ActionCell grow`), landing on the next
  accented `AppBar`. Only for doors into screens with an accented bar.
- Theme changes go through `crossFadeTheme(apply)` (`components/theme-fade.tsx`):
  the old frame is snapshotted, the theme swaps underneath, the snapshot fades.
- **Haptics are for serious actions only:** a `danger` button, the confirm in
  `openConfirm`, a swipe action firing. Never tab switches, scrolls,
  transitions, theme changes or plain taps.

What is still open (swipeable segment pages, the hide-amount morph, web) is
tracked in `docs/MOTION_AND_ICONS.md` (Track M).

**SOS alert exception:**
- SOS status badge pulses continuously (red glow) to draw attention
- This is the ONLY continuously animated element in the app

---

## 9. Dark Mode (built)

- **Shipped, not deferred.** `globals.css` declares `@custom-variant dark
  (&:is(.dark *))` and a full `.dark` token override — every token above has a
  dark counterpart.
- Style against tokens (`bg-background`, `text-foreground`, `border-border`) and
  dark mode follows for free. Reach for a raw hex and it does not.
- This is the practical reason the "no hardcoded colours" rule in §10 matters:
  each hex literal is a spot that silently stays light-mode.

---

## 10. What Not To Do

**Don't:**
- Build a custom date picker, custom dropdown, or custom modal — shadcn/ui already has these
- Import an icon library (lucide, Ionicons, any other). Draw the glyph in `glyphs.ts`
- Use absolute positioning for layout (use Flexbox/Grid)
- Hardcode colors (use Tailwind tokens)
- Mix font families (one variable font for the entire app)
- Animate everything (subtle is better)
- Use `<div>` for buttons (use `<button>` for semantics)
- Skip focus states (accessibility requirement)
- Build mobile views as an afterthought (mobile-first)

**Do:**
- Reuse shadcn/ui components
- Keep spacing consistent (Tailwind scale)
- Use semantic HTML (`<button>`, `<nav>`, `<main>`, `<header>`, `<footer>`)
- Test on real mobile devices (not just browser DevTools)
- Design forms to be forgiving (auto-format phone numbers, trim whitespace, etc.)
- Show helpful error messages ("Email is required" not just "Invalid")
- Make CTAs obvious (primary button styling, clear labels)
- Keep the guardian dashboard extremely simple (one page, minimal UI)

---

_End of DESIGN.md_
