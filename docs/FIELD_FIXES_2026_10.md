# Field fixes — October 2026

What hostels ran into once they used the app every day. One item at a time:
code → check → tick.

Markers: ☐ not started · ◐ partly done (note says what is left) · ☑ done and checked.

## 0. Live data everywhere

- ☑ **0.1** Every signed-in write to hostel data tells the hostel's open screens (web +
  app) to refresh — one hook in `requireApiPrincipal`, not a publish call per service.
- ☑ **0.2** Web dashboard actually refreshes: topics pointed at `/hostel-admin/dashboard*`,
  which does not exist; the dashboard reads `/hostel-admin/reports/*`.
- ☑ **0.3** App knows the `bookings` topic.

## 1. Moving out (items 3 + 8)

Root cause found: `Resident.moveOutDate` was never in the schema, so no move-out ever
recorded a date and the leaving month was never worked out.

- ☑ **1.1** `moveOutDate` + `lastMonthCharge` on the resident.
- ☑ **1.2** (app: Finance → Move-out & days away) Hostel default: last month on move-out = **Full month** or **Till the day**.
- ☑ **1.3** Move-out preview: what they owe, this month's bill under each choice.
- ☑ **1.4** Move-out does the money: this month's bill cut to the day (or kept full),
  later months' unpaid bills cancelled, and unpaid dues **written off** (default) or
  **kept as owed**. Written-off money leaves every total — dashboard, Money, Overall.
- ☑ **1.5** Already moved out with unpaid bills → **Write off** on their page.
- ☑ **1.6** App + web move-out sheet.

## 2. Fee at registration (item 4)

- ☑ **2.1** Intake takes a fee with a reason: Short stay / Relative / Other (typed).
  Stored on `Resident.monthlyFee` + reason, so every bill (first month too) uses it and
  the rate card never charges them. Audited.
- ☑ **2.2** App intake: Edit on the rent row.
- ☑ **2.3** Web intake: same.
- ☑ **2.4** Every charge editable per resident (2026-10-12): rent, admission fee, form fee,
  security deposit, under one reason. Only changed figures are sent; an edited joining line
  is `MANUAL` and carries the reason in its description; one finance audit row per changed
  charge (`RESIDENT_ADMISSION_FEE_SET` / `_FORM_FEE_SET` / `_DEPOSIT_SET`). Quote returns
  `standard` (rate-card figures). Web: "Charges" block; app: "Their charges" sheet. Fixed on
  the way: the web form's Deposit box was saved on the resident but never invoiced.

## 3. Floors and room numbers (items 6 + room tracking)

- ☑ **3.1** `HostelRoom` (floor, number, room type, beds). Free beds = beds − residents in it.
- ☑ **3.2** Resident carries floor + room number; intake, room change and the scan desk
  check the room is this type and has a free bed.
- ☑ **3.3** App Rooms: floors with their rooms; add "101–105, Double" in one go.
- ☑ **3.4** App intake + change room: pick floor → room.
- ☑ **3.5** Web rooms + intake.
- ◐ **3.6** Bookings: the room is picked when the guest is checked in (the intake asks floor → room like any other). Holding a numbered room at *confirm* time is not built — it needs held bookings counted against a room's free beds.
- ☑ **3.7** **Floor & room tracking** switch, on by default. Off = room type only, as
  before. On = every resident is in a floor + room (residents without one are listed
  to assign; intake asks for the room once any room exists).
- ☑ **3.8** **Room change requests**: a resident picks a free bed in another room
  (same or other floor) and sends it; a warden confirms or declines; only a confirmed
  request moves them. Staff can still move someone directly.
- ☑ **3.9** Residents enrolled before the switch (2026-10-12): they land in **No room yet**.
  Told about it on app Home ("Pick their rooms" row, with room requests) and on the web
  Residents page (banner → Rooms). Placed from Rooms → No room yet (app + web), the
  resident's own page → Floor & room (app), or the new Floor & room select on the web
  resident panel. Any room type may be picked; a different type moves their bed and rent.
- ☑ **3.10** Room asked on **every** add path (2026-10-12), not only new intake:
  - Existing-residents list: `roomNumber` on each line (`ExistingResidentList.rows`). With
    Floor & room on and rooms set up, the check needs it on every line — room exists, fits the
    room type (a room no. alone sets the type), free beds counted across the list. The add puts
    them straight into that room. Web: "Room no." sheet column (last, so old pastes still line
    up; hidden when off) + Room column in the list; Excel template gets a "Room no." column
    only for hostels that number rooms. App: "Which room" floor → room picker in Add one / Edit.
  - Join requests: staff pick the room before Add (web select on the card; app opens floor →
    room first). The resident's own request never asks — the hostel decides the room.
  - App "Add as existing resident" toggle: room sent with the add, checked before anyone is
    added (was set afterwards).

## 4. Opening balance (item 2)

- ☑ **4.1** Hostel's bank closing amount + date, saved once (editable).
- ☑ **4.2** Statement starts from it (app + web), so the app's balance matches the bank.

## 5. KYC catches up (items 2 + 6)

- ☑ **5.1** Two new KYC steps: **Rooms & floors**, **Opening balance**. Hostels already
  at 100% see the banner again until they fill them.
- ☑ **5.2** App + web KYC screens.

## 6. No ID card (item 5)

- ☑ **6.1** "No card" form: name, email, phone → room, fee. Same bills, mail and account
  work as a card scan.
- ☑ **6.2** If they have no account yet, signing in later with that Gmail opens the
  resident portal straight away (desk-typed email, person was present).

## 7. Bookings on app Home (item 7)

- ☑ **7.1** Hostels that take bookings get a Bookings tile with the waiting count.

## 8. Team: part payment on lifetime (item 1)

- ☑ **8.1** Team step 7: lifetime can be paid in part (online or cash); the rest shows as
  due on My desk with its Pay button.

## 9. Days away (item 9)

- ☑ **9.1** Hostel setting: what a resident gets off for days away — food only (Rs/day)
  or full day's rent — and the fewest days that count.
- ☑ **9.2** Staff add days away on the resident; the money comes off that month's bill
  (or next bill if it is paid).
- ☑ **9.3** App + web. (app: resident page → Days away, Finance → Move-out & days away; web: Fee schedule → Money rules, resident panel → Days away)

## Session log

| Date | Done |
|---|---|
| 2026-10-11 | All of §0–§9 except 3.6 (room picked at check-in, not at confirm). Web 3,339 + mobile 1,535 tests green, both typecheck clean. Nothing run against a live DB (local `.env` is prod Atlas). |

## Before it goes live

1. `npm --prefix apps/web run db:indexes` — new: `HostelRoom` (unique number per hostel), `RoomChangeRequest` (one open per resident), `ResidentLeave`, `Resident.roomId`.
2. Web deploy first: the app's Rooms, Money rules, Days away, My room and the move-out sheet all call new routes.
3. App: JS only (OTA-able) — new screens `manage/floors`, `manage/finance/money-rules`, `my-room`; no native change.
4. Every hostel's KYC drops below 100% (two new steps) and the banner comes back — on purpose.
5. Device pass: intake with a room + special fee, a move-out both ways with a write-off, a room request → confirm, days away on a billed month.

## Decisions taken while the owner was away (say if any is wrong)

- **Write off is the move-out default** for anything unpaid; "Keep as owed" is one tap. Old app builds (no `dues` sent) keep the debt, as their sheet promises.
- Unpaid bills **with nothing paid are cancelled**; part-paid ones are cut to what was paid. Paid-ahead later months become the resident's credit.
- **Special fee at intake** is allowed for anyone who may register residents, but needs a reason and is on the finance audit trail.
- **Floor & room is on by default.** Until a hostel has any rooms, intake does not ask for one; after that the app and web require it. Existing residents show under "No room yet".
- A room change to a **different room type changes their rent** from the next bill (rent follows the type).
- **Days away**: one entry stays inside one BS month; "Full day" needs that month's bill to exist (the day's rent is that bill's own rent ÷ its days). Food-only can be entered ahead.
- **Lifetime part payment**: the plan becomes lifetime only when the whole price is paid; until then the hostel is live with the rest due (the existing team "Pay Rs …" button on My desk collects it).
