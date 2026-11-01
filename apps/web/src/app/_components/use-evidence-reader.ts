"use client";

import { apiFetch } from "@/lib/api-url";
import { useCallback, useRef, useState } from "react";

import { residentEndpoints } from "@/lib/resident-endpoints";

/**
 * Reading the uploaded screenshot, with the stages shown as they happen.
 *
 * The recogniser takes about a second on a full-size phone screenshot. A second
 * of unexplained spinner on a screen about money is a screen people back out of,
 * so the server announces each stage as it starts and this consumes them —
 * **nothing here is on a timer.** If the decode is slow, "Decoding the image" is
 * what stays on screen, because that is what is actually happening.
 *
 * Failure is silent by design. Autofill is a convenience laid over a form that
 * already worked; a resident whose screenshot could not be read should see the
 * status disappear and type the two fields, not read an error about OCR.
 *
 * **`fetch` rather than `browserApi`, deliberately.** The response is a stream of
 * stages and `browserApi` parses a single JSON envelope, so it cannot carry this.
 * The cost is its transparent 401-refresh-and-replay: if the access token expires
 * at exactly this moment the read is abandoned and the resident types the fields
 * themselves, while the submit that follows still refreshes and succeeds. Auth is
 * cookie-based, so `same-origin` credentials are all the request needs.
 */

export type EvidenceStage =
  | "idle"
  /** The file is still on its way to storage — the uploader's own leg. */
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
 * What the resident is told at each stage. Plain language, no jargon.
 *
 * `uploading` is in here so the strip reads as one continuous process rather than
 * appearing out of nowhere a second after the upload toast: the resident picks a
 * file and the same line follows it from their phone to the recognised numbers.
 */
export const STAGE_LABELS: Record<Exclude<EvidenceStage, "done" | "idle">, string> = {
  decoding: "Opening your receipt…",
  matching: "Matching it to this invoice…",
  reading: "Reading the amount and transaction ID…",
  uploading: "Uploading your receipt…",
};

/**
 * Whether this invoice's reference code is on the receipt the resident just
 * uploaded, and the code itself so the form can quote it back to them.
 *
 * Null means the question was not answered — no code allocated, or nothing
 * readable on the file — and the form must stay silent rather than tell a
 * resident their code is missing on the strength of a read that failed.
 */
export type EvidenceReference = { code: string; found: boolean };

export function useEvidenceReader() {
  const [stage, setStage] = useState<EvidenceStage>("idle");
  const [fields, setFields] = useState<EvidenceFields | null>(null);
  const [reference, setReference] = useState<EvidenceReference | null>(null);
  /** True once a read finished and found nothing usable — the form says so gently. */
  const [unreadable, setUnreadable] = useState(false);
  /**
   * True when the text was read and is not a payment record at all.
   *
   * Separate from `unreadable`, and much louder: "we could not read this" is our
   * limitation, while "this is not a payment receipt" is a fact about their file
   * that they can act on immediately.
   */
  const [notAReceipt, setNotAReceipt] = useState(false);
  /**
   * True when the file is a receipt this system issued.
   *
   * Louder than either of the two above and the only one that blocks: the other
   * states describe a file we could not vouch for, while this one describes a
   * file the submit path is certain to refuse. Telling the resident now saves
   * them filling in a form that cannot be submitted.
   */
  const [systemDocument, setSystemDocument] = useState(false);
  /**
   * True when the file was read clearly and is not a payment record of any kind.
   *
   * The blocking half of {@link notAReceipt}. That flag fires on weak evidence and
   * has to stay a warning — a real receipt whose OCR came out badly must still get
   * through — while this one fires only on a page of readable text with no
   * provider, no money, no transaction and no date. The submit path refuses it, so
   * the form refuses it here rather than letting the resident fill in a form that
   * cannot be submitted.
   */
  const [notPayment, setNotPayment] = useState(false);
  /**
   * The sentence the submit path will refuse this file with, or null.
   *
   * The blocking state that covers the three things a receipt can be *wrong
   * about* rather than unreadable: money moving into the resident's account
   * instead of out of it, a transaction that failed, and a payment made to
   * somebody who is not this hostel. All three arrive as prose because all three
   * need the resident to go and find a different file, and the only useful thing
   * the form can do is say which one and why.
   *
   * Server-computed by the same functions the submit path calls, so the form and
   * the refusal cannot disagree.
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * Set when the resident uploaded a whole statement rather than one receipt.
   *
   * Deliberately *not* part of `refusal`: the payment is probably on that page,
   * so the form asks for the single receipt while letting them submit either way.
   * Turning genuine proof away because it arrived in a longer document would be
   * the worse failure.
   */
  const [statementGuidance, setStatementGuidance] = useState<string | null>(null);
  // A resident who re-picks a file mid-read gets the second read's answer, not
  // whichever request happened to finish last.
  const runId = useRef(0);

  const reset = useCallback(() => {
    runId.current += 1;
    setStage("idle");
    setFields(null);
    setReference(null);
    setUnreadable(false);
    setNotAReceipt(false);
    setSystemDocument(false);
    setNotPayment(false);
    setRefusal(null);
    setStatementGuidance(null);
  }, []);

  const read = useCallback(async (assetId: string, invoiceId?: string) => {
    const run = (runId.current += 1);
    const current = () => runId.current === run;

    setFields(null);
    setReference(null);
    setUnreadable(false);
    setNotAReceipt(false);
    setSystemDocument(false);
    setNotPayment(false);
    setRefusal(null);
    setStatementGuidance(null);
    setStage("decoding");

    try {
      const response = await apiFetch(residentEndpoints.readEvidence(assetId, invoiceId), {
        method: "POST",
      });

      if (!response.ok || !response.body) {
        throw new Error("unreadable");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Line-delimited JSON, so a chunk boundary may land mid-object: the tail
      // stays in the buffer until its newline arrives.
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");

        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim() || !current()) continue;

          const message = JSON.parse(line) as {
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

          if (message.stage === "done") {
            const found = message.fields ?? {};
            const anything = Object.keys(found).length > 0;

            setFields(anything ? found : null);
            setReference(message.reference ?? null);
            setNotAReceipt(message.looksLikeReceipt === false);
            setSystemDocument(message.systemDocument === true);
            setNotPayment(message.notPayment === true);
            setRefusal(message.refusal ?? null);
            setStatementGuidance(message.statementGuidance ?? null);
            // Only when text was actually read *and* it is a plausible receipt:
            // "we could not read it" and "that is not a receipt" are different
            // sentences and must not both fire on the same file.
            setUnreadable(!anything && message.looksLikeReceipt !== false);
          }

          setStage(message.stage);
        }
      }

      if (current()) setStage("done");
    } catch {
      if (current()) {
        setStage("done");
        setUnreadable(true);
      }
    }
  }, []);

  // `uploading` is not set here: the uploader owns that leg and the form passes it
  // straight through, so the two cannot disagree about whether bytes are moving.
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
