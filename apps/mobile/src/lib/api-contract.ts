/**
 * Shapes and constants shared with `apps/web`'s REST layer.
 *
 * Every route handler wraps its payload in `successResponse`, so responses are
 * `{ success: true, message, data }` and failures are
 * `{ success: false, message, errorCode }`. `unwrap` exists so no caller has to
 * remember the envelope.
 */

import type { AxiosError, AxiosResponse } from "axios";

/** Mirrors apps/web/src/lib/mobile-auth.ts. */
export const AUTH_CLIENT_HEADER = "x-hostelhub-client";
export const MOBILE_AUTH_CLIENT = "mobile";

export type ApiEnvelope<T> = {
  data: T;
  message: string;
  success: true;
};

export type ApiFailure = {
  /**
   * What the thrower attached, when it attached anything.
   *
   * `handleRouteError` forwards it from any error carrying a `details` property,
   * so the shape is per-`errorCode` and never guaranteed — a refused payment
   * claim names the month and date it collided with, and most failures carry
   * nothing at all. Read it through {@link readApiErrorDetails}, which types the
   * hole rather than pretending it is filled.
   */
  details?: unknown;
  errorCode: string;
  message: string;
  success: false;
};

export function unwrap<T>(response: AxiosResponse<ApiEnvelope<T>>): T {
  return response.data.data;
}

/** The code `handleRouteError` answers every Zod rejection with. */
const VALIDATION_ERROR = "VALIDATION_ERROR";

/**
 * Zod's own wording, which names no field: "Invalid input", "Too small: …".
 * A schema that wrote its own sentence ("Enter the 10-digit mobile number your
 * eSewa account uses.") already reads as advice and must not be prefixed.
 */
const UNHELPFUL_ISSUE = /^(invalid|required|expected|too small|too big|unrecognized|must be)\b/i;

/** `refundAccount.number` → `Number`; array indexes are not field names. */
function fieldName(path: string) {
  const leaf = path
    .split(".")
    .filter((part) => part && !/^\d+$/.test(part))
    .pop();

  return leaf
    ? leaf.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
    : "";
}

/**
 * The sentences a rejected form is actually carrying, in schema order.
 *
 * The server answers a failed schema with the message "Validation failed" and
 * puts the real ones — the ones written for the person typing — in
 * `details.issues`. Showing the envelope's message tells someone their form is
 * wrong and nothing else, which is the complaint this exists to answer.
 */
export function readValidationIssues(error: unknown): string[] {
  const failure = (error as AxiosError<ApiFailure>)?.response?.data;

  if (failure?.errorCode !== VALIDATION_ERROR) {
    return [];
  }

  const issues = (failure.details as { issues?: unknown } | undefined)?.issues;

  if (!Array.isArray(issues)) {
    return [];
  }

  const messages = issues.flatMap((issue) => {
    const { message, path } = (issue ?? {}) as { message?: unknown; path?: unknown };
    const text = typeof message === "string" ? message.trim() : "";

    if (!text) {
      return [];
    }

    const label = typeof path === "string" ? fieldName(path) : "";

    return [label && UNHELPFUL_ISSUE.test(text) ? `${label}: ${text}` : text];
  });

  return [...new Set(messages)];
}

/**
 * Turns any thrown value into something worth showing a user.
 *
 * The server's own `message` is written for humans, so prefer it. Only fall
 * back to a generic line when there isn't one — "Request failed with status
 * code 500" helps nobody.
 */
export function readApiError(error: unknown, fallback = "Something went wrong."): string {
  const axiosError = error as AxiosError<ApiFailure>;
  const issues = readValidationIssues(error);

  // Two is enough to fix a form. A wall of them in a toast is read by nobody,
  // and the rest surface as soon as the first two are corrected.
  if (issues.length > 0) {
    return issues.slice(0, 2).join(" ");
  }

  if (axiosError?.response?.data?.message) {
    return axiosError.response.data.message;
  }

  if (axiosError?.code === "ECONNABORTED") {
    return "The server took too long to respond. Check your connection and try again.";
  }

  if (axiosError?.request && !axiosError.response) {
    return "Can't reach the server. Check your internet connection.";
  }

  if (error instanceof Error && error.message) {
    if (!isTechnicalError(error)) {
      return error.message;
    }

    // For the logs only. A person holding the phone was shown "Call to function
    // 'FileSystemUploadTask.start' has been rejected. → Caused by: …" (ch 35).
    console.warn("[error]", error.message);

    if (/time ?out|timed out/i.test(error.message)) {
      return "The server took too long to respond. Check your connection and try again.";
    }

    if (/network|connect|unreachable|resolve host|socket/i.test(error.message)) {
      return "Can't reach the server. Check your internet connection.";
    }
  }

  return fallback;
}

/** Text a native module or the JS engine wrote for developers, not for people. */
const TECHNICAL_TEXT =
  /Call to function|Caused by|Exception|java\.|kotlin\.|undefined is not|is not a function|Cannot read propert|null is not an object|Request failed with status|^\s*\w*Error:/;

/**
 * Whether an error's message is for developers. Our own throws are a plain
 * `Error` (or a named class like `UploadError`) with a sentence in it; a native
 * module's rejection carries a string `code` (expo's `CodedError`), and the
 * engine's own failures are `TypeError` and friends.
 */
export function isTechnicalError(error: Error): boolean {
  return (
    typeof (error as { code?: unknown }).code === "string" ||
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError ||
    TECHNICAL_TEXT.test(error.message)
  );
}

/**
 * The two messages `readApiError` produces when the request never reached a
 * server, held as constants so the predicate below cannot drift from them.
 */
const OFFLINE_MESSAGES = [
  "The server took too long to respond. Check your connection and try again.",
  "Can’t reach the server. Check your internet connection.",
  "Can't reach the server. Check your internet connection.",
] as const;

/**
 * Whether a rendered error message means *no network* rather than *bad answer*.
 *
 * Screens hold `error` as a string — `useResource` throws the raw axios error
 * away — so this reads the message rather than the cause. That is a deliberate
 * trade and not a lossy one: the two strings above are only ever produced by the
 * two branches of `readApiError` that fire when there is no response to read,
 * and a server that genuinely returned one of them as its `message` would be
 * saying the same thing anyway.
 *
 * The alternative is a connectivity listener, which means a native module and a
 * new dev build for a signal that is strictly weaker: a phone can hold four bars
 * of a captive-portal Wi-Fi and reach nothing.
 */
export function isOfflineError(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }

  return OFFLINE_MESSAGES.some((candidate) => message === candidate);
}

export function readApiErrorCode(error: unknown): string | null {
  return (error as AxiosError<ApiFailure>)?.response?.data?.errorCode ?? null;
}

/**
 * The `details` object a failure carried, or null.
 *
 * Typed by the caller, because the shape belongs to the `errorCode` rather than
 * to the envelope — a refused payment claim carries the month and date it
 * collided with, a validation failure carries Zod issues, and most failures
 * carry nothing. Anything non-object (a string, a number, an array the caller
 * did not expect) reads as null: a caller reaching for `details.priorPeriod` on
 * one should render the generic failure, not `undefined` dressed as a fact.
 */
export function readApiErrorDetails<T>(error: unknown): T | null {
  const details = (error as AxiosError<ApiFailure>)?.response?.data?.details;

  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as T)
    : null;
}
