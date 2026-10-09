# Inventory (Stock) — plan

**Created 2026-10-05. Rebuilt as a stock ledger 2026-10-09.** A hostel buys rice,
daal, oil, gas and cleaning goods in bulk and vegetables daily, from a handful of
shops, often on credit. The owner needs to answer four questions at any time:
*what is in the store, what is it worth, where did it go, and who do we owe.*

This file is the tracker. Work at the first unticked box; `[x]` means *seen
working*, not *file created*. **[server]** `apps/web` API, **[app]** `apps/mobile`
(native + PWA), **[web]** Next.js hostel-admin page, **[device]** a real handset.

---

## 1. Decisions already made

| Question | Decision |
|---|---|
| The model | **A ledger, not a quantity field.** Every change is a movement row; what is left is their sum. Nothing is edited — a mistake is cancelled with a reason and stays in History. |
| Movements | **In:** Bought (a bill), Opening stock. **Out:** Used (for Kitchen / Staff / Student / Other), Wasted (Spoiled / Expired / Damaged / Other), Send to another building. **Adjust:** an approved Count — what was found minus what the book said at that moment. |
| Two kinds of item | **Store** (rice, daal, oil, gas, cleaning) is used, wasted and counted. **Daily** (vegetables, meat, milk) is used the day it comes: no Left, no Use entry, no Count. |
| A bill | One row: supplier, bill no., date, photo, lines (qty + price), discount, VAT, total, paid. Saving it is one write, so the stock and the supplier's due never disagree. |
| Money | What was **paid** on a bill writes one Expense (Money Out). The rest is **owed to the supplier**. Each later payment to a supplier writes its own Expense. Cancelling a bill or payment voids its expense. Money Out is cash that left; the supplier ledger is what is still owed. |
| Supplier balance | `opening due + Σ(bill total − paid on bill) − Σ payments`. Derived on every read, never stored. Running balance per supplier, newest first. |
| Cost | **Weighted average**, per item across the group. Only a priced Bought or Opening moves it. Every movement out is valued at the average *at that moment*. |
| Packs | An item may have one pack: `1 sack = 25 kg`. Stock is always kept in the item's own unit; a line typed in packs is multiplied out on Save and remembers it was `2 sacks`. |
| Counts | Shows `Book says 40 kg · 2 kg missing` as you type. A different count needs a reason. The owner's count (or a warden with **Approve stock counts**) corrects the book at once; anyone else's waits for approval and the approver gets a push. |
| Low stock | A push to the owner and the building's stock wardens the moment an item **crosses** below its low mark — not on every Use after. |
| Who | **Storekeeper** — a warden with `manageStock`: Buy, Use, Waste, Send, Count, add items and suppliers. **Cook** — *Kitchen stock* in the cook app: Used or thrown away, for its own building, same-day Undo, never a price; on unless the owner turns it off (`cookCanUseStock`). **Money** — owner, or a warden with Add expenses: sees prices, values and dues; pays suppliers. **Approver** — owner, or a warden with `approveStockCount`. A storekeeper without money rights never sees a price. |
| The kitchen | **Decided 2026-10-09 (option B):** no "kitchen holds it" stock. The cook enters what it took straight from its building's store, and that is the Used. Every movement records who entered it (`recordedRole`: OWNER / WARDEN / COOK). |
| Usage | The warden's question — *how much went today, this week, this month* — is the **Used** screen (`/stock/usage`, `GET /hostel-admin/stock/usage?range=today|week|month`): per item, per building, per day, with the kitchen's share and what was thrown away. Daily items count as used the day they came. A *Used today* card sits on the Stock home. |
| Where | Items and suppliers belong to the **group** (main hostel + branches). Movements belong to a building; the switcher picks it. Overall reads every building and writes nothing. |
| Balances | Folded from movements on every read (`stock-balance.ts`), the warden cash box's rule — so they can always be rebuilt. The fold is in memory; past ~20k entries per group, move it into a Mongo aggregation. |
| Look | Black, white, green. Home: a green header with **Stock value · Items · Running low** on a card straddling it; one grid of job tiles (**Use · Buy · Waste · Count · Send · Suppliers · Reports · Opening**); then what is waiting, then running low, then everything grouped by category with the heading outside the card. Use is built to take five seconds: most-used items are tiles, a tap focuses the box, `+1 / +5 / +1 sack` do the typing. |

## 2. Words (A1 English)

Use: **Stock · Buy · Bill · Use · Waste · Count · Send · Got it · Left · Supplier · Owed · Paid · Part paid · Not paid · Running low · Missing · Extra**.
Never: inventory ledger, issue, transfer, reconcile, consumption, variance, payable.

## 3. Data

- `StockItem` — per group: name, unit, kind (`STORE`/`DAILY`), category (Money Out
  group), `packUnit` + `packSize`, `location`, `lowAt`, `active`.
- `StockSupplier` — per group: name, phone, `openingDue`, note, `active`.
- `StockEntry` — one per Save: kind (`BUY`/`OPENING`/`USE`/`WASTE`/`SEND`/`COUNT`),
  building, `toHostelId` (Send), BS day, `lines[{ itemId, name, unit, qty, rate,
  packQty, packUnit, systemQty (Count), receivedQty (Send) }]`, bill fields
  (`supplierId`, `billNo`, `photoAssetId`, `discount`, `tax`, `total`, `paid`,
  `expenseId`), `useFor`, `wasteReason`, status (`DONE`/`PENDING`/`RECEIVED`/
  `CANCELLED`), approval and cancel trail, `clientRequestId`.
- `StockPayment` — per group: supplier, building paid from, amount, day, paid by,
  note, `expenseId`, status, `clientRequestId`.
- Old Bought rows (only `amount`) read as fully paid; old Counts (no `systemQty`)
  set the Left at their time, as before.

## 4. Tracker

**2026-10-09:** the ledger rebuild and the kitchen/usage pass are code-complete,
typechecked and linted on server, app and web; the fold, supplier-ledger and
usage unit tests pass (10 cases).
Nothing below has been *seen working* against a database or on a device yet.

### Phase 1 — the ledger (built)
- [x] Fold: opening → in → out → closing, used / wasted / adjusted, weighted average cost (`stock-balance.test.ts`)
- [x] Supplier running balance (`stock-balance.test.ts`)
- [ ] [server] Bills with supplier, discount, VAT, paid; paid part → one Expense; rest owed
- [ ] [server] Use / Waste; Opening stock (owner); Count with book figure, reason, approval
- [ ] [server] Suppliers: add, edit, ledger read; payments + cancel (each an Expense)
- [ ] [server] Low-stock push on crossing; Count-to-approve push; approved / turned down push
- [ ] [server] `approveStockCount` warden permission (validation, web + app warden forms)
- [ ] [app] Home (value card, job tiles, waiting, running low, by category)
- [ ] [app] `/stock/use` (Use + Waste), `/stock/buy` (bill + Opening), `/stock/count`
- [ ] [app] `/stock/suppliers`, `/stock/supplier/[id]` (ledger, Pay, edit, cancel payment)
- [ ] [app] `/stock/reports` (cost per student per day, spent from store, by category, by supplier, item ledger, share as CSV)
- [ ] [app] Entry details: bill money and photo, Count book vs shelf, Approve / Turn down
- [ ] [web] Stock page: all movements, bill form, counts to approve, suppliers + Pay, value columns, CSV export

### Phase 1b — the kitchen and usage (built 2026-10-09)
- [x] Usage per day / item / building with the kitchen's share (`usageRows`, `stock-balance.test.ts`)
- [ ] [server] Cook stock access (`/cook/stock`, undo same day), `cookCanUseStock` switch, `recordedRole`, `/stock/usage`
- [ ] [app] Cook: *Kitchen stock* (tiles → one sheet → Used), Today list with Undo; row on Today and More
- [ ] [app] Owner switch on `manage/cook`; warden/owner **Used** screen (Today · This week · This month, by item and by day); *Used today* card on Stock home
- [ ] [web] *Used* table on the stock page (Today · 7 days · This month, per building, by kitchen, thrown away)
- [ ] [device] Cook taps Rice 5 kg on a shared kitchen phone → warden sees it on Used today → cook undoes → it is gone

### After shipping
- [ ] `npm run db:indexes -w apps/web` against prod — `StockPayment`'s unique `clientRequestId` index is what makes a retried Pay safe
- [ ] Owner gives **Approve stock counts** to a senior warden where they want one
- [ ] [device] Buy on credit → Use → Count (warden) → Approve (owner) → Pay supplier → Reports

### Phase 2 — needs Phase 1 seen working first
- Return to supplier (goods out, supplier owed less)
- Returnable items (water jars): full and empty tracked apart, deposit held by the vendor
- Edit a bill's prices after the storekeeper saved it without them
- PDF export of the reports; Excel file rather than CSV
- Month-end Count reminder push

### Phase 3 — needs Phase 2 and real usage numbers
- Expected use from meals (students present × per-head norm) against what was used, flagging the gap
- Expiry and batches (would move valuation to FIFO for those items)
- Purchase orders and requisitions
- Bill OCR
- Multi-hostel dashboard across separate groups
