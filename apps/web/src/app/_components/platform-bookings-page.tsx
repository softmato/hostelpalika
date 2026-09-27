"use client";

import { ExternalLink, Eye, Plus, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import {
  FIELD,
  List,
  ReasonAction,
  Row,
  timeLeft,
  useAction,
  useNow,
} from "@/app/_components/booking-admin-ui";
import { at, rupees } from "@/app/_components/booking-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  PortalPageHeader,
  RoleButton,
  SoftBadge,
  TabBar,
} from "@/app/_components/portal-dashboard-ui";
import { LoadingRows, Panel } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import { uploadFile } from "@/lib/uploads/uploader";
import type { BookingConfig } from "@/modules/bookings/booking-config";
import type { BookingPaymentToCheck } from "@/modules/bookings/booking-review.service";
import type { TransferView } from "@/modules/bookings/booking-transfer.service";
import type { PlatformBookingView } from "@/modules/bookings/booking-views";
import type { PayoutAccountForReview } from "@/modules/bookings/payout-account.service";
import type { PendingSettingChange } from "@/modules/platform-config/setting-change.service";

/**
 * Platform → Bookings: docs/BOOKINGS.md item 17.
 *
 * Every queue HostelPalika has promised to work on time, one tab each, oldest
 * first: screenshots to check, hostels still to answer, beds held, refunds and
 * payouts to send, payout accounts to verify, paused hostels — then every
 * booking, and the settings, which save only through an emailed confirm link.
 */

const BASE = "/api/v1/platform/bookings";

type Counts = { holds: number; payments: number; payoutsDue: number; refundsDue: number; waiting: number };
type BookingsResponse = {
  bookings: PlatformBookingView[];
  counts: Counts;
  pausedHostels?: Array<{ automatic: boolean; id: string; name: string; pausedAt: string | null; reason: string | null; slug: string }>;
};

const REFRESH = [`${BASE}*`, "/api/v1/platform/setting-changes*"];

/* ── Screenshots to check ─────────────────────────────────────────────── */

function PaymentsTab() {
  const resource = usePortalResource<{ payments: BookingPaymentToCheck[] }>(`${BASE}/payments`);
  const { busy, run } = useAction(REFRESH);
  const { confirm, confirmDialog } = useConfirm();
  const now = useNow();

  return (
    <Panel title="Payments to check">
      {confirmDialog}
      <List
        empty="No screenshots waiting."
        items={resource.data?.payments}
        render={(payment) => (
          <Row
            actions={
              <>
                <a
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-semibold"
                  href={`/api/v1/files/${payment.proofAssetId}/url`}
                  rel="noopener"
                  target="_blank"
                >
                  <ExternalLink className="size-3.5" /> Screenshot
                </a>
                <RoleButton
                  disabled={busy === payment.id}
                  onClick={async () => {
                    if (
                      await confirm({
                        actionLabel: "Approve",
                        description: `Only if ${rupees(payment.amount)} with ${payment.bookingCode} arrived in the collection account.`,
                        title: "Approve this payment?",
                      })
                    ) {
                      await run(payment.id, `${BASE}/payments/${payment.id}`, { approve: true }, "Payment approved. The hostel has been asked.");
                    }
                  }}
                >
                  Approve
                </RoleButton>
                <ReasonAction
                  busy={busy === payment.id}
                  label="Reject"
                  onSubmit={(note) => void run(payment.id, `${BASE}/payments/${payment.id}`, { approve: false, note }, "Sent back to the person.")}
                  placeholder="What the person should fix"
                />
              </>
            }
          >
            <p className="font-bold text-foreground">
              {rupees(payment.amount)} · {payment.bookingCode}
            </p>
            <p className="text-muted-foreground">
              {payment.guest.name} ({payment.guest.phone || payment.guest.email}) → {payment.hostelName}, {payment.roomType}
            </p>
            <p className="text-muted-foreground">
              Reference {payment.reference || "none"} · sent {at(payment.submittedAt)} · check by {at(payment.checkBy)}{" "}
              <SoftBadge tone={timeLeft(payment.checkBy, now) === "overdue" ? "rose" : "amber"}>{timeLeft(payment.checkBy, now)}</SoftBadge>
            </p>
            {payment.note ? <p className="text-muted-foreground">Note: {payment.note}</p> : null}
          </Row>
        )}
        state={resource.state}
      />
    </Panel>
  );
}

/* ── Bookings (waiting, holds, all) ───────────────────────────────────── */

function BookingsTab({ tab }: { tab: "all" | "holds" | "waiting" }) {
  const [status, setStatus] = useState("");
  const resource = usePortalResource<BookingsResponse>(`${BASE}?tab=${tab}${status ? `&status=${status}` : ""}`);
  const { busy, run } = useAction(REFRESH);
  const now = useNow();
  const title = tab === "waiting" ? "Waiting on hostels" : tab === "holds" ? "Beds held" : "All bookings";

  return (
    <Panel
      action={
        tab === "all" ? (
          <select className={FIELD} onChange={(event) => setStatus(event.target.value)} value={status}>
            <option value="">Every status</option>
            {["AWAITING_PAYMENT", "PAYMENT_IN_REVIEW", "AWAITING_HOSTEL", "CONFIRMED", "CHECKED_IN", "EXPIRED", "DECLINED", "HOSTEL_NO_RESPONSE", "CANCELLED_BY_USER", "CANCELLED_BY_HOSTEL", "CANCELLED_BY_PLATFORM", "NO_SHOW"].map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
        ) : null
      }
      title={title}
    >
      <List
        empty="Nothing here."
        items={resource.data?.bookings}
        render={(booking) => {
          const deadline = booking.status === "AWAITING_HOSTEL" ? booking.hostelAnswerBy : booking.status === "CONFIRMED" ? booking.holdEndsAt : null;
          const paidOpen = booking.status === "AWAITING_HOSTEL" || booking.status === "CONFIRMED";

          return (
            <Row
              actions={
                paidOpen ? (
                  <>
                    <ReasonAction
                      busy={busy === booking.id}
                      label="Cancel, refund in full"
                      onSubmit={(reason) => void run(booking.id, `${BASE}/${booking.id}`, { reason }, "Cancelled. The refund is due.", "DELETE")}
                      placeholder="Why (the person and the hostel read this)"
                    />
                    <ReasonAction
                      busy={busy === `pause-${booking.hostel.id}`}
                      label="Pause hostel"
                      onSubmit={(reason) =>
                        void run(`pause-${booking.hostel.id}`, `${BASE}/hostels/${booking.hostel.id}/pause`, { paused: true, reason }, "Bookings paused on the hostel.")
                      }
                      placeholder="Why the hostel is paused"
                    />
                  </>
                ) : null
              }
              key={booking.id}
            >
              <p className="font-bold text-foreground">
                {booking.code} · {booking.statusLabel}{" "}
                {booking.strike ? <SoftBadge tone="rose">strike</SoftBadge> : null}
              </p>
              <p className="text-muted-foreground">
                {booking.guest.name} ({booking.guest.phone || booking.guest.email}) → {booking.hostel.name}
                {booking.hostel.phone ? ` · ${booking.hostel.phone}` : ""}, {booking.roomType}
              </p>
              <p className="text-muted-foreground">
                Fee {rupees(booking.fee)} · hostel share if kept {rupees(booking.hostelShareIfKept)} · booked {at(booking.createdAt)}
              </p>
              {deadline ? (
                <p className="text-muted-foreground">
                  {booking.status === "AWAITING_HOSTEL" ? "Answer by" : "Hold ends"} {at(deadline)}{" "}
                  <SoftBadge tone={timeLeft(deadline, now) === "overdue" ? "rose" : "amber"}>{timeLeft(deadline, now)}</SoftBadge>
                </p>
              ) : null}
              {booking.platformSettlement ? (
                <p className="text-muted-foreground">
                  Refund {rupees(booking.platformSettlement.refund)} · hostel {rupees(booking.platformSettlement.hostelShare)} · us{" "}
                  {rupees(booking.platformSettlement.platformShare)}
                </p>
              ) : null}
              {booking.endReason ? <p className="text-muted-foreground">Reason: {booking.endReason}</p> : null}
            </Row>
          );
        }}
        state={resource.state}
      />
    </Panel>
  );
}

/* ── Money to send ─────────────────────────────────────────────────────── */

function MarkSent({ busy, onSubmit }: { busy: boolean; onSubmit: (input: { note: string; proofAssetId?: string; transactionId: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [transactionId, setTransactionId] = useState("");
  const [note, setNote] = useState("");
  const [proof, setProof] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);

  if (!open) {
    return <RoleButton onClick={() => setOpen(true)}>Mark sent</RoleButton>;
  }

  return (
    <div className="grid w-full gap-2">
      <input className={FIELD} maxLength={64} onChange={(event) => setTransactionId(event.target.value)} placeholder="Transaction ID" value={transactionId} />
      <input className={FIELD} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Note (optional)" value={note} />
      <label className="text-xs text-muted-foreground">
        {uploading ? "Uploading…" : proof ? "Screenshot attached" : "Screenshot of the transfer (optional)"}
        <input
          accept="image/*"
          className="mt-1 block text-xs"
          onChange={async (event) => {
            const file = event.target.files?.[0];

            if (!file) return;

            setUploading(true);

            const result = await uploadFile(file, {
              accessLevel: "PRIVATE",
              assetKind: "BOOKING_TRANSFER_PROOF",
              kind: "image",
              label: "Transfer screenshot",
              silent: true,
            }).finally(() => setUploading(false));

            setProof(result?.assetId ?? undefined);
          }}
          type="file"
        />
      </label>
      <div className="flex gap-2">
        <RoleButton
          disabled={busy || uploading || transactionId.trim().length < 3}
          onClick={() => onSubmit({ note: note.trim(), proofAssetId: proof, transactionId: transactionId.trim() })}
        >
          Mark sent
        </RoleButton>
        <RoleButton onClick={() => setOpen(false)} variant="outline">
          Close
        </RoleButton>
      </div>
    </div>
  );
}

function TransfersTab({ kind }: { kind: "PAYOUT" | "REFUND" }) {
  const resource = usePortalResource<{ transfers: TransferView[] }>(`${BASE}/transfers?kind=${kind}`);
  const { busy, run } = useAction(REFRESH);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  return (
    <Panel title={kind === "REFUND" ? "Refunds to send" : "Payouts to send"}>
      <List
        empty="Nothing to send."
        items={resource.data?.transfers}
        render={(transfer) => (
          <Row
            actions={
              transfer.blocked ? (
                <SoftBadge tone="rose">
                  {transfer.blocked === "NO_PAYOUT_ACCOUNT" ? "No payout account" : "Payout account not verified"}
                </SoftBadge>
              ) : (
                <>
                  <RoleButton
                    disabled={busy === `reveal-${transfer.id}`}
                    onClick={async () => {
                      const data = await run<{ account: { number?: string } }>(
                        `reveal-${transfer.id}`,
                        `${BASE}/transfers/${transfer.id}/reveal`,
                        {},
                        "Account number shown. This was logged.",
                      );

                      if (data?.account.number) {
                        setRevealed((current) => ({ ...current, [transfer.id]: data.account.number as string }));
                      }
                    }}
                    variant="outline"
                  >
                    <Eye className="size-3.5" /> Number
                  </RoleButton>
                  <MarkSent
                    busy={busy === transfer.id}
                    onSubmit={(input) => void run(transfer.id, `${BASE}/transfers/${transfer.id}/sent`, input, "Marked sent. They have been emailed.")}
                  />
                </>
              )
            }
            key={transfer.id}
          >
            <p className="font-bold text-foreground">
              {rupees(transfer.amount)} · {transfer.bookingCode}
            </p>
            <p className="text-muted-foreground">
              {kind === "REFUND" ? transfer.guestName : transfer.hostelName} · {transfer.roomType} · due since {at(transfer.dueSince)}
            </p>
            {transfer.destination ? (
              <p className="text-muted-foreground">
                {transfer.destination.methodLabel} {transfer.destination.bankName} {revealed[transfer.id] ?? transfer.destination.maskedNumber} (
                {transfer.destination.holderName})
              </p>
            ) : null}
          </Row>
        )}
        state={resource.state}
      />
    </Panel>
  );
}

/* ── Payout accounts ───────────────────────────────────────────────────── */

function AccountsTab() {
  const resource = usePortalResource<{ accounts: PayoutAccountForReview[] }>(`${BASE}/payout-accounts?status=PENDING_REVIEW`);
  const { busy, run } = useAction(REFRESH);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  return (
    <Panel title="Payout accounts to verify">
      <List
        empty="No payout accounts waiting."
        items={resource.data?.accounts}
        render={(account) => (
          <Row
            actions={
              <>
                <RoleButton
                  disabled={busy === `reveal-${account.hostelId}`}
                  onClick={async () => {
                    const data = await run<{ account?: { number?: string }; number?: string }>(
                      `reveal-${account.hostelId}`,
                      `${BASE}/payout-accounts/${account.hostelId}/reveal`,
                      {},
                      "Account number shown. This was logged.",
                    );
                    const number = data?.account?.number ?? data?.number;

                    if (number) {
                      setRevealed((current) => ({ ...current, [account.hostelId]: number }));
                    }
                  }}
                  variant="outline"
                >
                  <Eye className="size-3.5" /> Number
                </RoleButton>
                <RoleButton
                  disabled={busy === account.hostelId}
                  onClick={() => void run(account.hostelId, `${BASE}/payout-accounts/${account.hostelId}/review`, { approve: true }, "Verified.")}
                >
                  Verify
                </RoleButton>
                <ReasonAction
                  busy={busy === account.hostelId}
                  label="Send back"
                  onSubmit={(note) => void run(account.hostelId, `${BASE}/payout-accounts/${account.hostelId}/review`, { approve: false, note }, "Sent back to the hostel.")}
                  placeholder="What the hostel should fix"
                />
              </>
            }
            key={account.hostelId}
          >
            <p className="font-bold text-foreground">{account.hostelName}</p>
            <p className="text-muted-foreground">
              {account.methodLabel} {account.bankName} {account.branch} · {revealed[account.hostelId] ?? account.maskedNumber} · {account.holderName}
            </p>
            <p className="text-muted-foreground">Submitted {at(account.submittedAt)}</p>
            {account.sharedWith.length > 0 ? (
              <SoftBadge tone="rose">Same number as {account.sharedWith.join(", ")}</SoftBadge>
            ) : null}
          </Row>
        )}
        state={resource.state}
      />
    </Panel>
  );
}

/* ── Paused hostels ────────────────────────────────────────────────────── */

function PausedTab() {
  const resource = usePortalResource<BookingsResponse>(`${BASE}?tab=paused`);
  const { busy, run } = useAction(REFRESH);

  return (
    <Panel title="Paused hostels">
      <List
        empty="No hostel is paused."
        items={resource.data?.pausedHostels}
        render={(hostel) => (
          <Row
            actions={
              <RoleButton
                disabled={busy === hostel.id}
                onClick={() => void run(hostel.id, `${BASE}/hostels/${hostel.id}/pause`, { paused: false }, "Bookings back on. Its strikes are forgiven.")}
              >
                Resume bookings
              </RoleButton>
            }
            key={hostel.id}
          >
            <p className="font-bold text-foreground">
              {hostel.name} <SoftBadge tone={hostel.automatic ? "amber" : "slate"}>{hostel.automatic ? "strikes" : "by a superadmin"}</SoftBadge>
            </p>
            <p className="text-muted-foreground">
              Since {at(hostel.pausedAt)}
              {hostel.reason ? ` · ${hostel.reason}` : ""}
            </p>
          </Row>
        )}
        state={resource.state}
      />
    </Panel>
  );
}

/* ── Settings ──────────────────────────────────────────────────────────── */

const NUMBER_FIELDS: Array<{ key: keyof BookingConfig; label: string; suffix: string }> = [
  { key: "feePercent", label: "Booking fee", suffix: "% of one month's rent" },
  { key: "hostelSharePercent", label: "Hostel's share of what is kept", suffix: "%" },
  { key: "paymentCheckHours", label: "We check a screenshot within", suffix: "hours" },
  { key: "unpaidWindowHours", label: "Unpaid booking closes after", suffix: "hours" },
  { key: "hostelAnswerHours", label: "Hostel answers within", suffix: "hours" },
  { key: "holdDays", label: "Bed held for", suffix: "days" },
  { key: "noShowRefundPercent", label: "Refund for a no-show", suffix: "%" },
  { key: "strikeLimit", label: "Strikes that pause a hostel", suffix: "strikes" },
  { key: "strikeWindowDays", label: "Counted over", suffix: "days" },
  { key: "shortStayMinMarkupPercent", label: "Short stay: daily rate at least monthly ÷ 30 +", suffix: "%" },
  { key: "shortStayHostelSharePercent", label: "Short stay: hostel's share of the nights", suffix: "%" },
  { key: "shortStayMaxNights", label: "Short stay: longest stay", suffix: "nights" },
  { key: "shortStayMaxAdvanceDays", label: "Short stay: booked up to", suffix: "days ahead" },
];

const hoursList = (values: number[]) => values.join(", ");
const parseHours = (value: string) =>
  value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part > 0);

function SettingsForm({ config }: { config: BookingConfig }) {
  const [draft, setDraft] = useState(config);
  const [hostelReminders, setHostelReminders] = useState(hoursList(config.hostelReminderHoursLeft));
  const [moveInReminders, setMoveInReminders] = useState(hoursList(config.moveInReminderHoursLeft));
  const { busy, run } = useAction(REFRESH);

  const set = <K extends keyof BookingConfig>(key: K, value: BookingConfig[K]) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3 text-sm font-semibold text-foreground">
        <input checked={draft.enabled} onChange={(event) => set("enabled", event.target.checked)} type="checkbox" />
        Bookings are switched on
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        {NUMBER_FIELDS.map((field) => (
          <label className="text-sm text-muted-foreground" key={field.key}>
            {field.label}
            <div className="mt-1 flex items-center gap-2">
              <input
                className={FIELD}
                min={0}
                onChange={(event) => set(field.key, Number(event.target.value) as never)}
                step={field.key === "feePercent" ? 0.1 : 1}
                type="number"
                value={draft[field.key] as number}
              />
              <span className="shrink-0 text-xs">{field.suffix}</span>
            </div>
          </label>
        ))}
      </div>

      <div>
        <p className="text-sm font-semibold text-foreground">If the person cancels after confirmation</p>
        <div className="mt-2 space-y-2">
          {draft.cancelSteps.map((step, index) => (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" key={index}>
              Through day
              <input
                className={`${FIELD} w-20`}
                min={1}
                onChange={(event) =>
                  set("cancelSteps", draft.cancelSteps.map((row, at) => (at === index ? { ...row, throughDay: Number(event.target.value) } : row)))
                }
                type="number"
                value={step.throughDay}
              />
              refund
              <input
                className={`${FIELD} w-20`}
                max={100}
                min={0}
                onChange={(event) =>
                  set("cancelSteps", draft.cancelSteps.map((row, at) => (at === index ? { ...row, refundPercent: Number(event.target.value) } : row)))
                }
                type="number"
                value={step.refundPercent}
              />
              %
              <button
                aria-label="Remove step"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => set("cancelSteps", draft.cancelSteps.filter((_, at) => at !== index))}
                type="button"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <RoleButton
            onClick={() => {
              const last = draft.cancelSteps[draft.cancelSteps.length - 1];

              set("cancelSteps", [...draft.cancelSteps, { refundPercent: 0, throughDay: (last?.throughDay ?? 0) + 1 }]);
            }}
            variant="outline"
          >
            <Plus className="size-3.5" /> Add step
          </RoleButton>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-muted-foreground">
          Remind the hostel at hours left
          <input className={`${FIELD} mt-1`} onChange={(event) => setHostelReminders(event.target.value)} value={hostelReminders} />
        </label>
        <label className="text-sm text-muted-foreground">
          Remind the person at hours left on the hold
          <input className={`${FIELD} mt-1`} onChange={(event) => setMoveInReminders(event.target.value)} value={moveInReminders} />
        </label>
      </div>

      <RoleButton
        disabled={busy === "settings"}
        onClick={() =>
          void run(
            "settings",
            `${BASE}/settings`,
            { ...draft, hostelReminderHoursLeft: parseHours(hostelReminders), moveInReminderHoursLeft: parseHours(moveInReminders) },
            "Check your email to confirm the change.",
          )
        }
      >
        Save — confirm by email
      </RoleButton>
    </div>
  );
}

function SettingsTab() {
  const resource = usePortalResource<{ config: BookingConfig; pending: PendingSettingChange | null }>(`${BASE}/settings`);
  const { busy, run } = useAction(REFRESH);
  const pending = resource.data?.pending;

  return (
    <Panel title="Booking settings">
      {resource.state !== "ready" || !resource.data ? (
        <LoadingRows />
      ) : (
        <div className="space-y-5">
          {pending ? (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p>
                A change is waiting for the confirm link sent to {pending.sentTo}, until {at(pending.expiresAt)}. Nothing changes before
                it is opened.
              </p>
              <RoleButton
                disabled={busy === "cancel-change"}
                onClick={() => void run("cancel-change", `/api/v1/platform/setting-changes/${pending.id}`, {}, "Change cancelled.", "DELETE")}
                variant="outline"
              >
                Cancel change
              </RoleButton>
            </div>
          ) : null}
          <SettingsForm config={resource.data.config} key={JSON.stringify(resource.data.config)} />
        </div>
      )}
    </Panel>
  );
}

/* ── The page ──────────────────────────────────────────────────────────── */

const TABS = ["payments", "waiting", "holds", "refunds", "payouts", "accounts", "paused", "all", "settings"] as const;

type Tab = (typeof TABS)[number];

export function PlatformBookingsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested && (TABS as readonly string[]).includes(requested) ? requested : "payments";
  const counts = usePortalResource<BookingsResponse>(`${BASE}?tab=waiting`).data?.counts;
  const accounts = usePortalResource<{ accounts: PayoutAccountForReview[] }>(`${BASE}/payout-accounts?status=PENDING_REVIEW`).data?.accounts;

  return (
    <div className="space-y-4">
      <PortalPageHeader
        breadcrumb={["Platform", "Finance", "Bookings"]}
        description="Room bookings paid to us: check payments, chase hostels, send refunds and payouts."
        title="Bookings"
      />
      <TabBar
        onChange={(key) => router.replace(`${pathname}?tab=${key}`, { scroll: false })}
        tabs={[
          { count: counts?.payments, key: "payments", label: "Payments to check" },
          { count: counts?.waiting, key: "waiting", label: "Waiting on hostels" },
          { count: counts?.holds, key: "holds", label: "Holds" },
          { count: counts?.refundsDue, key: "refunds", label: "Refunds to send" },
          { count: counts?.payoutsDue, key: "payouts", label: "Payouts to send" },
          { count: accounts?.length, key: "accounts", label: "Payout accounts" },
          { key: "paused", label: "Paused hostels" },
          { key: "all", label: "All bookings" },
          { key: "settings", label: "Settings" },
        ]}
        value={tab}
      />
      {tab === "payments" ? <PaymentsTab /> : null}
      {tab === "waiting" || tab === "holds" || tab === "all" ? <BookingsTab key={tab} tab={tab} /> : null}
      {tab === "refunds" ? <TransfersTab kind="REFUND" /> : null}
      {tab === "payouts" ? <TransfersTab kind="PAYOUT" /> : null}
      {tab === "accounts" ? <AccountsTab /> : null}
      {tab === "paused" ? <PausedTab /> : null}
      {tab === "settings" ? <SettingsTab /> : null}
    </div>
  );
}
