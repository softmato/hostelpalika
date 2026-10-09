/**
 * Expo push: permission, token, channels, registration.
 *
 * The server half already exists (`apps/web/src/modules/notifications/
 * push.service.ts`), batching to Expo and pruning dead tokens. This is what
 * gives it something to send to.
 *
 * ## Android channels are frozen at creation — get them right the first time
 *
 * `setNotificationChannelAsync` creates a channel with the sound, importance
 * and vibration given, and Android then **freezes all three**. Calling it again
 * with the same id only renames the channel; every other field is ignored, on
 * every install that already has it. The reference app
 * (`D:\Jiwan-Mijhar\app\lib\push-notifications.ts`) hit exactly this and had to
 * ship a `calls_v2` id, because its original `calls` channel had been created
 * with a short message chime and could never be corrected in place.
 *
 * ## `sound` is a filename, and ours is `water_drop.wav`
 *
 * Android's key takes a *file*, not a value: `customSoundExists` looks the
 * string up with `getIdentifier(name, "raw", packageName)` and
 * `SoundResolver.resolve` builds `android.resource://…/raw/<name>` from it. So
 * the string has to name a resource the APK actually carries, which is what the
 * `sounds` array in `app.json`'s `expo-notifications` block is for — the plugin
 * copies each file into `android/app/src/main/res/raw` at prebuild.
 *
 * Two consequences worth knowing before touching this:
 *
 * - **The filename is a resource name.** `assertValidAndroidAssetName` rejects
 *   anything but lowercase letters, digits and underscores, which is why the
 *   file is `water_drop` and not the name it was downloaded under.
 * - **It is a WAV because of iOS.** The same `sounds` array is copied into the
 *   iOS bundle, where the server's `sound: "water_drop.wav"` names it, and iOS
 *   will not play an MP3 as a notification sound. Android resolves the
 *   resource by name without its extension, so channels created while the file
 *   was an MP3 play the WAV with no new ids. The MP3 stays in `assets/` as the
 *   in-app player's copy — see `lib/sound-effects.ts`.
 * - **It cannot be shipped by an update.** A raw resource lives in the APK, so
 *   this needs `expo run:android` or an EAS build. EAS Update carries JS and
 *   assets, never resources.
 *
 * `sound: "default"` used to sit here, which is a file called `default.wav`
 * that no build has ever contained — three `Custom sound 'default' not found in
 * native app` errors per cold start. It was pure noise rather than a broken
 * tone: `resolve` returns `Settings.System.DEFAULT_NOTIFICATION_URI` when the
 * lookup misses, which is what a channel gets when the key is omitted anyway.
 *
 * ## `urgent` deliberately keeps the system tone
 *
 * The water drop is a soft two-note chime — right for a meal, a reply or an
 * invoice, wrong for the one channel that exists to say somebody has hit the
 * SOS button. That channel keeps whatever the phone's own alert sound is, which
 * is the sound its owner already reacts to. Its id is therefore unchanged, and
 * so is its entry in `androidChannel()`.
 *
 * So the ids below are a one-way door. Changing what one *does* means
 * publishing a new id — `urgent_v2` — **and** changing `androidChannel()` in
 * `push.service.ts` in the same release, since the server is what stamps
 * `channelId` on the message. An id the phone cannot resolve is not a dropped
 * notification: `BaseNotificationBuilder` logs it and falls back to
 * expo-notifications' own channel, which is IMPORTANCE_HIGH with the system
 * sound — so the failure mode is a phone that has not updated yet treating
 * every notification as an alert, not silence.
 *
 * The four ids match that function exactly: `urgent` (SOS and anything
 * URGENT), `food_v2` (meal-ready), `notices_v1` (notices, push notices and
 * announcements), `default_v2` (everything else).
 *
 * ## Failure is always silent and never fatal
 *
 * Every call here is guarded. A phone with notifications denied, an emulator
 * with no Play Services, or a failed `/mobile/device-token` post must all leave
 * the app completely usable — the bell still works, because it is an ordinary
 * GET. Push is an accelerator, not a dependency.
 */

import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { api, API_BASE_URL } from "@/lib/api";
import { APP_DRAWS_CATEGORY_PUSHES } from "@/lib/drawn-push";
import { configureNativeNightPrompt } from "@/lib/night-prompt-native";
import { registerNightStatusCategory } from "@/lib/night-status-notification";
import { claimNotificationDisplay, claimNotificationSound } from "@/lib/notification-sound";
import { palette } from "@/constants/theme";
import { UPLOAD_NOTIFICATION_TYPE } from "@/lib/upload-notification";

/*
 * The notification LED / accent colour is deliberately the light palette's,
 * not the resolved theme's. A channel's settings are frozen at creation, so it
 * could never follow a theme toggle anyway — and this is brand chrome on the
 * system's surface, not part of the app's own.
 */
const BRAND = palette.light;

/**
 * The raw resource name, as the plugin copied it — extension included, because
 * `filenameToBasename` strips it back off on the native side either way.
 */
const SOUND = "water_drop.wav";

/**
 * Must match `androidChannel()` in `apps/web/src/modules/notifications/
 * push.service.ts`. See the note above before changing any of these.
 */
export const PUSH_CHANNEL = {
  DEFAULT: "default_v2",
  FOOD: "food_v2",
  NOTICES: "notices_v1",
  URGENT: "urgent",
} as const;

/**
 * The ids `DEFAULT` and `FOOD` used to have, kept only to be deleted.
 *
 * A channel's sound is frozen at creation, so the water drop could not be given
 * to `default` and `food` on any phone that already had them — hence the `_v2`
 * ids. Left alone, the originals would sit in the app's notification settings
 * forever as two dead categories a user can still toggle and never hear from.
 */
const RETIRED_CHANNELS = ["default", "food"];

/**
 * Read from app.json rather than hardcoded. `getExpoPushTokenAsync` needs it
 * explicitly in a bare/dev build — without it the call throws with a message
 * about the project id that reads like a configuration bug in Expo itself.
 */
function easProjectId(): string | undefined {
  const config = Constants.expoConfig as
    | { extra?: { eas?: { projectId?: string } } }
    | null;

  return config?.extra?.eas?.projectId;
}

/**
 * How a notification behaves while the app is **open**.
 *
 * Set at module scope, once. A banner over the app is right here: unlike the
 * reference app there is no call UI to suppress, and the alternative — silently
 * swallowing it because the app happens to be foregrounded — loses an SOS
 * alert for someone staring at the screen.
 *
 * `shouldShowBanner`/`shouldShowList` are the SDK 52+ replacements for the
 * deprecated `shouldShowAlert`, which is **not** returned alongside them: the
 * runtime warns once per notification when it sees it, which on a progress
 * transfer is a wall of identical console noise, and both replacements were
 * already being given the value it would have carried.
 *
 * ## The one exception: our own upload progress
 *
 * `lib/upload-notifier.ts` reposts a notification every 5% of a transfer. With
 * the default answer that is a banner sliding over the screen twenty times per
 * file, on top of the `<UploadToaster />` already showing the same thing — so
 * foregrounded, it goes to the **list only**, silently. The shade is where it
 * is useful; the screen already has a better version of it.
 *
 * Android's LOW-importance channel would suppress the heads-up on its own, but
 * iOS has no channels and this handler is the only place to say it.
 *
 * ## Sound: once per notification, whichever route got here first
 *
 * The same row usually reaches an open app over the socket too, a moment before
 * its push, and `use-realtime` chimes for it there. So a push only sounds if it
 * is the first to claim its id — see `lib/notification-sound.ts` — and is
 * otherwise shown silently rather than chiming a second time.
 *
 * Silently means without vibration too: expo-notifications gates vibration on
 * the same `shouldPlaySound` flag, and a banner that buzzes after the chime
 * already played is the double alert this is here to stop.
 *
 * An urgent push sounds regardless. The socket's drop is the wrong noise for an
 * SOS, and the phone's alert tone is the one its owner reacts to.
 */
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data;

    /*
     * Progress only. A **finished download** is deliberately not suppressed:
     * it is one notification rather than twenty, it is the app's only report
     * that a file now exists, and it is the one the user actually wants to see
     * at the top of the screen. See `DOWNLOAD_CHANNEL`.
     */
    const isUploadProgress = data?.type === UPLOAD_NOTIFICATION_TYPE;

    // Our own echo of a socket row (`live-notifier.ts`): always shown, and
    // silent here because the socket path already played the drop.
    const isLiveEcho = data?.liveEcho === true;

    /*
     * A push for a row the socket already drew in the shade. Shown once, not
     * twice: whichever arrived first claimed the banner.
     */
    const displayKey =
      typeof data?.notificationId === "string"
        ? data.notificationId
        : typeof data?.campaignId === "string"
          ? `campaign:${data.campaignId}`
          : null;
    const duplicate =
      !isLiveEcho && !isUploadProgress && displayKey !== null && !claimNotificationDisplay(displayKey);

    // Claimed even when urgent, so the socket does not add a drop to an alert
    // that already sounded.
    const firstToSound =
      !isUploadProgress && !isLiveEcho && claimNotificationSound(data?.notificationId);

    /*
     * No `shouldShowAlert`. It was the pre-SDK-52 name for the pair below and
     * expo-notifications now warns on every single notification the app posts —
     * which on a progress transfer is a wall of identical console noise. The two
     * that replaced it were already being set to the same value, so dropping it
     * changes nothing about what is shown.
     */
    return {
      // `urgent` is stamped by `push.service.ts` from the channel it chose.
      shouldPlaySound: !duplicate && (firstToSound || (!isUploadProgress && data?.urgent === true)),
      shouldSetBadge: !isUploadProgress,
      shouldShowBanner: !isUploadProgress && !duplicate,
      shouldShowList: !duplicate,
    };
  },
});

async function createAndroidChannels() {
  if (Platform.OS !== "android") {
    return;
  }

  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL.DEFAULT, {
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: BRAND.primary,
    name: "General",
    sound: SOUND,
    vibrationPattern: [0, 250, 250, 250],
  });

  /*
   * SOS and anything URGENT. MAX importance so it interrupts, lock-screen
   * visible so it can be read without unlocking — a safety alert that needs the
   * phone unlocked before it says anything has failed at the only moment it
   * mattered. `bypassDnd` is best-effort: Android ignores it unless the user has
   * granted Do Not Disturb access, and asking for that at install time would be
   * a permission prompt in front of a product nobody has used yet.
   */
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL.URGENT, {
    bypassDnd: true,
    enableLights: true,
    enableVibrate: true,
    importance: Notifications.AndroidImportance.MAX,
    lightColor: BRAND.destructive,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    name: "Urgent alerts",
    vibrationPattern: [0, 400, 200, 400],
  });

  /*
   * Meal-ready. HIGH rather than MAX: it should reach someone who is not
   * looking at their phone, but dinner is not an emergency and a channel that
   * behaves like one is the channel people turn off — taking the SOS alerts
   * with it if they shared an id.
   */
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL.FOOD, {
    importance: Notifications.AndroidImportance.HIGH,
    lightColor: BRAND.primary,
    name: "Meals",
    sound: SOUND,
    vibrationPattern: [0, 250, 250, 250],
  });

  /*
   * Notices and push notices. HIGH so they arrive as a heads-up banner — on
   * `default_v2` a hostel's notice only reached the shade silently, and the
   * in-app toast was all anyone saw. Not MAX: the clothes washing reminder is
   * not an SOS, and it must not share an id with one.
   */
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL.NOTICES, {
    importance: Notifications.AndroidImportance.HIGH,
    lightColor: BRAND.primary,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    name: "Notices",
    sound: SOUND,
    vibrationPattern: [0, 250, 250, 250],
  });

  /*
   * Last, and never fatal: a phone that has only ever run the new build has no
   * `default`/`food` channels to delete, and the call for a missing id is a
   * no-op. Deleting is one-way in the sense that matters here — Android
   * remembers a deleted channel's settings and restores them if the same id is
   * ever created again, which is exactly why these ids are not being reused.
   */
  await Promise.all(
    RETIRED_CHANNELS.map((channelId) =>
      Notifications.deleteNotificationChannelAsync(channelId).catch(() => undefined),
    ),
  );
}

export type PushPermission = "blocked" | "denied" | "granted" | "unsupported";

/**
 * Reads notification permission, and asks for it **only when told to**.
 *
 * ## `ask` defaults to false, and that is the whole point
 *
 * The system dialogue must never appear on its own. On Android 13+ a second
 * refusal sets `canAskAgain: false` permanently and the dialogue never appears
 * again — so a prompt fired over a dashboard the user has not read yet spends
 * the one chance the app gets, on the worst possible moment to ask.
 *
 * That rule was written here from the start and the code broke it anyway:
 * `usePush` called `registerPushToken()` on account change, and that function
 * opened with an unconditional request — so every signed-in cold start met the
 * dialogue. Defaulting to "read, do not ask" makes the rule the default rather
 * than a note above a function that ignored it.
 *
 * `blocked` is reported separately from `denied` because the two need different
 * UI: `denied` can still be asked again, `blocked` can only be sent to system
 * settings, and a "Turn on notifications" button shown to a blocked user is a
 * button that does nothing.
 */
export async function requestPushPermission(
  options: { ask?: boolean } = {},
): Promise<PushPermission> {
  // Simulators and emulators cannot be issued a push token at all, and asking
  // makes a dev build look broken rather than unsupported.
  if (!Device.isDevice) {
    return "unsupported";
  }

  const existing = await Notifications.getPermissionsAsync().catch(() => null);

  if (existing?.granted) {
    return "granted";
  }

  if (existing && !existing.canAskAgain) {
    return "blocked";
  }

  if (!options.ask) {
    // Not granted, and nobody asked us to ask. The caller registers nothing and
    // the Settings screen offers the prompt where it can be explained first.
    return "denied";
  }

  const asked = await Notifications.requestPermissionsAsync().catch(() => null);

  if (asked?.granted) {
    return "granted";
  }

  return asked && !asked.canAskAgain ? "blocked" : "denied";
}

/**
 * The Expo push token for this install, or null.
 *
 * Deliberately **no** fallback to `getDevicePushTokenAsync`. The raw FCM/APNS
 * token is not interchangeable with an Expo one: `push.service.ts` posts to
 * `exp.host/--/api/v2/push/send`, which rejects anything that is not an
 * `ExponentPushToken[…]`. Storing a device token would fill `DeviceToken` with
 * rows that can never be delivered to and that Expo never reports as
 * `DeviceNotRegistered`, so nothing would ever prune them.
 */
async function fetchExpoPushToken(): Promise<string | null> {
  const projectId = easProjectId();

  const token = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  ).catch(() => null);

  return token?.data ?? null;
}

let lastRegisteredToken: string | null = null;

/** The token this install last sent to the server, for logout to revoke. */
export function currentPushToken() {
  return lastRegisteredToken;
}

export type PushRegistration = {
  permission: PushPermission;
  registered: boolean;
  token: string | null;
};

/**
 * Permission → channels → token → `POST /mobile/device-token`.
 *
 * Called on launch **for a signed-in account** and again after every login. Not
 * once per install: the row is keyed to `principal.userId`, so the same phone
 * used by two people has to register under each, or person B's alerts keep
 * arriving on a token the server still believes belongs to person A.
 *
 * Those calls pass no `ask`, so they are silent: an account that has already
 * granted permission is registered, and one that has not is left alone until it
 * chooses to turn notifications on from Settings.
 *
 * The same token re-posted is not a problem — `saveDeviceToken` upserts — but
 * it is skipped anyway, because launch and login both fire on a cold start
 * where a user just signed in.
 */
export async function registerPushToken(
  options: { ask?: boolean; force?: boolean } = {},
): Promise<PushRegistration> {
  // `ask` is off unless a caller opts in — see `requestPushPermission`. Boot and
  // the foreground re-check both register silently when permission is already
  // there and do nothing when it is not.
  const permission = await requestPushPermission({ ask: options.ask });

  if (permission !== "granted") {
    return { permission, registered: false, token: null };
  }

  // Before the token, not after: a token issued for a channel that does not
  // exist yet arrives on `default` with none of the urgent channel's settings.
  await createAndroidChannels().catch(() => undefined);

  /*
   * The night-status buttons, on the same terms and for the same reason.
   *
   * A category is per-install state the OS holds, so it has to be re-declared
   * every launch — a reinstall or an OS update can lose it, and a prompt that
   * arrives before it is registered is a prompt with no buttons on it, which is
   * the entire feature missing with nothing logged. Registering here rather
   * than at first use means it is in place before any push can arrive.
   */
  await registerNightStatusCategory();

  // Before the token is sent, so it is in place before the first prompt.
  configureNativeNightPrompt(API_BASE_URL);

  const token = await fetchExpoPushToken();

  if (!token) {
    return { permission, registered: false, token: null };
  }

  if (!options.force && token === lastRegisteredToken) {
    return { permission, registered: true, token };
  }

  try {
    await api.post("/mobile/device-token", {
      /*
       * Android only: this build draws a data-only push with buttons itself,
       * so the server may send it that way. iOS draws the buttons from APNs and
       * must keep the ordinary message. See `lib/drawn-push.ts`.
       */
      capabilities: Platform.OS === "android" ? [APP_DRAWS_CATEGORY_PUSHES] : [],
      // `deviceTokenSaveSchema` accepts IOS | ANDROID | WEB. Neither of the
      // other two can be reached from this app, and an unrecognised value is a
      // 400 that would read as a token problem.
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
      token,
    });

    lastRegisteredToken = token;

    return { permission, registered: true, token };
  } catch {
    // Offline, or the session ended between the token fetch and the post. The
    // next launch retries; nothing about the app is broken in the meantime.
    return { permission, registered: false, token };
  }
}

/**
 * Forgets the token locally so the next sign-in re-registers it.
 *
 * Local only, and not enough on its own — `revokePushToken` is what actually
 * stops delivery. What *this* prevents is the `token === lastRegisteredToken`
 * skip above quietly suppressing registration for the next account on a shared
 * phone.
 */
export function forgetPushToken() {
  lastRegisteredToken = null;
}

/**
 * Tells the server to stop sending to this device, on sign-out.
 *
 * ## Why forgetting locally was never enough
 *
 * `DeviceToken` rows are keyed to a user id, and the row survives sign-out. So
 * the account that just left kept receiving its invoices, complaint replies and
 * SOS alerts on a phone it had signed out of — indefinitely, because Expo only
 * reports `DeviceNotRegistered` for a token the app no longer holds, and this
 * one was still perfectly valid. On a shared or handed-down handset that is
 * someone else reading them.
 *
 * ## Called before the tokens are cleared
 *
 * `DELETE /mobile/device-token` is authenticated, so it has to go out while the
 * session is still usable — `endSession` runs it ahead of `clearTokens()`.
 *
 * ## Never blocks the sign-out
 *
 * Offline, already-expired, no permission ever granted: all of them end here
 * quietly. A user who taps "Sign out" is signed out either way; refusing would
 * strand them in an account they asked to leave, to fix a problem the *next*
 * registration corrects anyway (the upsert re-points the row at whoever signs
 * in next).
 */
export async function revokePushToken() {
  const token = lastRegisteredToken;

  forgetPushToken();

  if (!token) {
    return;
  }

  // `data` on a DELETE, because the token is long and credential-adjacent — a
  // query string would put it in every access log between here and the server.
  await api.delete("/mobile/device-token", { data: { token } }).catch(() => undefined);
}

/**
 * The app-icon badge.
 *
 * Driven from the unread count the bell already fetches rather than counted
 * here: two counters for one number always drift, and the server's is the one
 * that survives a reinstall. iOS is the platform that actually renders this;
 * most Android launchers show a dot at best, and the call is harmless there.
 */
export async function setBadgeCount(count: number) {
  await Notifications.setBadgeCountAsync(Math.max(0, count)).catch(() => undefined);
}
