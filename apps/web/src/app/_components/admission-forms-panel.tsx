"use client";

import { formatBsDate } from "@hostel/shared/calendar/bs";
import { Check, Copy, Download, X } from "@/components/icons";
import { useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { InitialsAvatar } from "@/app/_components/portal-dashboard-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WhatsAppMark } from "@/components/whatsapp-mark";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import type { ResidentDetails } from "@/modules/residents/resident-details";
import { toast } from "@/stores/toast-store";

/**
 * The Form QR on the web (`modules/residents/admission-form.service.ts`):
 * people who filled the hostel's admission form on their own phone and want a
 * bed — the list the app's Residents tab leads with — and the QR itself.
 */

export type AdmissionForm = {
  details: ResidentDetails | null;
  email: string;
  firstName: string;
  id: string;
  lastName: string;
  phone: string;
  photo: string | null;
  residentType: "OTHER" | "STUDENT" | "WORKING_PROFESSIONAL";
  submittedAt: string;
};

export const ADMISSION_FORMS_URL = "/api/v1/hostel-admin/residents/admission-forms";
const LINK_URL = "/api/v1/hostel-admin/residents/admission-form-link";

/** Waiting forms, above the roster they will change. Renders nothing when none wait. */
export function AdmissionFormsPanel({ onRegister }: { onRegister: (form: AdmissionForm) => void }) {
  const forms = usePortalResource<{ forms: AdmissionForm[] }>(ADMISSION_FORMS_URL);
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const [opening, setOpening] = useState("");
  const pending = forms.data?.forms ?? [];

  if (pending.length === 0) return confirmDialog;

  async function register(form: AdmissionForm) {
    setOpening(form.id);

    try {
      // The full form — documents and the paper details — not the list row.
      onRegister(await browserApi<AdmissionForm>(`${ADMISSION_FORMS_URL}/${encodeURIComponent(form.id)}`));
    } catch (error) {
      toast.error({ description: error instanceof Error ? error.message : undefined, title: "Could not open the form" });
    } finally {
      setOpening("");
    }
  }

  async function decline(form: AdmissionForm) {
    const ok = await confirm({
      actionLabel: "Decline",
      description: "Their form leaves this list. They can fill the Form QR again.",
      title: `Decline ${form.firstName}?`,
      tone: "destructive",
    });

    if (!ok) return;

    try {
      await browserApi(`${ADMISSION_FORMS_URL}/${encodeURIComponent(form.id)}`, { method: "DELETE" });
      invalidate(ADMISSION_FORMS_URL);
    } catch (error) {
      toast.error({ description: error instanceof Error ? error.message : undefined, title: "Not declined" });
    }
  }

  return (
    <section className="space-y-2">
      {confirmDialog}
      <div>
        <h2 className="text-sm font-bold text-foreground">
          {pending.length === 1 ? "1 wants to live here" : `${pending.length} want to live here`}
        </h2>
        <p className="text-xs text-muted-foreground">Filled your Form QR · choose a bed to register</p>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {pending.map((form) => {
          const name = `${form.firstName} ${form.lastName}`.trim();

          return (
            <div className="flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning/5 p-3" key={form.id}>
              <InitialsAvatar image={form.photo} name={name} size="md" tone="admin" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[form.phone, `Sent ${formatBsDate(new Date(form.submittedAt))}`].filter(Boolean).join(" · ")}
                </p>
              </div>
              <Button disabled={opening === form.id} onClick={() => void register(form)} size="sm">
                {opening === form.id ? "Opening…" : "Register"}
              </Button>
              <Button aria-label={`Decline ${name}`} onClick={() => void decline(form)} size="icon" variant="ghost">
                <X className="size-4" />
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type FormLink = { enabled: boolean; hostelName: string; qrDataUrl: string | null; url: string };

/** The hostel's Form QR, to print at the desk or send to someone before they come. */
export function FormQrDialog({ onClose }: { onClose: () => void }) {
  const link = usePortalResource<FormLink>(LINK_URL, { errorMessage: "Could not load the Form QR." });
  const [copied, setCopied] = useState(false);
  const data = link.data;
  const message = data ? `Fill ${data.hostelName}'s admission form here:\n${data.url}` : "";

  return (
    <Dialog onOpenChange={(next) => (next ? null : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Form QR</DialogTitle>
          <DialogDescription>
            They scan it, fill your admission form on their own phone, and it lands here for you to register.
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{link.message || "Loading…"}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/30 p-4">
              {data.qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL
                <img alt="Form QR" className="size-52 rounded-lg bg-white p-2" src={data.qrDataUrl} />
              ) : null}
              <p className="break-all text-center font-mono text-xs text-muted-foreground">{data.url}</p>
            </div>
            <Button asChild className="h-11 w-full" variant="outline">
              <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} rel="noreferrer" target="_blank">
                <WhatsAppMark className="size-5" />
                Send on WhatsApp
              </a>
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(data.url).catch(() => null);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                }}
                variant="outline"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button asChild disabled={!data.qrDataUrl} variant="outline">
                <a download="form-qr.png" href={data.qrDataUrl ?? undefined}>
                  <Download className="size-4" />
                  QR
                </a>
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A form's family and local guardian as the resident's own contact records — what the app writes too. */
export function detailsContacts(details: ResidentDetails | null) {
  const longEnough = (phone?: string) => (phone ?? "").replace(/\D/g, "").length >= 7;
  const guardians = (details?.family ?? [])
    .filter((person) => longEnough(person.phone))
    .map((person, index) => {
      const [firstName = "", ...rest] = (person.name ?? "").trim().split(/\s+/);

      return {
        firstName,
        isPrimary: index === 0,
        // The same split the app makes: a one-word name is both.
        lastName: rest.join(" ") || firstName,
        phone: person.phone!,
        relation: person.relation,
      };
    });
  const local = details?.localGuardian;
  const emergencyContact =
    local && longEnough(local.phone)
      ? { isPrimary: true, name: local.name, phone: local.phone!, relation: local.relation }
      : null;

  return { emergencyContact, guardians };
}
