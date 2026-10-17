"use client";

import { Check, KeyRound, Plus, Shield, ShieldOff, UserPlus } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Input as FormInput, LoadingRows } from "@/app/_components/shared-ui";
import { Glyph, type GlyphName } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useHostelWardens, type Warden } from "@/hooks/use-hostel-admin";
import { browserApi } from "@/lib/browser-api";
import {
  DEFAULT_WARDEN_PERMISSIONS,
  WARDEN_PERMISSION_KEYS,
  type WardenPermissionKey,
} from "@/modules/wardens/warden.validation";

import { field, optionalField } from "./hostel-admin-shared";
import {
  EmptyInline,
  InitialsAvatar,
  ListPager,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
} from "./portal-dashboard-ui";

type CreateWardenResult = {
  accountCreated: boolean;
  accountUpgraded: boolean;
  temporaryPassword: string | null;
  warden: Warden;
};

const PERMISSION_LABELS: Record<WardenPermissionKey, string> = {
  approvePayments: "Approve claims",
  editHostelProfile: "Edit hostel profile",
  manageFeeSchedule: "Set fees & bill",
  manageFood: "Food menu",
  manageMaintenance: "Maintenance",
  manageNotices: "Notices",
  managePaymentProfile: "Payment details",
  manageRooms: "Rooms & beds",
  manageStock: "Stock",
  approveStockCount: "Approve counts",
  recordCash: "Record cash",
  recordExpenses: "Add expenses",
  // Shown inverted below: the chip reads "Bill photo needed" and is on while
  // this waiver is absent.
  expenseWithoutProof: "Bill photo needed",
  registerResidents: "Register residents",
  reversePayments: "Reverse & void",
  updateComplaints: "Update complaints",
  updateNightStatus: "Update night status",
  viewComplaints: "View complaints",
  viewPayments: "View payments",
  viewNightStatus: "View night status",
};

/** The permissions in four areas, each a card with its own mark. */
const PERMISSION_GROUPS: { glyph: GlyphName; keys: WardenPermissionKey[]; title: string }[] = [
  { glyph: "people", keys: ["registerResidents", "manageRooms", "editHostelProfile"], title: "Residents & rooms" },
  {
    glyph: "wallet",
    keys: ["viewPayments", "approvePayments", "recordCash", "reversePayments", "manageFeeSchedule", "managePaymentProfile"],
    title: "Money",
  },
  {
    glyph: "clipboard",
    keys: ["manageFood", "manageNotices", "viewComplaints", "updateComplaints", "viewNightStatus", "updateNightStatus", "manageMaintenance"],
    title: "Daily work",
  },
  { glyph: "cube", keys: ["recordExpenses", "expenseWithoutProof", "manageStock", "approveStockCount"], title: "Spending & stock" },
];

/** Stored as a waiver, offered as a rule — on by default for every warden. */
const PROOF_WAIVER: WardenPermissionKey = "expenseWithoutProof";

/** Whether a permission chip reads "on". The proof waiver is shown inverted. */
function isOn(key: WardenPermissionKey, selected: Set<string>) {
  return key === PROOF_WAIVER ? !selected.has(key) : selected.has(key);
}

/**
 * Permissions as four area cards of toggle chips. A chip is on when it is green
 * with a tick; "All" flips the whole area. Any key added later that no area
 * names lands in "Other", so nothing silently disappears from the screen.
 */
function PermissionGrid({
  onToggle,
  selected,
}: {
  onToggle: (key: WardenPermissionKey, checked: boolean) => void;
  selected: Set<string>;
}) {
  const grouped = new Set(PERMISSION_GROUPS.flatMap((group) => group.keys));
  const other = WARDEN_PERMISSION_KEYS.filter((key) => !grouped.has(key));
  const groups = other.length > 0 ? [...PERMISSION_GROUPS, { glyph: "ellipsis-horizontal" as GlyphName, keys: other, title: "Other" }] : PERMISSION_GROUPS;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groups.map((group) => {
        const onCount = group.keys.filter((key) => isOn(key, selected)).length;
        const allOn = onCount === group.keys.length;

        return (
          <div className="rounded-2xl border border-border/70 bg-card p-3.5" key={group.title}>
            <div className="mb-3 flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                <Glyph className="size-4" name={group.glyph} />
              </span>
              <p className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">{group.title}</p>
              <span className="text-[11.5px] font-semibold text-muted-foreground">
                {onCount}/{group.keys.length}
              </span>
              <button
                className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-role-team transition hover:bg-role-team-soft"
                onClick={() => group.keys.forEach((key) => onToggle(key, key === PROOF_WAIVER ? allOn : !allOn))}
                type="button"
              >
                {allOn ? "None" : "All"}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {group.keys.map((key) => {
                const on = isOn(key, selected);

                return (
                  <button
                    aria-pressed={on}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition duration-150 active:scale-95",
                      on
                        ? "border-transparent bg-role-team-soft text-role-team"
                        : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                    )}
                    key={key}
                    onClick={() => onToggle(key, key === PROOF_WAIVER ? on : !on)}
                    type="button"
                  >
                    {on ? <Check className="size-3.5" strokeWidth={2.2} /> : null}
                    {PERMISSION_LABELS[key]}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const HostelAdminWardensPage = memo(function HostelAdminWardensPage() {
  const wardensResource = useHostelWardens();
  const { data, message: loadError, refreshAsync: refetch } = wardensResource;
  const isPending = wardensResource.state === "loading";
  const isError = wardensResource.state === "error";
  const wardens = useMemo(() => data?.wardens ?? [], [data]);

  const [selectedWardenId, setSelectedWardenId] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issuedPassword, setIssuedPassword] = useState("");
  const [formPermissions, setFormPermissions] = useState<Set<string>>(
    () => new Set(DEFAULT_WARDEN_PERMISSIONS),
  );
  // Draft edits for the detail panel, tagged with the warden they belong to so
  // switching the selected warden falls back to that warden's saved permissions
  // without a state-syncing effect.
  const [permissionDraft, setPermissionDraft] = useState<{
    perms: Set<string>;
    wardenId: string;
  } | null>(null);

  const selectedWarden =
    wardens.find((warden) => warden.id === selectedWardenId) ?? wardens[0];

  const editPermissions = useMemo(() => {
    if (permissionDraft && permissionDraft.wardenId === selectedWarden?.id) {
      return permissionDraft.perms;
    }
    return new Set<string>(selectedWarden?.permissions ?? []);
  }, [permissionDraft, selectedWarden]);

  const filteredWardens = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return wardens;
    }
    return wardens.filter((warden) =>
      [warden.name, warden.email, warden.phone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [search, wardens]);

  const handleCreateWarden = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      setSaving(true);
      try {
        const result = await browserApi<CreateWardenResult>(
          "/api/v1/hostel-admin/wardens",
          {
            body: JSON.stringify({
              email: field(form, "email"),
              name: field(form, "name"),
              permissions: Array.from(formPermissions),
              phone: optionalField(form, "phone"),
            }),
            method: "POST",
          },
        );

        formElement.reset();
        setFormPermissions(new Set(DEFAULT_WARDEN_PERMISSIONS));
        setShowAddForm(false);
        setIssuedPassword(result.temporaryPassword ?? "");
        setMessage(
          result.accountCreated
            ? "Warden account created — credentials emailed."
            : result.accountUpgraded
              ? "Existing account upgraded to warden."
              : "Warden saved.",
        );
        await refetch();
        setSelectedWardenId(result.warden.id);
      } catch (submitError) {
        setMessage(
          submitError instanceof Error ? submitError.message : "Could not create warden.",
        );
      } finally {
        setSaving(false);
      }
    },
    [formPermissions, refetch],
  );

  const handleSavePermissions = useCallback(async () => {
    if (!selectedWarden) {
      return;
    }

    try {
      await browserApi(`/api/v1/hostel-admin/wardens/${selectedWarden.id}`, {
        body: JSON.stringify({ permissions: Array.from(editPermissions) }),
        method: "PATCH",
      });
      setPermissionDraft(null);
      setMessage("Permissions updated.");
      await refetch();
    } catch (submitError) {
      setMessage(
        submitError instanceof Error
          ? submitError.message
          : "Could not update permissions.",
      );
    }
  }, [editPermissions, refetch, selectedWarden]);

  const handleToggleStatus = useCallback(async () => {
    if (!selectedWarden) {
      return;
    }

    const reactivate = selectedWarden.status !== "ACTIVE";

    try {
      if (reactivate) {
        await browserApi(`/api/v1/hostel-admin/wardens/${selectedWarden.id}`, {
          body: JSON.stringify({ status: "ACTIVE" }),
          method: "PATCH",
        });
        setMessage("Warden reactivated.");
      } else {
        await browserApi(`/api/v1/hostel-admin/wardens/${selectedWarden.id}`, {
          method: "DELETE",
        });
        setMessage("Warden deactivated.");
      }
      await refetch();
    } catch (submitError) {
      setMessage(
        submitError instanceof Error
          ? submitError.message
          : "Could not update warden status.",
      );
    }
  }, [refetch, selectedWarden]);

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PortalPageHeader
        actions={
          <RoleButton
            onClick={() => setShowAddForm(true)}
            tone="admin"
            type="button"
          >
            <Plus className="size-4" />
            Add Warden
          </RoleButton>
        }
        description="Who helps run the hostel, and what each of them can do."
        title="Wardens"
      />

      {message ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
          {message}
        </div>
      ) : null}

      {issuedPassword ? (
        <div className="rounded-xl border border-role-admin/30 bg-role-admin-soft/50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="size-4" /> Temporary password
          </p>
          <p className="mt-2 font-mono text-lg font-bold tracking-wide text-role-admin">
            {issuedPassword}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Share this securely if the warden did not receive the email. They will be
            asked to change it on first login.
          </p>
        </div>
      ) : null}

      <Dialog onOpenChange={setShowAddForm} open={showAddForm}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add a warden</DialogTitle>
            <DialogDescription>An existing account is upgraded in place, never duplicated.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreateWarden}>
            <div className="grid gap-3 md:grid-cols-2">
              <FormInput label="Full name" name="name" required />
              <FormInput label="Email" name="email" required type="email" />
              <FormInput label="Phone" name="phone" />
            </div>
            <div>
              <PermissionGrid
                onToggle={(key, checked) =>
                  setFormPermissions((current) => {
                    const next = new Set(current);
                    if (checked) {
                      next.add(key);
                    } else {
                      next.delete(key);
                    }
                    return next;
                  })
                }
                selected={formPermissions}
              />
            </div>
            <div className="flex justify-end">
              <RoleButton loading={saving} tone="admin" type="submit">
                {saving ? null : <UserPlus className="size-4" />}
                Save warden
              </RoleButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <SectionCard>
          <div className="mb-3">
            <SearchField
              onChange={setSearch}
              placeholder="Search wardens"
              value={search}
            />
          </div>

          {isPending ? <LoadingRows /> : null}
          {isError ? (
            <EmptyState label={loadError || "Wardens could not be loaded."} />
          ) : null}
          {!isPending && !isError && filteredWardens.length === 0 ? (
            <EmptyInline label="No wardens yet. Add your first warden." />
          ) : null}

          {!isPending && !isError && filteredWardens.length > 0 ? (
            <div className="space-y-1.5">
              {filteredWardens.map((warden) => {
                const selected = selectedWarden?.id === warden.id;
                const share = Math.round((warden.permissions.length / WARDEN_PERMISSION_KEYS.length) * 100);

                return (
                  <button
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition duration-150",
                      selected ? "bg-role-team-soft" : "hover:bg-muted",
                    )}
                    key={warden.id}
                    onClick={() => setSelectedWardenId(warden.id)}
                    type="button"
                  >
                    <InitialsAvatar name={warden.name} size="sm" tone="admin" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13.5px] font-semibold text-foreground">{warden.name}</p>
                        {warden.status === "ACTIVE" ? null : (
                          <SoftBadge tone={statusToneFromLabel(warden.status)}>{warden.status.replaceAll("_", " ")}</SoftBadge>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-brand-teal" style={{ width: `${share}%` }} />
                        </div>
                        <span className="text-[11px] font-semibold text-muted-foreground">
                          {warden.permissions.length}/{WARDEN_PERMISSION_KEYS.length}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          {wardensResource.pagination && wardensResource.pagination.totalPages > 1 ? (
            <ListPager
              onPageChange={wardensResource.setPage}
              page={wardensResource.pagination.page}
              pageSize={wardensResource.pagination.pageSize}
              tone="admin"
              total={wardensResource.pagination.total}
              unit="wardens"
            />
          ) : null}
        </SectionCard>

        <div className="space-y-5">
          <SectionCard>
            {selectedWarden ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <InitialsAvatar name={selectedWarden.name} size="lg" tone="admin" />
                  <div className="min-w-0">
                    <p className="text-lg font-bold text-foreground">
                      {selectedWarden.name}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {selectedWarden.email || selectedWarden.phone || "—"}
                    </p>
                    <div className="mt-2">
                      <SoftBadge tone={statusToneFromLabel(selectedWarden.status)}>
                        {selectedWarden.status.replaceAll("_", " ")}
                      </SoftBadge>
                    </div>
                  </div>
                </div>

                <div>
                  <PermissionGrid
                    onToggle={(key, checked) => {
                      const next = new Set(editPermissions);
                      if (checked) {
                        next.add(key);
                      } else {
                        next.delete(key);
                      }
                      setPermissionDraft({ perms: next, wardenId: selectedWarden.id });
                    }}
                    selected={editPermissions}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <RoleButton onClick={handleSavePermissions} tone="admin" type="button">
                    <Shield className="size-4" />
                    Save
                  </RoleButton>
                  <Button
                    className="gap-2 rounded-xl"
                    onClick={handleToggleStatus}
                    type="button"
                    variant="outline"
                  >
                    <ShieldOff className="size-4" />
                    {selectedWarden.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyInline label="Pick a warden to set what they can do." />
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
});
