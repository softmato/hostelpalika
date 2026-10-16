"use client";

import { Eye, MousePointerClick, Megaphone } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  MetricCard,
  PortalPageHeader,
  SoftBadge,
  TabBar,
} from "@/app/_components/portal-dashboard-ui";
import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
} from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

const SPONSORS_ENDPOINT = "/api/v1/platform/sponsors";

type Sponsor = {
  accentColor: string;
  clickCount: number;
  ctaLabel: string;
  endsAt: string | null;
  highlight: string;
  id: string;
  imageAssetId: string;
  imageUrl: string;
  impressionCount: number;
  isActive: boolean;
  kind: "COLLEGE" | "HOSTEL" | "BUSINESS" | "OTHER";
  linkUrl: string;
  name: string;
  priority: number;
  startsAt: string | null;
  subtitle: string;
};

type SponsorsPayload = {
  sponsors: Sponsor[];
  summary: { live: number; total: number };
};

const KINDS = ["COLLEGE", "HOSTEL", "BUSINESS", "OTHER"] as const;

function text(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}

/** Empty date inputs must be omitted, not sent as "" — the schema coerces dates. */
function optionalDate(form: FormData, key: string) {
  const value = text(form, key);

  return value ? { [key]: value } : {};
}

/**
 * Paid placements in the community's right rail — colleges, hostels, local
 * businesses. Superadmin only: selling a slot is a commercial decision, which
 * is why a PLATFORM_MODERATOR cannot reach this screen or its API.
 *
 * Ordering is by `priority`, highest first, so promoting one sponsor never
 * means renumbering the rest.
 */
export const PlatformSponsorsPageContent = memo(function PlatformSponsorsPageContent() {
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Sponsor | null>(null);
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();

  const url = `${SPONSORS_ENDPOINT}?status=${filter}`;
  const resource = usePortalResource<SponsorsPayload>(url, {
    errorMessage: "Could not load sponsors.",
  });

  const sponsors = useMemo(() => resource.data?.sponsors ?? [], [resource.data]);
  const summary = resource.data?.summary;

  const refresh = useCallback(() => {
    // Every status tab shows the same rows through a different filter, so one
    // save has to clear all three rather than only the tab in front of us.
    for (const status of ["all", "active", "inactive"]) {
      invalidate(`${SPONSORS_ENDPOINT}?status=${status}`);
    }
  }, [invalidate]);

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const payload = {
        accentColor: text(form, "accentColor") || "#0a8a4b",
        ctaLabel: text(form, "ctaLabel") || "View",
        highlight: text(form, "highlight"),
        imageUrl: text(form, "imageUrl"),
        kind: text(form, "kind"),
        linkUrl: text(form, "linkUrl"),
        name: text(form, "name"),
        priority: Number(text(form, "priority") || 0),
        subtitle: text(form, "subtitle"),
        ...optionalDate(form, "startsAt"),
        ...optionalDate(form, "endsAt"),
      };

      try {
        await browserApi(editing ? `${SPONSORS_ENDPOINT}/${editing.id}` : SPONSORS_ENDPOINT, {
          body: JSON.stringify(payload),
          method: editing ? "PATCH" : "POST",
        });
        formElement.reset();
        setEditing(null);
        setMessage(editing ? "Sponsor updated." : "Sponsor created.");
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not save the sponsor.");
      }
    },
    [editing, refresh],
  );

  const toggleActive = useCallback(
    async (sponsor: Sponsor) => {
      try {
        await browserApi(`${SPONSORS_ENDPOINT}/${sponsor.id}`, {
          body: JSON.stringify({ isActive: !sponsor.isActive }),
          method: "PATCH",
        });
        setMessage(sponsor.isActive ? "Sponsor paused." : "Sponsor is live.");
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not update.");
      }
    },
    [refresh],
  );

  const changePriority = useCallback(
    async (sponsor: Sponsor, delta: number) => {
      try {
        await browserApi(`${SPONSORS_ENDPOINT}/${sponsor.id}`, {
          body: JSON.stringify({ priority: sponsor.priority + delta }),
          method: "PATCH",
        });
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not reorder.");
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (sponsor: Sponsor) => {
      const confirmed = await confirm({
        actionLabel: "Delete sponsor",
        description: `"${sponsor.name}" comes out of the community rail immediately. Its impression and click totals are deleted with it.`,
        title: "Delete this sponsor?",
        tone: "destructive",
      });

      if (!confirmed) {
        return;
      }

      try {
        await browserApi(`${SPONSORS_ENDPOINT}/${sponsor.id}`, { method: "DELETE" });
        setMessage("Sponsor deleted.");
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not delete.");
      }
    },
    [confirm, refresh],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        description="Paid placements in the community sidebar — colleges, hostels and local businesses. Higher priority shows first."
        title="Sponsors"
      />
      <Message value={message || resource.message} />

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Megaphone} label="Live now" tone="green" value={summary.live} />
          <MetricCard icon={Eye} label="Total sponsors" value={summary.total} />
          <MetricCard
            icon={MousePointerClick}
            label="Clicks (all time)"
            tone="amber"
            value={sponsors.reduce((sum, sponsor) => sum + sponsor.clickCount, 0)}
          />
        </div>
      ) : null}

      <TabBar
        onChange={(key) => setFilter(key as typeof filter)}
        tabs={[
          { key: "all", label: "All" },
          { key: "active", label: "Active" },
          { key: "inactive", label: "Paused" },
        ]}
        tone="platform"
        value={filter}
      />

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Panel title="Sponsors">
          {resource.state === "loading" ? <LoadingRows /> : null}
          {resource.state === "ready" && sponsors.length === 0 ? (
            <EmptyState label="No sponsors yet. Create one on the right." />
          ) : null}

          <div className="space-y-3">
            {sponsors.map((sponsor) => (
              <div className="rounded-lg border border-border p-4" key={sponsor.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 gap-3">
                    <span
                      className="size-10 shrink-0 rounded-lg"
                      style={{ backgroundColor: sponsor.accentColor }}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">
                        {sponsor.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {sponsor.kind}
                        {sponsor.subtitle ? ` · ${sponsor.subtitle}` : ""}
                        {sponsor.highlight ? ` · ${sponsor.highlight}` : ""}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {sponsor.impressionCount} impressions · {sponsor.clickCount} clicks
                        {sponsor.startsAt || sponsor.endsAt
                          ? ` · ${sponsor.startsAt ? new Date(sponsor.startsAt).toLocaleDateString() : "—"} → ${
                              sponsor.endsAt
                                ? new Date(sponsor.endsAt).toLocaleDateString()
                                : "—"
                            }`
                          : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <SoftBadge tone={sponsor.isActive ? "green" : "slate"}>
                      {sponsor.isActive ? "Live" : "Paused"}
                    </SoftBadge>
                    <div className="flex items-center gap-1 rounded-md border border-border">
                      <button
                        aria-label="Lower priority"
                        className="px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
                        onClick={() => void changePriority(sponsor, -1)}
                        type="button"
                      >
                        ▼
                      </button>
                      <span className="min-w-6 text-center text-xs font-bold text-foreground">
                        {sponsor.priority}
                      </span>
                      <button
                        aria-label="Raise priority"
                        className="px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
                        onClick={() => void changePriority(sponsor, 1)}
                        type="button"
                      >
                        ▲
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                    onClick={() => setEditing(sponsor)}
                    type="button"
                  >
                    Edit
                  </button>
                  <button
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                    onClick={() => void toggleActive(sponsor)}
                    type="button"
                  >
                    {sponsor.isActive ? "Pause" : "Make live"}
                  </button>
                  <button
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/10"
                    onClick={() => void remove(sponsor)}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={editing ? `Edit ${editing.name}` : "New sponsor"}>
          {/* Keyed on the sponsor so switching which one is being edited
              remounts the fields with that sponsor's values, rather than
              leaving the previous one's text in place. */}
          <BusyForm className="grid gap-3" key={editing?.id ?? "new"} onSubmit={save}>
            <Input
              defaultValue={editing?.name}
              label="Name"
              name="name"
              placeholder="Trinity International College"
              required
            />
            <Select defaultValue={editing?.kind ?? "COLLEGE"} label="Type" name="kind">
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.charAt(0) + kind.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
            <Input
              defaultValue={editing?.subtitle}
              label="Subtitle"
              name="subtitle"
              placeholder="Dillibazar, Kathmandu"
            />
            <Input
              defaultValue={editing?.highlight}
              hint="The bold line above the button — a price, a deadline, an offer."
              label="Highlight"
              name="highlight"
              placeholder="Admissions open"
            />
            <Input
              defaultValue={editing?.imageUrl}
              hint="Banner image. Leave blank to show the name on the accent colour."
              label="Image URL"
              name="imageUrl"
              placeholder="https://…"
            />
            <Input
              defaultValue={editing?.accentColor ?? "#0a8a4b"}
              label="Accent colour"
              name="accentColor"
              type="color"
            />
            <Input
              defaultValue={editing?.linkUrl}
              hint="Where the card goes. A /path stays on site; http(s) opens a new tab."
              label="Link"
              name="linkUrl"
              placeholder="https://college.edu.np"
            />
            <Input
              defaultValue={editing?.ctaLabel ?? "View"}
              label="Button label"
              name="ctaLabel"
            />
            <Input
              defaultValue={editing?.priority ?? 0}
              hint="Higher shows first. Ties break by newest."
              label="Priority"
              name="priority"
              type="number"
            />
            <Input
              defaultValue={editing?.startsAt?.slice(0, 10)}
              hint="Optional. Blank means it runs as soon as it is live."
              label="Starts"
              name="startsAt"
              type="date"
            />
            <Input
              defaultValue={editing?.endsAt?.slice(0, 10)}
              hint="Optional. Blank means it runs until paused."
              label="Ends"
              name="endsAt"
              type="date"
            />

            <div className="flex gap-2">
              <SubmitButton className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-role-platform text-sm font-semibold text-white">
                {editing ? "Save changes" : "Create sponsor"}
              </SubmitButton>
              {editing ? (
                <button
                  className="h-11 rounded-md border border-border px-4 text-sm font-semibold text-foreground"
                  onClick={() => setEditing(null)}
                  type="button"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </BusyForm>
        </Panel>
      </div>
    </div>
  );
});
