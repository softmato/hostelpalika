/**
 * "Bills make themselves", shown rather than told (owner's notebook, 2026-11-16:
 * "show demo animated video in screen"). A CSS loop, not a video file: it is
 * crisp at any size, weighs nothing, and needs no re-shoot when copy changes.
 *
 * One cycle (9 s): bill day arrives → each resident's bill is sent → the
 * resident's phone gets it with its month code → the first one turns Paid.
 * Reduced motion shows the finished state.
 */
const ROWS = [
  { name: "Sita Rai", room: "Room 201", amount: "Rs 6,200" },
  { name: "Ram Thapa", room: "Room 104", amount: "Rs 5,800" },
  { name: "Gita KC", room: "Room 305", amount: "Rs 6,200" },
];

const CSS = `
@keyframes ab-in { 0%, 12% { opacity: 0; transform: translateY(6px) } 16%, 80% { opacity: 1; transform: none } 88%, 100% { opacity: 0 } }
@keyframes ab-day { 0% { opacity: 0; transform: scale(.9) } 6%, 92% { opacity: 1; transform: none } 100% { opacity: 0 } }
@keyframes ab-toast { 0%, 50% { opacity: 0; transform: translateY(-10px) } 56%, 92% { opacity: 1; transform: none } 100% { opacity: 0 } }
@keyframes ab-due { 0%, 66% { opacity: 1 } 70%, 100% { opacity: 0 } }
@keyframes ab-paid { 0%, 66% { opacity: 0 } 70%, 80% { opacity: 1 } 88%, 100% { opacity: 0 } }
.ab-day { animation: ab-day 9s ease-out infinite }
.ab-sent { opacity: 0; animation: ab-in 9s ease-out infinite }
.ab-toast { animation: ab-toast 9s ease-out infinite }
.ab-due { animation: ab-due 9s linear infinite }
.ab-paid { opacity: 0; animation: ab-paid 9s ease-out infinite }
@media (prefers-reduced-motion: reduce) {
  .ab-day, .ab-sent, .ab-toast, .ab-paid { animation: none; opacity: 1; transform: none }
  .ab-due { animation: none; opacity: 0 }
}
`;

export function AutoBillingDemo() {
  return (
    <figure aria-label="Animation: on bill day the app sends every resident their bill" className="overflow-hidden rounded-2xl border border-border bg-muted/40 p-5 sm:p-6">
      <style>{CSS}</style>
      <div className="grid gap-5 sm:grid-cols-[1fr_15rem] sm:items-start">
        <div className="rounded-xl border border-border bg-background p-4">
          <div className="ab-day mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Bhadra 1 · bill day</span>
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">Automatic</span>
          </div>
          <ul className="divide-y divide-border">
            {ROWS.map((row, i) => (
              <li className="flex items-center justify-between gap-3 py-2.5" key={row.name}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{row.name}</span>
                  <span className="block text-xs text-muted-foreground">{row.room} · {row.amount}</span>
                </span>
                <span
                  className="ab-sent relative shrink-0 rounded-full bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground"
                  style={{ animationDelay: `${i * 0.9}s` }}
                >
                  {i === 0 ? (
                    <>
                      <span className="ab-due">Bill sent</span>
                      <span className="ab-paid absolute inset-0 flex items-center justify-center">Paid ✓</span>
                    </>
                  ) : (
                    "Bill sent"
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mx-auto w-full max-w-60 rounded-[1.75rem] border-4 border-foreground/80 bg-background p-3 shadow-sm">
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-foreground/20" />
          <div className="ab-toast rounded-xl border border-border bg-muted p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">HostelPalika</p>
            <p className="mt-1 text-sm font-semibold text-foreground">Your Bhadra bill: Rs 6,200</p>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">Code RUP-482K-BHA83</p>
          </div>
          <div className="mt-3 space-y-2" aria-hidden>
            <div className="h-2 w-3/4 rounded bg-foreground/10" />
            <div className="h-2 w-1/2 rounded bg-foreground/10" />
          </div>
        </div>
      </div>
      <figcaption className="mt-4 text-sm text-muted-foreground">
        On bill day every resident gets their bill on their phone, with its month code. Nobody presses anything.
      </figcaption>
    </figure>
  );
}
