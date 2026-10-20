import AsyncStorage from "@react-native-async-storage/async-storage";
import { usePathname } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Linking, View } from "react-native";

import { isLockOfferDismissed, subscribeToLockOffer } from "@/components/app-lock";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSiteConfig } from "@/hooks/use-site-config";
import { canOfferLock } from "@/lib/app-lock";

const SEEN_KEY = "hostelpalika:app-notice-seen";

const AUDIENCE_ROLES: Record<string, string[] | null> = {
  EVERYONE: null,
  GUARDIANS: [ROLE.GUARDIAN],
  HOSTEL_STAFF: [ROLE.HOSTEL_ADMIN, ROLE.WARDEN, ROLE.COOK],
  RESIDENTS: [ROLE.RESIDENT],
};

/**
 * Platform → Push → Sheet message: the superadmin's words in the
 * "Update available" sheet's clothes, once per message per phone. Waits for the
 * lock offer like `PushOffer`, so two sheets never stack on a cold open.
 */
export function AppNoticeSheet() {
  const { colors } = useAppTheme();
  const notice = useSiteConfig().config.appNotice;
  const pathname = usePathname();
  const account = useAppSelector((state) => state.auth.account);
  const ready = useAppSelector((state) => state.auth.isReady);
  const activated = useAppSelector((state) => state.auth.isResidentActivated);
  const lockDismissed = useSyncExternalStore(subscribeToLockOffer, isLockOfferDismissed);
  const [open, setOpen] = useState(false);

  const audience = notice ? AUDIENCE_ROLES[notice.audience] : undefined;
  const lockOfferDue =
    !lockDismissed &&
    account?.hasLockPin !== true &&
    (account?.role !== ROLE.RESIDENT || activated !== false) &&
    canOfferLock(account);
  const wanted =
    ready &&
    Boolean(notice?.id && notice.title) &&
    (audience === null || Boolean(account && audience?.includes(account.role))) &&
    !lockOfferDue &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/activate");

  useEffect(() => {
    if (!wanted || !notice) return;
    let live = true;
    const timer = setTimeout(() => {
      void AsyncStorage.getItem(SEEN_KEY)
        .catch(() => null)
        .then((seen) => live && seen !== notice.id && setOpen(true));
    }, 1800);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [notice, wanted]);

  function close() {
    setOpen(false);
    if (notice) void AsyncStorage.setItem(SEEN_KEY, notice.id).catch(() => {});
  }

  if (!notice) return null;
  const action = notice.link && notice.buttonLabel ? notice : null;

  return (
    <Sheet fitContent onClose={close} open={open && wanted}>
      <View className="items-center gap-3 pb-2 pt-4">
        <View className="h-28 w-28 items-center justify-center rounded-full bg-brand-soft">
          <Glyph name="megaphone" color={colors.brand} size={52} strokeWidth={2.2} />
        </View>
        <Text className="text-center" variant="title">
          {notice.title}
        </Text>
        <Text className="text-center" variant="muted">
          {notice.message}
        </Text>
      </View>
      <View className="gap-3 pt-4">
        {action ? (
          <>
            <Button label="Later" onPress={close} variant="outline" />
            <Button
              label={action.buttonLabel}
              onPress={() => {
                close();
                void Linking.openURL(action.link);
              }}
            />
          </>
        ) : (
          <Button label="OK" onPress={close} />
        )}
      </View>
    </Sheet>
  );
}
