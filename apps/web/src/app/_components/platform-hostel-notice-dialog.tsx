"use client";

import { useState } from "react";

import { Bell, Mail } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { cn } from "@/lib/utils";

type Channel = "EMAIL" | "PUSH";

type NoticeResult = {
  emailed: number;
  pushed: number;
  results: {
    emailed: boolean | null;
    hostelName: string;
    pushed: boolean | null;
    reason?: string;
  }[];
  total: number;
};

const CHANNELS: { icon: typeof Mail; key: Channel; label: string }[] = [
  { icon: Mail, key: "EMAIL", label: "Email" },
  { icon: Bell, key: "PUSH", label: "Push" },
];

/** One line on who was reached, naming the hostels nobody could be reached at. */
function summarize(result: NoticeResult, channels: Channel[]) {
  const parts = [
    channels.includes("EMAIL") ? `${result.emailed}/${result.total} emailed` : null,
    channels.includes("PUSH") ? `${result.pushed}/${result.total} pushed` : null,
  ].filter(Boolean);
  const missed = result.results
    .filter((row) => row.reason || row.emailed === false || row.pushed === false)
    .map((row) => row.hostelName || "an archived hostel");

  return `Notice sent: ${parts.join(", ")}.${
    missed.length
      ? ` Not fully reached: ${missed.slice(0, 5).join(", ")}${missed.length > 5 ? ` and ${missed.length - 5} more` : ""}.`
      : ""
  }`;
}

/**
 * Listings → Send notice. One hostel is a personal notice, several a group one;
 * every owner gets their own copy. Open while `hostels` is non-null.
 */
export function HostelNoticeDialog({
  hostels,
  onClose,
  onSent,
}: {
  hostels: { id: string; name: string }[] | null;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [channels, setChannels] = useState<Channel[]>(["EMAIL", "PUSH"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const count = hostels?.length ?? 0;
  const ready =
    title.trim().length >= 2 &&
    body.trim().length >= 2 &&
    channels.length > 0 &&
    count > 0;

  const toggle = (key: Channel) =>
    setChannels((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );

  const close = () => {
    if (busy) return;
    setError("");
    onClose();
  };

  const send = async () => {
    if (!hostels || !ready) return;
    setBusy(true);
    setError("");
    try {
      const result = await browserApi<NoticeResult>(platformEndpoints.hostelNotice, {
        body: JSON.stringify({
          body: body.trim(),
          channels,
          hostelIds: hostels.map((hostel) => hostel.id),
          title: title.trim(),
        }),
        method: "POST",
      });
      onSent(result ? summarize(result, channels) : "Notice sent.");
      setTitle("");
      setBody("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The notice could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={(open) => (open ? null : close())} open={Boolean(hostels)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {count === 1 ? "Send notice" : `Send notice to ${count} hostels`}
          </DialogTitle>
          <DialogDescription>
            {count === 1
              ? `To the owner of ${hostels?.[0]?.name}.`
              : "Each owner gets their own copy. Nobody sees who else it went to."}
          </DialogDescription>
        </DialogHeader>

        {count > 1 ? (
          <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
            {hostels?.map((hostel) => (
              <span
                className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-foreground"
                key={hostel.id}
              >
                {hostel.name}
              </span>
            ))}
          </div>
        ) : null}

        <div className="space-y-3">
          <label className="block text-[12px] font-semibold text-foreground">
            Title
            <Input
              className="mt-1"
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Add more photos to your listing"
              value={title}
            />
          </label>
          <label className="block text-[12px] font-semibold text-foreground">
            Message
            <Textarea
              className="mt-1 min-h-28"
              maxLength={2000}
              onChange={(event) => setBody(event.target.value)}
              value={body}
            />
            <span className="mt-0.5 block text-right text-[11px] font-normal text-muted-foreground">
              {body.length}/2000
            </span>
          </label>

          <fieldset>
            <legend className="mb-1 text-[12px] font-semibold text-foreground">
              Send by
            </legend>
            <div className="grid grid-cols-2 gap-1.5">
              {CHANNELS.map(({ icon: Icon, key, label }) => {
                const on = channels.includes(key);
                return (
                  <button
                    aria-pressed={on}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-lg border px-2.5 py-2 text-[13px] font-semibold transition",
                      on
                        ? "border-brand-teal bg-brand-teal/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                    key={key}
                    onClick={() => toggle(key)}
                    type="button"
                  >
                    <Icon className="size-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {error ? (
            <p className="text-[12.5px] font-medium text-destructive">{error}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={busy} onClick={close} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!ready || busy}
            loading={busy}
            onClick={() => void send()}
            type="button"
          >
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
