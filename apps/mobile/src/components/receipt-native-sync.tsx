import { useEffect } from "react";
import { useAppSelector } from "@/hooks/redux";
import { API_BASE_URL } from "@/lib/api";
import { getActiveHostelId, loadActiveHostel, subscribeActiveHostel } from "@/lib/active-hostel";
import { receiptNative } from "@/lib/receipt-native";
export function ReceiptNativeSync() {
  const ready = useAppSelector((state) => state.auth.isReady);
  useEffect(() => {
    if (!receiptNative || !ready) return;
    const sync = () => { void receiptNative!.configure(API_BASE_URL, getActiveHostelId()).catch(() => undefined); };
    void loadActiveHostel().then(sync);
    return subscribeActiveHostel(sync);
  }, [ready]);
  return null;
}
