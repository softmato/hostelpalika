/**
 * The hostel statement — every rupee that has actually arrived, newest first.
 *
 * Pure and free of the axios client, same rule as `lib/admin-money.ts`: Vitest
 * here runs node-side with no React Native shim, so the part worth testing is
 * kept out of the screen. `app/manage/finance/statement.tsx` is a renderer over
 * these functions.
 *
 * ## Credits and debits, in one list
 *
 * The wallet apps our users already read — see
 * `ui_inspiration_folder/app_recordings/NOTES.md` — put debits and credits in
 * one list and sign them by colour, and since docs/EXPENSES_PLAN.md the hostel
 * spends through this product too. So the owner's statement is that list: a
 * settled invoice (`paidAmount > 0`) is a **credit**, a recorded expense is a
 * **debit** ({@link StatementRow.debit}), and the running figure on each row is
 * the net balance. Voided expenses are not on the wire — the server leaves them
 * out — because a cancelled expense never moved any money.
 *
 * Expenses arrive only for the owner (`AdminLedger.expenses` is `null` for a
 * warden), the same line the expenses screen draws, so a warden's statement is
 * still credits only.
 *
 * An invoice that is merely *raised* is absent. That is deliberate and
 * it is the difference between this screen and the Money tab: Money answers "who
 * still owes", this answers "what was received". Neither is a filter over the
 * other.
 *
 * ## The resident reads the same rows from the other side
 *
 * `lib/resident-statement.ts` builds **debits** — the same settled invoices, read
 * by the person who paid them — and every function here that filters, searches,
 * groups, ranges or totals is shared with it through {@link StatementRow}. Only
 * the row-building and the words are per-side. The alternative was a second copy
 * of the filter logic, which would have drifted from this one the first time a
 * date range was fixed in only one of them.
 *
 * ## One invoice is one credit, not one payment
 *
 * The ledger route serves invoices, so a resident who paid a month in two
 * instalments appears once, at the paid amount, dated by the **last**
 * settlement. That is what the server records — `paidDate` is a single field on
 * the invoice — and inventing two rows out of one would be inventing data. The
 * detail sheet says `NPR 3,000 of NPR 5,000` in that case rather than implying
 * the month is closed.
 *
 * ## Every function that spells a date takes the calendar
 *
 * This is an **admin** surface, and the hostel portal has a calendar preference
 * (`uiSlice.calendarPreference`, reached through `hooks/use-dates.ts`). These
 * functions used to call `formatDate` / `formatPeriod` from `lib/format.ts`
 * directly, so with the preference on Nepali the statement screen printed the
 * same month twice in two calendars — `Bhadra 2083` in the detail sheet, from
 * `dates.period`, and `September 2026` in the row title above it, from here.
 *
 * So `calendar` is a required argument rather than one defaulting to `"AD"`: a
 * default is exactly how a new call site keeps printing Gregorian while every
 * row around it has moved. The two deliberate exceptions are the day heading,
 * which shows **both** calendars because a date over money is the one place the
 * standing rule says to double them, and the search haystack, which indexes
 * both so the search box finds a row either way.
 */

import { bsPeriodBounds } from "@hostel/calendar/bs";

import type { AdminLedger, AdminLedgerEntry } from "@/lib/admin-api";
import { type ExpenseRow, expenseTitle } from "@/lib/expenses";
import {
  type CalendarSystem,
  formatDateIn,
  formatPeriodIn,
} from "@/lib/calendar";
import {
  formatAmount,
  formatDateBoth,
  formatMoney,
  formatPeriod,
  formatPeriodBs,
  formatWeekday,
  humanizeEnum,
  nepalDayKey,
  nepalPeriodKey,
} from "@/lib/format";
import { endOfDayIso, startOfDayIso, toDayInput } from "@/lib/manage-dates";

/**
 * The word for a settlement whose provider the server could not name.
 *
 * `HostelLedgerEntry.paymentMethod` comes out of a provider lookup that has no
 * fallback, so a cash-book entry recorded before the provider vocabulary
 * existed — or any settlement whose provider is simply absent — arrives as
 * `undefined`. Rendering that as a blank cell reads as a bug; rendering it as
 * `Cash` would be a guess about money. `OTHER` is the honest third answer, and
 * it is a real member of `PAYMENT_METHODS` rather than a word invented here.
 */
export const UNKNOWN_METHOD = "OTHER";

/**
 * One settled row on a statement, whichever way the money went.
 *
 * The half of a statement row that has nothing to do with *whose* statement it
 * is: an amount against what was billed, when it moved, how, what for, and the
 * cumulative position. Everything the filtering, grouping, searching and
 * totalling below needs, and nothing else.
 *
 * It exists because the resident portal shows the same statement from the other
 * side — see `lib/resident-statement.ts`. Their rows are **debits**: the same
 * invoices, read by the person who paid them. Two screens over one set of pure
 * functions, rather than a second copy of the filter sheet's logic that would
 * drift from this one the first time a range was fixed in only one place.
 *
 * The direction is {@link StatementRow.debit}, read only on the hostel's side:
 * the resident's list is never mixed, so it never sets it.
 */
export type StatementRow = {
  /** What moved. Always `> 0` — that is what makes it a settled row. */
  amount: number;
  /**
   * Money **out** — a hostel expense on the owner's statement. Absent on every
   * credit and on every resident row, so the resident side sums as before.
   */
  debit?: boolean;
  /** What the invoice asked for. Larger than `amount` on a part payment. */
  billed: number;
  dueDate: string | null;
  /** The invoice id. Unique per row, because one invoice is one row. */
  id: string;
  method: string;
  /** `2026-08`, or `null` for a one-off — an admission fee, a fine. */
  period: string | null;
  /** ISO, or `null` when the server recorded neither a paid nor a raised date. */
  receivedAt: string | null;
  /**
   * Everything on this side of the ledger up to and including this row.
   *
   * The `BALANCE` line the reference frames put under every transaction, which
   * on a wallet is the balance *after* it. Neither party has a wallet here, so
   * the honest analogue is the cumulative total — the figure a reader would get
   * by adding the column up from the bottom.
   *
   * `null` when the ledger came back truncated: the rows before the cap are
   * missing, so every total computed from these ones is short by an unknown
   * amount. A running total that is quietly wrong is worse than none, and the
   * screen says which it is rather than printing a number nobody can reconcile.
   */
  runningTotal: number | null;
  /**
   * The words this row can be found by that are not already on it.
   *
   * A resident's name and a remark on the hostel's side, a reference code on the
   * resident's. The alternative was a per-field test in {@link filterCredits},
   * which is exactly what the search box must not be — see {@link haystack} —
   * and a second alternative was for the shared filter to know about fields only
   * one of its two callers has.
   *
   * Blank members are allowed and cost nothing; the whole thing is joined and
   * lowercased once.
   */
  searchTerms: string[];
  status: string;
};

/**
 * One row on the hostel's statement: a settled invoice (a credit), or — when
 * `expense` is set — a recorded expense (a debit). The name predates debits.
 */
export type StatementCredit = StatementRow & {
  /** The expense behind a debit row; `null` on every credit. */
  expense: ExpenseRow | null;
  remarks: string;
  /** `""` on a debit — an expense has no resident. */
  residentId: string;
  residentName: string;
};

/** What a row adds to a running balance: money in up, money out down. */
export function signedAmount(row: StatementRow): number {
  return row.debit ? -row.amount : row.amount;
}

/** The status every debit carries — expenses have no invoice status. */
export const SPENT_STATUS = "SPENT";

/**
 * Every credit in the ledger, newest first, with the running total attached.
 *
 * The sort is on `receivedAt` and the running total is accumulated the other
 * way — oldest first — so the two are computed in one pass rather than by
 * reversing an array twice.
 *
 * Undated credits sort to the end and carry the total as it stood before them,
 * because there is no position in a chronological sum for a row with no date.
 */
export function statementCredits(ledger: AdminLedger | null | undefined): StatementCredit[] {
  const entries = ledger?.entries ?? [];
  const credits = [
    ...entries.filter((entry) => entry.paidAmount > 0).map(toCredit),
    ...(ledger?.expenses ?? [])
      .filter((expense) => expense.status === "RECORDED" && expense.amount > 0)
      .map(toDebit),
  ].sort(byNewestFirst);

  return ledger?.truncated ? credits : withRunningTotals(credits);
}

/**
 * Fills in {@link StatementRow.runningTotal} on a list already sorted newest
 * first, in place, and hands the same array back.
 *
 * Called only when the whole history is present. A caller holding a truncated
 * ledger must skip it and leave every total `null` — see the field's own note.
 */
export function withRunningTotals<T extends StatementRow>(rows: T[]): T[] {
  let total = 0;

  // Oldest first, so each row's total includes itself and everything under it.
  // Debits subtract, so on the owner's mixed list this is the net balance.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    total += signedAmount(rows[index]);
    rows[index].runningTotal = total;
  }

  return rows;
}

function toCredit(entry: AdminLedgerEntry): StatementCredit {
  return {
    amount: entry.paidAmount,
    billed: entry.dueAmount,
    dueDate: entry.dueDate ?? null,
    expense: null,
    id: entry.id,
    method: (entry.paymentMethod ?? entry.method ?? UNKNOWN_METHOD).trim() || UNKNOWN_METHOD,
    period: entry.month,
    /*
     * `paidDate` is when the money landed and `createdAt` is when the invoice
     * was raised, which are not the same fact — but a credit with no paid date
     * is still money that arrived, and the day it was billed is the only
     * timestamp the server has for it. Better a row in roughly the right week
     * than a row the statement cannot place at all.
     */
    receivedAt: entry.paidDate ?? entry.createdAt ?? null,
    remarks: entry.remarks?.trim() ?? "",
    residentId: entry.residentId,
    residentName: entry.residentName.trim(),
    runningTotal: null,
    searchTerms: [entry.residentName.trim(), entry.remarks?.trim() ?? ""],
    status: entry.status,
  };
}

/** Nepal is UTC+5:45 year-round — no DST to account for. */
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

/**
 * When an expense left. `spentOn` is a day, not an instant, so it is placed at
 * the moment it was recorded when that falls on the same Nepal day — which
 * orders it truthfully among that day's payments — and at noon Nepal time
 * otherwise (an expense back-dated to yesterday has no clock time).
 */
function spentAt(expense: ExpenseRow): string {
  if (expense.createdAt) {
    const created = new Date(expense.createdAt);

    if (
      !Number.isNaN(created.getTime()) &&
      new Date(created.getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 10) === expense.spentOn
    ) {
      return created.toISOString();
    }
  }

  return new Date(`${expense.spentOn}T12:00:00+05:45`).toISOString();
}

function toDebit(expense: ExpenseRow): StatementCredit {
  const who = expense.salaryFor?.name ?? "";

  return {
    amount: expense.amount,
    billed: expense.amount,
    debit: true,
    dueDate: null,
    expense,
    // Prefixed: an expense id and an invoice id are both ObjectIds, and the
    // list keys and tiebreak need them distinct.
    id: `expense:${expense.id}`,
    method: expense.paidBy || UNKNOWN_METHOD,
    period: null,
    receivedAt: spentAt(expense),
    remarks: expense.what.trim(),
    residentId: "",
    residentName: "",
    runningTotal: null,
    searchTerms: ["expense", "spent", expense.categoryLabel, expense.what, who, expense.recordedBy.name],
    status: SPENT_STATUS,
  };
}

function timeOf(row: StatementRow): number {
  if (!row.receivedAt) {
    return Number.NEGATIVE_INFINITY;
  }

  const millis = new Date(row.receivedAt).getTime();

  return Number.isNaN(millis) ? Number.NEGATIVE_INFINITY : millis;
}

/**
 * Newest first, ties broken on the id.
 *
 * The tiebreak is not cosmetic. A billing run settles a dozen invoices inside
 * the same second, and without it the list reshuffles on every refresh — the
 * row somebody was reaching for moves under their thumb. Same reasoning as the
 * name tiebreak in `outstandingRows`.
 */
export function byNewestFirst(left: StatementRow, right: StatementRow): number {
  return timeOf(right) - timeOf(left) || left.id.localeCompare(right.id);
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the filter sheet holds. Every field is a string, and `""` means "all".
 *
 * Strings rather than a union per field because two of the four are populated
 * from the data — see {@link methodOptions} — so the set of legal values is not
 * known until the ledger has loaded.
 */
export type StatementFilter = {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  method: string;
  /** `"IN"` for credits only, `"OUT"` for debits only, `""` for both. */
  direction: string;
  /**
   * Hide anything under this many rupees. `""` for no floor.
   *
   * A string because it is typed, and a half-typed number is a state the filter
   * has to survive: `"5"` on the way to `"5000"` must not blank the list and
   * then repopulate it. Anything that is not a number is treated as no floor —
   * see {@link filterCredits} — rather than as zero, which would look identical
   * and mean something different the moment somebody typed a stray character.
   */
  minAmount: string;
  /** Free text over the row, as one string. */
  query: string;
  status: string;
  /** `YYYY-MM-DD`, inclusive — the whole day, not midnight. */
  to: string;
};

export const NO_FILTER: StatementFilter = {
  direction: "",
  from: "",
  method: "",
  minAmount: "",
  query: "",
  status: "",
  to: "",
};

/** The typed floor as a number, or `null` when there isn't a usable one. */
function amountFloor(value: string): number | null {
  const parsed = Number(value.trim());

  return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The quick ranges above the list — the reference's `7 days / 14 days / 30 days`.
 *
 * A separate control from the sheet and not a duplicate of it: these write into
 * the same `from`/`to` the sheet edits, which is why tapping `30 days` and then
 * opening the sheet shows the dates it chose rather than two filters disagreeing
 * about the same range.
 */
export const QUICK_RANGES = [7, 14, 30] as const;

/** `{ from, to }` for the last `days` days, ending today in Kathmandu. */
export function quickRange(days: number, now: Date = new Date()): { from: string; to: string } {
  return {
    // `days - 1`, so "7 days" is a week including today rather than eight days.
    from: toDayInput(new Date(now.getTime() - (days - 1) * 86_400_000)),
    to: toDayInput(now),
  };
}

/**
 * Which quick range a filter currently *is*, or `null` for anything else.
 *
 * Derived rather than stored, so the chip cannot drift out of step with the
 * dates: editing `from` by hand in the sheet un-highlights the chip on its own,
 * with nothing to remember to clear.
 */
export function activeQuickRange(
  filter: StatementFilter,
  now: Date = new Date(),
): number | null {
  return (
    QUICK_RANGES.find((days) => {
      const range = quickRange(days, now);

      return filter.from === range.from && filter.to === range.to;
    }) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Months                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The month a row's money **landed** in, or `null` when it has no usable date.
 *
 * The collection month, not the billing period. Those are routinely different —
 * a hostel takes Bhadra's rent in Shrawan and Asar's arrears the day after —
 * and reading this screen as though they were the same is what makes two
 * honest rows look like a fault. The statement is filtered, grouped, summarised
 * and totalled on **this** axis throughout; `credit.period` only ever titles a
 * row. See {@link creditTitle}.
 *
 * `null` rather than a throw off the conversion table: the same rule the rest of
 * the calendar layer keeps, where an honest gap beats a confident guess.
 */
function receivedMonth(row: StatementRow): string | null {
  if (!row.receivedAt) {
    return null;
  }

  const received = new Date(row.receivedAt);

  if (Number.isNaN(received.getTime())) {
    return null;
  }

  try {
    return nepalPeriodKey(received);
  } catch {
    return null;
  }
}

/**
 * The BS months this statement can be narrowed to, newest first.
 *
 * Built from the data, on the same argument as {@link methodOptions}: a hostel
 * that took its first payment in Shrawan should not be offered a year of empty
 * months to filter to nothing with.
 *
 * The **current** month is always in the list even when nothing has arrived in
 * it, because it is the month the screen opens on — an option that vanishes
 * exactly when it is selected is not an option, and a quiet month is a fact an
 * owner opens this screen to check rather than a state to hide.
 *
 * Sorted on the key rather than on a label: BS period keys are zero-padded
 * `YYYY-MM`, so string order is chronological order, and it stays that way
 * across the year boundary that a month *name* sort would scramble.
 */
export function monthOptions(
  credits: readonly StatementRow[],
  now: Date = new Date(),
): string[] {
  const months = new Set<string>([nepalPeriodKey(now)]);

  for (const credit of credits) {
    const month = receivedMonth(credit);

    if (month) {
      months.add(month);
    }
  }

  return [...months].sort((left, right) => right.localeCompare(left));
}

/**
 * `{ from, to }` day inputs spanning one BS month, or a run of them.
 *
 * Writes into the same `from`/`to` the typed fields and the quick ranges edit,
 * for the reason {@link QUICK_RANGES} gives: one range, one pair of strings, and
 * no second control that can disagree with the first about what is on screen.
 *
 * The ends are ordered rather than validated. Picking Bhadra and then reaching
 * back to Shrawan is somebody widening a range, not making a mistake, and a
 * filter that answers an out-of-order pair with nothing is a filter people stop
 * trusting.
 *
 * `lastDay`, never `end` — see `bsPeriodBounds`. `end` is the last millisecond
 * of the month in UTC, which is already the small hours of the *next* month in
 * Kathmandu, and taking it here would push every range one day long.
 */
export function monthRange(from: string, to: string = from): { from: string; to: string } {
  const [first, last] = from <= to ? [from, to] : [to, from];

  try {
    return {
      from: toDayInput(bsPeriodBounds(first).start),
      to: toDayInput(bsPeriodBounds(last).lastDay),
    };
  } catch {
    // A key the conversion table does not reach. "No range" is the honest
    // answer; a clamped one would silently filter to a month nobody picked.
    return { from: "", to: "" };
  }
}

/**
 * Which BS months a filter currently *is*, or `null` for anything else.
 *
 * Derived rather than stored, exactly as {@link activeQuickRange} is derived,
 * and for the same reason: the month chips and the typed `YYYY-MM-DD` fields
 * edit one range between them, so typing a date that lands mid-month has to
 * un-highlight the chip on its own. A remembered selection would have to be
 * cleared by hand in every branch that touches a date, and one of them would
 * eventually forget.
 */
export function activeMonthRange(
  filter: StatementFilter,
): { from: string; to: string } | null {
  const from = monthOfDayInput(filter.from);
  const to = monthOfDayInput(filter.to);

  if (!from || !to) {
    return null;
  }

  const range = monthRange(from, to);

  return range.from === filter.from && range.to === filter.to ? { from, to } : null;
}

/** The BS month a `YYYY-MM-DD` filter bound falls in, or `null` if it is not one. */
function monthOfDayInput(value: string): string | null {
  const iso = value ? startOfDayIso(value) : null;

  if (!iso) {
    return null;
  }

  try {
    return nepalPeriodKey(new Date(iso));
  } catch {
    return null;
  }
}

/**
 * A month selection in words — `Bhadra 2083 BS`, or `Shrawan 2083 to Bhadra 2083 BS`.
 *
 * The era marker is trimmed off the left half of a run for the reason
 * {@link rangeLabel} trims it off a date range: saying which calendar this is
 * twice in one line is how a single range starts reading as two.
 */
export function monthRangeLabel(
  range: { from: string; to: string },
  calendar: CalendarSystem,
): string {
  const to = formatPeriodIn(calendar, range.to);

  if (range.from === range.to) {
    return to;
  }

  const from = formatPeriodIn(calendar, range.from);
  const lead = to.endsWith(" BS") && from.endsWith(" BS") ? from.slice(0, -3) : from;

  return `${lead} to ${to}`;
}

/**
 * How many filters are on, for the dot on the filter button.
 *
 * A date range counts once however many of its two ends are set — an owner who
 * picked "last 7 days" applied *one* filter, and a badge reading `2` for it
 * teaches people the number means nothing.
 */
export function activeFilterCount(filter: StatementFilter): number {
  return (
    Number(filter.method !== "") +
    Number(filter.direction !== "") +
    Number(filter.status !== "") +
    Number(filter.query.trim() !== "") +
    Number(amountFloor(filter.minAmount) !== null) +
    Number(filter.from !== "" || filter.to !== "")
  );
}

/**
 * Everything a row can be searched by, as one lowercase string.
 *
 * One haystack rather than a field-by-field test, same as `searchInvoices`: an
 * owner typing "kartik esewa" is describing one row, not composing a query, and
 * a per-field match would find nothing for them.
 */
function haystack(row: StatementRow): string {
  return [
    ...row.searchTerms,
    humanizeEnum(row.method),
    // **Both** month spellings, always, whatever the calendar preference says.
    // The row is *displayed* in one calendar; it is *searched* in either, so an
    // owner who reads Nepali dates and types "bhadra" finds the same row as one
    // who types "september". Indexing only the displayed spelling would make the
    // search box quietly change what it can find when the setting is flipped.
    row.period ? formatPeriod(row.period) : "one-off",
    row.period ? formatPeriodBs(row.period) : "",
    humanizeEnum(row.status),
    formatAmount(row.amount),
  ]
    .join(" ")
    .toLowerCase();
}

/** The rows a filter admits, in the order they came in. */
export function filterCredits<T extends StatementRow>(
  credits: readonly T[],
  filter: StatementFilter,
): T[] {
  const query = filter.query.trim().toLowerCase();
  const floor = amountFloor(filter.minAmount);
  const from = filter.from ? startOfDayIso(filter.from) : null;
  const to = filter.to ? endOfDayIso(filter.to) : null;

  return credits.filter((credit) => {
    if (filter.direction && (filter.direction === "OUT") !== Boolean(credit.debit)) {
      return false;
    }

    if (filter.method && credit.method !== filter.method) {
      return false;
    }

    if (filter.status && credit.status !== filter.status) {
      return false;
    }

    if (floor !== null && credit.amount < floor) {
      return false;
    }

    if (query && !haystack(credit).includes(query)) {
      return false;
    }

    /*
     * An undated credit is excluded by any date filter rather than kept.
     * "Between these two days" is a claim about when something happened, and a
     * row that cannot answer it does not belong in the answer — keeping it
     * would put a row with no date inside a range the reader chose.
     */
    if ((from || to) && !credit.receivedAt) {
      return false;
    }

    if (from && credit.receivedAt && credit.receivedAt < from) {
      return false;
    }

    return !(to && credit.receivedAt && credit.receivedAt > to);
  });
}

/* -------------------------------------------------------------------------- */
/* Filter options                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The method chips, taken from the data rather than from the enum.
 *
 * `PAYMENT_METHODS` has six members and a hostel that only ever takes cash
 * would get five chips that filter to nothing — a control whose options are
 * mostly dead teaches people not to open it. So the sheet offers what this
 * hostel has actually been paid through, in a stable order.
 *
 * Alphabetical on the humanised word, so the list does not reorder itself when
 * a new method first appears.
 */
export function methodOptions(credits: readonly StatementRow[]): string[] {
  return [...new Set(credits.map((credit) => credit.method))].sort((left, right) =>
    humanizeEnum(left).localeCompare(humanizeEnum(right)),
  );
}

/** The direction chips: offered only when the list actually has both kinds. */
export function directionOptions(rows: readonly StatementRow[]): string[] {
  const out = rows.some((row) => row.debit);
  const into = rows.some((row) => !row.debit);

  return out && into ? ["IN", "OUT"] : [];
}

/**
 * The status chips, on the same argument as {@link methodOptions}. Invoice
 * statuses only — every debit is `SPENT`, which the direction chips cover.
 */
export function statusOptions(credits: readonly StatementRow[]): string[] {
  return [...new Set(credits.filter((credit) => !credit.debit).map((credit) => credit.status))].sort((left, right) =>
    humanizeEnum(left).localeCompare(humanizeEnum(right)),
  );
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

/** One day's rows, with the heading that sits **outside** the card. */
export type StatementDay<T extends StatementRow = StatementCredit> = {
  key: string;
  label: string;
  /** The day's rows, in the order they were given. */
  rows: T[];
  /**
   * What moved that day — taken on the hostel's side (net of anything spent),
   * paid on the resident's.
   */
  total: number;
};

/** The heading for a day with no date behind it. */
const UNDATED_KEY = "undated";

/**
 * The day heading — `Sun · 8 Bhadra 2083 · 24 Aug 2026`.
 *
 * Three parts, and each is there for a reason:
 *
 * - the **weekday**, because that is how the reference frames head their groups
 *   and how people remember a payment ("that Friday");
 * - **both calendars**, because this is a date where money happened and the
 *   standing rule for those is BS beside AD — the hostel's books run on one and
 *   the bank's statement runs on the other. See `formatDateBoth`.
 *
 * No `Today` / `Yesterday`. It reads well on the top group and turns the heading
 * into a different *kind* of label from the ones under it, which is exactly what
 * a column of headings must not do — and the row already carries the clock time.
 */
function dayLabel(iso: string): string {
  const weekday = formatWeekday(iso);
  const date = formatDateBoth(iso);

  return weekday === "—" ? date : `${weekday.slice(0, 3)} · ${date}`;
}

/**
 * Credits grouped by the Kathmandu day they landed on, in the order given.
 *
 * The input is already sorted, so this preserves that order rather than sorting
 * again — a group's position is its newest member's position. Undated credits
 * collect into one trailing group instead of being dropped: they are money that
 * arrived, and a statement that silently omits a row does not add up.
 */
export function groupByDay<T extends StatementRow>(credits: readonly T[]): StatementDay<T>[] {
  const days: StatementDay<T>[] = [];
  const byKey = new Map<string, StatementDay<T>>();

  for (const credit of credits) {
    const date = credit.receivedAt ? new Date(credit.receivedAt) : null;
    const dated = date && !Number.isNaN(date.getTime());
    const key = dated ? nepalDayKey(date) : UNDATED_KEY;

    let day = byKey.get(key);

    if (!day) {
      day = {
        key,
        label: dated ? dayLabel(credit.receivedAt as string) : "Date not recorded",
        rows: [],
        total: 0,
      };
      byKey.set(key, day);
      days.push(day);
    }

    day.rows.push(credit);
    day.total += signedAmount(credit);
  }

  return days;
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

export type StatementSummary = {
  /** How many credits are in scope. */
  count: number;
  /** What the hostel spent over the same months — the debits. */
  out: number;
  /** How many debits are in scope. */
  outCount: number;
  /** `August 2026` — the month {@link StatementSummary.total} covers. */
  periodLabel: string;
  /** What this hostel took that month. */
  total: number;
};

/**
 * The strip under the bar: what has come in over **the months on screen**.
 *
 * The month, not the visible list. The list is whatever every filter left
 * behind, and a headline that moves when a status chip is tapped is a headline
 * nobody can quote; "NPR 84,500 received in Bhadra 2083 BS" is a fact about the
 * hostel that stays true while the reader searches around underneath it.
 *
 * ## Why it follows the month filter and nothing else
 *
 * The card names a month in its own sentence, so once a reader has picked one it
 * has to be *that* month. Pinned to today's regardless, it said "NPR 0 received
 * in Bhadra 2083 BS · 0 payments" over a list the reader had just narrowed to
 * Shrawan — both halves true, and together they read as a broken screen. So a
 * month selection moves it, and a run of months widens it to say so. With no
 * month picked it stays on the current one, which is the figure an owner opens
 * this screen already wanting.
 *
 * Every other filter is deliberately ignored. Narrowing to cash, or to sums
 * over NPR 5,000, is the reader interrogating the list; the figure above it is
 * the total those questions are being asked *of*, and a headline that shrank to
 * match each one would answer none of them.
 *
 * The month is decided in **Nepal** time (`nepalPeriodKey`), not the device's,
 * for the same reason invoice periods are — a phone left on UTC would call the
 * first two hours of the month the previous one, on the busiest rent day there
 * is.
 *
 * It counts by the day the money **landed**, not by the period the invoice is
 * for: a Shrawan payment against Asar's rent is Shrawan's collection, which is
 * the figure the owner is going to compare against their own cash box. See
 * {@link receivedMonth}.
 */
export function statementSummary(
  credits: readonly StatementRow[],
  calendar: CalendarSystem,
  now: Date = new Date(),
  filter: StatementFilter = NO_FILTER,
): StatementSummary {
  const period = nepalPeriodKey(now);
  const months = activeMonthRange(filter) ?? { from: period, to: period };
  const inScope = credits.filter((credit) => {
    const month = receivedMonth(credit);

    // String comparison, not arithmetic: BS period keys are zero-padded
    // `YYYY-MM`, so lexicographic order is chronological order.
    return month !== null && month >= months.from && month <= months.to;
  });

  const totals = splitTotals(inScope);

  return {
    count: totals.inCount,
    out: totals.out,
    outCount: totals.outCount,
    periodLabel: monthRangeLabel(months, calendar),
    total: totals.in,
  };
}

/** Money in and money out over a set of rows, kept apart. */
export function splitTotals(rows: readonly StatementRow[]): {
  in: number;
  inCount: number;
  out: number;
  outCount: number;
} {
  const totals = { in: 0, inCount: 0, out: 0, outCount: 0 };

  for (const row of rows) {
    if (row.debit) {
      totals.out += row.amount;
      totals.outCount += 1;
    } else {
      totals.in += row.amount;
      totals.inCount += 1;
    }
  }

  return totals;
}

/** One BS month on the Reports screen's month-by-month list. */
export type MonthTotals = { in: number; month: string; out: number };

/**
 * Money in and out per BS month (by the day it moved, in Nepal time), newest
 * month first. Undated rows belong to no month and are left out.
 */
export function monthlyTotals(rows: readonly StatementRow[]): MonthTotals[] {
  const byMonth = new Map<string, MonthTotals>();

  for (const row of rows) {
    const month = receivedMonth(row);

    if (!month) {
      continue;
    }

    const entry = byMonth.get(month) ?? { in: 0, month, out: 0 };

    if (row.debit) {
      entry.out += row.amount;
    } else {
      entry.in += row.amount;
    }

    byMonth.set(month, entry);
  }

  return [...byMonth.values()].sort((left, right) => right.month.localeCompare(left.month));
}

/**
 * What a filtered list adds up to — the line under the search field. Net:
 * debits subtract, so a credits-only list sums exactly as it always did.
 */
export function visibleTotal(credits: readonly StatementRow[]): number {
  return credits.reduce((sum, credit) => sum + signedAmount(credit), 0);
}

/**
 * What a row is called — `Rent from Kartik Adhikari`.
 *
 * The period leads because it is what distinguishes two rows for the same
 * resident, and a one-off says so rather than borrowing a month it does not
 * have: an admission fee carries `period: null`, and every month-keyed reader
 * that assumed otherwise has broken on the first resident a hostel takes.
 *
 * An unnamed resident is "a resident", not an empty string — `residentName` is
 * `""` when the record could not be resolved, and a title that starts with a
 * space reads as a rendering fault rather than as missing data.
 */
export function creditTitle(
  credit: StatementCredit,
  calendar: CalendarSystem,
): string {
  if (credit.expense) {
    return expenseTitle(credit.expense);
  }

  const what = credit.period
    ? `${formatPeriodIn(calendar, credit.period)} rent`
    : "One-off charge";

  return `${what} from ${credit.residentName || "a resident"}`;
}

/** Whether the invoice this row sits on is still short. */
export function isPartial(credit: StatementRow): boolean {
  return credit.amount < credit.billed;
}

/**
 * The range a filter describes, in words — `20 Aug 2026 to 26 Aug 2026`.
 *
 * Both open ends are named rather than left blank: "up to 26 Aug 2026" is a
 * range and "26 Aug 2026" on its own is a day, and a reader handed the second
 * when the first was meant will reconcile the wrong week.
 */
export function rangeLabel(
  filter: StatementFilter,
  calendar: CalendarSystem,
): string {
  const from = filter.from ? formatDateIn(calendar, startOfDayIso(filter.from)) : "";
  const to = filter.to ? formatDateIn(calendar, endOfDayIso(filter.to)) : "";

  if (from && to) {
    if (from === to) {
      return from;
    }

    // `Bhadra 4, 2083 BS to Bhadra 10, 2083 BS` says which calendar it is twice
    // in one line. The era marker earns its place on a date standing alone; on
    // the left half of a range the right half has already answered it.
    const lead = to.endsWith(" BS") && from.endsWith(" BS") ? from.slice(0, -3) : from;

    return `${lead} to ${to}`;
  }

  if (from) {
    return `${from} onwards`;
  }

  return to ? `Up to ${to}` : "All time";
}

/**
 * What the share button sends.
 *
 * Pure and free of `react-native`'s `Share`, the same split `lib/hostel-share.ts`
 * takes and for the same reason: Vitest here cannot load that module, and the
 * part worth testing is the words.
 *
 * It describes **what is on screen**, filters included, because that is what the
 * person tapping share is looking at. Sending the lifetime total from a screen
 * filtered to one week would be answering a question nobody asked, and the
 * recipient has no way to tell which they were sent — so the range is stated on
 * its own line rather than implied.
 *
 * No resident names and no invoice ids. This lands in a WhatsApp thread, and a
 * summary is the one shape of this data that carries nothing personal; anyone
 * entitled to the detail can open the screen.
 */
export function statementShareText({
  calendar,
  credits,
  filter,
  hostelName,
}: {
  /*
   * The sender's calendar, so the shared text reads the way the screen they
   * shared it from did. A statement pasted into a thread in the other calendar
   * from the one the owner was looking at is a range nobody can check.
   */
  calendar: CalendarSystem;
  credits: readonly StatementCredit[];
  filter: StatementFilter;
  /** Blank when the caller is a warden scoped to more than one hostel. */
  hostelName: string;
}): string {
  const totals = splitTotals(credits);
  const lines = [
    hostelName ? `${hostelName} — statement` : "Hostel statement",
    rangeLabel(filter, calendar),
    `${totals.inCount} ${totals.inCount === 1 ? "payment" : "payments"} · ${formatMoney(totals.in)} received`,
  ];

  if (totals.outCount > 0) {
    lines.push(
      `${totals.outCount} ${totals.outCount === 1 ? "expense" : "expenses"} · ${formatMoney(totals.out)} spent`,
      `Net ${formatMoney(totals.in - totals.out)}`,
    );
  }

  return lines.join("\n");
}
