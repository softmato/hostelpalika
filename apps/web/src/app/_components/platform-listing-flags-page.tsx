"use client";

import React, { useCallback, useState, useMemo, type FormEvent } from "react";
import { AlertOctagon, CheckCircle2, Flag, ScanSearch, XCircle } from "@/components/icons";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { EmptyState, Input, Panel } from "@/app/_components/shared-ui";
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
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import {
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SoftBadge,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { FactChip, ShareBar } from "./platform-page-ui";
import { Message, field, type ListingFlag } from "./portal-shared";

export const PlatformListingFlagsPageContent = React.memo(
  function PlatformListingFlagsPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [checking, setChecking] = useState(false);
    const [statusFilter, setStatusFilter] = useState("");
    const invalidate = useInvalidateResources();
    const flagsResource = usePortalResource<{ flags: ListingFlag[] }>(
      platformEndpoints.listingFlags,
      { errorMessage: "Could not load flags." },
    );

    const flags = useMemo(() => flagsResource.data?.flags ?? [], [flagsResource.data]);
    const message = actionMessage || flagsResource.message;

    const runCheck = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const hostelId = field(form, "hostelId");
        const currentForm = event.currentTarget;

        try {
          await browserApi(`${platformEndpoints.hostel(hostelId)}/run-duplicate-check`, {
            body: JSON.stringify({}),
            method: "POST",
          });
          setActionMessage("Duplicate check completed.");
          currentForm.reset();
          setChecking(false);
          invalidate(platformEndpoints.listingFlags);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not run check.",
          );
        }
      },
      [invalidate],
    );

    const resolve = useCallback(
      async (flagId: string, status: "DISMISSED" | "RESOLVED") => {
        const resolutionNote = window.prompt("Resolution note")?.trim();

        if (!resolutionNote) {
          return;
        }

        try {
          await browserApi(`${platformEndpoints.listingFlag(flagId)}/resolve`, {
            body: JSON.stringify({ resolutionNote, status }),
            method: "PATCH",
          });
          invalidate(platformEndpoints.listingFlags);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not resolve flag.",
          );
        }
      },
      [invalidate],
    );

    const counts = useMemo(() => {
      const by = (status: string) =>
        flags.filter((flag) => flag.status === status).length;
      return {
        dismissed: by("DISMISSED"),
        highRisk: flags.filter((flag) => flag.riskLevel?.toUpperCase() === "HIGH").length,
        open: by("OPEN"),
        resolved: by("RESOLVED"),
      };
    }, [flags]);

    const shown = statusFilter ? flags.filter((flag) => flag.status === statusFilter) : flags;
    const pick = (status: string) => setStatusFilter((current) => (current === status ? "" : status));

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PortalPageHeader
          actions={
            <RoleButton onClick={() => setChecking(true)} tone="team" type="button">
              <ScanSearch className="size-4" />
              Run duplicate check
            </RoleButton>
          }
          description="Duplicate and ghost listings, caught and settled."
          title="Abuse Flags"
        />
        <Message value={message} />

        {/* Each tile narrows the list to what it counts; a second click clears it. */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            active={statusFilter === "OPEN"}
            icon={Flag}
            label="Open"
            onClick={() => pick("OPEN")}
            tone={counts.open > 0 ? "amber" : "teal"}
            value={counts.open}
          />
          <MetricCard
            icon={AlertOctagon}
            label="High risk"
            tone={counts.highRisk > 0 ? "rose" : "teal"}
            value={counts.highRisk}
          />
          <MetricCard
            active={statusFilter === "RESOLVED"}
            icon={CheckCircle2}
            label="Resolved"
            onClick={() => pick("RESOLVED")}
            value={counts.resolved}
          />
          <MetricCard
            active={statusFilter === "DISMISSED"}
            icon={XCircle}
            label="Dismissed"
            onClick={() => pick("DISMISSED")}
            tone="slate"
            value={counts.dismissed}
          />
        </div>

        {flags.length > 0 ? (
          <Panel>
            <ShareBar label="flags settled" part={counts.resolved + counts.dismissed} total={flags.length} />
          </Panel>
        ) : null}

        <Panel title={statusFilter ? `${statusFilter.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())} flags` : "Flags"}>
          {shown.length === 0 ? <EmptyState label="No listing flags." /> : null}
          <div className="grid gap-3 lg:grid-cols-2">
            {shown.map((flag) => (
              <article
                className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                key={flag.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[13.5px] font-semibold text-foreground">{flag.reason}</p>
                  <div className="flex shrink-0 gap-1.5">
                    <SoftBadge tone={statusToneFromLabel(flag.riskLevel)}>{flag.riskLevel}</SoftBadge>
                    <SoftBadge tone={statusToneFromLabel(flag.status)}>{flag.status}</SoftBadge>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="business">{`Hostel ${flag.hostelId}`}</FactChip>
                  <FactChip glyph="copy" tone={flag.matchedHostelIds.length > 0 ? "amber" : "neutral"}>
                    {`${flag.matchedHostelIds.length} matches`}
                  </FactChip>
                  {flag.signals.map((signal) => (
                    <FactChip key={signal}>{signal}</FactChip>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => void resolve(flag.id, "RESOLVED")} size="sm" type="button" variant="outline">
                    <CheckCircle2 className="size-3.5" />
                    Resolve
                  </Button>
                  <Button onClick={() => void resolve(flag.id, "DISMISSED")} size="sm" type="button" variant="ghost">
                    <XCircle className="size-3.5" />
                    Dismiss
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </Panel>

        <Dialog onOpenChange={setChecking} open={checking}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Run a duplicate check</DialogTitle>
              <DialogDescription>New matches show up in the list as open flags.</DialogDescription>
            </DialogHeader>
            <BusyForm className="grid gap-3" onSubmit={runCheck}>
              <Input label="Hostel id" name="hostelId" required />
              <DialogFooter>
                <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">Run check</SubmitButton>
              </DialogFooter>
            </BusyForm>
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);
