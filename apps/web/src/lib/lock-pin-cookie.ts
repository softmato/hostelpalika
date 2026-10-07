import type { NextResponse } from "next/server";

import { signPurposeToken, verifyPurposeToken } from "@/lib/auth";

/**
 * Proof that this browser typed the account's app-lock PIN for this session.
 *
 * A token whose access claims say `lockPin` is refused by every portal page
 * (`proxy.ts` → `/unlock`) and every API guard (`requireApiPrincipal`, 423)
 * until this cookie is present and names the same user *and* session — so a
 * new sign-in asks again, and a copied cookie is useless on another session.
 * No `maxAge`: it dies with the browser, and the token inside caps it at 12 h.
 */
export const LOCK_PIN_UNLOCK_COOKIE = "hostelpalika_unlock";

const UNLOCK_TTL_SECONDS = 12 * 60 * 60;

type CookieReader = { get(name: string): { value: string } | undefined };

export async function isPinUnlocked(cookies: CookieReader, userId: string, sessionId = "") {
  const token = cookies.get(LOCK_PIN_UNLOCK_COOKIE)?.value;

  if (!token) return false;

  try {
    const payload = await verifyPurposeToken(token, "lock-pin-unlock");
    return payload.sub === userId && payload.sessionId === sessionId;
  } catch {
    return false;
  }
}

export async function applyPinUnlockCookie(
  response: NextResponse,
  userId: string,
  sessionId = "",
) {
  const token = await signPurposeToken({
    claims: { sessionId },
    purpose: "lock-pin-unlock",
    ttlSeconds: UNLOCK_TTL_SECONDS,
    userId,
  });

  response.cookies.set(LOCK_PIN_UNLOCK_COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
