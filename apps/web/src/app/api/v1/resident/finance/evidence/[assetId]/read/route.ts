import { Types } from "mongoose";
import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { connectToDatabase } from "@/lib/db";
import { readStoredObject } from "@/lib/uploads/verify";
import {
  extractClaimFields,
  isDefinitelyNotPaymentEvidence,
  isEvidenceOcrEnabled,
  isPdfEvidence,
  looksLikePaymentReceipt,
  readEvidence,
  referenceOnEvidence,
} from "@/modules/finance/evidence-ocr";
import {
  directionRefusal,
  outcomeRefusal,
  readEvidenceDirection,
} from "@/modules/finance/evidence-direction";
import {
  looksLikeStatement,
  methodForProvider,
  parseReceipt,
  STATEMENT_GUIDANCE,
} from "@/modules/finance/evidence-receipt";
import {
  hostelPayeeIdentity,
  payeeRefusal,
  readPayeeOnEvidence,
} from "@/modules/finance/evidence-payee";
import { systemDocumentKindFromText } from "@/modules/finance/evidence";
import { receiptBank } from "@/modules/finance/receipt-labels";
import { transactionCodeProblem } from "@/modules/finance/transaction-code";
import { findCurrentResident } from "@/modules/residents/resident-access";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { InvoiceModel } from "@hostel/db/models/Invoice";

export const runtime = "nodejs";

/**
 * The outer bound on a read, in seconds.
 *
 * Belt to `evidence-ocr`'s braces. That module now gives up on a recognition
 * after its own budget, which is the fix that matters; this is the guarantee
 * that holds even if some future path inside the stream forgets to bound
 * itself. It was the absence of *any* limit here that let a stalled recogniser
 * hold the response open until the platform killed it — minutes during which
 * the resident's claim form sat on "Reading the amount and transaction ID…".
 *
 * Comfortably above the recognition budget plus the object fetch, and well
 * below the mobile client's own 45-second deadline, so the phone receives a
 * real verdict rather than timing out and reporting the file as unreadable.
 */
export const maxDuration = 30;

/**
 * Reads a just-uploaded payment screenshot and hands back what it appears to say,
 * so the claim form can fill itself in.
 *
 * **Streamed, one JSON object per line.** The recogniser takes around a second on
 * a full-size phone screenshot, which is long enough that a silent spinner is a
 * screen the resident suspects is broken. Rather than animate invented progress,
 * each stage is announced as it actually begins — decoding, reading, matching —
 * so what the resident is told is what the server is doing. The last line carries
 * the fields.
 *
 * Nothing here settles, records or claims anything: it is a read of the
 * resident's own file. The claim itself is still validated from scratch on
 * submit, so a resident who edits a pre-filled value — or forges one straight into
 * the request — gains nothing at all.
 *
 * Authorization is the whole security surface, and it is the same rule as
 * `assertClaimAssetUsable`'s first three properties: the asset must exist, be
 * live, be *theirs*, belong to their hostel and have completed its upload. A
 * missing asset and someone else's answer identically, so a resident probing ids
 * learns nothing from the difference.
 */

type RouteContext = { params: Promise<{ assetId: string }> };

type Stage =
  | { stage: "decoding" }
  | { stage: "reading" }
  | { stage: "matching" }
  | {
      /** The bank named on the receipt, so the share sheet can draw its logo. */
      bank?: ReturnType<typeof receiptBank>;
      fields: ReturnType<typeof extractClaimFields>;
      /**
       * False when the text was read and is not a payment record at all (gap fix
       * 3's receipt signals). Told to the resident *here*, on the form, where the
       * wrong screenshot costs ten seconds to swap — rather than to a reviewer
       * tomorrow, or to nobody.
       */
      looksLikeReceipt: boolean;
      /**
       * True when the file was read clearly and carries no trace of a payment at
       * all. **The submit path refuses this**, so the form must too — the strong
       * form of `looksLikeReceipt: false`, which stays a warning.
       */
      notPayment: boolean;
      /**
       * Whether the invoice's own reference code is on the receipt — and the code
       * itself, so the form can name it.
       *
       * Null whenever the question could not be asked: no invoice was passed, the
       * invoice carries no code, or nothing could be read off the file. **Null is
       * not "absent"** — telling a resident their code is missing from a receipt
       * we never managed to read would be an accusation made out of our own
       * failure, and this is the one signal on the screen that asks them to go
       * and do something.
       */
      reference: { code: string; found: boolean } | null;
      /**
       * Why nothing was read, when nothing was read. Null on a successful read.
       *
       * **Diagnostic, and it exists because the absence of one hid a dead
       * recogniser for weeks.** Every failure mode in this pipeline degrades to
       * "no text", and "no text" reached the resident as one sentence — "We
       * could not read this one" — whether the engine was switched off,
       * unconfigured, over its budget, timed out, or genuinely handed an
       * unreadable photograph. Production sat in one of those states while every
       * local run stayed green, and nothing on any screen or in any log told the
       * two apart.
       *
       * **Nothing branches on it.** No flag is derived from it and the resident
       * is never shown it: the sentence they read stays the same, because the
       * action they should take is the same. It is here so that a developer with
       * the network tab open, and the server log beside it, can see which
       * failure this is.
       */
      reason: string | null;
      /**
       * The sentence the submit path is certain to refuse this file with, or
       * null.
       *
       * Carried as prose rather than a code because there are three of them —
       * wrong direction, failed transaction, wrong payee — and the form's job is
       * identical for all three: stop the resident here, say why in words they
       * can act on, and let them pick a different file. Computed by the same
       * functions `submitClaim` calls, so the two cannot drift into telling a
       * resident different things ten seconds apart.
       */
      refusal: string | null;
      /**
       * Set when the file is a whole account statement rather than a receipt for
       * one payment.
       *
       * **Guidance, not a refusal** — their payment almost certainly *is* on that
       * page. But nothing on it says which row is this month's rent, so a
       * reviewer handed one has to guess, and asking for the single receipt while
       * the resident is still on the form costs them ten seconds instead.
       */
      statementGuidance: string | null;
      stage: "done";
      /**
       * True when the file is a receipt *we* issued, read off its printed marker.
       *
       * Told here because this screen was actively encouraging the mistake. Our
       * receipt prints the invoice's reference code, so the read found it and the
       * form said, in green, "your code is on this receipt" — the strongest
       * encouragement on the page, shown for the one file that cannot be
       * accepted. The resident then pressed Submit and was refused for reasons
       * that contradicted what they had just been told.
       *
       * The submit path refuses this independently. This exists so the refusal
       * happens ten seconds earlier, in front of the file picker.
       */
      systemDocument: boolean;
      text: boolean;
    };

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireResidentPrincipal(request);
    const resident = await findCurrentResident(principal);
    const { assetId } = await context.params;

    await connectToDatabase();

    const asset = Types.ObjectId.isValid(assetId)
      ? await FileAssetModel.findOne({
          _id: assetId,
          isDeleted: false,
          status: "ACTIVE",
        })
          .select("bucket hostelId imageInsight key mimeType ownerId uploadCompletedAt")
          .lean<{
            bucket: string;
            hostelId?: Types.ObjectId;
            imageInsight?: { nearBlank?: boolean; width?: number };
            key: string;
            mimeType?: string;
            ownerId?: Types.ObjectId;
            uploadCompletedAt?: Date;
          } | null>()
      : null;

    if (!asset || asset.ownerId?.toString() !== principal.userId) {
      return errorResponse("File not found", "NOT_FOUND", 404);
    }

    if (asset.hostelId && asset.hostelId.toString() !== resident.hostelId.toString()) {
      return errorResponse("File not found", "NOT_FOUND", 404);
    }

    if (!asset.uploadCompletedAt) {
      return errorResponse(
        "This file did not finish uploading.",
        "ASSET_UPLOAD_INCOMPLETE",
        422,
      );
    }

    /**
     * The invoice this receipt is being uploaded against, when the form says so.
     *
     * Read from our own database rather than taken from the request: the code is
     * about to be shown to the resident as *their* code for *this* month, and a
     * client-supplied one would let a mistyped query string put somebody else's
     * code on the screen. Scoped to this resident for the same reason every other
     * lookup here is — an id they do not own reads as no invoice at all, and the
     * reference block simply does not appear.
     */
    const invoiceId = request.nextUrl.searchParams.get("invoiceId") ?? "";
    const invoice = Types.ObjectId.isValid(invoiceId)
      ? await InvoiceModel.findOne({
          _id: invoiceId,
          hostelId: resident.hostelId,
          residentId: resident._id,
        })
          .select("referenceCode")
          .lean<{ referenceCode?: string } | null>()
      : null;
    const referenceCode = invoice?.referenceCode ?? "";

    /**
     * The accounts this hostel actually collects in, for the payee check.
     *
     * Loaded here rather than inside the stream so a slow profile read delays
     * nothing the resident is watching — it happens while the bytes are still
     * being fetched. Failure degrades to an empty identity, which makes the
     * payee question unanswerable rather than answered wrongly.
     */
    const [profile, hostel] = await Promise.all([
      HostelPaymentProfileModel.findOne({ hostelId: resident.hostelId })
        // `qrPayee*` are not optional extras here: for a hostel that uploaded a
        // QR and typed nothing — the common case — they are the *only*
        // identifiers it has, read off the poster at upload. Projecting them
        // away leaves such a hostel `UNKNOWN` on every claim.
        .select(
          "bankAccountName bankAccountNumber displayName esewaId extraAccounts khaltiId qrPayeeName qrPayeeNumber",
        )
        .lean<{
          bankAccountName?: string | null;
          bankAccountNumber?: string | null;
          displayName?: string | null;
          esewaId?: string | null;
          extraAccounts?: Array<{ accountName?: string | null; number?: string | null }> | null;
          khaltiId?: string | null;
          qrPayeeName?: string | null;
          qrPayeeNumber?: string | null;
        } | null>(),
      HostelModel.findById(resident.hostelId)
        .select("name")
        .lean<{ name?: string } | null>(),
    ]).catch(() => [null, null] as const);

    const payeeIdentity = hostelPayeeIdentity(profile, hostel?.name ?? null);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: Stage) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        const finish = (line: Stage) => {
          send(line);
          controller.close();
        };

        /**
         * Why this read produced nothing, filled in on the way out.
         *
         * A single mutable local rather than a value threaded through four
         * returns: the payloads below are identical apart from this, and
         * duplicating the shape a fifth time to carry one string is how they
         * drift apart.
         */
        let reason: string | null = null;

        try {
          // A PDF reads *better* than a screenshot — its text is text — so it
          // takes the same path. What cannot be read is an image nothing measured
          // at upload, and saying so immediately beats a second of stages that
          // cannot lead anywhere.
          const readable =
            isEvidenceOcrEnabled() &&
            (isPdfEvidence(asset.mimeType) ||
              (asset.imageInsight?.width !== undefined &&
                asset.imageInsight?.nearBlank === false));

          if (!readable) {
            // Two different things, and worth distinguishing in the log: the
            // hostel switched reading off, or the file was never measured at
            // upload and there is nothing safe to hand a recogniser.
            reason = isEvidenceOcrEnabled() ? "not-measured" : "disabled";

            finish({
              fields: {},
              looksLikeReceipt: true,
              notPayment: false,
              reason,
              reference: null,
              refusal: null,
              statementGuidance: null,
              stage: "done",
              systemDocument: false,
              text: false,
            });

            return;
          }

          send({ stage: "decoding" });

          const bytes = await readStoredObject({
            bucket: asset.bucket,
            key: asset.key,
          });

          if (!bytes) {
            // The object did not come back from storage. Nothing to do with
            // reading at all, and it used to be reported as an unreadable
            // receipt.
            reason = "fetch-failed";

            finish({
              fields: {},
              looksLikeReceipt: true,
              notPayment: false,
              reason,
              reference: null,
              refusal: null,
              statementGuidance: null,
              stage: "done",
              systemDocument: false,
              text: false,
            });

            return;
          }

          send({ stage: "reading" });

          const read = await readEvidence(bytes, asset.mimeType);
          const text = read.result?.text ?? null;

          if (text === null) {
            reason = read.failure;

            // Loud on the server, because this is the line that would have shown
            // a dead recogniser on the first claim rather than the hundredth.
            console.warn(
              `[evidence-read] no text for asset ${assetId}: ${read.failure}`,
            );

            finish({
              fields: {},
              looksLikeReceipt: true,
              notPayment: false,
              reason,
              reference: null,
              refusal: null,
              statementGuidance: null,
              stage: "done",
              systemDocument: false,
              text: false,
            });

            return;
          }

          send({ stage: "matching" });

          const ours = systemDocumentKindFromText(text) !== null;
          const direction = readEvidenceDirection(text);
          const receipt = parseReceipt(text);
          const payee = readPayeeOnEvidence(text, payeeIdentity, receipt.payee);

          // The template's provider beats the generic branding scan, and the
          // form's `Auto` setting is built on it: it is read off a recognised
          // layout rather than from any brand name that happens to appear on the
          // page — and an eSewa receipt for a bank transfer names both.
          const detectedMethod = methodForProvider(receipt.provider);

          const scanned = extractClaimFields(text);
          // The template fills what the page scan missed, and does not overrule
          // it: the scan is label-anchored across the whole file, the template is
          // exact on the layouts it knows, and between them the layouts this
          // module has never seen are the ones that need the scan.
          //
          // The id runs through the same plausibility rule `submitClaim` applies.
          // Pre-filling a value the submit path is certain to refuse is worse than
          // pre-filling nothing — the resident would press submit on our own
          // suggestion and be told it is not a transaction ID.
          const templateTxnId =
            receipt.txnId && !transactionCodeProblem(receipt.txnId)
              ? receipt.txnId
              : undefined;

          finish({
            bank: receiptBank(text),
            fields: {
              ...scanned,
              ...(detectedMethod ? { method: detectedMethod } : {}),
              ...(scanned.amount === undefined && receipt.amount !== null
                ? { amount: receipt.amount }
                : {}),
              ...(scanned.transactionCode === undefined && templateTxnId
                ? { transactionCode: templateTxnId }
                : {}),
            },
            looksLikeReceipt: looksLikePaymentReceipt(text),
            reason: null,
            notPayment: isDefinitelyNotPaymentEvidence(text),
            // Suppressed when the file is ours. The code genuinely *is* on it —
            // we printed it — so answering the question honestly here would put
            // the page's strongest encouragement on the one file the submit path
            // is about to refuse.
            reference:
              referenceCode && !ours
                ? { code: referenceCode, found: referenceOnEvidence(text, referenceCode) }
                : null,
            // Suppressed when the file is ours, for the same reason the reference
            // block is: `systemDocument` is the more specific sentence and the
            // form shows one refusal, not two.
            refusal: ours
              ? null
              : (outcomeRefusal(direction) ??
                directionRefusal(direction) ??
                payeeRefusal(payee)),
            statementGuidance:
              !ours && looksLikeStatement(text) ? STATEMENT_GUIDANCE : null,
            stage: "done",
            systemDocument: ours,
            text: true,
          });
        } catch {
          // Autofill is a convenience. Every failure mode ends the same way: no
          // fields, an empty form, and a resident who types them as before.
          //
          // `reason` keeps whatever the failing step set, and falls back to the
          // catch-all only when something threw before any step claimed it.
          reason ??= "unknown";

          finish({
              fields: {},
              looksLikeReceipt: true,
              notPayment: false,
              reason,
              reference: null,
              refusal: null,
              statementGuidance: null,
              stage: "done",
              systemDocument: false,
              text: false,
            });
        }
      },
    });

    // The share sheet (native and PWA) wants the verdict, not the stages: its
    // HTTP layer reads one JSON envelope, and it shows its own "Reading…".
    if (request.nextUrl.searchParams.get("format") === "json") {
      const lines = (await new Response(stream).text()).trim().split("\n");

      return successResponse(JSON.parse(lines[lines.length - 1]) as Stage, "Receipt read");
    }

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        // Nothing between here and the browser may buffer this: a proxy holding
        // the stages until the body completes turns the whole point of streaming
        // into a one-second pause.
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
