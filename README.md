<h1 align="center">jeopi</h1>

<p align="center">
  <img src="assets/character.gif" alt="animated jeopi hooded doll mascot with split cyan and magenta pants, watched by a curious jeo-code crayfish" width="320">
</p>

<p align="center">
  <strong>Encode intention. Decode software.</strong><br>
  The oh-my-pi engine, rebuilt around one belief: <em>a gate that didn't pass is reported as not passed.</em>
</p>

<p align="center">
  <a href="https://github.com/akillness/jeopi"><img src="https://img.shields.io/badge/jeopi-spec--first-3B82F6?style=flat&colorA=0B0B14&logo=github&logoColor=white" alt="spec-first"></a>
  <img src="https://img.shields.io/badge/gates-critic%20blocked-8B5CF6?style=flat&colorA=0B0B14" alt="critic gated">
  <img src="https://img.shields.io/badge/verification-artifact%20backed-EC4899?style=flat&colorA=0B0B14" alt="artifact backed">
  <a href="packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-F472B6?style=flat&colorA=0B0B14" alt="Changelog"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-58A6FF?style=flat&colorA=0B0B14" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=0B0B14&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=0B0B14&logo=rust&logoColor=black" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3.14-f472b6?style=flat&colorA=0B0B14" alt="Bun"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> by <a href="https://github.com/can1357">@can1357</a> (itself a fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a>), fused with the spec-first working philosophy of <a href="https://github.com/akillness/jeo-code">jeo-code</a>.
</p>

jeopi keeps everything that makes oh-my-pi the most capable agent surface that ships — **40+** providers, **32** built-in tools, **14** LSP ops, **28** DAP ops, **~55k** lines of Rust core — and changes *how it works*: requirements are crystallized before planning, plans are critic-gated before execution, and completion claims are backed by artifacts.

## jeopi vs omp — what actually changed

| | `omp` (upstream) | `jeopi` |
| --- | --- | --- |
| **Vague request** | starts working | crystallizes goal / constraints / **checkable acceptance criteria** first — "make it better" gets sharpened, not accepted |
| **Planning** | plan agent | plan agent + **blocking `critic` gate**: `okay` / `iterate` / `reject` verdict, schema-enforced — and **runtime-enforced**: after a non-okay verdict the `task` tool refuses to spawn execution agents and `write`/`edit` lock the working tree until a fresh `okay` (or a new user message) |
| **Review** | `reviewer` (patch bugs) | `reviewer` + **`architect`**: severity-rated structural verdict that is invalid without an `inspected[]` evidence list |
| **Failure** | retry | **failure-lesson loop** — capture what the failure proved, change the next attempt, split stuck subgoals; no apology loops. Runtime 3-strike counter closes the critic-iterate loop before it can spin |
| **"Done"** | tests pass | **artifact gate** — a criterion with no command + observed result is reported `unresolved`, never implied met |
| **Pipeline** | ad-hoc | **`/jeo`**: interview → frozen seed → plan → critic gate → bounded execution → artifact-gated verification |
| **Identity** | `omp` | `jeopi` binary; config directory renamed `~/.omp` → `~/.jeopi` (`jeopi config migrate-legacy` moves existing auth/sessions/settings over) |

Real gates, no theater. The rest of this README is the engine both share.

## Install

**Bun (recommended)**

```sh
bun install -g jeopi-cli
jeopi --version # jeopi/16.x
```

**npm**

```sh
npm install -g jeopi-cli
```

**From source**

```sh
git clone https://github.com/akillness/jeopi.git && cd jeopi
bun run setup   # installs deps, builds natives, links the global `jeopi` command
```

macOS · Linux · Windows · bun ≥ 1.3.14. Upgrading from `omp`? Run `jeopi config migrate-legacy` once to move `~/.jeopi` to `~/.jeopi` — then `/login` once, keep it forever. jeopi is published as unscoped npm packages — CLI: `jeopi-cli` (binary command: `jeopi`), libraries: `jeopi-*` — fully independent of the `@oh-my-pi` scope, while legacy `@oh-my-pi/pi-*` plugin imports keep resolving through the built-in compat shim.

## The spec-first spine

The jeo-code pipeline, rebuilt on jeopi's native subagents. One command drives it:

```
/jeo <what you want built>
```

```
  interview        Socratic ambiguity gate — goal, constraints, out-of-scope,
      │            checkable acceptance criteria. Vague criteria are refused.
      ▼
  frozen seed      local://jeo-seed.md — immutable; scope changes reopen the
      │            interview, never drift silently.
      ▼
  plan             read-only `plan` agent; concrete files, sequencing,
      │            per-criterion verification.
      ▼
  critic gate      read-only `critic` agent; schema-enforced verdict
      │            okay / iterate / reject. No okay → no execution. Ever.
      │            Hard gate: the RUNTIME blocks execution spawns and
      │            working-tree writes until the verdict is okay.
      ▼
  execute          bounded `task` subagents; a failed task feeds the lesson
      │            into the next attempt instead of retrying unchanged.
      ▼
  verify           suite runs once as a global signal; each criterion cites
                   its command + observed result, or is reported unresolved.
```

### The gate is code, not vibes

Upstream jeo-code enforces its critic verdict with a state file and hash check between CLI processes. jeopi runs the whole pipeline inside one agent session — so the gate lives in the session runtime instead:

- A `critic` subagent's schema-validated verdict is recorded by the session the moment the run completes.
- While the latest verdict is `iterate` or `reject`, the `task` tool **refuses to spawn any non-read-only agent**, and `write`/`edit`/patch **reject every working-tree mutation** (the `local://` sandbox stays writable for seeds, plans, and notes).
- The gate clears in exactly two ways: a fresh critic returns `okay` for the revised plan, or **you** send a new message — the user regaining control is the only override.
- A **3-strike counter** bounds the iterate loop: after three consecutive non-okay verdicts even critic re-submission is refused, forcing a stop-and-report instead of an unbounded re-planning spin.

### Loop engineering

The `/jeo` pipeline borrows the deep-research playbook for token efficiency and loop stability:

- **Reference, don't repeat** — the seed and plan live in `local://` files; assignments and critic submissions pass paths, never re-inlined bodies.
- **Delta-only iteration** — each critic re-submission carries a short "what changed per required fix" note; the critic re-reads the plan file, not a re-narrated history.
- **Every round must change state** — an iteration that incorporates no new fact (a fix applied, a failure lesson, a user answer) is a prohibited no-op retry.
- **Hard bounds everywhere** — interview ≤2 ask rounds, critic ≤2 iterations (runtime stop at 3 strikes), per-task retries ≤2, verification suite runs once.
- **No silent caps** — anything a bound dropped (an unverified criterion, an unsplit subgoal) is named in the report.

The same discipline is welded into the standing agents:

- **`critic`** — read-only actionability gate. *"If you catch yourself softening a real, blocking gap into `iterate` just to avoid blocking, that softening is the signal the gap is real."*
- **`architect`** — severity-rated structural review whose verdict is invalid without the list of files it actually inspected. A clean verdict is not the absence of inspection.
- **`task`** — smallest correct change, subgoal-by-subgoal, verification evidence before `done`, debug leftovers removed.

### Skills: jeo-skills works out of the box

[jeo-skills](https://github.com/akillness/jeo-skills) (146 skills — `deep-research`, `god-tibo-imagen`, `perfectpixel`, `ooo`, …) installs into jeopi with zero extra linking: jeopi natively discovers `~/.agents/skills/` plus the `.claude` / `.codex` / `.config/opencode` skill dirs, at both user and project scope.

```sh
# global install — jeopi picks these up automatically
npx skills add -g https://github.com/akillness/jeo-skills --skill deep-research --skill god-tibo-imagen

# jeopi-only pin (native roots)
#   global : ~/.jeopi/agent/skills/<skill>/SKILL.md
#   project: .jeopi/skills/<skill>/SKILL.md
```

Invoke any discovered skill with `/skill:<name>` or let the agent route to it by description.

### Shell completions

`jeopi` generates its own completion scripts for **bash**, **zsh**, and **fish** from the live command/flag metadata, so they never drift from the actual CLI. Subcommands, flags, and enum values complete statically; model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog and `--resume` against your on-disk sessions.

```sh
# zsh — add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(jeopi completions zsh)"

# bash — add to ~/.bashrc
eval "$(jeopi completions bash)"

# fish
jeopi completions fish > ~/.config/fish/completions/jeopi.fish
```

## Every tool, _benchmaxxed_.

Edits that land on the first attempt. Reads that summarize files instead of dumping their content. Searches that return instantly. Pick any model — jeopi will get it right.

| model            | metric       | what                                                                  |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| Grok Code Fast 1 | 6.7% → 68.3% | Tenfold lift the moment the edit format stops eating the model alive. |
| Gemini 3 Flash   | +5 pp        | Over str_replace — beats Google's own best attempt at the format.     |
| Grok 4 Fast      | −61% tokens  | Output collapses once the retry loop on bad diffs disappears.         |
| MiniMax          | 2.1×         | Pass rate more than doubles. Same weights, same prompt.               |

- `read` : summarized snippets · ideal defaults · selector hit rate
- `search` : fastest in the west
- `lsp` : everything your IDE knows, the agent knows
- `prompts` : adjusted relentlessly for each model

[Read the full post ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)

## The Pi _you love_, with **batteries included**.

Originally built on [Mario Zechner](https://github.com/mariozechner)'s wonderful [Pi](https://github.com/badlogic/pi-mono), jeopi adds everything you're missing.

### 01 · Code execution w/ tool-calling

Most harnesses give the agent a Python sandbox and call it done. Ours runs persistent Python and a Bun worker, and either kernel can call back into the agent's own tools — read, search, task — over a loopback bridge. The agent loads a CSV with tool.read from inside Python, charts it from JavaScript, and never leaves the cell.

![jeopi TUI: a single eval session with `[1/2] pandas describe` (Python) printing a real DataFrame.describe() table, followed by `[2/2] top scorer` (JavaScript) running a reduce. Footer: 'Both kernels ran in one session.'](https://omp.sh/captures/eval.webp)

### 02 · LSP wired into every write

Ask for a rename and you get a rename. The call goes through workspace/willRenameFiles, so re-exports, barrel files, and aliased imports update before the file moves. Everything your IDE knows, the agent knows.

![jeopi TUI: `LSP references` returns five hits across three files for the symbol `formatBytes`, then `LSP rename` applies the change with edits to format.ts/report.ts/cli.ts, then a `Search formatBytes 0 matches` confirmation. Final line: 'Rename complete. Five edits across three files…'.](https://omp.sh/captures/lsp.webp)

### 03 · Drives a real debugger

A C binary segfaults: the agent attaches lldb, steps to the bad pointer, reads the frame. A Go service hangs: it attaches dlv and walks the goroutines. A Python process is wedged: debugpy, pause, inspect, evaluate. Most agents are still sprinkling print statements.

![jeopi TUI: a live lldb-dap session against a native binary at /tmp/omp-native/demo. Adapter=lldb-dap, Status=stopped, Frame=xorshift32, Instruction pointer 0x10000055C, Location demo.c:6:10. Debug scopes and Debug variables cards show locals (x = 57351) and the agent confirms the math: x went from 7 → 57351 (= 7 ^ (7<<13)).](https://omp.sh/clips/dap-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/dap.mp4)_

### 04 · Time-traveling stream rules

Your rules sit dormant until the model goes off-script. A regex match aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point. You get course-correction without paying context tax on every turn. Injections survive compaction, so the fix sticks.

![jeopi TUI: agent reading src.rs and about to write Box::leak when the request aborts (red `Error: Request was aborted`), an amber `⚠ Injecting rule: box-leak` card injects the rule body `Don't reach for Box::leak in production code paths`, and the agent then course-corrects by proposing `Arc<str>` and asking the user to confirm.](https://omp.sh/clips/ttsr-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/ttsr.mp4)_

### 05 · First-class subagents

Split a job across workers and get typed results back. task fans out into isolated worktrees, each worker runs its own tool surface, and the final yield is a schema-validated object the parent reads directly. No prose to parse, no merge conflicts between siblings, no orphaned edits.

![jeopi TUI showing `task` spawning two subagents `ComponentsExports` and `RoutesExports`, the constraints block requiring an IRC DM between peers, the per-subagent status cards with cost and duration, and a final Findings section listing both exports plus an honest 'IRC coordination note' about a one-sided handshake.](https://omp.sh/clips/irc-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/irc.mp4)_

### 06 · A second model, watching every turn.

Pair a reviewer model to the 'advisor' role and it reads every turn the main agent takes, injecting notes inline — a quiet aside, a concern, or a hard blocker. It runs on its own context and its own model, so it catches what the doer rushed past. The main agent sees the note and course-corrects, or tells you why it won't.

![jeopi TUI: /advisor status shows the advisor running on openai-codex/gpt-5.5; after the main agent scopes a catch to ENOENT instead of swallowing every error, an amber 'Advisor 1 note (concern)' card warns the fix no longer matches the user's literal acceptance criterion.](https://omp.sh/clips/advisor-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/advisor.mp4)_

### 07 · Hand someone the link, they're in.

/collab puts your live session on a relay and hands back a link — and a QR. A teammate joins from another terminal with jeopi join, or just opens it in a browser. Share read-write to pair on the same agent, or /collab view for a read-only link anyone can watch but no one can steer. Frames are sealed client-side; the relay never sees your keys.

![jeopi TUI: /collab view prints 'Collab session started!' with a jeopi join command, a my.omp.sh browser link, the note 'Anyone with this link can watch the session but cannot prompt the agent', and a large scannable QR code.](https://omp.sh/clips/collab-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/collab.mp4)_

### 08 · Read a pdf on arxiv, why not?

web_search chains eighteen ranked providers and hands whatever URLs it finds straight to read. Arxiv PDFs, GitHub pages, Stack Overflow threads come back as structured markdown with anchors intact — the same tool surface you use on local files. Cite, follow, quote, never lose where you came from.

![jeopi TUI: web_search returns 10 ranked Perplexity sources for inference-time compute scaling, the agent picks an arxiv paper, calls read https://arxiv.org/pdf/2604.10739v1, and summarizes the paper's headline result with real numbers.](https://omp.sh/clips/web-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/web.mp4)_

### 09 · Unapologetically native. Even on Windows.

Other agents shell out to rg, grep, find, and bash. On many machines those binaries don't exist, and on the ones where they do, every call costs a fork-exec round-trip. jeopi links the real implementations into the process. ripgrep, glob, find: in-process. brush is the bash, with sessions that survive across calls. The same jeopi binary runs on macOS, Linux, and Windows — no WSL bridge.

### 10 · Code review with priorities and a verdict

Get a clear verdict on whether the change ships, with every issue ranked P0 through P3 and scored for confidence. /review spawns dedicated reviewer subagents that sweep branches, single commits, or uncommitted work in parallel. You tackle what blocks release first; nothing important hides in a wall of prose.

### 11 · Hashline: edit by content hash

Perfect edits, fewer tokens. The model points at anchors instead of retyping the lines it wants to change, so whitespace battles and string-not-found loops just stop happening. Edit a stale file and the anchors diverge — we reject the patch before it corrupts anything. Grok 4 Fast spends 61% fewer output tokens on the same work.

### 12 · GitHub is just another filesystem

Other harnesses bolt on gh_issue_view, gh_pr_view, gh_search — each with its own parameters the agent has to learn and you have to debug. We skipped that. read already handles paths; PRs are paths. One interface to teach the model, one surface to keep correct.

### 13 · Hindsight: memory the agent curates

The agent remembers your codebase between sessions. It writes facts mid-run with retain, pulls them back with recall, and compresses each session into a mental model that loads on the first turn of the next one. Project-scoped by default, so what it learns about this repo stays with this repo.

### 14 · ACP: editor-drivable agent

Run jeopi inside Zed and you get the same agent you drive from the terminal — reading the buffer you're actually looking at, writing through the editor's save path, spawning shells in the editor's terminal. Destructive tools pause for a permission prompt you can answer once and forget. No bridge, no plugin, no second brain to keep in sync.

### 15 · Inherits what your other tools already wrote

Every other agent ships an importer and expects you to convert. jeopi reads the eight formats already on disk in their native shape — Cursor MDC, Cline .clinerules, Codex AGENTS.md, Copilot applyTo, and the rest. No migration script, no YAML-to-TOML port, no "supported subset" footnotes. The config your team wrote last quarter still works tonight.

### 16 · jeopi commit: atomic splits, validated messages

jeopi reads the working tree through git_overview, git_file_diff, and git_hunk, then splits unrelated changes into atomic commits ordered by their dependencies. Cycles are rejected before anything is written. Source files score above tests, docs, and configs, so the headline commit is the one that matters. Lock files are excluded from analysis entirely.

### 17 · Read PRs. _Walk skills._ Pull JSON out of subagents.

Twelve internal schemes — `pr://`, `issue://`, `agent://`, `skill://`, `rule://`, and the rest — resolve transparently inside every FS-shaped tool the agent already calls. `read pr://1428` returns the same shape as `read src/foo.ts`. `search` walks a diff like a directory. `agent://<id>/findings.0.path` pulls a field out of a subagent's output by path.

![jeopi TUI reading pr://can1357/oh-my-pi/1063 and then /diff/1, showing hunk headers, added lines, and a [MODIFIED] (+12 -0) summary.](https://omp.sh/captures/pr.webp)

### 18 · Conflict resolution, made easy.

Each merge conflict becomes one URL. The agent writes `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves cleanly. Bulk form: `conflict://*`.

![jeopi TUI: ✓ Read src/session.ts (⚠ 1 conflict), then ✓ Write conflict://1 · 1 line with content @theirs, then a confirmation 'Resolved.'](https://omp.sh/clips/conflict-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/conflict.mp4)_

### 19 · Preview, then accept.

`ast_edit` returns a _(proposed)_ card with the replacement count. The change is staged. The agent calls `resolve` with a reason; the TUI turns it into an **Accept** card and the disk move happens — atomic, all or nothing.

![jeopi TUI: ✓ AST Edit: console.log($X) (proposed) 3 replacements · 1 file, then ✓ Accept: 3 replacements in 1 file (AST Edit), followed by 'Applied 3 replacements in src/auth.ts.'](https://omp.sh/clips/codemod-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/codemod.mp4)_

### 20 · Drives a _real browser_. _Or your Slack?_

Stealth's on by default, so pages see a normal user instead of a headless bot. The same API drives any Electron app in place — point it at Slack and the agent reads your DMs the way it reads the web.

![jeopi TUI driving the browser tool against DuckDuckGo](https://omp.sh/captures/browser.webp)

## Whatever the task needs, _it's already in the box_.

32 tools live in the same namespace as `read` and `bash`. Pin the active set with `--tools read,edit,bash,…` and the rest stay hidden but indexed — `search_tool_bm25` pulls them back in mid-session when `tools.discoveryMode` says so.

**Files & search**

- `read` — files, dirs, archives, SQLite, PDFs, notebooks, URLs, and internal `://` schemes through one path.
- `write` — create or overwrite a file, archive entry, or SQLite row.
- `edit` — hashline patches with content-hash anchors and stale-anchor recovery.
- `ast_edit` — structural rewrites previewed before apply, via ast-grep.
- `ast_grep` — structural code queries over 50+ tree-sitter grammars.
- `search` — regex over files, globs, and internal URLs.
- `find` — glob-based path lookup; reach for `search` when you need content matches.

**Runtime**

- `bash` — workspace shell, with optional PTY or background-job dispatch.
- `eval` — persistent Python and JavaScript cells with shared prelude and tool re-entry.
- `ssh` — one remote command against a configured host.

**Code intelligence**

- `lsp` — diagnostics, navigation, symbols, renames, code actions, raw requests.
- `debug` — drive a DAP session — breakpoints, stepping, threads, stack, variables.

**Coordination**

- `task` — fan out subagents in parallel, optionally workspace-isolated.
- `irc` — short prose between live agents in this process.
- `todo` — ordered mutations over the session todo list with phase tracking.
- `job` — wait on or cancel background jobs.
- `ask` — structured follow-up questions for interactive runs.

**Outside the box**

- `browser` — Puppeteer tabs over headless Chromium or CDP-attached apps.
- `web_search` — one query across configured providers, returning answer plus citations.
- `github` — GitHub CLI ops — repo, PR, issues, code search, Actions run-watch.
- `generate_image` — generate or edit raster images via Gemini, GPT, or xAI Grok image models.
- `inspect_image` — vision-model analysis of a local image file.
- `tts` — text-to-speech via xAI Grok Voice — five built-in voices, WAV or MP3.

**Memory & state**

- `checkpoint` — mark conversation state for a later collapse-and-report.
- `rewind` — prune exploratory context, keep a concise report.
- `retain` — queue durable facts into the active Hindsight bank.
- `recall` — search the Hindsight bank for raw memories.
- `reflect` — ask Hindsight to synthesize an answer over the bank.

**Misc**

- `resolve` — apply or discard a queued preview action.
- `search_tool_bm25` — BM25 over the hidden tool index; activates top matches mid-session.

Setting-gated, off by default: `github`, `inspect_image`, `tts`, `checkpoint`, `rewind`, `search_tool_bm25`, `retain`, `recall`, `reflect`. Flip them on once, scoped per project.

[Full reference →](https://omp.sh/docs/tools)

## Forty-plus providers, hundreds of models, _one /model away_.

Roles route work by intent. `default` for normal turns. `smol` for cheap subagent fan-out. `slow` for deep reasoning. `plan` for plan mode. `commit` for changelogs. Override at launch with `--smol`, `--slow`, or `--plan`; cycle through the configured models for the active role with `Ctrl+P`. Swap the active model mid-session with the `/model` slash command.

Auth tags below: `oauth` signs in with your provider account, `plan` routes through a coding-plan subscription, `local` runs against a local server with the key optional.

### Frontier APIs

Direct APIs and gateways. Mix providers per role.

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Antigravity `oauth` · xAI · Mistral · Groq · Cerebras · Fireworks · Together · Hugging Face · NVIDIA · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless · Perplexity `oauth`

### Coding plans

Subscription-routed. `/login` attaches the session.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal · Z.AI / GLM Coding Plan `plan` · Xiaomi MiMo · Qianfan · NanoGPT · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### Run it yourself

OpenAI-compatible `/v1/models`. Local instances skip the key.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### Four knobs that make routing useful

- **Custom providers** — Declare anything that speaks `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, or `google-vertex` in `~/.jeopi/agent/models.yml`.
- **Fallback chains** — Per-role chains under `retry.fallbackChains`. When the primary throws 429s or hits a quota wall, the next entry takes the rest of the turn — restored on cooldown.
- **Path-scoped models** — Scope `enabledModels` and `disabledProviders` entries to a `path:` prefix to pin a different model set on one repo without touching the global config. Scoped entries cover the path and everything under it.
- **Round-robin credentials** — Stack API keys per provider and the runtime rotates with session affinity and per-credential backoff. Useful when one key would burn its quota by lunch.

Full provider & routing reference at [omp.sh/docs/providers](https://omp.sh/docs/providers).

## Eighteen backends. _One tool the agent already knows_.

`web_search` is built in, not bolted on. `auto` walks an eighteen-provider chain; pin one by name if you already pay for it. Behind every hit, site-aware extraction turns GitHub, registries, arXiv, Stack Overflow, and docs into structured markdown — anchors and link targets survive.

### Search providers

Eighteen backends. Pin one, or let `auto` walk the chain in order.

| provider     | auth                   |
| ------------ | ---------------------- |
| `auto`       | chain                  |
| `perplexity` | `PERPLEXITY_API_KEY`   |
| `gemini`     | oauth                  |
| `anthropic`  | oauth                  |
| `codex`      | oauth                  |
| `xai`        | `XAI_API_KEY`          |
| `zai`        | `ZAI_API_KEY`          |
| `exa`        | `EXA_API_KEY` (or mcp) |
| `tinyfish`   | `TINYFISH_API_KEY`     |
| `jina`       | `JINA_API_KEY`         |
| `kagi`       | `KAGI_API_KEY`         |
| `tavily`     | `TAVILY_API_KEY`       |
| `firecrawl`  | `FIRECRAWL_API_KEY`    |
| `brave`      | `BRAVE_API_KEY`        |
| `kimi`       | `MOONSHOT_API_KEY`     |
| `parallel`   | `PARALLEL_API_KEY`     |
| `synthetic`  | `SYNTHETIC_API_KEY`    |
| `searxng`    | self-hosted            |
| `duckduckgo` | no key                 |

### Specialised handlers

The agent gets structured content, not stripped HTML.

- **Code hosts** — github, gitlab
- **Package registries** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Research sources** — arxiv, semantic scholar
- **Forums** — stack overflow, reddit, hn
- **Docs** — mdn, readthedocs, docs.rs

Pages convert to markdown with link structure intact. The agent can cite, follow, and quote without losing anchors.

### Security databases

Vuln lookups answer with vendor data, not blog summaries.

- **NVD** — national vulnerability database
- **OSV** — open source vuln feed
- **CISA KEV** — known exploited vulns

[`web_search` reference ↗](https://omp.sh/docs/tools#web_search)

## Roughly **~55,000** lines of Rust, doing the work other harnesses shell out for.

Four crates, one platform-tagged N-API addon. Search, shell, AST, highlight, PTY, image decode, BPE counting — all in-process on the libuv pool. No fork/exec on the hot path.

- Crates: `pi-natives`, `pi-shell`, `pi-ast`, `pi-iso`
- Platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`

The table below is a per-module breakdown that intentionally omits glue and tests.

| Module     | What it does                                                                         | Powered by                                |  ~LoC |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------- | ----: |
| shell      | Embedded bash · persistent sessions · timeout/abort · custom builtins                | brush-shell (vendored)                    | 3,700 |
| grep       | Regex search · parallel/sequential · glob & type filters · fuzzy find                | grep-regex · grep-searcher                | 1,900 |
| keys       | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup                | phf                                       | 1,490 |
| text       | ANSI-aware width · truncation · column slicing · SGR-preserving wrap                 | unicode-width · segmentation              | 1,450 |
| summary    | Tree-sitter structural source summaries with elision controls                        | tree-sitter · ast-grep-core               | 1,040 |
| ast        | ast-grep pattern matching and structural rewrites                                    | ast-grep-core                             | 1,000 |
| fs_cache   | Mtime-keyed file cache shared by read · grep · lsp                                   | in-tree                                   |   840 |
| highlight  | Syntax highlighting · 11 semantic categories · 30+ aliases                           | syntect                                   |   470 |
| pty        | Native PTY allocation for sudo · ssh interactive prompts                             | portable-pty                              |   455 |
| glob       | Discovery with glob · type filters · mtime sort · gitignore respect                  | ignore · globset                          |   410 |
| workspace  | Workspace walker with gitignore + AGENTS.md discovery in one pass                    | ignore                                    |   385 |
| appearance | Mode 2031 + native macOS dark/light via CoreFoundation FFI                           | core-foundation                           |   270 |
| power      | macOS power-assertion API for idle/system/display-sleep prevention                   | IOKit FFI                                 |   270 |
| task       | Blocking work on libuv thread pool · cancellation · timeout · profiling              | tokio · napi                              |   260 |
| fd         | Filesystem walker for find-tool replacement                                          | ignore                                    |   250 |
| iso        | Workspace isolation shim · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy | pi-iso (PAL)                              |   245 |
| prof       | Circular buffer profiler with folded-stack and SVG flamegraph output                 | inferno                                   |   240 |
| ps         | Cross-platform process-tree kill and descendant listing                              | libc · libproc · CreateToolhelp32Snapshot |   195 |
| clipboard  | Text copy and image read from system clipboard · no xclip/pbcopy                     | arboard                                   |    80 |
| tokens     | O200k / Cl100k BPE token counting · both tables embedded                             | tiktoken-rs                               |    65 |
| sixel      | Terminal image rendering · decode PNG · JPEG · WebP · GIF · resize · SIXEL encode    | icy_sixel · image                         |    55 |
| html       | HTML to Markdown with optional content cleaning                                      | html-to-markdown-rs                       |    50 |

## Four entry points: _interactive_, _one-shot_, RPC, and ACP.

Same engine, four wrappers. `jeopi` runs the TUI. `jeopi -p` answers a single prompt and exits. The Node SDK embeds the session in your process. `jeopi --mode rpc` and `jeopi acp` hand the wheel to another program over stdio.

### Interactive — when in doubt, the agent asks

The TUI is the default surface. Tool calls render as cards, edits preview before they land, and ambiguity routes through the `ask` tool — a structured option picker the agent can call mid-turn. The keyboard handles the rest.

The same prompt cards surface over ACP, so editors get the picker without writing one.

![jeopi TUI: the ask tool renders an option picker with three choices, a (Recommended) badge on the first, and 'up/down navigate · enter select · esc cancel' footer.](https://omp.sh/captures/ask.webp)

### SDK — embed in Node

`jeopi`

Node and TypeScript hosts pull the engine in directly. The package exposes `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage`; the session emits typed events you subscribe to.

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "jeopi-cli";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

### RPC — drive over stdio

`jeopi --mode rpc`

For non-Node embedders, or when you want process isolation. NDJSON commands in, response and event frames out. `--mode rpc-ui` adds tool cards, selectors, and dialogs as `extension_ui_request` frames the host must answer.

```
$ jeopi --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP — speak to editors

`jeopi acp`

The [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) over JSON-RPC. When the editor advertises capabilities, tool I/O routes through it and writes are gated by `session/request_permission`.

| jeopi tool                      | ACP route                           |
| ----------------------------- | ----------------------------------- |
| `bash`                        | `terminal/create + terminal/output` |
| `read`                        | `fs/read_text_file`                 |
| `write`                       | `fs/write_text_file`                |
| `edit, bash`                  | `session/request_permission`        |

Full reference: [omp.sh/docs/sdk](https://omp.sh/docs/sdk).

## A harness worth keeping is one you _don't_ outgrow.

jeopi's lineage: [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner) → rewritten as the coding-first surface [oh-my-pi](https://github.com/can1357/oh-my-pi) by [Can Bölük](https://github.com/can1357) → fused with [jeo-code](https://github.com/akillness/jeo-code)'s spec-first discipline as **jeopi**. Sessions, subagents, slash commands, extensions — all TypeScript, all MIT. Shape it from config, hook it from outside, or read the source when you need to.

### Primitives

An extension is a TypeScript module. Same tool API, same slash-command registry, same hotkey table, same TUI primitives the built-ins use. Nothing is reserved.

### Discovery

On first run jeopi inherits whatever is already on disk: rules, skills, and MCP servers from `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. No migration script.

### Extensibility

Ask jeopi to write the piece you're missing, then `/reload-plugins`. Keep it local, ship it in a `marketplace`, or publish it to npm.

## Philosophy

jeopi = oh-my-pi's engine × jeo-code's discipline.

From **oh-my-pi** (and Pi before it):

- Keep interactive terminal-first UX for real coding work
- Include practical built-ins (tools, sessions, branching, subagents, extensibility)
- Make advanced behavior configurable rather than hidden

From **jeo-code**:

- Interviews before plans; plans before execution; gates between every handoff
- Real gates, no theater — a critic verdict is persisted and *required*, not decorative
- Honest verification: the suite runs once as a global signal; per-criterion passes are never fabricated
- Failure is information: extract the lesson, change the next attempt, split stuck subgoals

---

## Development

### Getting started from source

Fresh clones need both workspace dependencies and the local Rust/N-API addon before the source CLI can start.

```sh
bun setup
bun dev
```

`bun setup` installs Bun workspaces and builds `jeopi-natives`. Re-run `bun run build:native` after changing Rust crates or `packages/natives`.

For a non-interactive smoke check:

```sh
bun dev -- --version
```

### Debug Command

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

---

## Monorepo Packages

| Package                                                   | Description                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| **[jeopi-collab-web](packages/collab-web)**           | Browser guest client, mock host, and local relay for collab live sessions  |
| **[jeopi-ai](packages/ai)**                        | Multi-provider LLM client with streaming and model/provider integration    |
| **[jeopi-catalog](packages/catalog)**              | Model catalog: bundled model database, provider descriptors, and identity  |
| **[jeopi-agent-core](packages/agent)**             | Agent runtime with tool calling and state management                       |
| **[jeopi-cli](packages/coding-agent)**    | Interactive coding agent CLI and SDK                                       |
| **[jeopi-tui](packages/tui)**                      | Terminal UI library with differential rendering                            |
| **[jeopi-natives](packages/natives)**              | N-API bindings for grep, shell, image, text, syntax highlighting, and more |
| **[jeopi-stats](packages/stats)**                 | Local observability dashboard for AI usage statistics                      |
| **[jeopi-utils](packages/utils)**                  | Shared utilities (logging, streams, dirs/env/process helpers)              |
| **[jeopi-wire](packages/wire)**                    | Shared collab live-session protocol types and relay constants              |
| **[jeopi-hashline](packages/hashline)**               | Line-anchored patch language and applier behind the `edit` tool            |
| **[jeopi-mnemopi](packages/mnemopi)**              | Local SQLite memory engine for Oh My Pi agents                             |
| **[jeopi-snapcompact](packages/snapcompact)**         | Bitmap-frame context compression package and SQuAD eval suite              |
| **[jeopi-swarm-extension](packages/swarm-extension)** | Swarm orchestration extension package                                      |

### Rust Crates

| Crate                                              | Description                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                | Core Rust native addon (N-API `cdylib`) used by `jeopi-natives`; aggregates the crates below |
| **[pi-shell](crates/pi-shell)**                    | Embedded shell / PTY / process management split out of `pi-natives` (wraps `brush-*`)               |
| **[pi-ast](crates/pi-ast)**                        | tree-sitter-based code summarizer and AST utilities (50+ language grammars)                         |
| **[pi-iso](crates/pi-iso)**                        | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy          |
| **[brush-core](crates/vendor/brush-core)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution        |
| **[brush-builtins](crates/vendor/brush-builtins)** | Vendored bash builtins (cd, echo, test, printf, read, export, etc.)                                 |

## Changelog

<!-- CHANGELOG:START (auto-generated from packages/coding-agent/CHANGELOG.md — run `bun run gen:readme-changelog`) -->
Latest 5 released entries:
- **[16.2.24]** (2026-07-03) — Installed plugins' tools/hooks/commands/extensions no longer load automatically. Each plugin now needs a one-time trust grant (interactive Yes/No prompt on first load, or `PI_TRUST_ALL_PLUGINS=1` for…
- **[16.2.23]** (2026-07-03) — Added the animated jeopi character mascot (hooded doll + jeo-code crayfish) to the README, then removed the older static `hero.gif` wordmark banner above it so the animated mascot is the sole header…
- **[16.2.21]** (2026-07-02) — Fixed long-window quota exhaustion (including Cloud Code Assist daily quota) being shown as a generic `Retry failed after 1 attempts` error. When the provider retry window exceeds `retry.maxDelayMs`,…
- **[16.2.20]** (2026-07-02) — Made `jeopi update` failures diagnosable: a registry 404 on the update check now names the phantom package and prints the manual `bun install -g jeopi-cli` recovery (globals built before the `jeopi`…
- **[16.2.19]** (2026-07-02) — Fixed the startup update notice never appearing: the version check queried the nonexistent `jeopi` npm package (renamed CLI ships as `jeopi-cli`), so the 404 silently suppressed the "New version X is…

See [packages/coding-agent/CHANGELOG.md](packages/coding-agent/CHANGELOG.md) for the full history.
<!-- CHANGELOG:END -->

## Contributing

Issues and PRs are open at [akillness/jeopi](https://github.com/akillness/jeopi). Keep diffs small, name the acceptance criterion your change serves, and bring the verification evidence — the same contract the agent itself is held to. Upstream engine work belongs in [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi); jeopi tracks it.

---

## License

MIT. See [LICENSE](LICENSE).

© 2025 Mario Zechner  
© 2025-2026 Can Bölük  
© 2026 jeopi contributors

_Encode intention. Decode software._

- [GitHub](https://github.com/akillness/jeopi)
- [Changelog](packages/coding-agent/CHANGELOG.md)
- [jeo-code](https://github.com/akillness/jeo-code) — the philosophy donor
- [oh-my-pi](https://github.com/can1357/oh-my-pi) — the engine upstream
- [MIT](LICENSE)
