"use client";

import React, { useCallback, useMemo, useState, type FormEvent } from "react";
import { Sparkles, Wrench } from "@/components/icons";
import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
  StatusBadge,
} from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
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
  PageHeader,
  optionalField,
  type MaintenanceRequest,
  type ServiceProvider,
} from "./portal-shared";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const STATUS_ACTIONS = ["CONTACTED", "SCHEDULED", "COMPLETED", "CANCELLED"];

export const HostelAdminMaintenancePageContent = React.memo(
  function HostelAdminMaintenancePageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [problem, setProblem] = useState("");
    // Once the admin picks a role by hand we stop overwriting it from keywords.
    const [manualRole, setManualRole] = useState("");
    const [providerId, setProviderId] = useState("");
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
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PageHeader
          description="Describe a problem, get the right provider suggested, and track every repair in one place."
          icon={Wrench}
          title="Maintenance & Providers"
        />
        <Message value={message} />

        <Panel title="Raise a Request">
          <BusyForm className="space-y-4" onSubmit={create}>
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
              <label className="grid gap-2 text-sm font-semibold text-foreground">
                What is the problem?
                <textarea
                  className="min-h-32 rounded-md border border-border bg-background px-3 py-2 text-sm font-normal outline-none focus:border-role-admin"
                  name="problem"
                  onChange={(event) => setProblem(event.target.value)}
                  placeholder="e.g. Tap in room 204 bathroom is leaking since morning"
                  value={problem}
                />
                <span className="text-[11px] font-normal text-muted-foreground">
                  We read this as you type and suggest the provider role on the right.
                </span>
              </label>

              <div className="grid content-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
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
                              ? "rounded-full border border-role-admin bg-role-admin px-3 py-1.5 text-xs font-semibold text-white"
                              : "rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground"
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
                  <p className="text-[11px] text-muted-foreground">
                    Start typing the problem — a role is suggested automatically. You can
                    also pick one yourself.
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
                  <p className="text-[11px] text-muted-foreground">
                    No approved {providerRoleLabel(role).toLowerCase()} yet — raise it and
                    any provider can accept it from their jobs board.
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

            <SubmitButton className="h-11 rounded-md bg-role-admin px-6 text-sm font-semibold text-white">
              Raise Request
            </SubmitButton>
          </BusyForm>
        </Panel>

        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Maintenance History">
            {state === "loading" ? <LoadingRows /> : null}
            {state === "error" ? (
              <EmptyState label="Requests could not be loaded." />
            ) : null}
            {state === "ready" && requests.length === 0 ? (
              <EmptyState label="No maintenance requests yet." />
            ) : null}
            <div className="space-y-3">
              {requests.map((request) => (
                <div className="rounded-lg border border-border p-4" key={request.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-foreground">{request.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {request.category.replaceAll("_", " ")} / {request.priority}
                      </p>
                    </div>
                    <StatusBadge>{request.status}</StatusBadge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {request.description || request.costNote || "-"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {STATUS_ACTIONS.map((status) => (
                      <button
                        className="rounded-md border border-role-admin px-3 py-2 text-sm font-semibold text-role-admin"
                        key={status}
                        onClick={() => void updateStatus(request.id, status)}
                        type="button"
                      >
                        {status.replaceAll("_", " ")}
                      </button>
                    ))}
                  </div>
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
            <div className="space-y-3">
              {matchingProviders.map((provider) => (
                <div className="rounded-lg border border-border p-4" key={provider.id}>
                  <p className="font-semibold text-foreground">{provider.fullName}</p>
                  <p className="text-sm text-muted-foreground">
                    {providerRoleLabel(provider.category)} / {provider.area}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{provider.phone}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {provider.availability || provider.description || "-"}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    );
  },
);
