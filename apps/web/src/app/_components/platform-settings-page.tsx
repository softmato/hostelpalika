"use client";

import {
  AlertCircle,
  Building2,
  Check,
  Clock3,
  Copy,
  Flag,
  KeyRound,
  Loader2,
  Mail,
  MailX,
  ShieldCheck,
  ShieldHalf,
  Star,
  Trash2,
  UserPlus,
  Users,
  Wrench,
} from "@/components/icons";
import Link from "next/link";
import { memo, useEffect, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  DataTable,
  DetailField,
  FilterSelect,
  InitialsAvatar,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SoftBadge,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { TextField } from "@/app/_components/platform-config-shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { Role } from "@/lib/roles";
import { platformEndpoints } from "@/lib/platform-endpoints";
import {
  combineResources,
  useInvalidateResources,
  usePortalResource,
} from "@/lib/portal-query";
import { PlatformBroadcastPanel } from "./platform-broadcast-panel";
import { PlatformOperationsPanel } from "./platform-operations-panel";
import { Message, ReportRecord } from "./core-portal-shared";

type PlatformOwner = {
  email: string | null;
  emailVerified: boolean;
  id: string;
  name: string;
  phone: string | null;
  role: string;
  status: string;
};

type PlatformAdmin = {
  createdAt: string | null;
  email: string;
  id: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  name: string;
  phone: string;
  role: string;
  status: string;
};

type PlatformAdminInvite = {
  createdAt: string | null;
  email: string;
  expired: boolean;
  expiresAt: string;
  id: string;
  name: string;
  role: string;
  status: string;
};

type EmailCheck = {
  availability: "AVAILABLE" | "UPGRADEABLE" | "TAKEN";
  message: string;
  reason: string;
  sendable: boolean;
};

/**
 * How the new admin gets in.
 *
 * Both paths still exist because they answer different situations. An
 * invitation is the right default — nothing appears on the roster until the
 * person opens a link only their mailbox received, and they choose their own
 * password. But a platform whose email delivery is not configured cannot use
 * one at all, and that platform still needs to add an admin, which is what the
 * temporary password is for.
 */
type GrantMode = "invite" | "password";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CHECK_TONES: Record<
  EmailCheck["availability"],
  { className: string; icon: typeof Check }
> = {
  AVAILABLE: {
    className:
      "border-role-team/20 bg-role-team-soft text-role-team",
    icon: Check,
  },
  TAKEN: {
    className:
      "border-rose-200/80 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300",
    icon: AlertCircle,
  },
  UPGRADEABLE: {
    className:
      "border-amber-200/80 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    icon: AlertCircle,
  },
};

const ROLE_COPY: Record<string, { description: string; label: string }> = {
  [Role.PLATFORM_MODERATOR]: {
    description:
      "Approvals, verification, moderation and read-only reports. Cannot reach website config, fee plans, settings, report exports, or the admin roster.",
    label: "Platform Moderator",
  },
  [Role.SUPERADMIN]: {
    description:
      "Identical access to you, including the ability to create, promote, and revoke other platform admins.",
    label: "Superadmin",
  },
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function GrantModeSwitch({
  onChange,
  value,
}: {
  onChange: (value: GrantMode) => void;
  value: GrantMode;
}) {
  const options: { hint: string; label: string; value: GrantMode }[] = [
    { hint: "They set their own password", label: "Send an invite link", value: "invite" },
    { hint: "For when email is not set up", label: "Temporary password", value: "password" },
  ];

  return (
    <div
      aria-label="How they get access"
      className="inline-flex rounded-lg border border-border bg-background p-0.5"
      role="tablist"
    >
      {options.map((option) => (
        <button
          aria-selected={value === option.value}
          className={
            value === option.value
              ? "rounded-md bg-role-platform px-3 py-1.5 text-[11.5px] font-semibold text-white"
              : "rounded-md px-3 py-1.5 text-[11.5px] font-semibold text-muted-foreground transition hover:text-foreground"
          }
          key={option.value}
          onClick={() => onChange(option.value)}
          role="tab"
          title={option.hint}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The verdict on the typed address, under the field, as they type.
 *
 * Says nothing at all until the address is complete — a half-typed one is not
 * "unavailable", and colouring it red while somebody is still on the third
 * character is a rebuke for typing.
 */
function EmailCheckNote({
  checking,
  looksComplete,
  result,
  typed,
}: {
  checking: boolean;
  looksComplete: boolean;
  result: EmailCheck | null;
  typed: boolean;
}) {
  if (!typed || !looksComplete) {
    return null;
  }

  if (checking) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Checking whether this address is already in use…
      </p>
    );
  }

  // Checked, but the lookup itself failed. Silence rather than a spinner that
  // never stops — the submit is unlocked and the server checks again anyway.
  if (!result) {
    return null;
  }

  const tone = CHECK_TONES[result.availability];
  const Icon = tone.icon;

  return (
    <p
      className={`mt-1.5 flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] leading-4 ${tone.className}`}
      role="status"
    >
      <Icon className="mt-px size-3 shrink-0" />
      {result.message}
    </p>
  );
}

export const PlatformSettingsPageContent = memo(function PlatformSettingsPageContent() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteRole, setInviteRole] = useState<string>(Role.PLATFORM_MODERATOR);
  const [grantMode, setGrantMode] = useState<GrantMode>("invite");
  const [creating, setCreating] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [addingAdmin, setAddingAdmin] = useState(false);
  /*
   * The verdict is stored *with the address it was about*, not on its own.
   * Keying it that way is what lets "are we still checking?" be derived from a
   * comparison rather than tracked as a second flag that has to be flipped in
   * both directions — and a reply that lands after the field has moved on is
   * then simply not the current address, instead of a stale answer on screen.
   */
  const [emailCheck, setEmailCheck] = useState<{
    email: string;
    result: EmailCheck | null;
  } | null>(null);

  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const ownerResource = usePortalResource<{ user: PlatformOwner }>(
    platformEndpoints.currentUser,
    { errorMessage: "Could not load settings." },
  );
  const reportResource = usePortalResource<{ report: ReportRecord }>(
    platformEndpoints.dashboardReport,
    { errorMessage: "Could not load settings." },
  );
  const adminsResource = usePortalResource<{ admins: PlatformAdmin[] }>(
    platformEndpoints.admins,
  );
  const invitesResource = usePortalResource<{ invites: PlatformAdminInvite[] }>(
    platformEndpoints.adminInvites,
  );

  const owner = ownerResource.data?.user ?? null;
  const report = reportResource.data?.report ?? null;
  // A PLATFORM_MODERATOR gets 403 on the roster by design — show it empty rather
  // than surfacing an error they cannot act on, so its failure is not combined
  // into the page-level state below. The outstanding invitations are the same
  // shape of thing and are read the same way.
  const admins = adminsResource.data?.admins ?? [];
  const invites = invitesResource.data?.invites ?? [];
  const { state, message: loadMessage } = combineResources(ownerResource, reportResource);
  const pageError = error || loadMessage;

  // Only a full superadmin may manage admins; an acting superadmin sees the
  // roster read-only. The server enforces this too.
  const canManageAdmins = owner?.role === Role.SUPERADMIN;

  const trimmedEmail = inviteEmail.trim().toLowerCase();
  const emailLooksComplete = EMAIL_PATTERN.test(trimmedEmail);

  /*
   * Checked as they type, debounced, and only once the address is complete
   * enough to be one. Both grant paths refuse the same addresses, so the answer
   * belongs beside the field rather than behind the button — finding out that
   * an address is a warden's *after* pressing Create tells you the same thing
   * one wasted round trip later, and the older screen did exactly that.
   *
   * A failed lookup clears the note rather than blocking: the address may be
   * perfectly good, and the server re-checks on submit either way.
   */
  useEffect(() => {
    if (!emailLooksComplete) {
      return;
    }

    let cancelled = false;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await browserApi<EmailCheck>(
            `${platformEndpoints.adminEmailCheck}?email=${encodeURIComponent(trimmedEmail)}`,
          );

          if (!cancelled) {
            setEmailCheck({ email: trimmedEmail, result });
          }
        } catch {
          // Recorded as "checked, no answer" rather than left pending, so the
          // button unlocks: the address may be perfectly good, and the server
          // re-checks it on submit regardless.
          if (!cancelled) {
            setEmailCheck({ email: trimmedEmail, result: null });
          }
        }
      })();
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [emailLooksComplete, trimmedEmail]);

  const checkedEmail = emailCheck?.email === trimmedEmail ? emailCheck : null;
  const checkingEmail = emailLooksComplete && !checkedEmail;
  const emailBlocked = Boolean(checkedEmail?.result && !checkedEmail.result.sendable);
  const submitDisabled =
    creating || !emailLooksComplete || checkingEmail || emailBlocked;

  function resetForm() {
    setInviteEmail("");
    setInviteName("");
    setInvitePhone("");
    setEmailCheck(null);
  }

  async function createAdmin() {
    if (!inviteEmail.trim()) {
      setError("An email address is required.");
      return;
    }

    setCreating(true);
    setError("");
    setMessage("");
    setTemporaryPassword("");

    try {
      const result = await browserApi<{ temporaryPassword: string }>(
        platformEndpoints.admins,
        {
          body: JSON.stringify({
            email: inviteEmail.trim(),
            name: inviteName.trim() || undefined,
            phone: invitePhone.trim() || undefined,
            role: inviteRole,
          }),
          method: "POST",
        },
      );

      setMessage(
        `${ROLE_COPY[inviteRole]?.label ?? "Admin"} created — credentials emailed to ${trimmedEmail}.`,
      );
      setTemporaryPassword(result.temporaryPassword);
      resetForm();
      invalidate(platformEndpoints.admins);
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "Could not create admin.",
      );
    } finally {
      setCreating(false);
    }
  }

  /**
   * Sends the emailed link. Nothing is added to the roster here — the account
   * appears only when the recipient opens the link, which is the whole point of
   * this path, so the success line says so rather than implying it is done.
   */
  async function sendInvite() {
    if (!trimmedEmail) {
      setError("An email address is required.");
      return;
    }

    setCreating(true);
    setError("");
    setMessage("");
    setTemporaryPassword("");

    try {
      const result = await browserApi<{
        delivered: boolean;
        deliveryReason: string | null;
      }>(platformEndpoints.adminInvites, {
        body: JSON.stringify({
          email: trimmedEmail,
          name: inviteName.trim() || undefined,
          phone: invitePhone.trim() || undefined,
          role: inviteRole,
        }),
        method: "POST",
      });

      /*
       * An invitation with no delivered mail is a dead end — there is no
       * password to read off the screen and hand over — so a failed send is
       * said out loud rather than reported as success.
       */
      setMessage(
        result.delivered
          ? `Invitation sent to ${trimmedEmail}. They join the roster when they accept it.`
          : `The invitation was created, but the email could not be sent (${result.deliveryReason ?? "unknown"}). Withdraw it below and issue a temporary password instead until email delivery is configured.`,
      );
      resetForm();
      setAddingAdmin(false);
      invalidate(platformEndpoints.adminInvites);
    } catch (inviteError) {
      setError(
        inviteError instanceof Error
          ? inviteError.message
          : "Could not send the invitation.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function revokeInvite(inviteId: string, email: string) {
    const confirmed = await confirm({
      actionLabel: "Withdraw invitation",
      description: `The link sent to ${email} stops working immediately. Nothing was created on the roster, so there is nothing else to undo.`,
      title: "Withdraw this invitation?",
      tone: "destructive",
    });

    if (!confirmed) {
      return;
    }

    setError("");
    setMessage("");

    try {
      await browserApi(platformEndpoints.adminInvite(inviteId), { method: "DELETE" });
      setMessage("Invitation withdrawn.");
      invalidate(platformEndpoints.adminInvites);
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : "Could not withdraw the invitation.",
      );
    }
  }

  async function changeRole(adminId: string, role: string) {
    setError("");
    setMessage("");

    try {
      await browserApi(`${platformEndpoints.admins}/${adminId}`, {
        body: JSON.stringify({ role }),
        method: "PATCH",
      });
      setMessage("Access level updated.");
      invalidate(platformEndpoints.admins);
    } catch (roleError) {
      setError(roleError instanceof Error ? roleError.message : "Could not update role.");
    }
  }

  async function revoke(adminId: string, name: string) {
    const confirmed = await confirm({
      actionLabel: "Revoke access",
      description: `${name} will be suspended immediately and signed out of the platform portal.`,
      title: "Revoke platform access?",
      tone: "destructive",
    });

    if (!confirmed) {
      return;
    }

    setError("");
    setMessage("");

    try {
      await browserApi(`${platformEndpoints.admins}/${adminId}`, { method: "DELETE" });
      setMessage("Platform access revoked.");
      invalidate(platformEndpoints.admins);
    } catch (revokeError) {
      setError(
        revokeError instanceof Error ? revokeError.message : "Could not revoke access.",
      );
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      {confirmDialog}
      <PortalPageHeader
        actions={
          canManageAdmins ? (
            <RoleButton
              onClick={() => {
                setTemporaryPassword("");
                setAddingAdmin(true);
              }}
              tone="platform"
              type="button"
            >
              <UserPlus className="size-3.5" />
              Add admin
            </RoleButton>
          ) : null
        }
        description="Your account, who runs the platform, and how it behaves."
        title="Settings"
      />

      {message ? (
        <div className="flex items-center gap-2 rounded-xl border border-role-team/20 bg-role-team-soft px-3 py-2 text-[12.5px] font-medium text-role-team">
          <Check className="size-3.5 shrink-0" />
          {message}
        </div>
      ) : null}
      {pageError ? (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200/80 bg-rose-50 px-3 py-2 text-[12.5px] font-medium text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="size-3.5 shrink-0" />
          {pageError}
        </div>
      ) : null}
      <Message value="" />

      {state === "loading" ? <LoadingRows /> : null}
      {state === "error" ? <EmptyState label="Settings could not be loaded." /> : null}

      {state === "ready" ? (
        <>
          {canManageAdmins ? <PlatformBroadcastPanel /> : null}
          {canManageAdmins ? <PlatformOperationsPanel /> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Your Account">
              {owner ? (
                <div className="space-y-1">
                  <DetailField label="Name" value={owner.name} />
                  <DetailField label="Email" value={owner.email ?? "—"} />
                  <DetailField label="Phone" value={owner.phone ?? "—"} />
                  <DetailField
                    label="Access level"
                    value={
                      <SoftBadge tone="teal">
                        {ROLE_COPY[owner.role]?.label ?? owner.role}
                      </SoftBadge>
                    }
                  />
                  <DetailField
                    label="Status"
                    value={
                      <SoftBadge tone={statusToneFromLabel(owner.status)}>
                        {owner.status}
                      </SoftBadge>
                    }
                  />
                  <DetailField
                    label="Email verified"
                    value={
                      <SoftBadge tone={owner.emailVerified ? "green" : "amber"}>
                        {owner.emailVerified ? "Verified" : "Unverified"}
                      </SoftBadge>
                    }
                  />
                </div>
              ) : (
                <EmptyState label="Account is not loaded." />
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <RoleButton asChild tone="platform" variant="outline">
                  <Link href="/reset-password">
                    <KeyRound className="size-3.5" />
                    Change password
                  </Link>
                </RoleButton>
                <RoleButton asChild tone="platform" variant="outline">
                  <Link href="/platform/users">
                    <ShieldCheck className="size-3.5" />
                    Manage users
                  </Link>
                </RoleButton>
              </div>
            </Panel>

            <Panel title="Platform snapshot">
              <div className="grid grid-cols-2 gap-2.5">
                {[
                  { icon: Building2, label: "Hostels", value: report?.totalHostels },
                  { icon: Clock3, label: "Waiting approval", value: report?.pendingApprovals },
                  { icon: Users, label: "Active residents", value: report?.activeResidents },
                  { icon: Wrench, label: "Service providers", value: report?.serviceProviders },
                  { icon: Star, label: "Reviews", value: report?.reviews },
                  { icon: Flag, label: "Open listing flags", value: report?.openListingFlags },
                ].map((item) => (
                  <MetricCard
                    icon={item.icon}
                    key={item.label}
                    label={item.label}
                    value={Number(item.value ?? 0).toLocaleString()}
                  />
                ))}
              </div>
            </Panel>
          </div>

          {/* ── Platform access ─────────────────────────────────────── */}
          {canManageAdmins ? (
            <Dialog onOpenChange={setAddingAdmin} open={addingAdmin}>
              <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Add a platform admin</DialogTitle>
                  <DialogDescription>
                    {grantMode === "invite"
                      ? "They accept an emailed link and sign in with Google; the roster shows them once they do."
                      : "Created now with a temporary password, shown once; they change it on first login."}
                  </DialogDescription>
                </DialogHeader>

              <div className="space-y-3">
                {pageError ? <p className="text-[12.5px] font-medium text-destructive">{pageError}</p> : null}
                <GrantModeSwitch onChange={setGrantMode} value={grantMode} />

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <TextField
                      label="Email"
                      onChange={setInviteEmail}
                      placeholder="admin@example.com"
                      value={inviteEmail}
                    />
                    <EmailCheckNote
                      checking={checkingEmail}
                      looksComplete={emailLooksComplete}
                      result={checkedEmail?.result ?? null}
                      typed={inviteEmail.trim().length > 0}
                    />
                  </div>
                  <TextField
                    label="Full name"
                    onChange={setInviteName}
                    placeholder="Optional"
                    value={inviteName}
                  />
                  <TextField
                    label="Phone"
                    onChange={setInvitePhone}
                    placeholder="Optional"
                    value={invitePhone}
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
                  <FilterSelect
                    defaultLabel="Platform Moderator"
                    label="Access level"
                    onChange={(next) => setInviteRole(next || Role.PLATFORM_MODERATOR)}
                    options={[
                      { label: "Platform Moderator", value: Role.PLATFORM_MODERATOR },
                      { label: "Superadmin (full access)", value: Role.SUPERADMIN },
                    ]}
                    value={inviteRole}
                  />
                  <div className="flex items-end">
                    <p className="pb-2 text-[12px] leading-4 text-muted-foreground">
                      {ROLE_COPY[inviteRole]?.description}
                    </p>
                  </div>
                </div>

                <RoleButton
                  disabled={submitDisabled}
                  onClick={grantMode === "invite" ? sendInvite : createAdmin}
                  tone="platform"
                >
                  {creating ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : grantMode === "invite" ? (
                    <Mail className="size-3.5" />
                  ) : (
                    <UserPlus className="size-3.5" />
                  )}
                  {grantMode === "invite" ? "Send invitation" : "Create admin"}
                </RoleButton>

                {temporaryPassword ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <span className="font-semibold">Temporary password:</span>
                    <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono dark:bg-amber-900/50">
                      {temporaryPassword}
                    </code>
                    <button
                      className="inline-flex items-center gap-1 rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-semibold transition hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/50"
                      onClick={() =>
                        void navigator.clipboard.writeText(temporaryPassword)
                      }
                      type="button"
                    >
                      <Copy className="size-3" />
                      Copy
                    </button>
                    <span className="w-full text-[11px]">Shown once; it must be changed on first login.</span>
                  </div>
                ) : null}
              </div>
              </DialogContent>
            </Dialog>
          ) : null}

          {/* ── Outstanding invitations ──────────────────────────────
              Only rendered when there are any. An empty card here would be a
              permanent reminder of a thing that has not happened, on a screen
              whose other cards all state facts. */}
          {canManageAdmins && invites.length > 0 ? (
            <Panel title={`Invitations waiting · ${invites.length}`}>
              <DataTable className="min-w-[620px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Invited</Th>
                    <Th>Access level</Th>
                    <Th>Sent</Th>
                    <Th>Link expires</Th>
                    <Th align="right">Actions</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <InitialsAvatar
                            name={invite.name || invite.email}
                            size="sm"
                            tone="platform"
                          />
                          <div className="min-w-0">
                            <span className="block truncate font-semibold text-foreground">
                              {invite.name || invite.email}
                            </span>
                            {invite.name ? (
                              <p className="truncate text-[11px] text-muted-foreground">
                                {invite.email}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <SoftBadge
                          tone={invite.role === Role.SUPERADMIN ? "teal" : "slate"}
                        >
                          <span className="inline-flex items-center gap-1">
                            {invite.role === Role.SUPERADMIN ? (
                              <ShieldCheck className="size-3" />
                            ) : (
                              <ShieldHalf className="size-3" />
                            )}
                            {ROLE_COPY[invite.role]?.label ?? invite.role}
                          </span>
                        </SoftBadge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(invite.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {invite.expired ? (
                          <SoftBadge tone="amber">
                            <span className="inline-flex items-center gap-1">
                              <MailX className="size-3" />
                              Expired
                            </span>
                          </SoftBadge>
                        ) : (
                          <span className="text-muted-foreground">
                            {formatDate(invite.expiresAt)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end">
                          <button
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                            onClick={() => void revokeInvite(invite.id, invite.email)}
                            type="button"
                          >
                            <Trash2 className="size-3" />
                            Withdraw
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </Panel>
          ) : null}

          <Panel title={`Platform admins · ${admins.length}`}>
            {admins.length === 0 ? (
              <EmptyState
                label={
                  canManageAdmins
                    ? "No other platform admins yet."
                    : "Only a full superadmin can view the admin roster."
                }
              />
            ) : (
              <DataTable className="min-w-[720px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Admin</Th>
                    <Th>Access level</Th>
                    <Th>Status</Th>
                    <Th>Added</Th>
                    <Th>Last login</Th>
                    {canManageAdmins ? <Th align="right">Actions</Th> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admins.map((admin) => {
                    const isSelf = admin.id === owner?.id;

                    return (
                      <TableRow key={admin.id}>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <InitialsAvatar name={admin.name} size="sm" tone="platform" />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-[13.5px] font-semibold text-foreground">
                                  {admin.name}
                                </span>
                                {isSelf ? <SoftBadge tone="slate">You</SoftBadge> : null}
                              </div>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {admin.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <SoftBadge
                            tone={admin.role === Role.SUPERADMIN ? "teal" : "slate"}
                          >
                            <span className="inline-flex items-center gap-1">
                              {admin.role === Role.SUPERADMIN ? (
                                <ShieldCheck className="size-3" />
                              ) : (
                                <ShieldHalf className="size-3" />
                              )}
                              {ROLE_COPY[admin.role]?.label ?? admin.role}
                            </span>
                          </SoftBadge>
                        </TableCell>
                        <TableCell>
                          <SoftBadge tone={statusToneFromLabel(admin.status)}>
                            {admin.status}
                          </SoftBadge>
                          {admin.mustChangePassword ? (
                            <p className="mt-0.5 text-[10.5px] text-amber-600">
                              Password change pending
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(admin.createdAt)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(admin.lastLoginAt)}
                        </TableCell>
                        {canManageAdmins ? (
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <button
                                className="rounded-md px-2 py-1 text-[11px] font-semibold text-role-platform transition hover:bg-role-platform-soft"
                                onClick={() =>
                                  void changeRole(
                                    admin.id,
                                    admin.role === Role.SUPERADMIN
                                      ? Role.PLATFORM_MODERATOR
                                      : Role.SUPERADMIN,
                                  )
                                }
                                type="button"
                              >
                                {admin.role === Role.SUPERADMIN
                                  ? "Make moderator"
                                  : "Make superadmin"}
                              </button>
                              {isSelf ? null : (
                                <button
                                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                                  onClick={() => void revoke(admin.id, admin.name)}
                                  type="button"
                                >
                                  <Trash2 className="size-3" />
                                  Revoke
                                </button>
                              )}
                            </div>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </DataTable>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
});
