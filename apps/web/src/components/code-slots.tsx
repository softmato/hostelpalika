"use client";

/**
 * One-time-code slots (React Bits "CodeSlots", ported to TS). Digits land with a
 * spring, a wrong code drains, a right one washes green. The tick is inline so
 * no icon package is added.
 */
import { animate, motion, motionValue, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import "./code-slots.css";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const WASH_IN = 0.3;
const WASH_OUT = 0.2;
const SINK_DELAY = 0.06;
const SINK_STEP = 0.03;
const CHECK_DELAY = 0.28;
const CHECK_RISE = 8;
const SINK_FADE = 0.6;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const digitsOf = (raw: unknown) => String(raw ?? "").replace(/\D/g, "");
const toSlots = (raw: unknown, n: number) => {
  const d = digitsOf(raw).slice(0, n);
  return Array.from({ length: n }, (_, i) => d[i] ?? "");
};
const firstEmptyOf = (slots: string[]) => {
  const i = slots.indexOf("");
  return i === -1 ? slots.length - 1 : i;
};
const isFull = (slots: string[]) => slots.every(Boolean);

export type CodeSlotsProps = {
  accentColor?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  bounce?: number;
  caret?: boolean;
  cascade?: number;
  className?: string;
  dangerColor?: string;
  defaultValue?: string;
  digitColor?: string;
  disabled?: boolean;
  edgeColor?: string;
  gap?: number;
  inkColor?: string;
  length?: number;
  mask?: boolean;
  onChange?: (code: string) => void;
  onComplete?: (code: string) => void;
  radius?: number;
  rise?: number;
  settle?: number;
  slotColor?: string;
  slotSize?: number;
  status?: "idle" | "error" | "success";
  value?: string;
};

export function CodeSlots({
  length = 6,
  value,
  defaultValue = "",
  onChange,
  onComplete,
  status = "idle",
  mask = false,
  caret = true,
  disabled = false,
  autoFocus = false,
  accentColor = "#f5f5f5",
  inkColor = "#f5f5f5",
  slotColor = "#27272a",
  edgeColor = "transparent",
  digitColor = "#18181b",
  dangerColor = "#ff3b30",
  slotSize = 44,
  gap = 8,
  radius = 12,
  bounce = 0.2,
  settle = 0.3,
  rise = 8,
  cascade = 20,
  ariaLabel = "One-time code",
  className = "",
}: CodeSlotsProps) {
  const uid = useId();
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(() => toSlots(value ?? defaultValue, length));
  const [active, setActive] = useState(() => firstEmptyOf(slots));
  const [focused, setFocused] = useState(false);
  const [veiled, setVeiled] = useState(status === "success");
  const activeMv = useMotionValue(active);
  const openMv = useMotionValue(status === "success" ? 1 : 0);
  const checkMv = useMotionValue(status === "success" ? 1 : 0);
  const glide = useRef(new Set<number>());
  const target = useRef<number[]>([]);
  const draining = useRef(false);
  const drainTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const statusRef = useRef(status);
  const emitted = useRef(digitsOf(value ?? defaultValue).slice(0, length));
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const live = useRef({ bounce, cascade, reduce, settle });
  live.current = { bounce, cascade, reduce, settle };
  const callbacks = useRef({ onChange, onComplete });
  callbacks.current = { onChange, onComplete };

  const springs = useMemo(
    () => ({
      drops: Array.from({ length }, () => motionValue(statusRef.current === "success" ? 1 : 0)),
      mvs: Array.from({ length }, (_, i) => motionValue(slotsRef.current[i] ? 1 : 0)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [length],
  );
  const { drops, mvs } = springs;
  const pitch = slotSize + gap;
  const height = Math.round(slotSize * 1.18);
  const washRadius = Math.min(radius, slotSize / 2);

  const drive = useCallback(
    (i: number, to: number, delayMs = 0) => {
      const mv = mvs[i];
      if (!mv) return;
      target.current[i] = to;
      const L = live.current;
      if (L.reduce) {
        mv.jump(to);
        return;
      }
      animate(mv, to, { bounce: L.bounce, delay: delayMs / 1000, duration: L.settle, type: "spring" });
    },
    [mvs],
  );
  const land = useCallback(
    (i: number, delayMs = 0) => {
      if (mvs[i].get() > 0) mvs[i].jump(0);
      drive(i, 1, delayMs);
    },
    [mvs, drive],
  );
  const moveActive = useCallback(
    (next: number, crossed: number[]) => {
      crossed.forEach((j) => glide.current.add(j));
      activeMv.jump(next);
      setActive(next);
    },
    [activeMv],
  );
  const jumpActive = useCallback(
    (next: number) => {
      glide.current.clear();
      activeMv.jump(next);
      setActive(next);
    },
    [activeMv],
  );

  const caretX = useTransform(() => {
    const a = activeMv.get();
    let x = a * pitch;
    for (let j = 0; j < mvs.length; j++) {
      const h = clamp01(mvs[j].get());
      if (!glide.current.has(j)) continue;
      const to = target.current[j];
      if (to === undefined || h === clamp01(to)) {
        glide.current.delete(j);
        continue;
      }
      x += j < a ? -(1 - h) * pitch : h * pitch;
    }
    return Math.min(Math.max(x, 0), (mvs.length - 1) * pitch);
  });
  const caretTransform = useTransform(caretX, (x) => `translateX(${x}px)`);
  const washClip = useTransform(openMv, (o) => `inset(0 ${(1 - clamp01(o)) * 50}% round ${washRadius}px)`);
  const checkTransform = useTransform(checkMv, (c) => `translateY(${(1 - c) * CHECK_RISE}px) scale(${0.85 + 0.15 * Math.max(c, 0)})`);
  const checkOpacity = useTransform(checkMv, clamp01);

  const commit = useCallback((next: string[]) => {
    const prev = slotsRef.current;
    slotsRef.current = next;
    setSlots(next);
    const code = next.join("");
    emitted.current = code;
    callbacks.current.onChange?.(code);
    if (!isFull(prev) && isFull(next)) callbacks.current.onComplete?.(code);
  }, []);

  const insert = (raw: string, from = active) => {
    const digits = digitsOf(raw);
    if (!digits) return;
    const next = [...slotsRef.current];
    const crossed: number[] = [];
    const step = reduce ? 0 : cascade;
    let i = from;
    for (const ch of digits) {
      if (i >= length) break;
      next[i] = ch;
      land(i, (i - from) * step);
      crossed.push(i);
      i += 1;
    }
    if (!crossed.length) return;
    commit(next);
    moveActive(Math.min(i, length - 1), crossed);
  };
  const clearSlot = (i: number, stepBack = false) => {
    if (!slotsRef.current[i]) {
      if (stepBack) jumpActive(i);
      return;
    }
    const next = [...slotsRef.current];
    next[i] = "";
    drive(i, 0);
    commit(next);
    if (stepBack) moveActive(i, [i]);
  };

  const busy = disabled || draining.current || status === "success";
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (busy || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (/^[0-9]$/.test(k)) {
      e.preventDefault();
      insert(k);
    } else if (k === "Backspace") {
      e.preventDefault();
      if (slots[active]) clearSlot(active);
      else if (active > 0) clearSlot(active - 1, true);
    } else if (k === "Delete") {
      e.preventDefault();
      clearSlot(active);
    } else if (k === "ArrowLeft") {
      e.preventDefault();
      jumpActive(Math.max(active - 1, 0));
    } else if (k === "ArrowRight") {
      e.preventDefault();
      jumpActive(Math.min(active + 1, length - 1));
    } else if (k === "Home") {
      e.preventDefault();
      jumpActive(0);
    } else if (k === "End") {
      e.preventDefault();
      jumpActive(length - 1);
    }
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (busy) return;
    e.preventDefault();
    insert(e.clipboardData.getData("text"));
  };
  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (busy) return;
    const d = digitsOf(e.target.value);
    if (!d) return;
    insert(d, d.length === 1 ? active : 0);
  };
  const onRowMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    const row = rowRef.current;
    if (row && !draining.current && status !== "success") {
      const rect = row.getBoundingClientRect();
      const zoom = rect.width / (row.offsetWidth || rect.width) || 1;
      const i = Math.floor((e.clientX - rect.left) / zoom / pitch);
      jumpActive(Math.max(0, Math.min(i, firstEmptyOf(slotsRef.current))));
    }
    inputRef.current?.focus();
  };

  useEffect(() => {
    glide.current.clear();
    target.current = [];
    const next = Array.from({ length }, (_, i) => slotsRef.current[i] ?? "");
    slotsRef.current = next;
    setSlots(next);
    jumpActive(firstEmptyOf(next));
    const code = next.join("");
    if (code !== emitted.current) {
      emitted.current = code;
      callbacks.current.onChange?.(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [length]);

  useEffect(() => {
    if (value === undefined) return;
    const clean = digitsOf(value).slice(0, length);
    if (clean === emitted.current) return;
    emitted.current = clean;
    const prev = slotsRef.current;
    const next = toSlots(clean, length);
    const hidden = statusRef.current === "success";
    const landing: number[] = [];
    const leaving: number[] = [];
    next.forEach((ch, i) => {
      if (ch === prev[i]) return;
      (ch ? landing : leaving).push(i);
    });
    const step = live.current.reduce || hidden ? 0 : live.current.cascade;
    landing.forEach((i, k) => land(i, k * step));
    leaving.reverse().forEach((i, k) => {
      if (hidden) {
        target.current[i] = 0;
        mvs[i].jump(0);
        drops[i].jump(0);
      } else drive(i, 0, k * step);
    });
    slotsRef.current = next;
    setSlots(next);
    moveActive(firstEmptyOf(next), [...landing, ...leaving]);
    if (!isFull(prev) && isFull(next)) callbacks.current.onComplete?.(clean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, length]);

  useEffect(() => {
    const was = statusRef.current;
    const L = live.current;
    if (status === "success") {
      setVeiled(true);
      if (L.reduce) {
        openMv.jump(1);
        drops.forEach((d) => d.jump(1));
        checkMv.jump(1);
        return;
      }
      animate(openMv, 1, { duration: WASH_IN, ease: EASE_OUT });
      drops.forEach((d, k) => animate(d, 1, { bounce: 0, delay: SINK_DELAY + k * SINK_STEP, duration: 0.3, type: "spring" }));
      animate(checkMv, 1, { bounce: L.bounce, delay: CHECK_DELAY, duration: 0.35, type: "spring" });
      return;
    }
    if (was !== "success") return;
    if (L.reduce) {
      openMv.jump(0);
      checkMv.jump(0);
      drops.forEach((d) => d.jump(0));
      setVeiled(false);
      return;
    }
    animate(checkMv, 0, { duration: 0.15, ease: EASE_OUT });
    animate(openMv, 0, { delay: 0.06, duration: WASH_OUT, ease: EASE_OUT }).then(() => {
      if (openMv.get() === 0) setVeiled(false);
    });
    drops.forEach((d) => animate(d, 0, { bounce: 0, delay: 0.1, duration: 0.3, type: "spring" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (status !== "error") return;
    const filled = slotsRef.current.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    if (!filled.length) return;
    filled.reverse();
    draining.current = true;
    const L = live.current;
    const step = L.reduce ? 0 : L.cascade;
    filled.forEach((i, k) => drive(i, 0, k * step));
    moveActive(0, slotsRef.current.map((_, j) => j));
    clearTimeout(drainTimer.current);
    drainTimer.current = setTimeout(
      () => {
        draining.current = false;
        commit(Array.from({ length }, () => ""));
      },
      L.reduce ? 300 : (filled.length - 1) * step + L.settle * 1000,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => () => clearTimeout(drainTimer.current), []);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const view = slots.length === length ? slots : Array.from({ length }, (_, i) => slots[i] ?? "");
  const showCaret = caret && focused && !disabled && !veiled && status !== "success" && (status === "error" || !view[active]);

  return (
    <div
      className={`code-slots${className ? ` ${className}` : ""}`}
      style={
        {
          "--cs-accent": accentColor,
          "--cs-danger": dangerColor,
          "--cs-digit": digitColor,
          "--cs-edge": edgeColor,
          "--cs-font": `${Math.round(slotSize * 0.5)}px`,
          "--cs-gap": `${gap}px`,
          "--cs-height": `${height}px`,
          "--cs-ink": inkColor,
          "--cs-radius": `${Math.min(radius, slotSize / 2)}px`,
          "--cs-size": `${slotSize}px`,
          "--cs-slot": slotColor,
        } as React.CSSProperties
      }
    >
      <div
        className="code-slots__row"
        data-disabled={disabled ? "" : undefined}
        data-focused={focused ? "" : undefined}
        data-status={status}
        onMouseDown={onRowMouseDown}
        ref={rowRef}
      >
        <input
          aria-describedby={`${uid}-count`}
          aria-invalid={status === "error"}
          aria-label={ariaLabel}
          autoComplete="one-time-code"
          className="code-slots__input"
          disabled={disabled}
          inputMode="numeric"
          maxLength={length}
          onBlur={() => setFocused(false)}
          onChange={onInput}
          onFocus={() => setFocused(true)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          pattern="[0-9]*"
          readOnly={status === "success"}
          ref={inputRef}
          type="text"
          value=""
        />
        {view.map((ch, i) => (
          <Slot active={focused && i === active} char={mask && ch ? "•" : ch} drop={drops[i]} key={i} mv={mvs[i]} rise={rise} sink={Math.round(height * 0.5)} />
        ))}
        <motion.span aria-hidden="true" className="code-slots__wash" style={{ clipPath: washClip }}>
          <motion.span className="code-slots__check" style={{ opacity: checkOpacity, transform: checkTransform }}>
            <svg fill="none" height={Math.round(slotSize * 0.6)} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} viewBox="0 0 24 24" width={Math.round(slotSize * 0.6)}>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </motion.span>
        </motion.span>
        <motion.span aria-hidden="true" className="code-slots__caret" data-show={showCaret ? "" : undefined} style={{ transform: caretTransform }}>
          <span className="code-slots__caret-line" key={active} />
        </motion.span>
      </div>
      <span aria-live="polite" className="code-slots__sr" id={`${uid}-count`}>
        {status === "success" ? "Code accepted" : `${view.filter(Boolean).length} of ${length} digits entered`}
      </span>
    </div>
  );
}

function Slot({
  active,
  char,
  drop,
  mv,
  rise,
  sink,
}: {
  active: boolean;
  char: string;
  drop: ReturnType<typeof motionValue<number>>;
  mv: ReturnType<typeof motionValue<number>>;
  rise: number;
  sink: number;
}) {
  const [shown, setShown] = useState(char);
  if (char && char !== shown) setShown(char);
  const fill = useTransform(mv, (t) => `scale(${Math.max(t, 0)})`);
  const lift = useTransform([mv, drop], ([t, d]: number[]) => `translateY(${(1 - t) * rise + Math.max(d, 0) * sink}px)`);
  const ink = useTransform([mv, drop], ([t, d]: number[]) => clamp01(t) * (1 - clamp01(d / SINK_FADE)));
  return (
    <span aria-hidden="true" className="code-slots__slot" data-active={active ? "" : undefined} data-filled={char ? "" : undefined}>
      <motion.span className="code-slots__fill" style={{ transform: fill }} />
      {shown ? (
        <motion.span className="code-slots__digit" style={{ opacity: ink, transform: lift }}>
          {shown}
        </motion.span>
      ) : null}
    </span>
  );
}
