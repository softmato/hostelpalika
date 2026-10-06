import * as Application from "expo-application";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Updates from "expo-updates";
import { ArrowUp } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Linking, Platform, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { APP_NAME } from "@/constants/branding";
import { useAppTheme } from "@/hooks/use-app-theme";
import { appStoreUpdateUrl } from "@/lib/app-version";
import { PLATFORM_PLAY_STORE_URL } from "@hostel/brand/brand";

/** `modules/hostelhub-app-update` — Android builds from Play; `null` everywhere else. */
const playUpdate = requireOptionalNativeModule<{
  check(): Promise<{ versionCode: number } | null>;
  start(): Promise<boolean>;
}>("HostelHubAppUpdate");

/** "Remind me later" lasts until the next cold open. */
let dismissed = false;

/**
 * "Update available", for both ways a new version reaches a phone:
 *
 * - a **store build** (new native code): on Android, Play's in-app update
 *   says it exists and runs the install itself (the Play listing is the
 *   fallback); on iOS, the App Store lookup says it and the button opens the
 *   App Store page;
 * - an **OTA** (`expo-updates`, JS only): downloaded if it is not already,
 *   then the app restarts into it.
 *
 * A store build wins when both are out — it carries the OTA's code anyway.
 */
export function UpdateSheet() {
  const { colors } = useAppTheme();
  const ota = Updates.useUpdates();
  /** A newer store build: whether Play can install it in place, and the store page. */
  const [store, setStore] = useState<{ play: boolean; url: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (Updates.isEnabled && !__DEV__) void Updates.checkForUpdateAsync().catch(() => {});
    if (playUpdate) {
      void playUpdate
        .check()
        .then((found) => found && setStore({ play: true, url: PLATFORM_PLAY_STORE_URL }));
    } else if (Platform.OS === "ios" && Application.applicationId) {
      void appStoreUpdateUrl(Application.applicationId, Application.nativeApplicationVersion).then(
        (url) => url && setStore({ play: false, url }),
      );
    }
  }, []);

  const available = store !== null || ota.isUpdateAvailable || ota.isUpdatePending;

  useEffect(() => {
    if (!available || dismissed) return;
    const timer = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(timer);
  }, [available]);

  function later() {
    dismissed = true;
    setOpen(false);
  }

  async function update() {
    setBusy(true);
    setError(null);
    try {
      if (store) {
        if (!(store.play && (await playUpdate?.start()))) await Linking.openURL(store.url);
        later();
        return;
      }
      if (!ota.isUpdatePending) await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    } catch {
      setError("The update did not download. Check your internet and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet fitContent onClose={later} open={open}>
      <View className="items-center gap-3 pb-2 pt-4">
        <View className="h-28 w-28 items-center justify-center rounded-full bg-brand-soft">
          <ArrowUp color={colors.brand} size={56} strokeWidth={2.4} />
        </View>
        <Text className="text-center" variant="title">
          Update available
        </Text>
        <Text className="text-center" variant="muted">
          A new version of {APP_NAME} is ready.
        </Text>
        {error ? (
          <Text className="text-center text-destructive" variant="caption">
            {error}
          </Text>
        ) : null}
      </View>
      <View className="gap-3 pt-4">
        <Button label="Remind me later" onPress={later} variant="outline" />
        <Button label="Update now" loading={busy} onPress={update} />
      </View>
    </Sheet>
  );
}
