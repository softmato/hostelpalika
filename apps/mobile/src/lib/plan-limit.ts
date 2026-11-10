/**
 * The sheet a plan cap or the over-limit read-only opens, wherever it was hit:
 * `api.ts` calls `promptPlanLimit` on `PLAN_LIMIT_REACHED` / `PLAN_OVER_LIMIT`
 * and `PlanLimitHost` shows it. Plain listeners, no store library: one value.
 */
export type PlanLimitPrompt = { code: string; message: string };

let current: PlanLimitPrompt | null = null;
const listeners = new Set<(prompt: PlanLimitPrompt | null) => void>();

export function promptPlanLimit(prompt: PlanLimitPrompt | null) {
  current = prompt;
  listeners.forEach((listener) => listener(prompt));
}

export function subscribePlanLimit(listener: (prompt: PlanLimitPrompt | null) => void) {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
