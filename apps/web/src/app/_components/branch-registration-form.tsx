"use client";

import { CheckCircle2 } from "@/components/icons";
import { useState, type FormEvent, type InputHTMLAttributes } from "react";

import { browserApi } from "@/lib/browser-api";
import { branchRequestSchema } from "@/lib/hostels/hostel-branch.validation";
import { toast } from "@/stores/toast-store";

function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block min-w-0 text-sm font-semibold text-foreground">
      {label}
      {props.required ? <span className="text-brand-teal"> *</span> : null}
      <input {...props} className="input-field mt-2 block w-full min-w-0" />
      {hint ? <span className="mt-1 block text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/**
 * A new branch is two answers, like the quick sign-up: its name and the label
 * that tells it apart. Everything else — location, rooms, documents, payout —
 * is the branch's own KYC, done from the branch once it exists.
 */
export function BranchForm({
  main,
  onCancel,
  onFiled,
}: {
  main: { name: string };
  onCancel: () => void;
  onFiled: () => void;
}) {
  const [name, setName] = useState(main.name);
  const [branchLabel, setBranchLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const parsed = branchRequestSchema.safeParse({ branchLabel, name });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.path[0] === "name"
          ? "Enter the branch's name."
          : "Add a short label, like Block B.",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      await browserApi("/api/v1/hostel-admin/branches", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      toast.success({
        title: `${parsed.data.branchLabel} added`,
        description: "Switch to it and complete its KYC to open every feature.",
      });
      onFiled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the branch. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-7">
      <h2 className="text-xl font-bold text-foreground">New branch</h2>
      <p className="sr-only">
        Name the branch and give it a short label. Its KYC, done from the branch, covers
        the rest.
      </p>
      <form className="mt-5 grid gap-4 sm:grid-cols-2" noValidate onSubmit={submit}>
        <Field
          label="Branch name"
          maxLength={160}
          minLength={2}
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <Field
          hint="How you tell it apart, like Block B or Thamel branch."
          label="Branch label"
          maxLength={40}
          onChange={(event) => setBranchLabel(event.target.value)}
          required
          value={branchLabel}
        />
        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive sm:col-span-2"
          >
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3 border-t border-border pt-5 sm:col-span-2">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="mr-auto rounded-xl px-3 py-2.5 text-sm text-muted-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-brand-teal px-5 py-3 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {saving ? "Adding…" : "Add branch"}
            <CheckCircle2 className="size-4" />
          </button>
        </div>
      </form>
    </section>
  );
}
