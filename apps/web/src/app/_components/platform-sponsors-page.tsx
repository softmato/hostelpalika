"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

import {
  ChevronDown,
  ChevronUp,
  Eye,
  Megaphone,
  MousePointerClick,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  Trash2,
} from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  MetricCard,
  PortalPageHeader,
  RoleButton,
} from "@/app/_components/portal-dashboard-ui";
import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
} from "@/app/_components/shared-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";
import { FactChip, ShareBar } from "./platform-page-ui";

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
  const [formOpen, setFormOpen] = useState(false);
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
        setFormOpen(false);
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

  const openForm = (sponsor: Sponsor | null) => {
    setEditing(sponsor);
    setFormOpen(true);
  };

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        actions={
          <RoleButton onClick={() => openForm(null)} tone="team" type="button">
            <Plus className="size-4" />
            New sponsor
          </RoleButton>
        }
        description="Paid cards in the community sidebar. Higher priority shows first."
        title="Sponsors"
      />
      <Message value={message || resource.message} />

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Megaphone} label="Live now" value={summary.live} />
          <MetricCard icon={Eye} label="Sponsors" value={summary.total} />
          <MetricCard
            icon={MousePointerClick}
            label="Clicks, all time"
            value={sponsors.reduce((sum, sponsor) => sum + sponsor.clickCount, 0)}
          />
        </div>
      ) : null}

      <Panel
        action={
          <FilterButton active={filter === "all" ? 0 : 1} onClear={() => setFilter("all")}>
            <FilterChoice
              label="Status"
              onChange={setFilter}
              options={[
                { label: "All", value: "all" },
                { label: "Live", value: "active" },
                { label: "Paused", value: "inactive" },
              ]}
              value={filter}
            />
          </FilterButton>
        }
        title="Sponsors"
      >
        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "ready" && sponsors.length === 0 ? (
          <EmptyState label="No sponsors yet. Add one from the header." />
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {sponsors.map((sponsor) => (
            <article
              className="group overflow-hidden rounded-2xl border border-border/70 bg-card transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
              key={sponsor.id}
            >
              {/* The sponsor's own banner, or its name on its own colour — this
                  is their brand on show, not ours. */}
              <div className="relative flex h-28 items-center justify-center overflow-hidden" style={{ backgroundColor: sponsor.accentColor }}>
                {sponsor.imageUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img alt="" className="size-full object-cover" src={sponsor.imageUrl} />
                ) : (
                  <span className="px-4 text-center font-heading text-[16px] font-bold text-white">{sponsor.name}</span>
                )}
                <span className="absolute left-2.5 top-2.5 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                  {sponsor.isActive ? "Live" : "Paused"}
                </span>
                <div className="absolute bottom-2.5 right-2.5 flex items-center rounded-full bg-black/60 text-white backdrop-blur">
                  <button
                    aria-label="Lower priority"
                    className="rounded-full p-1 transition hover:bg-white/15"
                    onClick={() => void changePriority(sponsor, -1)}
                    type="button"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                  <span className="min-w-5 text-center text-[11px] font-bold" title="Priority">
                    {sponsor.priority}
                  </span>
                  <button
                    aria-label="Raise priority"
                    className="rounded-full p-1 transition hover:bg-white/15"
                    onClick={() => void changePriority(sponsor, 1)}
                    type="button"
                  >
                    <ChevronUp className="size-3.5" />
                  </button>
                </div>
              </div>

              <div className="space-y-3 p-4">
                <div className="min-w-0">
                  <h3 className="truncate font-heading text-[15px] font-bold tracking-tight text-foreground">{sponsor.name}</h3>
                  {sponsor.subtitle ? <p className="truncate text-[12.5px] text-muted-foreground">{sponsor.subtitle}</p> : null}
                </div>

                <ShareBar label="views clicked" part={sponsor.clickCount} total={sponsor.impressionCount} />

                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="pricetag">{sponsor.kind.charAt(0) + sponsor.kind.slice(1).toLowerCase()}</FactChip>
                  {sponsor.highlight ? <FactChip glyph="sparkles">{sponsor.highlight}</FactChip> : null}
                  {sponsor.startsAt || sponsor.endsAt ? (
                    <FactChip glyph="calendar">
                      {`${sponsor.startsAt ? formatHostelDate(sponsor.startsAt) : "—"} → ${
                        sponsor.endsAt ? formatHostelDate(sponsor.endsAt) : "—"
                      }`}
                    </FactChip>
                  ) : null}
                </div>

                <div className="flex gap-2">
                  <Button onClick={() => openForm(sponsor)} size="sm" type="button" variant="outline">
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                  <Button onClick={() => void toggleActive(sponsor)} size="sm" type="button" variant="ghost">
                    {sponsor.isActive ? <PauseCircle className="size-3.5" /> : <PlayCircle className="size-3.5" />}
                    {sponsor.isActive ? "Pause" : "Make live"}
                  </Button>
                  <Button
                    className="ml-auto text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(sponsor)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </Panel>

      <Dialog onOpenChange={setFormOpen} open={formOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "New sponsor"}</DialogTitle>
            <DialogDescription>A /path link stays on site; http(s) opens a new tab.</DialogDescription>
          </DialogHeader>
          {/* Keyed on the sponsor so switching which one is being edited
              remounts the fields with that sponsor's values. */}
          <BusyForm className="grid gap-3" key={editing?.id ?? "new"} onSubmit={save}>
            <div className="grid gap-3 sm:grid-cols-2">
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
              <Input defaultValue={editing?.subtitle} label="Subtitle" name="subtitle" placeholder="Dillibazar, Kathmandu" />
              <Input
                defaultValue={editing?.highlight}
                label="Highlight"
                name="highlight"
                placeholder="Admissions open"
              />
            </div>
            <Input
              defaultValue={editing?.imageUrl}
              hint="Blank shows the name on the accent colour."
              label="Image URL"
              name="imageUrl"
              placeholder="https://…"
            />
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <Input defaultValue={editing?.linkUrl} label="Link" name="linkUrl" placeholder="https://college.edu.np" />
              <Input defaultValue={editing?.accentColor ?? "#0a8a4b"} label="Accent" name="accentColor" type="color" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input defaultValue={editing?.ctaLabel ?? "View"} label="Button label" name="ctaLabel" />
              <Input
                defaultValue={editing?.priority ?? 0}
                hint="Higher shows first."
                label="Priority"
                name="priority"
                type="number"
              />
              <Input
                defaultValue={editing?.startsAt?.slice(0, 10)}
                hint="Blank: as soon as it is live."
                label="Starts"
                name="startsAt"
                type="date"
              />
              <Input
                defaultValue={editing?.endsAt?.slice(0, 10)}
                hint="Blank: until paused."
                label="Ends"
                name="endsAt"
                type="date"
              />
            </div>
            <DialogFooter>
              <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">
                {editing ? "Save changes" : "Create sponsor"}
              </SubmitButton>
            </DialogFooter>
          </BusyForm>
        </DialogContent>
      </Dialog>
    </div>
  );
});
