"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { roomTypeOptions } from "./registration-fields";

export function nextAvailableRoomType(selected: string[]): string | undefined {
  return roomTypeOptions.find((option) => !selected.includes(option));
}

export function availableRoomTypes(selectedElsewhere: string[], search = ""): string[] {
  return roomTypeOptions.filter(
    (option) =>
      !selectedElsewhere.includes(option) &&
      option.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
}

export function RoomTypePicker({
  value,
  selectedElsewhere,
  onChange,
  label,
  invalid,
  className = "",
}: {
  value: string;
  selectedElsewhere: string[];
  onChange: (value: string) => void;
  label: string;
  invalid?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 240 });
  const filtered = availableRoomTypes(selectedElsewhere, search);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    const closeOnScroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnScroll);
    searchInput.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeOnScroll);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`} ref={root}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-invalid={invalid || undefined}
        className="input-field flex w-full items-center justify-between gap-2 text-left data-[invalid=true]:border-destructive"
        onClick={() => {
          const rect = root.current?.getBoundingClientRect();
          if (rect) setPosition({
            left: rect.left,
            top: window.innerHeight - rect.bottom < 280 && rect.top > 280
              ? rect.top - 280
              : rect.bottom + 4,
            width: Math.max(rect.width, 240),
          });
          setSearch("");
          setOpen((current) => !current);
        }}
      >
        <span className="truncate">{value || "Select a room type"}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && createPortal(
        <div ref={panel} style={position} className="fixed z-[100] rounded-xl border border-border bg-background p-2 shadow-lg">
          <div className="flex items-center gap-2 rounded-lg border border-border px-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchInput}
              aria-label={`Search ${label.toLowerCase()} options`}
              className="w-full bg-transparent py-2 text-sm outline-none"
              placeholder="Search room types"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
                if (event.key === "Enter" && filtered.length === 1) {
                  event.preventDefault();
                  onChange(filtered[0]);
                  setOpen(false);
                }
              }}
            />
          </div>
          <div role="listbox" aria-label={label} className="mt-1 max-h-56 overflow-y-auto">
            {filtered.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === value}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                {option}
                {option === value && <Check className="size-4 shrink-0 text-brand-teal" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">No available room types</p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
