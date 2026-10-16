"use client";

import { MessageSquareWarning, Send } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
  StatusBadge,
  TextArea,
} from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { FileUploaderView, useUploader } from "@/components/uploads";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { type Complaint, ResidentHeader, Message, field } from "./resident-shared";

export const ResidentComplaintsPageContent = memo(
  function ResidentComplaintsPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    // Evidence photos/documents for the complaint. Progress shows in the global
    // toaster; the form only needs the resulting asset ids.
    const attachments = useUploader({
      accessLevel: "PRIVATE",
      kind: "document",
      label: "Attachment",
      maxFiles: 5,
      optimizeImage: true,
    });
    const { clear: clearAttachments, files: attachmentFiles } = attachments;
    const invalidate = useInvalidateResources();
    const complaintsResource = usePortalResource<{ complaints: Complaint[] }>(
      residentEndpoints.complaints,
      { errorMessage: "Could not load complaints." },
    );

    const complaints = useMemo(
      () => complaintsResource.data?.complaints ?? [],
      [complaintsResource.data],
    );
    const state = complaintsResource.state;
    const message = actionMessage || complaintsResource.message;

    const handleCreateComplaint = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);

        try {
          await browserApi(residentEndpoints.complaints, {
            body: JSON.stringify({
              attachmentAssetIds: attachmentFiles
                .map((file) => file.assetId)
                .filter((assetId): assetId is string => Boolean(assetId)),
              category: field(form, "category"),
              description: field(form, "description"),
              isAnonymous: form.get("isAnonymous") === "on",
              title: field(form, "title"),
            }),
            method: "POST",
          });
          formElement.reset();
          clearAttachments();
          setActionMessage("Complaint submitted.");
          invalidate(residentEndpoints.complaints, residentEndpoints.dashboard);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not submit complaint.",
          );
        }
      },
      [attachmentFiles, clearAttachments, invalidate],
    );

    const confirmResolution = useCallback(
      async (complaintId: string) => {
        const note = window.prompt("Optional confirmation note")?.trim();

        try {
          await browserApi(
            `${residentEndpoints.complaints}/${complaintId}/confirm-resolution`,
            {
              body: JSON.stringify(note ? { note } : {}),
              method: "PATCH",
            },
          );
          setActionMessage("Resolution confirmed.");
          invalidate(residentEndpoints.complaints, residentEndpoints.dashboard);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not confirm resolution.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <ResidentHeader
          description="Report hostel issues and track staff responses."
          icon={MessageSquareWarning}
          title="Complaints"
        />
        <Message value={message} />

        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="My Complaints">
            {state === "loading" ? <LoadingRows /> : null}
            {state === "error" ? (
              <EmptyState label="Complaints could not be loaded." />
            ) : null}
            {state === "ready" && complaints.length === 0 ? (
              <EmptyState label="No complaints submitted." />
            ) : null}
            <div className="space-y-3">
              {complaints.map((complaint) => (
                <div className="rounded-lg border border-border p-4" key={complaint.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-foreground">{complaint.title}</p>
                      {complaint.description ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {complaint.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusBadge>{complaint.status}</StatusBadge>
                      <StatusBadge>{complaint.category}</StatusBadge>
                      {complaint.isAnonymous ? (
                        <StatusBadge>ANONYMOUS</StatusBadge>
                      ) : null}
                    </div>
                  </div>
                  {/*
                    Their own recording, when they raised it from the app by
                    speaking. Cookie-authenticated, so a plain `<audio>` pointed
                    at the authorizing route follows the 302 to storage with no
                    header of ours attached.
                  */}
                  {complaint.voiceNoteAssetId ? (
                    <audio
                      className="mt-3 w-full"
                      controls
                      preload="none"
                      src={`/api/v1/files/${complaint.voiceNoteAssetId}/url`}
                    >
                      Your browser cannot play this recording.
                    </audio>
                  ) : null}

                  <div className="mt-4 grid gap-2 text-sm text-muted-foreground md:grid-cols-3">
                    <span>
                      Created:{" "}
                      {complaint.createdAt
                        ? new Date(complaint.createdAt).toLocaleDateString()
                        : "-"}
                    </span>
                    <span>SLA: {new Date(complaint.slaDueAt).toLocaleDateString()}</span>
                    <span>
                      Attachments:{" "}
                      {complaint.attachments.length > 0
                        ? complaint.attachments.map((item) => item.fileAssetId).join(", ")
                        : "None"}
                    </span>
                  </div>
                  {complaint.adminResponse ? (
                    <div className="mt-4 rounded-md bg-muted p-3 text-sm text-foreground">
                      {complaint.adminResponse}
                    </div>
                  ) : null}
                  {complaint.status === "RESOLVED" && !complaint.confirmedAt ? (
                    <button
                      className="mt-4 rounded-md bg-role-resident px-3 py-2 text-sm font-semibold text-white"
                      onClick={() => void confirmResolution(complaint.id)}
                      type="button"
                    >
                      Confirm Resolution
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Submit Complaint">
            <BusyForm className="grid gap-3" onSubmit={handleCreateComplaint}>
              <Input label="Title" name="title" required />
              <Select label="Category" name="category" required>
                {[
                  "FOOD",
                  "ROOM",
                  "MAINTENANCE",
                  "SAFETY",
                  "PAYMENT",
                  "STAFF",
                  "NOISE",
                  "OTHER",
                ].map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </Select>
              <TextArea label="Description" name="description" />
              <div className="grid gap-2">
                <span className="text-sm font-semibold text-foreground">
                  Attachments{" "}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <FileUploaderView
                  label="Add a photo or document"
                  tone="resident"
                  uploader={attachments}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input name="isAnonymous" type="checkbox" />
                Submit anonymously
              </label>
              <SubmitButton className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-role-resident text-sm font-semibold text-white">
                <Send className="size-4" />
                Submit
              </SubmitButton>
            </BusyForm>
          </Panel>
        </div>
      </div>
    );
  },
);
