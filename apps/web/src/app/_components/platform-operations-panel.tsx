"use client";

import { Loader2, QrCode, SlidersHorizontal, Upload, X } from "lucide-react";
import Image from "next/image";
import { memo, useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
} from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadFile } from "@/lib/uploads/uploader";
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
          hint="Read out while they scan, so the owner can check the name on their own screen before confirming."
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
    <Panel title="Operations configuration">
      {resource.state === "loading" ? <LoadingRows /> : null}
      {resource.state === "error" ? (
        <EmptyState label="Operations configuration could not be loaded." />
      ) : null}

      {config ? (
        <form className="grid gap-4" key={JSON.stringify(config)} onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Input
              defaultValue={config.qrActivationExpiryDays}
              hint="Days a resident activation code stays valid."
              label="QR activation expiry (days)"
              min="1"
              name="qrActivationExpiryDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.paymentReminderDaysBefore}
              hint="How early the reminder cron emails a due payment."
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
              hint="Days an owner has to pay a plan invoice once it is raised."
              label="Plan payment window (days)"
              max="180"
              min="1"
              name="subscriptionDueGraceDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.trialDays}
              hint="Free days a newly registered hostel gets before it pays monthly or the lifetime deal. Hostels already on a trial keep theirs."
              label="Free trial (days)"
              max="90"
              min="1"
              name="trialDays"
              required
              type="number"
            />
            <Input
              defaultValue={config.complaintSlaHours}
              hint="Response window every complaint is measured against."
              label="Complaint SLA (hours)"
              min="1"
              name="complaintSlaHours"
              required
              type="number"
            />
            <Input
              defaultValue={config.receiptNumberPrefix}
              hint="Leading text on generated receipt numbers."
              label="Receipt prefix"
              name="receiptNumberPrefix"
              required
            />
            <Input
              defaultValue={config.foodReadyCooldownMinutes}
              hint="Blast-radius limit on a shared cook login."
              label="Food-ready cooldown (minutes)"
              min="0"
              name="foodReadyCooldownMinutes"
              required
              type="number"
            />
          </div>

          <fieldset className="grid gap-4 rounded-lg border border-border p-3 sm:grid-cols-3">
            <legend className="px-1 text-xs font-semibold text-muted-foreground">
              Limits hostels tune within
            </legend>
            <Input
              defaultValue={config.maxInsideZoneRadiusMeters}
              hint="Ceiling on a hostel's inside-zone radius."
              label="Max inside radius (m)"
              min="10"
              name="maxInsideZoneRadiusMeters"
              required
              type="number"
            />
            <Input
              defaultValue={config.maxNearbyZoneRadiusMeters}
              hint="Ceiling on a hostel's nearby-zone radius."
              label="Max nearby radius (m)"
              min="20"
              name="maxNearbyZoneRadiusMeters"
              required
              type="number"
            />
            <Input
              defaultValue={config.maxAttendanceRetentionDays}
              hint="Longest a hostel may keep raw attendance logs."
              label="Max attendance retention (days)"
              min="30"
              name="maxAttendanceRetentionDays"
              required
              type="number"
            />
          </fieldset>

          {pendingQrChange ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              <p className="text-foreground">
                A QR change is waiting for the confirm link sent to{" "}
                <span className="font-semibold">{pendingQrChange.sentTo}</span>. It is not live
                until you open that link.
              </p>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-60"
                disabled={busy}
                onClick={() => void cancelQrChange()}
                type="button"
              >
                Cancel change
              </button>
            </div>
          ) : null}

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
              className="inline-flex items-center gap-2 rounded-md bg-role-platform px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-platform disabled:opacity-60"
              disabled={busy}
              type="submit"
            >
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              {busy ? "Saving…" : "Save configuration"}
            </button>
          </div>
        </form>
      ) : null}
    </Panel>
  );
});
