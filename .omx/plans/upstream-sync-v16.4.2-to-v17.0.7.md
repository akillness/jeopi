# Upstream synchronization: v16.4.2 → v17.0.7

## Requirements summary

- Content-port all applicable oh-my-pi changes after the maintained jeopi baseline, preserving jeopi naming and deliberate fork divergences rather than attempting a merge.
- Treat the requested `v16.0.0` boundary as already subsumed by jeopi's version-aligned baseline: every workspace package is currently `16.4.2` (`package.json:28-39`), and the tracker identifies upstream `v16.4.2` (`7aa1d581`) as the last real content-sync point (`llm-wiki/sync-tracker.md:20-29`).
- Extend the durable `llm-wiki/sync-tracker.md` ledger for every upstream change with its source SHA, classification, jeopi adaptation/SHA, tests, and explicit dependency/defer decision. Preserve the document's append-only checkpoint-note rule (`llm-wiki/sync-tracker.md:1-4`).
- Do not disturb the existing uncommitted work in the current checkout; it spans source, tests, and docs across Rust and TypeScript. Never reset, stash, or overwrite it.

## Current evidence and scope

- This is a content-level port, not a merge: the fork rename makes `git merge upstream/main` unsafe (`llm-wiki/sync-tracker.md:13-19`).
- The existing matrix has checkpointed the 1,469-commit range from `v16.4.2` through `v17.0.6`, with checkpoint 8 (`v16.5.1`) currently at 45/190 ported and later checkpoints unstarted (`llm-wiki/sync-tracker.md:31-52`, `:855-951`).
- Upstream released `v17.0.7` (`7b141199`) after that matrix was last refreshed. Its substantive catalog fix preserves opaque gateway IDs beginning with `@`; the release comparison reports three commits, one substantive fix plus release hygiene.
- The current root still pins `puppeteer-core@25.1.0` and ACP SDK `0.25.0` (`package.json:7-9`, `:17`, `:77`), while deferred upstream work relies on later versions; dependency changes must be evaluated as compatibility bundles, not lockfile copies (`llm-wiki/sync-tracker.md:837-843`).
- Existing deferred work includes coupled bundles (quota routing, organization identity, Codex Responses Lite, browser patch rebase, session compaction, model hub, coreutils, hashline recovery, and removed/experimental features) (`llm-wiki/sync-tracker.md:829-844`, `:925-941`). These are in scope under “all updates,” but each needs a coherent feature migration and an explicit ledger decision.

## Acceptance criteria

1. The ledger's checkpoint matrix includes `v17.0.7`, identifies the exact upstream tag SHA and cumulative delta, and every non-noise upstream commit from `v16.4.2` through the selected upstream tip has one auditable disposition: ported, intentionally retained divergence, superseded, or deferred with dependency and resume condition.
2. Each ported behavior has a source SHA, jeopi implementation reference, changelog entry under affected package's `Unreleased` section when user-visible, and focused contract-level regression coverage or a recorded reason existing coverage is sufficient.
3. No port overwrites or reverts pre-existing dirty work. Any overlap is isolated and reported as a concrete conflict rather than silently folded in.
4. The complete sync covers all applicable upstream behavior through `v17.0.7`; version alignment, release metadata, generated artifacts, and dependency bumps occur only when their source/compatibility requirements are satisfied.
5. Every implementation batch passes its focused test suites and package `bun check`; cross-package/runtimes changes additionally pass the relevant CI target (such as `ci:test:smoke`, `check:rs`, or `test:py`). The final integration passes `bun run check` and `bun run ci:test:full` unless an environment-specific blocker is documented with the actual command output.

## Implementation plan

### 1. Establish an isolated, reproducible sync workspace

- Fetch upstream tags/`main` at execution time and record the observed tip/tag SHAs before calculating ranges; do not assume the currently cached remote is current.
- Create a separate linked worktree from the active `jeopi` HEAD for synchronization, leaving this dirty checkout untouched. Copy no uncommitted changes into it; use it only for upstream-port commits/patches.
- Add an `llm-wiki` “run header” recording baseline, target tag, observed remote tip, date, command/range, and the current worktree isolation decision. Update the matrix from `v17.0.6` to `v17.0.7` before triage starts.
- Retain the tracker’s commit-level workflow—reverse-order log, skip only evidenced release/merge noise, diff/read/map/verify/record—but replace its “commit” step with an explicit user-approved commit policy because repository rules prohibit automatic commits (`llm-wiki/sync-tracker.md:65-78`).

### 2. Finish the active v16.5.1 checkpoint first

- Resume at `9831386de` and process remaining commits in chronological order, pairing external-PR merge commits with their preceding substantive change as documented (`llm-wiki/sync-tracker.md:855-868`, `:950-951`).
- For isolated fixes, inspect upstream diff and current jeopi equivalent, port only behavior that is not already present, add/adjust behavioral tests, run focused suites, and append the source SHA → local change/test disposition.
- For coupled changes, group source commits into bounded feature migrations and finish all prerequisites, consumers, schema/migration, docs, and regression suites together. Do not turn existing deferred entries into untracked “skips.”
- Prioritize safety/data-loss and externally observable correctness fixes before UX/restructure parity: auth/retry/account routing, hashline recovery, browser execution safety, provider/model request correctness, then TUI/transcript/tooling changes.

### 3. Migrate deferred feature bundles to completion

- **Authentication/account routing:** port quota rotation, gateway/Z.AI quota probes, and organization-scoped Anthropic identity as ordered migrations. Validate credential persistence/migration, identity dedupe, sticky-session selection, retry chain behavior, usage rendering, and fallback error paths.
- **Catalog/model transport:** port Codex Responses Lite metadata/policies and opaque gateway model-ID handling from `v17.0.7`; use catalog resolvers/policies and regenerate `packages/catalog/src/models.json` only via `bun run gen:models`, per repository rules.
- **Browser/runtime:** rebase the active Puppeteer stealth patch against the actually installed package version, port browser safety controls and locator fixes as one real-browser/CDP-tested bundle. Never edit inactive patch text as proof of a fix.
- **Session/TUI/workflow:** port session compaction with snapcompact/recovery/config as a coherent state migration; separately evaluate and port model hub, launch/vibe/downshift/boomerang, transcript/tool-arg recovery, and role-prefix changes against jeopi’s current product surfaces. Preserve intentional fork-specific role-agent behavior unless a replacement is explicitly integrated.
- **Native/build/tooling:** evaluate vendored coreutils, pi-shell rewrite, docs generation/bundling migration, hashline recovery rewrite, and dependency/ACP SDK upgrades as full package-level migrations with their upstream tests translated to behavioral contracts.
- For upstream removals or experimental/WIP features, compare runtime reachability and public API. Record either a validated removal/replacement or an intentional jeopi divergence; “not ported” without a reason is not a final state.

### 4. Advance remaining release checkpoints

- Process checkpoints `v16.5.2`, `v17.0.0` through `v17.0.7` in tag order, creating a ledger section before each range and closing it only when every commit is accounted for.
- Recalculate checkpoint counts after fetching to avoid stale totals, and treat `v17.0.7` release hygiene separately from substantive `5b798685` catalog behavior.
- Keep version numbers aligned only after all behavioral content for that release boundary is complete; use the repository release flow rather than editing released changelog sections.

### 5. Verify, document, and hand off

- For each batch, run the narrow package tests plus package type/format checks; update directly affected package changelogs under `Unreleased`.
- Run integration commands based on touched surfaces: `bun run ci:test:smoke` for worker/binary paths, `bun run check:rs`/targeted Cargo tests for native changes, `bun run test:py` for Python changes, and relevant coding-agent UI/runtime CI groups for cross-package TUI/agent changes (`package.json:114-117`, `:136-160`).
- Before closing each checkpoint, re-read the tracker row and append a dated summary containing completed count, outstanding bundle IDs, verification results, and the exact resume SHA. Before declaring the overall sync complete, reconcile the matrix totals and run final repository-wide checks.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dirty user work is clobbered by a port. | Use a linked sync worktree; stop at overlap and report the exact files/hunks. |
| Fork-wide rename causes false mechanical matches. | Port behavior from upstream diffs into current jeopi abstractions; forbid cherry-picks/merges and validate behavior. |
| Large coupled migrations leave half-installed schemas or retry paths. | Use explicit bundle boundaries with ordered prerequisites and integration tests before moving on. |
| Dependency/patch upgrades look complete but are inactive. | Verify resolved lock version, patch activation, and real runtime/CDP behavior—not source text. |
| Ledger drift masks missing commits. | Track every SHA exactly once with a machine-checkable range audit at checkpoint close. |
| Full suite is impractical for every incremental change. | Use focused contracts per batch; reserve full CI for checkpoint and final gates, recording real blockers. |

## Execution order

1. Isolate worktree and refresh upstream evidence.
2. Complete v16.5.1, including its deferred bundles.
3. Complete v16.5.2 and v17.0.0 through v17.0.6 in order.
4. Apply and verify v17.0.7’s opaque gateway-ID fix.
5. Reconcile version/release artifacts, ledger, changelogs, and final verification.
