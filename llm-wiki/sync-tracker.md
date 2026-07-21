# jeopi ⇄ oh-my-pi upstream sync tracker

Living document. Update the status table after every checkpoint (do not
rewrite history — append notes).

## Fork relationship (established 2026-07-21)

- `origin` = `https://github.com/akillness/jeopi.git`, active branch `jeopi`
  (branch `main` is an older, mostly-abandoned base — `jeopi` is 18 commits
  ahead of `main`, 0 behind).
- `upstream` = `https://github.com/can1357/oh-my-pi.git` (added as a git
  remote in this checkout).
- **`git merge upstream/main` is not viable.** `main...upstream/main` shows
  local `main` and upstream `main` share a common ancestor **14312 commits**
  behind upstream's current tip — the rename (`pi`/`omp` → `jeopi`,
  `can1357` → `akillness`) touches nearly every file, so a real merge would
  conflict almost everywhere. Sync must happen at the **content level**:
  read each upstream commit/checkpoint, re-apply the logic against jeopi's
  renamed tree, verify, commit.
- jeopi's own version numbers are **manually kept numerically aligned** with
  upstream release tags as a sync marker (jeopi's `v16.4.2` tag and
  upstream's `v16.4.2` tag point at different commits in different repos —
  same number, unrelated content). Last real sync point: **upstream
  `v16.4.2` = `7aa1d581c67ad9abb7f2a11b6621da2caf446d54`**, matching jeopi's
  current `package.json` version (`16.4.2`, commit `44cb072b`, tip of
  `jeopi` branch as of 2026-07-21).
- Upstream's latest tag as of 2026-07-21: **`v17.0.6` =
  `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6`**.
- Total gap: **1469 upstream commits** across 16 release checkpoints.

## Checkpoint matrix (upstream v16.4.2 → v17.0.6)

Commit counts are cumulative from the sync point (`7aa1d581`).

| # | tag | upstream commit | cumulative commits | delta | status |
|---|-----|-----------------|--------------------|-------|--------|
| 1 | v16.4.3 | 6328671d1 | 69 | +69 | in review |
| 2 | v16.4.4 | 29a6a6800 | 82 | +13 | pending |
| 3 | v16.4.5 | 3d1f9a4a3 | 132 | +50 | pending |
| 4 | v16.4.6 | 20c0a2e41 | 154 | +22 | pending |
| 5 | v16.4.7 | f933f02fc | 160 | +6 | pending |
| 6 | v16.4.8 | 01d3fc9b6 | 166 | +6 | pending |
| 7 | v16.5.0 | 3047c27c3 | 241 | +75 | pending |
| 8 | v16.5.1 | 14b5da76a | 431 | +190 | pending |
| 9 | v16.5.2 | 7d02778c6 | 538 | +107 | pending |
| 10 | v17.0.0 | d5cd24f39 | 599 | +61 | pending (major bump) |
| 11 | v17.0.1 | 6ae7cdbf9 | 756 | +157 | pending |
| 12 | v17.0.2 | 0f9fceeea | 1063 | +307 | pending |
| 13 | v17.0.3 | 48241afcc | 1154 | +91 | pending |
| 14 | v17.0.4 | 3fdd85ab6 | 1182 | +28 | pending |
| 15 | v17.0.5 | 9fd6e9711 | 1379 | +197 | pending |
| 16 | v17.0.6 | 89d6a8f6d | 1469 | +90 | pending |

Notable upstream-only additions visible in the full diff that jeopi does not
have yet (non-exhaustive, discovered from `git diff --stat` sync-point→v17.0.6):
new vendored coreutils crates (`uu-sed`, `uu-stat`, `uu-date`, `uu-touch`,
`uu-tr`, `uu-xargs`, `jaq`, …), `pi-shell` rewrite, harbor-manager →
metaharness migration, downshift/boomerang context-handoff flow, vibe mode
(persistent background agents), model hub redesign, advisor per-agent
toggle + quota UX, Cursor account usage reporting, `docs/tools/hub.md`
(new), removal of `docs/tools/{irc,job,resolve,search_tool_bm25,ssh}.md`
(tools folded/renamed upstream — needs check against jeopi's own tool set
before deleting anything).

## How each checkpoint gets ported

1. `git log --reverse <prev_tag>..<tag>` on the `upstream` remote for the
   commit list.
2. Skip pure `chore: bump version` / `chore: update changelogs` /
   `Merge remote-tracking branch 'origin/farm/...'` noise commits (farm
   branches are already squashed into the target commit upstream).
3. For each remaining commit, read the diff, map renamed identifiers
   (`pi` → `jeopi`, `omp` → `jeopi`/`jeo` per existing convention in
   `AGENTS.md`, `can1357` → `akillness`), and hand-apply into the
   corresponding jeopi file/package.
4. Run the narrowest relevant `bun test`/`bun check` for touched packages.
5. Commit with a message referencing the upstream commit(s) ported.
6. Update the status table row + append a dated note below.

## Checkpoint notes

### Checkpoint 1 — v16.4.3 (69 commits) — in review

69 commits, ~40 substantive (rest are merges/chores). Notable: vibe mode
(persistent background agents) lands in this window (`75bac085a`,
`1ab9c367e`, `b60cbb83b`, `acd893536`), `feat(coding-agent): removed plan
subagent` (`2f97b7fe4`, conflicts with jeopi's own `planner` role-agent
surface — needs explicit review before applying), reasoning/thinking title
stripping fixes, ACP provider error surfacing, natives glob traversal depth
cap.

Ported so far (small, self-contained fixes; large features below deferred
to a dedicated pass):

- [x] `cf4e510ac` fix(tool): bare `skill://` URLs resolve to directory for
  path-only ops — jeopi commit `8385f04e9`. Adapted to jeopi's `paths[]`
  array API (upstream had already unified to singular `path` by this
  point) and additionally threaded `pathOnly` through `grep.ts`'s
  `resolveInternalSearchInputs` context (upstream's own `grep.ts` didn't
  need the change at this point in its history — architecture diverged).
- [x] `a0a6949a4` fix(mcp): argv-first `Bun.spawn` overload for stdio TCC
  prompts — jeopi commit `922e5a05d`. Test adapted: jeopi doesn't carry
  upstream's darwin-stays-attached exception yet, so asserts jeopi's real
  `detached` semantics instead of upstream's platform-specific one.
- [x] `74c63fa6c` fix(agent): labeled system steering skips accurately —
  jeopi commit `ca1477dc2`. `hasSteeringMessages` may now return a
  `SteeringQueueState` in addition to a plain boolean; `agent.ts` inspects
  `#steeringQueue` entries for `role === "user" && attribution !== "agent"`
  to distinguish real user steering from advisor/system steering. Existing
  boolean-returning callers elsewhere in the codebase are unaffected.
- [x] `3188506e6` fix(ai): included OpenAI Responses `incomplete_details` —
  jeopi commit `4e55623a9`.
- [x] `31c9f4850` fix(ai): prevented empty image placeholders in tool
  outputs — jeopi commit `4e55623a9` (same commit as above, applied
  together).
- [x] `851186f5d` + `0420d44d3` + `65b0f0532` + `a16c60014` fix(coding-agent):
  strip leaked thinking envelopes from session titles — jeopi commit
  `e3cab053e`. Squashed into one port (each upstream commit revised the
  same function in sequence); adapted to jeopi's dual tool-choice/marker
  title path — only the marker-parsing branch of `extractGeneratedTitle`
  changed, the `set_title` tool-call branch (jeopi-specific, not present
  upstream at this point) is untouched.
- [x] `83fbefac2` fix(coding-agent): disabled context padding for raw
  file reads — jeopi commit `193286f05`. jeopi's in-memory/virtual-resource
  read path already funnels through the same fixed function
  (`#buildInMemoryTextResult`), so upstream's third edit site (a separate
  expansion block) wasn't needed here. No upstream test shipped with this
  fix — added `read-raw-range-no-padding.test.ts`.
- [x] `530faffd2` fix(coding-agent): clarified glob timeout status — jeopi
  commit `45981dd9b`. Added renderer regression tests (upstream shipped
  none).
- [x] `51cc34ac6` fix(agent): surfaced empty-stop retry failures
  unconditionally — jeopi commit `cab921422`. jeopi lacks upstream's
  `#clearPendingRecoveredRetryErrors` helper; kept jeopi's existing
  `#refusalBackoff` reset instead. Added a regression test for the
  previously-uncovered `#retryAttempt===0` path.
- [x] `54af1c03f` fix(coding-agent): ensured ACP provider errors are
  surfaced to clients — jeopi commit `9c6331bd1`. jeopi lacks upstream's
  `#flushMissedFinalAssistantText`; the new `#flushUnreportedTurnError`
  call was inserted standalone. Includes the `jeopi acp` stderr TTY hint.
- [x] `d993b13c8` fix(coding-agent): strengthened browser interaction
  reliability and error transparency — jeopi commit `a14120108`. Wire
  envelope keys renamed `__omp*` → `__jeopi*`. Added a unit test for the
  eval envelope encode/decode contract (upstream shipped none).
- [x] `159484ca6` fix(commit): created commits before agent teardown —
  jeopi commit `a97f5205f`. `runCommitAgentSession` gained an
  `onComplete(state)` callback invoked before `session.dispose()` in the
  `finally` block; `runAgenticCommit` restructured around it
  (`completeAgentCommitState` extracted). Missing changelog
  entries/split-plan mapping/proposal now throw instead of writing to
  stderr and returning cleanly. Dropped the forced
  `GPG_TTY="not a tty"` override in both `non-interactive-env.ts` and
  `git.ts` so GUI pinentry works again for signing-enabled repos.
- [ ] Remaining ~24 substantive commits in this checkpoint — not yet
  ported. Next candidate: `45143e8c7` (natives glob traversal depth cap —
  Rust, `crates/pi-natives`, needs a cargo build to verify).
- [ ] Large features flagged for dedicated review before porting: vibe
  mode (4 commits), plan-subagent removal (conflicts with jeopi's
  `planner` role-agent — needs a design decision, not a mechanical port),
  web search provider rewrite (10 new provider files), legacy-pi bundled
  registry rewrite (`legacy-pi-bundled-registry.ts` deleted upstream in
  favor of `legacy-pi-virtual-module.ts` — touches jeopi's own
  `legacy-pi-compat.ts` naming, needs careful review).

Status: **in progress**, 15/~69 upstream commits ported and verified
(`bun test` + full `bun check` clean after each; 12 jeopi commits, some
squashing multiple upstream commits that touched the same function in
sequence). Continuing commit-by-commit in following turns. At this rate
(~1469 total upstream commits across 16 release checkpoints), full
catch-up is a multi-session effort — this tracker is the source of truth
for exactly where the next turn should resume.