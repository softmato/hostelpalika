import { LogOut } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import {
  getMoveOutChecklist,
  type LastMonthCharge,
  type MoveOutChecklist,
  type MoveOutPreview,
  saveMoveOutChecklist,
  writeOffResidentDues,
} from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import { dayInputFromNow, parseDayInput } from "@/lib/manage-dates";
import { toastError, toastSuccess } from "@/lib/toast";

type DepositDecision = "APPROVED" | "PARTIAL" | "FORFEITED" | "PENDING";
type Dues = "KEEP" | "WRITE_OFF";

const DEPOSIT_OPTIONS = [
  { label: "Return all", value: "APPROVED" },
  { label: "Return part", value: "PARTIAL" },
  { label: "Keep", value: "FORFEITED" },
  { label: "Later", value: "PENDING" },
] as const;

const DUES_OPTIONS = [
  { label: "Write off", value: "WRITE_OFF" },
  { label: "Keep as owed", value: "KEEP" },
] as const;

type Resident = {
  depositAmount: number;
  firstName: string;
  id: string;
  status: string;
};

/**
 * Moving somebody out (docs/FIELD_FIXES_2026_10.md §1): the day, how the
 * leaving month is charged, what happens to anything unpaid, and the deposit.
 * Every figure is the server's preview for the day picked — nothing is worked
 * out on the phone.
 *
 * Once they have left, the same sheet settles the deposit and can write off
 * what they still owe.
 */
export function MoveOutSheet({
  checklist,
  onClose,
  onDone,
  open,
  owed,
  resident,
}: {
  checklist: MoveOutChecklist | null;
  onClose: () => void;
  onDone: () => void;
  open: boolean;
  /** What they owe now, from the resident record. */
  owed: number | null;
  resident: Resident;
}) {
  const gone = resident.status === "MOVED_OUT";
  const [date, setDate] = useState(() => dayInputFromNow(0));
  /** The preview, and the day it was read for. */
  const [fetched, setFetched] = useState<{ date: string; preview: MoveOutPreview | null } | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [charge, setCharge] = useState<LastMonthCharge | null>(null);
  const [dues, setDues] = useState<Dues>("WRITE_OFF");
  const [deposit, setDeposit] = useState<DepositDecision>("APPROVED");
  const [partAmount, setPartAmount] = useState("");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);

  // Each opening starts from what is on file.
  if (open && !seeded) {
    setSeeded(true);
    setDate(dayInputFromNow(0));
    setCharge(null);
    setDues("WRITE_OFF");
    setDeposit((checklist?.depositRefundDecision as DepositDecision) ?? "APPROVED");
    setPartAmount(
      checklist?.depositRefundDecision === "PARTIAL" ? String(checklist.depositRefundAmount) : "",
    );
    setWhy(checklist?.damageNotes ?? "");
  }

  if (!open && seeded) setSeeded(false);

  // The preview follows the day; a half-typed date waits.
  useEffect(() => {
    if (!open || gone || !parseDayInput(date)) return;

    let live = true;

    getMoveOutChecklist(resident.id, date)
      .then((result) => {
        if (!live) return;
        setFetched({ date, preview: result.preview ?? null });
        setCharge((current) => current ?? result.preview?.defaultCharge ?? "TILL_DAY");
      })
      .catch(() => live && setFetched({ date, preview: null }));

    return () => {
      live = false;
    };
  }, [date, gone, open, resident.id]);

  const preview = fetched?.preview ?? null;
  const loading = fetched?.date !== date;

  const chosen: LastMonthCharge = charge ?? preview?.defaultCharge ?? "TILL_DAY";
  const owedAfter = gone ? (owed ?? 0) : (preview?.owedAfter[chosen] ?? owed ?? 0);
  const paidBack = gone ? 0 : (preview?.paidBack[chosen] ?? 0);
  const hasDeposit = resident.depositAmount > 0;
  const holdsBack = deposit === "PARTIAL" || deposit === "FORFEITED";

  const submit = useCallback(async () => {
    const decision: DepositDecision = hasDeposit ? deposit : "APPROVED";
    const part = Number(partAmount.replace(/[^\d]/g, ""));

    if (decision === "PARTIAL" && !(part > 0)) {
      toastError("How much goes back?", "Type the amount to return, or pick Keep.");
      return;
    }

    if (!gone && !parseDayInput(date)) {
      toastError("Check the day", "Write it as YYYY-MM-DD.");
      return;
    }

    setBusy(true);

    try {
      await saveMoveOutChecklist(resident.id, {
        damageNotes: holdsBack ? why.trim() || undefined : undefined,
        depositRefundAmount: decision === "PARTIAL" ? part : 0,
        depositRefundDecision: decision,
        ...(gone
          ? {}
          : {
              dues: owedAfter > 0 ? dues : "KEEP",
              lastMonthCharge: chosen,
              moveOutDate: date,
            }),
      });
      toastSuccess(gone ? "Deposit updated" : `${resident.firstName} has moved out`);
      onClose();
      onDone();
    } catch (error) {
      toastError("That did not work", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [chosen, date, deposit, dues, gone, hasDeposit, holdsBack, onClose, onDone, owedAfter, partAmount, resident, why]);

  const writeOff = useCallback(() => {
    openConfirm({
      confirmLabel: "Write off",
      destructive: true,
      message: `${formatMoney(owed ?? 0)} leaves the hostel's totals. Their bills show it as written off.`,
      onConfirm: async () => {
        try {
          await writeOffResidentDues(resident.id);
          toastSuccess("Written off");
          onClose();
          onDone();
        } catch (error) {
          toastError("Could not write off", readApiError(error));
        }
      },
      title: `Let go of what ${resident.firstName} owes?`,
    });
  }, [onClose, onDone, owed, resident]);

  return (
    <Sheet
      footer={
        <Button
          icon={gone ? undefined : LogOut}
          label={gone ? "Save" : "Move out"}
          loading={busy}
          onPress={() => void submit()}
          variant={gone ? "primary" : "danger"}
        />
      }
      onClose={onClose}
      open={open}
      tall
      title={gone ? "Deposit" : `Move out ${resident.firstName}`}
    >
      <View className="gap-4 pb-2">
        {gone ? null : (
          <Input
            hint={preview?.dateLabel || undefined}
            label="Leaving on"
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            value={date}
          />
        )}

        {gone ? null : (
          <View className="gap-2">
            <Text variant="label">{preview ? `Last month · ${preview.periodLabel}` : "Last month"}</Text>
            <Segmented
              onChange={setCharge}
              options={[
                { label: "Full month", value: "FULL_MONTH" },
                { label: "Till the day", value: "TILL_DAY" },
              ]}
              value={chosen}
            />
            {loading && !preview ? (
              <Skeleton height={44} radius={14} />
            ) : preview?.lastMonth ? (
              <Text variant="caption">
                {chosen === "FULL_MONTH"
                  ? `${formatMoney(preview.lastMonth.FULL_MONTH)} for the whole month.`
                  : `${formatMoney(preview.lastMonth.TILL_DAY)} for ${preview.stayed} of ${preview.billedDays} days.`}
              </Text>
            ) : (
              <Text variant="caption">This month is billed this way when they leave.</Text>
            )}
          </View>
        )}

        <View className="rounded-2xl border border-border bg-card px-3 py-1">
          <FactRow
            label="Still unpaid"
            value={owedAfter > 0 ? <Money owed value={owedAfter} /> : "Nothing"}
          />
          {paidBack > 0 ? (
            <>
              <RowDivider />
              <FactRow label="Back to them as credit" value={<Money value={paidBack} />} />
            </>
          ) : null}
          <RowDivider />
          <FactRow
            label="Deposit held"
            value={hasDeposit ? <Money value={resident.depositAmount} /> : "None"}
          />
        </View>

        {!gone && owedAfter > 0 ? (
          <View className="gap-2">
            <Text variant="label">Unpaid</Text>
            <Segmented onChange={setDues} options={DUES_OPTIONS} value={dues} />
            <Text variant="caption">
              {dues === "WRITE_OFF"
                ? "Let go: it leaves the dashboard, Money and every total."
                : "Stays on their record as owed."}
            </Text>
          </View>
        ) : null}

        {gone && (owed ?? 0) > 0 ? (
          <Button label={`Write off ${formatMoney(owed ?? 0)}`} onPress={writeOff} variant="outline" />
        ) : null}

        {hasDeposit ? (
          <View className="gap-2">
            <Text variant="label">Deposit</Text>
            <Segmented onChange={setDeposit} options={DEPOSIT_OPTIONS} value={deposit} />
          </View>
        ) : null}

        {hasDeposit && deposit === "PARTIAL" ? (
          <Input
            keyboardType="number-pad"
            label="Amount to return (NPR)"
            onChangeText={setPartAmount}
            value={partAmount}
          />
        ) : null}

        {hasDeposit && holdsBack ? (
          <Input
            label="Why it is held back"
            multiline
            onChangeText={setWhy}
            placeholder="Broken chair, unpaid rent, lost key"
            style={{ height: 72 }}
            value={why}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
