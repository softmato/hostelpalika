"use client";

import { Siren } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Glyph } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { field, Message, PageHeader } from "./daily-operations-shared";
import { SectionTitle } from "./daily-portal-ui";
import { EmptyInline, InitialsAvatar, SectionCard } from "./portal-dashboard-ui";
import { TextArea } from "@/app/_components/shared-ui";

type EmergencyContact = {
  id: string;
  name: string;
  phone: string;
  relation: string;
};

export const ResidentSOSPageContent = memo(function ResidentSOSPageContent() {
  const [actionMessage, setActionMessage] = useState("");
  const [raising, setRaising] = useState(false);
  const contactsResource = usePortalResource<{ contacts: EmergencyContact[] }>(
    residentEndpoints.emergencyContacts,
    { errorMessage: "Could not load contacts." },
  );

  const contacts = useMemo(
    () => contactsResource.data?.contacts ?? [],
    [contactsResource.data],
  );
  const message = actionMessage || contactsResource.message;
  const { confirm, confirmDialog } = useConfirm();

  const trigger = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const alertsGuardian = form.get("guardianAlertEnabled") === "on";

    // §4.1: an SOS mails every admin and warden the moment it is raised, so the
    // one thing that must not happen is raising it by brushing the button.
    const confirmed = await confirm({
      actionLabel: "Raise SOS",
      description: alertsGuardian
        ? "This immediately alerts hostel staff, every warden, and your guardian. It cannot be recalled."
        : "This immediately alerts hostel staff and every warden. It cannot be recalled.",
      title: "Raise an emergency SOS?",
      tone: "destructive",
    });

    if (!confirmed) {
      return;
    }

    try {
      await browserApi("/api/v1/resident/sos", {
        body: JSON.stringify({
          guardianAlertEnabled: form.get("guardianAlertEnabled") === "on",
          message: field(form, "message"),
        }),
        method: "POST",
      });
      setActionMessage("SOS alert triggered.");
      formElement.reset();
      setRaising(false);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Could not trigger SOS.");
    }
  }, [confirm]);

  return (
    <div className="mx-auto max-w-[900px] space-y-5">
      {confirmDialog}
      <PageHeader
        description="Alert hostel staff in an emergency."
        icon={Siren}
        title="SOS"
      />
      <Message value={message} />

      {/* The one SOS on the screen is the biggest thing on it: in an emergency
          nobody reads a header. Red is reserved for this. */}
      <section className="flex flex-col items-center gap-4 rounded-2xl border border-border/70 bg-card px-5 py-8 text-center">
        <button
          aria-label="Raise SOS"
          className="flex size-36 items-center justify-center rounded-full bg-rose-600 text-white shadow-[0_0_0_12px_rgb(225_29_72/0.12)] transition duration-200 hover:scale-[1.03] hover:bg-rose-700 active:scale-95"
          onClick={() => setRaising(true)}
          type="button"
        >
          <span className="flex flex-col items-center gap-1">
            <Glyph className="size-10" name="siren" variant="solid" />
            <span className="font-heading text-[20px] font-bold tracking-wide">SOS</span>
          </span>
        </button>
        <p className="text-[13.5px] text-muted-foreground">Staff and every warden are alerted at once.</p>
      </section>

      <section className="space-y-3">
        <SectionTitle>Emergency contacts</SectionTitle>
        {contacts.length === 0 ? (
          <SectionCard>
            <EmptyInline label="No emergency contacts." />
          </SectionCard>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {contacts.map((contact) => (
              <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-4" key={contact.id}>
                <InitialsAvatar name={contact.name} tone="team" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-foreground">{contact.name}</p>
                  <p className="truncate text-[12px] text-muted-foreground">{contact.relation}</p>
                </div>
                <Button asChild className="h-9 gap-1.5 rounded-xl" size="sm" variant="outline">
                  <a href={`tel:${contact.phone}`}>
                    <Glyph className="size-4" name="call" />
                    {contact.phone}
                  </a>
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog onOpenChange={setRaising} open={raising}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Raise an SOS</DialogTitle>
            <DialogDescription>Say what is happening, if you can.</DialogDescription>
          </DialogHeader>
          <BusyForm className="grid gap-3" onSubmit={trigger}>
            <TextArea label="Message" name="message" />
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <input className="accent-rose-600" name="guardianAlertEnabled" type="checkbox" />
              Alert my guardian too
            </label>
            <DialogFooter>
              <SubmitButton className="h-11 bg-rose-600 text-white hover:bg-rose-700">
                <Siren className="size-4" />
                Raise SOS
              </SubmitButton>
            </DialogFooter>
          </BusyForm>
        </DialogContent>
      </Dialog>
    </div>
  );
});
