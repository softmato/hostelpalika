import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { AppState, Platform, Switch, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { getActiveHostelId, subscribeActiveHostel } from "@/lib/active-hostel";
import { receiptNative } from "@/lib/receipt-native";
import { toastError } from "@/lib/toast";
export function ReceiptShareSettings() {
  const account = useAppSelector((state) => state.auth.account);
  const [hostelId, setHostelId] = useState(getActiveHostelId());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const key = `hostelpalika.receipt-auto:${account?.id}:${hostelId || account?.hostelIds[0] || ""}`;
  useEffect(() => subscribeActiveHostel(() => setHostelId(getActiveHostelId())), []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = receiptNative ? await receiptNative.getAutoSave(key) : await AsyncStorage.getItem(key) === "true";
        if (active) setEnabled(value);
      } catch { /* Default to review when storage cannot be read. */ }
      finally { if (active) setBusy(false); }
    };
    void load();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void load(); });
    return () => { active = false; subscription.remove(); };
  }, [key]);
  if (!account || !["HOSTEL_ADMIN", "WARDEN"].includes(account.role)) return null;
  return <View className="mx-5 my-3 flex-row items-center gap-3 rounded-2xl border border-border p-4">
    <View className="flex-1"><Text variant="label">Auto-save shared receipts</Text>
      <Text variant="muted">Clear outgoing receipts save under Other. Turn off to review every receipt.</Text>
      {Platform.OS === "web" ? <Text variant="caption">On iPhone, use Import payment receipt.</Text> : null}
    </View>
    <Switch accessibilityLabel="Auto-save shared receipts" value={enabled} disabled={busy} onValueChange={async (value) => {
      setBusy(true);
      try {
        if (receiptNative) await receiptNative.setAutoSave(key, value);
        else await AsyncStorage.setItem(key, String(value));
        setEnabled(value);
      } catch { toastError("Setting not changed", "Try again."); }
      finally { setBusy(false); }
    }} />
  </View>;
}
