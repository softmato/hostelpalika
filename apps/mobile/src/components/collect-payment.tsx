import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { Easing, FadeIn, LinearTransition, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { BillBreakdown } from "@/components/bill-extras";
import { CopyButton } from "@/components/pay-methods";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletMark } from "@/components/ui/wallet-mark";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { readApiError } from "@/lib/api-contract";
import {
  getPaymentProfile,
  getResidentLedger,
  type PaymentProfile,
  recordCashPayment,
  type ResidentLedger,
} from "@/lib/admin-manage-api";
import { formatMoney } from "@/lib/format";
import { type DeskMethod, deskMethods, LABEL, SERVER_METHOD, unpaidMonths } from "@/lib/desk-collect";
import { fileAssetUrl } from "@/lib/finance-api";

/**
 * Collect a payment at the desk (todo E1–E6). Everything still unpaid, one row
 * per month; tick months, pick Cash or one of the hostel's own online methods,
 * and one button. An online method opens its QR / number inside the sheet.
 * Same rules as web Record payment: one cash call per bill, oldest first.
 */
export function CollectPayment({
  bill,
  collectedBy,
  onDone,
  onWaiveFine,
  residentId,
  slip,
}: {
  /** The month this sheet was opened from, if it was billed. Its lines head the receipt. */
  bill?: {
    dueAmount: number;
    id: string;
    lines?: { amount: number; basis: string; description: string }[] | null;
    paidAmount: number;
    status: string;
  };
  onWaiveFine?: () => void;
  collectedBy: string;
  onDone: (result: { amount: number; pending: boolean }) => void;
  residentId: string;
  slip: string;
}) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  const [ledger, setLedger] = useState<ResidentLedger | null>(null);
  const [profile, setProfile] = useState<PaymentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [ticked, setTicked] = useState<string[] | null>(null);
  const [method, setMethod] = useState<DeskMethod>("CASH");
  const [amountText, setAmountText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The undo window after Collect is tapped: the button turns into Cancel and counts down.
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getResidentLedger(residentId).catch(() => null), getPaymentProfile().catch(() => null)]).then(
      ([nextLedger, nextProfile]) => {
        if (!active) return;
        setLedger(nextLedger);
        setProfile(nextProfile);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [residentId]);

  const months = useMemo(() => unpaidMonths(ledger), [ledger]);
  const chosen = ticked ?? months.slice(0, 1).map((month) => month.period);
  const bills = months.filter((month) => chosen.includes(month.period));
  const balance = bills.reduce((sum, month) => sum + month.dueAmount - month.paidAmount, 0);
  const amount = amountText === null ? balance : Number(amountText) || 0;
  const methods = deskMethods(profile);

  if (loading) {
    return (
      <View className="gap-3 border-t border-border pt-4">
        <Skeleton height={28} width="40%" />
        <Skeleton height={104} radius={12} />
        <Skeleton height={48} radius={12} />
      </View>
    );
  }

  const receiptBill = bill ? (
    <BillBreakdown
      dueAmount={bill.dueAmount}
      lines={bill.lines}
      onWaiveFine={bill.status !== "PAID" ? onWaiveFine : undefined}
      paidAmount={bill.paidAmount}
    />
  ) : null;

  if (months.length === 0) {
    return receiptBill ? (
      <View className="rounded-2xl border border-border bg-card px-4 py-3">{receiptBill}</View>
    ) : (
      <View className="border-t border-border pt-4">
        <Text variant="muted">Nothing unpaid.</Text>
      </View>
    );
  }

  // One unpaid month that is the one opened is already the receipt; the tick
  // list only appears when there is a choice to make, or no bill to show.
  const openMonthUnpaid = bill ? months.some((month) => month.invoiceId === bill.id) : false;
  const showMonths = months.length > 1 || !openMonthUnpaid;
  const dashed = { borderColor: colors.border, borderStyle: "dashed", borderTopWidth: 1 } as const;

  const toggle = (period: string) => {
    setAmountText(null);
    setTicked(chosen.includes(period) ? chosen.filter((value) => value !== period) : [...chosen, period]);
  };

  const start = () => {
    if (!Number.isInteger(amount) || amount <= 0 || amount > balance) {
      setError(`Enter 1 to ${formatMoney(balance)}.`);
      return;
    }
    setError(null);
    setArming(true);
  };

  const collect = async () => {
    setBusy(true);
    let left = amount;
    let pending = false;
    try {
      // Oldest first, like web: a part payment clears the oldest months.
      for (const bill of bills) {
        const pay = Math.min(left, bill.dueAmount - bill.paidAmount);
        if (pay <= 0) break;
        const result = await recordCashPayment(bill.invoiceId!, {
          amount: pay,
          cashReceiptNumber: bills.length > 1 ? `${slip}-${bill.period}` : slip,
          collectedBy,
          method: SERVER_METHOD[method],
        });
        pending ||= result.pendingApproval;
        left -= pay;
      }
      onDone({ amount, pending });
    } catch (caught) {
      setError(readApiError(caught));
      // A bill before the failed one may already be saved: read the ledger again
      // so a retry never collects the same month twice.
      if (left < amount) {
        setLedger(await getResidentLedger(residentId).catch(() => ledger));
        setTicked(null);
        setAmountText(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Animated.View className="gap-4" layout={LinearTransition.duration(220)}>
      {/* Frozen while the undo timer runs, so what is collected is what was on screen. */}
      <View className="gap-4" pointerEvents={arming ? "none" : "auto"}>
      {/* The receipt: every figure in one strip, the total last. */}
      <View className="rounded-2xl border border-border bg-card px-4 py-3">
        {receiptBill}

        {showMonths ? (
          <View className="gap-1" style={bill ? [dashed, { marginTop: 12, paddingTop: 8 }] : undefined}>
            <Text variant="caption">{months.length === 1 ? "Month due" : "Months due · tick to collect"}</Text>
            {months.map((month) => {
              const on = chosen.includes(month.period);
              return (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  className="min-h-[48px] flex-row items-center gap-3 active:opacity-70"
                  key={month.period}
                  onPress={() => toggle(month.period)}
                >
                  <Glyph color={on ? colors.primary : colors.mutedForeground} name={on ? "checkbox" : "square"} size={20} />
                  <View className="flex-1">
                    <Text variant="label">{dates.period(month.period)}</Text>
                    {month.referenceCode ? <Text variant="caption">{month.referenceCode}</Text> : null}
                  </View>
                  <Money value={month.dueAmount - month.paidAmount} />
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View
          className="flex-row items-end justify-between"
          style={[dashed, { marginTop: 12, paddingTop: 10 }]}
        >
          <View>
            <Text variant="subtitle">Total</Text>
            {showMonths ? (
              <Text variant="caption">{bills.length === 1 ? "1 month" : `${bills.length} months`}</Text>
            ) : null}
          </View>
          <Money size="large" value={amount} />
        </View>
      </View>

      {methods.length > 1 ? (
        <View className="flex-row flex-wrap gap-2">
          {methods.map((key) => {
            const on = key === method;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                className={`min-h-12 flex-row items-center gap-2 rounded-full border py-1.5 pl-2 pr-4 ${on ? "border-primary bg-brand-soft" : "border-border"}`}
                key={key}
                onPress={() => setMethod(key)}
              >
                <WalletMark
                  name={key === "BANK" ? (profile?.bankName ?? "BANK") : key}
                  size={32}
                />
                <Text className={on ? "text-primary" : "text-foreground"} variant="label">
                  {LABEL[key]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {method !== "CASH" && profile ? (
        <Animated.View entering={FadeIn.duration(160)} key={method}>
          <MethodDetail colors={colors} method={method} profile={profile} token={token} />
        </Animated.View>
      ) : null}

      {amountText !== null ? (
        <Input
          keyboardType="number-pad"
          label="Amount"
          leading={<Text variant="subtitle">Rs</Text>}
          onChangeText={(value) => setAmountText(value.replace(/\D/g, ""))}
          value={amountText}
        />
      ) : bills.length > 0 ? (
        <Pressable accessibilityRole="button" className="min-h-11 justify-center self-start active:opacity-70" onPress={() => setAmountText(String(balance))}>
          <Text className="text-primary" variant="label">Part payment</Text>
        </Pressable>
      ) : null}

      {error ? <Text className="text-destructive" variant="label">{error}</Text> : null}
      </View>

      {arming ? (
        <UndoBar
          onCancel={() => setArming(false)}
          onElapsed={() => {
            setArming(false);
            void collect();
          }}
        />
      ) : (
        <Button
          disabled={bills.length === 0}
          icon={method === "CASH" ? "cash" : "checkmark-circle"}
          label={method === "CASH" ? `Collect ${formatMoney(amount)}` : `Save ${formatMoney(amount)}`}
          loading={busy}
          onPress={start}
          size="lg"
        />
      )}
    </Animated.View>
  );
}

const UNDO_MS = 5000;

/**
 * Collect, with a way back. Tapping it turns the button into Cancel with a
 * five-second bar draining across it; only when the bar is empty does the
 * payment go through, so a wrong tap costs nothing.
 */
function UndoBar({ onCancel, onElapsed }: { onCancel: () => void; onElapsed: () => void }) {
  const { colors } = useAppTheme();
  const fill = useSharedValue(1);
  const [left, setLeft] = useState(UNDO_MS / 1000);
  const elapsed = useRef(onElapsed);
  useEffect(() => {
    elapsed.current = onElapsed;
  });

  useEffect(() => {
    const started = Date.now();
    fill.set(withTiming(0, { duration: UNDO_MS, easing: Easing.linear }));
    const tick = setInterval(
      () => setLeft(Math.max(0, Math.ceil((UNDO_MS - (Date.now() - started)) / 1000))),
      200,
    );
    const done = setTimeout(() => elapsed.current(), UNDO_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(done);
    };
  }, [fill]);

  const bar = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }));

  return (
    <Pressable
      accessibilityLabel={`Cancel, collecting in ${left} seconds`}
      accessibilityRole="button"
      className="h-14 justify-center overflow-hidden rounded-2xl border border-primary"
      onPress={onCancel}
    >
      <Animated.View
        style={[{ backgroundColor: `${colors.primary}40`, bottom: 0, left: 0, position: "absolute", top: 0 }, bar]}
      />
      <Text className="text-center text-foreground" variant="subtitle">
        {`Cancel · ${left}s`}
      </Text>
    </Pressable>
  );
}

function MethodDetail({
  colors,
  method,
  profile,
  token,
}: {
  colors: ReturnType<typeof useAppTheme>["colors"];
  method: DeskMethod;
  profile: PaymentProfile;
  token: string | null;
}) {
  if (method === "QR" && profile.staticQrAssetId) {
    return (
      <View className="items-center">
        <Image
          contentFit="contain"
          source={{ headers: token ? { Authorization: `Bearer ${token}` } : undefined, uri: fileAssetUrl(profile.staticQrAssetId) }}
          style={{ backgroundColor: colors.card, height: 176, width: 176 }}
        />
      </View>
    );
  }

  const extra = profile.extraAccounts.find((account) => account.kind === method);
  const number =
    method === "ESEWA" ? (profile.esewaId ?? extra?.number) :
    method === "KHALTI" ? (profile.khaltiId ?? extra?.number) :
    (profile.bankAccountNumber ?? extra?.number);
  const caption =
    method === "BANK" ? [profile.bankName ?? extra?.bankName, profile.bankAccountName ?? extra?.accountName].filter(Boolean).join(" · ") : LABEL[method];

  return (
    <View className="flex-row items-center justify-between gap-3 rounded-xl bg-muted px-4 py-3">
      <View className="flex-1">
        <Text variant="caption">{caption}</Text>
        <Text className="text-lg font-bold tracking-wider text-foreground">{number ?? "—"}</Text>
      </View>
      {number ? <CopyButton label={`${LABEL[method]} number`} tone="glyph" value={number} /> : null}
    </View>
  );
}
