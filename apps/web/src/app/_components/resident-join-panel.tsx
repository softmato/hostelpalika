"use client";

import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Link2,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  UserCheck,
} from "lucide-react";
import { useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
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
import { formatBsDate } from "@hostel/shared/calendar/bs";
import type { JoinLinkView, JoinRequestView } from "@/modules/residents/resident-join.service";
import { toast } from "@/stores/toast-store";

import { InitialsAvatar, RoleButton, SectionCard, SoftBadge } from "./portal-dashboard-ui";

/**
 * The join link and the requests it brings in, on the Residents page
 * (docs/EXISTING_RESIDENTS.md, "Join link").
 *
 * A request is checked like a person at the desk: their ID card photo beside
 * what they said, the bill it will make, and anything that would stop it. Add
 * asks "are you sure" first; Send back asks what to fix and tells them.
 */

const LINK_URL = "/api/v1/hostel-admin/residents/join-link";
const REQUESTS_URL = "/api/v1/hostel-admin/residents/join-requests";

type JoinRequests = {
  currentMonth: { label: string; period: string };
  requests: JoinRequestView[];
  waiting: number;
};

const SEND_BACK_REASONS = [
  "Room type is not right",
  "Rent paid / months due is not right",
  "Deposit is not right",
  "Part paid amount is not right",
];

function rupees(value: number) {
  return `Rs ${value.toLocaleString("en-IN")}`;
}

function sentAgo(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);

  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;

  return formatBsDate(new Date(iso));
}

export function JoinLinkButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <RoleButton onClick={() => setOpen(true)} tone="admin" type="button" variant="outline">
        <Link2 className="size-4" />
        Join link
      </RoleButton>
      {open ? <JoinLinkDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function JoinLinkDialog({ onClose }: { onClose: () => void }) {
  const link = usePortalResource<JoinLinkView>(LINK_URL, { errorMessage: "Could not load the join link." });
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const [cap, setCap] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const data = link.data;

  async function save(patch: { cap?: number; enabled?: boolean; renew?: true }) {
    setBusy(true);

    try {
      await browserApi<JoinLinkView>(LINK_URL, { body: JSON.stringify(patch), method: "PATCH" });
      invalidate(LINK_URL);
      setCap(null);
    } catch (error) {
      toast.error({ description: error instanceof Error ? error.message : undefined, title: "Not saved" });
    } finally {
      setBusy(false);
    }
  }

  const message = data
    ? `Already living here? Add yourself as a resident on HostelPalika — choose your room and tell us what rent is paid. We check it before adding you.\n${data.url}`
    : "";

  return (
    <Dialog onOpenChange={(next) => (next ? null : onClose())} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Join link</DialogTitle>
          <DialogDescription>
            Send it to your residents&apos; WhatsApp group or to one person. They choose their room and
            say what rent is paid; you check and add them.
          </DialogDescription>
        </DialogHeader>

        {!data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{link.message || "Loading…"}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/30 p-4">
              {data.qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data: URL
                <img
                  alt="QR code for the join link"
                  className={`size-48 rounded-lg bg-white p-2 ${data.enabled ? "" : "opacity-30"}`}
                  src={data.qrDataUrl}
                />
              ) : null}
              <p className="break-all text-center font-mono text-xs text-muted-foreground">{data.url}</p>
              {!data.enabled ? (
                <SoftBadge tone="amber">Paused — nobody can send a new request</SoftBadge>
              ) : data.used >= data.cap ? (
                <SoftBadge tone="amber">Full — allow more requests below</SoftBadge>
              ) : null}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Button asChild variant="outline">
                <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} rel="noreferrer" target="_blank">
                  <MessageCircle className="size-4" />
                  WhatsApp
                </a>
              </Button>
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(data.url).catch(() => null);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                }}
                variant="outline"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button asChild disabled={!data.qrDataUrl} variant="outline">
                <a download="join-link-qr.png" href={data.qrDataUrl ?? undefined}>
                  <Download className="size-4" />
                  QR
                </a>
              </Button>
            </div>

            <div className="space-y-2 rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-semibold">Requests used</span>
                <span className="font-mono">
                  {data.used} of {data.cap}
                </span>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex-1 space-y-1">
                  <span className="text-xs text-muted-foreground">
                    Allow up to — your residents plus a few spare
                  </span>
                  <input
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-role-admin"
                    inputMode="numeric"
                    onChange={(event) => setCap(event.target.value.replace(/[^\d]/g, ""))}
                    value={cap ?? String(data.cap)}
                  />
                </label>
                <Button
                  disabled={busy || cap === null || !Number(cap) || Number(cap) === data.cap}
                  onClick={() => save({ cap: Number(cap) })}
                >
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Fixing and sending again is the same request — it does not use another one.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() => save({ enabled: !data.enabled })}
                variant={data.enabled ? "outline" : "default"}
              >
                {data.enabled ? "Pause link" : "Turn link on"}
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  const yes = await confirm({
                    actionLabel: "Make new link",
                    description:
                      "The old link and QR stop working at once, wherever they were shared. Requests already sent stay.",
                    title: "Make a new link?",
                    tone: "destructive",
                  });

                  if (yes) await save({ renew: true });
                }}
                variant="ghost"
              >
                <RefreshCw className="size-4" />
                New link
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Done
          </Button>
        </DialogFooter>
        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
}

/** Requests waiting, sent back and added lately. Renders nothing until there is one. */
export function JoinRequestsPanel() {
  const list = usePortalResource<JoinRequests>(REQUESTS_URL, { errorMessage: "Could not load join requests." });
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendingBack, setSendingBack] = useState<JoinRequestView | null>(null);
  const requests = list.data?.requests ?? [];

  if (requests.length === 0) return null;

  const waiting = requests.filter((request) => request.status === "PENDING");
  const returned = requests.filter((request) => request.status === "REJECTED");
  const added = requests.filter((request) => request.status === "ADDED");

  async function add(request: JoinRequestView) {
    const due = request.bills?.total ?? 0;
    const yes = await confirm({
      actionLabel: "Yes, add",
      description: [
        `${request.roomType} · ${request.rentLabel}.`,
        due > 0 ? `Bills of ${rupees(due)} are made now.` : "Nothing is billed now.",
        "They are told by email and in the app.",
      ].join(" "),
      title: `Add ${request.fullName} as an existing resident?`,
    });

    if (!yes) return;

    setBusyId(request.id);

    try {
      await browserApi(`${REQUESTS_URL}/${request.id}`, {
        body: JSON.stringify({ action: "add" }),
        method: "POST",
      });
      toast.success({ title: `${request.fullName} added` });
      invalidate(`${REQUESTS_URL}*`, "/api/v1/hostel-admin/residents*", LINK_URL);
    } catch (error) {
      toast.error({ description: error instanceof Error ? error.message : undefined, title: "Not added" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SectionCard
      description="Residents who sent their details through your join link. Check them against your book, then add."
      title={waiting.length ? `Join requests · ${waiting.length} waiting` : "Join requests"}
    >
      <div className="space-y-3">
        {waiting.map((request) => (
          <RequestCard
            busy={busyId === request.id}
            key={request.id}
            onAdd={() => add(request)}
            onSendBack={() => setSendingBack(request)}
            request={request}
          />
        ))}

        {returned.length ? (
          <div className="space-y-2 pt-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sent back — they are fixing it
            </h3>
            {returned.map((request) => (
              <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5" key={request.id}>
                <RotateCcw className="size-4 shrink-0 text-warning" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-semibold">{request.fullName}</span>
                  <span className="text-muted-foreground"> · {request.rejectReason}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {added.length ? (
          <p className="pt-2 text-xs text-muted-foreground">
            <UserCheck className="mr-1 inline size-3.5" />
            Added lately: {added.map((request) => request.fullName).join(", ")}
          </p>
        ) : null}
      </div>

      {sendingBack ? (
        <SendBackDialog
          onClose={() => setSendingBack(null)}
          onSent={() => {
            setSendingBack(null);
            invalidate(`${REQUESTS_URL}*`);
          }}
          request={sendingBack}
        />
      ) : null}
      {confirmDialog}
    </SectionCard>
  );
}

function RequestCard({
  busy,
  onAdd,
  onSendBack,
  request,
}: {
  busy: boolean;
  onAdd: () => void;
  onSendBack: () => void;
  request: JoinRequestView;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const facts: [string, string][] = [
    ["Room type", request.roomType],
    ["Rent", request.rentLabel],
    ["Deposit paid", rupees(request.depositPaid)],
    ...(request.partPaid ? ([["Part paid", rupees(request.partPaid)]] as [string, string][]) : []),
    ...(request.joinedDate
      ? ([["Moved in", formatBsDate(new Date(request.joinedDate))]] as [string, string][])
      : []),
  ];

  return (
    <article className="rounded-2xl border border-border p-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        {photoFailed ? (
          <InitialsAvatar className="size-24 shrink-0 rounded-xl text-2xl" name={request.fullName} size="lg" tone="admin" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- private, per-person route
          <img
            alt={`Photo on ${request.fullName}'s ID card`}
            className="size-24 shrink-0 rounded-xl border border-border bg-muted object-cover"
            onError={() => setPhotoFailed(true)}
            src={`/api/v1/hostel-admin/resident-scan/photo?residentId=${encodeURIComponent(request.cardId)}`}
          />
        )}

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-base font-bold">{request.fullName}</p>
              <p className="text-sm text-muted-foreground">
                {request.phone} ·{" "}
                <a
                  className="inline-flex items-center gap-1 font-mono text-xs hover:text-foreground"
                  href={`/resident-id/${encodeURIComponent(request.cardId)}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {request.cardId}
                  <ExternalLink className="size-3" />
                </a>
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              {request.sends > 1 ? `Fixed and sent again · ` : ""}
              {sentAgo(request.sentAt)}
            </span>
          </div>

          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          {request.bills ? (
            <div className="rounded-xl bg-muted/40 px-3 py-2 text-sm">
              {request.bills.months.length === 0 && !request.bills.oldDues ? (
                <span className="text-muted-foreground">Rent is all paid — nothing is billed when added.</span>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {request.bills.months.map((month) => (
                    <span key={month.period}>
                      {month.label} <span className="font-semibold">{rupees(month.amount)}</span>
                    </span>
                  ))}
                  {request.bills.partPaid ? (
                    <span className="text-success">− paid {rupees(request.bills.partPaid)}</span>
                  ) : null}
                  <span className="ml-auto font-bold">Bill on add {rupees(request.bills.total)}</span>
                </div>
              )}
            </div>
          ) : null}

          {request.note ? (
            <p className="rounded-xl border border-border px-3 py-2 text-sm">
              <span className="text-muted-foreground">Note: </span>
              {request.note}
            </p>
          ) : null}

          {request.problems.length ? (
            <ul className="space-y-1 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
              {request.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={busy} onClick={onSendBack} variant="outline">
              <RotateCcw className="size-4" />
              Send back
            </Button>
            <RoleButton disabled={busy || request.problems.length > 0} onClick={onAdd} tone="admin" type="button">
              <UserCheck className="size-4" />
              {busy ? "Adding…" : "Add as existing resident"}
            </RoleButton>
          </div>
        </div>
      </div>
    </article>
  );
}

function SendBackDialog({
  onClose,
  onSent,
  request,
}: {
  onClose: () => void;
  onSent: () => void;
  request: JoinRequestView;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    setBusy(true);
    setError("");

    try {
      await browserApi(`${REQUESTS_URL}/${request.id}`, {
        body: JSON.stringify({ action: "reject", reason }),
        method: "POST",
      });
      toast.success({ title: `Sent back to ${request.fullName}` });
      onSent();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send it back.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={(next) => (next ? null : onClose())} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send back to {request.fullName}</DialogTitle>
          <DialogDescription>
            Say what to fix. They get a message and fix it on the same link — it stays one request.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {SEND_BACK_REASONS.map((preset) => (
            <button
              className="rounded-full border border-border px-3 py-1 text-xs hover:border-role-admin"
              key={preset}
              onClick={() => setReason(preset)}
              type="button"
            >
              {preset}
            </button>
          ))}
        </div>
        <textarea
          autoFocus
          className="min-h-24 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-role-admin"
          maxLength={300}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. You owe Bhadra too — choose 2 months due"
          value={reason}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={busy || reason.trim().length < 3} onClick={send}>
            {busy ? "Sending…" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
