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

## Still to do
- ☐ Device pass on the Redmi (needs a JS reload; Send's location and Custom-month CSV need the web deploy).
