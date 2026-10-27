import { NextResponse, type NextRequest } from "next/server";

import { completeDriveConnect } from "@/modules/backup/backup.service";

export const runtime = "nodejs";

const APP_RETURN = "hostelpalika://manage/backup";

/**
 * Google's redirect after the owner allows Drive. No session rides on it — the
 * signed `state` says who started it, and ownership is checked again there.
 * Only a word goes back in the URL, never a code or token.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const web = new URL("/hostel-admin/backup", request.nextUrl.origin).toString();
  // Read only to pick where to send the owner back; its signature is checked in the service.
  let fromApp = false;

  try {
    fromApp = JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString("utf8"))?.f === "app";
  } catch {
    // unreadable state: the web page is safe either way
  }

  const target = fromApp ? APP_RETURN : web;

  try {
    if (!code) throw new Error("no code");

    await completeDriveConnect(code, state);

    return NextResponse.redirect(`${target}?drive=connected`);
  } catch {
    return NextResponse.redirect(`${target}?drive=failed`);
  }
}
