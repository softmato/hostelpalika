# Inventory (Stock) — plan

**Created 2026-10-05.** An owner with a main hostel and branches buys rice, daal,
oil and utensils in bulk and vegetables daily, then splits them between buildings
by hand. Nobody can say afterwards how much went where. This feature records the
three moments goods physically move — and never the cooking.

This file is the tracker. Work at the first unticked box; `[x]` means *seen
working*, not *file created*. **[server]** `apps/web` API, **[app]** `apps/mobile`
(native + PWA), **[web]** Next.js hostel-admin page, **[device]** a real handset.

---

## 1. Decisions already made

| Question | Decision |
|---|---|
| What is recorded | **Bought** (goods arrived), **Send** (carried to another building), **Count** (what is left). Daily use is never recorded — it is worked out at each Count. |
| Two kinds of item | **Store** (long use: rice, daal, oil, gas, utensils) keeps a *Left* and is counted. **Daily** (vegetables, meat, milk) is used the same day: no *Left*, no Count. |
| Where goods land | Wherever they arrive. Defaults to the main hostel; whoever records it picks the building. No separate godown. |
| A Send counts when | The receiving building taps **Got it** (or types what actually came). Until then it is *on the way*. The owner can confirm for a branch with no warden. |
| Money | A Bought with an amount writes **one Expense** in the hostel the recorder is working in — the same row Money Out shows. Sending never moves money between branches; Overall shows the whole group. |
| Who | Owner: the building picked in the switcher (every building only in Overall, read-only). Warden: only with the new `manageStock` permission, only their building, but can Send to any building in the group. Cook: not in this round. |
| Plan | Listed as **Inventory Management** under Food & Kitchen on **Max**. Not gated on the server — no other plan service is. |
| Look | The Finance screen: accent header, sections of tinted icon rows, badges, values on the right. Bottom sheets, skeletons, dates grouped with the heading outside the card. |

## 2. Words (A1 English)

Use: **Stock · Bought · Send · Got it · Count · Left · On the way · Used · Short**.
Never: inventory ledger, transfer, reconcile, consumption, variance.

## 3. Data

- `StockItem` — per group (main hostel id): name, unit, kind (`STORE`/`DAILY`),
  `lowAt`, `active`. Shared by the main hostel and every branch.
- `StockEntry` — one per tap of Save: kind (`BUY`/`SEND`/`COUNT`), building,
  `toHostelId` (Send), BS day, `lines[{ itemId, name, unit, qty, receivedQty }]`,
  status (`DONE`/`PENDING`/`RECEIVED`/`CANCELLED`), optional `expenseId`.
  Never deleted — cancelled with a reason; cancelling a Bought voids its expense.
- **Balances are derived, never stored** (same rule as the warden cash box):
  per item per building, fold the entries in time order — Bought +, Send out −,
  Got it +received, Count sets it. *Used* is what a Count found missing.

## 4. Tracker

**2026-10-05:** every Server, App and Web item below is code-complete, typechecked,
linted, and the web (3,272) and app (1,509) suites pass. None has been *seen
working* against a database or on a device yet, so only the unit test is ticked;
the rest tick after the device pass in "After shipping".

### Server
- [ ] Shared units/kinds in `packages/shared/src/expenses/stock.ts` (already aliased into Metro)
- [ ] `StockItem` + `StockEntry` models, indexes
- [ ] `manageStock` warden permission (validation, web + app warden forms)
- [ ] `stock.service.ts`: home read, add/edit item, entry (Bought/Send/Count), Got it, cancel
- [ ] Routes under `/api/v1/hostel-admin/stock`
- [ ] Notifications: Send → receiving building; Got it → sender
- [x] Unit test for the balance fold (`stock-balance.test.ts`, 5 cases)
- [ ] Plan service `inventory-management` (Max) + explainer

### App
- [ ] `lib/stock-api.ts`
- [ ] `/stock` home — Finance look: summary card, waiting for Got it, Store items, Daily items, this month's entries by date
- [ ] Item sheet — per building: left, counted on, used this month, per resident
- [ ] `/stock/entry?kind=buy|send|count` — one screen, item list with quantity inputs
- [ ] Manage grid tile + More row

### Web
- [ ] `/hostel-admin/stock` page + nav entry

### After shipping
- [ ] `npm run db:indexes -w apps/web` against prod (StockEntry's unique `clientRequestId` index is what makes a retried Save safe)
- [ ] Superadmin adds the *Inventory Management* service in Website Config → Plans (the stored catalogue replaces the defaults)
- [ ] Owner turns on **Stock** for each existing warden (only new wardens get it by default)
- [ ] [device] Bought → Send → Got it → Count on two buildings

## 5. Later (not built, on purpose)

Pack sizes (1 sack = 25 kg) · cook sees stock / "Running low" · low-stock push ·
month-end Count reminder · a delivered Supply Store order adds itself as Bought.
