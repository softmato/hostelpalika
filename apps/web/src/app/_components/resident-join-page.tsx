"use client";

import {
  AlertTriangle,
  BedDouble,
  CheckCircle2,
  Clock3,
  IdCard,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { requestResidentProfileForm } from "@/components/resident-identity";
import { PublicShell } from "@/app/_components/shared";
import { refreshSession } from "@/lib/auth-refresh";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource, useUpdateResource } from "@/lib/portal-query";
import { addBsMonths, formatBsDate, formatBsPeriodMonth } from "@hostel/shared/calendar/bs";
import { rentStatusOptions } from "@/modules/residents/existing-residents-sheet-model";
import type { JoinPageView, JoinRequestView } from "@/modules/residents/resident-join.service";

/**
 * `/join/{token}` — a resident adding themself to the hostel they already live
 * in (docs/EXISTING_RESIDENTS.md, "Join link").
 *
 * Opened from WhatsApp on a phone, so it is one column and big targets. The
 * steps are the order the server needs them in: an account, an ID card the
 * hostel can see, then the two things only the person knows — their room, and
 * whether this month's rent is paid. Everything else is the card's.
 */

type Draft = {
  depositPaid: string;
  joinedDate: string;
  note: string;
  paidTill: string;
  partPaid: string;
  roomType: string;
};

const IDENTITY_CHANGED = "hh:resident-identity-changed";

function rupees(value: number) {
  return `Rs ${value.toLocaleString("en-IN")}`;
}

function digits(text: string) {
  const value = text.replace(/[^\d]/g, "");

  return value ? Number(value) : 0;
}

function draftFrom(request: JoinRequestView | null): Draft {
  return {
    depositPaid: request?.depositPaid ? String(request.depositPaid) : "",
    joinedDate: request?.joinedDate ? request.joinedDate.slice(0, 10) : "",
    note: request?.note ?? "",
    paidTill: request?.paidTill ?? "",
    partPaid: request?.partPaid ? String(request.partPaid) : "",
    roomType: request?.roomType ?? "",
  };
}

function monthsDue(paidTill: string, period: string) {
  let count = 0;

  for (let month = addBsMonths(paidTill, 1); month <= period; month = addBsMonths(month, 1)) {
    count += 1;
  }

  return count;
}


export function ResidentJoinPage({ token }: { token: string }) {
  const url = `/api/v1/public/join/${encodeURIComponent(token)}`;
  const page = usePortalResource<JoinPageView>(url, { errorMessage: "This link could not be opened." });
  const update = useUpdateResource();
  const [editing, setEditing] = useState(false);
  const view = page.data ?? null;
  const loadError = page.message;
  const { refreshAsync } = page;
  const load = refreshAsync;
  const setView = (next: JoinPageView) => update<JoinPageView>(url, () => next);

  useEffect(() => {
    // Their ID card is made in a modal on this page; read it again once it is saved.
    const onChanged = () => void refreshAsync();

    window.addEventListener(IDENTITY_CHANGED, onChanged);

    return () => window.removeEventListener(IDENTITY_CHANGED, onChanged);
  }, [refreshAsync]);

  if (loadError && !view) {
    return (
      <Shell hostelName="Join link">
        <Panel>
          <AlertTriangle className="size-8 text-warning" />
          <h2 className="text-lg font-bold">This link does not open</h2>
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Button asChild variant="outline">
            <Link href="/">Go to the home page</Link>
          </Button>
        </Panel>
      </Shell>
    );
  }

  if (!view) {
    return (
      <Shell hostelName="">
        <div className="space-y-3">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      </Shell>
    );
  }

  const request = view.request;
  const showForm =
    view.viewer?.card === "READY" &&
    !view.viewer.livesAt &&
    (editing || !request || request.status === "ADDED") &&
    (request ? view.link !== "OFF" : view.link === "OPEN");

  return (
    <Shell city={view.hostel.city} hostelName={view.hostel.name}>
      <CardStrip token={token} view={view} onChanged={load} />

      {!view.viewer ? null : view.viewer.livesAt ? (
        <Panel>
          {view.viewer.livesAt.sameHostel ? (
            <>
              <CheckCircle2 className="size-8 text-success" />
              <h2 className="text-lg font-bold">You are a resident here</h2>
              <p className="text-sm text-muted-foreground">
                {view.hostel.name} has already added you. Your bills and notices are in your dashboard.
              </p>
              <OpenDashboard />
            </>
          ) : (
            <>
              <AlertTriangle className="size-8 text-warning" />
              <h2 className="text-lg font-bold">You live at {view.viewer.livesAt.hostelName}</h2>
              <p className="text-sm text-muted-foreground">
                One person lives in one hostel. Ask {view.viewer.livesAt.hostelName} to move you out
                first, then open this link again.
              </p>
            </>
          )}
        </Panel>
      ) : showForm ? (
        <JoinForm
          initial={editing || request?.status === "REJECTED" ? request : null}
          onCancel={request && request.status !== "ADDED" ? () => setEditing(false) : undefined}
          onSent={(next) => {
            setView(next);
            setEditing(false);
          }}
          token={token}
          view={view}
        />
      ) : request && request.status !== "ADDED" ? (
        <RequestStatus
          hostelName={view.hostel.name}
          linkOff={view.link === "OFF"}
          onEdit={() => setEditing(true)}
          request={request}
        />
      ) : request?.status === "ADDED" ? null : view.viewer.card === "READY" ? (
        <Panel>
          <AlertTriangle className="size-8 text-warning" />
          <h2 className="text-lg font-bold">
            {view.link === "FULL" ? "This link is full" : "This link is paused"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {view.link === "FULL"
              ? `${view.hostel.name} has had all the requests it allowed. Ask them to allow more.`
              : `${view.hostel.name} has turned this link off for now. Ask them.`}
          </p>
        </Panel>
      ) : null}

      <a
        className="mx-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        href={`hostelpalika://join/${token}`}
      >
        <Smartphone className="size-3.5" />
        Have the HostelPalika app? Open this in the app
      </a>
    </Shell>
  );
}

function Shell({
  children,
  city,
  hostelName,
}: {
  children: React.ReactNode;
  city?: string;
  hostelName: string;
}) {
  // The public shell carries the header, and the header hosts the ID card wizard this page opens.
  return (
    <PublicShell footer={false}>
    <main className="mx-auto w-full max-w-xl pb-16">
      {/* The painted block with rounded bottom corners; the card below straddles its edge. */}
      <div className="rounded-b-[2rem] bg-brand-teal px-5 pb-16 pt-8 text-white">
        <p className="text-xs font-semibold uppercase tracking-wider text-white/75">
          Join as a resident
        </p>
        <h1 className="mt-1 text-2xl font-bold leading-tight">{hostelName || " "}</h1>
        {city ? <p className="mt-0.5 text-sm text-white/80">{city}</p> : null}
      </div>
      <div className="-mt-10 space-y-4 px-4">{children}</div>
    </main>
    </PublicShell>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm">
      {children}
    </section>
  );
}

function OpenDashboard() {
  const [busy, setBusy] = useState(false);

  return (
    <Button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // The account became a resident's on the server; pick that up before going in.
        await refreshSession().catch(() => false);
        window.location.assign("/resident/dashboard");
      }}
    >
      Open my dashboard
    </Button>
  );
}

/** Who is sending: signed out, no card, private card, or the card the hostel will check. */
function CardStrip({
  onChanged,
  token,
  view,
}: {
  onChanged: () => Promise<void>;
  token: string;
  view: JoinPageView;
}) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");
  const next = encodeURIComponent(`/join/${token}`);

  if (!view.viewer) {
    return (
      <Panel>
        <h2 className="text-lg font-bold">Already living at {view.hostel.name}?</h2>
        <p className="text-sm text-muted-foreground">
          Add yourself in a minute. Your hostel checks it and adds you — no joining fee, only the
          rent that is still due.
        </p>
        <ol className="w-full space-y-2 text-sm">
          {["Log in or make an account", "Make your ID card (once)", "Choose your room and rent"].map(
            (step, index) => (
              <li className="flex items-center gap-3" key={step}>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-teal-soft text-xs font-bold text-brand-teal">
                  {index + 1}
                </span>
                {step}
              </li>
            ),
          )}
        </ol>
        <div className="flex w-full gap-2">
          <Button asChild className="flex-1">
            <Link href={`/login?next=${next}`}>Log in</Link>
          </Button>
          <Button asChild className="flex-1" variant="outline">
            <Link href={`/signup?next=${next}`}>Make an account</Link>
          </Button>
        </div>
      </Panel>
    );
  }

  if (view.viewer.card === "NONE") {
    return (
      <Panel>
        <IdCard className="size-8 text-brand-teal" />
        <h2 className="text-lg font-bold">Make your ID card first</h2>
        <p className="text-sm text-muted-foreground">
          {view.hostel.name} checks you against your ID card — your photo, name and phone. You make it
          once and use it in any hostel.
        </p>
        <Button onClick={() => requestResidentProfileForm("MANUAL")}>Make my ID card</Button>
      </Panel>
    );
  }

  if (view.viewer.card === "PRIVATE") {
    return (
      <Panel>
        <ShieldCheck className="size-8 text-brand-teal" />
        <h2 className="text-lg font-bold">Your ID card is private</h2>
        <p className="text-sm text-muted-foreground">
          Hostels cannot see it, so {view.hostel.name} cannot check you. Turn on sharing to send your
          request.
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button
          disabled={sharing}
          onClick={async () => {
            setSharing(true);
            setError("");

            try {
              await browserApi("/api/v1/users/resident-identity", {
                body: JSON.stringify({ sharingEnabled: true }),
                method: "PATCH",
              });
              await onChanged();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Could not turn on sharing.");
            } finally {
              setSharing(false);
            }
          }}
        >
          Share my ID card with hostels
        </Button>
      </Panel>
    );
  }

  const viewer = view.viewer;

  return (
    <section className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
      {viewer.hasPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin, cookie-authed bytes
        <img
          alt=""
          className="size-14 shrink-0 rounded-xl object-cover"
          src={`/api/v1/users/resident-identity/photo?v=${encodeURIComponent(viewer.photoUpdatedAt ?? "")}`}
        />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-brand-teal-soft text-xl font-bold text-brand-teal">
          {viewer.fullName.charAt(0) || "?"}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{viewer.fullName}</p>
        <p className="truncate text-sm text-muted-foreground">{viewer.phone}</p>
        <p className="font-mono text-xs text-muted-foreground">{viewer.cardId}</p>
      </div>
      <span className="shrink-0 rounded-full bg-brand-teal-soft px-2.5 py-1 text-xs font-semibold text-brand-teal">
        Your ID card
      </span>
    </section>
  );
}

function JoinForm({
  initial,
  onCancel,
  onSent,
  token,
  view,
}: {
  initial: JoinRequestView | null;
  onCancel?: () => void;
  onSent: (view: JoinPageView) => void;
  token: string;
  view: JoinPageView;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const period = view.currentMonth.period;
  const options = useMemo(() => rentStatusOptions(period, draft.paidTill || null), [period, draft.paidTill]);
  const due = draft.paidTill && draft.paidTill < period ? monthsDue(draft.paidTill, period) : 0;
  const firstDue = draft.paidTill ? addBsMonths(draft.paidTill, 1) : "";
  const room = view.roomTypes.find((candidate) => candidate.roomType === draft.roomType);
  const estimate = room?.monthlyRent && due ? room.monthlyRent * due - digits(draft.partPaid) : 0;
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  async function send() {
    setError("");

    if (!draft.roomType) return setError("Choose your room type.");
    if (!draft.paidTill) return setError(`Choose if ${view.currentMonth.label} rent is paid.`);

    setBusy(true);

    try {
      onSent(
        await browserApi<JoinPageView>(`/api/v1/public/join/${encodeURIComponent(token)}`, {
          body: JSON.stringify({
            depositPaid: digits(draft.depositPaid),
            joinedDate: draft.joinedDate || null,
            note: draft.note,
            paidTill: draft.paidTill,
            partPaid: due ? digits(draft.partPaid) : 0,
            roomType: draft.roomType,
          }),
          method: "POST",
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your request could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-sm">
      {initial?.status === "REJECTED" ? (
        <div className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <RotateCcw className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="font-semibold">{view.hostel.name} sent it back</p>
            <p className="text-muted-foreground">{initial.rejectReason}</p>
          </div>
        </div>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">Your room type</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {view.roomTypes.map((candidate) => {
            const active = draft.roomType === candidate.roomType;

            return (
              <button
                aria-pressed={active}
                className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                  active
                    ? "border-brand-teal bg-brand-teal-soft"
                    : "border-border hover:border-brand-teal/50"
                }`}
                key={candidate.roomType}
                onClick={() => set({ roomType: candidate.roomType })}
                type="button"
              >
                <BedDouble className={`size-5 shrink-0 ${active ? "text-brand-teal" : "text-muted-foreground"}`} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{candidate.roomType}</span>
                  <span className="block text-xs text-muted-foreground">
                    {candidate.monthlyRent ? `${rupees(candidate.monthlyRent)} / month` : "Rent set by the hostel"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="block space-y-1.5">
        <span className="text-sm font-semibold">Is {view.currentMonth.label} rent paid?</span>
        <select
          className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-teal"
          onChange={(event) => set({ paidTill: event.target.value })}
          value={draft.paidTill}
        >
          <option disabled value="">
            Choose one
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {due > 0 ? (
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold">
            Paid part of {formatBsPeriodMonth(firstDue)} rent already?{" "}
            <span className="font-normal text-muted-foreground">Optional</span>
          </span>
          <input
            className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-teal"
            inputMode="numeric"
            onChange={(event) => set({ partPaid: event.target.value.replace(/[^\d]/g, "") })}
            placeholder="Rs 0"
            value={draft.partPaid}
          />
          <span className="block text-xs text-muted-foreground">
            It comes off that month&apos;s bill.
          </span>
        </label>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold">
            Deposit you paid <span className="font-normal text-muted-foreground">Optional</span>
          </span>
          <input
            className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-teal"
            inputMode="numeric"
            onChange={(event) => set({ depositPaid: event.target.value.replace(/[^\d]/g, "") })}
            placeholder="Rs 0"
            value={draft.depositPaid}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold">
            Moved in on <span className="font-normal text-muted-foreground">Optional</span>
          </span>
          <input
            className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand-teal"
            max={new Date().toISOString().slice(0, 10)}
            onChange={(event) => set({ joinedDate: event.target.value })}
            type="date"
            value={draft.joinedDate}
          />
          {draft.joinedDate ? (
            <span className="block text-xs text-muted-foreground">{formatBsDate(new Date(draft.joinedDate))}</span>
          ) : null}
        </label>
      </div>

      <label className="block space-y-1.5">
        <span className="text-sm font-semibold">
          Note for the warden <span className="font-normal text-muted-foreground">Optional</span>
        </span>
        <textarea
          className="min-h-20 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-brand-teal"
          maxLength={300}
          onChange={(event) => set({ note: event.target.value })}
          placeholder="e.g. Paid Rs 3,000 cash to Hari dai on Bhadra 20"
          value={draft.note}
        />
      </label>

      {estimate > 0 ? (
        <div className="flex items-center justify-between rounded-xl bg-muted/50 px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            About what you will owe ({due} {due === 1 ? "month" : "months"})
          </span>
          <span className="font-bold">{rupees(estimate)}</span>
        </div>
      ) : null}

      <div className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          Your hostel owner or warden checks this against their own book. Fill it in correctly — wrong
          details can mean extra charges.
        </p>
      </div>

      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

      <div className="flex gap-2">
        {onCancel ? (
          <Button className="h-11" disabled={busy} onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
        ) : null}
        <Button className="h-11 flex-1" disabled={busy} onClick={send} type="button">
          {busy ? "Sending…" : initial ? "Send again" : `Send to ${view.hostel.name}`}
        </Button>
      </div>
    </section>
  );
}

function RequestStatus({
  hostelName,
  linkOff,
  onEdit,
  request,
}: {
  hostelName: string;
  linkOff: boolean;
  onEdit: () => void;
  request: JoinRequestView;
}) {
  const returned = request.status === "REJECTED";
  const rows: [string, string][] = [
    ["Room type", request.roomType],
    ["Rent", request.rentLabel],
    ...(request.partPaid ? ([["Part paid", rupees(request.partPaid)]] as [string, string][]) : []),
    ["Deposit paid", rupees(request.depositPaid)],
    ...(request.joinedDate ? ([["Moved in", formatBsDate(new Date(request.joinedDate))]] as [string, string][]) : []),
    ...(request.bills ? ([["Due when added", rupees(request.bills.total)]] as [string, string][]) : []),
  ];

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        {returned ? (
          <RotateCcw className="mt-0.5 size-6 shrink-0 text-warning" />
        ) : (
          <Clock3 className="mt-0.5 size-6 shrink-0 text-brand-teal" />
        )}
        <div>
          <h2 className="text-lg font-bold">{returned ? "Sent back to you" : `Sent to ${hostelName}`}</h2>
          <p className="text-sm text-muted-foreground">
            {returned
              ? request.rejectReason
              : "They check it against their book and add you. You will get a message when they do."}
          </p>
        </div>
      </div>

      <dl className="divide-y divide-border rounded-xl border border-border text-sm">
        {rows.map(([label, value]) => (
          <div className="flex justify-between gap-3 px-4 py-2.5" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      {linkOff ? (
        <p className="text-sm text-muted-foreground">The hostel has paused this link, so it cannot be changed now.</p>
      ) : (
        <Button className="h-11 w-full" onClick={onEdit} variant={returned ? "default" : "outline"}>
          <Pencil className="size-4" />
          {returned ? "Fix and send again" : "Change something"}
        </Button>
      )}
    </section>
  );
}
