import { router, usePathname } from "expo-router";
import { useEffect } from "react";
import { useAppSelector } from "@/hooks/redux";
import { takePaymentShareRoute } from "@/lib/shared-payment-resume";
export function SharedPaymentResume() {
  const account = useAppSelector((state) => state.auth.account);
  const pathname = usePathname();
  useEffect(() => {
    if (!account || pathname.includes("login") || pathname === "/share-payment") return;
    const params = takePaymentShareRoute();
    if (params) router.replace({ pathname: "/share-payment", params });
  }, [account, pathname]);
  return null;
}
