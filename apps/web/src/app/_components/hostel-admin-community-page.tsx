"use client";

import { Flag, Megaphone } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { TextArea } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { CommunityModerationPanel } from "@/app/_components/community-moderation-panel";
import { RoleButton } from "@/app/_components/portal-dashboard-ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources } from "@/lib/portal-query";
import { Message, field } from "./daily-operations-shared";
import { PageHeader } from "./core-portal-shared";

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
    const [announcing, setAnnouncing] = useState(false);
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
          setAnnouncing(false);
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
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          action={
            <RoleButton className="h-9 rounded-xl" onClick={() => setAnnouncing(true)} tone="admin" type="button">
              <Megaphone className="size-4" />
              Post announcement
            </RoleButton>
          }
          description="Posts your residents reported, and your official announcements."
          icon={Flag}
          title="Community Reports"
        />
        {announcing ? null : <Message value={actionMessage} />}

        <CommunityModerationPanel endpoint={COMMUNITY_ENDPOINT} tone="admin" />

        <Dialog onOpenChange={setAnnouncing} open={announcing}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Post an announcement</DialogTitle>
              <DialogDescription>Pinned to the top of your hostel&apos;s community space.</DialogDescription>
            </DialogHeader>
            <Message value={actionMessage} />
            <BusyForm className="grid gap-3" onSubmit={announce}>
              <TextArea label="Announcement" name="body" />
              <DialogFooter>
                <SubmitButton className="h-10 gap-2 rounded-xl bg-brand-teal px-5 text-white hover:bg-brand-teal/90">
                  <Megaphone className="size-4" />
                  Publish
                </SubmitButton>
              </DialogFooter>
            </BusyForm>
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);
