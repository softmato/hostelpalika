"use client";

import { Flag, Megaphone } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { Panel, TextArea } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { CommunityModerationPanel } from "@/app/_components/community-moderation-panel";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources } from "@/lib/portal-query";
import { Message, PageHeader, field } from "./daily-operations-shared";

const COMMUNITY_ENDPOINT = "/api/v1/hostel-admin/community";

/**
 * Not the feed — that lives at `/community` and is linked from the header. What
 * a hostel keeps in its portal is the queue of its own reported posts, plus the
 * one thing only staff can write: an official announcement pinned to the top of
 * that hostel's space.
 */
export const HostelAdminCommunityPageContent = memo(
  function HostelAdminCommunityPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const invalidate = useInvalidateResources();

    const announce = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);

        try {
          await browserApi(COMMUNITY_ENDPOINT, {
            body: JSON.stringify({ body: field(form, "body") }),
            method: "POST",
          });
          formElement.reset();
          setActionMessage("Announcement posted.");
          invalidate(`${COMMUNITY_ENDPOINT}?filter=all`);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not post announcement.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PageHeader
          description="Review posts your residents reported, and post official announcements to your hostel's community space."
          icon={Flag}
          title="Community Reports"
        />
        <Message value={actionMessage} />

        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <CommunityModerationPanel endpoint={COMMUNITY_ENDPOINT} tone="admin" />

          <Panel title="Post an Announcement">
            <BusyForm className="grid gap-3" onSubmit={announce}>
              <TextArea label="Announcement" name="body" />
              <SubmitButton className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-role-admin text-sm font-semibold text-white">
                <Megaphone className="size-4" />
                Publish
              </SubmitButton>
            </BusyForm>
          </Panel>
        </div>
      </div>
    );
  },
);
