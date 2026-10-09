import "server-only";

import { SoftmatoApiError } from "@softmato/sdk";
import { SoftmatoTaskModel, SOFTMATO_TASK_KINDS } from "@hostel/db/models/SoftmatoTask";

import { connectToDatabase } from "@/lib/db";

import { isSoftmatoDown } from "./client";

/**
 * When Softmato — the parent company that issues every invoice and receipt —
 * cannot be reached, nothing is printed in its place. The person is told so,
 * plainly, and promised an email; `rememberTask` is that promise, and
 * `retry.ts` keeps it once Softmato answers again.
 */

export const SOFTMATO_DOWN_MESSAGE =
  "Our parent company's server is not responding right now. We have saved this and will email you to complete it as soon as the server is back. Thank you for your patience.";

export class SoftmatoUnavailableError extends Error {
  readonly errorCode = "SOFTMATO_UNAVAILABLE";
  readonly status = 503;

  constructor() {
    super(SOFTMATO_DOWN_MESSAGE);
    this.name = "SoftmatoUnavailableError";
  }
}

/**
 * Softmato answered, and said no — a 4xx, not an outage. Carried to the screen
 * with their own words: it used to fall through `handleRouteError` as a bare
 * "Internal server error", which told neither the owner nor us what was wrong.
 */
export class SoftmatoRejectedError extends Error {
  readonly errorCode = "SOFTMATO_REJECTED";
  readonly status = 502;

  constructor(reason: string) {
    super(`Our payment server could not accept this: ${reason}`);
    this.name = "SoftmatoRejectedError";
  }
}

export type SoftmatoTask = {
  email?: string | null;
  kind: (typeof SOFTMATO_TASK_KINDS)[number];
  link?: string | null;
  name?: string | null;
  ref: string;
};

/** One open row per thing, however many times it was attempted. */
export async function rememberTask(task: SoftmatoTask): Promise<void> {
  await connectToDatabase();
  await SoftmatoTaskModel.updateOne(
    { doneAt: null, kind: task.kind, ref: task.ref },
    { $setOnInsert: { ...task, attempts: 0, doneAt: null } },
    { upsert: true },
  ).catch((error: { code?: number }) => {
    // Two presses racing to remember the same thing: the other one did.
    if (error?.code !== 11000) throw error;
  });
}

/**
 * Runs `work`. If Softmato cannot be reached, remembers `task` and throws the
 * message the person sees; any other failure is left alone.
 */
export async function unlessSoftmatoDown<T>(
  task: () => Promise<SoftmatoTask | null> | SoftmatoTask | null,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SoftmatoApiError && !isSoftmatoDown(error)) {
      console.error(
        JSON.stringify({
          action: "softmato_request_rejected",
          code: error.code,
          level: "error",
          message: error.message,
          status: error.status,
        }),
      );

      throw new SoftmatoRejectedError(error.message || "the request was refused.");
    }

    if (!isSoftmatoDown(error)) throw error;

    const remembered = await task();

    if (remembered) await rememberTask(remembered);

    throw new SoftmatoUnavailableError();
  }
}
