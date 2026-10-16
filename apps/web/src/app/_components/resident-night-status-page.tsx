"use client";

import { Moon } from "@/components/icons";
import { memo, useCallback, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { Message, PageHeader } from "./daily-operations-shared";
import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";

type NightStatus = {
  checkedAt: string | null;
  status: string;
};

export const ResidentNightStatusPageContent = memo(
  function ResidentNightStatusPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const invalidate = useInvalidateResources();
    const statusResource = usePortalResource<{ status: NightStatus }>(
      residentEndpoints.nightStatus,
      { errorMessage: "Could not load status." },
    );

    const status = statusResource.data?.status ?? null;
    const message = actionMessage || statusResource.message;

    const update = useCallback(
      async (statusValue: string) => {
        try {
          await browserApi(residentEndpoints.nightStatus, {
            body: JSON.stringify({ status: statusValue }),
            method: "POST",
          });
          setActionMessage("Night status updated.");
          invalidate(residentEndpoints.nightStatus, residentEndpoints.dashboard);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update status.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PageHeader
          description="Share a privacy-first safety status with hostel staff."
          icon={Moon}
          title="Night Status"
        />
        <Message value={message} />
        <Panel>
          {statusResource.state === "loading" ? (
            <LoadingRows />
          ) : statusResource.state === "error" ? (
            <EmptyState label="Your night status could not be loaded." />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Current status</p>
              <p className="mt-2 text-3xl font-bold text-foreground">
                {status?.status ?? "NOT_VERIFIED"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {/* No timestamp is shown when nothing has been recorded — an
                    empty status is not the same as "checked and absent". */}
                {status?.checkedAt
                  ? new Date(status.checkedAt).toLocaleString()
                  : "Not checked in yet today."}
              </p>
            </>
          )}
        </Panel>
        <div className="grid gap-3 md:grid-cols-4">
          {["INSIDE_HOSTEL", "OUTSIDE_HOSTEL", "MARKED_SAFE", "NOT_VERIFIED"].map(
            (item) => (
              <button
                className="h-11 rounded-md bg-role-resident text-sm font-semibold text-white"
                key={item}
                onClick={() => void update(item)}
                type="button"
              >
                {item.replaceAll("_", " ")}
              </button>
            ),
          )}
        </div>
      </div>
    );
  },
);
