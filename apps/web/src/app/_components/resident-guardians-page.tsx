"use client";

import { ShieldCheck, UserPlus } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  StatusBadge,
} from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
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
 * One row per shareable field. The copy is deliberately concrete about the
 * limit of each grant — a guardian seeing "complaint status" must not be
 * imagined by the resident as seeing the complaint text (PRD.md §10).
 */
const PERMISSION_FIELDS: Array<{ key: keyof GuardianPermissions; label: string }> = [
  { key: "canViewPayments", label: "Fee status (paid / unpaid / due)" },
  { key: "canViewReceipts", label: "Payment receipts" },
  { key: "canViewNotices", label: "Hostel notices" },
  { key: "canViewFood", label: "Food menu" },
  { key: "canViewSafety", label: "Night safety summary (day-level only)" },
  { key: "canViewComplaintStatus", label: "Complaint status (titles only)" },
];

export const ResidentGuardiansPageContent = memo(function ResidentGuardiansPageContent() {
  const [actionMessage, setActionMessage] = useState("");
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
    <div className="mx-auto max-w-[1448px] space-y-6">
      {confirmDialog}
      <ResidentHeader
        description="What a parent or guardian can see."
        icon={ShieldCheck}
        title="Guardians"
      />
      <Message value={message} />

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Panel title="My Guardians">
          {state === "loading" ? <LoadingRows /> : null}
          {state === "error" ? (
            <EmptyState label="Guardians could not be loaded." />
          ) : null}
          {state === "ready" && guardians.length === 0 ? (
            <EmptyState label="No guardian linked yet." />
          ) : null}
          <div className="space-y-3">
            {guardians.map((guardian) => (
              <div
                className="rounded-lg border border-border p-4"
                key={guardian.accessId}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground">{guardian.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {guardian.relation} · {guardian.email || guardian.phone}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge>{guardian.status}</StatusBadge>
                    {guardian.invitationPending ? (
                      <StatusBadge>INVITE PENDING</StatusBadge>
                    ) : null}
                  </div>
                </div>
                <div className="mt-4 grid gap-2">
                  {PERMISSION_FIELDS.map(({ key, label }) => (
                    <label
                      className="flex items-center gap-2 text-sm text-foreground"
                      key={key}
                    >
                      <input
                        checked={guardian.permissions[key]}
                        onChange={(event) =>
                          void togglePermission(
                            guardian.accessId,
                            key,
                            event.target.checked,
                          )
                        }
                        type="checkbox"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <button
                  className="mt-4 rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground"
                  onClick={() => void revoke(guardian.accessId)}
                  type="button"
                >
                  Remove access
                </button>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Invite a Guardian">
          <BusyForm className="grid gap-3" onSubmit={handleInvite}>
            <Input label="First name" name="firstName" required />
            <Input label="Last name" name="lastName" required />
            <Input label="Email" name="email" required type="email" />
            <Input label="Phone" name="phone" required />
            <Input
              label="Relation"
              name="relation"
              placeholder="Mother, father, uncle…"
              required
            />
            <div className="grid gap-2">
              <span className="text-sm font-semibold text-foreground">
                What they can see
              </span>
              {PERMISSION_FIELDS.map(({ key, label }) => (
                <label
                  className="flex items-center gap-2 text-sm text-foreground"
                  key={key}
                >
                  <input name={key} type="checkbox" />
                  {label}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                Anything left unchecked is never sent to them.
              </p>
            </div>
            <SubmitButton className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-role-resident text-sm font-semibold text-white">
              <UserPlus className="size-4" />
              Send invitation
            </SubmitButton>
          </BusyForm>
        </Panel>
      </div>
    </div>
  );
});
