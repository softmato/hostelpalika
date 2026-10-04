"use client";

import {
  Check,
  ChevronRight,
  FileText,
  IdCard,
  ImageIcon,
  Landmark,
  ListChecks,
  MapPin,
  PartyPopper,
  QrCode,
  Sparkles,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import { StepFlow } from "@/app/_components/registration-step-shell";
import { facilityOptions } from "@/app/_components/registration-fields";
import {
  EMPTY_PAYOUT_DRAFT,
  PayoutAccountFields,
  payoutAccountPayload,
} from "@/components/bookings/payout-account-fields";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { uploadRegistrationDocument } from "@/lib/uploads/registration-document";
import { uploadFiles } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/v1/hostel-admin/kyc";

type Kyc = {
  documents: { status: string; type: string }[];
  facilities: string[];
  minPhotos: number;
  percent: number;
  photoCount: number;
  rules: string[];
  steps: { done: boolean; key: string }[];
};

/** One screen per step. `href` is the full editor, for changing a finished step. */
const STEPS: Record<string, { hint: string; href: string; icon: LucideIcon; title: string }> = {
  documents: { hint: "Owner ID and PAN / VAT", href: "/hostel-admin/kyc", icon: FileText, title: "Documents" },
  facilities: { hint: "Tap what you offer", href: "/hostel-admin/profile", icon: Sparkles, title: "Facilities" },
  food: { hint: "Your weekly menu", href: "/hostel-admin/food", icon: UtensilsCrossed, title: "Weekly food" },
  location: { hint: "Drop the pin on your door", href: "/hostel-admin/profile", icon: MapPin, title: "Map pin" },
  payments: { hint: "Where residents pay rent", href: "/hostel-admin/payment-setup", icon: QrCode, title: "Rent payments" },
  payout: { hint: "Where booking money lands", href: "/hostel-admin/bookings", icon: Landmark, title: "Booking payout" },
  photos: { hint: "Outside and inside", href: "/hostel-admin/rooms", icon: ImageIcon, title: "Photos" },
  rules: { hint: "One rule per line", href: "/hostel-admin/profile", icon: ListChecks, title: "House rules" },
};

const DOCUMENTS = [
  { label: "Owner ID", match: (type: string) => !/pan|vat/i.test(type), type: "Owner ID proof" },
  { label: "PAN / VAT", match: (type: string) => /pan|vat/i.test(type), type: "PAN / VAT document" },
] as const;

const PRIMARY = "inline-flex h-11 w-full items-center justify-center rounded-xl bg-brand-teal px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50";
const GHOST = "inline-flex h-11 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold text-muted-foreground transition hover:bg-muted";
const OUTLINE = "inline-flex h-11 w-full items-center justify-center rounded-xl border border-border px-5 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-50";

function errorText(caught: unknown) {
  return caught instanceof Error ? caught.message : "That did not save.";
}

function Ring({ percent, size = 112 }: { percent: number; size?: number }) {
  const stroke = size / 10;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;

  return (
    <div className="relative shrink-0" style={{ height: size, width: size }}>
      <svg className="-rotate-90" height={size} width={size}>
        <circle className="stroke-muted" cx={size / 2} cy={size / 2} fill="none" r={radius} strokeWidth={stroke} />
        <circle
          className="stroke-brand-teal transition-[stroke-dashoffset] duration-700 ease-out"
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          strokeDasharray={length}
          strokeDashoffset={length * (1 - percent / 100)}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-bold text-foreground" style={{ fontSize: size / 4.5 }}>
        {percent}%
      </span>
    </div>
  );
}

/** Dashboard nudge. Renders nothing once KYC is complete, or for a warden. */
export function HostelKycBanner() {
  const workspaceHref = useWorkspaceHref();
  const resource = usePortalResource<{ kyc: Kyc }>(ENDPOINT);
  const kyc = resource.data?.kyc;

  if (!kyc || kyc.percent >= 100) {
    return null;
  }

  return (
    <Link
      className="group flex items-center gap-4 rounded-2xl border border-brand-teal/30 bg-brand-teal/5 p-4 transition hover:bg-brand-teal/10"
      href={workspaceHref("/hostel-admin/kyc")}
    >
      <Ring percent={kyc.percent} size={56} />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-foreground">Complete hostel KYC</p>
        <p className="text-sm text-muted-foreground">Unlock every feature</p>
      </div>
      <ChevronRight className="size-5 text-brand-teal transition group-hover:translate-x-0.5" />
    </Link>
  );
}

/**
 * Hostel KYC — a guided walk through what a team-registered hostel still has
 * to finish. One step per screen, saved in place where a small form covers it;
 * the heavy editors (menu, map, photos by room) open and come back here.
 */
export const HostelAdminKycPageContent = memo(function HostelAdminKycPageContent() {
  const router = useRouter();
  const workspaceHref = useWorkspaceHref();
  const resource = usePortalResource<{ kyc: Kyc }>(ENDPOINT, {
    errorMessage: "Could not load hostel KYC.",
  });
  const kyc = resource.data?.kyc;
  const [index, setIndex] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const { refresh } = resource;

  // Back from an editor: re-read, so the tick lands.
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);

    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  if (!kyc) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="h-24 animate-pulse rounded-3xl bg-muted" />
        <div className="h-80 animate-pulse rounded-3xl bg-muted" />
        {resource.message ? <p className="text-sm text-destructive">{resource.message}</p> : null}
      </div>
    );
  }

  const steps = kyc.steps;
  const firstOpen = steps.findIndex((step) => !step.done);
  const current = index ?? Math.max(0, firstOpen);
  const showFinish = finished || (index === null && firstOpen === -1);
  const step = steps[current];
  const meta = STEPS[step.key];
  const advance = () => (current >= steps.length - 1 ? setFinished(true) : setIndex(current + 1));
  const saved = async () => {
    await resource.refreshAsync();
    advance();
  };
  const open = (href: string) => router.push(workspaceHref(href));

  const setupLinks = <div className="mb-4 flex flex-wrap gap-3 rounded-xl border border-border p-3 text-sm font-semibold text-brand-teal"><Link href={workspaceHref("/hostel-admin/rooms")}>Room types & attached bathrooms</Link><Link href={workspaceHref("/hostel-admin/fee-schedule")}>Rent & form fees</Link></div>;

  if (showFinish) {
    return (
      <div className="mx-auto max-w-xl">
        {setupLinks}
        <StepFlow className="flex flex-col items-center gap-4 rounded-3xl border border-border bg-card p-8 text-center" stepKey={99}>
          {kyc.percent >= 100 ? (
            <span className="flex size-28 animate-in zoom-in-50 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal duration-500">
              <PartyPopper className="size-12" />
            </span>
          ) : (
            <Ring percent={kyc.percent} size={140} />
          )}
          <h1 className="text-2xl font-bold text-foreground">
            {kyc.percent >= 100 ? "KYC complete" : `${kyc.percent}% done`}
          </h1>
          <p className="text-muted-foreground">
            {kyc.percent >= 100 ? "Every feature is unlocked" : "Finish the rest anytime"}
          </p>
          <div className="grid w-full gap-2 pt-2">
            <button
              className={kyc.percent < 100 ? PRIMARY : OUTLINE}
              onClick={() => {
                setFinished(false);
                setIndex(Math.max(0, firstOpen));
              }}
              type="button"
            >
              {kyc.percent < 100 ? "Continue" : "Review steps"}
            </button>
            <button className={kyc.percent < 100 ? GHOST : PRIMARY} onClick={() => open("/hostel-admin/dashboard")} type="button">
              Back to dashboard
            </button>
          </div>
        </StepFlow>
      </div>
    );
  }

  const Icon = step.done ? Check : meta.icon;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {setupLinks}
      <section className="flex items-center gap-4 rounded-b-3xl rounded-t-xl bg-brand-teal p-5 text-white">
        <div className="rounded-full bg-white p-1">
          <Ring percent={kyc.percent} size={60} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-bold">
            Hostel KYC · Step {current + 1} of {steps.length}
          </p>
          <div className="flex gap-1.5">
            {steps.map((item, at) => (
              <button
                aria-label={`${STEPS[item.key]?.title ?? item.key}${item.done ? ", done" : ""}`}
                className={cn(
                  "h-2 flex-1 rounded-full transition-colors duration-500",
                  item.done ? "bg-white" : at === current ? "bg-white/60" : "bg-white/25",
                )}
                key={item.key}
                onClick={() => setIndex(at)}
                type="button"
              />
            ))}
          </div>
        </div>
      </section>

      <StepFlow className="space-y-5 rounded-3xl border border-border bg-card p-6" stepKey={current}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-16 items-center justify-center rounded-3xl bg-brand-teal/10 text-brand-teal">
            <Icon className="size-8" strokeWidth={step.done ? 3 : 2} />
          </span>
          <h1 className="text-xl font-bold text-foreground">{meta.title}</h1>
          <p className="text-sm text-muted-foreground">{step.done ? "Done" : meta.hint}</p>
        </div>

        {step.key === "photos" ? (
          <PhotosStep kyc={kyc} onChange={() => void resource.refreshAsync()} />
        ) : step.key === "documents" ? (
          <DocumentsStep kyc={kyc} onChange={() => void resource.refreshAsync()} />
        ) : step.done ? (
          <button className={OUTLINE} onClick={() => open(meta.href)} type="button">
            Change
          </button>
        ) : step.key === "payout" ? (
          <PayoutStep onSaved={saved} />
        ) : step.key === "payments" ? (
          <PaymentsStep onBank={() => open(meta.href)} onSaved={saved} />
        ) : step.key === "rules" ? (
          <RulesStep initial={kyc.rules} onSaved={saved} />
        ) : step.key === "facilities" ? (
          <FacilitiesStep initial={kyc.facilities} onSaved={saved} />
        ) : (
          <button className={PRIMARY} onClick={() => open(meta.href)} type="button">
            {step.key === "food" ? "Set weekly menu" : step.key === "location" ? "Place the pin" : "Open"}
          </button>
        )}
      </StepFlow>

      <div className="flex gap-3">
        {current > 0 ? (
          <button className={GHOST} onClick={() => setIndex(current - 1)} type="button">
            Back
          </button>
        ) : null}
        <button className={step.done ? PRIMARY : GHOST} onClick={advance} type="button">
          {step.done ? "Next" : "Skip"}
        </button>
      </div>
    </div>
  );
});

/** Save button + inline error, shared by the small forms below. */
function SaveForm({
  children,
  disabled,
  onSave,
}: {
  children: ReactNode;
  disabled?: boolean;
  onSave: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await onSave();
        } catch (caught) {
          setError(errorText(caught));
        } finally {
          setSaving(false);
        }
      }}
    >
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <button className={PRIMARY} disabled={disabled || saving} type="submit">
        {saving ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function PhotosStep({ kyc, onChange }: { kyc: Kyc; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const kind = useRef<"EXTERIOR" | "INTERIOR">("EXTERIOR");
  const [busy, setBusy] = useState("");

  async function add(files: File[]) {
    setBusy(kind.current);

    try {
      for (const file of files) {
        const [outcome] = await uploadFiles([file], {
          accessLevel: "PUBLIC",
          kind: "image",
          label: "Hostel photo",
          silent: true,
        });
        const assetId = outcome?.ok ? outcome.result.assetId : undefined;

        if (!assetId) continue;

        await browserApi(`${hostelAdminEndpoints.profile}/photos`, {
          body: JSON.stringify({ fileAssetId: assetId, kind: kind.current, url: `/api/v1/files/${assetId}/url` }),
          method: "POST",
        });
      }
    } finally {
      setBusy("");
      onChange();
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-center text-3xl font-bold text-foreground">
        {Math.min(kyc.photoCount, kyc.minPhotos)} / {kyc.minPhotos}
      </p>
      <input
        accept="image/*"
        className="hidden"
        multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) void add(files);
        }}
        ref={input}
        type="file"
      />
      <div className="grid grid-cols-2 gap-3">
        {(["EXTERIOR", "INTERIOR"] as const).map((value) => (
          <button
            className={OUTLINE}
            disabled={Boolean(busy)}
            key={value}
            onClick={() => {
              kind.current = value;
              input.current?.click();
            }}
            type="button"
          >
            {busy === value ? "Uploading…" : value === "EXTERIOR" ? "Outside" : "Inside"}
          </button>
        ))}
      </div>
    </div>
  );
}

function DocumentsStep({ kyc, onChange }: { kyc: Kyc; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<string>(DOCUMENTS[0].type);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function upload(file: File) {
    const type = pending.current;

    setBusy(type);
    setError("");

    try {
      const uploaded = await uploadRegistrationDocument(file, type);

      await browserApi(ENDPOINT, {
        body: JSON.stringify({ documents: [{ ...uploaded, documentType: type }] }),
        method: "POST",
      });
      onChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-3">
      <input
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }}
        ref={input}
        type="file"
      />
      {DOCUMENTS.map((doc) => {
        const uploaded = kyc.documents.some((row) => doc.match(row.type));

        return (
          <button
            className="flex w-full items-center gap-3 rounded-2xl border border-border p-4 text-left transition hover:bg-muted disabled:opacity-60"
            disabled={Boolean(busy)}
            key={doc.type}
            onClick={() => {
              pending.current = doc.type;
              input.current?.click();
            }}
            type="button"
          >
            <IdCard className="size-5 text-muted-foreground" />
            <span className="flex-1 font-semibold text-foreground">{doc.label}</span>
            {busy === doc.type ? (
              <span className="text-xs text-muted-foreground">Uploading…</span>
            ) : uploaded ? (
              <span className="flex size-6 items-center justify-center rounded-full bg-brand-teal text-white">
                <Check className="size-3.5" strokeWidth={3} />
              </span>
            ) : (
              <span className="text-sm font-semibold text-brand-teal">Upload</span>
            )}
          </button>
        );
      })}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function PayoutStep({ onSaved }: { onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(EMPTY_PAYOUT_DRAFT);
  const payload = payoutAccountPayload(draft);

  return (
    <SaveForm
      disabled={!payload}
      onSave={async () => {
        await browserApi("/api/v1/hostel-admin/payout-account", {
          body: JSON.stringify(payload),
          method: "PUT",
        });
        await onSaved();
      }}
    >
      <PayoutAccountFields onChange={setDraft} value={draft} />
    </SaveForm>
  );
}

function PaymentsStep({ onBank, onSaved }: { onBank: () => void; onSaved: () => Promise<void> }) {
  const [esewaId, setEsewaId] = useState("");
  const [khaltiId, setKhaltiId] = useState("");

  return (
    <div className="space-y-2">
      <SaveForm
        disabled={!esewaId.trim() && !khaltiId.trim()}
        onSave={async () => {
          await browserApi(hostelAdminEndpoints.paymentProfile, {
            body: JSON.stringify({
              ...(esewaId.trim() ? { esewaId: esewaId.trim() } : {}),
              ...(khaltiId.trim() ? { khaltiId: khaltiId.trim() } : {}),
            }),
            method: "PATCH",
          });
          await onSaved();
        }}
      >
        <input className="input-field w-full" inputMode="tel" onChange={(e) => setEsewaId(e.target.value)} placeholder="eSewa ID" value={esewaId} />
        <input className="input-field w-full" inputMode="tel" onChange={(e) => setKhaltiId(e.target.value)} placeholder="Khalti ID" value={khaltiId} />
      </SaveForm>
      <button className={GHOST} onClick={onBank} type="button">
        Bank or QR instead
      </button>
    </div>
  );
}

function RulesStep({ initial, onSaved }: { initial: string[]; onSaved: () => Promise<void> }) {
  const [text, setText] = useState(initial.join("\n"));
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <SaveForm
      disabled={rules.length === 0}
      onSave={async () => {
        await browserApi(hostelAdminEndpoints.profile, { body: JSON.stringify({ rules }), method: "PATCH" });
        await onSaved();
      }}
    >
      <textarea
        className="input-field h-auto min-h-36 w-full resize-y py-2"
        onChange={(event) => setText(event.target.value)}
        placeholder={"Gate closes at 10 PM\nNo smoking indoors"}
        value={text}
      />
    </SaveForm>
  );
}

function FacilitiesStep({ initial, onSaved }: { initial: string[]; onSaved: () => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>(initial);
  const options = [...new Set([...facilityOptions, ...initial])];

  return (
    <SaveForm
      disabled={picked.length === 0}
      onSave={async () => {
        await browserApi(hostelAdminEndpoints.profile, {
          body: JSON.stringify({ facilities: picked }),
          method: "PATCH",
        });
        await onSaved();
      }}
    >
      <div className="flex flex-wrap justify-center gap-2">
        {options.map((option) => {
          const on = picked.includes(option);

          return (
            <button
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-semibold transition",
                on ? "border-brand-teal bg-brand-teal text-white" : "border-border text-foreground hover:bg-muted",
              )}
              key={option}
              onClick={() =>
                setPicked((current) => (on ? current.filter((item) => item !== option) : [...current, option]))
              }
              type="button"
            >
              {option}
            </button>
          );
        })}
      </div>
    </SaveForm>
  );
}
