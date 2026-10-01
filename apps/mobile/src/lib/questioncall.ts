import { Linking, Platform } from "react-native";

import { recordQuestionCallClick } from "@/lib/resident-api";

/** QuestionCall's own phone app (`com.softmato.questioncall`) registers this scheme. */
const NATIVE_APP_URL = "questioncall://";

/**
 * Opens QuestionCall for a student resident: its phone app when installed,
 * otherwise `url` — the site-config link into its installable web app.
 *
 * The phone app first because QuestionCall is a calling app, and only the
 * native one rings like a phone call. A scheme nobody registered rejects, which
 * is the "not installed" answer — no `<queries>` entry, no native change.
 * `intent://` with `S.browser_fallback_url` cannot do this from here: React
 * Native hands `openURL` a plain VIEW intent and never parses `intent:` URLs.
 *
 * `Linking.openURL`, not `expo-web-browser`: a Custom Tab can neither hand the
 * link to QuestionCall's installed web app nor install it, and on Android the
 * system browser passes a link inside an installed web app's scope to that app.
 *
 * The PWA's stand-in is `web/questioncall.ts`.
 */
export async function openQuestionCall(url: string) {
  // Alongside, not before: the tap must not wait on our analytics.
  void recordQuestionCallClick(Platform.OS as "android" | "ios").catch(() => undefined);

  try {
    await Linking.openURL(NATIVE_APP_URL);
  } catch {
    await Linking.openURL(url);
  }
}
