"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PLATFORM_PLAY_STORE_URL } from "@hostel/shared/brand/brand";

import ShinyText from "@/components/react-bits/shiny-text";
import { useSiteConfig } from "@/components/site-config-provider";
import { browserApi } from "@/lib/browser-api";

type Pulse = {
  addedToday: number;
  hostels: number | null;
  latest: { city: string; name: string } | null;
  residents: number | null;
};

type Message = { href?: string; id: string; text: string };

type Phone = "android" | "ios" | null;

/** How long each line stays, and how often the cached figures are re-read. */
const HOLD_MS = 4800;
const REFRESH_MS = 60 * 1000;

const BRAND = "#0a8a4b";
const SHINE = "#8ff0b8";

function readPhone(): Phone {
  const agent = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
  if (/Android/i.test(agent)) return "android";
  return null;
}

/**
 * The top chip of the home hero: one short, true line at a time — what joined
 * today, how many are already here, and how to get the app on the phone in
 * front of the visitor. The figures come from one cached endpoint (a count per
 * minute for the whole site, not per visitor) and are re-read quietly while the
 * tab is open, so the chip stays current without a reload.
 */
export function HeroPulseChip() {
  const { apps, identity } = useSiteConfig();
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [phone, setPhone] = useState<Phone>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const slots = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    // The phone is only known in the browser; one sync after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhone(readPhone());
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const { pulse: next } = await browserApi<{ pulse: Pulse }>("/api/v1/public/pulse");
        if (alive) setPulse(next);
      } catch {
        // The chip simply keeps its fixed lines.
      }
    };
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const messages = useMemo<Message[]>(() => {
    const name = identity.siteName;
    const playHref = apps.androidPlayUrl || PLATFORM_PLAY_STORE_URL;
    const list: Message[] = [];

    if (pulse?.latest) {
      const where = pulse.latest.city ? ` in ${pulse.latest.city}` : "";
      list.push({ id: "latest", text: `${pulse.latest.name}${where} joined today` });
    }
    if (pulse && pulse.addedToday > 1) {
      list.push({ id: "today", text: `${pulse.addedToday} new hostels added today` });
    }
    list.push({ id: "trust", text: "Trusted by students & families" });
    if (pulse?.hostels) {
      list.push({ id: "hostels", text: `${pulse.hostels.toLocaleString("en-IN")} hostels already on ${name}` });
    }
    if (phone !== "ios") {
      list.push({ href: playHref, id: "play", text: "Install our app from Google Play" });
    }
    if (pulse?.residents) {
      list.push({ id: "residents", text: `${pulse.residents.toLocaleString("en-IN")} residents live in ${name} hostels` });
    }
    if (phone !== "android") {
      list.push({
        href: "/app?install",
        id: "pwa",
        text: phone === "ios" ? "On iPhone? Install from this site" : "iPhone? Install our app from this site",
      });
    }
    list.push({ id: "verified", text: "Verified listings, real photos, honest reviews" });
    list.push({ href: "/register-hostel", id: "owner", text: `Own a hostel? List it on ${name}` });

    return list;
  }, [apps.androidPlayUrl, identity.siteName, phone, pulse]);

  const count = messages.length;
  const active = index % count;
  const activeId = messages[active]?.id;

  useEffect(() => {
    if (paused || count < 2) return undefined;
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % count), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [active, count, paused]);

  // The chip hugs the line on show, easing to the next line's width as it changes.
  useLayoutEffect(() => {
    const slot = slots.current[active];
    if (slot) setWidth(slot.offsetWidth);
  }, [active, activeId, messages]);

  return (
    <span
      className="inline-flex max-w-full items-center gap-2 rounded-full border border-brand-teal/25 bg-card/70 px-3.5 py-1.5 text-xs font-semibold shadow-sm backdrop-blur"
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span aria-hidden className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-teal/60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-brand-teal" />
      </span>
      <span
        className="grid overflow-hidden transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={width === null ? undefined : { width }}
      >
        {messages.map((message, position) => {
          const isActive = position === active;
          const isLeaving = position === (active - 1 + count) % count;
          const state = isActive
            ? "translate-y-0 opacity-100 blur-none"
            : isLeaving
              ? "pointer-events-none -translate-y-3 opacity-0 blur-[3px]"
              : "pointer-events-none translate-y-3 opacity-0 blur-[3px]";
          const className = `col-start-1 row-start-1 w-max justify-self-start whitespace-nowrap transition-[opacity,transform,filter] duration-500 ease-out motion-reduce:transition-none ${state}`;
          const label = isActive ? (
            <ShinyText color={BRAND} delay={0} shineColor={SHINE} shineWidth={55} speed={1.4} trigger="view">
              {message.text}
            </ShinyText>
          ) : (
            <span className="text-brand-teal">{message.text}</span>
          );
          const attach = (node: HTMLElement | null) => {
            slots.current[position] = node;
          };

          // Plain anchors: `/app` is the exported phone app, outside Next's router.
          return message.href ? (
            <a
              aria-hidden={!isActive}
              className={`${className} hover:underline`}
              href={message.href}
              key={message.id}
              ref={attach}
              tabIndex={isActive ? 0 : -1}
            >
              {label}
            </a>
          ) : (
            <span aria-hidden={!isActive} className={className} key={message.id} ref={attach}>
              {label}
            </span>
          );
        })}
      </span>
    </span>
  );
}
