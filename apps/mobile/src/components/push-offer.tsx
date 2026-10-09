import { usePathname } from "expo-router";
import { BellRing } from "lucide-react-native";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Linking, View } from "react-native";

import { isLockOfferDismissed, StepHeading, subscribeToLockOffer } from "@/components/app-lock";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { canOfferLock } from "@/lib/app-lock";
import { type PushPermission, registerPushToken, requestPushPermission } from "@/lib/push-notifications";
import { toastSuccess } from "@/lib/toast";

/** "Not now" lasts until the app is next opened from cold — same rule as the lock offer. */
let offerDismissed = false;

/**
 * The ask for notification permission, on every cold open until it is granted.
 *
 * `usePush` registers this phone's token only when permission is **already**
 * granted, and the system dialogue must never fire on its own (see
 * `requestPushPermission`). Until now the one place that asked was a row deep in
 * Settings, so most phones never registered — and every payment, expense and
 * notice reached them only as the socket's in-app toast while the app was open.
 *
 * This puts the ask in front of them, and the dialogue still opens only on the
 * user's own tap. A phone that refused twice (`blocked`) is sent to the system
 * settings page instead, which is the only way back from there.
 *
 * Waits for the lock offer (`AppLockOffer`) to be answered so two sheets never
 * stack on a cold open.
 */
export function PushOffer() {
  const pathname = usePathname();
  const account = useAppSelector((state) => state.auth.account);
  const ready = useAppSelector((state) => state.auth.isReady);
  const activated = useAppSelector((state) => state.auth.isResidentActivated);
  const lockDismissed = useSyncExternalStore(subscribeToLockOffer, isLockOfferDismissed);
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(false);

  const lockOfferDue =
    !lockDismissed &&
    account?.hasLockPin !== true &&
    (account?.role !== ROLE.RESIDENT || activated !== false) &&
    canOfferLock(account);

  const wanted =
    ready &&
    Boolean(account) &&
    !offerDismissed &&
    !lockOfferDue &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/activate");

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    // Let the portal settle before asking anything.
    const timer = setTimeout(() => {
      void requestPushPermission().then((next) => {
        if (!live) return;
        setPermission(next);
        if (next === "denied" || next === "blocked") setOpen(true);
      });
    }, 2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [wanted]);

  function later() {
    offerDismissed = true;
    setOpen(false);
  }

  async function turnOn() {
    if (permission === "blocked") {
      later();
      await Linking.openSettings();
      return;
    }

    setAsking(true);
    const result = await registerPushToken({ ask: true, force: true });
    setAsking(false);
    setPermission(result.permission);
    later();

    if (result.permission === "granted") {
      toastSuccess("Notifications on", "This phone will get alerts from now on.");
    }
  }

  return (
    <Sheet fitContent onClose={later} open={open && wanted}>
      <View className="pb-2 pt-4">
        <StepHeading
          icon={BellRing}
          subtitle={
            permission === "blocked"
              ? "Notifications are off for this app. Turn them on in your phone's settings so payments, expenses and notices reach you even when the app is closed."
              : "Get payments, expenses and notices on this phone even when the app is closed."
          }
          title="Turn on notifications"
        />
      </View>
      <View className="gap-3 pt-4">
        <Button label="Not now" onPress={later} variant="outline" />
        <Button
          icon={BellRing}
          label={permission === "blocked" ? "Open settings" : "Turn on"}
          loading={asking}
          onPress={() => void turnOn()}
        />
      </View>
    </Sheet>
  );
}
