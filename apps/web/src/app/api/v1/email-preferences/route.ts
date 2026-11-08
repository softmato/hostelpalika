import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";

import {
  emailFromPreferenceToken,
  getMutedTopics,
  mutedAfterForm,
  setMutedTopics,
} from "@/modules/notifications/email-preference.service";
import { isEmailTopic } from "@/lib/notifications/email-topics";
import { maskEmail } from "@/modules/platform-config/setting-change.service";

export const runtime = "nodejs";

/**
 * What the `/email-preferences` page shows for a link (PARITY §9: the page reads
 * the API): the address, masked, and the topics it has muted. Reading changes
 * nothing — a link scanner that prefetches the page must not unsubscribe anyone.
 */
export async function GET(request: NextRequest) {
  try {
    const email = emailFromPreferenceToken(request.nextUrl.searchParams.get("token") ?? "");

    if (!email) {
      return errorResponse("This link is not valid.", "INVALID_TOKEN", 400);
    }

    return successResponse({ email: maskEmail(email), muted: await getMutedTopics(email) }, "Email preferences loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * The `/email-preferences` page's form. A plain HTML POST, so it works from any
 * mail client's browser with no JavaScript, answered with a 303 back to the page.
 *
 * `mute` is the page's single "Unsubscribe" button; otherwise `shown` lists the
 * topics the form rendered and `receive` the ones left ticked. The signed token
 * is the whole authorisation — it names one address and can only change that
 * address's optional mail.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const topic = form.get("topic");
  const back = new URL("/email-preferences", request.url);

  back.searchParams.set("token", token);

  if (isEmailTopic(topic)) {
    back.searchParams.set("topic", topic);
  }

  const email = emailFromPreferenceToken(token);

  if (!email) {
    return NextResponse.redirect(back, 303);
  }

  try {
    const current = await getMutedTopics(email);
    const mute = form.get("mute");

    await setMutedTopics(
      [email],
      isEmailTopic(mute)
        ? [...current, mute]
        : mutedAfterForm(
            current,
            form.getAll("shown").filter(isEmailTopic),
            form.getAll("receive").filter(isEmailTopic),
          ),
    );
    back.searchParams.set("saved", "1");
  } catch {
    back.searchParams.set("error", "1");
  }

  return NextResponse.redirect(back, 303);
}
