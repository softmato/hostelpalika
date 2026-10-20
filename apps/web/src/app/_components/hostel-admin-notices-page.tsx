"use client";

import { AlertTriangle, Bell, Megaphone, Send } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Input, Select, TextArea } from "@/app/_components/shared-ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  EmptyInline,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
} from "@/app/_components/portal-dashboard-ui";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";

import { field, optionalField, type Notice } from "./hostel-admin-shared";
import { HostelAdminNoticePushes } from "./hostel-admin-notice-pushes";

const CATEGORIES = [
  "GENERAL",
  "URGENT",
  "EVENT",
  "RULE",
  "MAINTENANCE",
  "PAYMENT",
  "FOOD",
];

export const HostelAdminNoticesPage = memo(function HostelAdminNoticesPage() {
  const [actionMessage, setActionMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const workspaceHref = useWorkspaceHref();
  const invalidate = useInvalidateResources();
  const noticesResource = usePortalResource<{ notices: Notice[] }>(
    hostelAdminEndpoints.notices,
    { errorMessage: "Could not load notices." },
  );

  const notices = useMemo(
    () => noticesResource.data?.notices ?? [],
    [noticesResource.data],
  );
  const state = noticesResource.state;
  const message = actionMessage || noticesResource.message;

  const handleCreateNotice = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      try {
        await browserApi(hostelAdminEndpoints.notices, {
          body: JSON.stringify({
            category: field(form, "category"),
            content: field(form, "content"),
            expiresAt: optionalField(form, "expiresAt"),
            isUrgent: form.get("isUrgent") === "on",
            title: field(form, "title"),
          }),
          method: "POST",
        });
        formElement.reset();
        setCreating(false);
        setActionMessage("Notice published — residents notified.");
        invalidate(hostelAdminEndpoints.notices);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not publish notice.",
        );
      }
    },
    [invalidate],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        actions={
          <RoleButton className="h-9 rounded-xl" onClick={() => setCreating(true)} tone="admin" type="button">
            <Megaphone className="size-4" />
            New notice
          </RoleButton>
        }
        breadcrumb={[{ href: workspaceHref("/hostel-admin"), label: "Home" }, "Notices"]}
        description="Announcements residents get by email and in the app."
        title="Notices"
      />
      {message ? (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-foreground">
          {message}
        </div>
      ) : null}

      <HostelAdminNoticePushes />

      <div>
        <SectionCard title={`Published · ${notices.length}`}>
          {state === "loading" ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div
                  className="h-20 animate-pulse rounded-xl border border-border/60 bg-muted/30"
                  key={index}
                />
              ))}
            </div>
          ) : null}
          {state === "error" ? <EmptyState label="Notices could not be loaded." /> : null}
          {state === "ready" && notices.length === 0 ? (
            <EmptyInline label="No notices published yet." />
          ) : null}
          <div className="grid gap-2.5 lg:grid-cols-2">
            {notices.map((notice) => (
              <div
                className="flex items-start gap-3 rounded-2xl border border-border/70 p-3.5 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                key={notice.id}
              >
                <span
                  className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
                    notice.isUrgent
                      ? "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
                      : "bg-role-team-soft text-role-team"
                  }`}
                >
                  {notice.isUrgent ? (
                    <AlertTriangle className="size-[17px]" />
                  ) : (
                    <Megaphone className="size-[17px]" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13.5px] font-bold text-foreground">
                      {notice.title}
                    </p>
                    {notice.isUrgent ? <SoftBadge tone="amber">Urgent</SoftBadge> : null}
                    <SoftBadge tone="slate">{notice.category}</SoftBadge>
                  </div>
                  <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
                    {notice.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

      </div>

      <Dialog onOpenChange={setCreating} open={creating}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New notice</DialogTitle>
            <DialogDescription>Every resident is emailed and notified in the app.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={handleCreateNotice}>
            <Input label="Title" name="title" required />
            <Select label="Category" name="category" required>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
            <TextArea label="Content" name="content" />
            <Input label="Expires at" name="expiresAt" type="date" />
            <label className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              <input className="accent-brand-teal" name="isUrgent" type="checkbox" />
              <span className="inline-flex items-center gap-1">
                <Bell className="size-3.5 text-amber-500" /> Mark as urgent
              </span>
            </label>
            <DialogFooter>
              <RoleButton tone="admin" type="submit">
                <Send className="size-3.5" />
                Publish notice
              </RoleButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
});
