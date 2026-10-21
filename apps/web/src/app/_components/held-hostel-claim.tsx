"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { DoorOpen, Download, FileText, RotateCcw } from "@/components/icons";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { refreshSession } from "@/lib/auth-refresh";
import { browserApi } from "@/lib/browser-api";
import { useSessionStore } from "@/stores/session-store";

/**
 * Claiming back a hostel taken off the platform (docs/HOSTEL_LEAVE_PLATFORM.md):
 * the live countdown, the claim itself, and the three places they show — the
 * deleted portal's own address, the header's Claim hostel button, `/hostel-leave`.
 */

export type HeldHostel = {
  /** Still inside the hold. After it only the files remain, for 30 days from leaving. */
  canClaim: boolean;
  filesUntil: string;
  holdDays: number;
  holdUntil: string;
  hostelName: string;
  requestId: string;
};

const ENDPOINT = "/api/v1/account/hostel-leave";
const DAY_MS = 86_400_000;

/** This account's held hostels — only asked with a session, `null` until known. */
export function useHeldHostels() {
  const sessionResolved = useSessionStore((state) => state.status === "resolved");
  const sessionUser = useSessionStore((state) => state.user);
  const [held, setHeld] = useState<HeldHostel[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // A signed-out 401 would bounce the tab to /login, so never ask without one.
    if (!sessionResolved || !sessionUser) return;

    let active = true;

    void browserApi<{ hostels: HeldHostel[] }>(ENDPOINT).then(
      (data) => active && setHeld(data.hostels),
      (cause) => active && setError(cause instanceof Error ? cause.message : "Could not load."),
    );

    return () => {
      active = false;
    };
  }, [sessionResolved, sessionUser]);

  return { error, held, signedOut: sessionResolved && !sessionUser };
}

/** Confirm, claim, refresh the token (the portal role came back), open the portal. */
export function useClaimHostel() {
  const { confirm, confirmDialog } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const claim = useCallback(
    async (row: HeldHostel) => {
      const confirmed = await confirm({
        actionLabel: "Claim it back",
        description: `${row.hostelName} comes back on ${PLATFORM_NAME} exactly as you left it — portal, residents and data.`,
        title: `Claim ${row.hostelName} back?`,
      });

      if (!confirmed) return;

      setBusyId(row.requestId);
      setError("");

      try {
        await browserApi(ENDPOINT, { body: JSON.stringify({ requestId: row.requestId }), method: "POST" });
        await refreshSession().catch(() => false);
        window.location.assign("/hostel-admin/dashboard");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not claim it back.");
        setBusyId(null);
      }
    },
    [confirm],
  );

  return { busyId, claim, confirmDialog, error };
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);

  return now;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The time left, running: a ring that drains over the whole hold and a clock
 * that ticks every second. Turns red in the last day.
 */
export function HoldCountdown({ held, size = 168 }: { held: HeldHostel; size?: number }) {
  const now = useNow();
  const end = new Date(held.holdUntil).getTime();
  const total = Math.max(1, held.holdDays * DAY_MS);
  const left = Math.max(0, end - now);
  const share = Math.min(1, left / total);
  const lastDay = left < DAY_MS;

  const days = Math.floor(left / DAY_MS);
  const hours = Math.floor((left % DAY_MS) / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);

  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ height: size, width: size }}>
        <svg
          aria-hidden
          className={`-rotate-90 ${lastDay ? "text-destructive" : "text-brand-teal"}`}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          width={size}
        >
          <circle className="text-muted" cx={size / 2} cy={size / 2} fill="none" r={radius} stroke="currentColor" strokeWidth={stroke} />
          <circle
            className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
            cx={size / 2}
            cy={size / 2}
            fill="none"
            r={radius}
            stroke="currentColor"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - share)}
            strokeLinecap="round"
            strokeWidth={stroke}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center" role="timer">
          <span className={`text-3xl font-bold tabular-nums ${lastDay ? "text-destructive" : "text-foreground"}`}>
            {days > 0 ? `${days}d` : `${pad(hours)}h`}
          </span>
          <span className="font-mono text-[13px] tabular-nums text-muted-foreground">
            {days > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`}
          </span>
        </div>
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        Claim before {formatHostelDate(held.holdUntil, "")}
      </p>
    </div>
  );
}

type HeldFiles = {
  fileLinksLeft: number;
  /** In group order (records first), oldest first inside each group. */
  files: { group: string; id: string; kind: string | null; name: string; sizeBytes: number; uploadedAt: string | null }[];
  /** `left` — ZIP downloads of this part still allowed in the last 24 hours. */
  parts: { bytes: number; files: number; left: number; part: number }[];
  totalBytes: number;
};

function size(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The hostel's original files (agreement point 9), the owner's choice of how:
 * everything at once as a ZIP — in parts when it is big — or file by file.
 * Both go through our routes; no lasting link to a file ever exists.
 */
function HeldFilesBlock({ requestId }: { requestId: string }) {
  const [data, setData] = useState<HeldFiles | null>(null);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const base = `${ENDPOINT}/${requestId}/files`;

  useEffect(() => {
    let active = true;

    void browserApi<HeldFiles>(base).then(
      (result) => active && setData(result),
      (cause) => active && setError(cause instanceof Error ? cause.message : "Could not load your files."),
    );

    return () => {
      active = false;
    };
  }, [base]);

  if (error) return <p className="text-[12.5px] text-destructive">{error}</p>;
  if (!data) return <HeldFilesSkeleton />;
  if (data.files.length === 0) return <p className="text-[12.5px] text-muted-foreground">No files were uploaded.</p>;

  return (
    <div className="w-full space-y-2 text-left">
      <p className="text-[13px] font-semibold text-foreground">
        Your files · {data.files.length} · {size(data.totalBytes)}
      </p>
      <div className="grid gap-2">
        {data.parts.map((part) => (
          <div className="space-y-1" key={part.part}>
            {part.left > 0 ? (
              <a
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-border text-[13px] font-semibold text-foreground hover:bg-muted"
                download
                href={`${base}/zip?part=${part.part}`}
                // Counted on the server when it starts; mirrored here so the line below is right.
                onClick={() => setData((current) => current && {
                  ...current,
                  parts: current.parts.map((row) => (row.part === part.part ? { ...row, left: row.left - 1 } : row)),
                })}
              >
                <Download className="size-4" />
                {data.parts.length > 1
                  ? `Download part ${part.part} of ${data.parts.length} (.zip, ${size(part.bytes)})`
                  : `Download all (.zip, ${size(part.bytes)})`}
              </a>
            ) : (
              <span className="inline-flex h-10 w-full items-center justify-center rounded-xl border border-dashed border-border text-[12.5px] text-muted-foreground">
                Downloaded {data.parts.length > 1 ? `part ${part.part} ` : ""}3 times today — again tomorrow
              </span>
            )}
            <p className="text-center text-[11.5px] text-muted-foreground">
              {part.left} of 3 downloads left today
            </p>
          </div>
        ))}
        <button
          className="h-9 text-[12.5px] font-semibold text-brand-teal hover:underline"
          onClick={() => setPicking((open) => !open)}
          type="button"
        >
          {picking ? "Hide the list" : "Choose files one by one"}
        </button>
      </div>
      {picking ? (
        <div className="max-h-96 overflow-y-auto rounded-xl border border-border">
          {groupFiles(data.files).map((group) => (
            <section key={group.label}>
              <h3 className="sticky top-0 flex items-center justify-between gap-2 border-b border-border bg-muted/90 px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground backdrop-blur">
                <span>{group.label}</span>
                <span className="normal-case tracking-normal">
                  {group.files.length} · {size(group.bytes)}
                </span>
              </h3>
              <ul className="divide-y divide-border">
                {group.files.map((file) => (
                  <li key={file.id}>
                    <a
                      className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] hover:bg-muted"
                      href={`${base}/${file.id}`}
                      rel="noopener"
                      target="_blank"
                    >
                      {group.label === "Records" ? (
                        <Download className="size-4 shrink-0 text-brand-teal" />
                      ) : (
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-foreground">{file.name}</span>
                      <span className="shrink-0 text-muted-foreground">{size(file.sizeBytes)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Consecutive files of one group under one heading. The server already sorted them. **Pure.** */
function groupFiles(files: HeldFiles["files"]) {
  const groups: { bytes: number; files: HeldFiles["files"]; label: string }[] = [];

  for (const file of files) {
    const last = groups.at(-1);

    if (last?.label === file.group) {
      last.files.push(file);
      last.bytes += file.sizeBytes;
    } else {
      groups.push({ bytes: file.sizeBytes, files: [file], label: file.group });
    }
  }

  return groups;
}

/** The files block while it loads: its title line, a ZIP button and the link under it. */
function HeldFilesSkeleton() {
  return (
    <div aria-busy className="w-full space-y-2" role="status">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-10 w-full rounded-xl" />
      <Skeleton className="mx-auto h-3 w-32" />
    </div>
  );
}

/** A held hostel's card while the list loads — the same shape, so nothing jumps. */
function HeldHostelSkeleton() {
  return (
    <div aria-busy className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-5" role="status">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="size-[168px] rounded-full" />
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-11 w-full rounded-xl" />
      <HeldFilesSkeleton />
    </div>
  );
}

/** One held hostel: its name, the countdown and the claim button. */
function HeldHostelBlock({
  busy,
  files = false,
  held,
  onClaim,
}: {
  busy: boolean;
  /** Show the files block — on `/hostel-leave`, not in the header's modal. */
  files?: boolean;
  held: HeldHostel;
  onClaim: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-5 text-center">
      <p className="text-[15px] font-semibold text-foreground">{held.hostelName}</p>
      {held.canClaim ? (
        <>
          <HoldCountdown held={held} />
          <Button className="h-11 w-full gap-2 rounded-xl" loading={busy} onClick={onClaim} type="button">
            <RotateCcw className="size-4" />
            Claim hostel back
          </Button>
        </>
      ) : (
        // The hold is over: the hostel is gone, its original files are not yet.
        <p className="text-[13px] text-muted-foreground">
          This hostel can no longer be claimed back. Its files can be downloaded until{" "}
          <strong className="text-foreground">{formatHostelDate(held.filesUntil, "")}</strong>.
        </p>
      )}
      {files ? (
        <HeldFilesBlock requestId={held.requestId} />
      ) : (
        <Link className="text-[12.5px] font-semibold text-brand-teal hover:underline" href="/hostel-leave">
          Download your files
        </Link>
      )}
    </div>
  );
}

/** Header button beside the account menu, for an account with a held hostel. */
export function ClaimHostelButton() {
  const { held: all } = useHeldHostels();
  const { busyId, claim, confirmDialog, error } = useClaimHostel();
  const [open, setOpen] = useState(false);
  // Files-only rows live on `/hostel-leave`; the header is for what can still come back.
  const held = all?.filter((row) => row.canClaim);

  if (!held?.length) return null;

  return (
    <>
      {confirmDialog}
      <button
        className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full bg-brand-teal px-3.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-white" />
        </span>
        Claim hostel
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Claim your hostel back</DialogTitle>
            <DialogDescription>It comes back exactly as you left it, if you claim it in time.</DialogDescription>
          </DialogHeader>
          {error ? <p className="rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p> : null}
          <div className="space-y-3">
            {held.map((row) => (
              <HeldHostelBlock busy={busyId === row.requestId} held={row} key={row.requestId} onClaim={() => void claim(row)} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * What the deleted portal's own address shows its owner in place of a 404:
 * the portal is gone, how long is left to claim it, and a way home.
 */
export function PortalDeletedNotice({ held }: { held: HeldHostel }) {
  const { busyId, claim, confirmDialog, error } = useClaimHostel();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      {confirmDialog}
      <div className="w-full max-w-md space-y-6 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive">
          <DoorOpen className="size-7" />
        </span>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">Your portal has been deleted</h1>
          <p className="text-[14px] text-muted-foreground">
            {held.hostelName} is off {PLATFORM_NAME}. Claim it back before the time runs out and everything comes back as it
            was — after that it is erased for good.
          </p>
        </div>
        <HoldCountdown held={held} size={188} />
        {error ? <p className="rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            className="h-11 flex-1 gap-2 rounded-xl"
            loading={busyId === held.requestId}
            onClick={() => void claim(held)}
            type="button"
          >
            <RotateCcw className="size-4" />
            Claim hostel back
          </Button>
          <Link
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-border px-4 text-sm font-semibold text-foreground hover:bg-muted"
            href="/"
          >
            Go home
          </Link>
        </div>
        <Link className="inline-block text-[13px] font-semibold text-brand-teal hover:underline" href="/hostel-leave">
          Download your files
        </Link>
      </div>
    </main>
  );
}

/** `/hostel-leave` — where the approval email sends the owner. */
export function HeldHostelsPanel() {
  const { error: loadError, held, signedOut } = useHeldHostels();
  const { busyId, claim, confirmDialog, error } = useClaimHostel();
  const message = error || loadError;

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      {confirmDialog}
      <h1 className="text-2xl font-bold text-foreground">Claim your hostel back</h1>
      <p className="mt-2 text-[14px] text-muted-foreground">
        A hostel taken off {PLATFORM_NAME} can be claimed back until its hold ends.
      </p>

      {message ? <p className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-[13.5px] text-destructive">{message}</p> : null}

      {signedOut ? (
        <Link
          className="mt-6 inline-flex h-11 items-center rounded-xl bg-brand-teal px-5 text-[14px] font-semibold text-white"
          href="/login?next=/hostel-leave"
        >
          Sign in with the owner&apos;s email
        </Link>
      ) : null}

      {held?.length === 0 ? (
        <p className="mt-6 text-[14px] text-foreground">
          There is no hostel to claim back on this account. The hold may have ended, or it was taken off with another email.
        </p>
      ) : null}

      <div className="mt-6 space-y-3">
        {!held && !signedOut && !message ? <HeldHostelSkeleton /> : null}
        {held?.map((row) => (
          <HeldHostelBlock busy={busyId === row.requestId} files held={row} key={row.requestId} onClaim={() => void claim(row)} />
        ))}
      </div>
    </main>
  );
}
