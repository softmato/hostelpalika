# Finance & Payments — Current Implementation (extracted from code)

> **Purpose of this document.** A complete, code-verified extraction of everything
> money-related in this codebase as of 2026-08-06, on branch `main`. It is written
> as a handoff for a second assistant who will research industry-standard practice
> and propose a better design. Nothing here is aspirational — every claim below
> was read out of the source files cited. Where a doc in `docs/` disagrees with the
> code, the code is treated as truth and the drift is flagged.
>
> **One-line summary of the current state:** this is a *manual, human-verified,
> screenshot-based fee ledger*, not a payment system. No money moves through the
> software. There is no payment gateway, no double-entry ledger, no immutable
> transaction record, no reconciliation, and no reversal path. The `Payment`
> document is simultaneously the invoice, the ledger, and the balance — and it is
> freely mutable by any hostel staff member with one capability flag.

---

## 1. Domain vocabulary (what the code actually means by each word)

| Term in code | What it really is | Not what it sounds like |
|---|---|---|
| `Payment` | One resident's fee obligation for one calendar month. Carries both the amount owed *and* the running amount settled. | Not a transaction. Not a payment event. It is a mutable invoice-with-balance. |
| `PaymentProof` | A resident-uploaded screenshot/PDF claiming they paid, plus a self-declared amount and method. | Not a verified receipt of funds. Entirely resident-asserted. |
| `Receipt` | An acknowledgement issued *after* a hostel admin approves a proof. Sequential number, unique index. | Not a tax invoice. Has no line items, no tax fields, no hostel identity. |
| `DepositRecord` | A security-deposit model that exists in the schema. | **Dead code — never written to by any code path.** |
| `DepositRefund` | Deposit decision captured at move-out. | Written exactly once, from the move-out checklist. Never reconciled against a `DepositRecord`. |
| "Transactions" (UI) | A *view* over `Payment` rows re-labelled as `SETTLED` / `PARTIAL` / `OUTSTANDING`. | **There is no transaction collection.** The word "ledger" in the UI code is decorative. |
| "Fee Plans" (UI) | Hostel side: room-type rents derived on the fly from room config + payments. Platform side: marketing pricing tiers from site-config. | Neither is a billing plan. Nothing subscribes to them, nothing is charged from them. |

---

## 2. Data model — the complete finance schema

All models are Mongoose, in `packages/db/src/models/`.

### 2.1 `Payment` — [Payment.ts](packages/db/src/models/Payment.ts)

```
hostelId      ObjectId → Hostel     (required)
residentId    ObjectId → Resident   (required)
month         String "YYYY-MM"      (required)
dueAmount     Number ≥ 0            (required)
paidAmount    Number ≥ 0            (default 0)
dueDate       Date                  (required)
paidDate      Date
status        UNPAID | PAID | PARTIAL | OVERDUE | PENDING_PROOF   (default UNPAID)
paymentMethod CASH | ESEWA | KHALTI | FONEPAY | BANK_TRANSFER | OTHER
remarks       String
createdBy / updatedBy  ObjectId → User
timestamps: true
```

Indexes: `{hostelId, residentId, month}` **unique** (this is the only thing
preventing double-billing), `{hostelId, status}`, `{hostelId, dueDate}`,
`{residentId, status}`.

**Critical properties:**
- `paidAmount` is a *mutable running total*, not a sum of anything. There is no
  child collection of payment events that it is derived from. If it is wrong,
  nothing can detect that.
- No currency field anywhere. NPR is hardcoded in the UI formatter only.
- No `version` / optimistic-lock field. Concurrency is handled ad hoc (see §5.3).
- No soft-delete, no `isDeleted`. Records can be mutated but the prior value is
  only recoverable from the `AuditLog` metadata, which stores *some* transitions.

### 2.2 `PaymentProof` — [PaymentProof.ts](packages/db/src/models/PaymentProof.ts)

```
hostelId, residentId, paymentId   ObjectId (all required)
proofImageAssetId  String (required)   ← plain string, NOT a ref to FileAsset
amount             Number ≥ 0 (required)  ← what the RESIDENT claims to have paid
paymentMethod      CASH | ESEWA | KHALTI | FONEPAY | BANK_TRANSFER | OTHER
referenceNote      String   (free text)
transactionCode    String   (free text, never validated against anything)
submittedAt / submittedBy
reviewedAt / reviewedBy
status             PENDING | APPROVED | REJECTED  (default PENDING)
rejectionReason    String
```

Indexes: `{hostelId, residentId, status}`, `{hostelId, paymentId, status}`,
`{paymentId, submittedAt:-1}`. **No uniqueness constraint of any kind** — a
resident may submit unlimited proofs against the same payment.

### 2.3 `Receipt` — [Receipt.ts](packages/db/src/models/Receipt.ts)

```
hostelId, residentId, paymentId  (required)
receiptNumber  String (required, UNIQUE index)
issuedAt / issuedBy
amount   Number ≥ 0
month    String
timestamps: { createdAt: true, updatedAt: false }
```

`updatedAt` is deliberately disabled — yet the amount **is** updated in place
(see §5.5), so a mutated receipt leaves no timestamp trail.

### 2.4 `DepositRecord` — [DepositRecord.ts](packages/db/src/models/DepositRecord.ts)

```
hostelId, residentId, amount, paidDate
status: HELD | REFUNDED | FORFEITED
refundedDate, refundedAmount, remarks
```

**Verified dead.** `grep -rn "DepositRecordModel" apps/web/src` returns zero
hits. Security deposits are never recorded at move-in. The resident payments UI
nonetheless shows a "Deposit Status: Tracked" metric card
([resident-payments-page.tsx:182-188](apps/web/src/app/_components/resident-payments-page.tsx:182))
— that value is a hardcoded string, backed by nothing.

### 2.5 `DepositRefund` — [DepositRefund.ts](packages/db/src/models/DepositRefund.ts)

```
hostelId, residentId, moveOutChecklistId
amount    Number ≥ 0 (default 0)
decision  PENDING | APPROVED | PARTIAL | FORFEITED
reason, decidedBy, decidedAt
```

Written in exactly one place:
[move-checklist.service.ts:333](apps/web/src/modules/move-checklist/move-checklist.service.ts:333),
inside `createMoveOutChecklist`. The refund amount is whatever the admin typed
into the move-out form. It is **not** validated against any deposit ever
collected (there is none), and not netted against `pendingFeeAmount`, which is
computed and stored on the checklist but never enforced.

### 2.6 What does *not* exist

Verified absent from the entire codebase — no model, no collection, no route:

- `Transaction` / `LedgerEntry` / `JournalEntry` — no immutable event log of money.
- `Invoice` — no invoice document, number, or tax representation.
- `Subscription` / `BillingCycle` — the platform never bills hostels.
- ~~`Expense` — no hostel-side cost tracking (salaries, groceries, utilities).~~
  Built: see `docs/EXPENSES_PLAN.md` (2026-10-01).
- `Refund` (of fees) — a resident overpayment or wrong approval has no reversal path.
- `Payout` / `Settlement` — no money ever routes to a hostel through the platform.
- Any payment-gateway integration. `grep -i "khalti|esewa|stripe|razorpay|webhook|gateway"`
  finds only **enum string values and UI dropdown labels**. There is no SDK, no
  API key, no callback route, no signature verification, no webhook handler.
- Any idempotency-key mechanism on any write path.

---

## 3. Money-adjacent fields living outside the finance models

| Field | Location | Role |
|---|---|---|
| `Resident.monthlyFee` | [Resident.ts:19](packages/db/src/models/Resident.ts:19) | Number, default 0. **The single source of what a resident is charged.** Set per-resident or in bulk. |
| `Hostel.admissionFee` | [Hostel.ts:38](packages/db/src/models/Hostel.ts:38) | Number. Displayed publicly; never billed, never turned into a `Payment`. |
| `MoveOutChecklist.pendingFeeAmount` | [MoveOutChecklist.ts](packages/db/src/models/MoveOutChecklist.ts) | Snapshot of outstanding dues at move-out. Advisory only — move-out is not blocked by it. |
| `MoveOutChecklist.finalReceiptAssetId` | same | Optional final-settlement document upload. |
| `HostelSettings` | [HostelSettings.ts](packages/db/src/models/HostelSettings.ts) | **Contains no payment fields at all.** |
| `ReferralReward` | [ReferralReward.ts](packages/db/src/models/ReferralReward.ts) | Carries an `amount`. Rewards are marked earned/paid but never settle through the fee ledger. |

**Structural gap:** there is nowhere for a hostel to store *how residents should
pay them* — no eSewa ID, no Khalti merchant code, no bank account, no payment QR
image. Confirmed by grepping `esewaId|bankAccount|accountNumber|paymentQr` across
`apps/web/src` and `packages/db/src`: only Lucide `QrCode` **icon** imports match.
The resident is asked to upload proof of a payment the software never told them
how to make. Payment instructions are communicated entirely out of band.

---

## 4. Configuration knobs

`PlatformSetting` document keyed `operations`, schema in
[operations-config.ts](apps/web/src/modules/platform-config/operations-config.ts).
Payment-relevant keys:

| Key | Default | Effect |
|---|---|---|
| `paymentReminderDaysBefore` | 3 | Reminder fires on exactly this day-offset before `dueDate`. |
| `receiptNumberPrefix` | `"RCP"` | Prefix of every receipt number, **globally across all hostels**. |
| `sendPaymentEmails` | `true` | Master kill-switch for all payment email. When false, in-app notifications still fire for proof review but the admin-notification path returns early *before* creating them. |

These are **platform-global**. A hostel cannot set its own reminder cadence, its
own receipt prefix, or its own due-date policy.

The read path (`getOperationsConfig`) never throws — malformed config silently
falls back to shipped defaults. The write path does throw.

---

## 5. The complete flows

### 5.1 Flow A — Billing: how a charge comes into existence

There are **three separate, overlapping ways** a `Payment` row is created. This
is itself a design problem — the same obligation can originate from three code
paths with three different amount rules.

**A1. Lazy auto-generation on matrix view** (the dominant path in practice)
[`getMonthlyPaymentMatrix`](apps/web/src/modules/payments/payment.service.ts:1112)

1. Admin opens the Payments screen → `GET /api/v1/hostel-admin/payments/matrix?month=YYYY-MM`.
2. Loads all `ACTIVE` + `PENDING` residents for the hostel.
3. If `month <= currentMonth()`, computes `computeMonthlyDue(resident.monthlyFee, resident.moveInDate, month)`
   for each resident with no existing row and inserts them, `dueDate = end of month`.
4. Future months are viewable but never auto-billed.
5. `insertMany(..., { ordered: false })` with a `catch` that swallows duplicate-key
   (11000) errors — concurrent matrix loads race, and the unique index is the referee.

**Proration** — [`computeMonthlyDue`](apps/web/src/modules/payments/payment.service.ts:1091):
`moveInDate > monthEnd` → 0; `moveInDate <= monthStart` → full fee; otherwise
`round(monthlyFee / daysInMonth * billableDays)` by calendar days. Unit-tested in
[payment-matrix.test.ts](apps/web/src/modules/payments/payment-matrix.test.ts).

**A2. Explicit bulk fee run**
[`generateMonthlyPayments`](apps/web/src/modules/payments/payment.service.ts:999) —
`POST /api/v1/hostel-admin/payments/generate`

- `ACTIVE` residents only (note: A1 also includes `PENDING`).
- Amount = `resident.monthlyFee || input.defaultAmount || 0`.
- **No proration** — a mid-month move-in is billed the full fee by this path but a
  prorated amount by A1. Which one wins is a race on who touched the month first.
- `dueDate` comes from the request body (A1 forces end-of-month).
- Idempotent: skips residents already billed for the month.
- Returns `{ createdCount, skippedExistingCount, skippedNoFeeCount }`.

**A3. Manual single-payment creation**
[`createPaymentRecord`](apps/web/src/modules/payments/payment.service.ts:350) —
`POST /api/v1/hostel-admin/payments`

Admin types resident, month, `dueAmount`, `dueDate`, optional `remarks`. The
schema also accepts `paidAmount`, `paidDate`, `status`, and `paymentMethod` on
create — so **a payment can be born already marked PAID with no proof and no
receipt**. The UI form does not send those fields, but the API accepts them.

**Fee setting** — [`setResidentMonthlyFee`](apps/web/src/modules/payments/payment.service.ts:959),
`PATCH /api/v1/hostel-admin/residents/fees`. Sets `monthlyFee` on one, several, or
**every** active/pending resident in the hostel. Omitting `residentIds` applies to
all. Audited as `RESIDENT_MONTHLY_FEE_SET` with the affected count. Historical
`Payment` rows are not retroactively changed (correct), but there is no fee-history
record — you cannot answer "what was this resident's rent in March?".

### 5.2 Flow B — Proof of payment: how money is "proven"

This is the heart of the system and the part the user specifically asked about.

**Step 1 — Resident pays, out of band.** eSewa / Khalti / Fonepay / bank transfer
/ cash. The software is not involved, does not know the hostel's account, and
receives no confirmation from any provider.

**Step 2 — Resident uploads an artefact.**
UI: [resident-payments-page.tsx:293-365](apps/web/src/app/_components/resident-payments-page.tsx:293).

The file goes through the generic uploader (`useUploader`, `kind: "document"`,
`accessLevel: "PRIVATE"`, accept `image/jpeg,image/png,image/webp,application/pdf`,
`optimizeImage: true`). The upload pipeline is **not payment-specific**:

- `POST /api/v1/files/presign` → creates a `FileAsset` row **before the bytes
  exist**, returns `{ assetId, key, presignedUrl }`, 10-minute TTL.
- Key is `generateFileKey("uploads", fileName)` → `uploads/<uuid>.<ext>`.
  ⚠️ `docs/API.md:647` claims keys are `payment-proofs/{hostelId}/{residentId}/...`.
  **That is doc drift — no such prefixing exists.**
- `mimeType` and `sizeBytes` are **client-declared** and used for validation.
  The server never re-reads the object to confirm what was actually stored.
- The `FileAsset` is created with `ownerId = principal.userId` and **no `hostelId`**.
  This matters — see §7.1.
- Nothing ever marks the asset "upload completed". A presign that is never
  followed by a PUT leaves an orphan `ACTIVE` `FileAsset` forever.

**Step 3 — Resident submits the claim.**
`POST /api/v1/resident/payments/[paymentId]/proof` →
[`submitPaymentProof`](apps/web/src/modules/payments/payment.service.ts:493).

Body (schema at [payment.validation.ts:39](apps/web/src/modules/payments/payment.validation.ts:39)):
`{ amount (positive), paymentMethod (default OTHER), proofImageAssetId (string 1-240),
referenceNote?, transactionCode? }`.

Service logic:
1. Resolve the current resident from the principal.
2. Find the `Payment` scoped to `{_id, hostelId: resident.hostelId, residentId: resident._id}` — tenant-safe.
3. Reject if `payment.status === "PAID"` (409). **Any other status is accepted** — including a payment that already has a PENDING proof.
4. Create `PaymentProof` with `status: PENDING`.
5. Flip `Payment.status → PENDING_PROOF`.
6. Audit `PAYMENT_PROOF_SUBMITTED`.
7. Fire-and-forget notify admins (never throws — the proof is already saved).

**Never validated at this step:**
- That `proofImageAssetId` corresponds to a real `FileAsset`.
- That the asset belongs to this resident.
- That the asset has not already been used on another proof.
- That `amount` bears any relation to `dueAmount` or the remaining balance.
  A resident can claim any positive number.
- That `transactionCode` is well-formed, unique, or matches any provider format.
- Rate limiting — a resident can submit unlimited proofs on the same payment.

**Step 4 — Admin notification.**
[`deliverProofNotification`](apps/web/src/modules/payments/payment.service.ts:573).
Gated on `config.sendPaymentEmails`; if that switch is off, the **in-app
notification is skipped too**, because the early return sits above both. All
hostel admin contacts get an in-app notification (category `PAYMENT`) plus the
`proof-uploaded` email with a link to `/hostel-admin/payments`.

**Step 5 — Admin reviews.**
UI: [hostel-admin-payments-page.tsx:544-549](apps/web/src/app/_components/hostel-admin-payments-page.tsx:544)
renders the proof as `<img src="/api/v1/files/{assetId}/url?variant=THUMBNAIL">`.
That route 302-redirects to a 15-minute presigned R2 URL
(`PRIVATE_READ_URL_TTL_SECONDS = 900`, [r2.ts:66](apps/web/src/lib/r2.ts:66)).

Rejection reason is collected via **`window.prompt()`**
([hostel-admin-payments-page.tsx:211](apps/web/src/app/_components/hostel-admin-payments-page.tsx:211)).

**Step 6a — Approve.**
`PATCH /api/v1/hostel-admin/payment-proofs/[id]/approve` →
[`approvePaymentProof`](apps/web/src/modules/payments/payment.service.ts:691).
Capability: `verifyPayments`.

1. Load proof scoped to the caller's hostels; `assertProofIsPending` (cheap pre-check).
2. Load the `Payment`.
3. **Claim the proof first**: `findOneAndUpdate({_id, status: "PENDING"} → APPROVED)`.
   If this matches nothing, throw 409 — this is the double-click guard, and it is
   deliberately ordered *before* the money is credited.
4. `verifiedAmount = proof.amount ?? payment.dueAmount`.
5. [`creditVerifiedAmount`](apps/web/src/modules/payments/payment.service.ts:644) —
   compare-and-swap loop, up to 5 attempts:
   `findOneAndUpdate({_id, paidAmount: <the value we read>}, {paidAmount: min(old + verified, dueAmount), ...})`.
   Losing writers re-read and retry against the fresh balance. After 5 failures → 503.
   **Note the clamp:** `min(..., dueAmount)` — an overpayment is silently truncated.
   The excess simply vanishes; no credit balance, no refund record, no warning.
6. `status = paidAmount >= dueAmount ? "PAID" : "PARTIAL"`; `paidDate = now`;
   `paymentMethod` copied from the proof.
7. Generate/update the `Receipt` (§5.5).
8. Audit `PAYMENT_PROOF_APPROVED` with `{amount, paymentId, resultingPaidAmount, resultingStatus}` —
   this metadata is the *only* per-event money trail that exists.
9. `markReferralConverted` — a referral converts only after real verified money.
10. Notify the resident (email + in-app), fire-and-forget.

**Step 6b — Reject.**
[`rejectPaymentProof`](apps/web/src/modules/payments/payment.service.ts:876).
Requires `rejectionReason` (3-500 chars) or 422. Same PENDING-claim guard.
`Payment.status` reverts to `PARTIAL` if `paidAmount > 0`, else `UNPAID`.
Deliberately refuses to reject an already-APPROVED proof, because that would
reopen a settled month while `paidAmount` stayed put.

**Step 7 — Resident notification.**
[`deliverReviewNotification`](apps/web/src/modules/payments/payment.service.ts:806).
Verified → `payment-verified` email with receipt number, verified amount, and
remaining balance. Rejected → `payment-rejected` email with the reason. Both
also create an in-app `PAYMENT` notification. Both gated on `sendPaymentEmails`.

### 5.3 Concurrency design (the one genuinely well-built part)

Three distinct races are handled explicitly, with comments explaining why:

1. **Double approval of one proof** → the PENDING-claim `findOneAndUpdate` before crediting.
2. **Two proofs approved simultaneously on one payment** → CAS retry loop on `paidAmount`.
3. **Receipt number collision** → unique index + retry with next sequence.
4. **Concurrent matrix auto-billing** → unique `{hostelId, residentId, month}` + unordered insert + 11000 swallow.

All four are covered by tests in
[fee-management.test.ts](apps/web/src/modules/payments/fee-management.test.ts).

**But:** none of this is transactional. MongoDB multi-document transactions are
not used anywhere. Between claiming the proof and crediting the payment, a process
crash leaves an APPROVED proof whose money was never credited — permanently, and
silently, with no reconciliation job to detect it.

### 5.4 Flow C — Manual override (the largest integrity hole)

`PATCH /api/v1/hostel-admin/payments/[id]` →
[`updatePaymentRecord`](apps/web/src/modules/payments/payment.service.ts:424).
Capability: `verifyPayments`.

The schema is `paymentCreateSchema.omit({residentId}).partial()` — meaning a
single request may rewrite **`dueAmount`, `paidAmount`, `dueDate`, `paidDate`,
`status`, `month`, `paymentMethod`, `remarks`** to any valid value.

- A payment can be marked `PAID` with **no proof, no evidence, no reference**.
  This is the intended path for cash — but it is indistinguishable from fraud.
- `paidAmount` can be **decreased**, silently erasing verified money.
- `month` can be changed, moving a settled obligation into a different period and
  potentially colliding with the unique index.
- If the new status is `PAID`, a `Receipt` is generated — a receipt for money the
  system has zero evidence of.
- The audit entry records only `{previousStatus, status}`. **Amount changes are
  not audited at all.** Changing `paidAmount` from 12,000 to 0 produces an audit
  log entry that says nothing about the amount.

There is no separate "record cash payment" endpoint, no cash-receipt evidence
requirement, no maker-checker, no approval threshold, and no reversal concept.
The remedy for a mistake is to mutate the record again.

### 5.5 Receipt issuance

[`generateReceipt`](apps/web/src/modules/payments/payment.service.ts:309) +
[`nextReceiptNumber`](apps/web/src/modules/payments/payment.service.ts:287).

- Number format `{prefix}-{YYYY-MM}-{00001}`, e.g. `RCP-2026-08-00123`.
- Sequence is derived by `findOne({receiptNumber: /^prefix/}).sort({receiptNumber: -1})`
  — a **string sort**, which works only because of the 5-digit zero-padding, and
  breaks at 100,000 receipts in a month.
- **The sequence is global across all hostels**, not per-hostel. Hostel A's
  receipt numbers are interleaved with Hostel B's, and the gaps leak the platform's
  total monthly volume to any hostel that looks at its own numbers.
- **One receipt per payment.** Re-verifying a partially-paid month does
  `findOneAndUpdate({paymentId, residentId}, {$set: {amount: paidAmount}})` —
  it **overwrites the existing receipt's amount in place** rather than issuing a
  second receipt. A resident who paid in two instalments has one receipt whose
  number was issued at the first instalment and whose amount silently changed
  later, with `updatedAt` disabled on the schema. This is the opposite of how
  receipts work in every accounting standard.
- Receipt retrieval: `GET /api/v1/resident/receipts/[id]` returns JSON only.
  There is **no PDF, no printable view, no download** — the "Download Statement"
  button on the resident page ([resident-payments-page.tsx:212](apps/web/src/app/_components/resident-payments-page.tsx:212))
  is a non-functional stub with no handler.

### 5.6 Flow D — Dunning (reminders and overdue chases)

[`runPaymentReminders`](apps/web/src/modules/payments/payment-reminders.service.ts)
via `POST /api/v1/cron/payment-reminders`, daily, `maxDuration = 60`.
Auth: `x-cron-secret` header or `Authorization: Bearer <CRON_SECRET>`. Scheduled
externally through cron-job.org (see [docs/CRON.md:43](docs/CRON.md:43)).

- Scans `status ∈ {UNPAID, PARTIAL, OVERDUE}` across **all hostels**, sorted by
  `dueDate` ascending, **`.limit(500)`**.
  ⚠️ **Hard cap with no pagination and no cursor.** At >500 open payments
  platform-wide, residents whose dues sort later are *never* reminded, forever.
- Skips residents that are deleted or `MOVED_OUT`.
- Flips past-due rows to `OVERDUE` (counted as `markedOverdue`).
- Reminder fires when `daysUntilDue === paymentReminderDaysBefore` — **an exact
  equality**. A missed cron run means that resident is never reminded before the
  due date.
- Overdue chase schedule: `daysOverdue === 1 || === 3 || % 7 === 0`
  ([shouldChaseOverdue](apps/web/src/modules/payments/payment-reminders.service.ts)) —
  decaying so a stale record does not email daily. Chases continue **indefinitely**;
  there is no stop condition, no escalation ladder, no hand-off to a human.
- In-app notification always fires; email is gated on `sendPaymentEmails`.
- Returns `{scanned, markedOverdue, reminded, overdueNotified}`. This return value
  is not persisted anywhere — there is no run history, so a silently-failing job
  is invisible.
- Sends emails **sequentially inside the loop**, one `await` per resident.
- Tested in [payment-reminders.test.ts](apps/web/src/modules/payments/payment-reminders.test.ts).

### 5.7 Flow E — Deposits and move-out settlement

- **Move-in:** nothing. No deposit is ever recorded. `DepositRecord` is dead.
- **Move-out:** [`createMoveOutChecklist`](apps/web/src/modules/move-checklist/move-checklist.service.ts:298)
  computes `pendingFeeAmount`, upserts the checklist, and creates one
  `DepositRefund` with the admin-entered `depositRefundAmount` and decision
  (`PENDING | APPROVED | PARTIAL | FORFEITED`).
- The refund amount is unconstrained — not checked against a deposit held (none
  exists), not netted against `pendingFeeAmount`.
- The resident is moved to `MOVED_OUT` and the bed released **regardless of
  outstanding dues**. No settlement gate.
- No money movement, no refund receipt, no resident-facing view of the decision.

---

## 6. Access control, tenancy, and audit

### 6.1 Who can touch money

| Actor | Route guard | Powers |
|---|---|---|
| Resident | `requireResidentPrincipal` | Read own payments + proofs; submit proofs; read own receipt. Scoped by `findCurrentResident` → always `{hostelId, residentId}` filtered. |
| Hostel admin / warden | `requireHostelCapability(request, "verifyPayments")` | **Everything**: list, create, arbitrary update, fee run, set fees, approve, reject. |
| Guardian | `requireGuardianPrincipal` | Read-only, and only if the resident enabled `canViewPayments` / `canViewReceipts`. |
| Platform admin | `requirePlatformPrincipal` | Read-only cross-tenant roll-up. |

**`verifyPayments` is one flat capability covering eight distinct operations** —
including the unrestricted `PATCH` of §5.4. It is in
[`DEFAULT_WARDEN_PERMISSIONS`](apps/web/src/modules/wardens/warden.validation.ts:37),
so **every newly created warden can rewrite any payment amount by default.**
There is no separation between "verify a proof" and "override a balance", and no
second-person approval for anything.

### 6.2 Tenancy

Consistently enforced through `scopedHostelFilter` / `resolveAdminHostelId` /
`assertHostelAccess` ([payment.service.ts:117-144](apps/web/src/modules/payments/payment.service.ts:117)).
A multi-hostel admin must pass an explicit `hostelId` for write actions
(`HOSTEL_SCOPE_REQUIRED`, 422). Covered by
[tenant-isolation.test.ts](apps/web/src/modules/tenant-isolation.test.ts).
Guardian read paths are default-deny and covered by
[guardian-privacy.test.ts](apps/web/src/modules/guardian/guardian-privacy.test.ts).
This layer is sound.

### 6.3 Audit trail

`auditPaymentAction` → `AuditLog` with `{action, actorId, entityId, entityType, hostelId, metadata}`.

Emitted actions: `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_PROOF_SUBMITTED`,
`PAYMENT_PROOF_APPROVED`, `PAYMENT_PROOF_REJECTED`, `MONTHLY_PAYMENTS_GENERATED`,
`RESIDENT_MONTHLY_FEE_SET`.

Gaps:
- `PAYMENT_UPDATED` metadata carries **only status**, not amounts. The single most
  dangerous operation in the system is the least-audited.
- The audit log is an ordinary mutable Mongo collection — no append-only guarantee,
  no hash chain, no retention policy tied to financial-record requirements.
- No audit entry on receipt mutation.
- Nothing reconciles `AuditLog` against `Payment.paidAmount`, so the audit trail
  can diverge from the balance with nothing noticing.

---

## 7. Confirmed defects and risks

Ordered by severity. Each was verified by reading the cited code, not inferred.

### 7.1 🔴 Private payment proofs are readable by any authenticated user

[`/api/v1/files/[assetId]/url/route.ts`](apps/web/src/app/api/v1/files/[assetId]/url/route.ts) —
the authorization check is:

```ts
if (
  fileAsset.ownerId?.toString() !== principal.userId &&
  fileAsset.hostelId &&                                  // ← short-circuits
  !principal.hostelIds.includes(fileAsset.hostelId.toString()) &&
  principal.role !== "SUPERADMIN"
) return 403;
```

The clause `fileAsset.hostelId &&` means: **if the asset has no `hostelId`, the
entire condition is false and access is granted.**

And payment-proof assets *never* have a `hostelId` — the presign route
([files/presign/route.ts](apps/web/src/app/api/v1/files/presign/route.ts)) creates
the `FileAsset` with only `createdBy` and `ownerId`. Neither the presign body nor
the uploader passes a hostel.

**Consequence:** any logged-in user of any hostel who can obtain or enumerate an
asset id gets a valid 15-minute presigned URL to any other resident's bank
screenshot, transaction code, and account details. Requires a valid session, so
it is not open to the public — but it is a complete cross-tenant break of the
most sensitive documents in the product. Combined with §7.2, this is the highest
priority item in this document.

### 7.2 🔴 Proof asset ownership is never verified

`submitPaymentProof` stores `proofImageAssetId` as an unvalidated string. A
resident can submit **another person's asset id** as their own payment proof. The
admin then reviews someone else's screenshot, believes it, and approves. Combined
with §7.1 (which makes other people's asset ids readable), this is a working
path to fraudulently settling a fee with a stranger's genuine receipt.

Also unchecked: the same asset id can back unlimited proofs, and no
`transactionCode` uniqueness exists — the *same* real transaction can be
submitted repeatedly across months.

### 7.3 🔴 Unrestricted payment mutation with unaudited amounts

Per §5.4. `paidAmount` is freely writable, downward as well as upward, by every
default warden, and the audit log does not record the amount. Money can be
created or destroyed in the ledger with no recoverable trace.

### 7.4 🟠 Overpayment is silently destroyed

`Math.min(current.paidAmount + verifiedAmount, current.dueAmount)`
([payment.service.ts:660](apps/web/src/modules/payments/payment.service.ts:660)).
A resident who pays 15,000 against a 12,000 due has 3,000 discarded — no credit
balance, no carry-forward, no refund, no flag, not even an audit note. The
approving admin is not told.

### 7.5 🟠 No reversal path for a wrongly approved proof

Once approved, a proof cannot be un-approved (`rejectPaymentProof` deliberately
refuses non-PENDING proofs). The only remedy is the raw `PATCH` — which is
exactly the uncontrolled operation of §7.3. A mis-verification therefore *forces*
staff into the least auditable code path.

### 7.6 🟠 Dunning silently drops everyone past the 500th open payment

Per §5.6. `.limit(500)` with no pagination, platform-wide. This scales to roughly
a few hundred residents before hostels stop receiving reminders — and the failure
is completely silent, since the run result is never persisted.

### 7.7 🟠 Receipts are mutable and globally sequenced

Per §5.5. In-place amount overwrite with `updatedAt` disabled; global rather than
per-hostel numbering; no PDF; no immutability. A receipt in this system is not
evidence of anything.

### 7.8 🟠 Two billing paths disagree on the amount

A1 (matrix) prorates a mid-month move-in; A2 (fee run) charges the full fee.
Whichever runs first wins, and the unique index makes the second a silent no-op.
The resident's bill therefore depends on which screen an admin happened to open.
A1 also bills `PENDING` residents; A2 bills only `ACTIVE`.

### 7.9 🟡 No transactional integrity

No MongoDB transactions anywhere in the finance code. Approve-then-credit,
credit-then-receipt, and checklist-then-refund are all multi-write sequences that
can half-complete. No reconciliation job exists to find the halves.

### 7.10 🟡 Presigned uploads are unverified and orphan-prone

`FileAsset` rows are created before the bytes land; `mimeType`/`sizeBytes` are
client-asserted and never re-checked against the stored object; nothing marks an
upload complete; abandoned presigns leave permanent `ACTIVE` orphans. A client
can declare `image/png`, 1 KB, and PUT anything the presign permits.

### 7.11 🟡 Residents are never told how to pay

No hostel payment-destination data exists anywhere in the schema (§3). The
product asks for proof of a payment it gives no instructions for.

### 7.12 🟡 Dead and decorative finance surfaces

- `DepositRecord` — model exists, zero writers.
- "Deposit Status: Tracked" metric — hardcoded string, no data source.
- "Download Statement" button — no handler.
- Resident receipt endpoint returns JSON with no rendering surface.
- Hostel "Fee Plans" page derives plans from room config; no fee-plan entity exists.
- Platform "Fee Plans" / "Payments" / "Transactions" pages read resident-fee data;
  the platform bills nobody.

### 7.13 🟡 Documentation drift

- `docs/API.md:647` — claims R2 keys are prefixed `payment-proofs/{hostelId}/{residentId}/`.
  Reality: `uploads/<uuid>.<ext>`.
- `docs/API.md:305` — resident proof body documented as `{ fileUrl, method, referenceNote? }`.
  Reality: `{ amount, paymentMethod, proofImageAssetId, referenceNote?, transactionCode? }`.
- `docs/API.md:274` — approve documented as taking `{ status, rejectionReason? }`.
  Reality: approve and reject are separate endpoints; approve takes `{ hostelId? }`.
- `docs/API.md:272` — POST payments documented as supporting bulk creation. Reality:
  single-resident only; bulk lives at `/payments/generate`.
- `docs/API.md:201-202` — superadmin subscription endpoints marked "⏳ Not built".
  Still not built; there is no subscription concept at all.
- `packages/shared/src/types/enums.ts` — `PaymentStatus` enum lacks `PENDING_PROOF`,
  and `ProofVerificationStatus` uses `VERIFIED` where the Mongoose schema uses
  `APPROVED`. The shared enums are **not** the source of truth; the model schemas are.

---

## 8. What the platform earns (business-model gap)

The platform's own revenue is **entirely unimplemented**.

- `site-config.pricing` holds marketing tiers, rendered on the public pricing page
  and mirrored on the platform "Fee Plans" screen. Nothing subscribes to a tier.
- The platform "Payments" screen
  ([getPlatformPaymentsOverview](apps/web/src/modules/reports/report.service.ts:375))
  is a cross-tenant read-only roll-up of **resident-to-hostel** fees, explicitly
  commented as such. The platform sees hostels' money but never takes any.
- No hostel is ever charged, invoiced, or suspended for non-payment.
- No trial, no plan enforcement, no feature gating by tier, no dunning for hostels.

Whatever commercial model the product intends, none of it is built.

---

## 9. Test coverage

| File | Covers |
|---|---|
| [fee-management.test.ts](apps/web/src/modules/payments/fee-management.test.ts) (437 L) | Per-resident fee vs default fallback; no double-billing; skip zero-fee residents; bulk fee set; partial verification; settle on running total; double-approve refusal; lost-claim no-double-credit; CAS retry on concurrent approval; double-reject refusal; receipt sequence continuity. |
| [payment-matrix.test.ts](apps/web/src/modules/payments/payment-matrix.test.ts) (41 L) | `computeMonthlyDue` proration: pre-month, 1st, mid-month, month-end, before move-in, February. |
| [payment-reminders.test.ts](apps/web/src/modules/payments/payment-reminders.test.ts) (172 L) | Exact-day reminder; silence on non-chase days; OVERDUE marking + chase schedule; overdue-marked-but-no-email. |
| [tenant-isolation.test.ts](apps/web/src/modules/tenant-isolation.test.ts) | Cross-hostel payment access denial. |
| [guardian-privacy.test.ts](apps/web/src/modules/guardian/guardian-privacy.test.ts) | Guardian payment/receipt permission gating. |
| [warden-capability.test.ts](apps/web/src/lib/warden-capability.test.ts) | `verifyPayments` capability enforcement. |

**Untested:** the `PATCH` override path (§5.4), the file-access authorization
branch (§7.1), proof-asset ownership (§7.2), overpayment clamping (§7.4), the
500-row reminder cap (§7.6), receipt mutation on re-verification (§7.7), the
A1/A2 proration disagreement (§7.8), and every deposit path.

Concurrency is genuinely well-tested. Authorization and data integrity around
money are not.

---

## 10. Complete file inventory

**Models** — `packages/db/src/models/`: `Payment.ts`, `PaymentProof.ts`,
`Receipt.ts`, `DepositRecord.ts` (dead), `DepositRefund.ts`, `FileAsset.ts`,
`AuditLog.ts`, `Resident.ts` (`monthlyFee`), `Hostel.ts` (`admissionFee`),
`MoveOutChecklist.ts`, `GuardianPermission.ts`, `ReferralReward.ts`, `PlatformSetting.ts`.

**Services** — `apps/web/src/modules/`:
`payments/payment.service.ts` (1,245 L — the core),
`payments/payment.validation.ts` (83 L),
`payments/payment-reminders.service.ts` (189 L),
`reports/report.service.ts` (`sumPayments`, `monthlyPaymentSeries`,
`getPlatformPaymentsOverview`, `getHostelAdminPaymentsReport`),
`reports/report-export.service.ts` (`paymentVolume` CSV),
`move-checklist/move-checklist.service.ts` (deposit refund),
`guardian/guardian.service.ts` (`listGuardianPayments`),
`referrals/referral.service.ts` (conversion on verified payment),
`platform-config/operations-config.ts`.

**API routes** — `apps/web/src/app/api/v1/`:

| Method | Path | Guard |
|---|---|---|
| GET/POST | `hostel-admin/payments` | `verifyPayments` |
| PATCH | `hostel-admin/payments/[id]` | `verifyPayments` |
| POST | `hostel-admin/payments/generate` | `verifyPayments` |
| GET | `hostel-admin/payments/matrix` | `verifyPayments` |
| PATCH | `hostel-admin/payment-proofs/[id]/approve` | `verifyPayments` |
| PATCH | `hostel-admin/payment-proofs/[id]/reject` | `verifyPayments` |
| PATCH | `hostel-admin/residents/fees` | `verifyPayments` |
| GET | `hostel-admin/reports/payments` | hostel staff |
| GET | `resident/payments` | resident |
| POST | `resident/payments/[paymentId]/proof` | resident |
| GET | `resident/receipts/[id]` | resident |
| GET | `guardian/payments` | guardian + permission |
| GET | `platform/payments` | platform admin |
| POST | `cron/payment-reminders` | `CRON_SECRET` |
| POST | `files/presign`, `files/upload` | any authenticated |
| GET | `files/[assetId]/url` | ⚠️ see §7.1 |

**UI** — `apps/web/src/app/_components/`: `resident-payments-page.tsx` (393 L),
`hostel-admin-payments-page.tsx` (598 L), `hostel-admin-transactions-page.tsx` (301 L),
`platform-payments-page.tsx` (437 L), `platform-transactions-page.tsx` (317 L),
`hostel-admin-fee-plans-page.tsx` (214 L), `platform-fee-plans-page.tsx` (178 L),
`hostel-admin-reports-page.tsx`, `guardian-dashboard-page.tsx`, `report-widgets.tsx`.

**Email templates** — `packages/shared/src/email/templates/payment/`:
`payment-due-reminder.ts`, `payment-overdue.ts`, `payment-verified.ts`,
`payment-rejected.ts`, `proof-uploaded.ts`.

**Infrastructure** — `apps/web/src/lib/r2.ts` (presign, 10-min upload TTL,
15-min read TTL), `lib/uploads/uploader.ts`, `stores/upload-store.ts`,
`lib/cron-auth.ts`, `lib/tenant.ts`, `lib/api-auth.ts`.

---

## 11. Brief for the next assistant

The design questions this state raises, in the order they matter:

1. **Event-sourced money.** Should `Payment` be split into an immutable
   `Transaction`/ledger-entry log with `paidAmount` as a derived projection,
   rather than a mutable field anyone can overwrite? What does double-entry look
   like for a single-tenant-per-hostel rent ledger?
2. **Evidence integrity.** How should a proof artefact be bound to its uploader
   and its payment (ownership check, one-time use, hash of the file, dedup of
   `transactionCode`)? What is the standard for storing financial documents —
   retention, immutability, access logging?
3. **Reversals instead of edits.** What replaces the unrestricted `PATCH`:
   correcting entries, void/reissue, maker-checker thresholds, separate
   `recordCashPayment` with its own evidence requirement?
4. **Overpayment and credit balances.** Carry-forward, credit note, or refund?
5. **Receipt standards.** Immutable numbering (per-hostel sequence), one receipt
   per *payment event* not per month, PDF generation, what Nepali practice and
   tax rules require.
6. **Gateway integration.** eSewa / Khalti / Fonepay have real APIs with server
   verification and webhooks. What does the flow look like when the software can
   actually confirm a payment instead of trusting a screenshot? What stays manual
   for cash?
7. **Dunning at scale.** Cursor-based batching, run history, escalation ladder,
   stop conditions, retry semantics.
8. **Deposits.** A real collect → hold → settle → refund lifecycle, netted
   against outstanding dues at move-out.
9. **Platform monetisation.** Subscription entity, plan enforcement, hostel-side
   invoicing and dunning — currently a blank slate.
10. **Reconciliation.** Nothing today can answer "does the ledger balance?".
    What periodic job proves that `paidAmount` equals the sum of its approved
    evidence, and what happens when it does not?

---

*Extracted 2026-08-06 from branch `main` (working tree includes uncommitted
changes). All file:line references were read directly; nothing in this document
is inferred from documentation.*
