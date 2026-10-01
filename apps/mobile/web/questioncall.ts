import type * as Native from "@/lib/questioncall";
import { recordQuestionCallClick } from "@/lib/resident-api";

/**
 * `@/lib/questioncall` for the installable web app: `url` in a new window, in
 * the tap itself — a window opened after an await is a popup the browser
 * blocks. A browser cannot ask whether QuestionCall's phone app is installed,
 * and `intent://`'s fallback would replace this app's own page, so there is no
 * native-app step here. On Android, Chrome hands a link inside the `/app` scope
 * to QuestionCall's installed web app.
 */
export const openQuestionCall: typeof Native.openQuestionCall = async (url) => {
  window.open(url, "_blank", "noopener");
  void recordQuestionCallClick("web").catch(() => undefined);
};
