---
name: jeo
description: "Spec-first pipeline: interview → seed → plan → critic gate → execute → honest verification"
thinking-level: high
---

Drive the request through the jeo spec-first pipeline: requirements are crystallized before planning, plans are critic-gated before execution, and completion claims are backed by artifacts. Real gates, no theater — a gate that did not pass is reported as not passed, never talked around.

Request: $@

## Phase 1 — Interview (ambiguity gate)

Crystallize the request into a seed before any planning:

1. Read the relevant code first so questions are grounded in the repo, not generic.
2. If the request is ambiguous, ask the user (via `ask`, batched — not one at a time) until you can state: **goal**, **constraints**, **out-of-scope**, and **acceptance criteria**. Acceptance criteria MUST be concrete and mechanically checkable (a command, a test, an observable behavior) — "works well" or "is clean" is not a criterion; push back and sharpen it instead of accepting it.
3. Freeze the seed: write `local://jeo-seed.md` with those four sections. The seed is immutable for the rest of the run — scope changes require a new interview round, never silent drift.
4. If the request is already concrete, write the seed directly and say so; do not manufacture interview rounds.

## Phase 2 — Plan

Spawn a `plan` agent with the seed (pass `local://jeo-seed.md` in the assignment). The plan MUST name concrete files, sequencing, and per-criterion verification steps.

## Phase 3 — Critic gate (blocking)

Spawn a `critic` agent with the seed and the plan. This gate is real:

- `okay` → proceed to Phase 4.
- `iterate` → feed `required_fixes` back into a revised plan, re-submit to a fresh `critic`. Maximum two iterations; if still not `okay`, stop and report the surviving gaps to the user instead of executing anyway.
- `reject` → stop. Report the disqualifying evidence and return to Phase 1 or ask the user.

You NEVER execute a plan whose latest critic verdict is not `okay`.

## Phase 4 — Execute

Decompose the approved plan into bounded tasks and delegate via `task` (parallel where files are independent, serial where they depend). Each assignment carries: its slice of the plan, the seed's constraints, and the acceptance criterion it serves. Each task is a bounded subgoal — verify one before starting the next; when a task fails, extract what the failure proved and feed that fact into the next attempt's assignment instead of retrying unchanged.

## Phase 5 — Verify (artifact gate)

- Run the repo's real checks once as a global signal (typecheck/tests/build as the repo defines them).
- Then walk the seed's acceptance criteria one by one: for each, cite the exact command or observation that proves it, and the changed files serving it.
- A criterion with no supporting artifact is NOT met — mark it `unresolved` with what is missing; never imply success.
- Optionally spawn `architect` on the final diff for a structural verdict when the change is substantial.

## Report

End with: seed summary, plan verdict history, per-criterion status (met + evidence / unresolved + reason), changed files, and open risks.
