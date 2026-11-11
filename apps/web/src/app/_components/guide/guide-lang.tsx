"use client";

import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

/**
 * English / नेपाली on the guide. Both languages are in the page (it is static), and
 * `html[data-guide-lang]` shows one: see `.guide-en` / `.guide-ne` in globals.css.
 * The choice is kept per browser; `GUIDE_LANG_SCRIPT` sets it before first paint.
 */
const KEY = "guide-lang";
type Lang = "en" | "ne";

export const GUIDE_LANG_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(KEY)})==="ne")document.documentElement.dataset.guideLang="ne";}catch(e){}})()`;

const subscribe = (onChange: () => void) => {
  window.addEventListener(KEY, onChange);
  return () => window.removeEventListener(KEY, onChange);
};
const readLang = (): Lang => (document.documentElement.dataset.guideLang === "ne" ? "ne" : "en");

export function GuideLangSwitch() {
  const lang = useSyncExternalStore(subscribe, readLang, () => "en" as Lang);

  const pick = (next: Lang) => {
    document.documentElement.setAttribute("data-guide-lang", next);
    window.dispatchEvent(new Event(KEY));
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private window: the switch still works for this visit.
    }
  };

  return (
    <div aria-label="Language" className="flex shrink-0 rounded-full border border-border p-0.5 text-xs font-semibold" role="radiogroup">
      {(
        [
          ["en", "EN"],
          ["ne", "नेपाली"],
        ] as const
      ).map(([value, label]) => (
        <button
          aria-checked={lang === value}
          className={cn(
            "rounded-full px-2.5 py-1 transition-colors duration-150",
            lang === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          key={value}
          lang={value === "ne" ? "ne" : undefined}
          onClick={() => pick(value)}
          role="radio"
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
