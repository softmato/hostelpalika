import type * as Native from "@/lib/questioncall";
import { recordQuestionCallClick } from "@/lib/resident-api";

/**
 * `@/lib/questioncall` for the installable web app. The window is opened in the
 * tap and pointed after the click returns its `ssoCode` — a window opened after
 * an await is a popup the browser blocks. A browser cannot ask whether
 * QuestionCall's phone app is installed, and `intent://`'s fallback would
 * replace this app's own page, so there is no native-app step here.
 */
export const openQuestionCall: typeof Native.openQuestionCall = async (url) => {
  const tab = window.open("", "_blank");
  const ssoCode = await recordQuestionCallClick("web")
    .then((click) => click.ssoCode)
    .catch(() => null);
  const target = ssoCode
    ? `${url}${url.includes("?") ? "&" : "?"}hp_code=${encodeURIComponent(ssoCode)}`
    : url;

  if (!tab) {
    window.open(target, "_blank", "noopener");
    return;
  }

  tab.opener = null;
  tab.location.href = target;
};
