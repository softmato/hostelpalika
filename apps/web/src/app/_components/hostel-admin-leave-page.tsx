"use client";

import { CircleAlert, Clock, DoorOpen } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { PortalPageHeader, SoftBadge } from "@/app/_components/portal-dashboard-ui";
import { LoadingRows, Panel, Select, TextArea } from "@/app/_components/shared-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { formatHostelDate } from "@hostel/shared/calendar/bs";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { Message } from "./core-portal-shared";

const ENDPOINT = "/api/v1/hostel-admin/leave";

type Overview = {
  blockers: { code: string; message: string }[];
  branches: { id: string; name: string }[];
  canLeave: boolean;
  hold: { max: number; min: number };
  hostel: { id: string; isBranch: boolean; name: string };
  request: {
    holdDays: number;
    reason: string;
    requestedAt: string;
  } | null;
};

/**
 * Leave the platform (docs/HOSTEL_LEAVE_PLATFORM.md). The owner only — the
 * route refuses wardens. Bills must be cleared before the form opens; our team
 * approves, emails the data and holds it for the days chosen here.
 */
export const HostelAdminLeavePageContent = memo(function HostelAdminLeavePageContent() {
  const [message, setMessage] = useState("");
  const { confirm, confirmDialog } = useConfirm();
  const resource = usePortalResource<Overview>(ENDPOINT, { errorMessage: "Could not load this page." });
  const data = resource.data;

  const send = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const reason = String(form.get("reason") ?? "").trim();
      const holdDays = Number(form.get("holdDays"));

      if (reason.length < 3) {
        setMessage("Tell us why you are leaving.");
        return;
      }

      const confirmed = await confirm({
        actionLabel: "Send request",
        cancelLabel: "Keep my hostel",
        description: `Once we approve, ${data?.hostel.name ?? "your hostel"} goes off ${PLATFORM_NAME} and its portal closes. We hold your data for ${holdDays} days, then erase it.`,
        pin: true,
        title: `Leave ${PLATFORM_NAME}?`,
        tone: "destructive",
      });

      if (!confirmed) return;

      try {
        await browserApi(ENDPOINT, { body: JSON.stringify({ confirm: true, holdDays, reason }), method: "POST" });
        setMessage("Request sent. We emailed you a copy.");
        await resource.refreshAsync();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The request could not be sent.");
      }
    },
    [confirm, data, resource],
  );

  const cancel = useCallback(async () => {
    try {
      await browserApi(ENDPOINT, { method: "DELETE" });
      setMessage("Request cancelled. Your hostel stays.");
      await resource.refreshAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The request could not be cancelled.");
    }
  }, [resource]);

  return (
    <div className="mx-auto max-w-[880px] space-y-5">
      {confirmDialog}
      <PortalPageHeader description={`Take your hostel off ${PLATFORM_NAME}.`} title={`Leave ${PLATFORM_NAME}`} />
      <Message value={message || resource.message} />
      {resource.state === "loading" ? <LoadingRows /> : null}

      {data?.request ? (
        <Panel title="Request sent">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              <Clock className="size-5" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <SoftBadge tone="amber">Waiting for our team</SoftBadge>
              <dl className="mt-2 grid gap-1 text-[13.5px]">
                <Fact label="Sent" value={formatHostelDate(data.request.requestedAt, "")} />
                <Fact label="Hold data for" value={`${data.request.holdDays} days after approval`} />
                <Fact label="Reason" value={data.request.reason} />
              </dl>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button className="h-10 rounded-xl" onClick={() => void cancel()} type="button" variant="outline">
              Cancel request
            </Button>
          </div>
        </Panel>
      ) : null}

      {data && !data.request && data.blockers.length > 0 ? (
        <Panel title="Clear these first">
          <ul className="space-y-2">
            {data.blockers.map((blocker) => (
              <li className="flex items-start gap-2.5 rounded-xl bg-destructive/10 px-3 py-2.5 text-[13.5px] text-destructive" key={blocker.code}>
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {blocker.message}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end">
            <a className="inline-flex h-10 items-center rounded-xl bg-brand-teal px-4 text-[13.5px] font-semibold text-white" href="billing">
              Open Billing
            </a>
          </div>
        </Panel>
      ) : null}

      {data?.canLeave ? (
        <>
          <Panel title="What happens">
            <dl className="grid gap-1 text-[13.5px]">
              <Fact label="Your portal" value="Closes on approval" />
              <Fact label="Residents and staff" value="Lose access" />
              <Fact label="Your data" value="Emailed to you, from your first day" />
              <Fact label="Changed your mind" value="Claim it back before the hold ends" />
              <Fact label="After the hold" value="Erased for good" />
              {data.branches.length > 0 ? (
                <Fact label="Branches leaving too" value={data.branches.map((branch) => branch.name).join(", ")} />
              ) : null}
            </dl>
          </Panel>

          <Panel title="Your request">
            <BusyForm className="grid gap-4" onSubmit={send}>
              <TextArea label="Why are you leaving?" name="reason" placeholder="Closing the hostel, moving to another app…" />
              <Select defaultValue={String(data.hold.min)} label="Hold my data for" name="holdDays">
                {Array.from({ length: data.hold.max - data.hold.min + 1 }, (_, index) => data.hold.min + index).map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </Select>
              <div className="flex justify-end">
                <SubmitButton className="h-10 gap-2 rounded-xl px-5" variant="destructive">
                  <DoorOpen className="size-4" />
                  Send request
                </SubmitButton>
              </div>
            </BusyForm>
          </Panel>
        </>
      ) : null}

    </div>
  );
});

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-b border-border/60 py-2 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </div>
  );
}
