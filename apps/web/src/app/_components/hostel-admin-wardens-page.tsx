"use client";

import { KeyRound, Plus, Shield, ShieldOff, UserPlus, Users, X } from "lucide-react";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Input as FormInput, LoadingRows } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useHostelWardens, type Warden } from "@/hooks/use-hostel-admin";
import { browserApi } from "@/lib/browser-api";
import {
  DEFAULT_WARDEN_PERMISSIONS,
  WARDEN_PERMISSION_KEYS,
  type WardenPermissionKey,
} from "@/modules/wardens/warden.validation";

import { field, optionalField } from "./hostel-admin-shared";
import {
  DataTable,
  EmptyInline,
  InitialsAvatar,
  ListPager,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./portal-dashboard-ui";

type CreateWardenResult = {
  accountCreated: boolean;
  accountUpgraded: boolean;
  temporaryPassword: string | null;
  warden: Warden;
};

const PERMISSION_LABELS: Record<WardenPermissionKey, string> = {
  approvePayments: "Approve payment claims",
  editHostelProfile: "Edit hostel profile",
  manageFeeSchedule: "Set fees & bill residents",
  manageFood: "Manage food",
  manageMaintenance: "Manage maintenance",
  manageNotices: "Manage notices",
  managePaymentProfile: "Edit payment details",
  manageRooms: "Manage rooms & beds",
  recordCash: "Record cash payments",
  recordExpenses: "Add expenses",
  registerResidents: "Register residents",
  reversePayments: "Reverse & void payments",
  updateComplaints: "Update complaints",
  updateNightStatus: "Update night status",
  viewComplaints: "View complaints",
  viewPayments: "View payments",
  viewNightStatus: "View night status",
};

function PermissionGrid({
  onToggle,
  selected,
}: {
  onToggle: (key: WardenPermissionKey, checked: boolean) => void;
  selected: Set<string>;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {WARDEN_PERMISSION_KEYS.map((key) => (
        <label
          className="flex items-center gap-2 rounded-lg border border-border bg-muted/15 px-3 py-2 text-sm text-foreground"
          key={key}
        >
          <Checkbox
            checked={selected.has(key)}
            onCheckedChange={(value) => onToggle(key, value === true)}
          />
          {PERMISSION_LABELS[key]}
          {key === "recordExpenses" ? (
            <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Recommended
            </span>
          ) : null}
        </label>
      ))}
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
            onClick={() => setShowAddForm((value) => !value)}
            tone="admin"
            type="button"
          >
            <Plus className="size-4" />
            Add Warden
          </RoleButton>
        }
        description="Create warden accounts and control what each warden can do."
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

      {showAddForm ? (
        <SectionCard
          actions={
            <Button
              className="size-8"
              onClick={() => setShowAddForm(false)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          }
          description="An account is created or upgraded in place — no duplicate users."
          title="Add Warden"
        >
          <form className="space-y-4" onSubmit={handleCreateWarden}>
            <div className="grid gap-3 md:grid-cols-2">
              <FormInput label="Full name" name="name" required />
              <FormInput label="Email" name="email" required type="email" />
              <FormInput label="Phone" name="phone" />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-foreground">Permissions</p>
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
            <RoleButton loading={saving} tone="admin" type="submit">
              {saving ? null : <UserPlus className="size-4" />}
              Save Warden
            </RoleButton>
          </form>
        </SectionCard>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <SectionCard>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <SearchField
              onChange={setSearch}
              placeholder="Search by name, email, phone..."
              value={search}
            />
            <SoftBadge tone="cyan">
              <Users className="size-3" />
              Wardens: {filteredWardens.length}
            </SoftBadge>
          </div>

          {isPending ? <LoadingRows /> : null}
          {isError ? (
            <EmptyState label={loadError || "Wardens could not be loaded."} />
          ) : null}
          {!isPending && !isError && filteredWardens.length === 0 ? (
            <EmptyInline label="No wardens yet. Add your first warden." />
          ) : null}

          {!isPending && !isError && filteredWardens.length > 0 ? (
            <DataTable className="min-w-[560px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Warden
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Phone
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Permissions
                  </TableHead>
                  <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredWardens.map((warden) => {
                  const selected = selectedWarden?.id === warden.id;
                  return (
                    <TableRow
                      className={
                        selected
                          ? "cursor-pointer bg-role-admin-soft/50 data-[state=selected]:bg-role-admin-soft/50"
                          : "cursor-pointer"
                      }
                      data-state={selected ? "selected" : undefined}
                      key={warden.id}
                      onClick={() => setSelectedWardenId(warden.id)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <InitialsAvatar name={warden.name} size="sm" tone="admin" />
                          <div className="min-w-0">
                            <p className="font-semibold text-foreground">{warden.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {warden.email || "—"}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {warden.phone || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {warden.permissions.length}
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone={statusToneFromLabel(warden.status)}>
                          {warden.status.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </DataTable>
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
                  <p className="mb-2 text-sm font-semibold text-foreground">
                    Permissions
                  </p>
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
                    Save Permissions
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
              <EmptyInline label="Select a warden to manage permissions." />
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
});
