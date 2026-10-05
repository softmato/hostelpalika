"use client";

import { CalendarClock, Coins, Layers, PartyPopper, Trash2 } from "lucide-react";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import {
  currency,
  EmptyState,
  Input,
  LoadingRows,
  Panel,
} from "@/app/_components/shared-ui";
import {
  DataTable,
  SoftBadge,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { dayMonthYearBoth, periodKey } from "@/lib/format-month";
import { addBsMonths, bsPeriodBounds } from "@/lib/hostel-day";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { normalizeBedType } from "@/modules/finance/bed-type";
import { BED_TYPE_LABELS, type BedType } from "@hostel/shared/types/bed-type";
import { MonthField } from "./hostel-admin-month-picker";
import { LateFinePanel } from "./khata-pages";
import { Message, PageHeader, field } from "./portal-shared";

/**
 * The rate card editor (target §11.9, plan item 3.2).
 *
 * **This replaces the old Fee Plans page** (deviation §3.4, D2). That page read
 * `roomConfigurations[].monthlyRent` and called it a fee plan, so a hostel had
 * two rate cards on two screens — which is how a hostel bills the wrong amount.
 *
 * For a while afterwards `roomConfigurations[].monthlyRent` survived as the
 * *public listing price* and this was the *billing price*, and they were allowed
 * to differ. That did not survive contact with a hostel: one advertised a single
 * room at 18,000, had 180,000 here, and invoiced a resident 174,000 for their
 * first month. Every screen read its own number correctly and nothing compared
 * them. **There is one price now.** Saving this card writes the public listing,
 * and the profile form no longer accepts a rent.
 *
 * So the boxes below are one per **room type**, not one per bed type. That is
 * the change that makes a single price possible: a bed type is a five-value enum
 * derived from free text, and it cannot express a hostel whose rooms are called
 * `"Shared"` — which is why a second store had to exist.
 *
 * **A schedule is never edited.** Saving closes the current card the day before
 * the new one starts and opens a successor, so an invoice issued in March can
 * still be explained in September.
 */

type Rate = {
  /** Derived, for display only. Absent on a card written before the re-key. */
  bedType?: BedType | null;
  monthlyAmount: number;
  /** The key. Absent on a card written before the re-key. */
  roomType?: string | null;
};

type FeeSchedule = {
  _id: string;
  admissionFee?: number;
  formFee?: number;
  referralAdmissionDiscount?: number;
  depositAmount?: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  rates: Rate[];
  /**
   * Whether these rates are billing residents today, are only booked for a
   * future month, or have finished.
   *
   * Decided by the server, because `effectiveTo === null` is a different
   * question. For the whole month between saving new rates and them starting,
   * the open row is upcoming while a closed row does the billing — reading the
   * open row as "current" told an owner their rates were live when they were
   * not, and the residents were billed at ten times the figure on screen.
   */
  standing?: "current" | "past" | "upcoming";
};

/** A room type the hostel offers, with what its public listing says today. */
type RoomTypeOption = { monthlyRent: number; roomType: string };

/** Matching is case- and punctuation-insensitive, as it is on the server. */
function roomTypeKey(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const SCHEDULES_ENDPOINT = hostelAdminEndpoints.feeSchedules;
const CONCESSIONS_ENDPOINT = hostelAdminEndpoints.rentConcessions;

/**
 * A month the hostel has put on reduced rent — Dashain at half fee.
 *
 * `standing` comes from the server, and `past` is the one that matters on screen:
 * those months are already invoiced and their bills carry the figure they were
 * issued with, so a discount added to them now changes nothing. Saying that is
 * better than refusing the save for a reason nobody can check.
 */
/** What a save or a delete did to bills that had already gone out. */
type ConcessionBackfill = {
  discounted: number;
  invoicesChanged: number;
  invoicesKept: number;
  refundedAsCredit: number;
};

type RentConcession = {
  _id: string;
  label: string;
  percentOff: number;
  period: string;
  reason: string | null;
  standing: "current" | "past" | "upcoming";
};

/**
 * A rate card boundary, named in the calendar the card actually turns over in.
 *
 * ## Two things were wrong with `toLocaleDateString()`
 *
 * It renders in the *browser's* locale, so the same card read `17/09/2026` for
 * the owner and `9/17/2026` for anyone whose machine says `en-US` — the ambiguity
 * `lib/format-month` exists to keep off the finance screens.
 *
 * And it is a bare Gregorian day for a date that is now a **Bikram Sambat month
 * boundary**: `createFeeSchedule` pulls `effectiveFrom` back to `hostelMonthStart`,
 * so a card always begins on the 1st of a BS month and ends on the last day of
 * one. Printed as "17 Sep 2026" that reads as an arbitrary mid-month date an
 * owner never chose, when what actually happened is that the card starts on
 * **Aswin 1**. So the BS date leads and the Gregorian follows it — a rate card
 * boundary is the definition of a date that is money.
 */
function formatDate(value: string | null) {
  return value ? dayMonthYearBoth(value) : "—";
}

/**
 * The **Bikram Sambat** month `n` months out, as a period key.
 *
 * Rates never start mid-month, and the month they start on is a BS one:
 * `createFeeSchedule` runs the submitted date through `hostelMonthStart`, which
 * pulls it back to the first day of the BS month it lands in.
 *
 * That rounding is why the Gregorian date picker here had to go. An owner
 * choosing **1 October 2026** — a perfectly ordinary "from next month" — was
 * handing the server a day inside Aswin 2083, and the card that came back
 * started on **17 September**. Two weeks earlier than the date they picked, over
 * a fortnight they had already billed at the old rate, with nothing on the screen
 * to show it had happened.
 */
function monthStartPeriod(offsetMonths: number) {
  return addBsMonths(periodKey(new Date()), offsetMonths);
}

/**
 * The instant a BS month opens, as `YYYY-MM-DD`, which is what the API takes.
 *
 * `effectiveFrom` on the wire stays a date — the server stores an instant and
 * `z.coerce.date()` parses one. Only the *choosing* moved to months; the picker
 * hands back `2083-06` and this is where that becomes the day Aswin starts.
 */
function periodStartDate(period: string) {
  try {
    return bsPeriodBounds(period).start.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/**
 * Months at reduced rent, on top of the rate card rather than inside it.
 *
 * ## Why this is not another rate card
 *
 * A hostel that takes half fee in Dashain has not changed what a bed costs. Said
 * through the card above it would mean three cards — Aswin at the real rents,
 * Kartik at half, Mangsir back again — and the real rents would then live in two
 * rows that agree only by accident, which is the drift the card's versioning
 * exists to prevent. Here the card is untouched and one row says "this month,
 * 50% off, everybody".
 *
 * ## A percentage, because that is how it is announced
 *
 * Not a rupee figure. The hostel says "half fee", and one percentage then applies
 * correctly to a single room and a dormitory bed at once — and to a resident on a
 * negotiated rate, who is also owed the festival the rest of the building gets.
 *
 * ## The month is picked, not typed
 *
 * `MonthField`, for the same reason the rate card uses it: the month is a Bikram
 * Sambat one, and an owner who means Kartik should not have to work out which
 * Gregorian fortnight that is. Editing is a save over the same month — there is
 * one discount per month by index, so "make it 40" is a correction, not a row.
 */
/**
 * What happened to bills that were already out, in one sentence.
 *
 * Says nothing when nothing was billed yet — that is the ordinary, healthy case
 * (the discount was set before the month's run) and a line reading "0 bills
 * changed" would make it look like a failure.
 *
 * `invoicesKept` is named whenever it is non-zero, because it is the only outcome
 * an owner might otherwise be surprised by: bills with money already settled
 * against them keep their discount rather than being put back up.
 */
function describeApplied(applied: ConcessionBackfill, verb: "reduced" | "restored") {
  if (applied.invoicesChanged === 0 && applied.invoicesKept === 0) {
    return verb === "reduced"
      ? "No bills have gone out for that month yet, so the billing run will charge the reduced rent directly."
      : "No bills had gone out for that month.";
  }

  const parts = [
    `${applied.invoicesChanged} ${applied.invoicesChanged === 1 ? "bill" : "bills"} already issued for that month ${verb === "reduced" ? "reduced" : "put back to full rent"}.`,
  ];

  if (applied.refundedAsCredit > 0) {
    parts.push(
      `${currency(applied.refundedAsCredit)} had already been paid and is now credit against next month.`,
    );
  }

  if (applied.invoicesKept > 0) {
    parts.push(
      `${applied.invoicesKept} ${applied.invoicesKept === 1 ? "bill keeps its" : "bills keep their"} discount because money is already settled against ${applied.invoicesKept === 1 ? "it" : "them"}.`,
    );
  }

  return parts.join(" ");
}

const MonthDiscounts = memo(function MonthDiscounts() {
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const resource = usePortalResource<{ concessions: RentConcession[] }>(
    CONCESSIONS_ENDPOINT,
    { errorMessage: "Could not load the month discounts." },
  );

  const concessions = useMemo(
    () => resource.data?.concessions ?? [],
    [resource.data],
  );

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const percentOff = Number(field(form, "percentOff"));

      if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
        setMessage("Enter a whole percent between 1 and 100.");
        return;
      }

      setSaving(true);
      setMessage("");

      try {
        const saved = await browserApi<{
          concession: RentConcession & { applied: ConcessionBackfill };
        }>(CONCESSIONS_ENDPOINT, {
          body: JSON.stringify({
            percentOff,
            period: field(form, "period"),
            reason: field(form, "reason") || undefined,
          }),
          method: "POST",
        });
        /*
         * The count, not a promise. A month that is already billed has its bills
         * corrected right here, and "saved" alone left an owner to open the Money
         * tab and work out whether anything had happened — which is the whole
         * reason a discount decided after the 1st used to feel broken.
         */
        setMessage(`Saved. ${describeApplied(saved.concession.applied, "reduced")}`);
        await resource.refreshAsync();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not save the discount.",
        );
      } finally {
        setSaving(false);
      }
    },
    [resource],
  );

  const remove = useCallback(
    async (row: RentConcession) => {
      const confirmed = window.confirm(
        `Charge full rent in ${row.label} again? Bills already issued for that month keep the discount they were issued with.`,
      );

      if (!confirmed) {
        return;
      }

      setSaving(true);
      setMessage("");

      try {
        const removed = await browserApi<{ restored: ConcessionBackfill }>(
          `${CONCESSIONS_ENDPOINT}/${row._id}`,
          { method: "DELETE" },
        );
        setMessage(
          `${row.label} is back to full rent. ${describeApplied(removed.restored, "restored")}`,
        );
        await resource.refreshAsync();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not remove the discount.",
        );
      } finally {
        setSaving(false);
      }
    },
    [resource],
  );

  return (
    <Panel title="Festival discounts">
      <Message value={message} />

      <form className="grid gap-4" onSubmit={save}>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <PartyPopper aria-hidden="true" className="size-4" />
          A percentage off every resident&rsquo;s rent, for one month only. The rates
          above do not change &mdash; Dashain at 50% is half of whatever each room
          type already costs.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MonthField
            defaultValue={monthStartPeriod(1)}
            hint="Nepali month. Saving over a month that already has a discount replaces it."
            label="Month"
            name="period"
          />
          <Input
            hint="1&ndash;100. Use 50 for half fee."
            label="Off the rent (%)"
            max="100"
            min="1"
            name="percentOff"
            step="1"
            type="number"
          />
          <Input
            hint="Printed on the resident's bill beside the amount."
            label="Reason"
            name="reason"
            placeholder="Dashain"
          />
          <div className="flex items-end">
            <button
              className="h-11 w-full rounded-md bg-role-admin px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              disabled={saving}
              type="submit"
            >
              {saving ? "Saving…" : "Save discount"}
            </button>
          </div>
        </div>
      </form>

      <div className="mt-5">
        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "ready" && concessions.length === 0 ? (
          <EmptyState label="No month is discounted. Every month is charged at the rates above." />
        ) : null}
        {concessions.length > 0 ? (
          <DataTable className="min-w-[560px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <Th>Month</Th>
                <Th align="right">Off the rent</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th align="right">&nbsp;</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {concessions.map((row) => (
                <TableRow key={row._id}>
                  <TableCell className="whitespace-nowrap font-semibold text-foreground">
                    {row.label}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-foreground">
                    {row.percentOff}%
                  </TableCell>
                  <TableCell>
                    {row.reason ?? <span className="text-muted-foreground">&mdash;</span>}
                  </TableCell>
                  <TableCell>
                    {row.standing === "past" ? (
                      /*
                       * Not an error, and not hidden. The month is billed and its
                       * invoices carry what they were issued with, so the row is
                       * history — labelling it is the honest half of allowing a
                       * discount to be set on a month that has closed.
                       */
                      <SoftBadge tone="slate">Already billed</SoftBadge>
                    ) : row.standing === "current" ? (
                      <SoftBadge tone="green">This month</SoftBadge>
                    ) : (
                      <SoftBadge tone="amber">Upcoming</SoftBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      aria-label={`Remove the ${row.label} discount`}
                      className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                      disabled={saving}
                      onClick={() => void remove(row)}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </DataTable>
        ) : null}
      </div>
    </Panel>
  );
});

export const HostelAdminFeeSchedulePageContent = memo(
  function HostelAdminFeeSchedulePageContent() {
    const [message, setMessage] = useState("");
    const [saving, setSaving] = useState(false);

    const resource = usePortalResource<{
      roomTypes: RoomTypeOption[];
      schedules: FeeSchedule[];
    }>(SCHEDULES_ENDPOINT, { errorMessage: "Could not load the rate card." });

    const schedules = useMemo(
      () => resource.data?.schedules ?? [],
      [resource.data],
    );
    const roomTypes = useMemo(
      () => resource.data?.roomTypes ?? [],
      [resource.data],
    );
    /*
     * What is billing residents today, and what is only booked to. Two different
     * cards for the whole month between saving rates and their month arriving —
     * conflating them is the defect this screen carried.
     */
    const current = useMemo(
      () => schedules.find((schedule) => schedule.standing === "current") ?? null,
      [schedules],
    );
    const upcoming = useMemo(
      () => schedules.find((schedule) => schedule.standing === "upcoming") ?? null,
      [schedules],
    );
    /** The card the form edits: next month's if one is booked, else a new one. */
    const open = upcoming ?? current;

    /** Only rates that have finished. The live ones are shown above, not filed. */
    const pastSchedules = useMemo(
      () => schedules.filter((schedule) => schedule.standing === "past"),
      [schedules],
    );

    /*
     * Every room type the hostel offers *or* has ever priced. A card closed
     * against a room type since renamed still has to show its rents — history
     * that quietly drops a column is history nobody can audit.
     */
    const historyColumns = useMemo(() => {
      const seen = new Map<string, string>();

      for (const option of roomTypes) {
        seen.set(roomTypeKey(option.roomType), option.roomType);
      }

      for (const schedule of schedules) {
        for (const rate of schedule.rates) {
          const label =
            rate.roomType ?? (rate.bedType ? BED_TYPE_LABELS[rate.bedType] : null);

          if (label && !seen.has(roomTypeKey(label))) {
            seen.set(roomTypeKey(label), label);
          }
        }
      }

      return [...seen.values()];
    }, [roomTypes, schedules]);

    /**
     * The rate on the open card for one room type, or blank so nothing is
     * invented. Falls back to the bed type for a card saved before rates were
     * keyed by room type, so an owner opening this screen sees what they set.
     */
    const rateFor = useCallback(
      (roomType: string) => {
        const byRoomType = open?.rates.find(
          (rate) => roomTypeKey(rate.roomType) === roomTypeKey(roomType),
        );

        if (byRoomType) {
          return byRoomType.monthlyAmount;
        }

        const bedType = normalizeBedType(roomType);
        const legacy = bedType
          ? open?.rates.find((rate) => !rate.roomType && rate.bedType === bedType)
          : undefined;

        return legacy?.monthlyAmount ?? "";
      },
      [open],
    );

    /**
     * Drops rates that have not started yet, and lets the current ones carry on.
     *
     * Only ever offered for an upcoming card. One that is billing residents is
     * history — an invoice may already carry its id — and the server refuses it
     * regardless of what the screen shows.
     */
    const removeUpcoming = useCallback(
      async (scheduleId: string) => {
        const confirmed = window.confirm(
          "Delete the rates booked for next month? They have not started, so nothing has been billed from them, and your current rates carry on.",
        );

        if (!confirmed) {
          return;
        }

        setSaving(true);
        setMessage("");

        try {
          await browserApi(`${SCHEDULES_ENDPOINT}/${scheduleId}`, { method: "DELETE" });
          setMessage("Upcoming rates deleted. Your current rates carry on.");
          await resource.refreshAsync();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not delete those rates.",
          );
        } finally {
          setSaving(false);
        }
      },
      [resource],
    );

    const save = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        // A blank box means "not priced yet", not "free". Sending a zero would
        // price it at nothing; omitting it makes billing fail loudly and name
        // the resident it could not price, which is the rule.
        const rates = roomTypes
          .map((option) => ({
            monthlyAmount: field(form, `rate-${option.roomType}`),
            roomType: option.roomType,
          }))
          .filter((entry) => entry.monthlyAmount !== "")
          .map((entry) => ({
            monthlyAmount: Number(entry.monthlyAmount),
            roomType: entry.roomType,
          }));

        if (rates.length === 0) {
          setMessage("Set a rate for at least one room type.");
          return;
        }

        setSaving(true);
        setMessage("");

        try {
          await browserApi(SCHEDULES_ENDPOINT, {
            body: JSON.stringify({
              formFee: field(form, "formFee") ? Number(field(form, "formFee")) : 0,
              admissionFee: field(form, "admissionFee")
                ? Number(field(form, "admissionFee"))
                : undefined,
              depositAmount: field(form, "depositAmount")
                ? Number(field(form, "depositAmount"))
                : undefined,
              // The field holds a BS period key; the API takes the instant that
              // month opens on. Converting here rather than posting the key
              // keeps `effectiveFrom` the date it has always been on the wire.
              effectiveFrom: periodStartDate(field(form, "effectiveFrom")),
              rates,
              referralAdmissionDiscount: field(form, "referralAdmissionDiscount")
                ? Number(field(form, "referralAdmissionDiscount"))
                : undefined,
            }),
            method: "POST",
          });

          setMessage(
            "New rate card saved. Your public listing now shows these rents, and the previous card is closed and stays readable below.",
          );
          await resource.refreshAsync();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save the rate card.",
          );
        } finally {
          setSaving(false);
        }
      },
      [resource, roomTypes],
    );

    return (
      <div className="mx-auto max-w-[1100px] space-y-6">
        <PageHeader
          description="The one place a rent is set. Your public listing is written from this card, and every invoice is computed from the card that was open on its billing date."
          icon={Coins}
          title="Fee Schedule"
        />
        <Message value={message} />

        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="The rate card could not be loaded." />
        ) : null}

        {resource.state === "ready" ? (
          <>
            {current ? null : (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300">
                <p className="font-semibold">
                  {upcoming
                    ? "No rates are running this month."
                    : "This hostel has no rate card."}
                </p>
                <p className="mt-1 leading-5">
                  {upcoming
                    ? `Billing fails for every resident until ${formatDate(upcoming.effectiveFrom)}, when the rates below start. Rates already running cannot be changed, so this gap has to be filled by the platform team.`
                    : "Billing will fail for every resident until one exists — deliberately, because a guessed rate is worse than a run that stops and says why."}
                </p>
              </div>
            )}

            {upcoming ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
                <p className="leading-5">
                  <span className="font-semibold text-foreground">
                    Rates are booked for {formatDate(upcoming.effectiveFrom)}.
                  </span>{" "}
                  They have not started, so you can change them below or delete them.
                </p>
                <button
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm font-semibold text-destructive transition hover:bg-destructive/20 disabled:opacity-60"
                  disabled={saving}
                  onClick={() => void removeUpcoming(upcoming._id)}
                  type="button"
                >
                  Delete these rates
                </button>
              </div>
            ) : null}

            <Panel
              title={
                upcoming
                  ? "Change next month's rates"
                  : current
                    ? "Set rates for a future month"
                    : "Set your first rates"
              }
            >
              <form className="grid gap-4" key={open?._id ?? "new"} onSubmit={save}>
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Layers aria-hidden="true" className="size-4" />
                  One rate per room type you offer. A blank is not free — billing
                  stops and names the resident it could not price.
                </p>
                {roomTypes.length === 0 ? (
                  <EmptyState label="Add your room types on the hostel profile first — a rate is set against one." />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {roomTypes.map((option) => {
                      const bedType = normalizeBedType(option.roomType);

                      return (
                        <Input
                          defaultValue={rateFor(option.roomType)}
                          /*
                           * The rent the public page shows today, printed under
                           * the box. Nothing used to put these two numbers on one
                           * screen, which is exactly how 18,000 on a listing and
                           * 180,000 on a card went unnoticed for a month. After
                           * saving they are the same number by construction.
                           */
                          hint={
                            option.monthlyRent > 0
                              ? `Listed at ${currency(option.monthlyRent)}${bedType ? ` · ${BED_TYPE_LABELS[bedType]}` : ""}`
                              : bedType
                                ? BED_TYPE_LABELS[bedType]
                                : "No listed price yet"
                          }
                          key={option.roomType}
                          label={`${option.roomType} (NPR / month)`}
                          min="0"
                          name={`rate-${option.roomType}`}
                          step="1"
                          type="number"
                        />
                      );
                    })}
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <Input
                    defaultValue={open?.admissionFee ?? ""}
                    hint="One-time charge at move-in. Blank if you do not levy one."
                    label="Admission fee (NPR)"
                    min="0"
                    name="admissionFee"
                    type="number"
                  />
<Input
                    defaultValue={open?.formFee ?? ""}
                    hint="One-time form charge, separate from admission. Blank means no fee."
                    label="Form fee (NPR)"
                    min="0"
                    name="formFee"
                    type="number"
                  />
                  <Input
                    defaultValue={open?.referralAdmissionDiscount ?? ""}
                    hint="Comes off the admission fee when someone arrives on a resident's referral code. Never off the rent."
                    label="Referral discount (NPR)"
                    min="0"
                    name="referralAdmissionDiscount"
                    type="number"
                  />
                  <Input
                    defaultValue={open?.depositAmount ?? ""}
                    hint="Refundable security deposit."
                    label="Deposit (NPR)"
                    min="0"
                    name="depositAmount"
                    type="number"
                  />
                  <MonthField
                    defaultValue={
                      upcoming
                        ? periodKey(new Date(upcoming.effectiveFrom))
                        : monthStartPeriod(1)
                    }
                    hint="Rates start on the first day of a Nepali month. This month cannot change — those residents are already being billed."
                    label="Starts from"
                    name="effectiveFrom"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    className="rounded-md bg-role-admin px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                    disabled={saving}
                    type="submit"
                  >
                    {saving ? "Saving…" : "Save new rate card"}
                  </button>
                </div>
              </form>
            </Panel>

            <MonthDiscounts />
            <LateFinePanel />

            <Panel title="Past rates">
              {pastSchedules.length === 0 ? (
                <EmptyState label="No rates have finished yet." />
              ) : (
                <DataTable className="min-w-[680px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <Th>Effective</Th>
                      {historyColumns.map((roomType) => (
                        <Th align="right" key={roomType}>
                          {roomType}
                        </Th>
                      ))}
                      <Th align="right">Deposit</Th>
                      <Th>Status</Th>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pastSchedules.map((schedule) => (
                      <TableRow key={schedule._id}>
                        <TableCell className="whitespace-nowrap font-semibold text-foreground">
                          <span className="flex items-center gap-1.5">
                            <CalendarClock
                              aria-hidden="true"
                              className="size-3.5 text-muted-foreground"
                            />
                            {formatDate(schedule.effectiveFrom)} →{" "}
                            {formatDate(schedule.effectiveTo)}
                          </span>
                        </TableCell>
                        {historyColumns.map((roomType) => {
                          const bedType = normalizeBedType(roomType);
                          const rate =
                            schedule.rates.find(
                              (entry) =>
                                roomTypeKey(entry.roomType) === roomTypeKey(roomType),
                            ) ??
                            // A card closed before rates were keyed by room type
                            // still has to be readable — that is the whole point
                            // of keeping history.
                            (bedType
                              ? schedule.rates.find(
                                  (entry) => !entry.roomType && entry.bedType === bedType,
                                )
                              : undefined);

                          return (
                            <TableCell className="text-right" key={roomType}>
                              {rate ? (
                                currency(rate.monthlyAmount)
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-right">
                          {schedule.depositAmount
                            ? currency(schedule.depositAmount)
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <SoftBadge tone="slate">Finished</SoftBadge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </DataTable>
              )}
            </Panel>
          </>
        ) : null}
      </div>
    );
  },
);
