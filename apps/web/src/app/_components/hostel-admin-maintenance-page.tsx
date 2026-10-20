"use client";

import React, { useCallback, useMemo, useState, type FormEvent } from "react";
import { CalendarClock, CheckCircle2, Plus, Sparkles, Users, Wrench } from "@/components/icons";
import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
} from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { Chip, RowMark, type ChipTone } from "@/app/_components/hostel-admin-page-ui";
import { InitialsAvatar, MetricCard, RoleButton, SearchField } from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import {
  categoryForRole,
  PROVIDER_ROLES,
  providerRoleLabel,
  suggestPriority,
  suggestProviderRoles,
  titleFromProblem,
} from "@/lib/maintenance-role-suggest";
import {
  combineResources,
  useInvalidateResources,
  usePortalResource,
} from "@/lib/portal-query";
import {
  Message,
  optionalField,
  type MaintenanceRequest,
  type ServiceProvider,
} from "./portal-shared";
import { PageHeader } from "./core-portal-shared";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const STATUS_ACTIONS = ["CONTACTED", "SCHEDULED", "COMPLETED", "CANCELLED"];

/** docs/DESIGN.md: completed green, scheduled/contacted amber, cancelled red, pending grey. */
const STATUS_TONE: Record<string, ChipTone> = {
  CANCELLED: "bad",
  COMPLETED: "brand",
  CONTACTED: "warn",
  SCHEDULED: "warn",
};

function words(value: string) {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const HostelAdminMaintenancePageContent = React.memo(
  function HostelAdminMaintenancePageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [problem, setProblem] = useState("");
    // Once the admin picks a role by hand we stop overwriting it from keywords.
    const [manualRole, setManualRole] = useState("");
    const [providerId, setProviderId] = useState("");
    const [raising, setRaising] = useState(false);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("ALL");
    const invalidate = useInvalidateResources();
    const providersResource = usePortalResource<{ providers: ServiceProvider[] }>(
      hostelAdminEndpoints.serviceProviders,
      { errorMessage: "Could not load providers." },
    );
    const requestsResource = usePortalResource<{ requests: MaintenanceRequest[] }>(
      hostelAdminEndpoints.maintenanceRequests,
      { errorMessage: "Could not load maintenance." },
    );

    const providers = useMemo(
      () => providersResource.data?.providers ?? [],
      [providersResource.data],
    );
    const requests = useMemo(
      () => requestsResource.data?.requests ?? [],
      [requestsResource.data],
    );
    const combined = combineResources(providersResource, requestsResource);
    const state = combined.state;
    const message = actionMessage || combined.message;

    const suggestions = useMemo(() => suggestProviderRoles(problem), [problem]);
    const suggestedRole = suggestions[0]?.role ?? "";
    // Manual choice wins; otherwise follow whatever the keywords point at.
    const role = manualRole || suggestedRole;
    const priority = useMemo(() => suggestPriority(problem), [problem]);
    const matchingProviders = useMemo(
      () => providers.filter((provider) => !role || provider.category === role),
      [providers, role],
    );

    const shownRequests = useMemo(() => {
      const query = search.trim().toLowerCase();

      return requests.filter(
        (request) =>
          (statusFilter === "ALL" || request.status === statusFilter) &&
          (!query || `${request.title} ${request.description ?? ""}`.toLowerCase().includes(query)),
      );
    }, [requests, search, statusFilter]);
    const countOf = (...statuses: string[]) =>
      requests.filter((request) => statuses.includes(request.status)).length;
    const requestStatuses = [...new Set(requests.map((request) => request.status))];

    const chooseRole = useCallback((next: string) => {
      setManualRole(next);
      setProviderId("");
    }, []);

    const create = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const title = titleFromProblem(problem);

        if (title.length < 2) {
          setActionMessage("Describe the problem before raising a request.");
          return;
        }

        try {
          await browserApi(hostelAdminEndpoints.maintenanceRequests, {
            body: JSON.stringify({
              category: categoryForRole(role),
              costNote: optionalField(form, "costNote"),
              description: problem.trim(),
              location: optionalField(form, "location"),
              priority: form.get("priority") || priority,
              providerId: providerId || undefined,
              title,
            }),
            method: "POST",
          });
          formElement.reset();
          setProblem("");
          setManualRole("");
          setProviderId("");
          setRaising(false);
          setActionMessage("Maintenance request raised.");
          invalidate(
            hostelAdminEndpoints.maintenanceRequests,
            hostelAdminEndpoints.maintenanceReport,
          );
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not create request.",
          );
        }
      },
      [invalidate, priority, problem, providerId, role],
    );

    const updateStatus = useCallback(
      async (requestId: string, status: string) => {
        try {
          await browserApi(
            `${hostelAdminEndpoints.maintenanceRequests}/${requestId}/status`,
            {
              body: JSON.stringify({ status }),
              method: "PATCH",
            },
          );
          invalidate(
            hostelAdminEndpoints.maintenanceRequests,
            hostelAdminEndpoints.maintenanceReport,
          );
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update request.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          action={
            <RoleButton className="h-9 rounded-xl" onClick={() => setRaising(true)} tone="admin" type="button">
              <Plus className="size-4" />
              Raise request
            </RoleButton>
          }
          description="Report a problem and track every repair."
          icon={Wrench}
          title="Maintenance & Providers"
        />
        {raising ? null : <Message value={message} />}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={Wrench}
            label="Open"
            value={requests.length - countOf("COMPLETED", "CANCELLED")}
          />
          <MetricCard
            icon={CalendarClock}
            label="Contacted or scheduled"
            tone="amber"
            value={countOf("CONTACTED", "SCHEDULED")}
          />
          <MetricCard icon={CheckCircle2} label="Completed" value={countOf("COMPLETED")} />
          <MetricCard icon={Users} label="Providers" value={providers.length} />
        </div>

        <Dialog onOpenChange={setRaising} open={raising}>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Raise a request</DialogTitle>
              <DialogDescription>Describe it; we suggest who to send it to as you type.</DialogDescription>
            </DialogHeader>
            <Message value={message} />
          <BusyForm className="space-y-4" onSubmit={create}>
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
              <label className="grid gap-2 text-[13.5px] font-semibold text-foreground">
                What is the problem?
                <textarea
                  className="min-h-32 rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] font-normal outline-none focus:border-brand-teal"
                  name="problem"
                  onChange={(event) => setProblem(event.target.value)}
                  placeholder="e.g. Tap in room 204 bathroom is leaking since morning"
                  value={problem}
                />
              </label>

              <div className="grid content-start gap-3 rounded-xl bg-muted/50 p-3">
                <Select
                  label="Service provider role"
                  name="role"
                  onChange={(event) => chooseRole(event.target.value)}
                  value={role}
                >
                  <option value="">Not decided yet</option>
                  {PROVIDER_ROLES.map((option) => (
                    <option key={option} value={option}>
                      {providerRoleLabel(option)}
                    </option>
                  ))}
                </Select>

                {suggestions.length > 0 ? (
                  <div className="grid gap-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      Suggested from your words
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {suggestions.map((suggestion) => (
                        <button
                          className={
                            suggestion.role === role
                              ? "rounded-full border border-transparent bg-foreground px-3 py-1.5 text-[12px] font-semibold text-background"
                              : "rounded-full border border-border px-3 py-1.5 text-[12px] font-semibold text-foreground"
                          }
                          key={suggestion.role}
                          onClick={() => chooseRole(suggestion.role)}
                          title={`Matched: ${suggestion.matched.join(", ")}`}
                          type="button"
                        >
                          {providerRoleLabel(suggestion.role)}
                        </button>
                      ))}
                    </div>
                    {manualRole ? (
                      <button
                        className="justify-self-start text-[11px] font-semibold text-role-admin underline"
                        onClick={() => chooseRole("")}
                        type="button"
                      >
                        Use the suggestion instead
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[11.5px] text-muted-foreground">
                    Type the problem and a role is suggested.
                  </p>
                )}

                <Select
                  label="Assign provider"
                  name="providerId"
                  onChange={(event) => setProviderId(event.target.value)}
                  value={providerId}
                >
                  <option value="">Send to every provider (first to accept)</option>
                  {matchingProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.fullName} / {provider.area}
                    </option>
                  ))}
                </Select>
                {role && matchingProviders.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    No approved {providerRoleLabel(role).toLowerCase()} yet — any provider can accept it.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <Input label="Location" name="location" placeholder="Room 204, 2nd floor" />
              <Select
                key={priority}
                defaultValue={priority}
                label="Priority"
                name="priority"
              >
                {PRIORITIES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
              <Input label="Cost note" name="costNote" placeholder="Approx. Rs. 1500" />
            </div>

            <DialogFooter>
              <SubmitButton className="h-10 rounded-xl bg-brand-teal px-5 text-white hover:bg-brand-teal/90">
                Raise request
              </SubmitButton>
            </DialogFooter>
          </BusyForm>
          </DialogContent>
        </Dialog>

        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="History">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <SearchField onChange={setSearch} placeholder="Search requests" size="lg" value={search} />
              <FilterButton active={statusFilter === "ALL" ? 0 : 1} onClear={() => setStatusFilter("ALL")}>
                <FilterChoice
                  label="Status"
                  onChange={setStatusFilter}
                  options={[
                    { label: "All", value: "ALL" },
                    ...requestStatuses.map((status) => ({ label: words(status), value: status })),
                  ]}
                  value={statusFilter}
                />
              </FilterButton>
            </div>
            {state === "loading" ? <LoadingRows /> : null}
            {state === "error" ? (
              <EmptyState label="Requests could not be loaded." />
            ) : null}
            {state === "ready" && shownRequests.length === 0 ? (
              <EmptyState label={requests.length === 0 ? "No maintenance requests yet." : "Nothing matches."} />
            ) : null}
            <div className="divide-y divide-border/60">
              {shownRequests.map((request) => (
                <div className="flex items-start gap-3 py-3" key={request.id}>
                  <RowMark
                    glyph="build"
                    tone={request.priority === "URGENT" || request.priority === "HIGH" ? "warn" : "brand"}
                  />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="text-[13.5px] font-semibold text-foreground">{request.title}</p>
                    {request.description || request.costNote ? (
                      <p className="line-clamp-2 text-[13px] text-muted-foreground">
                        {request.description || request.costNote}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-1.5">
                      <Chip tone={STATUS_TONE[request.status] ?? "neutral"}>{words(request.status)}</Chip>
                      <Chip glyph="pricetag">{words(request.category)}</Chip>
                      <Chip glyph="flag" tone={request.priority === "URGENT" ? "warn" : "neutral"}>
                        {words(request.priority)}
                      </Chip>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" type="button" variant="outline">
                        Set status
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {STATUS_ACTIONS.map((status) => (
                        <DropdownMenuItem key={status} onSelect={() => void updateStatus(request.id, status)}>
                          {words(status)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title={
              role ? `Approved ${providerRoleLabel(role)}s` : "Approved Service Providers"
            }
          >
            {state === "loading" ? <LoadingRows /> : null}
            {state === "ready" && matchingProviders.length === 0 ? (
              <EmptyState label="No approved providers." />
            ) : null}
            <div className="divide-y divide-border/60">
              {matchingProviders.map((provider) => (
                <div className="flex items-start gap-3 py-2.5" key={provider.id}>
                  <InitialsAvatar name={provider.fullName} size="sm" tone="admin" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold text-foreground">{provider.fullName}</p>
                    <p className="truncate text-[12px] text-muted-foreground">
                      {providerRoleLabel(provider.category)} · {provider.area} · {provider.phone}
                    </p>
                    {provider.availability || provider.description ? (
                      <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
                        {provider.availability || provider.description}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    );
  },
);
