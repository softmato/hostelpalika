"use client";

import { Loader2, Pencil, QrCode, SlidersHorizontal, Upload, X } from "@/components/icons";
import Image from "next/image";
import { memo, useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
} from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadFile } from "@/lib/uploads/uploader";
import { FactChip } from "./platform-page-ui";
import { field } from "./portal-shared";

type OperationsConfig = {
  collectionQrLabel: string;
  collectionQrUrl: string;
  complaintSlaHours: number;
  foodReadyCooldownMinutes: number;
  maxAttendanceRetentionDays: number;
  maxInsideZoneRadiusMeters: number;
  maxNearbyZoneRadiusMeters: number;
  paymentReminderDaysBefore: number;
  qrActivationExpiryDays: number;
  receiptNumberPrefix: string;
  sendComplaintEmails: boolean;
  sendNoticeEmails: boolean;
  sendPaymentEmails: boolean;
  subscriptionDueGraceDays: number;
  trialDays: number;
  leaveHoldMaxDays: number;
  leaveHoldMinDays: number;
};

/** A money-setting edit parked until the superadmin opens the emailed link. */
type PendingSettingChange = {
  expiresAt: string;
  id: string;
  sentTo: string;
};

const OPERATIONS_ENDPOINT = "/api/v1/platform/operations-config";

/**
 * The merchant QR a field agent holds up for an owner to scan.
 *
 * An upload rather than a URL box because the person setting it has a picture
 * from their bank, not a link — and because a mistyped URL here is a QR that
 * silently fails to render in front of a paying customer.
 *
 * The preview is not decoration: it is the only way to catch that the wrong
 * image was uploaded before an agent shows it to somebody.
 */
function CollectionQrField({
  defaultLabel,
  defaultUrl,
}: {
  defaultLabel: string;
  defaultUrl: string;
}) {
  const [url, setUrl] = useState(defaultUrl);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(file: File) {
    setUploading(true);
    setError("");

    try {
      const uploaded = await uploadFile(file, {
        kind: "image",
        label: "Collection QR",
        silent: true,
        target: "public",
        visibility: "public",
      });

      if (!uploaded?.url) {
        throw new Error("Upload failed");
      }

      setUrl(uploaded.url);
    } catch {
      setError("Could not upload that image.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <fieldset className="grid gap-4 rounded-lg border border-border p-3 sm:grid-cols-[auto_1fr]">
      <legend className="px-1 text-xs font-semibold text-muted-foreground">
        Field collection QR
      </legend>

      <input name="collectionQrUrl" type="hidden" value={url} />

      <div className="flex size-32 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface">
        {uploading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : url ? (
          <Image alt="Collection QR" height={128} src={url} unoptimized width={128} />
        ) : (
          <QrCode className="size-8 text-muted-foreground/40" />
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-semibold text-foreground transition hover:border-role-platform">
            <Upload className="size-3.5" />
            {url ? "Replace image" : "Upload QR image"}
            <input
              accept={acceptAttribute("image")}
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];

                if (file) {
                  void handleFile(file);
                }

                event.currentTarget.value = "";
              }}
              type="file"
            />
          </label>

          {url ? (
            <button
              className="inline-flex items-center gap-1 rounded-md px-2 py-2 text-xs font-semibold text-muted-foreground transition hover:text-destructive"
              onClick={() => setUrl("")}
              type="button"
            >
              <X className="size-3.5" /> Remove
            </button>
          ) : null}
        </div>

        <Input
          defaultValue={defaultLabel}
          hint="Read out while they scan, so the owner can check it."
          label="Account name on the QR"
          name="collectionQrLabel"
          placeholder="HostelDays Pvt. Ltd. — Fonepay"
        />

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </fieldset>
  );
}

/**
 * Platform defaults and the ceilings hostels tune within (ARCHITECTURE.md §5).
 * Deliberately separate from Website Config: this changes how activation,
 * payments, complaints and attendance behave, not what the public site says.
 */
export const PlatformOperationsPanel = memo(function PlatformOperationsPanel() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);

  const resource = usePortalResource<{
    config: OperationsConfig;
    pendingQrChange: PendingSettingChange | null;
  }>(OPERATIONS_ENDPOINT, {
    errorMessage: "Could not load operations configuration.",
  });
  const config = resource.data?.config ?? null;
  const pendingQrChange = resource.data?.pendingQrChange ?? null;

  const cancelQrChange = useCallback(async () => {
    if (!pendingQrChange) return;

    setBusy(true);

    try {
      await browserApi(`/api/v1/platform/setting-changes/${pendingQrChange.id}`, {
        method: "DELETE",
      });
      setMessage("The QR change was cancelled.");
      await resource.refreshAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not cancel the QR change.");
    } finally {
      setBusy(false);
    }
  }, [pendingQrChange, resource]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);

      setBusy(true);
      setMessage("");

      try {
        const saved = await browserApi<{ pendingQrChange: PendingSettingChange | null }>(
          OPERATIONS_ENDPOINT,
          {
          body: JSON.stringify({
            collectionQrLabel: field(form, "collectionQrLabel"),
            collectionQrUrl: field(form, "collectionQrUrl"),
            complaintSlaHours: Number(field(form, "complaintSlaHours")),
            foodReadyCooldownMinutes: Number(field(form, "foodReadyCooldownMinutes")),
            maxAttendanceRetentionDays: Number(field(form, "maxAttendanceRetentionDays")),
            maxInsideZoneRadiusMeters: Number(field(form, "maxInsideZoneRadiusMeters")),
            maxNearbyZoneRadiusMeters: Number(field(form, "maxNearbyZoneRadiusMeters")),
            paymentReminderDaysBefore: Number(field(form, "paymentReminderDaysBefore")),
            qrActivationExpiryDays: Number(field(form, "qrActivationExpiryDays")),
            receiptNumberPrefix: field(form, "receiptNumberPrefix"),
            sendComplaintEmails: field(form, "sendComplaintEmails") === "true",
            sendNoticeEmails: field(form, "sendNoticeEmails") === "true",
            sendPaymentEmails: field(form, "sendPaymentEmails") === "true",
            subscriptionDueGraceDays: Number(field(form, "subscriptionDueGraceDays")),
            trialDays: Number(field(form, "trialDays")),
            leaveHoldMaxDays: Number(field(form, "leaveHoldMaxDays")),
            leaveHoldMinDays: Number(field(form, "leaveHoldMinDays")),
          }),
          method: "PUT",
          },
        );

        const qrChanged =
          field(form, "collectionQrUrl") !== (config?.collectionQrUrl ?? "") ||
          field(form, "collectionQrLabel") !== (config?.collectionQrLabel ?? "");

        setMessage(
          qrChanged && saved.pendingQrChange
            ? `Saved. The QR change waits for the confirm link we emailed to ${saved.pendingQrChange.sentTo}.`
            : "Operations configuration saved.",
        );
        setEditing(false);
        await resource.refreshAsync();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not save the configuration.",
        );
      } finally {
        setBusy(false);
      }
    },
    [config, resource],
  );

  return (
    <Panel
      action={
        config ? (
          <Button onClick={() => setEditing(true)} size="sm" type="button" variant="outline">
            <Pencil className="size-3.5" />
            Edit
          </Button>
        ) : null
      }
      title="Operations configuration"
    >
      {resource.state === "loading" ? <LoadingRows /> : null}
      {resource.state === "error" ? (
        <EmptyState label="Operations configuration could not be loaded." />
      ) : null}

      {config ? (
        <div className="space-y-4">
          {message && !editing ? <p className="text-[12.5px] text-muted-foreground">{message}</p> : null}

          {/* The settings as facts; Edit opens the form. */}
          <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
            <div className="flex size-24 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface">
              {config.collectionQrUrl ? (
                <Image alt="Collection QR" height={96} src={config.collectionQrUrl} unoptimized width={96} />
              ) : (
                <QrCode className="size-7 text-muted-foreground/40" />
              )}
            </div>
            <div className="space-y-3">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Timing</p>
                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="gift">{`${config.trialDays}-day free trial`}</FactChip>
                  <FactChip glyph="time">{`Leaving hostels held ${config.leaveHoldMinDays}–${config.leaveHoldMaxDays} days`}</FactChip>
                  <FactChip glyph="time">{`${config.subscriptionDueGraceDays} days to pay a plan`}</FactChip>
                  <FactChip glyph="notifications">{`Reminder ${config.paymentReminderDaysBefore} days before`}</FactChip>
                  <FactChip glyph="qr-code">{`Activation code ${config.qrActivationExpiryDays} days`}</FactChip>
                  <FactChip glyph="chatbox-alert">{`Complaint SLA ${config.complaintSlaHours} h`}</FactChip>
                  <FactChip glyph="restaurant">{`Food-ready cooldown ${config.foodReadyCooldownMinutes} min`}</FactChip>
                  <FactChip glyph="receipt">{`Receipts ${config.receiptNumberPrefix}…`}</FactChip>
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Limits hostels tune within</p>
                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="locate">{`Inside ≤ ${config.maxInsideZoneRadiusMeters} m`}</FactChip>
                  <FactChip glyph="navigate">{`Nearby ≤ ${config.maxNearbyZoneRadiusMeters} m`}</FactChip>
                  <FactChip glyph="archive">{`Attendance kept ≤ ${config.maxAttendanceRetentionDays} days`}</FactChip>
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Emails</p>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: "Payment", on: config.sendPaymentEmails },
                    { label: "Notice", on: config.sendNoticeEmails },
                    { label: "Complaint", on: config.sendComplaintEmails },
                  ].map((item) => (
                    <FactChip glyph={item.on ? "mail" : "mail-x"} key={item.label} tone={item.on ? "brand" : "neutral"}>
                      {`${item.label} ${item.on ? "on" : "off"}`}
                    </FactChip>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {pendingQrChange ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-[13.5px]">
              <p className="text-foreground">
                The QR change waits for the confirm link sent to{" "}
                <span className="font-semibold">{pendingQrChange.sentTo}</span>.
              </p>
              <button
                className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-semibold text-foreground transition hover:bg-muted disabled:opacity-60"
                disabled={busy}
                onClick={() => void cancelQrChange()}
                type="button"
              >
                Cancel change
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog onOpenChange={setEditing} open={editing && config !== null}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Operations configuration</DialogTitle>
            <DialogDescription>How activation, payments, complaints and attendance behave, not what the site says.</DialogDescription>
          </DialogHeader>
      {config ? (
        <form className="grid gap-4" key={JSON.stringify(config)} onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Input
              defaultValue={config.qrActivationExpiryDays}
              hint="How long an activation code stays valid."
              label="QR activation expiry (days)"
              min="1"
              name="qrActivationExpiryDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.paymentReminderDaysBefore}
              hint="How early a due payment is emailed."
              label="Payment reminder lead (days)"
              min="0"
              name="paymentReminderDaysBefore"
              required
              type="number"
            />
            {/*
              The plan trial. Registered on 25 Bhadra with 3 here, and the
              balance is due on 28 Bhadra — the hostel is live and usable in
              between. The same number sets the window on a public owner's
              invoice after Pay now, so the answer to "how long do I have" is
              one figure wherever it is asked.
            */}
            <Input
              defaultValue={config.subscriptionDueGraceDays}
              hint="Days to pay a plan invoice once raised."
              label="Plan payment window (days)"
              max="180"
              min="1"
              name="subscriptionDueGraceDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.trialDays}
              hint="For new hostels; running trials keep theirs."
              label="Free trial (days)"
              max="90"
              min="1"
              name="trialDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.leaveHoldMinDays}
              hint="Shortest a leaving hostel's data is held."
              label="Leave hold, shortest (days)"
              max="60"
              min="1"
              name="leaveHoldMinDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.leaveHoldMaxDays}
              hint="Longest; the owner picks in between."
              label="Leave hold, longest (days)"
              max="60"
              min="1"
              name="leaveHoldMaxDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.complaintSlaHours}
              hint="Every complaint is measured against it."
              label="Complaint SLA (hours)"
              min="1"
              name="complaintSlaHours"
              required
              type="number"
            />
            <Input
              defaultValue={config.receiptNumberPrefix}
              hint="Leads every receipt number."
              label="Receipt prefix"
              name="receiptNumberPrefix"
              required
            />
            <Input
              defaultValue={config.foodReadyCooldownMinutes}
              hint="Limits a shared cook login."
              label="Food-ready cooldown (minutes)"
              min="0"
              name="foodReadyCooldownMinutes"
              required
              type="number"
            />
          </div>

          <fieldset className="grid gap-4 rounded-xl border border-border p-3 sm:grid-cols-3">
            <legend className="px-1 text-xs font-semibold text-muted-foreground">
              Limits hostels tune within
            </legend>
            <Input
              defaultValue={config.maxInsideZoneRadiusMeters}
              label="Max inside radius (m)"
              min="10"
              name="maxInsideZoneRadiusMeters"
              required
              type="number"
            />
            <Input
              defaultValue={config.maxNearbyZoneRadiusMeters}
              label="Max nearby radius (m)"
              min="20"
              name="maxNearbyZoneRadiusMeters"
              required
              type="number"
            />
            <Input
              defaultValue={config.maxAttendanceRetentionDays}
              label="Max attendance retention (days)"
              min="30"
              name="maxAttendanceRetentionDays"
              required
              type="number"
            />
          </fieldset>

          <CollectionQrField
            defaultLabel={config.collectionQrLabel}
            defaultUrl={config.collectionQrUrl}
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <Select
              defaultValue={String(config.sendPaymentEmails)}
              label="Payment emails"
              name="sendPaymentEmails"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </Select>
            <Select
              defaultValue={String(config.sendNoticeEmails)}
              label="Notice emails"
              name="sendNoticeEmails"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </Select>
            <Select
              defaultValue={String(config.sendComplaintEmails)}
              label="Complaint emails"
              name="sendComplaintEmails"
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </Select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {message}
            </p>
            <button
              className="inline-flex items-center gap-2 rounded-xl bg-brand-teal px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-platform disabled:opacity-60"
              disabled={busy}
              type="submit"
            >
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              {busy ? "Saving…" : "Save configuration"}
            </button>
          </div>
        </form>
      ) : null}
        </DialogContent>
      </Dialog>
    </Panel>
  );
});
