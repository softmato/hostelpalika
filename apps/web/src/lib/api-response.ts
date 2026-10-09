import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { logger } from "@/lib/logger";

export type ApiSuccess<T> = {
  success: true;
  message: string;
  data: T;
};

export type ApiError = {
  success: false;
  message: string;
  errorCode: string;
  details?: unknown;
};

/**
 * Response init for public, per-visitor-identical payloads. Sends them to
 * Vercel's CDN cache, whose reads and writes are free and unmetered, instead of
 * `export const revalidate`, which uses the metered ISR cache for the same
 * behaviour. `s-maxage` is shared-cache only, so a browser still revalidates.
 * Never put this on an authed route — the response would be served to the next
 * visitor.
 */
export const PUBLIC_CACHE: ResponseInit = {
  headers: {
    "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
  },
};

export function successResponse<T>(
  data: T,
  message = "Request successful",
  init?: ResponseInit,
) {
  return NextResponse.json<ApiSuccess<T>>(
    {
      success: true,
      message,
      data,
    },
    init,
  );
}

export function errorResponse(
  message: string,
  errorCode = "BAD_REQUEST",
  status = 400,
  details?: unknown,
) {
  return NextResponse.json<ApiError>(
    {
      success: false,
      message,
      errorCode,
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) {
    // `flatten()` only buckets by *top-level* key, so a failure inside a nested
    // object reads as `{ profile: [...] }` — useless for pointing a user at the
    // input that is actually wrong. `issues` carries the full dotted path.
    const issues = error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.join("."),
    }));
    const details = { ...error.flatten(), issues };

    // A bare "422" in the dev terminal says nothing about which field was
    // rejected, which makes form bugs needlessly hard to chase.
    logger.warn("Request validation failed", { issues });

    return errorResponse("Validation failed", "VALIDATION_ERROR", 422, details);
  }

  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    "errorCode" in error &&
    typeof error.errorCode === "string"
  ) {
    // `details` when the thrower attached any. An instant rejection is only
    // actionable if it says *which* earlier payment it collided with (target
    // §11.3), and that fact is known here and nowhere else.
    return errorResponse(
      error.message,
      error.errorCode,
      error.status,
      "details" in error ? error.details : undefined,
    );
  }

  /*
   * Softmato (the payment server) said no. Every payment route can meet one,
   * and only some run inside `unlessSoftmatoDown`; the rest fell through to a
   * bare 500, which is how a refused lifetime invoice reached owners as
   * "Internal server error" while the reason sat in Softmato's own logs.
   * Matched by name so this module does not import the SDK.
   */
  if (error instanceof Error && error.name === "SoftmatoApiError") {
    const extra = Object.fromEntries(
      Object.entries(error).filter(
        ([key, value]) => !["message", "name", "stack"].includes(key) && value != null,
      ),
    );

    logger.error("Softmato refused a request", { error, ...extra });

    return errorResponse(
      `Our payment server could not accept this: ${error.message}`,
      "SOFTMATO_REJECTED",
      502,
    );
  }

  logger.error("Unhandled API route error", { error });
  return errorResponse("Internal server error", "INTERNAL_SERVER_ERROR", 500);
}

/** What `browserApi(…, onStep)` asks for, and what `progressResponse` streams. */
export const PROGRESS_CONTENT_TYPE = "application/x-ndjson";

/**
 * The same answer `successResponse` gives, but — when the caller asks for it —
 * with each step announced as it *starts*, one JSON line at a time.
 *
 * It exists so a waiting screen can say what is really happening ("reading
 * your invoice", "setting up the payment") instead of animating a guess. The
 * steps are the server's own: `run` calls `step()` right before the work it
 * names, so a line only ever describes something that is actually underway.
 *
 * A caller that does not send `Accept: application/x-ndjson` — the phone app,
 * a script — gets the plain JSON envelope, unchanged. Errors go through
 * `handleRouteError`, so a streamed failure carries exactly the message and
 * code the JSON route would have. Authenticate **before** calling this: a 401
 * must stay a real status, which is what lets `browserApi` refresh and retry.
 */
export async function progressResponse<T>(
  request: Request,
  run: (step: (name: string) => void) => Promise<T>,
  message = "Request successful",
): Promise<Response> {
  if (!request.headers.get("accept")?.includes(PROGRESS_CONTENT_TYPE)) {
    try {
      return successResponse(await run(() => {}), message);
    } catch (error) {
      return handleRouteError(error);
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      try {
        send({ data: await run((name) => send({ step: name })) });
      } catch (error) {
        const body = (await handleRouteError(error).json()) as ApiError;
        send({ error: { errorCode: body.errorCode, message: body.message } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      // Per-person and live: never cached, never buffered by a proxy.
      "Cache-Control": "private, no-store",
      "Content-Type": `${PROGRESS_CONTENT_TYPE}; charset=utf-8`,
      "X-Accel-Buffering": "no",
    },
  });
}
