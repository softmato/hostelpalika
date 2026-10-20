"use client";

import {
  Banknote,
  Check,
  Eye,
  HandCoins,
  QrCode,
  ShieldCheck,
  Pencil,
  Smartphone,
  Wallet,
  X,
} from "@/components/icons";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  BankMark,
  EsewaMark,
  KhaltiMark,
  NotesMark,
  QrMark,
} from "@/app/_components/payment-brand-marks";
import {
  type ExtraAccount,
  PaymentProfileResidentPreview,
  type ProfileDraft,
} from "@/app/_components/payment-profile-resident-preview";
import { EmptyState, Input, LoadingRows, Panel, TextArea } from "@/app/_components/shared-ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WalletMark } from "@/components/wallet-mark";
import { Chip, ShareBar } from "./hostel-admin-page-ui";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { uploadFile } from "@/lib/uploads/uploader";
import { PageHeader } from "./core-portal-shared";
import { Message } from "./portal-shared";

/**
 * How this hostel takes money (target §11.8, plan item 3.1).
 *
 * Until this screen existed the product asked residents for proof of a payment
 * it gave them no instructions for, and every hostel communicated its account
 * details out of band (current §7.11).
 *
 * **The form is a picker, not a wall.** Showing seven inputs at once asks an
 * owner to read every field before deciding which ones apply to them, and the
 * honest answer for most hostels is two. So the methods are cards first — this
 * is what you *could* accept — and the fields for one open only when it is
 * chosen. The same reasoning as the gateways screen, which lists all three
 * providers whether or not any is configured.
 *
 * **Everything here is rendered live on the right, as the resident sees it.**
 * The details on this form are only ever consumed by one screen, and an owner
 * previously had to save and open a resident account to find out what they had
 * built. The preview reads the *unsaved* draft on purpose: a mistyped account
 * number should look wrong before it is stored, not after.
 */

type PaymentProfile = {
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  cashApprovalThreshold: number;
  displayName: string | null;
  enabledProviders: string[];
  esewaId: string | null;
  extraAccounts: ExtraAccount[];
  khaltiId: string | null;
  payeeVerifiable: boolean;
  paymentInstructions: string | null;
  qrPayeeName: string | null;
  qrPayeeNumber: string | null;
  qrPayeeSource: "MANUAL" | "OCR" | null;
  staticQrAssetId: string | null;
  tier: "TIER_0" | "TIER_1";
  usable: boolean;
};

type SectionId = "BANK" | "ESEWA" | "GENERAL" | "KHALTI" | "QR";

const EMPTY_DRAFT: ProfileDraft = {
  bankAccountName: "",
  bankAccountNumber: "",
  bankName: "",
  cashApprovalThreshold: "0",
  displayName: "",
  esewaId: "",
  khaltiId: "",
  paymentInstructions: "",
  qrPayeeName: "",
  qrPayeeNumber: "",
};

function draftFrom(profile: PaymentProfile): ProfileDraft {
  return {
    bankAccountName: profile.bankAccountName ?? "",
    bankAccountNumber: profile.bankAccountNumber ?? "",
    bankName: profile.bankName ?? "",
    cashApprovalThreshold: String(profile.cashApprovalThreshold ?? 0),
    displayName: profile.displayName ?? "",
    esewaId: profile.esewaId ?? "",
    khaltiId: profile.khaltiId ?? "",
    paymentInstructions: profile.paymentInstructions ?? "",
    qrPayeeName: profile.qrPayeeName ?? "",
    qrPayeeNumber: profile.qrPayeeNumber ?? "",
  };
}

/**
 * Which fields each card owns.
 *
 * A section saves only its own keys, so an owner editing their bank account
 * cannot blank an eSewa id they never opened — the PATCH schema treats an empty
 * string as "clear this", which makes a whole-form submit destructive for every
 * field the owner did not look at.
 */
const SECTION_FIELDS: Record<SectionId, (keyof ProfileDraft)[]> = {
  BANK: ["bankName", "bankAccountName", "bankAccountNumber"],
  ESEWA: ["esewaId"],
  GENERAL: ["displayName", "paymentInstructions", "cashApprovalThreshold"],
  KHALTI: ["khaltiId"],
  QR: ["qrPayeeName", "qrPayeeNumber"],
};

const EXTRA_KINDS: { label: string; value: ExtraAccount["kind"] }[] = [
  { label: "Bank", value: "BANK" },
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
];

/** The whole list is one PATCH — rows are added and removed locally, then saved. */
function ExtraAccountsForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: ExtraAccount[];
  onCancel: () => void;
  onSave: (accounts: ExtraAccount[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<ExtraAccount[]>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = (index: number, patch: Partial<ExtraAccount>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <form
      className="grid gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");

        try {
          await onSave(rows.filter((row) => row.number.trim()));
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Could not save the accounts.");
        } finally {
          setSaving(false);
        }
      }}
    >
      {rows.map((row, index) => (
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2" key={index}>
          <label className="grid gap-1 text-sm font-medium">
            Type
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => update(index, { kind: event.target.value as ExtraAccount["kind"] })}
              value={row.kind}
            >
              {EXTRA_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
          {row.kind === "BANK" ? (
            <Input
              label="Bank name"
              name={`extraBankName${index}`}
              onChange={(event) => update(index, { bankName: event.target.value })}
              value={row.bankName ?? ""}
            />
          ) : null}
          <Input
            label="Account name"
            name={`extraAccountName${index}`}
            onChange={(event) => update(index, { accountName: event.target.value })}
            value={row.accountName ?? ""}
          />
          <Input
            label={row.kind === "BANK" ? "Account number" : "Wallet ID"}
            name={`extraNumber${index}`}
            onChange={(event) => update(index, { number: event.target.value })}
            value={row.number}
          />
          <button
            className="justify-self-start text-sm font-semibold text-destructive"
            onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
            type="button"
          >
            Remove
          </button>
        </div>
      ))}
      {rows.length < 6 ? (
        <button
          className="justify-self-start rounded-md border border-border px-3 py-2 text-sm font-semibold transition hover:bg-muted"
          onClick={() =>
            setRows((current) => [
              ...current,
              { accountName: null, bankName: null, kind: "BANK", number: "" },
            ])
          }
          type="button"
        >
          Add an account
        </button>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <SaveRow onCancel={onCancel} saving={saving} />
    </form>
  );
}

function SaveRow({
  onCancel,
  saving,
}: {
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button
        className="rounded-md border border-border px-3.5 py-2 text-sm font-semibold transition hover:bg-muted"
        onClick={onCancel}
        type="button"
      >
        Cancel
      </button>
      <button
        className="rounded-md bg-role-admin px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
        disabled={saving}
        type="submit"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/**
 * A way to pay as a tile: its mark, whether it is set, and what is on file.
 * The form opens in a dialog with the resident preview beside it, so a
 * mistyped number still looks wrong before it is saved. Closing the dialog
 * any way but Save is a cancel.
 */
function MethodCard({
  children,
  configured,
  description,
  liveCheckout,
  mark,
  onClose,
  onToggle,
  open,
  preview,
  title,
}: {
  children: ReactNode;
  configured: boolean;
  description: string;
  /** Online checkout is live for this provider — the wallet id is not shown to residents. */
  liveCheckout?: boolean;
  mark: ReactNode;
  onClose: () => void;
  onToggle: () => void;
  open: boolean;
  preview: ReactNode;
  title: string;
}) {
  return (
    <>
      <button
        className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
        onClick={onToggle}
        type="button"
      >
        {mark}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-heading text-[14px] font-bold text-foreground">{title}</span>
            {configured ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-role-team-soft px-2 py-0.5 text-[11px] font-semibold text-role-team">
                <Check aria-hidden="true" className="size-3" />
                Set up
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                Not set
              </span>
            )}
            {liveCheckout ? (
              <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-semibold text-background">
                Checkout live
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
            {description}
          </span>
        </span>
        <Pencil aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <Dialog onOpenChange={(next) => (next ? null : onClose())} open={open}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              {mark}
              {title}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
            <div>{children}</div>
            <div className="hidden md:block">{preview}</div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Full-size preview. Portalled to the body so no ancestor's overflow clips it. */
function ResidentModePreview({
  draft,
  onClose,
  profile,
}: {
  draft: ProfileDraft;
  onClose: () => void;
  profile: PaymentProfile;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only ever opens from a click, so there is nothing to render on the server —
  // and createPortal needs a real document.
  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label="Resident view"
        aria-modal="true"
        className="w-full max-w-md"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2 shadow-lg">
          <p className="text-sm font-semibold">
            Resident view
            <span className="ml-2 font-normal text-muted-foreground">
              example invoice
            </span>
          </p>
          <button
            aria-label="Close resident view"
            className="rounded-md border border-border p-1.5 transition hover:bg-muted"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
        {/* The phone frame is not decoration: nearly every resident opens this on
            a phone, and a preview at desktop width hides the wrapping that
            actually decides whether a long bank name is readable. */}
        <div className="rounded-[22px] border-4 border-foreground/80 bg-surface p-2 shadow-2xl">
          <PaymentProfileResidentPreview
            draft={draft}
            enabledProviders={profile.enabledProviders}
            extraAccounts={profile.extraAccounts ?? []}
            staticQrAssetId={profile.staticQrAssetId}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const HostelAdminPaymentProfilePageContent = memo(
  function HostelAdminPaymentProfilePageContent() {
    const [message, setMessage] = useState("");
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [open, setOpen] = useState<SectionId | null>(null);
    const [extraOpen, setExtraOpen] = useState(false);
    const [residentMode, setResidentMode] = useState(false);
    const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
    const qrInputRef = useRef<HTMLInputElement>(null);
    const loadedRef = useRef<string | null>(null);

    const resource = usePortalResource<{ profile: PaymentProfile }>(
      hostelAdminEndpoints.paymentProfile,
      { errorMessage: "Could not load the payment profile." },
    );
    const profile = resource.data?.profile ?? null;

    // The server is the truth after every save, so the draft is re-seeded from
    // it — the signature guard is what stops that from wiping the field the
    // owner is typing into on an unrelated re-render.
    useEffect(() => {
      if (!profile) return;

      const signature = JSON.stringify(profile);

      if (loadedRef.current === signature) return;

      loadedRef.current = signature;
      setDraft(draftFrom(profile));
    }, [profile]);

    const set = useCallback(
      (key: keyof ProfileDraft) => (value: string) =>
        setDraft((current) => ({ ...current, [key]: value })),
      [],
    );

    const patch = useCallback(
      async (body: Record<string, unknown>, note: string) => {
        await browserApi(hostelAdminEndpoints.paymentProfile, {
          body: JSON.stringify(body),
          method: "PATCH",
        });
        setMessage(note);
        await resource.refreshAsync();
      },
      [resource],
    );

    const saveSection = useCallback(
      async (section: SectionId) => {
        const body: Record<string, unknown> = {};

        for (const key of SECTION_FIELDS[section]) {
          body[key] =
            key === "cashApprovalThreshold"
              ? Number(draft.cashApprovalThreshold || 0)
              : draft[key];
        }

        setSaving(true);
        setMessage("");

        try {
          await patch(body, "Saved. Residents see this on their pay screen.");
          setOpen(null);
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save payment details.",
          );
        } finally {
          setSaving(false);
        }
      },
      [draft, patch],
    );

    // Cancel discards the draft for every field, not just the open section's —
    // the preview has been showing unsaved values, so a partial revert would
    // leave it displaying something the owner just backed out of.
    const cancel = useCallback(() => {
      if (profile) setDraft(draftFrom(profile));
      setOpen(null);
    }, [profile]);

    const uploadQr = useCallback(
      async (file: File | undefined) => {
        if (!file) return;

        setUploading(true);
        setMessage("");

        try {
          // `PAYMENT_QR` is a financial kind, so presign scopes the asset to this
          // hostel (item 0.1) — which is also what lets the service refuse a QR
          // borrowed from somewhere else.
          const result = await uploadFile(file, {
            assetKind: "PAYMENT_QR",
            kind: "image",
            label: "Payment QR",
            silent: true,
          });

          if (!result?.assetId) {
            setMessage("The QR image could not be uploaded.");
            return;
          }

          await patch({ staticQrAssetId: result.assetId }, "Payment QR updated.");
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save the QR image.",
          );
        } finally {
          setUploading(false);
          if (qrInputRef.current) qrInputRef.current.value = "";
        }
      },
      [patch],
    );

    const removeQr = useCallback(async () => {
      setUploading(true);

      try {
        await patch({ staticQrAssetId: null }, "Payment QR removed.");
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not remove the QR image.",
        );
      } finally {
        setUploading(false);
      }
    }, [patch]);

    const toggle = useCallback(
      (section: SectionId) =>
        setOpen((current) => (current === section ? null : section)),
      [],
    );

    const submitSection = useCallback(
      (section: SectionId) => (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void saveSection(section);
      },
      [saveSection],
    );

    const live = new Set((profile?.enabledProviders ?? []).map((p) => p.toUpperCase()));
    const preview = profile ? (
      <PaymentProfileResidentPreview
        draft={draft}
        enabledProviders={profile.enabledProviders}
        staticQrAssetId={profile.staticQrAssetId}
      />
    ) : null;
    const closeExtras = () => setExtraOpen(false);
    const waysSet = profile
      ? Math.min(
          4,
          [profile.staticQrAssetId, profile.bankAccountNumber, profile.esewaId, profile.khaltiId].filter(Boolean)
            .length + (profile.extraAccounts?.length ?? 0),
        )
      : 0;

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          action={
            profile ? (
              <button
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-input bg-input/30 px-3 text-[13px] font-medium transition hover:bg-input/50"
                onClick={() => setResidentMode(true)}
                type="button"
              >
                <Eye aria-hidden="true" className="size-4" />
                Resident view
              </button>
            ) : undefined
          }
          description="What residents see when they open an invoice."
          icon={Banknote}
          title="Payment Setup"
        />
        {open || extraOpen ? null : <Message value={message} />}

        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="The payment profile could not be loaded." />
        ) : null}

        {profile ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              {/* Methods below are collected by hand — each payment is confirmed
                  from the review queue. Online checkout settles without review.
                  Anything left unset is simply not shown to residents. */}
              <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ShieldCheck aria-hidden="true" className="mr-1 size-5 shrink-0 text-role-team" />
                  <Chip tone={profile.usable ? "brand" : "warn"}>
                    {profile.usable ? "Residents can pay" : "Not set up yet"}
                  </Chip>
                  <Chip tone={profile.payeeVerifiable ? "brand" : "warn"}>
                    {profile.payeeVerifiable ? "Receipts checked" : "Receipts not checked"}
                  </Chip>
                  {profile.enabledProviders.map((provider) => (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full bg-muted py-0.5 pl-0.5 pr-2.5 text-[12px] font-medium text-foreground"
                      key={provider}
                    >
                      <WalletMark name={provider} size={22} />
                      Checkout live
                    </span>
                  ))}
                </div>
                {/* The app counts the same four: QR, bank, eSewa, Khalti (extra accounts fill in). */}
                <ShareBar label="ways to pay set up" total={4} value={waysSet} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <MethodCard
                  configured={Boolean(profile.staticQrAssetId)}
                  description={
                    profile.staticQrAssetId
                      ? (profile.qrPayeeName ?? "QR uploaded")
                      : "Scan-to-pay image from your bank or wallet app"
                  }
                  mark={<QrMark className="size-12" />}
                  onClose={cancel}
                  onToggle={() => toggle("QR")}
                  open={open === "QR"}
                  preview={preview}
                  title="Payment QR"
                >
                  <div className="flex flex-wrap items-start gap-5">
                    {profile.staticQrAssetId ? (
                      // eslint-disable-next-line @next/next/no-img-element -- private asset served through our own authorizing route
                      <img
                        alt="Payment QR"
                        className="size-40 rounded-lg border border-border object-contain"
                        src={`/api/v1/files/${profile.staticQrAssetId}/url`}
                      />
                    ) : (
                      <div className="flex size-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground">
                        <QrCode aria-hidden="true" className="size-7" />
                        <span className="text-xs">No QR uploaded</span>
                      </div>
                    )}
                    {/* Residents scan it and then upload their payment screenshot,
                        so the name on the QR should match the account display name
                        or they will hesitate to pay. */}
                    <div className="min-w-[180px] flex-1 space-y-3">
                      <p className="text-[12.5px] text-muted-foreground">
                        The name on the QR should match your display name.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <input
                          accept="image/*"
                          className="hidden"
                          onChange={(event) => void uploadQr(event.target.files?.[0])}
                          ref={qrInputRef}
                          type="file"
                        />
                        <button
                          className="rounded-md bg-role-admin px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                          disabled={uploading}
                          onClick={() => qrInputRef.current?.click()}
                          type="button"
                        >
                          {uploading
                            ? "Working…"
                            : profile.staticQrAssetId
                              ? "Replace QR"
                              : "Upload QR"}
                        </button>
                        {profile.staticQrAssetId ? (
                          <button
                            className="rounded-md border border-border px-4 py-2 text-sm font-semibold transition hover:bg-muted disabled:opacity-60"
                            disabled={uploading}
                            onClick={() => void removeQr()}
                            type="button"
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/*
                    What the poster says it pays.

                    A QR is not an opaque image: the account name and number are
                    printed beside the code, and they are read off it at upload.
                    That read is what lets `evidence-payee` recognise this hostel
                    on the receipts residents send back — the only check in the
                    claim pipeline a payer cannot satisfy by typing. So it is
                    shown rather than hidden: an admin who can see a wrong name
                    here fixes it in ten seconds, and an admin who never sees it
                    finds out when a warden approves a payment made to somebody
                    else. When the read came back empty the same two fields are
                    the ask, which is the only time this hostel has to type
                    anything at all.
                  */}
                  {profile.staticQrAssetId ? (
                    <form
                      className="mt-5 space-y-3 border-t border-border pt-4"
                      onSubmit={submitSection("QR")}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-heading text-sm font-bold">
                          What this QR says
                        </p>
                        {profile.qrPayeeSource === "OCR" ? (
                          <span className="rounded-full bg-role-admin-soft px-2 py-0.5 text-[11px] font-semibold text-role-admin">
                            Read from your QR
                          </span>
                        ) : null}
                        {profile.qrPayeeSource === "MANUAL" ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                            Entered by you
                          </span>
                        ) : null}
                      </div>
                      <p className="text-[12.5px] text-muted-foreground">
                        {profile.qrPayeeSource
                          ? "Every receipt is checked against this. Correct it if it is wrong."
                          : "We could not read your QR. Type these once so receipts can be checked."}
                      </p>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Input
                          hint="Exactly as printed on the QR."
                          label="Account name on the QR"
                          name="qrPayeeName"
                          onChange={(event) => set("qrPayeeName")(event.target.value)}
                          value={draft.qrPayeeName}
                        />
                        <Input
                          hint="Bank account or wallet number on the QR."
                          label="Account number on the QR"
                          name="qrPayeeNumber"
                          onChange={(event) => set("qrPayeeNumber")(event.target.value)}
                          value={draft.qrPayeeNumber}
                        />
                      </div>
                      <SaveRow onCancel={cancel} saving={saving} />
                    </form>
                  ) : null}
                </MethodCard>

                <MethodCard
                  configured={Boolean(profile.esewaId)}
                  description={profile.esewaId || "Your eSewa mobile number or ID"}
                  liveCheckout={live.has("ESEWA")}
                  mark={<EsewaMark className="size-12" />}
                  onClose={cancel}
                  onToggle={() => toggle("ESEWA")}
                  open={open === "ESEWA"}
                  preview={preview}
                  title="eSewa"
                >
                  <form className="grid gap-4" onSubmit={submitSection("ESEWA")}>
                    <Input
                      hint="Residents copy this and transfer to it themselves."
                      label="eSewa ID"
                      name="esewaId"
                      onChange={(event) => set("esewaId")(event.target.value)}
                      placeholder="98XXXXXXXX"
                      value={draft.esewaId}
                    />
                    {/* Checkout live means residents get the "Pay with eSewa"
                        button instead; the ID stays saved for when it is off. */}
                    {live.has("ESEWA") ? (
                      <p className="rounded-xl bg-muted/60 px-3 py-2 text-[12.5px] text-muted-foreground">
                        Checkout is live, so residents get the Pay with eSewa button instead.
                      </p>
                    ) : null}
                    <SaveRow onCancel={cancel} saving={saving} />
                  </form>
                </MethodCard>

                <MethodCard
                  configured={Boolean(profile.khaltiId)}
                  description={profile.khaltiId || "Your Khalti mobile number or ID"}
                  liveCheckout={live.has("KHALTI")}
                  mark={<KhaltiMark className="size-12" />}
                  onClose={cancel}
                  onToggle={() => toggle("KHALTI")}
                  open={open === "KHALTI"}
                  preview={preview}
                  title="Khalti"
                >
                  <form className="grid gap-4" onSubmit={submitSection("KHALTI")}>
                    <Input
                      hint="Residents copy this and transfer to it themselves."
                      label="Khalti ID"
                      name="khaltiId"
                      onChange={(event) => set("khaltiId")(event.target.value)}
                      placeholder="98XXXXXXXX"
                      value={draft.khaltiId}
                    />
                    {live.has("KHALTI") ? (
                      <p className="rounded-xl bg-muted/60 px-3 py-2 text-[12.5px] text-muted-foreground">
                        Checkout is live, so residents get the Pay with Khalti button instead.
                      </p>
                    ) : null}
                    <SaveRow onCancel={cancel} saving={saving} />
                  </form>
                </MethodCard>

                <MethodCard
                  configured={Boolean(profile.bankAccountNumber)}
                  description={
                    profile.bankAccountNumber
                      ? [profile.bankName, profile.bankAccountNumber].filter(Boolean).join(" · ")
                      : "Account name, number and bank for direct transfers"
                  }
                  mark={<BankMark className="size-12" name={profile.bankName} />}
                  onClose={cancel}
                  onToggle={() => toggle("BANK")}
                  open={open === "BANK"}
                  preview={preview}
                  title="Bank transfer"
                >
                  <form className="grid gap-4" onSubmit={submitSection("BANK")}>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Input
                        label="Bank name"
                        name="bankName"
                        onChange={(event) => set("bankName")(event.target.value)}
                        value={draft.bankName}
                      />
                      <Input
                        label="Bank account name"
                        name="bankAccountName"
                        onChange={(event) => set("bankAccountName")(event.target.value)}
                        value={draft.bankAccountName}
                      />
                      <Input
                        hint="Shown to residents in full — check it against your passbook."
                        label="Bank account number"
                        name="bankAccountNumber"
                        onChange={(event) =>
                          set("bankAccountNumber")(event.target.value)
                        }
                        value={draft.bankAccountNumber}
                      />
                    </div>
                    <SaveRow onCancel={cancel} saving={saving} />
                  </form>
                </MethodCard>

                <MethodCard
                  configured={(profile.extraAccounts ?? []).length > 0}
                  description={
                    (profile.extraAccounts ?? []).length > 0
                      ? `${(profile.extraAccounts ?? []).length} more account(s)`
                      : "A second bank, eSewa or Khalti account"
                  }
                  mark={
                    <BankMark
                      className="size-12"
                      name={
                        profile.extraAccounts?.[0]
                          ? profile.extraAccounts[0].kind === "BANK"
                            ? profile.extraAccounts[0].bankName
                            : profile.extraAccounts[0].kind
                          : "BANK"
                      }
                    />
                  }
                  onClose={closeExtras}
                  onToggle={() => setExtraOpen((value) => !value)}
                  open={extraOpen}
                  preview={preview}
                  title="More accounts"
                >
                  <ExtraAccountsForm
                    initial={profile.extraAccounts ?? []}
                    onCancel={closeExtras}
                    onSave={async (extraAccounts) => {
                      await patch({ extraAccounts }, "Saved. Residents see every account.");
                      setExtraOpen(false);
                    }}
                  />
                </MethodCard>

                <MethodCard
                  configured={Boolean(profile.displayName)}
                  description={profile.displayName || "Display name, instructions, cash approval"}
                  mark={<NotesMark className="size-12" />}
                  onClose={cancel}
                  onToggle={() => toggle("GENERAL")}
                  open={open === "GENERAL"}
                  preview={preview}
                  title="Name & instructions"
                >
                  <form className="grid gap-4" onSubmit={submitSection("GENERAL")}>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Input
                        hint="Must match the name on the QR."
                        label="Account display name"
                        name="displayName"
                        onChange={(event) => set("displayName")(event.target.value)}
                        value={draft.displayName}
                      />
                      <Input
                        hint="Cash above this needs a second approver. 0 = all."
                        label="Second approval above (NPR)"
                        min="0"
                        name="cashApprovalThreshold"
                        onChange={(event) =>
                          set("cashApprovalThreshold")(event.target.value)
                        }
                        required
                        type="number"
                        value={draft.cashApprovalThreshold}
                      />
                    </div>
                    <TextArea
                      label="Instructions for residents — shown under the QR"
                      name="paymentInstructions"
                      onChange={(event) =>
                        set("paymentInstructions")(event.target.value)
                      }
                      placeholder="e.g. write your room number in the remarks"
                      value={draft.paymentInstructions}
                    />
                    <SaveRow onCancel={cancel} saving={saving} />
                  </form>
                </MethodCard>
              </div>
            </div>

            <div className="lg:sticky lg:top-4 lg:self-start">
              <Panel title="What your resident sees">
                {preview}
                {/* Amount and reference code are stand-ins — the real ones come
                    from each resident's bill. */}
                <p className="mt-3 flex items-start gap-1.5 text-[12px] text-muted-foreground">
                  <Smartphone aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  Example invoice, updating as you type.
                </p>
              </Panel>

              {/* Online checkout (settles without review) is its own screen, and
                  money going the other way — what we pay you for a booking — is
                  set under Bookings, beside the bookings it pays for. */}
              <div className="mt-3 flex flex-wrap gap-1.5 px-1">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12px] text-muted-foreground">
                  <Wallet aria-hidden="true" className="size-3.5" />
                  Online checkout: Payment Gateways
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[12px] text-muted-foreground">
                  <HandCoins aria-hidden="true" className="size-3.5" />
                  Booking payouts: Bookings → Settings
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {residentMode && profile ? (
          <ResidentModePreview
            draft={draft}
            onClose={() => setResidentMode(false)}
            profile={profile}
          />
        ) : null}
      </div>
    );
  },
);
