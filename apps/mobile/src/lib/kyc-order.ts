/**
 * KYC chapters (TODO.md H1, guide 3): easy taps first, documents and the
 * signature last. Room types come before rooms — rooms are numbered by type.
 * A key the server adds later lands in a trailing "More" chapter, never lost.
 */
export const KYC_CHAPTERS = [
  { keys: ["location", "details", "facilities", "photos"], title: "Your hostel" },
  { keys: ["rates", "rooms"], title: "Rooms & price" },
  { keys: ["food", "rules"], title: "Daily life" },
  { keys: ["payments", "payout", "opening"], title: "Money" },
  { keys: ["documents", "agreement"], title: "Verify" },
] as const;

type Step = { done: boolean; key: string; required?: boolean };

/** The server's steps grouped into chapters, in chapter order. */
export function kycChapters<T extends Step>(steps: T[]): { steps: T[]; title: string }[] {
  const known = new Set<string>(KYC_CHAPTERS.flatMap((chapter) => [...chapter.keys]));
  const chapters = KYC_CHAPTERS.map((chapter) => ({
    steps: chapter.keys.flatMap((key) => steps.filter((step) => step.key === key)),
    title: chapter.title as string,
  }));
  const extra = steps.filter((step) => !known.has(step.key));
  return [...chapters, { steps: extra, title: "More" }].filter((chapter) => chapter.steps.length);
}

/** Every step in walking order. */
export const kycOrder = <T extends Step>(steps: T[]) => kycChapters(steps).flatMap((chapter) => chapter.steps);

/** Where Continue goes: the first step not done, in walking order. */
export const firstOpenStep = (steps: Step[]) => kycOrder(steps).find((step) => !step.done)?.key ?? null;

/** Where Save & next goes from `key`: the next step not done after it, or null (→ review). */
export function nextOpenStep(steps: Step[], key: string) {
  const order = kycOrder(steps);
  const at = order.findIndex((step) => step.key === key);
  return order.slice(at + 1).find((step) => !step.done)?.key ?? null;
}
