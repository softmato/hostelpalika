import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import Toast from "react-native-toast-message";

import { PUSH_CHANNEL } from "@/lib/push-notifications";

/**
 * One place that decides how feedback looks, so a success in Payments and a
 * success in Complaints are not subtly different.
 */

/** Marks a toast's copy in the shade. */
export const TOAST_ECHO = "toastEcho";

/**
 * Every toast also goes to the notification shade: the toast is gone in four
 * seconds, the shade keeps what it said. Silent — the toast already showed it —
 * and skipped without notification permission or on the web export.
 */
function alsoNotify(title: string, body?: string) {
  if (Platform.OS === "web") return;

  void Notifications.getPermissionsAsync()
    .then((permission) =>
      permission.granted
        ? Notifications.scheduleNotificationAsync({
            content: { body, data: { [TOAST_ECHO]: true }, title },
            // The channel rides on the trigger — in `content` Android ignores it.
            trigger: { channelId: PUSH_CHANNEL.DEFAULT },
          })
        : undefined,
    )
    .catch(() => undefined);
}

export function toastSuccess(title: string, description?: string) {
  Toast.show({ text1: title, text2: description, type: "success" });
  alsoNotify(title, description);
}

/**
 * A success the reader can act on by tapping it — a finished download that
 * opens its file. The tap hides the toast first so the opened app is not
 * returned to with a stale "Downloaded" still sitting over the screen.
 *
 * Not copied to the shade: the download posts its own finished notification.
 */
export function toastSuccessAction(title: string, description: string, onPress: () => void) {
  Toast.show({
    onPress: () => {
      Toast.hide();
      onPress();
    },
    text1: title,
    text2: description,
    type: "success",
    visibilityTime: 5000,
  });
}

export function toastError(title: string, description?: string) {
  Toast.show({ text1: title, text2: description, type: "error" });
  alsoNotify(title, description);
}

export function toastInfo(title: string, description?: string) {
  Toast.show({ text1: title, text2: description, type: "info" });
  alsoNotify(title, description);
}

/**
 * An urgent live event — an SOS, a HIGH/URGENT announcement.
 *
 * Rendered with the error style deliberately: `react-native-toast-message`
 * ships success/error/info and nothing between, and of the three only error
 * reads as "stop and look". Naming it for what it *is* keeps call sites honest
 * about that being a presentation choice rather than a claim that something
 * failed. It also stays up roughly twice as long, because these arrive
 * unprompted and the reader was not waiting for them.
 */
export function toastUrgent(title: string, description?: string) {
  Toast.show({ text1: title, text2: description, type: "error", visibilityTime: 8000 });
  alsoNotify(title, description);
}
