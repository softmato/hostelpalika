import { useEffect } from "react";
import { useAppSelector } from "@/hooks/redux";
import { API_BASE_URL } from "@/lib/api";
import { getRequestHostelId, loadActiveHostel, subscribeActiveHostel } from "@/lib/active-hostel";
import { receiptAutoKey, receiptNative } from "@/lib/receipt-native";
export function ReceiptNativeSync() {
  const ready = useAppSelector((state) => state.auth.isReady);
  const account = useAppSelector((state) => state.auth.account);
  useEffect(() => {
    if (!receiptNative || !ready) return;
    const sync = () => {
      const hostelId = getRequestHostelId();
      void receiptNative!.configure(API_BASE_URL, hostelId).catch(() => undefined);
      void receiptNative!.setShareAccount?.(account?.role ?? null, account ? receiptAutoKey(account, hostelId) : null).catch(() => undefined);
    };
    void loadActiveHostel().then(sync);
    return subscribeActiveHostel(sync);
  }, [ready, account]);
  return null;
}
