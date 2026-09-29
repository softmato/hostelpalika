import { Percent, Tag } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { PaymentMonthStrip } from "@/components/payment-months";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  type ConcessionBackfill,
  deleteRentConcession,
  type RentConcession,
  saveRentConcession,
} from "@/lib/admin-manage-api";
import { type AdminFinanceData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney, nepalPeriodKey } from "@/lib/format";
import { monthWindow } from "@/lib/payment-months";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Festival discounts — a month at reduced rent, on top of the rates.
 *
 * The list is the screen; the form is a sheet behind **Add a discount** or a
 * row's **Change**, so an owner checking which months are discounted is not
 * scrolling past an empty form to find out.
 *
 * ## It is not a second rate card, and the screen has to make that obvious
 *
 * A hostel taking half fee in Dashain has not changed what a bed costs. Said
 * through `finance/rates` it would take three cards to express one festival —
 * Aswin at the real rents, Kartik at half, Mangsir back again — and the real
 * rents would then live in two rows that agree only by accident. So this screen
 * never shows a rupee figure: it shows a month, a percentage and a word, and the
 * rents stay where an owner already knows to look for them.
 *
 * ## The month is the app's own month strip
 *
 * `<PaymentMonthStrip>` — the same control the Money tab picks a month with, fed
 * by `monthWindow` instead of the server's billed-period roll-up. Not the
 * `YYYY-MM-DD` box `finance/rates` uses, because the thing being named here is a
 * **Bikram Sambat month** and nothing else, and not a `Select` either: that was
 * the first attempt and it was wrong twice over. Its list ran downwards from a
 * year ahead and its rows were labelled by month name alone, so during Aswin the
 * top row read *Aswin* and set Aswin of the following year — the row came back
 * badged **Upcoming** and the badge was the only honest thing on the screen.
 *
 * The strip is what the rest of the app already uses and it does not have that
 * hole: the year is on the chip, the current month is lit and first, and the line
 * underneath names the selection in the reader's own calendar. The chips under
 * the percentage are the three answers hostels actually give; the box is there
 * for the fourth.
 *
 * ## A row already billed is labelled, not hidden
 *
 * Those months' invoices carry the amount and the words they were issued with,
 * so a discount set on one changes no money. Refusing the save would be a screen
 * saying no for a reason nobody can check; the badge says the month is done.
 *
 * ## Editing is saving the same month again
 *
 * There is one discount per month by index, so a row's **Change** simply seeds
 * the form with it — no second endpoint, no draft state, and no way to end up
 * with two answers for one Kartik.
 */

/** The three a hostel actually announces. The box takes anything else. */
const QUICK_PERCENTS = [25, 50, 100];

/**
 * What happened to bills that had already gone out, as a toast's second line.
 *
 * Empty when nothing was billed yet, which is the ordinary case and the healthy
 * one: the discount was set before the month's run, so the run will charge the
 * reduced rent directly and there was nothing to correct. A line reading "0 bills
 * changed" would make that look like a failure.
 *
 * `invoicesKept` is spoken whenever it is non-zero, because it is the one outcome
 * an owner would otherwise be surprised by — a bill with money already settled
 * against it keeps its discount instead of going back up.
 */
function appliedNote(applied: ConcessionBackfill, verb: "reduced" | "restored") {
  const parts: string[] = [];

  if (applied.invoicesChanged > 0) {
    parts.push(
      `${applied.invoicesChanged} ${applied.invoicesChanged === 1 ? "bill" : "bills"} already sent out ${verb === "reduced" ? "reduced" : "back to full rent"}.`,
    );
  }

  if (applied.refundedAsCredit > 0) {
    parts.push(`${formatMoney(applied.refundedAsCredit)} became credit for next month.`);
  }

  if (applied.invoicesKept > 0) {
    parts.push(
      `${applied.invoicesKept} ${applied.invoicesKept === 1 ? "bill keeps its" : "bills keep their"} discount — already part paid.`,
    );
  }

  return parts.join(" ");
}

export default function ManageMonthDiscountsScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();

  /*
   * The finance screen's own read, not a key of its own.
   *
   * `finance/index` already loads the discounts to draw its summary rows, and a
   * separate key here would mean the list arriving twice on the way in and the
   * summary going stale on the way out. One key, revalidated on refocus, and a
   * save shows up on both screens with nothing wired between them.
   */
  const query = adminQuery.finance();
  const finance = useResource<AdminFinanceData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const concessions = finance.data?.concessions ?? null;

  const [busy, setBusy] = useState<"delete" | "save" | null>(null);
  /*
   * This month, not the next one.
   *
   * `finance/rates` defaults to next month because rates *cannot* start in the
   * current one — `FEE_SCHEDULE_MONTH_LOCKED` refuses it. A discount has no such
   * rule and the common case is the opposite: the festival is now, the bills are
   * already out, and the correction is what this screen is for.
   */
  const [period, setPeriod] = useState(() => nepalPeriodKey());
  const [percentOff, setPercentOff] = useState("");
  const [reason, setReason] = useState("");
  /** The row whose sheet is open. Null is "no sheet". */
  const [acting, setActing] = useState<RentConcession | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  /*
   * This month, the year ahead and the year behind — the window, not the
   * server's billed periods. `paymentMonths` is right for the Money tab, which
   * can only show a month it has invoices for; a discount is most often set on a
   * month nothing has been billed for yet.
   */
  const months = useMemo(() => monthWindow(), []);

  /** The discount already on the month in the picker, if any. */
  const existing = useMemo(
    () => (concessions ?? []).find((row) => row.period === period) ?? null,
    [concessions, period],
  );

  const save = useCallback(async () => {
    const percent = Number(percentOff.trim());

    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      toastError("Check the percentage", "A whole number from 1 to 100.");
      return;
    }

    setBusy("save");

    try {
      const saved = await saveRentConcession({
        percentOff: percent,
        period,
        reason: reason.trim() || undefined,
      });

      /*
        Written into `admin:finance` before the back navigation, because the
        POST answers with the concession it saved. Without it the list this
        screen returns to shows the old month until its focus revalidate lands,
        which reads as the save not having taken.
      */
      finance.setData((current) =>
        current
          ? {
              ...current,
              concessions: [
                saved,
                ...(current.concessions ?? []).filter(
                  (entry) => entry._id !== saved._id,
                ),
              ],
            }
          : current,
      );
      toastSuccess(
        `${dates.periodMonth(period)} is ${percent}% off`,
        appliedNote(saved.applied, "reduced") ||
          "The billing run will charge the reduced rent.",
      );
      setFormOpen(false);
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setBusy(null);
    }
  }, [dates, finance, percentOff, period, reason]);

  /** Loads a row into the form. The save then replaces that same month. */
  const edit = useCallback((row: RentConcession) => {
    setActing(null);
    setPeriod(row.period);
    setPercentOff(String(row.percentOff));
    setReason(row.reason ?? "");
    setFormOpen(true);
  }, []);

  const add = useCallback(() => {
    setPeriod(nepalPeriodKey());
    setPercentOff("");
    setReason("");
    setFormOpen(true);
  }, []);

  const remove = useCallback(
    (row: RentConcession) => {
      setActing(null);
      openConfirm({
        confirmLabel: "Charge full rent",
        destructive: true,
        message: `${row.label} goes back to the rates on your rate card. Bills nobody has paid yet go back up; any bill with money already against it keeps its discount.`,
        onConfirm: async () => {
          setBusy("delete");

          try {
            const removed = await deleteRentConcession(row._id);

            /*
              The DELETE names the row it removed, so the list closes over the
              gap immediately. `restored` is about bills, which this payload does
              not carry — it is the toast's business, not the screen's.
            */
            finance.setData((current) =>
              current
                ? {
                    ...current,
                    concessions:
                      current.concessions?.filter(
                        (entry) => entry._id !== removed.deletedId,
                      ) ?? null,
                  }
                : current,
            );
            toastSuccess(
              `${row.label} is back to full rent`,
              appliedNote(removed.restored, "restored") || undefined,
            );
          } catch (error) {
            toastError("Could not remove it", readApiError(error));
          } finally {
            setBusy(null);
          }
        },
        title: `Remove the ${row.label} discount?`,
      });
    },
    [finance],
  );

  const header = (
    <AppBar
      accent
      centerTitle
      showBack
      title="Festival discounts"
    />
  );

  if (finance.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonRows rows={3} />
        </View>
      </Screen>
    );
  }

  if (finance.error) {
    return (
      <Screen header={header}>
        <ErrorState message={finance.error} onRetry={finance.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      footer={<Button label="Add a discount" onPress={add} />}
      header={header}
      onRefresh={finance.refresh}
      refreshing={finance.refreshing}
      scroll
    >
      <View className="pt-1">
        {concessions === null || concessions.length === 0 ? (
          <EmptyCard
            description="Take a percentage off one month — Dashain at half rent."
            title="Every month is at full rent"
          />
        ) : (
          <Card padding="px-4 py-1">
            {concessions.map((row, index) => (
              <View key={row._id}>
                {index > 0 ? <RowDivider inset /> : null}
                <ListRow
                  icon="gift-outline"
                  iconBgColor={row.standing === "past" ? "#8E8E93" : "#FF9500"}
                  onPress={() => setActing(row)}
                  right={
                    <Badge
                      label={
                        row.standing === "past"
                          ? "Billed"
                          : row.standing === "current"
                            ? "This month"
                            : "Upcoming"
                      }
                      tone={
                        row.standing === "past"
                          ? "neutral"
                          : row.standing === "current"
                            ? "success"
                            : "warning"
                      }
                    />
                  }
                  subtitle={row.reason ?? undefined}
                  title={`${row.label} · ${row.percentOff === 100 ? "Free" : `${row.percentOff}% off`}`}
                />
              </View>
            ))}
          </Card>
        )}
      </View>

      <Sheet
        footer={
          <Button
            disabled={busy === "delete"}
            label={existing ? "Replace this month" : "Save discount"}
            loading={busy === "save"}
            onPress={() => void save()}
          />
        }
        onClose={() => setFormOpen(false)}
        open={formOpen}
        title="Discount a month"
      >
        <View className="gap-3 pb-2">
          <View className="-mx-5">
            <PaymentMonthStrip months={months} onSelect={setPeriod} value={period} />
          </View>
          <View className="flex-row gap-2">
            {QUICK_PERCENTS.map((value) => {
              const active = percentOff === String(value);

              return (
                <Chip
                  key={value}
                  label={value === 100 ? "Free month" : `${value}% off`}
                  onPress={() => setPercentOff(String(value))}
                  tone={active ? "brand" : "neutral"}
                />
              );
            })}
          </View>
          <Input
            keyboardType="number-pad"
            label="Or type a percentage"
            leading={<Percent color={colors.mutedForeground} size={18} />}
            onChangeText={setPercentOff}
            placeholder="%"
            value={percentOff}
          />
          <Input
            hint="Printed on the bill."
            label="Reason"
            leading={<Tag color={colors.mutedForeground} size={18} />}
            onChangeText={setReason}
            placeholder="Dashain"
            value={reason}
          />
          {existing ? (
            <Text variant="caption">
              {`${existing.label} is already ${existing.percentOff}% off — saving replaces it.`}
            </Text>
          ) : null}
        </View>
      </Sheet>

      {/*
        Two actions on one row, so a sheet — an anchored menu is not the vocabulary
        this app uses, and a row that did one of the two on tap would do the wrong
        one half the time.
      */}
      <Sheet
        onClose={() => setActing(null)}
        open={acting !== null}
        title={acting?.label ?? ""}
      >
        {acting ? (
          <View className="gap-1">
            <SheetRow
              label="Change this month"
              onPress={() => edit(acting)}
              subtitle={`Currently ${acting.percentOff}% off`}
            />
            <SheetRow
              label="Charge full rent again"
              onPress={() => remove(acting)}
              subtitle={
                acting.standing === "past"
                  ? "That month is billed — its bills do not change"
                  : undefined
              }
            />
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
