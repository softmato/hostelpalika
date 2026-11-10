"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import type { GuideHostel } from "@/lib/guide-hostels";
import { optimizedImage } from "@/lib/image-url";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";

/** "On this page" with the section in view highlighted. */
export function OnThisPage({ items }: { items: Array<{ id: string; label: string }> }) {
  const [active, setActive] = useState(items[0]?.id);

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);

  if (items.length < 2) return null;
  return (
    <div>
      <p className="font-heading text-base font-bold text-foreground">On this page</p>
      <ul className="mt-3 space-y-0.5">
        {items.map((i) => (
          <li key={i.id}>
            <a
              className={cn(
                "block truncate rounded-lg px-3 py-1.5 text-[13px] transition-colors duration-150",
                active === i.id ? "bg-primary/[0.08] font-medium text-primary" : "text-muted-foreground hover:text-foreground",
              )}
              href={`#${i.id}`}
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Is this page useful?" — Yes is saved at once; No opens a reason box, and the
 * vote (with or without a reason) is saved on Send. Both land in
 * Platform → Feedback → Guide pages.
 */
export function PageUseful() {
  const page = usePathname();
  const [step, setStep] = useState<"ask" | "why" | "done">("ask");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);

  async function send(helpful: boolean) {
    setSending(true);
    try {
      await browserApi("/api/v1/guide/feedback", {
        body: JSON.stringify({ helpful, page, reason: reason.trim() || undefined }),
        method: "POST",
      });
      setStep("done");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send. Try again.");
    } finally {
      setSending(false);
    }
  }

  const pill = "rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150";

  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="text-sm font-semibold text-foreground">Is this page useful?</p>
      {step === "done" ? (
        <p className="mt-2 animate-page-in text-[13px] text-muted-foreground">Thanks — we have it.</p>
      ) : (
        <>
          <div className="mt-3 flex gap-2">
            <button
              className={cn(pill, "border-border text-foreground/80 hover:border-primary/40 hover:text-primary")}
              disabled={sending}
              onClick={() => void send(true)}
              type="button"
            >
              Yes
            </button>
            <button
              aria-expanded={step === "why"}
              className={cn(
                pill,
                step === "why"
                  ? "border-primary/40 bg-primary/[0.06] text-primary"
                  : "border-border text-foreground/80 hover:border-primary/40 hover:text-primary",
              )}
              disabled={sending}
              onClick={() => setStep("why")}
              type="button"
            >
              No
            </button>
          </div>
          <div
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
              step === "why" ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            )}
            inert={step !== "why"}
          >
            <form
              className="overflow-hidden"
              onSubmit={(e) => {
                e.preventDefault();
                void send(false);
              }}
            >
              <label className="mt-3 block text-[13px] text-muted-foreground" htmlFor="guide-reason">
                Please say what was missing — we will work on it.
              </label>
              <textarea
                className="mt-2 block min-h-20 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50"
                id="guide-reason"
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                placeholder="The steps didn't match my screen…"
                value={reason}
              />
              <button
                className="mt-2 h-8 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-60"
                disabled={sending}
                type="submit"
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

/** Live hostels with their first exterior photo — the guide's "sponsor" column. */
export function HostelRail({ hostels, wide = false }: { hostels: GuideHostel[]; wide?: boolean }) {
  if (!hostels.length) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-semibold text-foreground">On HostelPalika</p>
        <Link className="text-xs font-medium text-primary hover:underline" href="/hostels">
          All
        </Link>
      </div>
      <ul className={cn("mt-3 grid gap-2", wide ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-8" : "grid-cols-2")}>
        {hostels.map((h) => (
          <li key={h.slug}>
            <Link className="group block" href={`/hostels/${h.slug}`}>
              <span className="relative block aspect-[4/3] overflow-hidden rounded-xl border border-border bg-muted">
                <span
                  aria-hidden
                  className="absolute inset-0 bg-cover bg-center transition-transform duration-300 ease-out group-hover:scale-105"
                  style={{ backgroundImage: `url("${optimizedImage(h.image, 384)}")` }}
                />
              </span>
              <span className="mt-1 block truncate text-[11.5px] font-medium text-foreground/80 group-hover:text-primary">
                {h.name}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
