import { takeSharedPayment } from "@/lib/shared-payment";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { isPdfReceipt } from "@/components/receipt-preview";
import { ShareReceiptGuide } from "@/components/share-receipt-guide";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Select, type SelectOption } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { WalletMark } from "@/components/ui/wallet-mark";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError, readApiErrorCode, readApiErrorDetails } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import { clearClaimDraft, readClaimDraft, saveClaimDraft } from "@/lib/claim-draft";
import { notifyClaimOutcome } from "@/lib/claim-notifier";
import { prepareEvidenceForUpload } from "@/lib/evidence-image";
import {
  AUTO_METHOD,
  CLAIM_METHODS,
  type ClaimErrors,
  type ClaimRejection,
  type ClaimRejectionDetails,
  claimRejection,
  hasErrors,
  parseClaimAmount,
  resolveClaimMethod,
  transactionCodeRequired,
  uploadRejection,
  validateClaim,
  whereToLook,
} from "@/lib/claim-form";
import {
  type EvidenceStage,
  STAGE_LABELS,
  useEvidenceReader,
} from "@/lib/evidence-reader";
import {
  type PayInstructions,
  type PaymentMethod,
  submitClaim,
} from "@/lib/finance-api";
import { formatMoney } from "@/lib/format";
import { formatMegabytes } from "@/lib/public-upload-limits";
import { residentQuery } from "@/lib/resident-queries";
import { toastError } from "@/lib/toast";
import { uploadAsset, type UploadProgress } from "@/lib/uploads";

/**
 * "Submit payment proof" — a claim against one invoice (target §11.2, §11.3).
 *
 * ## The receipt fills the form in
 *
 * This screen used to accept any image at all, say nothing about it, and leave
 * the resident to copy a ten-digit transaction id across from a screenshot they
 * were holding — the single most error-prone thing on it, and a mistyped id is
 * one of the instant rejections. The web form has read the file in front of the
 * resident since it was written; the phone did not, so the phone was where a
 * wrong file was discovered last and cost the most.
 *
 * It now uploads first and reads: `lib/evidence-reader.ts` streams the server's
 * stages while they happen, and the amount, the method and the transaction id
 * arrive off the receipt. **The promise is made before the picker**, not after —
 * a resident who does not know the file fills the form in types those fields
 * first, and the read deliberately does not overwrite typing, so the feature
 * they were never told about is the one that never runs.
 *
 * ## Every state of the upload is a state of the screen
 *
 * There are twelve, and each one is drawn rather than implied: nothing
 * attached; uploading, with the percentage; reading, with the fields it is about
 * to fill replaced by skeletons; read and filled; read and short of something;
 * read and unreadable; the three ways a file fails to attach at all; and the
 * three endings — submitted, not sent, refused.
 *
 * The rule that shapes all of them: **one notice, and it names the next
 * action.** A resident looking at this screen at any moment should be able to
 * read one card and know whether to wait, to type, to pick a different file, or
 * to leave. That is why the field borders carry the "which one" — three amber
 * captions under three fields would be three notices for one sentence — and it
 * is why the submit footer is absent for most of the flow rather than greyed.
 * It used to narrate its own unavailability — "Upload your proof first",
 * "Reading your receipt…" — which was a second statement of whatever the card
 * above it had already said, and cost the form a footer's height in every state
 * to say it. The bar is now mounted only once there is a claim to send, and from
 * that moment it is pinned to the bottom edge like any other CTA in this app.
 *
 * ## What blocks, what merely warns, and why the difference is the whole design
 *
 * The read comes back with verdicts of three strengths, and collapsing them
 * would break the screen in one direction or the other:
 *
 * - **Blocking** — the file is one *we* issued, or a page of text with no
 *   payment on it at all, or a receipt showing money arriving rather than
 *   leaving / a failed transaction / a payment to somebody who is not this
 *   hostel. The submit path refuses every one of these outright, so leaving the
 *   button live would let a resident fill in a whole form to be told no.
 * - **Warning** — "this does not look like a receipt", "that is a statement, not
 *   a receipt", "some details are missing". These fire on weak evidence and must
 *   never block: a genuine receipt whose OCR came out badly still has to reach a
 *   human, and refusing real proof is by far the worse failure.
 * - **Silent** — nothing could be read. The resident types two fields, as
 *   before. Autofill is a convenience laid over a form that already worked.
 *
 * **None of it is decided on the phone.** Every verdict is computed by the same
 * server functions `submitClaim` calls, so the form and the refusal cannot tell
 * a resident two different things ten seconds apart — and a modified client that
 * ignored them would still be refused at submit, because a client is not a gate.
 *
 * ## Why the submit button is not a retry loop
 *
 * `POST .../claims` is rate-limited to **8 an hour**: each call runs sharp and
 * tesseract over a full-size image, seconds of CPU per submit. A client that
 * retried on failure would spend a resident's whole budget in one frustrated
 * minute. Every check the server does that the phone can do first is done in
 * `lib/claim-form.ts` before a request is made — including the two
 * transaction-id rules, because `TXN_ID_REQUIRED` and `TXN_ID_NOT_PLAUSIBLE`
 * were costing a submit each to say something the phone already knew.
 *
 * ## A repeat submit is not a second claim
 *
 * The server is idempotent: a replayed submit collapses onto the existing claim
 * and answers `created: false` with a 200. That is reported as "already
 * submitted", not as a fresh success — telling someone their proof went through
 * twice is how they start wondering whether they paid twice.
 *
 * ## The three endings replace the form
 *
 * A submitted claim, a submit that did not go, and a claim refused outright are
 * all whole screens rather than toasts over a form the resident has no further
 * use for. The refusals in particular never reach the owner's queue, so this
 * screen is the only place the resident learns anything at all — and the one
 * that did not send keeps the typing, on disk, so `Save and exit` is a promise
 * that survives the process being killed.
 */

/**
 * The `<Select>`'s options: Auto leads, then the six the server accepts.
 *
 * Typed as `SelectOption<string>` rather than left to infer a union of the seven
 * literals. The screen holds the selection as a plain string — it is one of
 * these, or the resolved method, or nothing yet — and a narrower generic here
 * would push a cast onto every one of those.
 */
const METHOD_CHOICES: SelectOption<string>[] = [
  {
    description: "We read it off the receipt you upload",
    label: "Auto",
    value: AUTO_METHOD,
  },
  ...CLAIM_METHODS,
];

/** What a picker hands over, in the shape `attach` and a retry both need. */
type PickedFile = {
  fileName?: string | null;
  fileSize?: number;
  height?: number;
  mimeType?: string;
  uri: string;
  width?: number;
};

/**
 * Why the last file never became an attachment, and what to offer about it.
 *
 * `retry` is the whole distinction: a dropped connection wants the *same* file
 * sent again, and a refused type or an oversized photo wants a different one.
 * Offering "Try again" for the second is a button guaranteed to fail, and
 * offering "Choose a different file" for the first sends a resident hunting for
 * a problem with a file that is fine.
 */
type AttachFailure = { detail: string; retry: boolean; title: string };

/** Which of the three endings is on screen, and what it has to say. */
type Outcome =
  | { detail: string; kind: "failed" }
  | { kind: "duplicate" }
  | { kind: "submitted" };

export default function SubmitClaimScreen() {
  const { id, shared } = useLocalSearchParams<{ id: string; shared?: string }>();
  const { colors } = useAppTheme();
  const dates = useDates();

  const query = residentQuery.payInstructions(id);
  const instructions = useResource<PayInstructions>(query.load, {
    cacheKey: query.key,
    // The amount is prefilled from this, and re-reading it while the resident is
    // mid-form would move the number under their fingers.
    refetchOnFocus: false,
  });

  /**
   * Only what the resident has actually typed.
   *
   * **Derived, not synchronised.** The obvious build — an effect copying the
   * recognised fields into state — is a cascading render *and* a race: the read
   * lands after first paint, so any field they had already touched would be
   * overwritten by a value they had just corrected. Here their edit is the
   * override and the receipt is only the fallback, so "never clobber typing" is
   * a property of the shape rather than a check that has to keep holding.
   */
  const [edits, setEdits] = useState<{
    amount?: string;
    method?: string;
    transactionCode?: string;
  }>({});
  const [note, setNote] = useState("");
  const [proofAssetId, setProofAssetId] = useState<string | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [proofMimeType, setProofMimeType] = useState<string | undefined>(undefined);
  /**
   * The attached file as a *row* — a name, a size and a way to drop it.
   *
   * The preview used to be a 180-point image sitting between the picker and the
   * form, which on a phone is most of a screen spent on a picture the resident
   * has already looked at inside the app they paid with. What they actually need
   * from it is confirmation that the right file went, which a thumbnail and a
   * filename give in a fortieth of the space — and the full-size view is one tap
   * away on the row, for the moment they want to check a digit.
   */
  const [proofFile, setProofFile] = useState<{ name: string; size?: number } | null>(
    null,
  );
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ClaimErrors>({});
  const [rejection, setRejection] = useState<ClaimRejection | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /**
   * Why the last file never became an attachment.
   *
   * Kept on the screen rather than left to the upload toaster, and it is the
   * difference between a resident who knows to take a different screenshot and
   * one staring at an empty dropzone. A refused *upload* clears the preview, so
   * without this the whole event is a toast that scrolls away and a form that
   * looks exactly as it did before they picked anything.
   *
   * It replaces the dropzone rather than sitting above it, because the button it
   * carries **is** the dropzone for this state: a card saying "this file is too
   * large" over a picker saying "just upload the proof" is two instructions, and
   * the resident follows the wrong one.
   *
   * Not the full-screen `rejection`: that one ends the attempt, which is right
   * for a claim the server refused and far too heavy for "that photo will not
   * open, pick another".
   */
  const [attachFailure, setAttachFailure] = useState<AttachFailure | null>(null);
  /**
   * The last file picked, so `Try again` can send it again.
   *
   * Only ever read on the transient branch. A retry that reopened the picker
   * would be asking the resident to find the file a second time to fix a problem
   * that was never about the file.
   */
  const [lastPicked, setLastPicked] = useState<PickedFile | null>(null);
  /**
   * Which attach attempt the screen is currently showing.
   *
   * An upload is not cancellable — `uploadAsset` owns a PUT that will finish or
   * fail on its own schedule — so the resident tapping ✕ mid-transfer, or
   * picking a second file over the first, leaves a promise in flight that still
   * intends to write an asset id into state. Without a ticket it does: the
   * removed file comes back as a bare `proofAssetId` with no row above it, the
   * read starts, and the submit button lights up over an empty dropzone.
   *
   * A ref rather than state, because nothing renders from it and a re-render on
   * every pick would be a re-render for nobody.
   */
  const attempt = useRef(0);
  const [whereOpen, setWhereOpen] = useState(false);
  /**
   * Whether this build can open the system file browser at all.
   *
   * Once per mount — whether a native module is linked cannot change while the
   * app is running — and read here rather than inside the dropzone, because the
   * failed-attach card offers the same way back in.
   */
  const [canPickDocument] = useState(() => loadDocumentPicker() !== null);

  const evidence = useEvidenceReader();
  const { read: readEvidence, reset: resetEvidence } = evidence;
  const found = evidence.fields;
  const data = instructions.data;

  useEffect(() => {
    if (proofAssetId) {
      // The invoice goes with the read so the server can check *this month's*
      // reference code against the receipt, rather than the screen guessing from
      // whatever code the extractor happened to find on the image.
      void readEvidence(proofAssetId, id);
    } else {
      resetEvidence();
    }
  }, [id, proofAssetId, readEvidence, resetEvidence]);

  /*
   * A draft left behind by `Save and exit`, put back.
   *
   * Guarded on the state still being untouched rather than on a mounted flag:
   * the storage read is fast but it is not synchronous, and a resident who
   * started typing in the frame before it landed must not have their first
   * keystrokes replaced by yesterday's. The proof comes back as an **asset id**,
   * which restarts the read above — so the verdicts are recomputed from the file
   * rather than restored from a guess at what they were, and a receipt the
   * server has since matched to a payment says so.
   */
  useEffect(() => {
    let cancelled = false;

    if (shared) return;
    void readClaimDraft(id).then((draft) => {
      if (cancelled || !draft) {
        return;
      }

      setEdits((current) =>
        Object.keys(current).length > 0
          ? current
          : {
              amount: draft.amount,
              method: draft.method,
              transactionCode: draft.transactionCode,
            },
      );
      setNote((current) => current || (draft.note ?? ""));

      if (draft.proofAssetId) {
        setProofAssetId((current) => current ?? draft.proofAssetId ?? null);
        setProofPreview((current) => current ?? draft.proofPreview ?? null);
        setProofMimeType((current) => current ?? draft.proofMimeType);
        setProofFile(
          (current) =>
            current ?? {
              name: draft.proofName ?? "Payment receipt",
              size: draft.proofSize,
            },
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [id, shared]);

  const amount =
    edits.amount ??
    (found?.amount !== undefined ? String(found.amount) : String(data?.amountDue ?? ""));
  const transactionCode = edits.transactionCode ?? found?.transactionCode ?? "";
  /**
   * What the resident chose, which may be `AUTO` — the default.
   *
   * Kept apart from `method`: the trigger has to keep saying `Auto` after a
   * receipt resolves to eSewa, or the setting changes under the resident and
   * their *next* upload is locked to the app the *last* one happened to be.
   */
  const selection = edits.method ?? AUTO_METHOD;
  /** What the receipt itself says the app was. Null until one is read. */
  const detected = found?.method ?? null;
  const method = resolveClaimMethod(selection, detected);
  const isCash = method === "CASH";
  /** Which fields the resident is looking at values they did not type. */
  const filled = {
    amount: edits.amount === undefined && found?.amount !== undefined,
    method: selection === AUTO_METHOD && Boolean(detected),
    transactionCode:
      edits.transactionCode === undefined && Boolean(found?.transactionCode),
  };
  /**
   * Which fields still want an answer — the ones the amber borders point at.
   *
   * Deliberately *not* `validateClaim`: that one runs on submit and speaks in
   * sentences, and running it during render would light three red fields the
   * moment the screen opened, before the resident had done anything at all.
   * This is the same question asked quietly — is there a value here yet — and it
   * is only ever consulted once a read has settled, which is the first moment
   * the screen has any standing to say a field is short.
   */
  const missing = {
    amount: !amount.trim(),
    method: !method,
    transactionCode: transactionCodeRequired(method) && !transactionCode.trim(),
  };
  const anyMissing = missing.amount || missing.method || missing.transactionCode;
  const filledAnything = filled.amount || filled.method || filled.transactionCode;

  /**
   * The read results that stop the form rather than informing it.
   *
   * Everything else the reader returns is a hint the resident may override — a
   * corrected amount, a retyped id, a receipt we thought looked odd. These are
   * not hints: the submit path refuses all of them. The wording is the server's
   * so the resident does not read two explanations of one refusal.
   */
  const blockReason = evidence.systemDocument
    ? "That is a receipt your hostel issued, not a record of your payment. Please upload the screenshot or receipt from the app you paid with — the one showing the money leaving your account."
    : evidence.notPayment
      ? "That file does not look like a payment at all — there is no app name, no amount and no transaction ID on it. Please upload the screenshot or receipt from the app you paid with."
      : // The three the server computed rather than this screen: money arriving
        // instead of leaving, a failed transaction, a payment to somebody who is
        // not this hostel. Taken as prose because each names something specific
        // about *their* file that a fixed string here could not say.
        (evidence.refusal ?? "");

  /*
   * One refusal, reported in two places.
   *
   * The banner is the durable copy — it stays on screen while the resident finds
   * a different file, which for the longer sentences is the whole point. The
   * toast is the one that *arrives*: it renders over the screen wherever they
   * have scrolled to, and the resident's eye is on the file row when the read
   * comes back, not on the notice above it.
   *
   * Fires on the transition into the blocked state, which is once per read.
   */
  useEffect(() => {
    if (blockReason) {
      toastError("That file cannot be used as proof", blockReason);
      /*
       * …and a third place, which is the only one that survives the resident
       * leaving.
       *
       * The read is the slow leg of this screen, and the obvious thing to do
       * while it runs is switch to the wallet app to copy the transaction ID.
       * Come back and the toast has gone; lock the phone and the whole answer
       * was delivered to nobody. The shade is where a verdict that arrived
       * while they were elsewhere can still be found.
       */
      notifyClaimOutcome(
        { body: blockReason, title: "That file cannot be used as proof", tone: "failure" },
        id,
      );
    }
  }, [blockReason, id]);

  /*
   * The six methods with their marks.
   *
   * `CLAIM_METHODS` is a plain label/value table in `lib/claim-form.ts`, which
   * has to stay node-testable and therefore cannot import a component. The marks
   * are attached here — and it matters on this list more than anywhere else in
   * the app, because getting the method wrong sends the hostel looking for the
   * payment in the wrong statement, and six wallet names in identical grey type
   * is exactly the list that gets mis-tapped.
   *
   * `Auto` takes the scan glyph rather than a wallet mark: it is not one of the
   * apps, and drawing it as though it were is how it stops reading as the
   * default that thinks for you.
   *
   * Memoised: a fresh array of seven JSX nodes on every keystroke of the inputs
   * either side of it would re-render the sheet's whole list.
   */
  const methodOptions = useMemo(
    () =>
      METHOD_CHOICES.map((option) => ({
        ...option,
        leading:
          option.value === AUTO_METHOD ? (
            <View className="h-7 w-7 items-center justify-center rounded-lg bg-brand-soft">
              <Ionicons color={colors.primary} name="scan-outline" size={16} />
            </View>
          ) : (
            // 28, not 32: the same node is drawn on the `<Select>` trigger, which
            // is `h-12` and would grow past the `<Input>`s either side of it.
            <WalletMark name={option.value} size={28} />
          ),
      })),
    [colors.primary],
  );

  const attach = useCallback(
    async (picked: PickedFile) => {
      // Claimed before anything is drawn, so a slower attempt already in flight
      // stops being able to write to this screen from here on.
      const ticket = (attempt.current += 1);

      // The local uri *is* the preview — the row's thumbnail draws a screenshot
      // straight off the phone, so it is on screen before the upload starts
      // rather than after it finishes.
      setProofPreview(picked.uri);
      setProofMimeType(picked.mimeType);
      setProofFile({
        // Camera captures arrive without one on several platforms, and "the file
        // you just took a photo of" needs no name to be recognised.
        name: picked.fileName ?? "Payment receipt",
        size: picked.fileSize,
      });
      setProofAssetId(null);
      setLastPicked(picked);
      setErrors((current) => ({ ...current, proofAssetId: undefined }));
      // Whatever was wrong with the last file is not what is wrong with this
      // one. Cleared on the way in so the notice cannot outlive its subject.
      setAttachFailure(null);
      // A new file makes every verdict about the old one wrong, and the read is
      // about to start from `decoding` anyway — clearing here means the strip
      // never shows the previous file's answer over the new file's preview.
      resetEvidence();

      try {
        /*
         * Shrunk to the size the server actually reads, before a byte moves.
         *
         * The recogniser works at a 1600px longest edge, so a 3456 × 4608 camera
         * frame spends ten times the bytes on detail that is discarded before it
         * is ever looked at — up a phone uplink, which is the slowest link in
         * the path and the one the resident is watching. PDFs and screenshots
         * already under the bar come back untouched, and any failure returns the
         * original, so this can only ever cost bytes rather than the claim.
         */
        const prepared = await prepareEvidenceForUpload(picked);
        const assetId = await uploadAsset(prepared, {
          kind: "PAYMENT_PROOF",
          label: "Payment proof",
          onProgress: setUpload,
        });

        if (attempt.current === ticket) {
          setProofAssetId(assetId);
        }
      } catch (caught) {
        if (attempt.current !== ticket) {
          // Removed, or replaced by a newer pick. The failure belongs to a file
          // that is no longer on the screen, and reporting it would put a red
          // card over whatever the resident is doing instead.
          return;
        }

        /*
         * The row is cleared: leaving a thumbnail on screen after a failed
         * upload is how somebody submits believing they attached something.
         */
        setProofPreview(null);
        setProofMimeType(undefined);
        setProofFile(null);

        /*
         * Every failure leaves a card behind, including the transient ones.
         *
         * This used to defer to the global upload toaster on the grounds that
         * two notices for one event read as two failures — true, and it cost
         * more than it saved. A toast is the wrong *lifetime* for this: the
         * resident has to still be able to see what happened while they walk to
         * a window for signal. It is also the wrong *shape*, because the only
         * useful answer to a dropped upload is a button that sends the same file
         * again, and a toast has nowhere to put one.
         *
         * `uploadRejection` still owns the named refusals — the ones that mean
         * "pick a different file" — and returns null for everything else, which
         * is what the retry branch is for.
         */
        const refused = uploadRejection(
          readApiErrorCode(caught),
          readApiError(caught, "That upload did not go through."),
        );

        setAttachFailure(
          refused
            ? { detail: refused.detail, retry: false, title: refused.title }
            : {
                detail:
                  "Please check your internet connection and try again. Your file is still on your phone.",
                retry: true,
                title: "Upload failed",
              },
        );

        // Only the refusals that name the file reach the shade. A "your
        // connection dropped" there is noise, and the retry button is on screen.
        if (refused) {
          notifyClaimOutcome(
            { body: refused.detail, title: refused.title, tone: "failure" },
            id,
          );
        }
      } finally {
        // Only if this attempt still owns the bar — otherwise it would clear the
        // progress of the upload that replaced it.
        if (attempt.current === ticket) {
          setUpload(null);
        }
      }
    },
    [id, resetEvidence],
  );

  useEffect(() => {
    if (!shared) return;
    void takeSharedPayment().then((file) => { if (file) void attach(file); });
  }, [attach, shared]);

  /** The ✕ on the attached row. Puts the picker back with nothing carried over. */
  const detach = useCallback(() => {
    // Whatever is in flight loses the right to write here. The PUT itself keeps
    // going — there is no way to stop it — and lands as an orphaned asset the
    // resident never claimed against, which costs storage and nothing else.
    attempt.current += 1;
    setUpload(null);
    setProofAssetId(null);
    setProofPreview(null);
    setProofMimeType(undefined);
    setProofFile(null);
    setLastPicked(null);
    setAttachFailure(null);
    resetEvidence();
  }, [resetEvidence]);

  const pick = useCallback(
    async (source: "camera" | "library") => {
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        toastError(
          "Permission needed",
          source === "camera"
            ? "Allow camera access to photograph your receipt."
            : "Allow photo access to attach your screenshot.",
        );
        return;
      }

      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 0.8,
            });

      const asset = result.canceled ? null : result.assets[0];

      if (asset) {
        await attach({
          fileName: asset.fileName,
          fileSize: asset.fileSize,
          height: asset.height,
          mimeType: asset.mimeType,
          uri: asset.uri,
          width: asset.width,
        });
      }
    },
    [attach],
  );

  /**
   * The PDF path.
   *
   * A bank receipt arrives as a PDF far more often than as a screenshot, and it
   * reads *better* than one — its text is text, so the server skips OCR
   * entirely and the fields come back exact. Until this existed the image picker
   * was the only way in, so the highest-quality evidence the product can receive
   * was the one kind of file a resident on a phone could not send.
   *
   * `expo-document-picker` is a native module and this project is bare, so it is
   * required inside the handler rather than imported: a binary built before it
   * was added would otherwise throw at module load and take the whole route down
   * as "missing default export". `loadDocumentPicker` lets the dropzone leave
   * the tile off rather than offer a tap that cannot work.
   */
  const pickDocument = useCallback(async () => {
    const picker = loadDocumentPicker();

    if (!picker) {
      toastError(
        "This build cannot open files",
        "The file picker is a native module added after this app was built. A photo or screenshot still works.",
      );
      return;
    }

    const result = await picker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png", "image/webp"],
    });
    const file = result.canceled ? null : result.assets?.[0];

    if (!file) {
      return;
    }

    await attach({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.mimeType ?? "application/pdf",
      uri: file.uri,
    });
  }, [attach]);

  /** Everything typed so far, in the shape the draft store keeps. */
  const draftOf = useCallback(
    () => ({
      amount,
      method: selection,
      note,
      proofAssetId: proofAssetId ?? undefined,
      proofMimeType,
      proofName: proofFile?.name,
      proofPreview: proofPreview ?? undefined,
      proofSize: proofFile?.size,
      transactionCode,
    }),
    [
      amount,
      note,
      proofAssetId,
      proofFile?.name,
      proofFile?.size,
      proofMimeType,
      proofPreview,
      selection,
      transactionCode,
    ],
  );

  const submit = useCallback(async () => {
    // Built here rather than during render: a fresh object every render would
    // change this callback's identity on every keystroke.
    const draft = { amount, method, proofAssetId, transactionCode };
    const problems = validateClaim(draft);

    setErrors(problems);

    /*
     * `!method` is redundant against `hasErrors` — the validator already refuses
     * a null one — and is kept because TypeScript cannot see that, and the
     * request below needs a narrowed `PaymentMethod`.
     */
    if (hasErrors(problems) || !method) {
      return;
    }

    setSubmitting(true);

    try {
      const result = await submitClaim(id, {
        amount: parseClaimAmount(draft.amount) as number,
        paymentMethod: method as PaymentMethod,
        proofImageAssetId: proofAssetId as string,
        referenceNote: note.trim() || undefined,
        transactionCode: transactionCode.trim() || undefined,
      });

      /*
       * The proof is on file either way, so the draft goes either way.
       *
       * Restoring one onto the next visit would offer to submit something that
       * has already been submitted, which is exactly the doubt this screen works
       * hardest to avoid.
       */
      await clearClaimDraft(id);

      if (result.created) {
        /*
         * The one good ending, and the one worth keeping.
         *
         * No toast: the whole screen now says it, and a toast over a screen
         * already reading "Claim submitted!" is the same sentence twice. The
         * notification stays, because it is the only durable receipt the
         * resident has that their proof went in — which, for a rent payment, is
         * the thing they will want to check again this evening.
         */
        notifyClaimOutcome(
          {
            body: "Your hostel will confirm it shortly.",
            title: "Payment proof submitted",
            tone: "success",
          },
          id,
        );
        setOutcome({ kind: "submitted" });
      } else {
        setOutcome({ kind: "duplicate" });
      }
    } catch (caught) {
      const instant = claimRejection(
        readApiErrorCode(caught),
        readApiError(caught),
        readApiErrorDetails<ClaimRejectionDetails>(caught),
        { day: dates.date, month: dates.period },
      );

      if (instant) {
        // The screenshot is the thing that has to change, so it goes — the
        // resident is one upload away from a valid claim rather than back at the
        // start of the form.
        setProofAssetId(null);
        setProofPreview(null);
        setProofMimeType(undefined);
        setProofFile(null);
        setRejection(instant);
        // A submit costs one of eight an hour, so being told it was refused is
        // worth as much as being told it worked — and the resident may have put
        // the phone down the moment they pressed the button.
        notifyClaimOutcome(
          { body: instant.detail, title: instant.title, tone: "failure" },
          id,
        );
        return;
      }

      /*
       * Not refused — never arrived. The form is worth keeping, and the typing
       * is worth keeping *off the process*: the commonest cause of this is a
       * phone with no signal, and the commonest response to that is to put the
       * phone away.
       *
       * Written before the screen offers `Save and exit` rather than when that
       * button is pressed. A resident who kills the app from the switcher
       * instead has done the same thing by a different route and should not lose
       * a ten-digit transaction id for it.
       */
      await saveClaimDraft(id, draftOf());
      // Deliberately no automatic retry: the endpoint costs seconds of server
      // CPU per call and allows eight an hour. The button is the resident's.
      setOutcome({ detail: readApiError(caught), kind: "failed" });
      notifyClaimOutcome(
        { body: readApiError(caught), title: "Could not submit your proof", tone: "failure" },
        id,
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    amount,
    dates.date,
    dates.period,
    draftOf,
    id,
    method,
    note,
    proofAssetId,
    transactionCode,
  ]);

  /*
   * "Submit payment proof", not "I've paid".
   *
   * The button on the invoice is still "I've paid" and should stay that way — it
   * is the resident's own claim, in their words, and it is what makes them tap.
   * A title has a different job: it names what the screen *is*, and this screen
   * is a form for handing over a receipt.
   */
  const header = <AppBar showBack title="Submit payment proof" />;
  /*
   * The endings drop the title.
   *
   * Nothing is being filled in any more, so a bar naming the form would be
   * chrome for a screen the resident is leaving — and the glyph and heading two
   * rows down already say what happened, far louder than a 16-point strip can.
   * The back arrow stays, because it is the only thing up there still worth
   * pressing.
   */
  const bareHeader = <AppBar showBack title="" />;

  if (instructions.loading) {
    return (
      /* The promise, the dropzone, then the three fields. */
      <Screen header={header} scroll>
        <View className="gap-4 pt-1">
          <Skeleton height={64} radius={16} />
          <Skeleton height={18} width="52%" />
          <Skeleton height={168} radius={16} />
          <Skeleton height={72} radius={12} />
          <Skeleton height={72} radius={12} />
          <Skeleton height={72} radius={12} />
        </View>
      </Screen>
    );
  }

  if (instructions.error || !data) {
    return (
      <Screen header={header}>
        <FailureState
          message={instructions.error ?? "This invoice could not be loaded."}
          onRetry={instructions.reload}
          title="Failed to load"
        />
      </Screen>
    );
  }

  if (outcome?.kind === "submitted" || outcome?.kind === "duplicate") {
    return (
      <SubmittedScreen
        duplicate={outcome.kind === "duplicate"}
        header={bareHeader}
        onDone={() => router.replace(`/invoice/${id}`)}
      />
    );
  }

  if (outcome?.kind === "failed") {
    return (
      <NotSentScreen
        detail={outcome.detail}
        header={bareHeader}
        onExit={() => router.replace(`/invoice/${id}`)}
        onRetry={() => setOutcome(null)}
      />
    );
  }

  if (rejection) {
    return (
      <RefusedScreen
        header={bareHeader}
        onBack={() => router.replace(`/invoice/${id}`)}
        rejection={rejection}
      />
    );
  }

  const uploading = upload !== null;
  /**
   * A file is attached and we do not yet know what is on it.
   *
   * Written against `proofAssetId` rather than against the reader's own stage,
   * and the difference is a hole in the barrier rather than a nicety. The read
   * starts in an effect, so between the upload resolving and that effect running
   * the stage is still `idle` — and a stage-only test reads that as "no read in
   * progress" and lights the submit button. One tap inside that window sends a
   * claim the read was a frame away from refusing, and spends one of the eight
   * submits an hour to be told so by the server instead.
   *
   * Anything attached is therefore unsubmittable until its read has finished,
   * however it finishes. The timeout in `lib/evidence-reader.ts` is what
   * guarantees that "finished" always arrives.
   */
  const reading = proofAssetId !== null && evidence.stage !== "done";
  /** The read is over and had something to say about the fields. */
  const settled = proofAssetId !== null && evidence.stage === "done" && !blockReason;

  /**
   * The border on one field, once there is standing to draw one.
   *
   * Green for a value the receipt gave, amber for one still wanted, and red only
   * where the read failed outright — the case the notice above calls "we
   * couldn't read this one", where every empty field is one the resident now has
   * to fill in by hand rather than one we merely missed.
   *
   * Nothing before the read settles: a form that opens with coloured borders is
   * telling the resident they have already got something wrong.
   */
  const toneFor = (
    field: "amount" | "method" | "transactionCode",
  ): "danger" | "success" | "warning" | undefined => {
    if (!settled) {
      return undefined;
    }

    if (filled[field]) {
      return "success";
    }

    if (missing[field]) {
      return evidence.unreadable ? "danger" : "warning";
    }

    return undefined;
  };

  /**
   * Whether there is a claim to send yet — and therefore whether the screen has
   * a footer at all.
   *
   * The gate is the same one that used to grey the button out: a proof,
   * uploaded, read, and not refused. What changed is that it now decides whether
   * the bar **exists**.
   *
   * A sticky footer costs its height in every state it is mounted, keyboard or
   * no keyboard, and for most of this form that height was spent on a control
   * that could not be pressed — which on a small phone is the difference between
   * the dropzone and the first field both fitting and the resident scrolling to
   * discover there is a form under the picker at all. Passing `undefined` gives
   * the whole bottom edge back to the page: `<Screen>` reserves footer clearance
   * only when it has a footer to reserve it for.
   *
   * And nothing is lost while it is gone. Every state that suppresses it already
   * draws its own reason — the dropzone asks for a file, the bar is moving, the
   * reading card is reading, the red banner refuses the one attached — so a
   * greyed button under any of them was a second, quieter statement of a fact
   * already on screen.
   *
   * The moment there *is* something to send, it is pinned rather than appended:
   * a submit that scrolls away is a submit the resident has to go looking for,
   * and this one sits under the thumb from the first frame it exists.
   */
  const readyToSubmit = proofAssetId !== null && !uploading && !reading && !blockReason;

  return (
    <Screen
      footer={
        readyToSubmit ? (
          /*
           * No `disabled`: `readyToSubmit` is the only thing between this and a
           * press, and `loading` already refuses a second tap — double-submitting
           * a payment claim spends one of eight an hour and reads, to the
           * resident, as having paid twice.
           */
          <Button
            label="Submit claim"
            loading={submitting}
            onPress={() => void submit()}
          />
        ) : undefined
      }
      header={header}
      scroll
    >
      <View className="gap-4 pt-1">
        {/*
          What is owed, in one line. The rate limit and the reference code used
          to ride along here; the code has its own row below, and a resident
          who hits the limit is told so by the refusal itself.
        */}
        <Notice icon="receipt-outline" title={`${formatMoney(data.amountDue)} due`} />

        {/* Sharing from the bank app skips this whole form. */}
        <ShareReceiptGuide />

        {/* The blocking sentence, at the top rather than beside the button that
            produced it: the submit is pinned to the footer, so a refusal
            rendered next to it would sit below the fold on every phone. */}
        {blockReason ? (
          <Notice icon="close-circle" title={blockReason} tone="danger" />
        ) : null}

        <View className="gap-2">
          <Text variant="label">Receipt</Text>

          {attachFailure ? (
            /* The failed attach replaces the picker and carries the one control
               that answers it — a retry for a dropped connection, a fresh pick
               for a file we would refuse identically however many times it was
               sent. */
            <Notice
              action={{
                label: attachFailure.retry ? "Try again" : "Choose a different file",
                onPress: () => {
                  if (attachFailure.retry && lastPicked) {
                    void attach(lastPicked);
                    return;
                  }

                  setAttachFailure(null);
                  void (canPickDocument ? pickDocument() : pick("library"));
                },
              }}
              body={attachFailure.detail}
              icon="alert-circle"
              title={attachFailure.title}
              tone="danger"
            />
          ) : proofPreview || proofFile ? (
            <AttachedFile
              mimeType={proofMimeType}
              name={proofFile?.name ?? "Payment receipt"}
              onOpen={
                proofAssetId
                  ? () =>
                      openAssetViewer([
                        {
                          assetId: proofAssetId,
                          caption: "The receipt you uploaded",
                          mimeType: proofMimeType,
                          title: "Payment receipt",
                        },
                      ])
                  : undefined
              }
              onRemove={detach}
              size={proofFile?.size}
              uri={proofPreview}
            />
          ) : (
            <Dropzone
              canPickDocument={canPickDocument}
              onCamera={() => void pick("camera")}
              onDocument={() => void pickDocument()}
              onLibrary={() => void pick("library")}
            />
          )}

          {errors.proofAssetId ? (
            <Text className="text-destructive" variant="caption">
              {errors.proofAssetId}
            </Text>
          ) : null}

          {uploading ? (
            <UploadProgressBar progress={upload} />
          ) : (
            <EvidenceStatus
              /* Blocked beats read.

                 Without this the strip answers a different question from the
                 banner and wins, because it is the one beside the receipt: a
                 credit-side receipt reads perfectly, so `filledAnything` is true
                 and this said "We read your receipt and filled in what we found"
                 in green, directly under a red refusal. The resident believes
                 the half that looks like progress and fills in a form whose
                 submit is disabled. */
              blocked={Boolean(blockReason)}
              filledAnything={filledAnything}
              missing={anyMissing}
              notAReceipt={evidence.notAReceipt}
              stage={evidence.stage}
              statementGuidance={evidence.statementGuidance}
              unreadable={evidence.unreadable}
            />
          )}
        </View>

        {reading ? (
          /*
            The three fields, as the shapes they are about to become.

            Skeletons rather than a spinner over live inputs, and rather than
            live inputs on their own: the read is about to write into all three,
            and a resident who starts typing an amount into a field replaced
            under them a second later has been invited to do the work twice.
            `NOTES.md` §9 — loading is skeleton cards, not spinners.
          */
          <ReadingFields stage={evidence.stage} />
        ) : (
          <>
            <View className="gap-1.5">
              <Input
                error={errors.amount}
                inputMode="numeric"
                keyboardType="number-pad"
                label="Amount"
                onChangeText={(value) =>
                  setEdits((current) => ({ ...current, amount: value }))
                }
                placeholder="Enter amount"
                tone={toneFor("amount")}
                value={amount}
              />

              {/*
                The one attribution line left.

                The others — "Read from your receipt", "Read from your receipt:
                eSewa" — said in a sentence, three times, what the green border
                now says once. This one is not an attribution at all: it is a
                *conflict*, between the figure on the receipt and the balance on
                the invoice, and it is the difference between a resident
                submitting a partial payment knowingly and doing it by accident.
              */}
              {filled.amount &&
              parseClaimAmount(amount) !== data.amountDue &&
              data.amountDue > 0 ? (
                <ReadOffReceipt
                  text={`Invoice balance is ${formatMoney(data.amountDue)}`}
                />
              ) : null}
            </View>

            <Select
              error={errors.method}
              label="Method"
              onChange={(value) =>
                setEdits((current) => ({ ...current, method: value }))
              }
              options={methodOptions}
              placeholder="Select method"
              sheetTitle="How did you pay?"
              tone={toneFor("method")}
              value={selection}
            />

            <View className="gap-1.5">
              <Input
                /* A transaction id is copied, not composed, so autocorrect and
                   autocapitalisation are only ever wrong about it. */
                autoCapitalize="characters"
                autoCorrect={false}
                error={errors.transactionCode}
                label={
                  isCash
                    ? "Who did you give the cash to?"
                    : transactionCodeRequired(method)
                      ? "Transaction ID"
                      : "Transaction ID (optional)"
                }
                onChangeText={(value) =>
                  setEdits((current) => ({ ...current, transactionCode: value }))
                }
                placeholder={isCash ? "Enter their name" : "Enter transaction ID"}
                tone={toneFor("transactionCode")}
                value={transactionCode}
              />

              {/* Cash has no id to hunt for, so the helper would point at a
                  screen that does not exist. A sheet rather than an inline
                  expander: `NOTES.md` §6 is explicit that what a row opens is a
                  sheet, and three steps pushed into the middle of a form move
                  both fields around it. */}
              {isCash ? null : (
                <Pressable
                  accessibilityRole="button"
                  className="flex-row items-center gap-1.5 self-start active:opacity-70"
                  hitSlop={8}
                  onPress={() => setWhereOpen(true)}
                >
                  <Ionicons color={colors.primary} name="help-circle-outline" size={14} />
                  <Text className="text-primary" variant="caption">
                    Show me where to find this
                  </Text>
                </Pressable>
              )}
            </View>
          </>
        )}

        {/*
          The reference code, in whichever state this upload has reached.

          Once the receipt has been read we *know* whether the code is on it, so
          asking the resident to confirm they used it would be asking a question
          we have already answered, and answered better. Nothing at all while the
          file is one of ours: the code genuinely is on it — we printed it there —
          so every state of this block would be encouragement to submit the one
          file that cannot be accepted.
        */}
        {evidence.systemDocument ? null : evidence.reference ? (
          <ReferenceState
            code={evidence.reference.code}
            state={evidence.reference.found ? "confirmed" : "missed"}
          />
        ) : data.referenceCode ? (
          <ReferenceState code={data.referenceCode} state="reminder" />
        ) : null}

        <Input
          label="Note (optional)"
          maxLength={200}
          multiline
          onChangeText={setNote}
          placeholder="Eg. Paid from my brother's eSewa."
          value={note}
        />

      </View>

      <Sheet
        onClose={() => setWhereOpen(false)}
        open={whereOpen}
        title="Where to find the transaction ID"
      >
        <View className="gap-3 pb-2">
          {whereToLook(method).map((step, index) => (
            <View className="flex-row items-start gap-3" key={step}>
              <View className="h-6 w-6 items-center justify-center rounded-full bg-brand-soft">
                <Text className="text-primary" variant="caption">
                  {index + 1}
                </Text>
              </View>
              <Text className="flex-1" variant="body">
                {step}
              </Text>
            </View>
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}

/**
 * The claim landed.
 *
 * A whole screen rather than a toast over a form, because the form has no
 * further use — and because this is the moment a resident wants reassurance
 * about a rent payment they have just staked a claim on. One sentence says
 * what happens next: the gap between submitting proof and a hostel confirming
 * it is measured in hours, and an unexplained gap is where people start
 * submitting it again.
 */
function SubmittedScreen({
  duplicate,
  header,
  onDone,
}: {
  duplicate: boolean;
  header: ReactNode;
  onDone: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Screen
      footer={<Button label="Go to invoice" onPress={onDone} />}
      header={header}
      scroll
    >
      <View className="gap-6 pt-6">
        <View className="items-center gap-3">
          <View className="h-24 w-24 items-center justify-center rounded-full bg-success-soft">
            <Ionicons color={colors.success} name="checkmark-circle" size={56} />
          </View>

          <Text className="text-center" variant="title">
            {duplicate ? "Already sent" : "Sent to your hostel"}
          </Text>
          <Text className="text-center" variant="body">
            You&apos;ll get a notification when it&apos;s confirmed.
          </Text>
        </View>
      </View>
    </Screen>
  );
}

/**
 * The submit never reached the server.
 *
 * Distinct from a refusal in the one way that matters: **the claim is still
 * good**. So the copy asks for the same thing again rather than for a different
 * file, and the second button is an exit rather than a cancel — the draft is
 * already on disk by the time this renders, so leaving costs nothing and coming
 * back costs nothing.
 */
function NotSentScreen({
  detail,
  header,
  onExit,
  onRetry,
}: {
  detail: string;
  header: ReactNode;
  onExit: () => void;
  onRetry: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Screen
      footer={
        <View className="gap-2.5">
          <Button label="Try again" onPress={onRetry} variant="danger" />
          <Button label="Save and exit" onPress={onExit} variant="outline" />
          <Text className="text-center" variant="caption">
            Your details are saved. You can come back later.
          </Text>
        </View>
      }
      header={header}
      scroll
    >
      <View className="items-center gap-3 pt-6">
        <View className="h-24 w-24 items-center justify-center rounded-full bg-destructive-soft">
          <Ionicons color={colors.destructive} name="alert-circle" size={56} />
        </View>

        <Text className="text-center" variant="title">
          Couldn&apos;t submit
        </Text>
        <Text className="text-center" variant="body">
          {detail}
        </Text>
      </View>
    </Screen>
  );
}

/**
 * The server refused the claim outright.
 *
 * The duplicate screenshot, the reused transaction id and the three unreadable
 * cases never reach the owner's queue, so this screen is the only place the
 * resident learns anything at all — which is why the reason gets its own titled
 * card rather than a line under a heading, and why there is a list of things to
 * do underneath it.
 *
 * `Back to invoice` is the only button because the invoice is where `I've paid`
 * lives: a retry is one tap away through the screen that owns it, and a second
 * `Try again` here would offer to resubmit against a proof this screen has
 * already dropped.
 */
function RefusedScreen({
  header,
  onBack,
  rejection,
}: {
  header: ReactNode;
  onBack: () => void;
  rejection: ClaimRejection;
}) {
  const { colors } = useAppTheme();

  return (
    <Screen
      footer={<Button label="Back to invoice" onPress={onBack} variant="outline" />}
      header={header}
      scroll
    >
      <View className="gap-5 pt-1">
        {/* A tinted block, not a tinted page. A whole screen painted
            `destructive` is a colour take this app does not make, and the tone
            carries just as far around the heading it belongs to. */}
        <View className="items-center gap-3 rounded-2xl bg-destructive-soft px-5 py-7">
          <View className="h-20 w-20 items-center justify-center rounded-full bg-background">
            <Ionicons color={colors.destructive} name="alert-circle" size={44} />
          </View>

          <Text className="text-center" variant="title">
            Claim not accepted
          </Text>
          {/* The server's own headline, which names *what* collided — a far
              better subtitle than a restatement of the line above it. */}
          <Text className="text-center" variant="caption">
            {rejection.title}
          </Text>
        </View>

        <View className="gap-1.5">
          <Text variant="label">Reason</Text>
          <Card>
            <Text variant="body">{rejection.detail}</Text>
          </Card>
        </View>

      </View>
    </Screen>
  );
}

/**
 * The bytes moving, as a bar and a number.
 *
 * A percentage *and* a track, which is one more than a progress indicator
 * usually needs — but this is the leg of the screen a resident on hostel Wi-Fi
 * watches for real seconds, and "46%" is what tells them it is moving at all
 * when the bar has not visibly grown since they last looked.
 *
 * Not `<Meter>`: that component picks its colour from the value, because
 * everywhere else in the app a low bar means money that has not come in. A
 * 12%-complete upload is not a warning, and a red one would read as a failure
 * that has not happened.
 */
function UploadProgressBar({ progress }: { progress: UploadProgress }) {
  const percent = progress.fraction === null ? null : Math.round(progress.fraction * 100);

  return (
    <View className="gap-2 pt-1">
      <View className="flex-row items-center justify-between">
        <Text variant="label">{UPLOAD_STAGE_LABELS[progress.stage]}</Text>
        {percent === null ? null : (
          <Text className="text-primary" variant="label">
            {percent}%
          </Text>
        )}
      </View>

      <View className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <View
          className="h-full rounded-full bg-primary"
          /*
           * A floor of 6%, and a sliver while the size is still unknown. A track
           * visibly empty for the first second of every upload reads as an
           * upload that has not started — which is the exact moment a resident
           * taps the picker again.
           */
          style={{ width: `${percent === null ? 6 : Math.max(6, percent)}%` }}
        />
      </View>

    </View>
  );
}

/**
 * What the uploader is doing, in the resident's words.
 *
 * `presigning` and `verifying` are our vocabulary, not theirs, and both are
 * short — but neither is instant on a bad connection, and a bar sitting at 0%
 * under the word "Uploading" for four seconds is less honest than one saying it
 * is still getting ready.
 */
const UPLOAD_STAGE_LABELS: Record<UploadProgress["stage"], string> = {
  presigning: "Getting ready…",
  uploading: "Uploading…",
  verifying: "Checking the file…",
};

/**
 * The three fields while the receipt is being read.
 *
 * The labels stay and the boxes go grey, so the form does not change height when
 * the values land — the reason to prefer a skeleton over a spinner in the first
 * place. The caption above the first one is the reader's *live* stage rather
 * than a fixed word, because the stages are genuinely different lengths and
 * "Matching it to this invoice…" sitting there for two seconds is information,
 * not decoration.
 */
function ReadingFields({ stage }: { stage: EvidenceStage }) {
  return (
    <>
      <View className="gap-1.5">
        <Text variant="caption">
          {stage === "idle" || stage === "done"
            ? "Reading your receipt…"
            : STAGE_LABELS[stage]}
        </Text>
        <Skeleton height={48} radius={12} />
      </View>

      <View className="gap-1.5">
        <Text className="text-muted-foreground" variant="label">
          Method
        </Text>
        <Skeleton height={48} radius={12} />
      </View>

      <View className="gap-1.5">
        <Text className="text-muted-foreground" variant="label">
          Transaction ID
        </Text>
        <Skeleton height={48} radius={12} />
        <Skeleton height={10} width="55%" />
      </View>
    </>
  );
}

/**
 * The attached file as a row: thumbnail, name, size, and a way to drop it.
 *
 * Tapping the row opens the full-screen viewer — but only once the upload has
 * finished, because until then there is no asset to open, and a dead tap on the
 * one thing that looks pressable is worse than no tap at all.
 *
 * The ✕ is a nested `Pressable`, which React Native does not bubble past: a tap
 * on it removes the file without also opening the viewer behind it.
 */
function AttachedFile({
  mimeType,
  name,
  onOpen,
  onRemove,
  size,
  uri,
}: {
  mimeType?: string;
  name: string;
  onOpen?: () => void;
  onRemove: () => void;
  size?: number;
  uri: string | null;
}) {
  const { colors } = useAppTheme();
  const isPdf = isPdfReceipt(mimeType);

  return (
    <Pressable
      accessibilityHint={onOpen ? "Opens it full screen" : undefined}
      accessibilityLabel={`Attached: ${name}`}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3 active:opacity-80"
      disabled={!onOpen}
      onPress={onOpen}
    >
      {isPdf || !uri ? (
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-muted">
          <Ionicons
            color={colors.mutedForeground}
            name={isPdf ? "document-text-outline" : "image-outline"}
            size={20}
          />
        </View>
      ) : (
        /* `cover` here, unlike the full-screen view: at 44 points this is an
           identity check — "yes, that is the eSewa screenshot" — and letterboxing
           a tall screenshot into a square leaves a thumbnail that is mostly
           background. */
        <Image
          contentFit="cover"
          source={{ uri }}
          style={{ backgroundColor: colors.muted, borderRadius: 12, height: 44, width: 44 }}
        />
      )}

      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1} variant="label">
          {name}
        </Text>
        {size ? <Text variant="caption">{formatMegabytes(size)}</Text> : null}
      </View>

      <Pressable
        accessibilityLabel="Remove this file"
        accessibilityRole="button"
        className="h-8 w-8 items-center justify-center rounded-full active:opacity-60"
        hitSlop={8}
        onPress={onRemove}
      >
        <Ionicons color={colors.mutedForeground} name="close" size={18} />
      </Pressable>
    </Pressable>
  );
}

/**
 * What is happening to the receipt, once it is on the server.
 *
 * The stages come from the server as it reaches them, so this is a report rather
 * than an animation — if the decode is slow, that is what stays on screen,
 * because that is what is actually slow.
 *
 * **It always says something once a read has finished.** An earlier shape
 * returned null on the quiet outcomes, so a read that succeeded and filled
 * nothing in — a receipt carrying only the reference code — left the resident
 * watching a spinner vanish into silence.
 *
 * The blocking verdicts are deliberately absent: they are drawn once, at the top
 * of the form, where the eye returns after a failed submit. Printing them here
 * as well would be two notices for one refusal.
 */
function EvidenceStatus({
  blocked,
  filledAnything,
  missing,
  notAReceipt,
  stage,
  statementGuidance,
  unreadable,
}: {
  blocked: boolean;
  filledAnything: boolean;
  missing: boolean;
  notAReceipt: boolean;
  stage: EvidenceStage;
  statementGuidance: string | null;
  unreadable: boolean;
}) {
  const { colors } = useAppTheme();

  if (stage === "idle") {
    return null;
  }

  /*
   * A blocked file has one thing to say and the banner is already saying it.
   *
   * Silent rather than repeating the sentence: the refusal is long — it names
   * the account or the direction that was read — and printing it twice on a
   * phone pushes the picker off the screen, which is the one control the
   * resident needs. Every other branch below describes a file they may still
   * submit, and none of those descriptions is true of this one.
   */
  if (blocked && stage === "done") {
    return null;
  }

  if (stage !== "done") {
    return (
      <View
        className={`flex-row items-start gap-2.5 rounded-2xl border p-4 ${NOTICE_TONES.brand.wrap}`}
      >
        <ActivityIndicator color={colors.primary} size="small" />
        <View className="flex-1 gap-0.5">
          <Text className="text-primary" variant="label">
            Reading your receipt…
          </Text>
        </View>
      </View>
    );
  }

  /*
   * A statement is a real payment record and their payment is probably on it, so
   * this never blocks. What it does is ask for the one file that settles in a
   * glance instead of the one a reviewer has to search.
   */
  if (statementGuidance) {
    return (
      <Notice
        body={statementGuidance}
        icon="alert-circle"
        title="That is a statement, not a receipt"
        tone="warning"
      />
    );
  }

  /*
   * The loudest thing that still lets them through, and the only one that is a
   * fact about their file rather than about our software: they can fix it now,
   * in ten seconds.
   */
  if (notAReceipt) {
    return (
      <Notice
        icon="alert-circle"
        title="This doesn't look like a payment receipt"
        tone="warning"
      />
    );
  }

  /*
   * Read, and short of something.
   *
   * Amber rather than green, and ahead of the success branch, because a receipt
   * that gave up the method but not the transaction id is the commonest outcome
   * of all — and a green "we filled the form in" sitting over a disabled submit
   * button is the single most confusing thing this screen ever said.
   */
  if (filledAnything && missing) {
    return (
      <Notice
        icon="alert-circle"
        title="Fill in the highlighted fields"
        tone="warning"
      />
    );
  }

  if (filledAnything) {
    return (
      <Notice
        icon="checkmark-circle"
        title="Filled from your receipt"
        tone="success"
      />
    );
  }

  /*
   * Nothing came off the file.
   *
   * Two sentences apart because they are two different events: `unreadable` is a
   * read that failed and leaves the resident both fields to type, and the other
   * is a read that worked on a receipt carrying nothing we recognised — which is
   * not an error, and must not be dressed as one.
   */
  return unreadable ? (
    <Notice
      icon="close-circle"
      title="Couldn't read it — fill in the details"
      tone="danger"
    />
  ) : (
    <Notice
      icon="scan-outline"
      title="Uploaded. Fill in the amount and ID."
    />
  );
}

/**
 * The reference code, in one of its three states.
 *
 * Informational in all of them, never a gate. A resident who forgot the code has
 * still paid, and blocking the claim would leave real money with no way to be
 * reported — it costs the owner a manual match, which is exactly what the
 * owner's review queue is for.
 */
function ReferenceState({
  code,
  state,
}: {
  code: string;
  state: "confirmed" | "missed" | "reminder";
}) {
  const copy = {
    confirmed: {
      body: undefined,
      icon: "checkmark-circle" as const,
      title: `Reference ${code} found`,
      tone: "success" as const,
    },
    missed: {
      body: "Your hostel will match it by hand.",
      icon: "alert-circle" as const,
      title: `${code} isn't on this receipt`,
      tone: "warning" as const,
    },
    reminder: {
      body: "Add it to the remarks when you pay.",
      icon: "pricetag-outline" as const,
      title: `Reference ${code}`,
      tone: "plain" as const,
    },
  }[state];

  return (
    <Notice body={copy.body} icon={copy.icon} title={copy.title} tone={copy.tone} />
  );
}

/**
 * The tinted surfaces this screen draws, as one table.
 *
 * Deliberately a plain `<View>` rather than a `<Card>` with the tone appended.
 * `Card` already sets `border-border`, and two border-colour utilities of equal
 * specificity are settled by the order Tailwind generated them in rather than by
 * where they sat in the string — the trap the component's own doc names. One
 * border rule per surface means there is nothing to settle.
 *
 * `/30` and `/40` rather than the solid tone: a fully saturated border around a
 * soft fill reads as a control that can be pressed, and none of these can.
 */
const NOTICE_TONES = {
  brand: { icon: "primary", wrap: "border-primary/30 bg-brand-soft" },
  danger: { icon: "destructive", wrap: "border-destructive/40 bg-destructive-soft" },
  plain: { icon: "mutedForeground", wrap: "border-border bg-card" },
  success: { icon: "success", wrap: "border-success/30 bg-success-soft" },
  warning: { icon: "warning", wrap: "border-warning/40 bg-warning-soft" },
} as const;

/**
 * A glyph, a sentence, a caption under it — and, where the notice is the thing
 * blocking progress, the control that unblocks it.
 *
 * Seven of these on one screen is why it is a component: the alternative is
 * seven hand-built rows that drift apart on icon size, gap and which of the two
 * lines carries the emphasis. Every tone is one of the semantic ones; none is a
 * hex.
 *
 * The action is drawn as a plain `Pressable` rather than a `<Button>` because it
 * sits *on* a tinted surface and has to be the one rectangle that is not tinted.
 * Every button variant either paints a fill or declares `bg-transparent`, and
 * the one that would work — `outline` with `bg-card` appended — puts two
 * background utilities of equal specificity in one class list, which Tailwind
 * settles by generation order rather than by intent.
 */
function Notice({
  action,
  body,
  icon,
  title,
  tone = "plain",
}: {
  action?: { label: string; onPress: () => void };
  body?: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  tone?: keyof typeof NOTICE_TONES;
}) {
  const { colors } = useAppTheme();
  const palette = NOTICE_TONES[tone];

  return (
    <View className={`gap-3 rounded-2xl border p-4 ${palette.wrap}`}>
      <View className="flex-row items-start gap-2.5">
        <Ionicons color={colors[palette.icon]} name={icon} size={18} />
        <View className="flex-1 gap-0.5">
          <Text variant="label">{title}</Text>
          {body ? <Text variant="caption">{body}</Text> : null}
        </View>
      </View>

      {action ? (
        <Pressable
          accessibilityRole="button"
          className="h-11 items-center justify-center rounded-xl border border-border bg-card active:opacity-80"
          onPress={action.onPress}
        >
          <Text variant="label">{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The green attribution under a field the resident did not type. */
function ReadOffReceipt({ text }: { text: string }) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row items-center gap-1.5">
      <Ionicons color={colors.success} name="scan" size={13} />
      <Text className="flex-1 text-success" variant="caption">
        {text}
      </Text>
    </View>
  );
}

/**
 * The empty picker: a dashed slot with the promise in it, and the three sources
 * as tiles underneath.
 *
 * The tiles are the reference apps' own shape — `NOTES.md` §3, a menu of
 * destinations is a grid of tinted glyphs and never full-width rows of
 * sentences — and the reason they sit outside the dashed box is that the dashed
 * box is the *slot*, not the menu. What goes in the slot is one file; the tiles
 * are three ways to find it.
 *
 * `Choose file` opens the document browser where the build has one, because that
 * is the only picker accepting both a screenshot and a bank's PDF, and the PDF
 * is the better evidence of the two. Where the native module is missing it falls
 * back to the photo library and the `Files` tile is not drawn at all — an offer
 * that cannot work is worse than one that is never made.
 */
function Dropzone({
  canPickDocument,
  onCamera,
  onDocument,
  onLibrary,
}: {
  canPickDocument: boolean;
  onCamera: () => void;
  onDocument: () => void;
  onLibrary: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="gap-2.5">
      <View className="items-center gap-3 rounded-2xl border-2 border-dashed border-border bg-muted/20 px-5 py-7">
        <View className="h-12 w-12 items-center justify-center rounded-full bg-brand-soft">
          <Ionicons color={colors.primary} name="cloud-upload-outline" size={24} />
        </View>

        <View className="items-center gap-1">
          <Text variant="subtitle">Upload your receipt</Text>
          {/*
            Said *before* they upload, not after.

            A resident who does not know the file fills the form in types the
            amount and the ten-digit id first — and the read deliberately does
            not overwrite what they typed, so the feature they were never told
            about is the one that never runs. One sentence in front of the picker
            is what makes uploading first a reason rather than an order.
          */}
          <Text className="text-center" variant="caption">
            We fill in the rest.
          </Text>
        </View>

        <Button
          label="Choose file"
          onPress={canPickDocument ? onDocument : onLibrary}
          size="md"
        />
      </View>

      <View className="flex-row gap-2.5">
        <SourceTile icon="images-outline" label="Photos" onPress={onLibrary} />
        <SourceTile icon="camera-outline" label="Camera" onPress={onCamera} />
        {canPickDocument ? (
          <SourceTile icon="folder-open-outline" label="Files" onPress={onDocument} />
        ) : null}
      </View>
    </View>
  );
}

/** One source of a receipt, as a tile. */
function SourceTile({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className="flex-1 items-center gap-1.5 rounded-2xl border border-border bg-card py-3 active:opacity-70"
      onPress={onPress}
    >
      <Ionicons color={colors.primary} name={icon} size={20} />
      <Text variant="caption">{label}</Text>
    </Pressable>
  );
}

/** What `expo-document-picker` hands back. Only the fields the upload needs. */
type PickedDocument = { mimeType?: string; name: string; size?: number; uri: string };

type DocumentPickerModule = {
  getDocumentAsync: (options: {
    type?: string[];
  }) => Promise<{ assets: PickedDocument[] | null; canceled: boolean }>;
};

/**
 * `expo-document-picker`, loaded only when somebody actually picks a file.
 *
 * The same guard `manage/statements.tsx` uses, and for the same reason: it is a
 * native module, this project is bare, and a top-level import of one absent from
 * the *binary* throws at module load — which expo-router reports as "Route is
 * missing the required default export", killing a screen whose photo path needs
 * no native code at all.
 *
 * `require` rather than `await import()`: a dynamic import is a promise Metro
 * still resolves eagerly at bundle time.
 */
function loadDocumentPicker(): DocumentPickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-document-picker") as DocumentPickerModule;
  } catch {
    return null;
  }
}
