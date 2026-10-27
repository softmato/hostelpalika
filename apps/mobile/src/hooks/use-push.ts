/**
 * Push registration, tap routing, the app-icon badge — and the one push that
 * changes what app this is.
 *
 * Mounted once, at the root. Everything is keyed to the signed-in account:
 * registration re-runs when the account changes, because the `DeviceToken` row
 * belongs to a user id and a shared phone must not keep delivering person A's
 * alerts to person B.
 *
 * The exception to "a push opens a screen" is `marksRoleChange`: being
 * registered at a hostel promotes the recipient's own account, and that push is
 * handled in both directions — tapped, and merely received while the app is
 * open. See `adoptRoleChange`.
 */

import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { nightKey } from "@hostel/night/night-window";

import { useAppSelector } from "@/hooks/redux";
import { adoptRoleChange } from "@/lib/auth-session";
import { openSavedFile } from "@/lib/native-downloads";
import { parseNightStatusAction } from "@/lib/night-status-actions";
import {
  flushNightStatusQueue,
  handleNightStatusResponse,
  collapseNightPrompts,
} from "@/lib/night-status-notification";
import { fitRole, marksRoleChange, resolvePushPath } from "@/lib/push-link";
import { store } from "@/store";
import {
  forgetPushToken,
  registerPushToken,
  setBadgeCount,
} from "@/lib/push-notifications";
import { DOWNLOAD_NOTIFICATION_TYPE } from "@/lib/upload-notification";

export function usePush() {
  const account = useAppSelector((state) => state.auth.account);
  const isReady = useAppSelector((state) => state.auth.isReady);
  const userId = account?.id ?? null;

  /*
   * Responses already routed. The cold-start replay below and the live listener
   * can both surface the *same* response, and without this the app pushes the
   * invoice screen twice — leaving a duplicate in the back stack that the user
   * has to dismiss twice.
   *
   * ## Why the key is not the identifier alone
   *
   * It was, and it broke every download after the first. A *server* push gets a
   * fresh identifier per message, so an identifier looked like a per-response
   * key — but the app's own notifications are posted under a deliberately
   * constant one (`UPLOAD_NOTIFICATION_ID`), because each progress update has to
   * *replace* the last rather than stack. So every download the app has ever
   * reported shares a single identifier, and this set never empties: the first
   * tap opened the file, and every tap afterwards was dropped as a duplicate.
   *
   * The cold-start replay made it worse than "once per session". It marks that
   * constant id handled before the user has tapped anything, so the first real
   * tap of a session was usually dead too — which is exactly what a tap that
   * does nothing at all looks like from the outside.
   *
   * `date` is when the notification was delivered, so it differs per post and
   * matches for the two surfacings of one response — which is the only thing
   * this set was ever meant to catch.
   */
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!userId) {
      // Signed out: drop the cached token so the next account re-registers
      // rather than being skipped as "already sent".
      forgetPushToken();
      void setBadgeCount(0);
      return;
    }

    // Deliberately not awaited into the render path, and failure is silent —
    // `registerPushToken` never throws, it reports.
    void registerPushToken();
  }, [userId]);

  useEffect(() => {
    /*
     * Wait for the boot gate. Routing a tap before `isReady` races the
     * `<Redirect>` in `app/index.tsx`: the deep-linked screen mounts, the gate
     * then replaces it with the role's home, and the notification silently does
     * nothing. This is the same ordering trap that left the splash stuck over
     * referral deep links.
     */
    if (!isReady) {
      return;
    }

    function open(response: Notifications.NotificationResponse) {
      // Identifier *and* delivery time — see `handled` above. The identifier is
      // reused by design for the app's own notifications, so on its own it
      // silently swallowed every download tap after the first.
      const id = `${response.notification.request.identifier}:${response.notification.date ?? 0}`;

      if (handled.current.has(id)) {
        return;
      }

      handled.current.add(id);

      /*
       * A night-status button, answered rather than opened.
       *
       * Checked first, and it never routes. The three buttons are registered
       * with `opensAppToForeground: false`, so reaching this listener at all
       * means the app happened to be alive — and the resident who tapped
       * `Inside` on their lock screen has not asked to be taken anywhere. On
       * Android with the app killed this never runs and the background task in
       * `lib/night-status-task.ts` handles it instead; on iOS after a
       * force-quit it arrives here through the cold-start replay below, which
       * is exactly what that replay is for.
       *
       * `parseNightStatusAction` is pure and synchronous, so the decision to
       * swallow the response is made before anything is awaited — a `return`
       * after an `await` would have already let the routing below run.
       */
      if (parseNightStatusAction(response.actionIdentifier, response.userText)) {
        void handleNightStatusResponse(response);

        return;
      }

      const data = response.notification.request.content.data as
        | Record<string, unknown>
        | undefined;

      /*
       * A finished download opens the file rather than routing into the app.
       *
       * It is the only notification here that is about something outside the
       * app, so it is the only one that does not end in `router.push` — and a
       * "Downloaded" notice that dropped you on a dashboard instead of the file
       * would be the same broken promise as one that does nothing at all.
       *
       * ## When there is nothing to open it with
       *
       * `openDownloaded` answers `false` rather than throwing — a build with no
       * native module, or a phone with nothing that reads the type. That answer
       * used to be discarded, so the tap did nothing at all and the file looked
       * lost. It is a bad ending either way, but the recoverable version of it
       * says where the file is, which is enough to go and find it.
       *
       * There is deliberately no `router.push` here: this notification has no
       * screen behind it. Dropping the user on a dashboard would be the broken
       * promise the paragraph above rules out.
       */
      if (data?.type === DOWNLOAD_NOTIFICATION_TYPE && typeof data.uri === "string") {
        void openSavedFile({
          mimeType: typeof data.mimeType === "string" ? data.mimeType : null,
          path: typeof data.path === "string" ? data.path : null,
          uri: data.uri,
        });

        return;
      }

      const path = resolvePushPath(data?.path);

      /*
       * A push that says the account's own role changed re-reads the session
       * before it routes anywhere.
       *
       * Order is the whole point. `/(resident)/payments/<id>` is a resident
       * route, and this phone is still holding a public access token until
       * `adoptRoleChange` rotates it — routing first would open the invoice on
       * a session whose every request comes back 403, which reads exactly like
       * a broken screen. Rotating first also lands the resident tabs under the
       * pushed screen, so backing out of the invoice arrives at their own home
       * rather than the browsing app they were in when it buzzed.
       *
       * Awaited, then pushed, and the push still happens if the refresh failed
       * — an offline phone should not swallow a tapped notification.
       */
      if (marksRoleChange(data)) {
        void adoptRoleChange()
          .catch(() => null)
          .finally(() => router.push(path as never));

        return;
      }

      /*
       * `resolvePushPath` guarantees a route that exists in this build — the
       * server's table names several screens that are still M5/M7 work, and an
       * unrouted push lands on `+not-found`, which reads as the app being
       * broken at the exact moment it just buzzed. See `lib/push-link.ts`.
       */
      // F3: a resident path on an owner's phone opens the owner's screen for the kind.
      router.push(
        fitRole(path, data?.category, store.getState().auth.account?.role) as never,
      );
    }

    const subscription = Notifications.addNotificationResponseReceivedListener(open);

    /*
     * The tap that cold-started the app.
     *
     * `addNotificationResponseReceivedListener` only sees responses delivered
     * *after* it subscribes, and this effect waits on `isReady` — so a tap that
     * launched the app from killed was already delivered and dropped, landing
     * the user on their home screen instead of the thing they tapped. The
     * reference app (`D:\Jiwan-Mijhar`) hit exactly this and its fix is the
     * same call. Deduped against the listener via `handled`, because both can
     * surface one response.
     */
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          open(response);
        }
      })
      .catch(() => undefined);

    return () => subscription.remove();
  }, [isReady]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    /*
     * Nudge the badge while the app is open.
     *
     * The authoritative number is the server's `unreadCount`, which
     * `notifications.tsx` writes whenever the bell is opened — that is what
     * "cleared on read" actually means here. This only keeps the icon honest
     * between those moments, and it is deliberately an increment rather than a
     * fetch: one GET per arriving notification would turn a burst of alerts
     * into a burst of requests, to correct a number nobody is looking at while
     * the app is in front of them.
     */
    const received = Notifications.addNotificationReceivedListener((notification) => {
      void Notifications.getBadgeCountAsync()
        .then((count) => setBadgeCount(count + 1))
        .catch(() => undefined);

      /*
       * The app changes shape without waiting to be tapped.
       *
       * A resident registered at a hostel desk is holding their phone with the
       * app open — that is the moment the warden scanned their card. The push
       * arrives in the foreground, where a notification that is only *routed on
       * tap* does nothing at all: they are left in the public browsing app,
       * having just paid a deposit, with no way to reach a resident screen and
       * no reason to think one exists. `adoptRoleChange` rotates the token and
       * replaces the shell with their own tabs.
       *
       * Only for this class of notification. Every other push in the app is
       * about something to go and look at, and re-routing the screen out from
       * under somebody because their rent was invoiced would be the app taking
       * over their phone.
       */
      if (marksRoleChange(notification.request.content.data)) {
        void adoptRoleChange().catch(() => null);
      }

      // A new round of the night prompt replaces the unanswered one.
      void collapseNightPrompts({ keepLatest: true });
    });

    return () => received.remove();
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    /*
     * Once on start as well. `AppState` only reports a *change*, and a cold
     * start opens already active — so an app launched from closed, which is
     * the usual way a resident comes back after answering from the shade,
     * never sent the queue at all. Seen on a real phone: seven answers still
     * queued after the app had been opened.
     */
    void flushNightStatusQueue(nightKey()).catch(() => undefined);
    void collapseNightPrompts({ keepLatest: true });

    /*
     * Permission can be revoked from system settings while the app sits in the
     * background, and Android never tells the app. Re-registering on
     * foreground is what keeps the `DeviceToken` row from claiming a device
     * that has gone silent — and it costs one request per return to the app,
     * skipped entirely when the token has not changed.
     */
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void registerPushToken();

        /*
         * Anything the shade could not send. A background handler gets seconds
         * and a doubtful network; this is the first moment there is a real
         * client, a live token and time to use them. See
         * `night-status-queue.ts` for why the answer was written to disk before
         * it was ever posted.
         */
        void flushNightStatusQueue(nightKey()).catch(() => undefined);
        void collapseNightPrompts({ keepLatest: true });
      }
    });

    return () => subscription.remove();
  }, [userId]);
}
