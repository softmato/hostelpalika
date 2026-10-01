"use client";

import {
  Banknote,
  Check,
  ChevronDown,
  Eye,
  HandCoins,
  QrCode,
  ShieldCheck,
  Smartphone,
  Wallet,
  X,
} from "lucide-react";
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
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { uploadFile } from "@/lib/uploads/uploader";
import { Message, PageHeader } from "./portal-shared";

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

function MethodCard({
  children,
  configured,
  description,
  liveCheckout,
  mark,
  onToggle,
  open,
  title,
}: {
  children: ReactNode;
  configured: boolean;
  description: string;
  /** Online checkout is live for this provider — the wallet id is not shown to residents. */
  liveCheckout?: boolean;
  mark: ReactNode;
  onToggle: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border transition ${
        open ? "border-role-admin/50 bg-surface shadow-sm" : "border-border bg-surface"
      }`}
    >
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-3.5 text-left transition hover:bg-muted/50"
        onClick={onToggle}
        type="button"
      >
        {mark}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-heading text-sm font-bold text-foreground">{title}</span>
            {configured ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                <Check aria-hidden="true" className="size-3" />
                Set up
              </span>
            ) : (
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                Not set
              </span>
            )}
            {liveCheckout ? (
              <span className="rounded-full border border-role-resident/30 bg-role-resident/10 px-2 py-0.5 text-[11px] font-semibold text-role-resident">
                Checkout live
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {description}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="border-t border-border p-3.5">{children}</div>
      ) : null}
    </div>
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

    return (
      <div className="mx-auto max-w-[1240px] space-y-6">
        <PageHeader
          description="The account details, QR and instructions residents see when they open an invoice."
          icon={Banknote}
          title="Payment Setup"
        />
        <Message value={message} />

        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="The payment profile could not be loaded." />
        ) : null}

        {profile ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div
                className={`rounded-lg border p-4 text-sm ${
                  profile.usable
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                }`}
              >
                <p className="flex items-center gap-2 font-semibold">
                  <ShieldCheck aria-hidden="true" className="size-4" />
                  {profile.usable
                    ? "Residents can see how to pay you."
                    : "Residents cannot see how to pay you yet."}
                </p>
                <p className="mt-1 leading-5">
                  {profile.usable
                    ? `Payments below are collected manually — you confirm each one from the review queue. ${
                        profile.enabledProviders.length > 0
                          ? `Online checkout is live for ${profile.enabledProviders.join(", ").toLowerCase()}, and settles without your review.`
                          : ""
                      }`
                    : "Pick a method below and fill it in. Until then their pay screen says your hostel has not set this up."}
                </p>
              </div>

              <p className="text-sm text-muted-foreground">
                Choose the ways you accept rent. Anything you leave unset is simply
                not shown to residents.
              </p>

              <div className="space-y-3">
                <MethodCard
                  configured={Boolean(profile.staticQrAssetId)}
                  description="Scan-to-pay image exported from your bank or wallet app"
                  mark={<QrMark className="size-10" />}
                  onToggle={() => toggle("QR")}
                  open={open === "QR"}
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
                    <div className="min-w-[220px] flex-1 space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Residents scan it and then upload their payment screenshot,
                        so the name on the QR should match the account display name
                        or they will hesitate to pay.
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
                      <p className="text-sm text-muted-foreground">
                        {profile.qrPayeeSource
                          ? "We match this against every payment receipt your residents upload, so we can tell you whether the money actually reached you. Correct it if it is wrong."
                          : "We could not read the name and number printed on your QR. Type them in once and we can check that each payment receipt was really paid to you."}
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
                  description="Your eSewa mobile number or ID"
                  liveCheckout={live.has("ESEWA")}
                  mark={<EsewaMark className="size-10" />}
                  onToggle={() => toggle("ESEWA")}
                  open={open === "ESEWA"}
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
                    {live.has("ESEWA") ? (
                      <p className="rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
                        Online eSewa checkout is live, so residents get the
                        &ldquo;Pay with eSewa&rdquo; button instead of this ID. It stays
                        saved and reappears if you turn checkout off.
                      </p>
                    ) : null}
                    <SaveRow onCancel={cancel} saving={saving} />
                  </form>
                </MethodCard>

                <MethodCard
                  configured={Boolean(profile.khaltiId)}
                  description="Your Khalti mobile number or ID"
                  liveCheckout={live.has("KHALTI")}
                  mark={<KhaltiMark className="size-10" />}
                  onToggle={() => toggle("KHALTI")}
                  open={open === "KHALTI"}
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
                      <p className="rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
                        Online Khalti checkout is live, so residents get the
                        &ldquo;Pay with Khalti&rdquo; button instead of this ID. It stays
                        saved and reappears if you turn checkout off.
                      </p>
                    ) : null}
                    <SaveRow onCancel={cancel} saving={saving} />
                  </form>
                </MethodCard>

                <MethodCard
                  configured={Boolean(profile.bankAccountNumber)}
                  description="Account name, number and bank for direct transfers"
                  mark={<BankMark className="size-10" />}
                  onToggle={() => toggle("BANK")}
                  open={open === "BANK"}
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
                  description="A second bank, eSewa or Khalti account"
                  mark={<BankMark className="size-10" />}
                  onToggle={() => setExtraOpen((value) => !value)}
                  open={extraOpen}
                  title="More accounts"
                >
                  <ExtraAccountsForm
                    initial={profile.extraAccounts ?? []}
                    onCancel={() => setExtraOpen(false)}
                    onSave={async (extraAccounts) => {
                      await patch({ extraAccounts }, "Saved. Residents see every account.");
                      setExtraOpen(false);
                    }}
                  />
                </MethodCard>

                <MethodCard
                  configured={Boolean(profile.displayName)}
                  description="Account display name, resident instructions, cash approval"
                  mark={<NotesMark className="size-10" />}
                  onToggle={() => toggle("GENERAL")}
                  open={open === "GENERAL"}
                  title="Name & instructions"
                >
                  <form className="grid gap-4" onSubmit={submitSection("GENERAL")}>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Input
                        hint="Must match the registered name on the QR, or residents abandon the payment."
                        label="Account display name"
                        name="displayName"
                        onChange={(event) => set("displayName")(event.target.value)}
                        value={draft.displayName}
                      />
                      <Input
                        hint="Cash above this needs a second person to approve it. 0 means every cash entry does."
                        label="Cash second-approval threshold (NPR)"
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
              <Panel
                action={
                  <button
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold transition hover:bg-muted"
                    onClick={() => setResidentMode(true)}
                    type="button"
                  >
                    <Eye aria-hidden="true" className="size-3.5" />
                    Resident mode
                  </button>
                }
                title="What your resident sees"
              >
                <PaymentProfileResidentPreview
                  draft={draft}
                  enabledProviders={profile.enabledProviders}
                  staticQrAssetId={profile.staticQrAssetId}
                />
                <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Smartphone aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  Example invoice, updating as you type. Amount and reference code
                  are stand-ins — the real ones come from each resident&rsquo;s bill.
                </p>
              </Panel>

              <p className="mt-3 flex items-start gap-1.5 px-1 text-xs text-muted-foreground">
                <Wallet aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                Online checkout, where the payment settles without your review, is
                set up separately under Payment Gateways.
              </p>

              {/* Money going the other way — what we pay you for a booking — is
                  set under Bookings, beside the bookings it pays for. */}
              <p className="mt-2 flex items-start gap-1.5 px-1 text-xs text-muted-foreground">
                <HandCoins aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                The account we send your share of booking fees to is under
                Bookings → Settings.
              </p>
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
