"use client";

import { Megaphone } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
  StatusBadge,
  TextArea,
} from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { field, optionalField } from "./portal-shared";

type Campaign = {
  body: string;
  id: string;
  priority: string;
  recipientCount: number;
  scheduledFor?: string;
  sentAt?: string;
  stats: { delivered: number; read: number; sent: number };
  status: string;
  title: string;
};

type Hostel = { id: string; name: string };

const BROADCAST_ENDPOINT = "/api/v1/platform/notifications";
const HOSTELS_ENDPOINT = "/api/v1/platform/hostels";

function shortDateTime(value?: string) {
  return value
    ? new Date(value).toLocaleString("en", {
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
      })
    : "—";
}

/**
 * Superadmin platform-wide announcements (PHASES.md §5.1). Lives on Settings
 * rather than its own tab — the platform portal deliberately has no personal
 * notification feed, and this is an outbound action, not an inbox.
 */
export const PlatformBroadcastPanel = memo(function PlatformBroadcastPanel() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState("ALL");
  const [hostelIds, setHostelIds] = useState<string[]>([]);

  const campaignsResource = usePortalResource<{ campaigns: Campaign[] }>(
    BROADCAST_ENDPOINT,
    { errorMessage: "Could not load platform announcements." },
  );
  const hostelsResource = usePortalResource<{ hostels: Hostel[] }>(HOSTELS_ENDPOINT, {
    errorMessage: "",
  });

  const campaigns = campaignsResource.data?.campaigns ?? [];
  const hostels = hostelsResource.data?.hostels ?? [];

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const scheduledFor = optionalField(form, "scheduledFor");

      setBusy(true);
      setMessage("");

      try {
        const result = await browserApi<{ campaign: Campaign }>(BROADCAST_ENDPOINT, {
          body: JSON.stringify({
            body: field(form, "body"),
            category: field(form, "category"),
            // An empty list means every hostel on the platform.
            hostelIds: scope === "SPECIFIC" ? hostelIds : [],
            priority: field(form, "priority"),
            scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
            title: field(form, "title"),
          }),
          method: "POST",
        });

        setMessage(
          result.campaign.status === "SCHEDULED"
            ? `Scheduled for ${shortDateTime(result.campaign.scheduledFor)}.`
            : `Sent to ${result.campaign.recipientCount} resident(s).`,
        );
        formElement.reset();
        setScope("ALL");
        setHostelIds([]);
        await campaignsResource.refreshAsync();
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Could not send the announcement.",
        );
      } finally {
        setBusy(false);
      }
    },
    [campaignsResource, hostelIds, scope],
  );

  return (
    <Panel title="Platform announcements">
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Title" name="title" required />
          <Input defaultValue="PLATFORM" label="Category" name="category" required />
        </div>
        <TextArea label="Message" name="body" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Select defaultValue="NORMAL" label="Priority" name="priority">
            <option value="LOW">Low</option>
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </Select>
          <Select
            label="Send to"
            name="scope"
            onChange={(event) => setScope(event.target.value)}
            value={scope}
          >
            <option value="ALL">Every hostel</option>
            <option value="SPECIFIC">Selected hostels</option>
          </Select>
          <Input
            hint="Leave empty to send immediately."
            label="Schedule for"
            name="scheduledFor"
            type="datetime-local"
          />
        </div>

        {scope === "SPECIFIC" ? (
          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-semibold text-muted-foreground">
              Hostels ({hostelIds.length} selected)
            </legend>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {hostels.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">No hostels to pick.</p>
              ) : (
                hostels.map((hostel) => (
                  <label
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                    key={hostel.id}
                  >
                    <input
                      checked={hostelIds.includes(hostel.id)}
                      onChange={(event) =>
                        setHostelIds((current) =>
                          event.target.checked
                            ? [...current, hostel.id]
                            : current.filter((id) => id !== hostel.id),
                        )
                      }
                      type="checkbox"
                    />
                    <span>{hostel.name}</span>
                  </label>
                ))
              )}
            </div>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {message}
          </p>
          <button
            className="inline-flex items-center gap-2 rounded-md bg-role-platform px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-platform disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            <Megaphone aria-hidden="true" className="size-4" />
            {busy ? "Sending…" : "Send announcement"}
          </button>
        </div>
      </form>

      <div className="mt-5 border-t border-border pt-4">
        {campaignsResource.state === "loading" ? <LoadingRows /> : null}
        {campaignsResource.state !== "loading" && campaigns.length === 0 ? (
          <EmptyState label="No platform announcements sent yet." />
        ) : null}
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <div className="rounded-lg border border-border p-3.5" key={campaign.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{campaign.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {campaign.status === "SCHEDULED"
                      ? `scheduled ${shortDateTime(campaign.scheduledFor)}`
                      : `sent ${shortDateTime(campaign.sentAt)}`}{" "}
                    · {campaign.stats.read} of {campaign.stats.sent} read
                  </p>
                </div>
                <StatusBadge>{campaign.status}</StatusBadge>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
});
