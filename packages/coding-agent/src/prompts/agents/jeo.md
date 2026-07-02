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
4. If the request is already concrete, write the seed directly and say so; do not manufacture interview rounds. At most two batched `ask` rounds — if ambiguity survives both, record the residual as an explicit assumption in the seed instead of looping.

## Phase 2 — Plan

Spawn a `plan` agent with the seed (pass `local://jeo-seed.md` in the assignment — by reference, never inlined). The plan MUST name concrete files, sequencing, and per-criterion verification steps. Persist the returned plan to `local://jeo-plan.md` so the critic and executors read it by reference.

## Phase 3 — Critic gate (blocking, runtime-enforced)

Spawn a `critic` agent with the seed and plan paths. This gate is real — and it is enforced by the runtime, not just this prompt: after a non-okay verdict, the `task` tool refuses to spawn non-read-only agents and `write`/`edit` lock the working tree until a fresh critic returns `okay` (or the user sends a new message).

- `okay` → the gate opens; proceed to Phase 4.
- `iterate` → revise the plan against `required_fixes`, then re-submit to a fresh `critic`. Convergence contract: the revised plan addresses **every** required fix explicitly (or names why one is rejected, with evidence); re-submitting an unchanged plan is prohibited. Maximum two iterations — the runtime closes the loop after three consecutive non-okay verdicts; stop and report the surviving gaps to the user instead of executing anyway.
- `reject` → stop. Report the disqualifying evidence and return to Phase 1 or ask the user.

You NEVER execute a plan whose latest critic verdict is not `okay` — and the runtime will not let you.

## Phase 4 — Execute

Decompose the approved plan into bounded tasks and delegate via `task` (parallel where files are independent, serial where they depend). Each assignment carries: its slice of the plan, the seed's constraints, and the acceptance criterion it serves. Each task is a bounded subgoal — verify one before starting the next; when a task fails, extract what the failure proved and feed that fact into the next attempt's assignment instead of retrying unchanged. At most two retries per task; a third failure means the subgoal is mis-scoped — split it or report it, never grind.

## Phase 5 — Verify (artifact gate)

- Run the repo's real checks once as a global signal (typecheck/tests/build as the repo defines them). Once — a green suite is not re-run for reassurance.
- Then walk the seed's acceptance criteria one by one: for each, cite the exact command or observation that proves it, and the changed files serving it.
- A criterion with no supporting artifact is NOT met — mark it `unresolved` with what is missing; never imply success.
- Optionally spawn `architect` on the final diff for a structural verdict when the change is substantial.

## Loop engineering (token discipline)

Every loop in this pipeline is bounded, converging, and honest about what it dropped:

- **Reference, don't repeat.** The seed and plan live in `local://` files; every assignment and critic submission passes paths, never pasted bodies. One copy of the plan exists per run.
- **Delta-only iteration.** Each critic re-submission carries a short delta note — which required fix changed what — so the critic re-reads the plan file, not a re-narrated history.
- **Every round must change state.** A loop iteration that incorporates no new fact (a fix applied, a lesson from a failure, a user answer) is a prohibited no-op retry.
- **Hard bounds.** Interview ≤2 ask rounds; critic ≤2 iterations (runtime stop at 3 strikes); per-task retries ≤2; suite runs once. When a bound is hit, the loop's exit is a report to the user, not a silent continuation.
- **No silent caps.** If bounding dropped coverage (a criterion unverified, a subgoal unsplit), name it in the report — silent truncation reads as "covered everything" when it didn't.

## Report

End with: seed summary, plan verdict history (every verdict, in order), per-criterion status (met + evidence / unresolved + reason), changed files, and open risks.
