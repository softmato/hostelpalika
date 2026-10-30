# Field notes — 2026-10-28 (owner's paper list + transition video)

Mobile admin fixes from the handwritten list and the screen-recording of the
push/back bug. Order is the order they were done.

## Transitions
- ☑ Push showed a green header block with no title, then the title a beat later — `card-grow` (tile copy → AppBar hidden until it landed). Removed: `components/card-grow.tsx`, AppBar claim, `ActionCell grow`.
- ☑ Back showed both screens half-transparent — root + store stacks were `fade` (crossfade). Now `fade_from_bottom`.

## Resident screen (`manage/resident/[id]`)
- ☑ "No room yet — pick one" for a resident in a room: `roomLine(resident)` read `.number`; the record has `roomNumber`.
- ☑ Monthly fee shows the amount (own rate, else the open rate card for their room type) instead of "On the fee schedule".
- ☑ Details on the screen — the See details sheet is gone, its sections are inline.
- ☑ Payment history, month by month, heading outside the card.

## Finance settings
- ☑ Move-out & days away / Opening balance: own icons, each opens only its own section (`money-rules?section=leaving|opening`).
- ☑ Opening balance once set: shows amount + date + Edit → sheet.
- ☑ "How bills work" row removed. Billing: "How to leave" card removed.
- ☑ Tab renamed Finance → Payments. Home Manage: Residents tile removed (it is a tab).

## Expenses
- ☑ Month switch no longer blanks to skeletons; previous month prefetched.
- ☑ Swipe the month card: one swipe = one month.

## Downloads + reports
- ☑ `DownloadSheet` (1 · 3 · 6 months · 1 year · All · Custom N; PDF/CSV) on Statement, Reports, Stock report.
- ☑ Server: report export accepts 0–24 months (was 0/1/3/6/12) so Custom works for CSV.
- ☑ Stock report summary redrawn (one label size, one value size, usage bar + legend); Reports hero figures down from 3xl.

## Stock
- ☑ Item screen: Use / Buy / Send / Stock check are icon tiles, not text buttons.
- ☑ Send: each building says Main hostel / Branch and its area, city (server now sends `location`).

## Empty states
- ☑ Every `EmptyCard` draws vector art, glyph read from its title (`glyphFor`), override with `icon`.
- ☑ Art idles (bob + breathing rings) on the UI thread; off under reduce-motion.

## Referrals
- ☑ Top of Referrals: hostel invite with QR of the registration link, code, Share / WhatsApp / Copy, and what both hostels get. Shared with Invite hostels (`HostelInviteCard`).

## Second round (videos 9:10 / 9:12)
- ☑ Header jumped a few points on every open and went see-through on back — that was `fade_from_bottom` moving the whole screen. Root + store stacks stay `fade_from_bottom` (slide up + fade in), the motion the owner chose.
- ☑ Statement and Notifications blank for a second on every open — the cache hit, but every row was built in one render. `useFirstRows` paints the first 12, the rest 300 ms later.
- ☑ Referrals white for 2–3 s — the new QR drew ~400 SVG `<Rect>`s; now one `<Path>`. Invite query warmed on touch-down too.
- ☑ Bookings (and every compact empty state) now draw the animated art, not a small disc.
- ☑ Collect-cash sheet: no grey box, rent line without the repeated "Monthly rent — Kartik 2083 BS", one "To collect" figure until something is paid, actions in one row, collector as a plain line, note as a link.

## Third round (video 9:44)
- ☑ Every green header went white for two frames at the end of each open and the start of each back (Android runs its own 350 ms `fade_from_bottom` and ignores `animationDuration`). It was only the green that dropped, so the white title vanished with it. A wrapper alone did not fix it (video 10:19). The only screens that never blank, Billing and Stock, both have an `elevation: 8` card overlapping the bar, so `AppBar` now carries an invisible elevated strip (`Z_ANCHOR`, no background, no shadow) over its bottom edge.

## Still to do
- ☐ Device pass on the Redmi (needs a JS reload; Send's location and Custom-month CSV need the web deploy).
