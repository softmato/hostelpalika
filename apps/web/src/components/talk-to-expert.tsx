"use client";

import { CheckCircle2, Loader2, X } from "@/components/icons";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { requestResidentProfileForm } from "@/components/resident-identity";
import { refreshSession } from "@/lib/auth-refresh";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { NEPAL_COLLEGES } from "@/lib/maps/nepal-colleges";
import { cn } from "@/lib/utils";

type Step =
  | "checking"
  | "closed"
  | "done"
  | "error"
  | "form"
  | "needs-profile"
  | "signin";

type IdentityResponse = {
  identity: { accountEmail: string | null; hasProfile: boolean };
  profile: { budgetRange?: string; fullName: string; primaryEmail: string; primaryPhone: string } | null;
};

type Prefill = { budgetRange: string; email: string; fullName: string; phone: string };

const EMPTY_PREFILL: Prefill = { budgetRange: "", email: "", fullName: "", phone: "" };

const ENVIRONMENT_OPTIONS = [
  "Quiet & studious",
  "Social & lively",
  "Family-friendly",
  "No strong preference",
];

/**
 * Same recoverable-401 pattern as the resident identity center: a raw fetch,
 * not `browserApi`, because a 401 here means "sign in first," not a fault —
 * `browserApi` would redirect the visitor away before this component gets a
 * chance to show that in the modal.
 */
export async function checkOnly<T>(url: string): Promise<{ data: T | null; status: number }> {
  let response = await fetch(url, { credentials: "same-origin" });

  if (response.status === 401 && (await refreshSession())) {
    response = await fetch(url, { credentials: "same-origin" });
  }

  if (!response.ok) {
    return { data: null, status: response.status };
  }

  const payload = (await response.json().catch(() => null)) as {
    data: T;
    success: true;
  } | null;

  return { data: payload?.success ? payload.data : null, status: response.status };
}

function Field({
  defaultValue,
  label,
  name,
  placeholder,
  required,
  type = "text",
}: {
  defaultValue?: string;
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="block text-xs font-bold text-foreground">
      {label}
      {required ? <span className="text-danger"> *</span> : null}
      <input
        className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal text-foreground outline-none transition placeholder:text-foreground/45 focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
        defaultValue={defaultValue}
        name={name}
        placeholder={placeholder}
        required={required}
        type={type}
      />
    </label>
  );
}

function Modal({
  children,
  footer,
  onClose,
}: {
  children: ReactNode;
  /** Stays pinned below the scroll area — for a submit button on a long form. */
  footer?: ReactNode;
  onClose: () => void;
}) {
  return createPortal(
    <div
      aria-modal
      className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
    >
      <div aria-hidden className="absolute inset-0" onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h2 className="font-heading text-lg font-extrabold text-foreground">
              Talk to a discovery expert
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Tell us what you are looking for and our team will call you.
            </p>
          </div>
          <button
            aria-label="Close"
            className="rounded-md p-1.5 text-foreground transition hover:bg-muted"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? (
          <div className="shrink-0 border-t border-border px-6 py-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The "Talk to an Expert" trigger and its gated flow: sign in, then a
 * completed resident profile, then this short preference form. Both gates
 * reuse existing flows (the login pages, the resident-identity prompt) rather
 * than re-implementing them — this component only owns the new question set.
 */
export function TalkToExpertButton({
  className,
  onSubmitted,
}: {
  className?: string;
  /** Fires once the request is saved — lets a parent refetch its own copy. */
  onSubmitted?: () => void;
}) {
  const [step, setStep] = useState<Step>("closed");
  const [prefill, setPrefill] = useState<Prefill>(EMPTY_PREFILL);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const close = () => {
    setStep("closed");
    setError("");
  };

  async function open() {
    setStep("checking");
    setError("");

    const result = await checkOnly<IdentityResponse>("/api/v1/users/resident-identity");

    if (result.status === 401) {
      setStep("signin");
      return;
    }

    if (!result.data) {
      setError("Could not check your account. Please try again.");
      setStep("error");
      return;
    }

    if (!result.data.identity.hasProfile) {
      setStep("needs-profile");
      return;
    }

    setPrefill({
      budgetRange: result.data.profile?.budgetRange ?? "",
      email: result.data.profile?.primaryEmail ?? result.data.identity.accountEmail ?? "",
      fullName: result.data.profile?.fullName ?? "",
      phone: result.data.profile?.primaryPhone ?? "",
    });
    setStep("form");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();

    try {
      await browserApi("/api/v1/users/expert-consultation-requests", {
        body: JSON.stringify({
          budgetRange: text("budgetRange") || undefined,
          email: text("email") || undefined,
          environment: text("environment") || undefined,
          fullName: text("fullName"),
          likedSpots: text("likedSpots") || undefined,
          phone: text("phone"),
          preferredCollege: text("preferredCollege") || undefined,
        }),
        method: "POST",
      });
      setStep("done");
      onSubmitted?.();
    } catch (submitError) {
      setError(
        submitError instanceof ApiRequestError
          ? submitError.message
          : "Could not send your request. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  const next = typeof window === "undefined" ? "/compare" : window.location.pathname;

  return (
    <>
      <button
        className={cn(
          "rounded-lg border border-slate-900 bg-slate-900 px-5 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-70",
          className,
        )}
        disabled={step === "checking"}
        onClick={() => void open()}
        type="button"
      >
        {step === "checking" ? "Checking…" : "Talk to an Expert"}
      </button>

      {step === "signin" ? (
        <Modal onClose={close}>
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Sign in first so our team knows who to call back.
            </p>
            <Link
              className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-brand-teal text-sm font-bold text-white shadow-sm transition hover:brightness-110"
              href={`/login?next=${encodeURIComponent(next)}`}
            >
              Sign in
            </Link>
            <Link
              className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-border text-sm font-bold text-foreground transition hover:bg-muted"
              href={`/signup?next=${encodeURIComponent(next)}`}
            >
              Create an account
            </Link>
          </div>
        </Modal>
      ) : null}

      {step === "needs-profile" ? (
        <Modal onClose={close}>
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Save your resident details once — it takes about two minutes — and our
              expert will already have your name and number when they call.
            </p>
            <button
              className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-brand-teal text-sm font-bold text-white shadow-sm transition hover:brightness-110"
              onClick={() => {
                close();
                requestResidentProfileForm("MANUAL");
              }}
              type="button"
            >
              Complete my resident profile
            </button>
            <p className="text-center text-xs text-muted-foreground">
              Once you are done, tap &ldquo;Talk to an Expert&rdquo; again to continue.
            </p>
          </div>
        </Modal>
      ) : null}

      {step === "error" ? (
        <Modal onClose={close}>
          <p className="text-sm font-semibold text-danger">{error}</p>
        </Modal>
      ) : null}

      {step === "done" ? (
        <Modal onClose={close}>
          <div className="space-y-3 py-2 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-brand-teal-soft text-brand-teal">
              <CheckCircle2 className="size-7" />
            </div>
            <p className="text-sm font-extrabold text-foreground">Request sent</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Our discovery expert will call you soon to help you choose.
            </p>
            <button
              className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-5 text-sm font-bold text-foreground transition hover:bg-muted"
              onClick={close}
              type="button"
            >
              Close
            </button>
          </div>
        </Modal>
      ) : null}

      {step === "form" ? (
        <Modal
          footer={
            <button
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-teal text-sm font-bold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
              disabled={saving}
              form="talk-to-expert-form"
              type="submit"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {saving ? "Sending…" : "Request a call back"}
            </button>
          }
          onClose={close}
        >
          <form
            className="space-y-4"
            id="talk-to-expert-form"
            onSubmit={handleSubmit}
          >
            {error ? (
              <div
                className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs font-semibold text-danger"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                defaultValue={prefill.fullName}
                label="Full name"
                name="fullName"
                required
              />
              <Field
                defaultValue={prefill.phone}
                label="Phone"
                name="phone"
                required
                type="tel"
              />
              <Field
                defaultValue={prefill.email}
                label="Email"
                name="email"
                type="email"
              />
              <Field
                defaultValue={prefill.budgetRange}
                label="Monthly budget"
                name="budgetRange"
                placeholder="8000-12000"
              />
            </div>

            <label className="block text-xs font-bold text-foreground">
              What kind of environment are you looking for?
              <select
                className="mt-1.5 h-11 w-full cursor-pointer rounded-lg border border-border bg-background px-3 text-sm font-normal text-foreground outline-none transition focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
                defaultValue=""
                name="environment"
              >
                <option value="">Select one</option>
                {ENVIRONMENT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs font-bold text-foreground">
              Which college or campus?
              <select
                className="mt-1.5 h-11 w-full cursor-pointer rounded-lg border border-border bg-background px-3 text-sm font-normal text-foreground outline-none transition focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
                defaultValue=""
                name="preferredCollege"
              >
                <option value="">Not sure yet</option>
                {NEPAL_COLLEGES.map((college) => (
                  <option key={college.name} value={college.name}>
                    {college.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs font-bold text-foreground">
              Any hostels or areas you have already liked?
              <textarea
                className="mt-1.5 min-h-20 w-full rounded-lg border border-border bg-background p-3 text-sm font-normal text-foreground outline-none transition placeholder:text-foreground/45 focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
                maxLength={500}
                name="likedSpots"
                placeholder="Optional — hostel names or areas like Baneshwor, Pulchowk…"
              />
            </label>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
