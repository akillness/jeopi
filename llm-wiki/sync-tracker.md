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
| 1 | v16.4.3 | 6328671d1 | 69 | +69 | triaged 69/69, ported 30 + 9 N/A/subsumed/coupled-skip, 11 deferred (large features) |
| 2 | v16.4.4 | 29a6a6800 | 82 | +13 | in progress: 3/10 ported |
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
- [x] `b35e4c413` fix(tui): honored move overlay width — jeopi commit
  `b310e3abe`.
- [x] `c1480b29e` fix(catalog): parsed version-first claude ids — jeopi
  commit `8af173a8f`. Test adjusted to assert jeopi's actual (broader,
  non-official-endpoint) custom-provider effort vocabulary rather than
  upstream's narrower expected shape — unrelated prior divergence in
  `compat/anthropic.ts`, not this commit's scope.
- [x] `e58d2c460` + `4bae9a42a` + `b0f22caf8` fix(providers): GitHub
  Copilot vision honored on non-personal endpoints — jeopi commit
  `aa6b34984`. Squashed (3-commit iteration on the same policy). Touches
  `packages/catalog` (model-manager merge, openai-compat discovery,
  wire/github-copilot) and `packages/coding-agent`
  (snapcompact-inline.ts).
- [x] `3f52e26a7` fix(ai): preserve CCA schemas with annotation
  conflicts — jeopi commit `329232f65`.
- [skip] `3b6c3409e` fix: paranoid auth storage schema handling —
  depends on `auth_credential_refresh_leases` table/credential-refresh
  leasing, a feature jeopi's `auth-storage.ts` doesn't have at all yet
  (no match for the table name anywhere in the file). Needs that base
  feature ported first; out of scope as a standalone fix.
- [x] `7d72ee9e0` + `dabb2291a` fix(advisor): preserved explicit empty
  tool lists — jeopi commit `6e139870a`. `filterAdvisorTools`,
  `loadWatchdogConfigFile`, `serializeWatchdogConfig`, `commitTools` (the
  tools-picker overlay), and `AgentSession`'s advisor tool resolution now
  distinguish `undefined` (default read/grep/glob) from an explicit `[]`
  (no tools).
- [x] `f53411295` + `449310eb1` fix(coding-agent): bound startup
  changelog to unseen releases — jeopi commit `aba69f857`. New
  `parseChangelogVersion`/`selectStartupChangelog`/`renderChangelogEntries`
  cap first-run/upgrade startup notes to 3 releases and 64 KiB instead of
  dumping the full packaged changelog on any missing/malformed marker;
  `/changelog` and the slash-command registry now share the same
  rendering helper.
- [x] `1c6f5dc18` feat(prompts): sharpened eager-task delegation guidance
  — jeopi commit `d075dbe79`, **`eager-task.md` portion only**.
  `system-prompt.md`'s delegation section has diverged structurally from
  upstream's (different paragraph organization) — flagged for separate
  manual review rather than force-fitted.
- [skip] `3b6c3409e` fix: paranoid auth storage schema handling —
  depends on `auth_credential_refresh_leases` table/credential-refresh
  leasing, a feature jeopi's `auth-storage.ts` doesn't have at all yet
  (no match for the table name anywhere in the file). Needs that base
  feature ported first; out of scope as a standalone fix.
- [x] `295655255` test(coding-agent): validated behavioral consistency —
  subsumed by tests already added while porting `d993b13c8` (browser eval
  envelope), `530faffd2` (glob timeout), and `83fbefac2` (raw range) —
  same contracts, different exact assertions/test names.
- [x] `376084c19` feat(coding-agent/web): ensured auth storage cleanup —
  jeopi commit `8c07425e8`. `runSearchQuery` throws when no auth storage
  is available and closes any storage it opened itself in a `finally`.
- [x] `b0d98d9e2` fix(coding-agent): decoupled LSP diagnostics from tool
  execution — jeopi commit `6e576a4a5`. New shared
  `lsp/deferred-diagnostics.ts` `DeferredDiagnostics` class (extracted
  from `EditTool`); `WriteTool` now wired into the same deferred late-
  diagnostics channel instead of blocking on the inline poll.
- [x] `5a4a6670b` feat(pi-walker): ignored parent rules that cover
  explicitly rooted walks — jeopi commit `b029cd92b`, Rust
  (`crates/pi-walker`). Adapted to jeopi's simpler ancestor-walk
  structure (no repo-scoped boundary); test adapted to jeopi's
  `collect_entries` convention. Verified with `cargo test -p pi-walker`
  (24 pass) + `cargo fmt` + full `bun run check:rs`.
- [skip] `980d24e24` fix(patches): resolved puppeteer locator timeouts —
  patches `puppeteer-core@25.3.0.patch`; jeopi pins `puppeteer-core@25.1.0`
  (`patches/puppeteer-core@25.1.0.patch`, a different upstream npm
  version with different source line numbers/hunks). Not a mechanical
  port — needs the equivalent fix re-derived against jeopi's actual
  pinned puppeteer-core version.
- [skip] `3b6c3409e` fix: paranoid auth storage schema handling —
  depends on `auth_credential_refresh_leases` table/credential-refresh
  leasing, a feature jeopi's `auth-storage.ts` doesn't have at all yet
  (no match for the table name anywhere in the file). Needs that base
  feature ported first; out of scope as a standalone fix.
- [x] `45143e8c7` feat(natives): restricted glob traversal depth — jeopi
  commit `a0c6429fb`, Rust (`crates/pi-natives`). Direct 1:1 port —
  jeopi's `glob.rs`/`glob_util.rs` matched upstream's pre-change
  structure exactly. Verified with `cargo test -p pi-natives` (21/21
  pass) + `cargo fmt` + full `bun run check:rs`.
- [x] **N/A** `d179968bb` build: migrated bundling from CLI to Bun.build
  API — the bug this fixes (E2BIG from a giant `PI_DOCS_EMBED` payload
  passed as a `bun build --define` CLI arg) doesn't exist in jeopi:
  jeopi's `bundle-dist.ts` already embeds the docs index via a generated
  on-disk file (`src/internal-urls/docs-index.generated.txt`, imported
  normally) instead of a `--define`-injected payload — a different,
  already-safe architecture. Confirmed by reading jeopi's
  `assertDocsEmbedPopulated()`/`main()`.
- [x] **N/A** `82645c5a6`, `f7930048d`, `529effac1`, `056fc5f69` — pure
  upstream bookkeeping (changelog note, upstream's own version bump,
  upstream's `.github/VOUCHED.td` contributor list, changelog
  finalization). Not applicable to a fork with its own versioning/vouch
  list/changelog cadence.
- [x] **subsumed** `d469064d1` fix: handle stale tests — the only
  independently-portable fragment (hardening `delayedBody()`'s
  enqueue/close against a cancelled stream in
  `packages/ai/test/pi-native-client.test.ts`) is already present in
  jeopi in equivalent (actually stricter) form — `closed` guard flag +
  try/catch on `enqueue`, `cancel()` sets `closed = true`. The rest of
  the commit (deleted `web-search-*.test.ts` files, `robomp` test tweak,
  `legacy-pi-virtual-module`/Bun.build-migration references) is coupled
  to the deferred web-search-rewrite and Bun.build-migration commits and
  moves with them.
- [skip] `c893e7ab7` hack: backtrack changelog — its only code change
  (`auth-storage-block-persistence.test.ts` v5→v6 migration test) is a
  regression test for the credential-refresh-lease backfill, coupled to
  the already-skipped `3b6c3409e`. Moves with it.
- [ ] **Deferred — needs dedicated review, not mechanical**:
  - Vibe mode (persistent background agents): `75bac085a`, `1ab9c367e`,
    `b60cbb83b`, `514a8ca6c`, `acd893536`, `aa2c580b2`, `46fd8c557` (7
    commits, ~2500 lines, new subsystem).
  - `2f97b7fe4` feat: removed plan subagent — **conflicts with jeopi's
    own `planner` role-agent**; this is an architecture decision (keep
    jeopi's role-agent vs. adopt upstream's removal), not a mechanical
    port. Needs explicit user direction before touching.
  - Web search rewrite: `ea632a518`, `4c167eaa6`, `376084c19` (last one
    already ported standalone above) — 10 new provider files, couples to
    the `d469064d1` deleted test files above.
  - `ce10e5fff` feat: pcre2 + advanced grep, `8755c3879` feat(pi-uu-grep):
    advanced regex/filtering — large paired Rust+TS grep rewrite (2100+
    lines combined).
  - [x] Browser tool standardization pair (ported together — `9ebc23928`
    directly builds on `a9cdaf427`'s handle/op shape): jeopi commit
    `2dc5312fd`. New `run-output.ts` (`RunOutput`/`cloneSafe`/
    `safeJsonStringify`, deduped from 3 copies), `ActionableHandle`/
    `toActionableHandle`/`fillViaHandle`, `#selectorTimeoutHint`
    match-count diagnosis, `#zeroMatchWatchdog` (2s zero-match fail-fast
    raced via `Promise.race`/`AbortController`), `ACTION_OP_TIMEOUT_MS`
    15s→8s, `CmuxElementHandle.press()`. Adapted: jeopi has no
    `markHandled` wrapper in `run-cancellation.ts` (ported without it)
    and no `postmortem` module in `cmux-tab.ts` (kept plain
    `ToolAbortError`). Verified: full `bun run check:ts` clean +
    targeted `bun test .../tools/browser` (56/56 pass).
  - `33c161d9d` refactor: plugin system + build logic restructure (761
    insertions / 5332 deletions — largest single diff in the checkpoint).
- [ ] **Partial**: `system-prompt.md` delegation-section refinement from
  `1c6f5dc18` — needs manual semantic port into jeopi's restructured
  section (search for "NEVER abandon phases under scope pressure" /
  "Use `{{toolRefs.task}}` to map unknown code" in `system-prompt.md` to
  locate jeopi's equivalent).

Checkpoint 1 triage is now **complete** — every one of the ~69 commits
between `7aa1d581` and `6328671d1` has been individually inspected and
falls into: ported (30), subsumed/already-equivalent (2), N/A to a fork
(5), skipped as coupled to an N/A/skipped commit (2), or deferred pending
a dedicated large-feature session (vibe mode, plan-subagent removal,
web search rewrite, pcre2/grep rewrite, plugin restructure — ~11
commits, all flagged above with the concrete reason). No further "quick
win" commits remain in checkpoint 1 — every item left requires either a
multi-file feature port or a user architecture decision (plan-subagent
removal).

Status: **in progress**, 30/~69 upstream commits ported (1 partially —
`eager-task.md` done, `system-prompt.md` deferred), 2 subsumed, 5 N/A,
2 skipped-as-coupled, and 11 deferred pending dedicated review — all
verified/triaged (`bun test`/`cargo test` + full `bun check`/`check:rs`
clean after each port; 24 jeopi commits, some squashing multiple
upstream commits touching the same function). Checkpoint 1's mechanical
work is exhausted; remaining deferred items are all genuinely large
(vibe mode ~2500 lines/7 commits, web search rewrite 10 new provider
files, pcre2/grep rewrite ~2100 lines combined Rust+TS, plugin
restructure 761+/5332- lines) or blocked on a user architecture decision
(plan-subagent removal conflicts with jeopi's `planner` role-agent). The
next unit of progress is either (a) tackle one deferred large feature
end-to-end (pcre2/grep rewrite `ce10e5fff`+`8755c3879` is the next
smallest self-contained candidate), or (b) move on to checkpoint 2
(v16.4.4, only 13 commits) and circle back to checkpoint 1's deferred
list later. At this rate (~1469 total upstream commits across 16
checkpoints), full catch-up is a multi-session effort — this tracker is
the source of truth for exactly where the next turn should resume.

### Checkpoint 2 — v16.4.4 (10 substantive commits) — in progress

10 commits between `6328671d1` and `29a6a6800`. Notable: small-model
preprocessing centralization (`93635e7b6`, large — new `message-preproc.ts`
module), Windows Bun.build-compiled binary CLI dispatch fix (`3d2568060`,
likely coupled to the checkpoint-1-deferred Bun.build migration), native
install artifact portability (`bc7a143c1`), test null-safety hardening
(`337feb297`).

- [x] `cbe083224` docs(coding-agent): corrected context promotion docs —
  text-only, no jeopi commit hash needed for code (see combined commit
  below). Cross-checked against actual runtime
  (`AgentSession#resolveContextPromotionTarget` only resolves the explicit
  `contextPromotionTarget`, no same-provider fallback) and
  `settings-schema.ts` (`contextPromotion.enabled` default already
  `false`) before editing — confirmed the docs were genuinely stale, not
  a hypothetical.
- [x] `3272b6574` feat(pi-natives): prioritized shallow paths for fuzzy
  search ties — Rust (`crates/pi-natives/src/fd.rs`), `path_depth()` tie
  -break in `fuzzy_find_sync`'s sort. Direct 1:1 port; regression test's
  hidden-dir fixture renamed `.omp/...` → `.jeopi/...`. Both commits above
  landed together as jeopi commit `935a34034`. Verified: `cargo test -p
  pi-natives` (148/148 pass) + `cargo fmt` + full `bun run check:rs`.
- [x] `748b2dff1` fix(tools): allowed opaque codex image keys — jeopi
  commit `7087f7272`. `buildOpenAIImageHeaders()` no longer throws when
  `getCodexAccountId()` finds no account id in the bearer token (proxy/
  opaque keys); omits `chatgpt-account-id` instead of failing the
  request. Direct 1:1 port. Verified: `bun test
  .../test/tools/image-gen.test.ts` (6/6 pass, incl. 2 new tests) + tsgo
  + biome.
- [ ] `93635e7b6` feat(coding-agent): centralized preprocessing/guidance
  for small models — 687+/128- lines across `tiny/message-preproc.ts`
  (new, 133 lines), `tiny/text.ts` (heavily refactored), `tiny/worker.ts`,
  `title-generator.ts`. Not yet reviewed for jeopi's `tiny/` divergence.
- [ ] `29a6a6800` fix(coding-agent): preserved chat envelope in title
  preprocessing — builds on `93635e7b6`'s new `message-preproc.ts`; port
  together with it.
- [ ] `bc7a143c1` fix(setup): used portable native install artifacts — not
  yet reviewed.
- [ ] `337feb297` test: improved test null safety and type assertions —
  touches 7 test files across `packages/ai` and `packages/coding-agent`;
  not yet reviewed for applicability (may be upstream-specific flake
  fixes).
- [ ] `3d2568060` fix(coding-agent): dispatched CLI entry in
  Bun.build-compiled Windows binaries — likely coupled to the
  checkpoint-1-deferred Bun.build bundling migration (jeopi still uses
  the CLI-invoked `bun build` in `bundle-dist.ts`, not `Bun.build()` API,
  per the `d179968bb` N/A finding); needs verification before deciding
  applicable/coupled.
- [ ] `cf1b3fc3f`, `6bc4302f6` — chore version bump / changelog update,
  expected N/A (upstream-only bookkeeping, same pattern as checkpoint 1's
  `f7930048d`/`056fc5f69`).

Status: **in progress**, 3/10 substantive commits ported (2 jeopi
commits: `935a34034`, `7087f7272`), 7 remaining (1 large feature not yet
reviewed, 1 likely-coupled Windows/Bun.build fix, 1 test-hardening batch
not yet reviewed, 2 expected-N/A chores, 1 depends on the not-yet
reviewed `93635e7b6`).