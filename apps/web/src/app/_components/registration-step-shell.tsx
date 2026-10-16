"use client";

import { Check } from "@/components/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The calm one-section-at-a-time shell the public registration form wears.
 *
 * ## What it takes from the reference, and what it does not
 *
 * The reference flow is a vertical rail of named steps on the left and a single
 * card on the right that fades, lifts and sharpens as you move between them.
 * That layout is worth copying: it keeps the whole journey visible while asking
 * exactly one thing at a time, which is what makes a long form feel short.
 *
 * What is not copied is its palette. The reference is a warm off-white with its
 * own green; this uses `--brand-teal` on `--surface` like every other screen
 * here, because a registration form that looked like a different product than
 * the dashboard behind it would be the least trustworthy thing on the site.
 *
 * The motion is also deliberately quieter — see the note over `@keyframes
 * step-in` in `globals.css` for why the blur, travel and marker overshoot were
 * all reduced.
 *
 * ## Steps are named, not numbered
 *
 * The rail shows what each step is *for* ("Where it is", "Rooms and pricing")
 * rather than "Step 3". A number tells somebody how much is left; a name tells
 * them what they are about to be asked, which is the thing that lets them
 * decide whether they have the paperwork to hand.
 */

export type RegistrationStep = {
  /** One line under the name, in the rail. What this step is actually for. */
  description: string;
  key: number;
  label: string;
};

/**
 * Replays the entrance animation whenever the step changes.
 *
 * Keyed remounting would do the same thing in one line, but it would also throw
 * away the DOM of every field in the section — and with it any uncommitted
 * value, focus, or in-flight upload sitting inside. Re-running the animation on
 * a stable subtree keeps the movement and leaves the contents alone.
 */
export function StepFlow({
  children,
  className,
  stepKey,
}: {
  children: ReactNode;
  className?: string;
  stepKey: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;

      return;
    }

    const node = ref.current;

    if (!node) {
      return;
    }

    node.classList.remove("animate-step-in");
    // Reading a layout property forces the class removal to take effect before
    // it is re-added; without it the browser coalesces the two and nothing runs.
    void node.offsetWidth;
    node.classList.add("animate-step-in");
  }, [stepKey]);

  return (
    <div className={cn("animate-step-in", className)} ref={ref}>
      {children}
    </div>
  );
}

export function StepRail({
  currentStep,
  onStepSelect,
  stepComplete,
  steps,
}: {
  currentStep: number;
  onStepSelect: (step: number) => void;
  stepComplete: (step: number) => boolean;
  steps: RegistrationStep[];
}) {
  return (
    <nav aria-label="Registration steps" className="lg:sticky lg:top-24">
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        On this form
      </p>

      <ol className="space-y-0.5">
        {steps.map((step, index) => {
          const done = stepComplete(step.key);
          const active = step.key === currentStep;
          const last = index === steps.length - 1;

          return (
            <li className="relative flex gap-3" key={step.key}>
              <div className="flex flex-col items-center">
                <StepMarker active={active} done={done} index={index + 1} />
                {!last ? (
                  <span
                    className={cn(
                      "w-px flex-1 rounded-full transition-colors duration-300",
                      done ? "animate-rail-grow bg-brand-teal" : "bg-border",
                    )}
                  />
                ) : null}
              </div>

              <button
                className={cn(
                  "group -mt-0.5 flex-1 rounded-lg px-2 pb-6 pt-1 text-left transition",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal/40",
                  last && "pb-1",
                )}
                onClick={() => onStepSelect(step.key)}
                type="button"
              >
                <span
                  className={cn(
                    "block text-sm font-semibold transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  {step.label}
                </span>
                <span
                  className={cn(
                    "mt-0.5 block text-xs leading-relaxed transition-opacity",
                    active ? "text-muted-foreground" : "text-muted-foreground/70",
                  )}
                >
                  {step.description}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <p className="mt-2 pl-2 text-xs font-medium tabular-nums text-muted-foreground">
        {currentStep} / {steps.length}
      </p>
    </nav>
  );
}

function StepMarker({
  active,
  done,
  index,
}: {
  active: boolean;
  done: boolean;
  index: number;
}) {
  // Re-keyed on its own state so the settle animation runs on the transition
  // into "done" or "active" rather than on every parent render.
  const [key, setKey] = useState(0);
  const previous = useRef(`${active}-${done}`);

  useEffect(() => {
    const next = `${active}-${done}`;

    if (previous.current !== next) {
      previous.current = next;
      setKey((value) => value + 1);
    }
  }, [active, done]);

  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors",
        done
          ? "animate-marker-settle border-brand-teal bg-brand-teal text-white"
          : active
            ? "animate-marker-settle border-brand-teal bg-brand-teal/10 text-brand-teal"
            : "border-border bg-surface text-muted-foreground",
      )}
      key={key}
    >
      {done ? <Check className="size-3.5" strokeWidth={3} /> : index}
    </span>
  );
}
