"use client";

import { AlertCircle, Check, ChevronDown, ChevronUp, Loader2, Plus, RotateCcw, Trash2 } from "@/components/icons";
import { useCallback, useState, type ReactNode } from "react";

import { LoadingRows } from "@/app/_components/shared-ui";
import {
  PortalPageHeader,
  RoleButton,
  SoftBadge,
  type BreadcrumbItem,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { DEFAULT_SITE_CONFIG } from "@/modules/platform-config/site-config.defaults";
import type {
  SiteConfig,
  SiteConfigSection,
} from "@/modules/platform-config/site-config.validation";
import { cn } from "@/lib/utils";

type LoadState = "idle" | "loading" | "ready" | "error";

/**
 * Loads the whole site config once, then tracks a per-section draft so each card
 * on a page saves independently — an admin editing the hero shouldn't have to
 * re-submit the stats block sitting next to it.
 */
export function useSiteConfigDraft() {
  const [drafts, setDrafts] = useState<Partial<SiteConfig>>({});
  const [savingSection, setSavingSection] = useState<SiteConfigSection | null>(null);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  const invalidate = useInvalidateResources();
  // One cache entry shared by every config screen, so moving between them no
  // longer refetches the whole config each time.
  const configResource = usePortalResource<{ config: SiteConfig }>(
    platformEndpoints.siteConfig,
    { errorMessage: "Could not load site configuration." },
  );

  const config = configResource.data?.config ?? DEFAULT_SITE_CONFIG;
  const state = configResource.state;
  const error = saveError || configResource.message;

  const valueFor = useCallback(
    <Section extends SiteConfigSection>(section: Section): SiteConfig[Section] =>
      (drafts[section] ?? config[section]) as SiteConfig[Section],
    [config, drafts],
  );

  const setValue = useCallback(
    <Section extends SiteConfigSection>(section: Section, next: SiteConfig[Section]) => {
      setDrafts((current) => ({ ...current, [section]: next }));
      setMessage("");
    },
    [],
  );

  const isDirty = useCallback(
    (section: SiteConfigSection) =>
      drafts[section] !== undefined &&
      JSON.stringify(drafts[section]) !== JSON.stringify(config[section]),
    [config, drafts],
  );

  const reset = useCallback((section: SiteConfigSection) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[section];
      return next;
    });
    setMessage("");
  }, []);

  const save = useCallback(
    async (section: SiteConfigSection) => {
      setSavingSection(section);
      setSaveError("");
      setMessage("");

      try {
        const payload = drafts[section] ?? config[section];
        await browserApi<{ section: string; value: unknown }>(
          `${platformEndpoints.siteConfig}/${section}`,
          { body: JSON.stringify(payload), method: "PUT" },
        );

        // Refetch rather than patching a local copy: the cached config is shared
        // with every other config screen and the Fee Plans page.
        invalidate(platformEndpoints.siteConfig);
        setDrafts((current) => {
          const next = { ...current };
          delete next[section];
          return next;
        });
        setMessage("Saved — the public site now shows these values.");
      } catch (error_) {
        setSaveError(error_ instanceof Error ? error_.message : "Could not save.");
      } finally {
        setSavingSection(null);
      }
    },
    [config, drafts, invalidate],
  );

  return {
    error,
    isDirty,
    message,
    reset,
    save,
    savingSection,
    setValue,
    state,
    valueFor,
  };
}

export function ConfigPage({
  breadcrumb,
  children,
  description,
  error,
  message,
  state,
  title,
}: {
  breadcrumb: BreadcrumbItem[];
  children: ReactNode;
  description: string;
  error?: string;
  message?: string;
  state: LoadState;
  title: string;
}) {
  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      <PortalPageHeader breadcrumb={breadcrumb} description={description} title={title} />

      {message ? (
        <div className="flex items-center gap-2 rounded-xl border border-role-team/20 bg-role-team-soft px-3 py-2 text-[12.5px] font-medium text-role-team">
          <Check className="size-3.5 shrink-0" />
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200/80 bg-rose-50 px-3 py-2 text-[12.5px] font-medium text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {state === "loading" ? <LoadingRows /> : null}
      {state === "ready" ? children : null}
    </div>
  );
}

/** Card wrapper with its own dirty indicator and save/revert controls. */
export function ConfigCard({
  children,
  description,
  dirty,
  onReset,
  onSave,
  saving,
  title,
}: {
  children: ReactNode;
  description?: string;
  dirty: boolean;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {dirty ? <SoftBadge tone="amber">Unsaved</SoftBadge> : null}
          </div>
          {description ? (
            <p className="mt-0.5 line-clamp-1 text-[12px] text-muted-foreground" title={description}>
              {description}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {dirty ? (
            <button
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11.5px] font-semibold text-muted-foreground transition hover:bg-muted"
              onClick={onReset}
              type="button"
            >
              <RotateCcw className="size-3" />
              Revert
            </button>
          ) : null}
          <RoleButton disabled={!dirty || saving} onClick={onSave} tone="platform">
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Save
          </RoleButton>
        </div>
      </header>

      <div className="space-y-3 p-4">{children}</div>
    </section>
  );
}

export function TextField({
  hint,
  label,
  onChange,
  placeholder,
  readOnly,
  value,
}: {
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-foreground">
        {label}
      </span>
      <input
        className="h-10 w-full rounded-xl border border-border bg-background px-3 text-[13.5px] outline-none transition focus:border-role-platform focus:ring-2 focus:ring-role-platform/15"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        type="text"
        value={value}
      />
      {hint ? (
        <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextAreaField({
  hint,
  label,
  onChange,
  placeholder,
  rows = 4,
  value,
}: {
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-foreground">
        {label}
      </span>
      <textarea
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] outline-none transition focus:border-role-platform focus:ring-2 focus:ring-role-platform/15"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        value={value}
      />
      {hint ? (
        <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * Generic add/remove/reorder list editor. `renderRow` gets the item plus a
 * patch helper so callers only describe the fields, not the array plumbing.
 */
export function Repeater<Item>({
  addLabel,
  emptyLabel = "Nothing here yet.",
  items,
  makeItem,
  max,
  onChange,
  renderRow,
}: {
  addLabel: string;
  emptyLabel?: string;
  items: Item[];
  makeItem: () => Item;
  max?: number;
  onChange: (next: Item[]) => void;
  renderRow: (
    item: Item,
    patch: (changes: Partial<Item>) => void,
    index: number,
  ) => ReactNode;
}) {
  const canAdd = max == null || items.length < max;

  function patchAt(index: number, changes: Partial<Item>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...changes } : item)));
  }

  function removeAt(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-[12.5px] text-muted-foreground">
          {emptyLabel}
        </p>
      ) : null}

      {items.map((item, index) => (
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3" key={index}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-card text-[11px] font-bold text-muted-foreground ring-1 ring-border">
              {index + 1}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                aria-label="Move up"
                className="rounded-lg p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                disabled={index === 0}
                onClick={() => move(index, -1)}
                type="button"
              >
                <ChevronUp className="size-3.5" />
              </button>
              <button
                aria-label="Move down"
                className="rounded-lg p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                disabled={index === items.length - 1}
                onClick={() => move(index, 1)}
                type="button"
              >
                <ChevronDown className="size-3.5" />
              </button>
              <button
                aria-label="Remove"
                className="rounded-lg p-1 text-muted-foreground transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40"
                onClick={() => removeAt(index)}
                type="button"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
          {renderRow(item, (changes) => patchAt(index, changes), index)}
        </div>
      ))}

      <button
        className={cn(
          "inline-flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform",
          !canAdd && "pointer-events-none opacity-40",
        )}
        onClick={() => onChange([...items, makeItem()])}
        type="button"
      >
        <Plus className="size-3.5" />
        {addLabel}
      </button>
    </div>
  );
}

/** Parses a comma/newline separated textarea back into a string[] field. */
export function parseListField(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * A numeric field. `nullable` makes an empty box mean "no ceiling" rather than
 * zero — the difference between a plan that houses nobody and one that houses
 * everybody, which is not a distinction a number input makes on its own.
 *
 * The value is held as the string the admin typed, so a half-typed "1" on the
 * way to "150" does not get parsed, rounded and written back under the caret.
 */
export function NumberField({
  hint,
  label,
  max,
  min = 0,
  nullable = false,
  nullLabel = "No limit",
  onChange,
  prefix,
  suffix,
  value,
}: {
  hint?: string;
  label: string;
  max?: number;
  min?: number;
  nullable?: boolean;
  nullLabel?: string;
  onChange: (value: number | null) => void;
  prefix?: string;
  suffix?: string;
  value: number | null;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-foreground">
        {label}
      </span>
      <span className="flex h-10 items-center gap-1 rounded-xl border border-border bg-background px-3 transition focus-within:border-role-platform focus-within:ring-2 focus-within:ring-role-platform/15">
        {prefix ? (
          <span className="text-[11px] font-semibold text-muted-foreground">{prefix}</span>
        ) : null}
        <input
          className="w-full bg-transparent text-[13.5px] outline-none"
          inputMode="decimal"
          max={max}
          min={min}
          onChange={(event) => {
            const raw = event.target.value.trim();

            if (raw === "") {
              onChange(nullable ? null : 0);
              return;
            }

            const parsed = Number(raw);

            if (Number.isFinite(parsed)) {
              onChange(parsed);
            }
          }}
          placeholder={nullable ? nullLabel : "0"}
          type="number"
          value={value ?? ""}
        />
        {suffix ? (
          <span className="text-[11px] font-semibold text-muted-foreground">{suffix}</span>
        ) : null}
      </span>
      {hint ? (
        <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * One Save for the whole screen, pinned to the top of it.
 *
 * The alternative — a save button per card, as the other config screens have —
 * makes no sense here: every control on this page writes into the same `plans`
 * document, so three buttons would be three ways to send the same payload.
 */
export function ConfigSaveBar({
  dirty,
  onReset,
  onSave,
  saving,
}: {
  dirty: boolean;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/70 bg-card/95 px-4 py-2.5 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-semibold text-foreground">
          {dirty ? "Unsaved changes" : "Everything saved"}
        </span>
        {dirty ? <SoftBadge tone="amber">Draft</SoftBadge> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {dirty ? (
          <button
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11.5px] font-semibold text-muted-foreground transition hover:bg-muted"
            onClick={onReset}
            type="button"
          >
            <RotateCcw className="size-3" />
            Revert
          </button>
        ) : null}
        <RoleButton disabled={!dirty || saving} onClick={onSave} tone="platform">
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Save
        </RoleButton>
      </div>
    </div>
  );
}

/** A titled card with no save controls of its own — the page owns the Save. */
export function ConfigPanel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-4 py-3">
        <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? (
          <p className="mt-0.5 line-clamp-1 text-[12px] text-muted-foreground" title={description}>
            {description}
          </p>
        ) : null}
      </header>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  );
}
