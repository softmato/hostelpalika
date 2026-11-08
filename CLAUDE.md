## Go server work — READ `server/docs/MISSION.md` FIRST

Any work in `server/` starts by reading `server/docs/MISSION.md`: the owner's binding
brief, kept word for word. A bug found in the TS server is fixed in Go in the best way
and in TS too, never copied (`server/docs/RULES.md` §2). Routes match the web exactly.
Open findings live in `server/docs/review_fixes_needed.md`. All repo work is Claude's;
outside work, Claude does what it can reach and the owner helps or does the rest
(`MISSION.md` addition 4).

## Never quote a schedule, and never treat the repo as a ceiling

Two rules that apply to every plan, review, estimate and answer in this project.

work efficiently, patch with targeted edits instead of re-reading big files, and don't run Prettier on whole files.

### No day counts
Do not write "1 week", "2–3 days", "add a few days", "one sprint" or any other
duration for engineering work — not in plans, not in phase headings, not in
review notes, not in chat. Real production work takes as long as it takes, and a
number pulled out of the air only becomes a stick to be beaten with later.

Say what has to happen and in what order instead. **Sequence and dependency are
useful; duration is not.** "Phase 2 cannot start until the Wi-Fi read is proven
on a real Redmi" is worth writing. "Phase 2 — 2 weeks" is not.

If a phased plan arrives with durations in its headings, strip them; keep the
phases.

### The codebase is never the reason something can't be done
"That library isn't installed", "there's no native module for it", "the current
schema doesn't support it", "that would mean rewiring eight call sites" — none
of these are objections. Every one of them is just work, and the work is ours.

Raise a limit only when it comes from **outside** what we control: an OS
restriction, an app-store policy, a payment provider's rules, physics, the
hostel's own hardware. Those are real. Anything that lives inside this repo is
not a constraint — it is the next commit.

When something genuinely does need new libraries, a native module, a custom dev
build, a schema migration or a rewrite of an existing module, the correct output
is **what to build**, not a warning that it would be big.

## Mobile app work — READ THE DESIGN REFERENCES FIRST

Before creating or changing **any** screen, page, or component in `apps/mobile/`,
read these — every time, before writing code, not after:

1. `ui_inspiration_folder/app_recordings/NOTES.md` — the interaction vocabulary,
   with the frames it describes sitting beside it. Extracted from recordings of
   the Nepali fintech apps our users already use (EBL Touch 24, eSewa).
2. `ui_inspiration_folder/hostelhub_master_ui_screens/` — the per-portal screen
   mockups.
3. `docs/DESIGN.md` — the token and layout rules that are binding.
4. `apps/mobile/src/app/ui-preview.tsx` — the live gallery of what the admin
   surface currently looks like in code.

### The palette is not negotiable
The app is **black, white and green**: `--foreground` on `--background`, with
`--brand` / `--primary` (`#0a8a4b` light, `#12a95d` dark) as the only accent, plus
`--warning` / `--destructive` / `--success` where they carry meaning.

**Take layout, icons, assets and flow from the references. Never take colour.**
EBL's red, eSewa's dark ground and eSewa's lighter lime green are all out. Never
copy a literal hex out of a reference image.

### The rules those references encode
- A menu of destinations is an **icon-tile grid or tinted icon rows** — never
  full-width rows of sentences.
- Accent headers are painted **blocks with rounded bottom corners**, often with
  something straddling the bottom edge.
- Lists group by date, with the heading **outside** the card.
- Row overflow opens a **bottom sheet**, not an anchored menu.
- Loading is **skeletons**, not spinners.

### Reuse before inventing
Check `apps/mobile/src/components/ui/` first. `Card`, `DataCard`, `CardRow`,
`ListRow`, `InfoTile`, `Grid`, `Segmented`, `Sheet`, `Meter`, `Skeleton` and
`AppBar` already cover most of what these references show. Adding a near-duplicate
of an existing primitive is the mistake this codebase keeps warning about — if a
component's own doc comment argues against what you are about to do, read it
before overriding it.

## graphify - READ THIS FIRST then docs folder PHASES.md

This project uses a Graphify knowledge graph at `graphify-out/`. Treat that folder as the canonical fast-context map for the codebase.

### What you MUST do at the start of every session
1. Read `graphify-out/GRAPH_REPORT.md` before opening source files or running broad searches.
2. Read `README.md` for product/setup context.
3. If `graphify-out/wiki/index.md` exists, navigate it for relevant context before reading raw files.
4. If the user mentions a sprint, roadmap, tracker, or feature status, read the relevant tracker file.
5. For architecture questions, use `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"`.
6. If `graphify-out/GRAPH_REPORT.md` is missing, say the graph has not been generated yet, then read `README.md` and continue with the narrowest useful file reads.

### What you MUST NOT do
- Do not run `graphify extract .`, `/graphify`, or any full graph rebuild unless the user explicitly asks.
- Do not run broad searches before checking the graph for structure or dependency questions.
- Do not re-read files already summarized by the graph unless implementation details are needed.

### Keeping the graph fresh
- Run `graphify update .` after uncommitted code changes when the user asks about current structure but dont run auto only when user ask for this..
- Prefer git hooks with `graphify hook install` for normal commit/checkout updates.
- This repo also has a pre-push hook that runs `graphify update .` before code is pushed.
- Keep `graphify-out/GRAPH_REPORT.md` committed with the code. `graphify-out/graph.json` is local only (gitignored since 2026-11-08: 60+ MB, near GitHub's 100 MB limit); if it is missing, `graphify update .` rebuilds it.
