"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

type ThemeToggleProps = {
  className?: string;
  menu?: boolean;
};

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
const currentTheme = () => document.documentElement.classList.contains("dark");
const serverTheme = () => false;

export function ThemeToggle({ className, menu = false }: ThemeToggleProps) {
  const isDark = useSyncExternalStore(subscribeTheme, currentTheme, serverTheme);

  const toggleTheme = () => {
    const next = !isDark;
    document.documentElement.classList.toggle("dark", next);
  };

  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      aria-label={label}
      className={cn(
        menu
          ? "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          : "inline-flex size-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground",
        className,
      )}
      onClick={toggleTheme}
      title={isDark ? "Light theme" : "Dark theme"}
      type="button"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      {menu ? <span>{isDark ? "Light theme" : "Dark theme"}</span> : null}
    </button>
  );
}
