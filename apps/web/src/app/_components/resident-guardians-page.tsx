"use client";

import { ShieldCheck, Trash2, UserPlus } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Input } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Glyph, type GlyphName } from "@/components/glyph";
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
import { residentEndpoints } from "@/lib/resident-endpoints";
import { cn } from "@/lib/utils";
import { CardSkeletons, ShareBar, titleCase } from "./daily-portal-ui";
import { EmptyInline, InitialsAvatar, RoleButton, SectionCard } from "./portal-dashboard-ui";
import { Message, ResidentHeader, field } from "./resident-shared";

type GuardianPermissions = {
  canViewComplaintStatus: boolean;
  canViewFood: boolean;
  canViewNotices: boolean;
  canViewPayments: boolean;
  canViewReceipts: boolean;
  canViewSafety: boolean;
};

type GuardianLink = {
  accessId: string;
  email: string;
  invitationPending: boolean;
  name: string;
  permissions: GuardianPermissions;
  phone: string;
  relation: string;
  status: string;
};

/**
 * One chip per shareable field. The labels stay concrete about the limit of
 * each grant — a guardian seeing "complaint titles" must not be imagined by
 * the resident as seeing the complaint text (PRD.md §10).
 */
const PERMISSION_FIELDS: Array<{ glyph: GlyphName; key: keyof GuardianPermissions; label: string }> = [
  { glyph: "wallet", key: "canViewPayments", label: "Fee status" },
  { glyph: "receipt", key: "canViewReceipts", label: "Receipts" },
  { glyph: "megaphone", key: "canViewNotices", label: "Notices" },
  { glyph: "restaurant", key: "canViewFood", label: "Food menu" },
  { glyph: "moon", key: "canViewSafety", label: "Night safety · day only" },
  { glyph: "chatbox-alert", key: "canViewComplaintStatus", label: "Complaint titles only" },
];

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition duration-150 active:scale-95";
const CHIP_ON = "border-transparent bg-foreground text-background";
const CHIP_OFF = "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground";

export const ResidentGuardiansPageContent = memo(function ResidentGuardiansPageContent() {
  const [actionMessage, setActionMessage] = useState("");
  const [inviting, setInviting] = useState(false);
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const guardiansResource = usePortalResource<{ guardians: GuardianLink[] }>(
    residentEndpoints.guardians,
    { errorMessage: "Could not load guardians." },
  );

  const guardians = useMemo(
    () => guardiansResource.data?.guardians ?? [],
    [guardiansResource.data],
  );
  const state = guardiansResource.state;
  const message = actionMessage || guardiansResource.message;

  const handleInvite = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      try {
        await browserApi(residentEndpoints.guardians, {
          body: JSON.stringify({
            email: field(form, "email"),
            firstName: field(form, "firstName"),
            lastName: field(form, "lastName"),
            permissions: Object.fromEntries(
              PERMISSION_FIELDS.map(({ key }) => [key, form.get(key) === "on"]),
            ),
            phone: field(form, "phone"),
            relation: field(form, "relation"),
          }),
          method: "POST",
        });
        formElement.reset();
        setInviting(false);
        setActionMessage("Invitation sent.");
        invalidate(residentEndpoints.guardians);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not send the invitation.",
        );
      }
    },
    [invalidate],
  );

  const togglePermission = useCallback(
    async (accessId: string, key: keyof GuardianPermissions, next: boolean) => {
      try {
        await browserApi(`${residentEndpoints.guardians}/${accessId}`, {
          body: JSON.stringify({ [key]: next }),
          method: "PATCH",
        });
        setActionMessage("Guardian access updated.");
        invalidate(residentEndpoints.guardians);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not update access.",
        );
      }
    },
    [invalidate],
  );

  const revoke = useCallback(
    async (accessId: string) => {
      const confirmed = await confirm({
        actionLabel: "Remove access",
        description:
          "They will immediately stop seeing your information and will need a new invitation to get it back.",
        title: "Remove this guardian's access?",
        tone: "destructive",
      });

      if (!confirmed) {
        return;
      }

      try {
        await browserApi(`${residentEndpoints.guardians}/${accessId}`, {
          method: "DELETE",
        });
        setActionMessage("Guardian access removed.");
        invalidate(residentEndpoints.guardians);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not remove access.",
        );
      }
    },
    [confirm, invalidate],
  );

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      {confirmDialog}
      <ResidentHeader
        actions={
          <RoleButton className="h-9 px-4" onClick={() => setInviting(true)} tone="team">
            <UserPlus className="size-4" />
            Invite guardian
          </RoleButton>
        }
        description="What a parent or guardian can see."
        icon={ShieldCheck}
        title="Guardians"
      />
      <Message value={message} />

      {state === "loading" ? <CardSkeletons count={2} /> : null}
      {state === "error" ? <EmptyState label="Guardians could not be loaded." /> : null}
      {state === "ready" && guardians.length === 0 ? (
        <SectionCard>
          <EmptyInline label="No guardian linked yet." />
        </SectionCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {guardians.map((guardian) => {
          const shared = PERMISSION_FIELDS.filter(({ key }) => guardian.permissions[key]).length;

          return (
            <article className="space-y-4 rounded-2xl border border-border/70 bg-card p-4" key={guardian.accessId}>
              <div className="flex items-center gap-3">
                <InitialsAvatar name={guardian.name} tone="team" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-heading text-[15px] font-semibold text-foreground">{guardian.name}</p>
                  <p className="truncate text-[12.5px] text-muted-foreground">
                    {guardian.relation} · {guardian.email || guardian.phone}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
                    guardian.invitationPending
                      ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                      : "bg-role-team-soft text-role-team",
                  )}
                >
                  {guardian.invitationPending ? "Invite pending" : titleCase(guardian.status)}
                </span>
              </div>

              <ShareBar label={`Sees ${shared} of ${PERMISSION_FIELDS.length}`} total={PERMISSION_FIELDS.length} value={shared} />

              <div className="flex flex-wrap gap-1.5">
                {PERMISSION_FIELDS.map(({ glyph, key, label }) => {
                  const on = guardian.permissions[key];

                  return (
                    <button
                      aria-pressed={on}
                      className={cn(CHIP_BASE, on ? CHIP_ON : CHIP_OFF)}
                      key={key}
                      onClick={() => void togglePermission(guardian.accessId, key, !on)}
                      type="button"
                    >
                      <Glyph className="size-3.5" name={glyph} />
                      {label}
                    </button>
                  );
                })}
              </div>

              <Button
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void revoke(guardian.accessId)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
                Remove access
              </Button>
            </article>
          );
        })}
      </div>

      <Dialog onOpenChange={setInviting} open={inviting}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Invite a guardian</DialogTitle>
            <DialogDescription>Anything you leave off is never sent to them.</DialogDescription>
          </DialogHeader>
          <BusyForm className="grid gap-3" onSubmit={handleInvite}>
            <div className="grid grid-cols-2 gap-3">
              <Input label="First name" name="firstName" required />
              <Input label="Last name" name="lastName" required />
              <Input label="Email" name="email" required type="email" />
              <Input label="Phone" name="phone" required />
            </div>
            <Input label="Relation" name="relation" placeholder="Mother, father, uncle…" required />
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                What they can see
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PERMISSION_FIELDS.map(({ glyph, key, label }) => (
                  // A real checkbox under the chip, so the form still posts "on".
                  <label className="cursor-pointer" key={key}>
                    <input className="peer sr-only" name={key} type="checkbox" />
                    <span
                      className={cn(
                        CHIP_BASE,
                        CHIP_OFF,
                        "peer-checked:border-transparent peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:ring-2 peer-focus-visible:ring-role-team",
                      )}
                    >
                      <Glyph className="size-3.5" name={glyph} />
                      {label}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <DialogFooter>
              <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">
                <UserPlus className="size-4" />
                Send invitation
              </SubmitButton>
            </DialogFooter>
          </BusyForm>
        </DialogContent>
      </Dialog>
    </div>
  );
});
