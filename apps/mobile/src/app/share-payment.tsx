import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyCard } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { ResidentFinanceView } from "@/lib/finance-api";
import { receivePaymentShare } from "@/lib/receive-payment-share";
import { setSharedPayment, type SharedPaymentFile } from "@/lib/shared-payment";
import { rememberPaymentShare } from "@/lib/shared-payment-resume";

type Invoice = ResidentFinanceView["invoices"][number];
type State =
  | { kind: "loading" }
  | { kind: "pick"; invoices: Invoice[] }
  | { kind: "empty"; title: string; description: string };

/**
 * A receipt shared into the app from eSewa or a bank (todo C2).
 *
 * Staff go straight to a new expense. A resident sees the receipt, picks the
 * month it pays (oldest unpaid is ticked), and taps Continue — the claim screen
 * then reads the amount and the month code off it. One unpaid month skips this
 * screen entirely: there is nothing to choose.
 */
export default function SharePaymentScreen() {
  const { share, error } = useLocalSearchParams<{ share?: string; error?: string }>();
  const { account, isReady } = useAppSelector((state) => state.auth);
  const { colors } = useAppTheme();
  const dates = useDates();
  const file = useRef<SharedPaymentFile | null>(null);
  const incoming = useRef<Promise<SharedPaymentFile | null> | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const toClaim = (invoiceId: string, replace = true) => {
    if (file.current) setSharedPayment(file.current);
    const target = { pathname: "/invoice/[id]/claim" as const, params: { id: invoiceId, shared: "1" } };
    if (replace) router.replace(target);
    else router.push(target);
  };

  useEffect(() => {
    if (!isReady || !account) return;
    // The sheet page reads, matches and saves/sends for staff and residents alike.
    if (Platform.OS === "web" && ["HOSTEL_ADMIN", "WARDEN", "RESIDENT"].includes(account.role)) {
      const query = new URLSearchParams();
      if (share) query.set("share", share);
      if (error) query.set("error", error);
      window.location.replace("/app/receipt-sheet.html" + (query.size ? "?" + query.toString() : ""));
      return;
    }
    let active = true;
    async function open() {
      setState({ kind: "loading" });
      try {
        incoming.current ??= error ? Promise.resolve(null) : receivePaymentShare(share);
        file.current = await incoming.current;
        if (!active) return;
        setPreview(file.current?.mimeType?.startsWith("image/") ? file.current.uri : null);
        if (!file.current) {
          setState({ description: "One screenshot or PDF, up to 20 MB.", kind: "empty", title: "No receipt found" });
          return;
        }
        if (["HOSTEL_ADMIN", "WARDEN"].includes(account!.role)) {
          setSharedPayment(file.current);
          router.replace("/expenses/new");
          return;
        }
        if (account!.role !== "RESIDENT") {
          setState({ description: "Use a resident or hostel staff account.", kind: "empty", title: "Wrong account" });
          return;
        }
        const result = unwrap(await api.get<ApiEnvelope<ResidentFinanceView>>("/resident/finance/invoices"));
        if (!active) return;
        // Oldest first: that is the month a payment most likely clears.
        const due = result.invoices
          .filter((invoice) => invoice.dueAmount > 0)
          .sort((a, b) => (a.month ?? "").localeCompare(b.month ?? ""));
        if (due.length === 1) {
          toClaim(due[0]!.id);
          return;
        }
        if (due.length === 0) {
          setState({ description: "Nothing to attach this receipt to.", kind: "empty", title: "All paid" });
          return;
        }
        setPicked(due[0]!.id);
        setState({ invoices: due, kind: "pick" });
      } catch {
        if (active) setState({ description: "Check your connection.", kind: "empty", title: "Couldn't open receipt" });
      }
    }
    void open();
    return () => {
      active = false;
    };
    // toClaim reads refs only.
  }, [account, isReady, share, error, retry]);

  const header = <AppBar showBack title="Shared receipt" />;

  if (!account) {
    return (
      <Screen
        footer={<Button label="Sign in" onPress={() => { rememberPaymentShare({ error, share }); router.push("/(auth)/login"); }} size="lg" />}
        header={header}
      >
        <EmptyCard description="Then this receipt opens again." icon="lock-closed" title="Sign in first" />
      </Screen>
    );
  }

  if (state.kind === "loading") {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <Skeleton height={180} radius={16} />
          <Skeleton height={18} width="40%" />
          <Skeleton height={120} radius={16} />
        </View>
      </Screen>
    );
  }

  if (state.kind === "empty") {
    return (
      <Screen
        footer={<Button label="Try again" onPress={() => { incoming.current = null; setRetry((value) => value + 1); }} size="lg" variant="outline" />}
        header={header}
      >
        <EmptyCard description={state.description} title={state.title} />
      </Screen>
    );
  }

  return (
    <Screen
      footer={<Button disabled={!picked} label="Continue" onPress={() => picked && toClaim(picked, false)} size="lg" />}
      header={header}
    >
      <View className="gap-4 pt-1">
        <Card className="items-center overflow-hidden" padding="p-0">
          {preview ? (
            <Image contentFit="contain" source={{ uri: preview }} style={{ height: 180, width: "100%" }} />
          ) : (
            <View className="h-24 items-center justify-center">
              <Glyph color={colors.mutedForeground} name="document-text" size={32} />
            </View>
          )}
        </Card>

        <View>
          <SectionHeader title="Pays for" />
          <Card padding="px-4 py-1">
            {state.invoices.map((invoice, index) => {
              const on = invoice.id === picked;
              return (
                <View key={invoice.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    className="min-h-[52px] flex-row items-center gap-3 py-2 active:opacity-70"
                    onPress={() => setPicked(invoice.id)}
                  >
                    <Glyph color={on ? colors.primary : colors.mutedForeground} name={on ? "checkmark-circle" : "radio-button-off"} size={20} />
                    <View className="flex-1">
                      <Text variant="label">{invoice.month ? dates.period(invoice.month) : "Other bill"}</Text>
                      {invoice.referenceCode ? <Text variant="caption">{invoice.referenceCode}</Text> : null}
                    </View>
                    <Money value={invoice.dueAmount} />
                  </Pressable>
                </View>
              );
            })}
          </Card>
        </View>
      </View>
    </Screen>
  );
}
