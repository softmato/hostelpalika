"use client";

import { useState, type FormEvent } from "react";

import { Megaphone } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { toast } from "@/stores/toast-store";

import { RoleButton, SoftBadge } from "./portal-dashboard-ui";
import { Input, Panel, Select, TextArea } from "./shared-ui";

type AppNotice = {
  audience: "EVERYONE" | "GUARDIANS" | "HOSTEL_STAFF" | "RESIDENTS";
  buttonLabel: string;
  enabled: boolean;
  id: string;
  link: string;
  message: string;
  title: string;
};

const ENDPOINT = "/api/v1/platform/site-config";
const AUDIENCE_LABEL: Record<AppNotice["audience"], string> = {
  EVERYONE: "Everyone",
  GUARDIANS: "Guardians",
  HOSTEL_STAFF: "Hostel owners & staff",
  RESIDENTS: "Residents",
};
const EMPTY: AppNotice = {
  audience: "EVERYONE",
  buttonLabel: "",
  enabled: false,
  id: "",
  link: "",
  message: "",
  title: "",
};

/**
 * Push → Sheet message: what the superadmin types here opens as the
 * "Update available" sheet in the app and as the same card on every web
 * portal, once per person. Sending a new one replaces the live one.
 */
export function PlatformAppNoticePanel() {
  const resource = usePortalResource<{ config: { appNotice?: AppNotice } }>(ENDPOINT, {
    errorMessage: "Could not load the sheet message.",
  });
  const live = resource.data?.config.appNotice;
  const [draft, setDraft] = useState<AppNotice | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: AppNotice, done: string) {
    setBusy(true);
    try {
      await browserApi(`${ENDPOINT}/appNotice`, { body: JSON.stringify(next), method: "PUT" });
      toast.success(done);
      setDraft(null);
      await resource.refreshAsync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    // A fresh id is what makes everyone who closed the last one see this one.
    void save({ ...draft, enabled: true, id: Date.now().toString(36) }, "Sheet message is live.");
  }

  const set = <K extends keyof AppNotice>(key: K, value: AppNotice[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <Panel
      action={
        <RoleButton className="h-8 px-3" onClick={() => setDraft({ ...(live ?? EMPTY), audience: live?.audience ?? "EVERYONE" })} type="button">
          <Megaphone className="size-3.5" />
          New sheet message
        </RoleButton>
      }
      title="Sheet message"
    >
      {live?.enabled && live.title ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SoftBadge tone="teal">Live</SoftBadge>
              <p className="font-semibold text-foreground">{live.title}</p>
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{live.message}</p>
            <p className="mt-1 text-xs text-muted-foreground">{AUDIENCE_LABEL[live.audience]} · app and web, once each</p>
          </div>
          <button
            className="h-8 rounded-lg border border-border px-3 text-xs font-semibold transition hover:bg-muted disabled:opacity-50"
            disabled={busy}
            onClick={() => void save({ ...live, enabled: false }, "Sheet message taken down.")}
            type="button"
          >
            Take down
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing live. A sheet message opens like “Update available” in the app and on the web.
        </p>
      )}

      <Dialog onOpenChange={(open) => !open && setDraft(null)} open={draft !== null}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>New sheet message</DialogTitle>
            <DialogDescription>Shown once to each person, on their next open of the app or a portal.</DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
              <form className="grid gap-4" onSubmit={submit}>
                <Input label="Heading" name="title" onChange={(event) => set("title", event.target.value)} required value={draft.title} />
                <TextArea label="Message" name="message" onChange={(event) => set("message", event.target.value)} value={draft.message} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input
                    hint="Leave empty for just “OK”."
                    label="Button"
                    name="buttonLabel"
                    onChange={(event) => set("buttonLabel", event.target.value)}
                    value={draft.buttonLabel}
                  />
                  <Input
                    hint="https:// — where the button goes."
                    label="Link"
                    name="link"
                    onChange={(event) => set("link", event.target.value)}
                    placeholder="https://"
                    type="url"
                    value={draft.link}
                  />
                </div>
                <Select label="Send to" name="audience" onChange={(event) => set("audience", event.target.value as AppNotice["audience"])} value={draft.audience}>
                  {Object.entries(AUDIENCE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                <div className="flex justify-end">
                  <RoleButton className="h-9 px-4" disabled={busy || draft.title.trim().length < 2 || draft.message.trim().length < 2} type="submit">
                    <Megaphone className="size-4" />
                    {busy ? "Saving…" : "Show it"}
                  </RoleButton>
                </div>
              </form>

              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Preview</p>
                <div className="rounded-2xl border border-border bg-card p-4 text-center shadow-sm">
                  <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Megaphone className="size-7" />
                  </span>
                  <p className="mt-3 font-semibold text-foreground">{draft.title || "Heading"}</p>
                  <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{draft.message || "Message"}</p>
                  <div className="mt-4 grid gap-2">
                    {draft.link && draft.buttonLabel ? (
                      <>
                        <span className="h-8 rounded-lg border border-border text-xs font-semibold leading-8">Later</span>
                        <span className="h-8 rounded-lg bg-primary text-xs font-bold leading-8 text-primary-foreground">{draft.buttonLabel}</span>
                      </>
                    ) : (
                      <span className="h-8 rounded-lg bg-primary text-xs font-bold leading-8 text-primary-foreground">OK</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
