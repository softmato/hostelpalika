import { Linking, Platform } from "react-native";

import { recordQuestionCallClick } from "@/lib/resident-api";

/** QuestionCall's own phone app (`com.softmato.questioncall`) registers this scheme. */
const NATIVE_APP_URL = "questioncall://";

/**
 * Opens QuestionCall for a student resident, signed in: its phone app when
 * installed, otherwise `url` — the site-config link into its installable web app.
 *
 * The click comes first now, not alongside: its `ssoCode` rides on the link as
 * `hp_code`, and QuestionCall's backend trades it with ours for who this is — a
 * single-use code, so the link is worthless once opened. No code (unverified
 * email, offline) still opens QuestionCall; they sign in there instead.
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
  const ssoCode = await recordQuestionCallClick(Platform.OS as "android" | "ios")
    .then((click) => click.ssoCode)
    .catch(() => null);
  const code = ssoCode ? `hp_code=${encodeURIComponent(ssoCode)}` : "";

  try {
    await Linking.openURL(code ? `${NATIVE_APP_URL}?${code}` : NATIVE_APP_URL);
  } catch {
    await Linking.openURL(code ? `${url}${url.includes("?") ? "&" : "?"}${code}` : url);
  }
}
