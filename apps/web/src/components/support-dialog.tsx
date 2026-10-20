"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { AlertTriangle, ArrowLeft, Mail, MessageSquare, Phone, Send, Sparkles } from "@/components/icons";
import { useSiteConfig } from "@/components/site-config-provider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FileUploader, type UploadedAsset } from "@/components/uploads";
import { browserApi } from "@/lib/browser-api";
import { uploadHint } from "@/lib/uploads/accepts";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";

const KINDS = [
  { icon: MessageSquare, id: "FEEDBACK", label: "Feedback" },
  { icon: AlertTriangle, id: "BUG", label: "Bug" },
  { icon: Sparkles, id: "IMPROVEMENT", label: "Improvement" },
] as const;

type Kind = (typeof KINDS)[number]["id"];

/**
 * Help & support, from the `?` in every portal's sidebar: how to reach us
 * (the support email and up to two numbers with a note each, from Website
 * Config → Site Identity), and Send feedback — a kind, one text box whose
 * first line reads as the title, and screenshots. Lands in Platform → Feedback.
 */
export function SupportDialog({
  initialView = "contact",
  onOpenChange,
  open,
}: {
  /** The footer's Send feedback opens straight on the form. */
  initialView?: "contact" | "feedback";
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { identity } = useSiteConfig();
  const pathname = usePathname();
  const [view, setView] = useState<"contact" | "feedback">(initialView);
  const [kind, setKind] = useState<Kind>("FEEDBACK");
  const [message, setMessage] = useState("");
  const [shots, setShots] = useState<UploadedAsset[]>([]);
  const [sending, setSending] = useState(false);

  const lines = identity.supportLines?.length
    ? identity.supportLines
    : identity.supportPhone
      ? [{ note: "", phone: identity.supportPhone }]
      : [];

  // Re-read the starting view on every open: the `?` shows contacts, the footer the form.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setView(initialView);
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) setView("contact");
  }

  async function send() {
    setSending(true);

    try {
      await browserApi("/api/v1/feedback", {
        body: JSON.stringify({
          kind,
          message,
          page: pathname,
          platform: "WEB",
          screenshotAssetIds: shots.map((shot) => shot.assetId).filter(Boolean),
        }),
        method: "POST",
      });
      toast.success("Thanks — we have it.");
      setMessage("");
      setShots([]);
      close(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="sm:max-w-lg">
        {view === "contact" ? (
          <div className="stagger-in space-y-4" key="contact">
            <div>
              <DialogTitle>Help & support</DialogTitle>
              <DialogDescription>Reach us, or tell us what to fix.</DialogDescription>
            </div>

            <ul className="space-y-2">
              {identity.supportEmail ? (
                <ContactRow
                  href={`mailto:${identity.supportEmail}`}
                  icon={<Mail className="size-4" />}
                  note="Email — we reply within a working day"
                  value={identity.supportEmail}
                />
              ) : null}
              {lines.map((line) => (
                <ContactRow
                  callHref={`tel:${line.phone.replace(/[^\d+]/g, "")}`}
                  external
                  href={whatsappHref(line.phone)}
                  icon={<MessageSquare className="size-4" />}
                  key={line.phone}
                  note={line.note ? `${line.note} · Message on WhatsApp` : "Message us on WhatsApp"}
                  value={line.phone}
                />
              ))}
            </ul>

            <button
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition hover:brightness-110"
              onClick={() => setView("feedback")}
              type="button"
            >
              <Send className="size-4" />
              Send feedback or report a problem
            </button>
          </div>
        ) : (
          <div className="stagger-in space-y-4" key="feedback">
            <div className="flex items-start gap-2">
              <button
                aria-label="Back"
                className="-ml-1 mt-0.5 rounded-lg p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                onClick={() => setView("contact")}
                type="button"
              >
                <ArrowLeft className="size-4" />
              </button>
              <div>
                <DialogTitle>Send feedback</DialogTitle>
                <DialogDescription>The first line reads as the title.</DialogDescription>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {KINDS.map((entry) => (
                <button
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-semibold transition",
                    kind === entry.id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                  key={entry.id}
                  onClick={() => setKind(entry.id)}
                  type="button"
                >
                  <entry.icon className="size-4" />
                  {entry.label}
                </button>
              ))}
            </div>

            <textarea
              autoFocus
              className="min-h-36 w-full rounded-xl border border-input bg-background px-3.5 py-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
              maxLength={4000}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={
                kind === "BUG"
                  ? "Payments page shows the wrong total\nWhat you did, what you expected, what happened."
                  : "One line on what it's about\nThen as much detail as you like."
              }
              value={message}
            />

            <FileUploader
              assetKind="GENERIC"
              hint={`Up to 4 · ${uploadHint("media")}`}
              kind="media"
              label="Add screenshots or a video"
              maxFiles={4}
              onChange={setShots}
              size="sm"
              variant="dropzone"
            />

            <button
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition hover:brightness-110 disabled:opacity-60"
              disabled={sending || message.trim().length < 3}
              onClick={() => void send()}
              type="button"
            >
              <Send className="size-4" />
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A WhatsApp chat with the number: messaging is how we want to be reached —
 * it leaves a thread both sides can scroll back through. `wa.me` takes digits
 * only, with the country code; a local 98… number is given Nepal's 977.
 */
function whatsappHref(phone: string) {
  const digits = phone.replace(/\D/g, "");

  return `https://wa.me/${digits.length === 10 && digits.startsWith("9") ? `977${digits}` : digits}`;
}

function ContactRow({
  callHref,
  external,
  href,
  icon,
  note,
  value,
}: {
  /** A secondary Call button beside a WhatsApp row. */
  callHref?: string;
  external?: boolean;
  href: string;
  icon: React.ReactNode;
  note: string;
  value: string;
}) {
  return (
    <li className="flex items-center gap-2 rounded-xl border border-border pr-2 transition hover:border-primary/40">
      <a
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3.5 py-3 transition hover:bg-muted/50"
        href={href}
        {...(external ? { rel: "noopener", target: "_blank" } : {})}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">{icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">{value}</span>
          <span className="block truncate text-xs text-muted-foreground">{note}</span>
        </span>
      </a>
      {callHref ? (
        <a
          aria-label={`Call ${value}`}
          className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
          href={callHref}
          title="Call"
        >
          <Phone className="size-4" />
        </a>
      ) : null}
    </li>
  );
}
