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
| 2 | v16.4.4 | 29a6a6800 | 82 | +13 | triaged 10/10, ported 5 + 3 N/A, 2 deferred (large feature) |
| 3 | v16.4.5 | 3d1f9a4a3 | 132 | +50 | reviewed 41/41, ported 3 + 4 N/A/subsumed, 34 deferred to dedicated large-feature sessions (model hub, ask dialog, vendored coreutils, agent suspension, task restructure, TUI loader, bash fixup removal, tool-arg recovery) |
| 4 | v16.4.6 | 20c0a2e41 | 154 | +22 | triaged 21/21, ported 3 + 3 N/A, 15 deferred (model perf tracking, Model Hub, sequential queueing, retry-fallback divergence, cache invalidation) |
| 5 | v16.4.7 | f933f02fc | 160 | +6 | triaged 6/6, ported 4 + 2 N/A |
| 6 | v16.4.8 | 01d3fc9b6 | 166 | +6 | triaged 6/6, ported 4 + 2 N/A |
| 7 | v16.5.0 | 3047c27c3 | 241 | +75 | triaged 75/75, ported 19 + 1 N/A, 55 deferred to dedicated large-feature sessions (harbor-manager/metaharness new package, downshift/boomerang workflow, launch tool, session-compaction/snapcompact bucket, vendored-coreutils continuation, hashline drift-recovery rewrite, browser safety controls, Model Hub, ACP SDK major bump, misc large/experimental) |
| 8 | v16.5.1 | 14b5da76a | 431 | +190 | in progress: 17/190 ported (largest checkpoint yet — first checkpoint with many small external-contributor PR fixes rather than large features; each real change is a paired `fix(...)` + redundant `Merge PR #NNNN` commit, only the `fix(...)` carries a unique diff) |
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

### Checkpoint 2 — v16.4.4 (10 substantive commits) — triaged, tail deferred

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
- [ ] **Deferred — large feature, dedicated review**: `93635e7b6` feat:
  centralized preprocessing/guidance for small models + `29a6a6800` fix
  (builds on it) — 687+/128- lines across 15 files: new
  `tiny/message-preproc.ts` (133 lines, centralizes noise-stripping/
  truncation currently duplicated across `tiny/text.ts`/`worker.ts`/
  `title-generator.ts`), a new 332-line `scripts/bench-title-models.ts`
  benchmark harness, `auto-thinking/classifier.ts`,
  `prompts/system/{tiny-title-system,title-system}.md`,
  `session/agent-session.ts`, `.omp/skills/system-prompts/small-models.md`
  (upstream repo-dev skill doc, needs `jeopi`-renaming if ported), and 3
  test files. Comparable in scope to checkpoint 1's deferred web-search/
  pcre2-grep rewrites — same bucket, same reason (needs a dedicated
  session to diff jeopi's actual `tiny/` module against upstream's
  refactor before extracting the centralized module cleanly).
- [x] `bc7a143c1` fix(setup): used portable native install artifacts —
  jeopi commit `f98711401`. Windows release binary now compiles with
  `bun-windows-x64-baseline` (not the AVX2-only `-modern` target,
  `scripts/ci-release-build-binaries.ts`); native addon builds force
  `PCRE2_SYS_STATIC=1` (`packages/natives/scripts/build-native.ts` +
  `scripts/ci-build-native.ts`, new `withPortableNativeBuildEnv()`).
  Adapted: upstream's `build-binary.ts` `resolveCrossBuild()` extraction
  + unit test NOT ported — jeopi's `build-binary.ts` has a structurally
  different string-interpolation `CROSS_TARGET` resolver (no function to
  extract) from an earlier independent divergence; the actual
  release-build target (`ci-release-build-binaries.ts`, what `bun run
  release`/CI invoke) matched upstream's structure and was ported
  directly. Verified: `bun test` on all 5 `scripts/*.test.ts` (23/23
  pass) + full `bun run check:ts` (incl. `bun run gen:docs` regen for
  the `cbe083224` docs edit) + `bun run check:rs`, both clean.
- [x] `337feb297` test: improved test null safety and type assertions —
  jeopi commit `b85cfd000`. Applied to 7 of 9 upstream-touched files
  (adapted individually to jeopi's actual per-file state, not blindly
  copied): `openai-responses-stateful.test.ts`,
  `pre-response-timeout.test.ts`, `openai-responses-history-payload.test.ts`,
  `sdk-custom-tools-per-session-binding.test.ts` (both `it()` blocks),
  `session-messages.test.ts`, `irc.test.ts`, `perplexity.test.ts`. Two
  files already carried an equivalent independent fix (`anthropic-alignment.test.ts`,
  `stream-auth-retry.test.ts` — subsumed); two upstream targets don't
  exist in jeopi at all (`openai-codex-responses-lite.test.ts`'s
  `additional_tools` test, `browser-cmux-release-mid-run.test.ts` file
  itself — both coupled to not-yet-ported features, out of scope).
  Verified: `bun test` on all 7 touched files (109/109 pass) + tsgo +
  biome.
- [x] **N/A** `3d2568060` fix(coding-agent): dispatched CLI entry in
  Bun.build-compiled Windows binaries — the bug is specific to the
  `Bun.build()` **JS API**'s standalone loader (backslash/forward-slash
  path-separator mismatch in `import.meta.main` detection on Windows);
  upstream's own commit message says "`bun build --compile` CLI builds
  are unaffected." Confirmed jeopi's entire binary-compile pipeline
  (`packages/coding-agent/scripts/build-binary.ts` AND
  `scripts/ci-release-build-binaries.ts`, the actual release path) still
  spawns CLI-invoked `bun build --compile ...` via `Bun.spawn`, not the
  `Bun.build()` API — consistent with the `d179968bb` N/A finding in
  checkpoint 1 (jeopi never did that migration for the binary-compile
  path either). Bug does not exist in jeopi's architecture.
- [x] **N/A** `cf1b3fc3f`, `6bc4302f6` — confirmed pure upstream
  bookkeeping (own version bump across every package.json/Cargo.toml/
  lockfile, own changelog finalization). Not applicable to a fork with
  its own versioning/changelog cadence.

Status: **triaged 10/10** — 5/10 substantive commits ported (4 jeopi
commits: `935a34034`, `7087f7272`, `f98711401`, `b85cfd000`), 3 N/A
(confirmed against actual jeopi code/architecture, not assumed), 2
deferred as a large feature (small-model preprocessing centralization,
same bucket/reason as checkpoint 1's deferred items). Checkpoint 2's
mechanical work is complete — everything left needs a dedicated
large-feature session, same as checkpoint 1's tail.

### Checkpoint 3 — v16.4.5 (~41 substantive commits) — reviewed, tail deferred

41 commits between `29a6a6800` and `3d1f9a4a3` (chores/merges excluded).
Denser with large new features than checkpoints 1–2 — several multi-commit
subsystems land in this window:
- **Model hub** (`59d08172c` introduces it + `5d3d1230f`, `2081bae6a`,
  `ab7b776f9`, `c6b83c1d9` follow-ups): unified model management/search UI.
- **`ask` rich interactive dialog** (`38a5c8a89` introduces it +
  `69c02c802`, `48b2a742c`, `1d14e262b`, `f66e52767` fixes): new dialog
  subsystem.
- **Vendored coreutils** (`991c166d8`, `5a73d65b7`, `8a510052a`, `d1317c303`
  "allocation-free grep"): in-process coreutils execution for the shell
  tool. **Note**: jeopi's `crates/` already contains `pi-uu-grep`,
  `crates/vendor/uu-{wc,mv,sort,cat,head,tail,ls,find,rm,mkdir,uniq}` and
  compiles/links them (discovered while running `bun run check:rs` for
  the grep mmap port below) — this suggests jeopi already has some form
  of vendored coreutils, independent of or ahead of this upstream
  commit. Needs a diff-level comparison before assuming this checkpoint's
  vendoring commits are needed at all — may be partially/fully subsumed.
- **Agent suspension / pause** (`9a868d2e7` introduces `pause` command +
  UI, `369a0d879` follow-up): new interruption mechanism.
- **Resumable subagent yielding** (`33b6774aa`): task subsystem change.
- **Flat task structure** (`cb2153e9a` "agent-centric flat task
  structure"): likely a task/job subsystem rewrite, may be a prerequisite
  or successor to `408a92d91` (background task execution) and
  `5b20a7dea` (tool-call persistence during rebuilds) — needs sequencing
  review.
- **Bulk conflict resolution** (`7a0ae7031`, `conflict://*` URLs) +
  follow-up (`7e5e7e864`, echo-line auto-trim in `conflict-detect.ts`).

Smaller/more isolated candidates spotted but not yet reviewed:
`c22d5dffb`/`62172339b`/`276092eac` (TUI loader/anchored-container
sequence, ~3 commits building on each other), `d7a71642c` (browser
header generation guard, self-contained with tests), `459682cc6` (custom
tool loader — skip invalid entries), `172691f6e` (−569 lines, removed
redundant bash command fixup — worth checking what replaced it),
`0b9bdaaed` (malformed tool-argument auto-recovery, `packages/ai`).

Ported so far:
- [x] `b87cfc7e1` + `f359a5f29` fix(native): replaced mmap-backed grep
  reads with bounded owned buffers (SIGBUS/mutation-under-rewrite safety
  fix) — jeopi commit `ab1f3a18c`, Rust (`crates/pi-natives/src/grep.rs`).
  Direct 1:1 port, removed the `memmap2` dependency entirely (only
  `pi-natives` used it directly; `grep-searcher`'s own transitive
  `memmap2` dep is unaffected). Verified: `cargo test -p pi-natives grep`
  (28/28 pass) + `cargo build` clean (no mmap warnings) + `cargo fmt` +
  full `bun run check:rs`.
- [x] `459682cc6` fix(plugins): skipped invalid custom tool entries —
  jeopi commit `782f145c8`. `loadTool()` now returns `{ tools, errors }`
  (both arrays) and validates each factory-array entry via
  `isLoadableCustomTool()` before accepting it, so one malformed entry
  (`null`, missing `name`/`description`/`parameters`/`execute`) is
  reported per-index and skipped instead of crashing the whole load.
  Adapted: ported without upstream's `withExitGuard()` wrapper (jeopi's
  `loadTool()` calls the factory directly, no `withExitGuard` in this
  file — an earlier independent divergence). New
  `test/extensibility/custom-tool-loader.test.ts` (file didn't exist in
  jeopi; ported the 3 new validation regression tests, not upstream's
  pre-existing `withExitGuard`/process.exit tests since jeopi lacks that
  feature). **Bonus finding**: the new validation surfaced a latent
  `params:`-instead-of-`parameters:` typo in
  `sdk-custom-tools-per-session-binding.test.ts`'s tool fixture,
  previously silent because nothing validated tool shape — fixed.
  Verified: `bun test` across `test/extensibility/` + dependent
  per-session-binding files (96/96 + dependents pass) + full `bun run
  check:ts`.
- [ ] `f47fd9300` (scout agent prompt `blocking: true` removal) —
  reviewed, coupled to a not-yet-identified larger task/job per-item
  blocking feature landing earlier in this checkpoint (referenced by its
  own CHANGELOG bullet as already-shipped); deferred with that feature.
- [x] **N/A** `d7a71642c` fix(coding-agent): guarded browser header
  generation — `packages/coding-agent/src/web/search/providers/browser-headers.ts`
  does not exist in jeopi at all; coupled to the checkpoint-1-deferred
  web-search-provider rewrite (`ea632a518`/`4c167eaa6`). Out of scope
  until that rewrite lands.
- [x] `0828c53ca` feat(coding-agent): integrated liveness monitoring into
  irc wait operations — jeopi commit `4cb3ad47c`. `IrcBus.wait()` gained
  an `options.liveness: { registry, senderId }` param that checks
  `AgentRegistry.listVisibleTo()` for a running peer on commitment and on
  every registry change, aborting with a named error the moment none
  remain. `IrcTool.#executeWait()` always passes it now. Direct 1:1
  port. Verified: `bun test .../tools/irc.test.ts` (43/43 pass, incl. 4
  new liveness tests) + full `bun run check:ts`.
- [x] `a643e9446` chore: remove redundant tests — applicable portion
  ported as jeopi commit `0a6472415` (the `params:`→`parameters:` typo
  fix in `sdk-extensions-per-session-binding.test.ts`, same bug
  independently found and fixed in the sibling `sdk-custom-tools-*` file
  while porting `459682cc6`, confirmed correct by this later upstream
  commit). Rest (`grep.rs` `SearchWorker`/`search_one_file` formatting,
  deleted `web-search-browser-headers.test.ts`) is coupled to
  not-yet-ported features (allocation-free grep, web-search rewrite) —
  N/A to jeopi's current code shape.
- [x] **N/A** `5c56144f6` "Update VOUCHED list" — pure upstream
  bookkeeping (`.github/VOUCHED.td` contributor list), same pattern as
  checkpoint 1/2's equivalent chores.
- [ ] `f47fd9300` (scout agent prompt `blocking: true` removal) —
  reviewed, coupled to a not-yet-identified larger task/job per-item
  blocking feature landing earlier in this checkpoint (referenced by its
  own CHANGELOG bullet as already-shipped); deferred with that feature.
- [ ] **Reviewed, deferred — genuine feature removal, not a quick win**:
  `172691f6e` feat: removed redundant pre-execution bash command fixup
  logic — deletes `crates/pi-shell/src/fixup.rs` (530 lines), the native
  `apply_bash_fixups`/`BashFixupResult` napi exports, jeopi's
  `bash-command-fixup.ts` (currently the full implementation, not yet a
  compat shim), the `bash.stripTrailingHeadTail` settings-schema entry,
  and the call site in `bash.ts`; rewrites 3 docs files. All of it
  exists in jeopi unchanged (confirmed by reading
  `bash-command-fixup.ts`, `bash.ts`'s `applyBashFixups` call site, and
  `settings-schema.ts`'s `bash.stripTrailingHeadTail` entry) — fully
  applicable, but a real architecture/behavior change (bash commands
  with trailing `| head`/`| tail`/`2>&1` stop being auto-stripped) that
  needs its own careful pass (native rebuild + docs + settings + call
  site), not a rushed one.
- [ ] **Reviewed, deferred — large**: `0b9bdaaed` feat(ai): automated
  recovery for malformed tool arguments — 479 lines across
  `dialect/glm.ts` (125 new) and `utils/validation.ts` (237 changed,
  core tool-argument validation/coercion path). Comparable in risk to
  touching shared validation logic across every provider; needs
  dedicated review.
- [ ] **Reviewed, deferred — coupled to task/job restructure**:
  `d39a3ed45` chore: fix stale tests (confirmed jeopi's
  `task-async-fallback.test.ts` still uses the pre-restructure
  `id`/`description`/`assignment` `TaskParams` shape, not upstream's
  `name`/`task`), `8e006a5c8` (agent selection instructions,
  `task/index.ts`), `441037025` (thinking-level config precedence,
  `task/agents.ts`+`task/executor.ts`+`task/types.ts`) — all touch the
  `task/` module family that `cb2153e9a` (flat task structure) rewrites.
- [x] **N/A** `3c2c9f5bc` "docs(coding-agent): update changelog for u10"
  — pure upstream changelog bookkeeping (issue-linked entry for a
  publish branch), not applicable to jeopi's own changelog cadence.
- [ ] **Reviewed, deferred — large TUI feature pair**: `c22d5dffb` +
  `62172339b` + `276092eac` (tui loader/anchored-container sequence) —
  confirmed jeopi's `loader.ts` has no `requestDirectWrite` at all (only
  `requestComponentRender`), so all three are coupled to `276092eac`
  introducing that mechanism (149 new lines in `tui.ts`) — a genuine
  perf feature (bypasses the full compose/diff pipeline for loader
  ticks), not a quick fix.
- [ ] **Reviewed, deferred — coupled to model hub**: `c6b83c1d9` (session
  selector tiered search perf, 537 lines across `session-selector.ts`/
  `fuzzy.ts`/`autocomplete.ts`) and `1eab12e28` (skill completion
  matching, `autocomplete.ts`) both touch `packages/tui/src/autocomplete.ts`
  in ways that may conflict/sequence with each other — needs a combined
  review, not independently portable.

Status: **in progress**, 3/~41 ported + 4 N/A/subsumed. Checkpoint 3's
mechanical/self-contained work is now exhausted — every remaining item
has been individually reviewed and falls into a large-feature bucket
with a concrete, checked reason (not a guess): model hub UI (5
commits), `ask` dialog UI (6 commits), vendored coreutils (4 commits),
agent suspension (2 commits), task/job restructure (5 commits, confirmed
via actual `task/` file inspection), TUI loader direct-write mechanism
(3 commits), bash command fixup removal (1 commit, real behavior
change), malformed tool-argument recovery (1 commit, core validation
logic), session-selector/autocomplete perf (2 commits, need combined
review). None of these are safe to rush — each needs a dedicated
session. Recommend moving to checkpoint 4 (v16.4.6, only 22 commits) to
keep breadth-first progress, circling back to checkpoint 3's deferred
list in a future dedicated pass.

### Checkpoint 4 — v16.4.6 (21 substantive commits) — fully triaged

21 commits between `3d1f9a4a3` and `20c0a2e41`. Notable large features
landing here: model performance tracking + storage/migration
(`c4fa0ebaa` + `a0dcb8ae2` UI + `41317cc23` tests + `d54dcc222` fallback
routing — 4-commit sequence), sequential message queueing/commands
(`e7955ddf3`), interactive fallback chain configuration (`54bafa1cc`),
`0ae8efd64` "integrated coreutils as in-process shell builtins" (part of
the checkpoint-3-deferred vendored-coreutils bucket), preserved
completed/abandoned tasks in session (`6c292b97c`, likely coupled to the
checkpoint-3-deferred flat task structure).

- [x] `a9adf20af` fix: prevented false overlap errors by deduplicating
  identical edits — jeopi commit `7f960a53c`, Rust
  (`crates/pi-ast/src/ops.rs` + `crates/pi-natives/src/ast.rs`). Direct
  1:1 port. Verified: `cargo test -p pi-ast -p pi-natives ast` (12/12
  pass) + `cargo fmt` + full `bun run check:rs`.
- [x] `2c161d2a8` + `9269823d1` fix(coding-agent): preserved btw codex
  websocket routing + shared codex state — jeopi commit `e545a0865`.
  `/btw` side-channel turns now pass `preferWebsockets`/
  `providerSessionState` through instead of forcing SSE with no state;
  Esc now dismisses an active `/btw`/`/omfg` panel before loop-mode or
  maintenance interrupts (previously only before streaming/bash
  aborts). Direct 1:1 port. Verified: `bun test`
  `agent-session-message-pipeline.test.ts` + `input-controller-escape.test.ts`
  (53/53 pass, incl. 3 new tests) + full `bun run check:ts`.
- [x] `7cef4a769` fix(ai): improved OAuth credential resolution fallback
  logic — jeopi commit `30b46cf97`. Replaced the single top-ranked-only
  fallback with a 3-pass ladder (strict → blocked-allowed+filtered →
  blocked-allowed+unfiltered) run over every candidate, so an exhausted
  Pro-eligible account is now returned (real usage-limit retry
  semantics) instead of "No API key found" when the top-ranked candidate
  is an idle-but-ineligible account. Adapted: jeopi has no generalized
  multi-tier `planRequirement` abstraction (only a boolean
  `enforceProRequirement`/`hasOpenAICodexProPlan` Pro gate) — ported the
  structural ladder fix against jeopi's actual gate shape. Verified:
  `bun test auth-storage-codex-selection.test.ts` (21/21, incl. new
  regression test) + full `auth-storage*` suite (152/152) + `bun run
  check:ts`.
- [x] **N/A** `4181ef18b` build: prevented embedding native runtime
  dependencies — depends on `packages/coding-agent/scripts/compile-binary.ts`
  and the `Bun.build()`-API binary-compile path, neither of which exist
  in jeopi (confirmed: no `compile-binary.ts` file; `build-binary.ts`
  and `ci-release-build-binaries.ts` both still spawn CLI-invoked `bun
  build --compile`). Same root cause as `d179968bb`/`3d2568060`'s N/A
  findings — jeopi never adopted the Bun.build JS-API migration for any
  binary-compile path.
- [x] **N/A** `666327608` feat(coding-agent): improved model search
  ranking by match quality — touches
  `packages/coding-agent/src/modes/components/model-browser.ts`, which
  doesn't exist in jeopi (confirmed: only `model-selector.ts` exists).
  Coupled to the checkpoint-3-deferred Model Hub feature
  (`59d08172c`+series) that introduces `model-browser.ts`/`model-hub.ts`
  in the first place.

Status: **in progress**, 3/~21 ported (3 jeopi commits covering 4
upstream commits), triaged the rest:
- [ ] **Deferred — model perf tracking bucket** (all touch/reference
  `agent-storage.ts`'s new `model_perf` table, `recordModelPerf`, or the
  `model-browser.ts`/`model-hub.ts` UI that doesn't exist in jeopi):
  `c4fa0ebaa` (core: 339 lines, new table + backfill), `a0dcb8ae2` (UI
  integration into `model-browser.ts`/`model-hub.ts`), `41317cc23`
  (tests for the above), `b6559861d` (throughput calc standardized to
  total-duration, small but reads `recordModelPerf`'s corrected math),
  `20c0a2e41` (storage test fixes for the `SCHEMA_VERSION` bump this
  introduces), `a3117c284` (`AsyncDrain` extracted from
  `history-storage.ts` to `packages/utils` purely as prep for
  `recordModelPerf`'s deferred-write batching — no benefit ported alone,
  moves with the feature that needs it).
- [ ] **Deferred — large, standalone**: `e7955ddf3` feat: sequential
  message queueing and commands (551 lines, new `queue-input.ts` module
  + editor/input-controller/TUI changes) and `54bafa1cc` feat:
  interactive fallback chain configuration (1060 lines, 487 of them in
  the not-yet-existing `model-hub.ts` — coupled to the Model Hub bucket
  too).
- [ ] **Reviewed, deferred — real structural divergence found**:
  `d54dcc222` feat: allowed model fallback after retry budget exhaustion
  — confirmed jeopi's `agent-session.ts` retry-lifecycle code at the
  target line has ALREADY diverged from upstream's pre-change shape
  (jeopi's `if (this.#retryAttempt > retrySettings.maxRetries &&
  !classifierRefusal)` already has a `classifierRefusal` guard upstream
  only adds via a different later condition) — this is core turn-
  reliability logic; force-fitting the diff without reconciling the
  divergence first is too risky to rush.
- [ ] **Reviewed, deferred — genuine new feature, not a quick win**:
  `6bb0878b6`+`43f8999a9` feat(ai): cache invalidation for usage reports
  — new `POST /v1/usage/stale` auth-broker endpoint, wire-schemas,
  `AuthCredentialStore.invalidateUsageCache` hook, `RemoteAuthCredentialStore`
  wiring, plus `packages/coding-agent/src/cli/usage-cli.ts`/`commands/usage.ts`
  CLI changes (148 lines combined across 9 files) — a real wire-protocol
  addition, needs its own review pass.
- [x] **N/A** `0ae8efd64` feat: integrated coreutils as in-process shell
  builtins — coupled to checkpoint 3's deferred vendored-coreutils
  bucket (`991c166d8`/`5a73d65b7`/`8a510052a`/`d1317c303`).
- [x] **N/A** `6c292b97c` refactor: preserved completed and abandoned
  tasks in session — coupled to checkpoint 3's deferred flat task
  structure bucket (`cb2153e9a`).
- [x] **N/A** `12466ecf4` "chore: bump version to 16.4.6" — pure
  upstream bookkeeping (own version bump across every package.json/
  Cargo.toml/lockfile), same pattern as every other checkpoint's
  version-bump chore.

Checkpoint 4 fully triaged: 21/21 commits accounted for — 3 ported, 3
N/A, 15 deferred (12 to the model-perf/Model-Hub/sequential-queueing
buckets, 1 to a confirmed code-divergence risk, 2 to a genuine
unreviewed feature).

### Checkpoint 5 — v16.4.7 (6 commits) — fully triaged

6 commits between `20c0a2e41` and `f933f02fc`. Small checkpoint, fully
resolved:

- [x] `4fa5b61b0` "Add plan review copy hotkey" — jeopi commit
  `e1aa33a5d`. `c` hotkey in `PlanReviewOverlay` copies the current
  (in-overlay-edited) plan markdown to the clipboard via a new
  `onCopyPlan` callback. Direct 1:1 port. Verified: `bun test` on both
  touched test files (74/74 pass, incl. 3 new tests) + full `bun run
  check:ts`.
- [x] `1b0b18c7a` fix(stats): handled malformed session entries to
  prevent sync crashes — jeopi commit `0ad04c7aa`, applicable portion
  only. `extractStats()` now skips entries with no model/provider/api/
  usage and coerces missing `stopReason`/token counts/`timestamp`
  instead of crashing the whole sync on a NOT NULL constraint. **Not
  ported**: the `extractToolCalls()`/`ToolCallStats` portion — confirmed
  jeopi's `packages/stats` has no per-tool-call stats tracking at all
  (no matching type/function/export exists). Verified: `bun test` new
  file (3/3) + full `packages/stats/test/` suite (56/57 — the 1 failure
  is a confirmed pre-existing, unrelated flake in
  `priority-premium-requests.test.ts`, reproduced identically via `git
  stash` before this edit) + full `bun run check:ts`.
- [x] `1822603b2` feat(coding-agent): improved model browser keyboard
  navigation and focus visuals — TUI portion only, jeopi commit
  `bd0621fd8`. `TUI#handleInput()`'s input-render-grace delay (meant to
  keep a Ctrl+C/Esc double-press gesture's second key from landing
  behind an immediate slow repaint) now arms only for those two keys
  instead of every keystroke, so idle-state keyboard navigation repaints
  without a frame of extra latency. **Not ported**: the
  `model-browser.ts`/`model-hub.ts` navigation/focus-visual changes in
  the same commit — coupled to the not-yet-ported Model Hub feature.
  Verified: `bun test input-priority.test.ts` (2/2, incl. new test) +
  full `packages/tui/test/` suite (1160/1163 pass, 3 pre-existing skips)
  + full `bun run check:ts`.
- [x] `93db3913d` "chore: update tips" — `tips.txt` portion only, jeopi
  commit `c1bd90e49`. Removed the stale `[NEW]` marker from the
  `/advisor` tip (an established jeopi feature). **Not ported**: the new
  `->`-prompt-queueing tip (references the not-yet-ported sequential
  message queueing feature — confirmed no `->` composer shorthand exists
  in jeopi) and the Model Hub CHANGELOG bullets bundled into the same
  commit (coupled to the deferred Model Hub feature).
- [x] **N/A** `f933f02fc` "chore: bump version to 16.4.7" — pure
  upstream bookkeeping, same pattern as every other checkpoint.
- [x] **N/A** `b1c882e89` "Update VOUCHED list" — pure upstream
  bookkeeping (`.github/VOUCHED.td`), same pattern as every other
  checkpoint.

Checkpoint 5 fully triaged: 6/6 commits accounted for — 4 ported
(2 of them partial: the tips/keyboard-nav commits had a Model-Hub-
coupled portion correctly excluded), 2 N/A.

### Checkpoint 6 — v16.4.8 (6 commits) — fully triaged

6 commits between `20c0a2e41`..`v16.4.8`. Fully resolved:

- [x] `b6f83021c` fix(coding-agent): ensured top-level declarations
  persist in async cells — jeopi commit `5ec5081c1`. JS eval cells
  lost top-level `function`/`var` declarations across cells when the
  defining cell contained top-level `await` (the async IIFE wrapper
  scoped them to the cell's function scope instead of publishing them
  to the worker global, so a later cell saw `ReferenceError`).
  `demoteTopLevelLexicals` now also targets top-level `var`/`function`
  declarations (not just demoted const/let/class) when `publishGlobals`
  is set. Direct 1:1 port including both new cross-cell-persistence
  tests. Verified: `bun test js-static-import-rewrite.test.ts` (22/22
  pass) + full `bun run check:ts`.
- [x] `dabe233c6` feat(coding-agent/web): improved perplexity results —
  jeopi commit `b92081cbf`. `skip_search_enabled` flipped `true`→`false`
  (was letting the backend classifier skip retrieval and return an
  ungrounded refusal) plus `always_search_override: true` as a second
  guarantee; declares no tool-approval UI/no local browser agent so the
  stream never stalls on an unrenderable confirmation. Direct 1:1 port
  (no existing test asserts the request body shape). Verified: full
  `bun run check:ts`.
- [x] `bb35e7918`+`fc35e17cb` fix(ast): auto-wrap multi-node patterns
  instead of erroring (+ same-day rustfmt/clippy fixup, squashed) —
  jeopi commit `6f03b0182`. A pattern like `"@types/bun": $V` parses to
  multiple root AST nodes and was rejected outright; `compile_pattern`/
  `compile_search_patterns` now retry wrapped in a minimal single-node
  context for languages with a wrapper template (JSON: `{ <frag> }`
  selecting `pair`, quoting bare metavars), falling back to the
  original error unchanged if the wrap still fails or the language has
  no template. Added regression tests (none existed upstream): JSON
  auto-wrap success + captured metavar text via both entry points, and
  a Rust (no-template) fragment still erroring as before. Verified:
  `cargo test -p pi-ast` (62/62 pass) + `cargo fmt -p pi-ast` (no diff)
  + full `bun run check:rs`.
- [x] `6bd51d4ad` refactor(coding-agent): decoupled tip weight test
  from tips.txt data — jeopi commit `9c77369b5`. `pickWeightedTip` now
  takes the tip list and a uniform sample explicitly instead of reading
  module-level `TIPS`/`Math.random()`, exported for tests; the
  weighted-selection test sweeps a synthetic tip list so a `tips.txt`
  shipping zero `[NEW]` tips (which jeopi's now does, after this
  checkpoint range's earlier `93db3913d` port) no longer fails the
  suite. Direct 1:1 port. Verified: `bun test welcome.test.ts` (3/3
  pass) + full `bun run check:ts`.
- [x] **N/A** `01d3fc9b6` "chore: bump version to 16.4.8" — pure
  upstream bookkeeping (package.json/Cargo.toml/lockfile version bumps,
  release CHANGELOG finalization), same pattern as every checkpoint.

Checkpoint 6 fully triaged: 6/6 commits accounted for — 4 ported
(all direct 1:1, no adaptation needed), 1 N/A. Note: this checkpoint's
tip-weight-decoupling port (`9c77369b5`) directly de-risks checkpoint
5's `93db3913d` port, which had already zeroed out `[NEW]` tips in
`tips.txt` — confirms that earlier port didn't leave the test suite
fragile.

### Checkpoint 7 — v16.5.0 (75 commits) — IN PROGRESS (12/75 ported)

75 commits between `20c0a2e41`..`3047c27c3`. Largest/riskiest
checkpoint so far: introduces an entirely new internal package
(`harbor-manager`/`metaharness`, a benchmark/experiment orchestration
tool — not present anywhere in jeopi, not listed in AGENTS.md's package
table), a `downshift`/`boomerang` agent-workflow feature that is added
then partially removed within the same checkpoint, a new `launch` tool
(persistent project service + pty terminal rendering), and a
session-compaction/collapsed-transcript feature bucket touching
config schema + the `snapcompact` package + session recovery. Full
per-commit list captured in `git log --reverse --oneline
20c0a2e41..v16.5.0` for resume.

**Ported (19 upstream commits via 17 jeopi commits):**
1. `fabded89e` → `f7d3fe402`: empty provider responses classified as retriable
2. `8f783d100` → `13bd9f919`: removed redundant TTSR parse-error logging
3. `900ffef06` → `3d3c1aa46`: text verbosity default high→medium
4. `8c8afaf47`+`df7193731`+`3047c27c3` → `c69059fe5`: `tab.evaluate` always runs in the page's main JS world (squashed with same-day test-timeout/skip-when-chromium-cant-exec fixups)
5. `59ecd2a4d` → `4e9067f3d`: ACP elicitation type guards (pure narrowing refactor)
6. `3e5b7da6f` → `b7ba70754`: auth-gateway diagnostic response headers (`x-request-id`, LiteLLM-style cost/model/duration headers)
7. `bd7d39522` → `43cba08c0`: browser `wait()` gained predicate-polling form, `wait(fn, {timeout,interval})`
8. `46ed33f27` → `62505dfcc`: `/tan` records `session_init` on the clone's own session log
9. `c69c04836` → `23d02c66e`: CI UI/TUI bucket chunk size 10→5 (Bun GC heap abort avoidance) — **partial port**, the paired `repro-issue-1955` test's `Settings.init`/`resetSettingsForTest` addition was **not** ported (confirmed `renderInitialMessages`/`initTheme` read no global `Settings` state on jeopi's current code path; upstream's stated root cause, a `display.collapseCompacted` settings read, doesn't exist in jeopi yet — deferred with the session-compaction bucket below)
10. `eb52f6ea2` → `83a4ec908`: `/tan` clones get a context-switch developer-message notice before their prompt runs
11. `d4ffb4b64` → `682423c05`: status event log shows a tail window of the most recent entries behind a leading "… N earlier" marker (was head window + trailing "… N more"), expanded view widens to the viewport-sized preview window
12. `896c4bb17` → `5df2e25fa`: expanded (ctrl+O) streaming edit diff previews capped to a viewport-sized tail instead of unbounded — fixes duplicated tool-box blocks in scrollback from a stale frozen preview snapshot
13. `e45796908` → `0f58e92b5`: hashline `repairReplacementBoundaries` now rejects two classes of ambiguous auto-repair (a too-short one-sided boundary echo; a spared structural closer with no evidence the payload belongs inside its block) instead of silently guessing and risking data loss — added 4 regression tests from the real incident that motivated it
14. `485d207a7` → `ba33c054d`: forced renders (tool finalization, `resetDisplay`, image reconciliation) mid-resize-drag now stay on the alt-screen viewport fast path instead of preempting into a destructive normal-screen full replay (ED3 + O(history) scroll-through, twice)
15. `0a98aa252` → `6a60d92b2`: further `/tan` hardening — inherited todo list cleared at fork (memory + disk), fork notice warns about concurrent parent edits + inherited todos, notice re-injected after every compaction, provider prompt-cache key mirrors the parent's actual pinned key; `#pruneStaleToolResults` now persists via `rewriteEntries` so forks/resume don't rebuild a divergent un-pruned prefix
16. `87a64b2f6` → `795e2ab09`: backgrounded Bash blocks freeze with a compact `Backgrounded: <jobId>` footer notice instead of continuing to repaint with live/final job output; `EventController`'s "keep updating" tracking scoped to `task` calls only, not Bash
17. `58d6130b5` → `4f16fc755`: `retry.fallbackChains` now consulted on non-retryable ("hard") provider errors too, not just retryable ones — a hard error on a model covered by a chain switches to the next candidate instead of failing the turn, still never backoff-retrying the failing model. Caught and fixed a test-adaptation bug during verification: jeopi's `#resolveRetryFallbackRole` resolves chain keys as configured model roles (`settings.setModelRole`), not upstream's provider-wildcard `"anthropic/*"` pattern — the ported tests silently exercised zero fallback attempts until adapted to jeopi's actual mechanism

**Explicitly deferred (reason given, not yet a final skip decision):**
- `69865b609` (system prompt verification-guidelines rewrite) — coupled to the same `system-prompt.md` structural divergence already flagged blocking `1c6f5dc18` (checkpoint 1, item 19); jeopi's own Verify/Cleanup sections already diverged (mentions jeopi-specific "tester agent"), needs one combined manual review rather than two clobbering passes.
- Harbor-manager/metaharness bucket (whole new package, not in jeopi): `14aa1e206`, `0856055df`, `96ba1a99f`, `32714d2fd`, `6f6f2f263`, `e90bbf121`, `017fd641d`, `b451f9456`, `0f9a30153`, `35d3e49d1`, `77f641268`, `8702a3f22`, and the parts of `42d81f189`/`4cfec9345`/`96cc9caa6`/`acc0211cf`/`d8ad39320`/`4c1c5f40d`/`e770cdc4d`/`f83e40921`/`64dfb98c2`/`6fcb1b300` that are harbor/launch-tool-coupled — needs a user decision on whether this internal benchmarking tool is in scope for the fork at all before any of it is triaged commit-by-commit.
- Downshift/boomerang agent-workflow bucket (added then partially removed upstream within this same checkpoint): `9f1ff90a3`, `e42589d43`, `d7849ddea`, `d76872274`, `4d019e561`, `45e7a12f3`, `95ecc61bc`, `590270ca2`, `f405525bf` (the removal commit — moot for jeopi since none of the "add" commits were ported).
- Session-compaction/collapsed-transcript bucket: `d6f8c061b`, `5c2bae47a`, `585b9e437`, `711fa4312`, `4903a1351`, `aa52fa423`, `22f2c1947`, plus `bf5eb3769` (pending context snapshot rebase after compaction) — touches config schema, `snapcompact` package, and session recovery together; needs one coherent pass, not commit-by-commit.
- Model-Hub-coupled: `8dbc43b6e` (floating model selection), `af7345e87` (role switching/filtering in model picker) — same deferred-Model-Hub bucket as checkpoints 4/5.
- Vendored-coreutils BSD compat: `6b2f4ad5d`, `198efb3e4` — continuation of checkpoint 3's already-deferred vendored-coreutils bucket.
- `a886a3090` (hashline drift-recovery rewrite: "replaced 3-way-merge and session-chain replay strategies with a consistent anchor remapping flow", 185 lines of core `recovery.ts` changed across 8 files, removes `RECOVERY_SESSION_REPLAY_WARNING` and the 3-way-merge path entirely) — data-integrity-critical rewrite of hashline's core recovery algorithm; needs a dedicated full before/after read of `recovery.ts` and its test suite, not a checkpoint-triage-speed port. `e45796908` (boundary-repair strict validation, same package) was already safely ported this session — this is the next, much larger hashline item.
- `0d07da529` (browser execution safety controls: cell-budget timeout clamping, `recover` on tab-worker init, JS-dialog/stalled-op failure attribution, `//!world=main` string-boxing fix) — the puppeteer-core patch it touches is pinned to `25.3.0` upstream vs jeopi's `25.1.0` (`patches/puppeteer-core@25.1.0.patch`), so the patch hunk needs manual re-derivation against jeopi's pinned version, not a direct apply; plus 148 lines of `tab-worker.ts` changes to integrate with the already-ported `wait()` predicate/main-world work. Needs dedicated review.
- `edd959a38` (removed docs-index generation, `PI_DOCS_EMBED` env-var injection instead) — coupled to checkpoint 1's deferred Bun.build bundling migration (`d179968bb`); jeopi's build still generates and CI-checks `docs-index.generated.txt` via `gen:docs`, confirmed load-bearing in every `check:ts` run.
- Experimental/wip: `ac1625361` ("wip: rslide"), `4df6f6683`/`f80fb4836`/`da24614d5` (prewalk finalization/guidance/status-line — explicitly experimental per commit messages).
- `d0f90f35a` (removed unreliable web search providers, −401 lines) — needs review against jeopi's still-deferred web-search-provider-rewrite bucket from checkpoint 1 before deciding whether this is a compatible subtraction or conflicts with what jeopi kept.
- `a5673c90f` (removed legacy Google interactions routing, −1510/+95 across 18 files) — large deletion, needs careful review that jeopi doesn't still depend on the removed path before porting.
- `f9f6ed9e8` (replaced legacy `pi/` role alias prefix, 38 files) — potentially relevant to jeopi's own `pi`/`omp`→`jeopi` rename conventions; needs dedicated review, not a quick port.
- `883e68f2d` (dependency version bumps + patch refresh) — `@ark/schema` portion already **N/A/subsumed**: jeopi's `bun.lock`/`package.json` are already at the target `0.56.2` (confirmed via direct read, no action needed). `@agentclientprotocol/sdk` 0.25.0→1.2.1 (major version) deferred: upstream's own commit needed a new package patch to restore an export path (`dist/schema/zod.gen.js`) the SDK stopped publishing, indicating internal SDK structure changed — a major bump on the exact package jeopi's `jeopi acp` mode depends on needs downstream ACP-integration compatibility verification (`packages/coding-agent/src/modes/acp/`), not a blind lockfile sync, especially given jeopi's `puppeteer-core` pin has already independently diverged from upstream's (`25.1.0` vs `25.3.0`).

**N/A:** `a3960bb4e` ("chore: bump version to 16.5.0") — pure upstream release bookkeeping.

Checkpoint 7 fully triaged: 75/75 commits accounted for — 19 ported
(17 jeopi commits, all verified against real test suites plus full
`bun run check:ts`/`check:rs`; one port caught and fixed a
test-adaptation bug during verification rather than shipping a
false-positive), 1 N/A, 55 deferred to dedicated large-feature
sessions with concrete reasons recorded per item/bucket above. No
"not yet reviewed" items remain for this checkpoint.

### Checkpoint 8 — v16.5.1 (190 commits) — IN PROGRESS (3/190 ported)

190 commits between `3047c27c3`..`14b5da76a`. Largest checkpoint by
commit count, but structurally different from checkpoints 1/3/4/7:
this is where upstream's history starts showing external-contributor
PRs merged individually. Each real change is typically a pair — the
substantive `fix(...)`/`feat(...)` commit, then a `Merge PR #NNNN: ...`
commit right after that carries **no unique diff** (it's the merge
commit for the PR branch, already fully represented by the preceding
commit). Triage unit is the `fix(...)`/`feat(...)` commit; bare
`Merge PR #NNNN` commits are skipped as N/A-by-construction once their
paired substantive commit is triaged. This means the *effective*
number of distinct changes is well under 190 — full per-commit list
via `git log --reverse --oneline v16.5.0..v16.5.1` for resume.

**Ported (8 upstream commits, each its own jeopi commit):**
1. `aeed4d10d` → `bb1f0008a`: Markdown HTML comments (`<!-- -->`) stripped during TUI terminal normalization instead of rendering literally
2. `dac54080d` → `3a8a00f3d`: autolearn auto-continue no longer nudges after an aborted turn (Esc/cancel) — reads `stopReason` from the `agent_end` event's own messages since the session-level abort flag is unreliable by delivery time
3. `1a3e137f1` → `0112a4309`: `jeopi -p` text-mode print writes a one-shot "Working..." stderr indicator before the first prompt so it doesn't look hung
4. `81c4cb6df` → `de89ca220`: follow-up cleanup to `dac54080d`'s test (typed `AssistantMessage` fixture instead of `as never` cast)
5. `b097019fe` → `917059ba4`: MCP tool call args now resolve `local://` image attachments to on-disk paths before dispatch (external MCP servers can't resolve jeopi's internal URL scheme) — new `CustomToolContext.localProtocolOptions`, recursive arg-tree resolver in `tool-bridge.ts`
6. `70316a7f8` → `b68bafab1`: collab-web live transcript deduped active tool cards against committed assistant messages too (not just the stream ghost), and stops showing the "thinking…" shimmer while a tool card is already rendering
7. `8480a84b3` → `892226c28`: collab-web deduped active tool cards render the ActiveTool's current execution args, not the stale raw args captured at tool-call time
8. `3ebcb3690` → `6a0680675`: threaded `localProtocolOptions` through `ExtensionRunner`/`ExtensionContext`/`createCustomToolContext` so extension-registered MCP tools resolve `local://` session attachments against the correct calling session too (follow-up to #5)
9. `5e781a9c7` → `66096b939`: OAuth completion page now tells users they can close the tab manually (Firefox ignores `window.close()` on unscripted tabs); new regression test drives the real callback path directly since jeopi has no `/launch` route
10. `b7aa046ed` → `4c6e1bee6`: stale cached model limits no longer override fresh static-catalog limits after a static fingerprint mismatch — same-id cache rows are sanitized (`contextWindow`/`maxTokens` reset to `null`) instead of passed through verbatim
11. `63adfeece` → `088352a76`: plugin installer removes the stale pinned git dependency edge before invoking Bun when replacing a pinned source with an unpinned one for the same repo, avoiding a Bun `DependencyLoop`
12. `e7c678dbe` → `963f10a18`: `ultrathink`/`orchestrate`/`workflowz` magic keywords now trigger beside sentence punctuation and quotes (new shared `magicKeywordRegex` boundary builder), while still rejecting inflections and path/extension occurrences
13. `358811115`+`f98ef2e1e` → `1d31be68f` (squashed, same-day pair fixing #4797): Cursor `max_mode` metadata is now parsed from `GetUsableModels` (new `Model.cursorMaxMode`), forwarded on run requests (`modelDetails.maxMode` + new `requestedModel`), and the Cursor cache namespace was bumped (`cursor:max-mode-v2`) so stale pre-max-mode cache rows can't mask the flag
14. `7029789e7` → `9462719c1`: provider credential changes (add/remove/login) now also purge persisted session-sticky OAuth cache rows for that provider (new `AuthCredentialStore.deleteCachePrefix`, implemented for both Sqlite and Remote stores), fixing sessions reusing stale sticky mappings after login/logout
15. `a86c1ec46` → `23c334712`: Python eval `agent()` bridge calls no longer lose in-flight subagent work on external abort — new `BridgeAbortShield` in `executor-base.ts` defers the kernel abort until already-paused bridge calls resume, and rejects new bridge calls once an abort is pending to stop a post-abort fan-out wave

**Not yet reviewed:** ~175 remaining. Next in queue: `6fab752eb`+
`d670dd5d9` (CLI --max-time duration parsing pair), `1d9889810`
(Codex reset selected-account), `3876f60d6` (npm self-update
routing), `a4f43be04`+`f26fffb8e` (read-only internal URL / memory
root isolation pair), and onward through
--oneline v16.5.0..v16.5.1` starting after `f26fffb8e`, and onward through
the list. Given the volume, expect several more large/risky items
(the `org`-scoped Anthropic OAuth credential identity rework spans
~10 commits `044d722a3`..`c001d660e`, the advisor staleness-coalescing
rework spans ~6 commits `74715f8cc`..`74be4d5f6`, and the eval-runtime
isolation rework spans ~9 commits `c40ccdc68`..`ffa879ba2` — these
look like coherent multi-commit features/rewrites needing the same
dedicated-review treatment as checkpoint 7's large buckets, not
commit-by-commit porting).