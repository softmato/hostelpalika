import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { getCreditAmount } from "@/modules/finance/credit-balance.service";
import {
  computeInvoiceAmount,
  getEffectiveSchedule,
  listedRoomRates,
  periodBounds,
  resolveMonthlyCharge,
} from "@/modules/finance/fee-schedule.service";
import type {
  FeeScheduleRecord,
  ListedRoomRates,
} from "@/modules/finance/fee-schedule.service";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { getRentConcession } from "@/modules/finance/rent-concession.service";
import {
  listRecentInvoices,
  listResidentInvoices,
} from "@/modules/finance/ledger-read.service";
import type { LedgerInvoice } from "@/modules/finance/ledger-read.service";
import { paidBeforeJoining } from "@/modules/finance/paid-till";
import { type ExpenseRow, listLedgerExpenses } from "@/modules/finance/expenses/expense.service";
import { countableResidentIds } from "@/modules/finance/resident-scope";
import { listReviewQueue } from "@/modules/finance/review.service";
import {
  findCurrentResident,
  findResidentAvatars,
} from "@/modules/residents/resident-access";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ResidentModel } from "@hostel/db/models/Resident";
import type { BedType } from "@hostel/shared/types/bed-type";

/**
 * Invoice lists for the two portals (plan item 2.8).
 *
 * Replaces `listPayments`, `listResidentPayments` and `getMonthlyPaymentMatrix`.
 * All three read through the ledger facade rather than a model, so the screens
 * are already source-agnostic.
 *
 * The matrix keeps its shape — one row per resident, billed or not — because
 * that shape is genuinely useful: "who has not paid" is the question an owner
 * opens the screen to answer. What it loses is the lazy insert that made
 * *rendering* it a billing event (item 2.5). A resident with no invoice now
 * shows as `NOT_BILLED`, which is the truth rather than a gap the page quietly
 * filled in.
 */

/**
 * An invoice in the portal's own vocabulary.
 *
 * `month`, not `period` — every other consumer of the facade renames it in its
 * own serializer (`report.service`, `guardian.service`,
 * `resident-dashboard.service`, `report-export.service` all do), because the
 * screens have said `month` since they were built. Returning `period` raw here
 * would have rendered five blank cells on the resident's payments page while
 * type-checking perfectly, since the response type is a caller-side generic.
 * Block 3 renames the screens and this mapping goes with it.
 */
export type PortalInvoice = {
  dueAmount: number;
  dueDate?: Date;
  id: string;
  method?: string;
  /**
   * `YYYY-MM`, or `null` for a one-off that belongs to no month — an admission
   * fee is the common one. See `LedgerInvoice.period`; screens render their own
   * word for the empty case rather than being handed `""`.
   */
  month: string | null;
  paidAmount: number;
  paidDate?: Date;
  status: string;
};

export function toPortalInvoice(invoice: LedgerInvoice): PortalInvoice {
  return {
    dueAmount: invoice.dueAmount,
    dueDate: invoice.dueDate,
    id: invoice.id,
    method: invoice.method,
    month: invoice.period,
    paidAmount: invoice.paidAmount,
    paidDate: invoice.paidDate,
    status: invoice.status,
  };
}

/** One receipt on a resident's month, as their screen lists it. */
export type ResidentInvoiceReceipt = {
  amount: number;
  /** Set when the receipt is certified under the Resident Offer Program. */
  certificationCode: string | null;
  id: string;
  issuedAt: string | null;
  number: string;
};

/**
 * One line of an invoice, as the resident is shown it.
 *
 * Everything here is already snapshotted on the invoice — the amount above all,
 * which is why a historical invoice stays correct after every fee schedule it
 * came from is closed (see `Invoice.lines`). Nothing is re-derived.
 *
 * `feeScheduleId` is deliberately **not** carried through. It exists for
 * tracing, it means nothing to a resident, and a schedule id on a customer-facing
 * payload is an internal identifier the client would have no way to resolve.
 */
export type ResidentInvoiceLine = {
  /** Signed — a credit line is negative (target §9.4). */
  amount: number;
  /** How the amount was arrived at: SCHEDULE, OVERRIDE, MANUAL or CREDIT. */
  basis: string;
  /** Null on non-rent lines: admission fees and adjustments have no bed type. */
  bedType: string | null;
  description: string;
  /** e.g. `"18/31 days"` — why a part month costs what it costs. */
  prorationBasis: string | null;
};

/**
 * An invoice as the resident's own screen needs it.
 *
 * `receipts` is the one addition: a settled month has receipts, and a resident
 * who needs proof of rent for a visa or a landlord should be one tap from the
 * PDF rather than emailing the hostel for it. The admin matrix has no use for
 * them, so they live on this shape instead of `PortalInvoice`.
 *
 * **All of them, not the newest.** There is one receipt per settled *payment*,
 * not per month, so a resident who paid NPR 60 and then the remaining NPR 1,230
 * has two — and returning only the latest quietly made the first unreachable the
 * moment the second was issued. The screen showed a single chip whose number
 * changed under a row whose `Paid` column had gone up, which is exactly the
 * question this page keeps getting asked: *did my earlier payment survive?*
 * Newest first, because the last thing they paid is the thing they are looking
 * for.
 */
export type ResidentPortalInvoice = PortalInvoice & {
  /**
   * What the month is actually made of (target §3.3).
   *
   * The second addition, and for the same reason as `receipts`: without it a
   * resident can see *what* they owe and never *why*. A month that costs more
   * than the last one — a part-month proration, an admission fee, a credit from
   * an overpayment — is indistinguishable from a mistake, and the only way to
   * find out is to ask the hostel, who then have to open the admin portal to
   * read back a breakdown the database has had all along.
   *
   * Not on `PortalInvoice`: the admin matrix is one row per resident per month
   * and would carry every line of every invoice for nothing.
   *
   * Read from `InvoiceModel` beside `referenceCode` rather than through the
   * ledger facade, on the same grounds (ADR-3) — the facade describes
   * *balances*, and these are the invoice's own description of itself. The
   * balance still comes from the facade; the two are not summed against each
   * other here, because a paid invoice's lines still total the full amount.
   */
  lines: ResidentInvoiceLine[];
  receipts: ResidentInvoiceReceipt[];
  /**
   * The invoice's reference code (§5, ADR-7), so the payments page can show the
   * resident the code for the month they owe without opening the pay screen.
   *
   * The commonest way to pay without a code is never to have seen one: the code
   * lived only behind `Pay now`, and a resident who pays from their banking app
   * out of habit never opens that screen. It is not on `PortalInvoice` because
   * the admin matrix has no use for it, and it is read here rather than through
   * the ledger facade because the facade describes balances, not identifiers.
   */
  referenceCode: string | null;
};

export type ResidentFinanceView = {
  claims: Awaited<ReturnType<typeof listReviewQueue>>;
  /**
   * Credit carried from an earlier overpayment (target §9.4). Zero for almost
   * everyone, and the screen shows it only when it is not — but when it is, the
   * resident has to be told, or the next invoice arrives mysteriously smaller.
   */
  credit: number;
  invoices: ResidentPortalInvoice[];
};

export async function getResidentFinanceView(
  principal: ApiPrincipal,
): Promise<ResidentFinanceView> {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  const [invoices, claims, credit] = await Promise.all([
    listResidentInvoices({ hostelId: resident.hostelId, residentId: resident._id }),
    listResidentClaims(resident.hostelId, resident._id),
    getCreditAmount(resident.hostelId, resident._id),
  ]);

  const detailRows = invoices.length
    ? await InvoiceModel.find({
        _id: { $in: invoices.map((invoice) => invoice.id) },
        residentId: resident._id,
      })
        .select("lines referenceCode")
        .lean<
          {
            _id: Types.ObjectId;
            lines?: {
              amount: number;
              basis: string;
              bedType?: string | null;
              description: string;
              prorationBasis?: string | null;
            }[];
            referenceCode?: string;
          }[]
        >()
    : [];

  const codeByInvoice = new Map(
    detailRows.map((row) => [row._id.toString(), row.referenceCode ?? null]),
  );

  // Mapped rather than passed through: the stored subdocument carries
  // `feeScheduleId`, which is an internal tracing handle with no meaning to a
  // resident and no route that would resolve it.
  const linesByInvoice = new Map(
    detailRows.map((row) => [
      row._id.toString(),
      (row.lines ?? []).map(
        (line): ResidentInvoiceLine => ({
          amount: line.amount,
          basis: line.basis,
          bedType: line.bedType ?? null,
          description: line.description,
          prorationBasis: line.prorationBasis ?? null,
        }),
      ),
    ]),
  );

  // Voided receipts are excluded: a receipt that was voided when its payment was
  // reversed must not stay downloadable, or the resident keeps a document
  // asserting a payment the ledger no longer counts.
  const receipts = invoices.length
    ? await ReceiptModel.find({
        invoiceId: { $in: invoices.map((invoice) => invoice.id) },
        residentId: resident._id,
        voidedAt: null,
      })
        .select("amount certificationCode invoiceId issuedAt receiptNumber")
        .sort({ issuedAt: -1 })
        .lean<
          {
            _id: Types.ObjectId;
            amount: number;
            certificationCode?: string | null;
            invoiceId?: Types.ObjectId | null;
            issuedAt?: Date | null;
            receiptNumber: string;
          }[]
        >()
    : [];

  // Sorted newest first above, and appended in that order, so each month's list
  // reads most-recent-first without a second sort.
  const receiptsByInvoice = new Map<string, ResidentInvoiceReceipt[]>();

  for (const receipt of receipts) {
    const key = receipt.invoiceId?.toString();

    if (!key) continue;

    const list = receiptsByInvoice.get(key) ?? [];

    list.push({
      amount: receipt.amount,
      certificationCode: receipt.certificationCode ?? null,
      id: receipt._id.toString(),
      issuedAt: receipt.issuedAt?.toISOString() ?? null,
      number: receipt.receiptNumber,
    });
    receiptsByInvoice.set(key, list);
  }

  return {
    claims,
    credit,
    invoices: invoices.map((invoice) => {
      const portal = toPortalInvoice(invoice);

      return {
        ...portal,
        lines: linesByInvoice.get(portal.id) ?? [],
        receipts: receiptsByInvoice.get(portal.id) ?? [],
        referenceCode: codeByInvoice.get(portal.id) ?? null,
      };
    }),
  };
}

/**
 * A resident's own claims, so their screen can show "waiting for review" against
 * the invoice it belongs to. Reuses the queue's row shape rather than inventing
 * a second one — it is the same record seen from the other side.
 */
async function listResidentClaims(
  hostelId: Types.ObjectId,
  residentId: Types.ObjectId,
): Promise<Awaited<ReturnType<typeof listReviewQueue>>> {
  const [pending, settled, rejected] = await Promise.all([
    listReviewQueue(hostelId, "PENDING"),
    listReviewQueue(hostelId, "SETTLED"),
    listReviewQueue(hostelId, "REJECTED"),
  ]);

  const mine = residentId.toString();

  return [...pending, ...settled, ...rejected].filter(
    (claim) => claim.residentId === mine,
  );
}

/**
 * One row of the matrix.
 *
 * `payment` and `resident`, not `invoice` and `residentId`: this is the shape
 * the admin screen already renders, and keeping it is the same decision as the
 * facade's vocabulary — the models changed underneath, the screens change in
 * Block 3, and not on the same day.
 */
type ResidentRow = {
  _id: Types.ObjectId;
  bedType?: string;
  firstName?: string;
  lastName?: string;
  /** Needed to price an unbilled row — see {@link NotBilled}. */
  monthlyFee?: number | null;
  moveInDate?: Date;
  moveOutDate?: Date | null;
  /** Months up to here were paid before the hostel joined — never billed. */
  paidTill?: string | null;
  phone?: string;
  roomNumber?: string;
  roomType?: string;
  /** Only to find their face — see {@link findResidentAvatars}. */
  userId?: Types.ObjectId | null;
};

/**
 * What an unbilled row would cost, and why it has not been billed.
 *
 * `NOT_BILLED` on its own was a dead end. It is the status a warden sees the
 * day after registering somebody, and it says neither of the two things they
 * want: how much this person owes for the month, and whether anybody has to do
 * something about it. "Not billed" over a resident who is plainly living there
 * reads as a fault in the product, and the reader's only move was to open the
 * rate card and work the proration out on paper.
 *
 * Both halves are answerable without writing anything. The amount is
 * `resolveMonthlyCharge` + `computeInvoiceAmount` — the billing run's own
 * arithmetic, not a second opinion — and the reason is the error or skip code
 * that run would produce. **Nothing here bills.** That is the rule this function
 * was rewritten to obey (item 2.5), and showing the figure is not the same act
 * as owing it: an amount here is a projection, an amount on `payment` is a debt.
 *
 * `reason` is a code, phrased by whichever screen renders it, like every other
 * status this module returns:
 *
 * - `NOT_YET_RUN` — priceable, simply not billed yet. The month's run has not
 *   happened. This is the common one and the only one with an amount that will
 *   become real on its own.
 * - `FEE_SCHEDULE_MISSING` / `BED_TYPE_NOT_PRICED` — nothing prices this room
 *   type: no rate card covers the month and the owner has listed no rent
 *   against it. Needs a person.
 * - `NOT_YET_RESIDENT`, `ALREADY_MOVED_OUT`, `NO_BILLABLE_DAYS`,
 *   `PAID_BEFORE_JOINING`, `ZERO_CHARGE` — the run's own skip reasons. Nothing is owed, and that is
 *   correct rather than broken.
 */
export type NotBilled = {
  /** What the run would charge, or null when nothing can price this resident. */
  amount: number | null;
  reason: string;
};

function priceUnbilled(
  resident: ResidentRow,
  schedule: FeeScheduleRecord | null,
  listed: ListedRoomRates,
  period: string,
  /**
   * The month's festival discount. Projected here for the same reason the rest
   * of this function exists: the figure a warden reads beside an unbilled row has
   * to be the figure the run will charge, and a Dashain month at half rent that
   * showed the full rent here would make every unbilled row on the busiest screen
   * in the portal wrong by half.
   */
  concessionPercent = 0,
): NotBilled {
  if (paidBeforeJoining(resident.paidTill, period)) {
    return { amount: 0, reason: "PAID_BEFORE_JOINING" };
  }

  try {
    const charge = resolveMonthlyCharge(
      {
        _id: resident._id,
        bedType: (resident.bedType ?? null) as BedType | null,
        monthlyFee: resident.monthlyFee,
        moveInDate: resident.moveInDate,
        moveOutDate: resident.moveOutDate,
        roomType: resident.roomType,
      },
      schedule,
      listed,
      concessionPercent,
    );

    const invoiceAmount = computeInvoiceAmount(
      charge.amount,
      resident.moveInDate,
      resident.moveOutDate,
      period,
    );

    if (invoiceAmount.amount <= 0) {
      // The same three-way reading `skipReasonFor` makes in the billing run.
      // Repeated rather than imported because importing it would drag the whole
      // write path into a read, and the mapping is three lines.
      return {
        amount: 0,
        reason:
          invoiceAmount.prorationBasis === "not yet resident"
            ? "NOT_YET_RESIDENT"
            : invoiceAmount.prorationBasis === "already moved out"
              ? "ALREADY_MOVED_OUT"
              : charge.amount === 0
                ? "ZERO_CHARGE"
                : "NO_BILLABLE_DAYS",
      };
    }

    return { amount: invoiceAmount.amount, reason: "NOT_YET_RUN" };
  } catch (error) {
    return {
      amount: null,
      reason:
        error instanceof FinanceServiceError ? error.errorCode : "FEE_SCHEDULE_MISSING",
    };
  }
}

export type InvoiceMatrixRow = {
  displayStatus: string;
  /** Set only on a row with no invoice. See {@link NotBilled}. */
  notBilled: NotBilled | null;
  payment:
    | (PortalInvoice & { lines: { amount: number; basis: string; description: string }[] })
    | null;
  resident: {
    fullName: string;
    id: string;
    /** Their profile picture — a URL behind auth, or null. */
    image: string | null;
    moveInDate: string;
    phone?: string;
    roomNumber?: string | null;
    /**
     * The identifying attribute the hostel actually thinks in (target §11.4:
     * "bed type replaces room number throughout"). `bedType` is the canonical
     * pricing vocabulary and `roomType` is what the resident was registered
     * with, so we prefer the former and fall back to the latter for residents
     * registered before the derivation existed.
     */
    roomType?: string | null;
  };
};

export type InvoiceMatrix = {
  month: string;
  rows: InvoiceMatrixRow[];
  totals: {
    collected: number;
    due: number;
    notBilled: number;
    overdue: number;
    paid: number;
    partial: number;
    unpaid: number;
  };
};

/**
 * One row per resident for a period, billed or not.
 *
 * **Read-only.** This is the function whose predecessor created a `Payment` row
 * for every unbilled resident as a side effect of being called, so two residents
 * could be billed differently depending on which screen an admin opened first.
 *
 * ## Nobody appears in a month they had not moved into yet
 *
 * The resident query used to be "everyone on the roster", with no reference to
 * the period at all. A hostel that opened in July and took its first resident in
 * August therefore showed that resident on **July**, marked `NOT_BILLED` — a red
 * count of unbilled people for a month in which they did not live there, on the
 * one screen whose entire job is to say who owes money. Worse, the honest fix
 * for it looks like billing them.
 *
 * `moveInDate > end` is the same test `computeInvoiceAmount` already applies
 * before it prices anybody (`"not yet resident"`), so the matrix and the billing
 * run now agree about who a month is even about. A resident with no `moveInDate`
 * at all is kept: an unknown start is a data gap, and hiding somebody from the
 * screen that would reveal it is how it stays unfixed.
 *
 * The mirror case — a resident who moved out before the period began — is
 * already handled below by the `MOVED_OUT` status filter, and by the rule that
 * anybody holding an invoice for the period keeps their row whatever their
 * status now says.
 *
 * ## A `PENDING` resident is not on this screen
 *
 * The roster query used to be `["ACTIVE", "PENDING"]`, and that put a resident
 * who has not been admitted into the **Owing** list, permanently, marked
 * `NOT_BILLED`. Nothing could ever clear it: `findBillableResidents` bills the
 * admitted only, so no run — not the intake's, not the monthly cron's — would
 * ever raise them an invoice. The row was an item on a worklist with no action
 * behind it, and it inflated the "still owe" count on a screen whose whole job
 * is that count.
 *
 * `NOT_BILLED` still means something here, and it means the thing worth seeing:
 * an **admitted** resident nobody billed. That is a billing run that failed or
 * a rate card that could not price them, and it needs an owner to look at it.
 * "Not billed because they have not moved in yet" is not the same fact and does
 * not belong in the same list; a pending resident is on the Residents tab, where
 * their status is the actionable thing about them.
 *
 * They are still pulled back in by the `extraIds` lookup below if they hold an
 * invoice for the period — an admission fee taken at booking, say. Money that
 * exists is never hidden by a status filter.
 */
export async function getInvoiceMatrix(
  hostelId: Types.ObjectId | string,
  period: string,
): Promise<InvoiceMatrix> {
  await connectToDatabase();

  const { end } = periodBounds(period);

  const [residents, invoices] = await Promise.all([
    ResidentModel.find({
      hostelId,
      isDeleted: { $ne: true },
      $or: [{ moveInDate: { $lte: end } }, { moveInDate: null }, { moveInDate: { $exists: false } }],
      status: "ACTIVE",
    })
      .select(
        "bedType firstName lastName monthlyFee moveInDate moveOutDate paidTill phone roomNumber roomType userId",
      )
      .lean<ResidentRow[]>(),
    InvoiceModel.find({ hostelId, period, status: { $ne: "VOID" } }).lean<
      {
        _id: Types.ObjectId;
        dueDate?: Date;
        lines?: { amount: number; basis: string; description: string }[];
        period: string;
        residentId: Types.ObjectId;
        status: string;
        totalAmount: number;
      }[]
    >(),
  ]);

  /*
   * The two inputs an unbilled row is priced from. Read once for the page, not
   * once per row: the matrix is the most-opened screen in the portal and a
   * per-resident schedule lookup would be forty round trips to say "not billed".
   */
  const [schedule, hostel, concession] = await Promise.all([
    getEffectiveSchedule(hostelId, period),
    HostelModel.findById(hostelId)
      .select("roomConfigurations")
      .lean<{ roomConfigurations?: { monthlyRent?: number; roomType: string }[] } | null>(),
    getRentConcession(hostelId, period),
  ]);

  const listed = listedRoomRates(hostel?.roomConfigurations);

  const balances = await listRecentInvoices({ hostelId, period }, 1000);
  const balanceByInvoiceId = new Map(balances.map((row) => [row.id, row]));

  // Fine and khata lines, so the cash sheet can say what the total is made of.
  const linesByInvoiceId = new Map(
    invoices.map((invoice) => [
      invoice._id.toString(),
      (invoice.lines ?? []).map(({ amount, basis, description }) => ({ amount, basis, description })),
    ]),
  );

  const invoiceByResident = new Map(
    invoices.map((invoice) => [
      invoice.residentId.toString(),
      balanceByInvoiceId.get(invoice._id.toString()) ?? null,
    ]),
  );

  // Residents who left mid-period keep their row: they were billed, and hiding
  // the invoice would hide money that is still owed.
  //
  // **A soft-deleted resident is not one of them.** This lookup used to have no
  // `isDeleted` guard, so a deleted resident with an open invoice was pulled
  // back onto the screen — the matrix listed two people while every other
  // surface, which filters properly, counted one. Deletion means gone from the
  // product, not gone unless they happen to owe money.
  const extraIds = invoices
    .map((invoice) => invoice.residentId.toString())
    .filter((id) => !residents.some((resident) => resident._id.toString() === id));

  const extras = extraIds.length
    ? await ResidentModel.find({ _id: { $in: extraIds }, isDeleted: { $ne: true } })
        .select(
        "bedType firstName lastName monthlyFee moveInDate moveOutDate phone roomNumber roomType userId",
      )
        .lean<ResidentRow[]>()
    : [];

  const everyone = [...residents, ...extras];
  // One join for the whole matrix; the money list draws a face per row.
  const avatars = await findResidentAvatars(everyone);

  const rows: InvoiceMatrixRow[] = everyone.map((resident) => {
    const invoice = invoiceByResident.get(resident._id.toString()) ?? null;

    return {
      displayStatus: invoice?.status ?? "NOT_BILLED",
      notBilled: invoice
        ? null
        : priceUnbilled(resident, schedule, listed, period, concession.percentOff),
      payment: invoice
        ? { ...toPortalInvoice(invoice), lines: linesByInvoiceId.get(invoice.id) ?? [] }
        : null,
      resident: {
        fullName: `${resident.firstName ?? ""} ${resident.lastName ?? ""}`.trim(),
        id: resident._id.toString(),
        /** Their profile picture, or null. See {@link findResidentAvatars}. */
        image: resident.userId ? (avatars.get(resident.userId.toString()) ?? null) : null,
        // The screen flags a mid-month move-in as pro-rated by comparing this
        // against the period, so it has to be an ISO string, not a Date.
        moveInDate: resident.moveInDate?.toISOString() ?? "",
        phone: resident.phone,
        roomNumber: resident.roomNumber ?? null,
        roomType: resident.bedType ?? resident.roomType ?? null,
      },
    };
  });

  rows.sort((left, right) => left.resident.fullName.localeCompare(right.resident.fullName));

  const countOf = (status: string) =>
    rows.filter((row) => row.displayStatus === status).length;

  return {
    month: period,
    rows,
    totals: {
      collected: rows.reduce((sum, row) => sum + (row.payment?.paidAmount ?? 0), 0),
      due: rows.reduce((sum, row) => sum + (row.payment?.dueAmount ?? 0), 0),
      notBilled: countOf("NOT_BILLED"),
      overdue: countOf("OVERDUE"),
      paid: countOf("PAID"),
      partial: countOf("PARTIAL"),
      unpaid: countOf("UNPAID") + countOf("PENDING_PROOF"),
    },
  };
}

/** One line of the hostel's transaction ledger. */
export type HostelLedgerEntry = PortalInvoice & {
  createdAt?: Date;
  paymentMethod?: string;
  remarks?: string;
  residentId: string;
  residentName: string;
};

export type HostelLedger = {
  entries: HostelLedgerEntry[];
  /**
   * Money out — the hostel's recorded expenses, newest first, so the statement
   * can show debits beside credits. `null` when the reader may not see the
   * hostel's spending (anyone but the owner), which is not the same as `[]`.
   */
  expenses: ExpenseRow[] | null;
  /** True when the ledger hit {@link LEDGER_LIMIT} and older rows were dropped. */
  truncated: boolean;
};

/** A hostel bills ~40 residents a month; 5000 rows is roughly a decade. */
const LEDGER_LIMIT = 5000;

/**
 * Every invoice this hostel has ever raised, newest first — the Transactions
 * screen.
 *
 * ## Why this is not `getInvoiceMatrix`
 *
 * The Transactions screen was pointed at `GET /finance/invoices`, which is the
 * matrix: one row **per resident** for **one month**, under the key `rows`. The
 * screen reads `payments` and shows a lifetime ledger, so it found nothing and
 * had been rendering an empty table with four zeroed metric cards. Two different
 * questions — "who has not paid this month" and "what has this hostel ever
 * billed" — were being asked of one route.
 *
 * ## The one-off invoices are the point
 *
 * An admission fee carries `period: null` and therefore appears in **no** month
 * of the matrix. This read is where an owner can actually see it, which is why
 * it is scoped by hostel and not by period.
 *
 * Scoped through `countableResidentIds` like every other hostel-facing money
 * read, so a soft-deleted resident's invoices do not resurrect here after being
 * excluded everywhere else.
 */
export async function getHostelLedger(
  hostelId: Types.ObjectId | string,
  options: { expensesFor?: string } = {},
): Promise<HostelLedger> {
  await connectToDatabase();

  const residentIds = await countableResidentIds(hostelId);
  const [invoices, spent] = await Promise.all([
    listRecentInvoices({ hostelId, residentIds }, LEDGER_LIMIT),
    options.expensesFor
      ? listLedgerExpenses(hostelId, options.expensesFor, LEDGER_LIMIT)
      : Promise.resolve(null),
  ]);

  const residents = await ResidentModel.find({ _id: { $in: residentIds } })
    .select("firstName lastName")
    .lean<{ _id: Types.ObjectId; firstName?: string; lastName?: string }[]>();

  const nameById = new Map(
    residents.map((resident) => [
      resident._id.toString(),
      `${resident.firstName ?? ""} ${resident.lastName ?? ""}`.trim(),
    ]),
  );

  return {
    entries: invoices.map((invoice) => ({
      ...toPortalInvoice(invoice),
      createdAt: invoice.createdAt,
      paymentMethod: invoice.method,
      remarks: invoice.remarks,
      residentId: invoice.residentId,
      residentName: nameById.get(invoice.residentId) ?? "",
    })),
    expenses: spent?.expenses ?? null,
    truncated: invoices.length >= LEDGER_LIMIT || Boolean(spent?.truncated),
  };
}
