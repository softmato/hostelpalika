import { Platform } from "react-native";
import { rememberPaymentShare } from "@/lib/shared-payment-resume";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Screen } from "@/components/ui/screen";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { ResidentFinanceView } from "@/lib/finance-api";
import { receivePaymentShare } from "@/lib/receive-payment-share";
import { setSharedPayment, type SharedPaymentFile } from "@/lib/shared-payment";
import { formatMoney } from "@/lib/format";

export default function SharePaymentScreen() {
  const { share, error } = useLocalSearchParams<{ share?: string; error?: string }>();
  const { account, isReady } = useAppSelector((state) => state.auth);
  const file = useRef<SharedPaymentFile | null>(null);
  const incoming = useRef<Promise<SharedPaymentFile | null> | null>(null);
  const [message, setMessage] = useState("Opening shared receipt…");
  const [invoices, setInvoices] = useState<ResidentFinanceView["invoices"]>([]);
  const [retry, setRetry] = useState(0);
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
      try {
        incoming.current ??= error ? Promise.resolve(null) : receivePaymentShare(share);
        file.current = await incoming.current;
        if (!active) return;
        if (!file.current) { setMessage("Share one payment screenshot or PDF, up to 20 MB, then try again."); return; }
        if (["HOSTEL_ADMIN", "WARDEN"].includes(account!.role)) {
          setSharedPayment(file.current);
          router.replace("/expenses/new");
        } else if (account!.role === "RESIDENT") {
          const result = unwrap(await api.get<ApiEnvelope<ResidentFinanceView>>("/resident/finance/invoices"));
          if (!active) return;
          const due = result.invoices.filter((invoice) => invoice.dueAmount > 0);
          setInvoices(due);
          setMessage(due.length ? "Choose the invoice this payment is for. We will read the receipt for you." : "You have no unpaid invoices to attach this receipt to.");
        } else { setMessage("Sign in with a resident or hostel staff account to use this receipt."); }
      } catch { if (active) setMessage("Could not open your receipt. Check your connection and try again."); }
    }
    void open();
    return () => { active = false; };
  }, [account, isReady, share, error, retry]);
  return <Screen header={<AppBar title="Shared payment" showBack />}>
    <Text>{!account ? "Sign in, then return here to finish adding your receipt." : message}</Text>
    {!account ? <Button label="Sign in" onPress={() => { rememberPaymentShare({ share, error }); router.push("/(auth)/login"); }} /> : null}
    {invoices.map((invoice) => <Button key={invoice.id} label={`${invoice.month ?? "Invoice"} · ${formatMoney(invoice.dueAmount)}`}
      onPress={() => { if (file.current) setSharedPayment(file.current); router.replace({ pathname: "/invoice/[id]/claim", params: { id: invoice.id, shared: "1" } }); }} />)}
    {account ? <Button label="Try again" onPress={() => { incoming.current = null; setRetry((value) => value + 1); }} /> : null}
  </Screen>;
}
