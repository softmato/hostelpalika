"use client";

import { useState } from "react";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";

import { PortalPageHeader, SoftBadge, TabBar } from "./portal-dashboard-ui";
import { EmptyState, LoadingRows } from "./shared-ui";

type FeedbackItem = {
  appVersion: string | null;
  createdAt: string;
  hostel: string | null;
  id: string;
  kind: "BUG" | "FEEDBACK" | "IMPROVEMENT";
  message: string;
  page: string | null;
  platform: string;
  role: string | null;
  screenshots: Array<{ id: string; video: boolean }>;
  sender: { email: string | null; name: string; phone: string | null };
  status: "DONE" | "NEW" | "SEEN";
};

const ENDPOINT = "/api/v1/platform/feedback";
const KIND_LABEL = { BUG: "Bug", FEEDBACK: "Feedback", IMPROVEMENT: "Improvement" } as const;
const KIND_TONE = { BUG: "rose", FEEDBACK: "teal", IMPROVEMENT: "amber" } as const;
/** Who sent it, in the order platform staff triage them. */
const ROLE_LABEL: Record<string, string> = {
  HOSTEL_ADMIN: "Hostel admins",
  WARDEN: "Wardens",
  COOK: "Cooks",
  RESIDENT: "Residents",
  GUARDIAN: "Guardians",
  PUBLIC: "Public",
  PLATFORM_AGENT: "Agents",
  PLATFORM_MODERATOR: "Moderators",
  SUPERADMIN: "Superadmins",
};
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role.replaceAll("_", " ").toLowerCase();

/** Platform → Feedback: what people sent from Help & support, newest first. */
export function PlatformFeedbackPageContent() {
  const [status, setStatus] = useState("NEW");
  const [role, setRole] = useState("");
  const resource = usePortalResource<{
    counts: Record<string, number>;
    items: FeedbackItem[];
    roleCounts: Record<string, number>;
  }>(
    `${ENDPOINT}?status=${status}${role ? `&role=${role}` : ""}`,
    { errorMessage: "Could not load feedback." },
  );
  const invalidate = useInvalidateResources();
  const counts = resource.data?.counts ?? {};
  const roleCounts = resource.data?.roleCounts ?? {};
  const roles = [
    ...Object.keys(ROLE_LABEL).filter((key) => roleCounts[key] || key === role),
    ...Object.keys(roleCounts).filter((key) => !(key in ROLE_LABEL)),
  ];
  const everyone = Object.values(roleCounts).reduce((sum, count) => sum + count, 0);

  async function move(id: string, next: FeedbackItem["status"]) {
    try {
      await browserApi(`${ENDPOINT}/${id}`, { body: JSON.stringify({ status: next }), method: "PATCH" });
      invalidate(`${ENDPOINT}*`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update.");
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      <PortalPageHeader description="Feedback, bugs and ideas sent from Help & support." title="Feedback" />

      <TabBar
        onChange={setStatus}
        tabs={[
          { count: counts.NEW ?? 0, key: "NEW", label: "New" },
          { count: counts.SEEN ?? 0, key: "SEEN", label: "Seen" },
          { count: counts.DONE ?? 0, key: "DONE", label: "Done" },
        ]}
        tone="team"
        value={status}
      />

      {roles.length ? (
        <div className="no-scrollbar flex gap-2 overflow-x-auto">
          {[{ count: everyone, key: "", label: "Everyone" }, ...roles.map((key) => ({ count: roleCounts[key] ?? 0, key, label: roleLabel(key) }))].map(
            (chip) => (
              <button
                aria-pressed={chip.key === role}
                className={cn(
                  "h-8 shrink-0 rounded-full border px-3 text-xs font-semibold transition",
                  chip.key === role
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                key={chip.key || "all"}
                onClick={() => setRole(chip.key)}
                type="button"
              >
                {chip.label} <span className="tabular-nums opacity-70">{chip.count}</span>
              </button>
            ),
          )}
        </div>
      ) : null}

      {resource.state === "loading" && !resource.data ? (
        <LoadingRows />
      ) : !resource.data?.items.length ? (
        <EmptyState label={resource.message || "Nothing here."} />
      ) : (
        <ul className="space-y-3">
          {resource.data.items.map((item) => {
            const [title, ...rest] = item.message.split("\n");

            return (
              <li className="rounded-2xl border border-border bg-card p-4" key={item.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <SoftBadge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</SoftBadge>
                      <p className="font-semibold text-foreground">{title}</p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[
                        item.sender.name,
                        item.role ? roleLabel(item.role).replace(/s$/, "") : null,
                        item.hostel,
                        item.platform === "APP" ? `App ${item.appVersion ?? ""}`.trim() : "Web",
                        item.page,
                        formatHostelDateTime(item.createdAt),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {item.status !== "SEEN" ? (
                      <StatusButton label="Mark seen" onClick={() => void move(item.id, "SEEN")} />
                    ) : null}
                    {item.status !== "DONE" ? (
                      <StatusButton label="Done" onClick={() => void move(item.id, "DONE")} primary />
                    ) : (
                      <StatusButton label="Reopen" onClick={() => void move(item.id, "NEW")} />
                    )}
                  </div>
                </div>

                {rest.join("\n").trim() ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/90">{rest.join("\n").trim()}</p>
                ) : null}

                {item.screenshots.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.screenshots.map((shot) =>
                      shot.video ? (
                        <video
                          className="h-28 w-auto rounded-lg border border-border bg-black"
                          controls
                          key={shot.id}
                          preload="metadata"
                          src={`/api/v1/files/${shot.id}/url`}
                        />
                      ) : (
                        <a
                          className="block overflow-hidden rounded-lg border border-border"
                          href={`/api/v1/files/${shot.id}/url`}
                          key={shot.id}
                          rel="noopener"
                          target="_blank"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- a signed, private file URL */}
                          <img alt="Screenshot" className="h-28 w-auto object-cover" src={`/api/v1/files/${shot.id}/url`} />
                        </a>
                      ),
                    )}
                  </div>
                ) : null}

                {item.sender.email || item.sender.phone ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Reply:{" "}
                    {item.sender.email ? (
                      <a className="font-semibold text-primary" href={`mailto:${item.sender.email}`}>
                        {item.sender.email}
                      </a>
                    ) : null}
                    {item.sender.email && item.sender.phone ? " · " : null}
                    {item.sender.phone ? (
                      <a className="font-semibold text-primary" href={`tel:${item.sender.phone}`}>
                        {item.sender.phone}
                      </a>
                    ) : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusButton({ label, onClick, primary }: { label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      className={cn(
        "h-8 rounded-lg px-3 text-xs font-semibold transition",
        primary ? "bg-primary text-primary-foreground hover:brightness-110" : "border border-border hover:bg-muted",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
