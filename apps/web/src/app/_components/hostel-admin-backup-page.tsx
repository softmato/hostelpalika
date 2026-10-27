"use client";

import { Download, RefreshCw, ShieldCheck } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { PortalPageHeader, SoftBadge } from "@/app/_components/portal-dashboard-ui";
import { LoadingRows, Panel } from "@/app/_components/shared-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { downloadFile } from "@/lib/downloads/downloader";
import { usePortalResource } from "@/lib/portal-query";
import { formatHostelDate } from "@hostel/shared/calendar/bs";
import { Message } from "./core-portal-shared";

const ENDPOINT = "/api/v1/hostel-admin/backup";

type Run = {
  bytes: number | null;
  checked: boolean;
  createdAt: string;
  error: string | null;
  fileName: string | null;
  id: string;
  onDrive: boolean;
  status: "OK" | "FAILED";
};

type Overview = {
  allowed: boolean;
  drive: {
    email: string | null;
    error: string | null;
    ready: boolean;
    status: "NOT_CONNECTED" | "CONNECTED" | "REVOKED" | "QUOTA_FULL" | "ERROR";
  };
  key: { fingerprint: string | null; kitConfirmedAt: string | null } | null;
  runs: Run[];
};

const DRIVE_WORDS: Record<Overview["drive"]["status"], string> = {
  CONNECTED: "Connected",
  ERROR: "Last try failed",
  NOT_CONNECTED: "Not connected",
  QUOTA_FULL: "Drive is full",
  REVOKED: "Access removed",
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kathmandu" });
const megabytes = (bytes: number | null) => (bytes ? `${(bytes / 1_048_576).toFixed(1)} MB` : "—");

/**
 * Backup to the owner's Google Drive (docs/FIELD_REVIEW_2026_10_27.md I6). Owner
 * only — the route refuses wardens. The recovery key is made and kept on the
 * owner's phone, so setting it up and restoring happen in the app; this page
 * shows the facts, connects Drive, and downloads the encrypted files.
 */
export const HostelAdminBackupPageContent = memo(function HostelAdminBackupPageContent() {
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const resource = usePortalResource<Overview>(ENDPOINT, { errorMessage: "Could not load this page." });
  const data = resource.data;
  const lastOk = data?.runs.find((run) => run.status === "OK") ?? null;
  const days = useMemo(() => {
    const groups = new Map<string, Run[]>();

    for (const run of data?.runs ?? []) {
      const day = formatHostelDate(run.createdAt, "");

      groups.set(day, [...(groups.get(day) ?? []), run]);
    }

    return [...groups];
  }, [data?.runs]);

  const connect = useCallback(async () => {
    try {
      const { url } = await browserApi<{ url: string }>(`${ENDPOINT}/drive`, { body: JSON.stringify({ from: "web" }), method: "POST" });

      window.location.assign(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Google could not be opened.");
    }
  }, []);

  const disconnect = useCallback(async () => {
    const confirmed = await confirm({
      actionLabel: "Disconnect",
      description: "Backups stop. Files already in your Drive stay there.",
      title: "Disconnect Google Drive?",
      tone: "destructive",
    });

    if (!confirmed) return;

    try {
      await browserApi(`${ENDPOINT}/drive`, { method: "DELETE" });
      await resource.refreshAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Drive could not be disconnected.");
    }
  }, [confirm, resource]);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const result = await browserApi<{ checked?: boolean; error?: string; ok: boolean }>(ENDPOINT, { method: "POST" });

      setMessage(result.ok ? `Backup made · ${result.checked ? "checked" : "not checked"}` : (result.error ?? "Backup failed."));
      await resource.refreshAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backup failed.");
    } finally {
      setRunning(false);
    }
  }, [resource]);

  const connected = data && ["CONNECTED", "QUOTA_FULL", "ERROR"].includes(data.drive.status);

  return (
    <div className="mx-auto max-w-[880px] space-y-5">
      {confirmDialog}
      <PortalPageHeader description="An encrypted copy of your hostel in your own Google Drive." title="Backup" />
      <Message value={message || resource.message} />
      {resource.state === "loading" ? <LoadingRows /> : null}

      {data && !data.allowed ? (
        <Panel title="Not on your plan">
          <dl className="grid gap-1 text-[13.5px]">
            <Fact label="Google Drive backup" value="Pro plan and up" />
          </dl>
          <div className="mt-4 flex justify-end">
            <a className="inline-flex h-10 items-center rounded-xl bg-brand-teal px-4 text-[13.5px] font-semibold text-white" href="billing">
              Open Billing
            </a>
          </div>
        </Panel>
      ) : null}

      {data?.allowed ? (
        <Panel title="Status">
          <dl className="grid gap-1 text-[13.5px]">
            <Fact
              label="Last backup"
              value={lastOk ? `${formatHostelDate(lastOk.createdAt, "")}, ${time(lastOk.createdAt)} · ${lastOk.checked ? "checked" : "not checked"}` : "None yet"}
            />
            <Fact label="Google Drive" value={data.drive.email ? `${DRIVE_WORDS[data.drive.status]} · ${data.drive.email}` : DRIVE_WORDS[data.drive.status]} />
            <Fact
              label="Recovery key"
              value={!data.key ? "Set it up in the app" : data.key.kitConfirmedAt ? `Kit saved · ${data.key.fingerprint}` : `Kit not saved · ${data.key.fingerprint}`}
            />
            {data.drive.error ? <Fact label="Drive said" value={data.drive.error} /> : null}
          </dl>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {connected ? (
              <Button className="h-10 rounded-xl" onClick={() => void disconnect()} type="button" variant="outline">
                Disconnect Drive
              </Button>
            ) : (
              <Button className="h-10 rounded-xl" disabled={!data.drive.ready} onClick={() => void connect()} type="button" variant="outline">
                {data.drive.status === "REVOKED" ? "Reconnect Google Drive" : "Connect Google Drive"}
              </Button>
            )}
            {connected && data.key ? (
              <Button className="h-10 gap-2 rounded-xl" disabled={running} onClick={() => void runNow()} type="button">
                <RefreshCw className="size-4" />
                {running ? "Backing up…" : "Back up now"}
              </Button>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {days.map(([day, runs]) => (
        <section className="space-y-2" key={day}>
          <h3 className="px-1 text-[13px] font-semibold text-muted-foreground">{day}</h3>
          <div className="divide-y divide-border/60 rounded-2xl border border-border bg-card">
            {runs.map((run) => (
              <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13.5px]" key={run.id}>
                <ShieldCheck className="size-4 text-muted-foreground" />
                <span className="font-medium">{time(run.createdAt)}</span>
                <span className="text-muted-foreground">{megabytes(run.bytes)}</span>
                <SoftBadge tone={run.status === "FAILED" ? "rose" : run.checked ? "green" : "amber"}>
                  {run.status === "FAILED" ? "Failed" : run.checked ? "Checked" : "Not checked"}
                </SoftBadge>
                {run.error ? <span className="basis-full text-muted-foreground">{run.error}</span> : null}
                {run.status === "OK" && run.onDrive ? (
                  <Button
                    className="ml-auto h-9 gap-2 rounded-xl"
                    onClick={() =>
                      void downloadFile({
                        fileName: run.fileName ?? "backup.hpbk",
                        label: "Encrypted backup",
                        mimeType: "application/octet-stream",
                        url: `${ENDPOINT}/runs/${run.id}/file`,
                      })
                    }
                    type="button"
                    variant="outline"
                  >
                    <Download className="size-4" />
                    Download
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
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
