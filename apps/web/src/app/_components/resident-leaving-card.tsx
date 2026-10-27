"use client";

import { useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";

type LeavingNotice = {
  earliest: string;
  leavingOn: string | null;
  leavingOnLabel: string | null;
  noticeDays: number;
  reason: string | null;
};

const ENDPOINT = "/api/v1/resident/leaving";
const INPUT = "h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary";

/**
 * "I'm leaving" (field review E5): the resident names the day, no approval,
 * and the hostel is told at once. Rent stops on it; change or cancel until then.
 */
export function ResidentLeavingCard() {
  const resource = usePortalResource<LeavingNotice>(ENDPOINT);
  const data = resource.data;
  const { confirm, confirmDialog } = useConfirm();
  const [date, setDate] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (!data) return null;

  const day = date ?? data.leavingOn ?? data.earliest;
  const why = reason ?? data.reason ?? "";

  const run = async (init: RequestInit, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await browserApi(ENDPOINT, init);
      setDate(null);
      setReason(null);
      setMessage(done);
      await resource.refreshAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      {confirmDialog}
      <div>
        <h3 className="text-sm font-semibold">Moving out</h3>
        <p className="text-xs text-muted-foreground">
          {data.leavingOn
            ? `You leave on ${data.leavingOnLabel ?? data.leavingOn}. Rent stops that day.`
            : data.noticeDays > 0
              ? `This hostel needs ${data.noticeDays} days' notice.`
              : "Tell the hostel the day you leave. Rent stops that day."}
        </p>
      </div>
      <input
        className={INPUT}
        min={data.earliest}
        onChange={(event) => setDate(event.target.value)}
        type="date"
        value={day}
      />
      <input
        className={INPUT}
        maxLength={300}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional)"
        value={why}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || day < data.earliest}
          onClick={() =>
            void run(
              {
                body: JSON.stringify({ date: day, reason: why.trim() || undefined }),
                headers: { "Content-Type": "application/json" },
                method: "PUT",
              },
              "The hostel has been told.",
            )
          }
          type="button"
        >
          {data.leavingOn ? "Change leaving day" : "I'm leaving"}
        </Button>
        {data.leavingOn ? (
          <Button
            disabled={busy}
            onClick={async () => {
              if (
                !(await confirm({
                  actionLabel: "I'm staying",
                  description: "Your leaving day is removed and the hostel is told.",
                  title: "Cancel your notice?",
                }))
              )
                return;
              await run({ method: "DELETE" }, "Notice cancelled.");
            }}
            type="button"
            variant="outline"
          >
            Cancel — I&apos;m staying
          </Button>
        ) : null}
      </div>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
