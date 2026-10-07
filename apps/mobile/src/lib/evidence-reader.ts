import { useCallback, useRef, useState } from "react";

import { API_BASE_URL, rotateAccessToken } from "@/lib/api";
import { readTokens } from "@/lib/session";
import { finishUpload, startRead, updateUpload } from "@/lib/upload-queue";

/**
 * Reading the uploaded receipt, and reporting what the server finds on it.
 *
 * The mobile port of `apps/web/src/app/_components/use-evidence-reader.ts`, and
 * it talks to the same endpoint — `POST /resident/finance/evidence/{id}/read`.
 * Nothing about the read is client-side: the phone uploads a file and is told
 * what is on it. That matters twice over. The verdicts below decide whether the
 * submit button is live, and a verdict computed on the device would be a verdict
 * a modified client could compute differently.
 *
 * ## Why this screen needed it at all
 *
 * The submit endpoint has always run the same OCR and refused the same files —
 * our own receipt handed back to us, a photograph of a notebook, a receipt
 * showing money arriving rather than leaving, a screenshot already used for a
 * different month. So a mobile resident could never actually get a forged claim
 * past the server. What they could do is fill in a whole form, press Submit, and
 * be told no — having spent one of the **eight submits an hour** the endpoint
 * allows, because every one of them runs OCR over a full-size screenshot.
 *
 * The web form has read the file in front of the resident since it was written.
 * The phone did not, so the phone was the surface where a wrong file was
 * discovered last and cost the most. This closes that.
 *
 * ## Streamed, with a fallback that is not a downgrade in correctness
 *
 * The endpoint answers line-delimited JSON, announcing each stage as it reaches
 * it, because the recogniser takes about a second on a full-size phone
 * screenshot and a silent spinner on a screen about money is a screen people
 * back out of.
 *
 * React Native's built-in `fetch` is an XHR shim with no `response.body`, so the
 * stages need `expo/fetch` — the WinterCG client, which streams. It is required
 * lazily and inside a `try`, the same way `manage/statements.tsx` handles
 * `expo-document-picker`: it is backed by a native module, this project is bare,
 * and a binary built before it existed would otherwise throw at module load and
 * take the whole route down with a "missing default export".
 *
 * When it is missing we fall back to the platform `fetch` and read the body in
 * one piece. **The verdicts are identical** — they all ride on the final line —
 * and the only thing lost is the stage-by-stage narration, which collapses into
 * one label. A form that reads the file is worth far more than a progress line.
 *
 * ## Failure is quiet
 *
 * Autofill sits on top of a form that already worked. A resident whose receipt
 * could not be read should watch the status settle into "type these two in
 * yourself", not read an error about OCR — that is our problem, not theirs.
 */

export type EvidenceStage =
  | "idle"
  /** The bytes are still on their way to storage. The uploader owns this leg. */
  | "uploading"
  | "decoding"
  | "reading"
  | "matching"
  | "done";

export type EvidenceFields = {
  amount?: number;
  method?: string;
  referenceCode?: string;
  transactionCode?: string;
};

/**
 * Whether this invoice's reference code is on the receipt, and the code itself
 * so the screen can quote it back.
 *
 * Null means the question was not answered — no code allocated, nothing readable
 * on the file — and the screen must stay silent rather than tell a resident
 * their code is missing on the strength of a read that failed.
 */
export type EvidenceReference = { code: string; found: boolean };

/** What the resident is told at each stage. Plain language, no jargon. */
export const STAGE_LABELS: Record<Exclude<EvidenceStage, "done" | "idle">, string> = {
  decoding: "Opening your receipt…",
  matching: "Matching it to this invoice…",
  reading: "Reading the amount and transaction ID…",
  uploading: "Uploading your receipt…",
};

/** The last line of the stream, which carries every verdict. */
type StageMessage = {
  fields?: EvidenceFields;
  looksLikeReceipt?: boolean;
  notPayment?: boolean;
  reference?: EvidenceReference | null;
  refusal?: string | null;
  statementGuidance?: string | null;
  stage: EvidenceStage;
  systemDocument?: boolean;
  text?: boolean;
};

/**
 * How long a read may take before it is abandoned.
 *
 * **A read with no deadline is a form that freezes.** `fetch` has no default
 * timeout — unlike the axios client, which has twenty seconds — so a request
 * that neither answers nor fails leaves the strip on its first stage and, worse,
 * leaves the submit button disabled behind it: the resident is locked out of a
 * form they could otherwise have filled in by hand. That is exactly what a dead
 * API host produced, and it must not be a possible state whatever the cause.
 *
 * Forty-five seconds is chosen against the work rather than against patience: a
 * PDF is read in about a second because its text is text, and the slow case is
 * tesseract over a full-size phone screenshot on a cold serverless function,
 * which can take tens of seconds. Anything past that is not slow, it is stuck —
 * and the honest answer then is the one a failed read always gives, which is to
 * let the resident type the two fields themselves.
 */
const READ_TIMEOUT_MS = 45_000;

type FetchLike = typeof globalThis.fetch;

/**
 * `expo/fetch`, or null on a binary that predates it.
 *
 * `require` rather than `await import()`: a dynamic import is still resolved
 * eagerly by Metro at bundle time, and what has to survive here is the module
 * being absent from the *binary*.
 */
function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("expo/fetch") as { fetch?: FetchLike };

    return module.fetch ?? null;
  } catch {
    return null;
  }
}

function readUrl(assetId: string, invoiceId?: string) {
  const query = invoiceId ? `?invoiceId=${encodeURIComponent(invoiceId)}` : "";

  return `${API_BASE_URL}/api/v1/resident/finance/evidence/${assetId}/read${query}`;
}

/**
 * The read request, retried exactly once behind a token rotation.
 *
 * `lib/api.ts`'s axios interceptor refreshes and replays on a 401, and this
 * request does not go through axios — it needs a streaming response body, which
 * axios on React Native cannot give. So the one behaviour worth reproducing is
 * reproduced here, using the same shared rotation: `rotateAccessToken` waits on
 * the interceptor's own flag rather than racing it, which is what stops two
 * refreshes from invalidating each other's rotated token.
 *
 * A second 401 is given up on rather than retried again. The interceptor ends
 * the session properly when a refresh genuinely fails, and a convenience read is
 * not the request that should be making that call.
 */
async function requestRead(
  client: FetchLike,
  assetId: string,
  invoiceId: string | undefined,
  signal: AbortSignal,
  retryOn401: boolean,
): Promise<Response> {
  const tokens = await readTokens();
  const response = await client(readUrl(assetId, invoiceId), {
    headers: tokens?.accessToken
      ? { Authorization: `Bearer ${tokens.accessToken}` }
      : undefined,
    method: "POST",
    signal,
  });

  if (response.status !== 401 || !retryOn401) {
    return response;
  }

  const rotated = await rotateAccessToken();

  if (!rotated) {
    return response;
  }

  return requestRead(client, assetId, invoiceId, signal, false);
}

export function useEvidenceReader() {
  const [stage, setStage] = useState<EvidenceStage>("idle");
  const [fields, setFields] = useState<EvidenceFields | null>(null);
  const [reference, setReference] = useState<EvidenceReference | null>(null);
  /** A read finished and found nothing usable. The screen says so gently. */
  const [unreadable, setUnreadable] = useState(false);
  /**
   * The text was read and does not look like a payment record.
   *
   * Separate from {@link unreadable} and much louder: "we could not read this"
   * is our limitation, "this is not a receipt" is a fact about their file they
   * can act on in ten seconds. Still only a warning — a real receipt whose OCR
   * came out badly has to get through, and refusing genuine proof is the worse
   * failure by a distance.
   */
  const [notAReceipt, setNotAReceipt] = useState(false);
  /**
   * The file is a receipt *this system* issued.
   *
   * Blocking. Our receipt prints the invoice's reference code, so a screen that
   * only checked for the code would show its strongest encouragement — "your
   * code is on this receipt" — for the one file the submit path is certain to
   * refuse.
   */
  const [systemDocument, setSystemDocument] = useState(false);
  /**
   * A page of readable text with no provider, no money, no transaction and no
   * date. The blocking half of {@link notAReceipt}; the submit path refuses it.
   */
  const [notPayment, setNotPayment] = useState(false);
  /**
   * The sentence the submit path will refuse this file with, or null.
   *
   * Covers the three things a receipt can be *wrong about* rather than
   * unreadable: money arriving instead of leaving, a transaction that failed,
   * and a payment made to somebody who is not this hostel. Prose, because all
   * three need the resident to find a different file and the only useful thing
   * to say is which one and why. Computed by the same server functions the
   * submit path calls, so the form and the refusal cannot disagree.
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * A whole statement rather than one receipt.
   *
   * Deliberately not part of {@link refusal}: the payment is probably on that
   * page, so this asks for the single receipt and lets them submit either way.
   */
  const [statementGuidance, setStatementGuidance] = useState<string | null>(null);
  // A resident who re-picks a file mid-read gets the second read's answer, not
  // whichever request happened to finish last.
  const runId = useRef(0);

  const clear = useCallback(() => {
    setFields(null);
    setReference(null);
    setUnreadable(false);
    setNotAReceipt(false);
    setSystemDocument(false);
    setNotPayment(false);
    setRefusal(null);
    setStatementGuidance(null);
  }, []);

  const reset = useCallback(() => {
    runId.current += 1;
    setStage("idle");
    clear();
  }, [clear]);

  const applyDone = useCallback((message: StageMessage) => {
    const found = message.fields ?? {};
    const anything = Object.keys(found).length > 0;

    setFields(anything ? found : null);
    setReference(message.reference ?? null);
    setNotAReceipt(message.looksLikeReceipt === false);
    setSystemDocument(message.systemDocument === true);
    setNotPayment(message.notPayment === true);
    setRefusal(message.refusal ?? null);
    setStatementGuidance(message.statementGuidance ?? null);
    // Only when text was actually read *and* it is a plausible receipt: "we
    // could not read it" and "that is not a receipt" are different sentences and
    // must never both fire on one file.
    setUnreadable(!anything && message.looksLikeReceipt !== false);
  }, []);

  const read = useCallback(
    async (assetId: string, invoiceId?: string) => {
      const run = (runId.current += 1);
      const current = () => runId.current === run;

      clear();
      // `decoding` rather than a generic "working": it is the first thing the
      // server actually does, and on the non-streaming path it is the only label
      // the resident will see.
      setStage("decoding");

      const streaming = loadStreamingFetch();
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), READ_TIMEOUT_MS);
      /*
       * The read reports itself, the same way every upload and download in this
       * app does.
       *
       * `<UploadToaster />` is mounted at the root and renders whatever is in
       * this queue, so the stages follow the resident off the screen — which
       * matters here more than for an upload, because the read is the slow leg
       * and a resident who switches apps while tesseract works has, until now,
       * had no way to know it was still going.
       *
       * `verifying` is the queue's stage for "the bytes are there and the server
       * is deciding", which is exactly what a read is. The queue's own doc makes
       * the point that a download borrows the upload's five stages rather than
       * inventing more, and this borrows them for the same reason — as the
       * `read` direction, so the shade says "Checking payment receipt" rather
       * than claiming to be uploading something that is already uploaded.
       */
      const row = startRead("Payment receipt");

      try {
        const response = await requestRead(
          streaming ?? globalThis.fetch,
          assetId,
          invoiceId,
          abort.signal,
          true,
        );

        if (!response.ok) {
          throw new Error("unreadable");
        }

        for await (const message of streamMessages(response)) {
          // A newer read replaced this one. `break`, not `return`: the row below
          // must still finish, or the shade keeps "Reading it…" for ever.
          if (!current()) break;

          if (message.stage === "done") {
            applyDone(message);
          }

          setStage(message.stage);

          if (message.stage !== "done") {
            updateUpload(row, { fraction: null, stage: "verifying" });
          }
        }

        if (current()) setStage("done");

        finishUpload(row);
      } catch {
        if (current()) {
          setStage("done");
          setUnreadable(true);
        }

        /*
         * Reported as a finished row with no error, not as a failure.
         *
         * A read that could not be done is not something that went wrong for the
         * resident — the form still works and they type two fields. Putting a red
         * row in the toaster over it would tell them their *upload* failed, which
         * it did not, and send them to re-upload a file that is already stored.
         */
        finishUpload(row);
      } finally {
        clearTimeout(deadline);
      }
    },
    [applyDone, clear],
  );

  // `uploading` is not set here: the uploader owns that leg and the screen passes
  // it straight through, so the two cannot disagree about whether bytes are
  // moving.
  return {
    fields,
    notAReceipt,
    notPayment,
    read,
    reference,
    refusal,
    reset,
    statementGuidance,
    stage,
    systemDocument,
    unreadable,
  };
}

/**
 * The response body as a sequence of messages: streamed where the runtime can,
 * read whole where it cannot.
 *
 * Line-delimited JSON, so a chunk boundary may land mid-object — the tail stays
 * in the buffer until its newline arrives. A malformed line is skipped rather
 * than thrown on: the last line carries the verdicts, and losing the whole read
 * because a stage line arrived truncated would trade the answer for the
 * narration.
 */
async function* streamMessages(response: Response): AsyncGenerator<StageMessage> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;

  if (!body?.getReader) {
    for (const line of (await response.text()).split("\n")) {
      const message = parseLine(line);

      if (message) yield message;
    }

    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const message = parseLine(line);

      if (message) yield message;
    }
  }

  const tail = parseLine(buffer);

  if (tail) yield tail;
}

function parseLine(line: string): StageMessage | null {
  if (!line.trim()) {
    return null;
  }

  try {
    return JSON.parse(line) as StageMessage;
  } catch {
    return null;
  }
}
