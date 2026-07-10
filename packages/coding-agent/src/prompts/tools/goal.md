Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal. Requires `objective`; optional `token_budget` must be positive. Use only when no goal exists and no goal is paused.
- `get` returns the current goal (active or paused) and remaining token budget.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence. Requires `evidence`: a specific, non-generic description of what you checked and how (tests run, output inspected, files diffed, etc.) — status words like "done" or "verified" are rejected. Completion is also evidence-gated at runtime: if this goal session modified project files, a verification run (test/build/typecheck/lint) must have succeeded AFTER the last modification, or the first `complete` is rejected with instructions. For docs/config-only work where no verification applies, call `complete` again and explain why in `evidence`.
- `drop` discards the current goal without completing it.

NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
