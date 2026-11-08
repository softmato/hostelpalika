## graphify - READ THIS FIRST

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
- Run `graphify update .` after uncommitted code changes when the user asks about current structure.
- Prefer git hooks with `graphify hook install` for normal commit/checkout updates.
- This repo also has a pre-push hook that runs `graphify update .` before code is pushed.
- Keep `graphify-out/GRAPH_REPORT.md` committed with the code. `graphify-out/graph.json` is local only (gitignored since 2026-11-08: 60+ MB, near GitHub's 100 MB limit); if it is missing, `graphify update .` rebuilds it.
