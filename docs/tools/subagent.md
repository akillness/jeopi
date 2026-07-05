# subagent

> List, inspect, await, cancel, pause, resume, and steer background `task` subagents.

## Source
- Entry: `packages/coding-agent/src/tools/subagent.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/subagent.md`
- Key collaborators:
  - `packages/coding-agent/src/async/job-manager.ts` — `AsyncJobManager`, source of truth for a spawn's *original* run outcome (`type: "task"` jobs).
  - `packages/coding-agent/src/registry/agent-registry.ts` — `AgentRegistry`, source of truth for whether the underlying `AgentSession` is currently working right now (`running`) and whether it is still resident (`idle` / `parked` / `aborted`). Authoritative beyond the first run, since a `resume`d follow-up runs a real turn on the same session without registering a new async job.
  - `packages/coding-agent/src/session/agent-session.ts` — `AgentSession.abort(...)` is the fallback `cancel` path for a subagent that is live from a `resume`, not from its original `task` job.
  - `packages/coding-agent/src/irc/bus.ts` — `IrcBus.send(...)`, the single delivery path for `steer` / `resume` / `pause`. Always routes through `AgentRegistry.global()`.
  - `packages/coding-agent/src/task/index.ts` — registers the `type: "task"` jobs this tool observes and controls.
  - `packages/coding-agent/src/tools/job.ts` — the generic (bash + task) job-control tool; `subagent` is scoped to `task` jobs only and adds registry-aware lifecycle actions.
  - `packages/coding-agent/src/tools/irc.ts` — `isIrcEnabled(...)` is reused verbatim as `isSubagentToolEnabled` (same peer-availability gate).

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"list" \| "inspect" \| "await" \| "cancel" \| "pause" \| "resume" \| "steer"` | Yes | Control operation to perform. |
| `id` | `string` | For `steer`/`resume`/`pause` | Single target subagent id. |
| `ids` | `string[]` | No | Target subagent ids for `inspect`/`await`/`cancel` (and `cancel` requires at least one of `id`/`ids`). Omit to target every running spawn of the calling agent. |
| `limit` | `number` | No | `list`: maximum subagents to return, clamped to `1..MAX_LIST_LIMIT` (default `DEFAULT_LIST_LIMIT = 10`, max `MAX_LIST_LIMIT = 50`). `inspect`/`await` with no `ids` are always capped at `MAX_LIST_LIMIT` regardless of this field; `inspect`/`await`/`cancel` with explicit `ids` are never truncated. |
| `verbosity` | `"receipt" \| "preview" \| "full"` | No | Output width for `resultText`/`errorText`: `receipt` (default) = `RECEIPT_PREVIEW_CHARS = 280`, `preview` = `PREVIEW_CHARS = 2_000`, `full` = `FULL_PREVIEW_CHARS = 12_000`. `full` throws `ToolError` when `action === "list"`, or when neither `id` nor `ids` is present. |
| `message` | `string` | For `steer`; conditionally for `resume` | Message body to deliver. |
| `pause` | `boolean` | No | `steer` only: also request a pause after delivering the message. |
| `timeout_ms` | `number` | No | `await` only: how long to wait before giving up, clamped to `0..MAX_AWAIT_TIMEOUT_MS` (`60 * 60 * 1000`). `0` waits indefinitely. Default `DEFAULT_AWAIT_TIMEOUT_MS = 30_000`. Field name matches the canonical gajae-code `subagent` tool (snake_case), unlike the rest of this tool's camelCase-only source. |

## Outputs
The tool returns one text block plus `details: SubagentToolDetails`.

- `details.action`: the action that was executed.
- `details.subagents`: array of `SubagentSnapshot`:
  - `id: string`
  - `status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "not_found"`
  - `resumable: boolean` — true when the `AgentRegistry` ref is `idle` or `parked` (session resident, addressable via a follow-up). Independent of `status`.
  - `label: string`, `durationMs: number`
  - optional `displayName`, `activity` (always included when known; not verbosity-gated)
  - optional `resultText`, `errorText` — always truncated to the resolved `verbosity` width (280 / 2 000 / 12 000 chars), never fully omitted
- `details.truncated` (only when `limit` hid results): count of hidden subagents.
- `details.cancelled` (only for `cancel`): `{ id, status }[]` where status is `"cancelled" | "not_found" | "already_completed"`.
- `details.receipt` (only for `steer`/`resume`/`pause`): `{ to, outcome: "injected" | "woken" | "revived" | "failed", error? }`, the raw `IrcDeliveryReceipt` from `IrcBus.send(...)`.

## Flow
1. `SubagentTool.createIf(session)` requires `isSubagentToolEnabled(...)` (alias of `isIrcEnabled`) plus a live `session.agentRegistry` and `session.getAgentId`. Construction fails closed (`null`) otherwise, exactly like `IrcTool.createIf`.
2. `execute(...)` resolves `registry`/`senderId` from the session; if either is missing it returns a plain-text unavailable error (not thrown).
3. Every job lookup goes through `#visibleJob(...)`, which filters to `job.type === "task"` and `job.ownerId === callingAgentId` — jobs owned by another agent are invisible, matching `job`'s cross-agent isolation contract.
4. `#status(job, ref, id)` computes the reported status, in priority order:
   - no `job` and no `ref` → `not_found`.
   - `job.queued` → `queued`.
   - `ref.status === "running"` → `running` (this is checked ahead of the paused bookkeeping — a `pause` request is advisory and does not itself flip the registry, so a still-running ref just means the pause has not taken effect yet).
   - `id` present in the tool's session-local `#pausedIds` set → `paused`.
   - `job` present → `job.status` (the original run's terminal outcome: `completed`/`failed`/`cancelled`).
   - otherwise (a `ref` with no tracked job — e.g. its job record was evicted after `async.pollWaitDuration`'s retention window) → `cancelled` if `ref.status === "aborted"`, else `completed`.
5. `list` snapshots every `type: "task"` job owned by the caller (`manager.getAllJobs({ ownerId })`), merged with the matching `AgentRegistry` ref, then applies `limit`/`verbosity`.
6. `inspect` resolves `id`/`ids` via `#visibleJob(...)` (dropping unknown/foreign ids); omitting both inspects every currently `running` owned job. Applies the same `limit`/`verbosity`.
7. `await` resolves the same target set as `inspect`, but only waits on jobs still `status === "running"` (the underlying `AsyncJob`, not the registry — `await` is specifically about a spawn's original run settling). It races each watched `job.promise` against a `timeoutMs` timer and the tool-call abort signal — settling on the first watched job to finish, not all of them (mirrors `job`'s poll semantics). `manager.watchJobs(...)`/`unwatchJobs(...)` bracket the wait; `onUpdate` streams a snapshot every 500 ms.
8. `cancel` requires `id`/`ids` (throws `ToolError` otherwise) and, per id: if the original `task` job is still `running`, calls `manager.cancel(id, { ownerId })`; otherwise, if the registry ref is `running` (a live turn started by a later `resume`/`steer`, with no job to cancel), calls `ref.session.abort({ reason: "Cancelled via subagent tool" })` directly; otherwise reports `already_completed`. Either path also clears `#pausedIds` for that id.
9. `steer` requires `id` + `message`, rejects self-targeting, and calls `IrcBus.global().send({ from, to: id, body })`. When `pause: true`, the delivered body gets a `[pause requested] …` directive appended and, on non-`failed` delivery, `id` is added to `#pausedIds`; a plain `steer` without `pause` clears `#pausedIds` for `id` instead (new work supersedes an outstanding pause). Delivery reuses `IrcBus`'s existing routing: steering injection for a `running` target, a real wake turn for `idle`, revival for `parked`.
10. `resume` requires `id`, rejects self-targeting. A registry `running` target is a no-op (nothing to resume). A `queued` job is a no-op (already waiting for a spawn slot). A `paused` target (`id` present in `#pausedIds`) resumes with `message` if given, otherwise a default `DEFAULT_RESUME_MESSAGE = "Continue from where you left off."` body — GJC parity: a paused subagent stopped because the caller asked it to, so it has known intent to continue even without new text. Any other target (`completed`/`failed`/`cancelled` on its own, not paused) still requires `message` (throws `ToolError` otherwise, since the underlying `AgentSession` has no known pending work to continue on its own). On non-`failed` delivery, `#pausedIds` is cleared for `id`.
11. `pause` requires `id`, rejects self-targeting. A target whose registry ref is not `running` is a no-op. A running target gets a `[pause requested] …` directive delivered via `IrcBus.send(...)` — this is advisory: it asks the agent to stop at its next safe boundary, it does not forcibly interrupt an in-flight tool call. On non-`failed` delivery, `id` is added to `#pausedIds`.

## Modes / Variants
- Snapshot everything: `{ action: "list" }`; capped/cheap: `{ action: "list", limit: 10, verbosity: "receipt" }`.
- Inspect specific spawns: `{ action: "inspect", ids: [...] }`; inspect all running spawns: `{ action: "inspect" }`.
- Block for the next completion: `{ action: "await" }` (all running) or `{ action: "await", ids: [...] }`.
- Stop hung/unneeded work: `{ action: "cancel", ids: [...] }` — works on a spawn's first run or a live resumed follow-up.
- Interject content: `{ action: "steer", id, message }`; interject and ask it to stop: `{ action: "steer", id, message, pause: true }`.
- Ask a running agent to wrap up without new content: `{ action: "pause", id }`.
- Continue a finished-but-resident agent: `{ action: "resume", id, message }`.

## Side Effects
- Filesystem
  - None directly. Delivered messages may cause the recipient agent to read/write files as part of handling them.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Reads `session.asyncJobManager` and `session.agentRegistry` state; does not construct or own either.
  - `cancel` mutates job state via `manager.cancel(...)` (aborts the job's `AbortController`), or calls `AgentSession.abort(...)` directly for a live resumed turn.
  - `steer`/`resume`/`pause` mutate the target's mailbox/session state via `IrcBus.send(...)` — the same side effects as an `irc` `send`, including reviving a `parked` agent through `AgentLifecycleManager`.
  - `#pausedIds` is a private `Set<string>` owned by the `SubagentTool` instance (one per session) — it does not persist across sessions or process restarts.
- User-visible prompts / interactive UI
  - `await` emits periodic `onUpdate` snapshots every 500 ms while waiting.
  - `steer`/`resume`/`pause` deliveries relay onto the main session UI via `IrcBus`'s existing relay path (`IrcBus.global()` skips the relay only when the main agent is sender or recipient).
- Background work / cancellation
  - `await` uses a timeout plus optional tool-call abort signal; it never cancels the watched jobs itself.

## Limits & Caps
- No dedicated settings namespace; availability is gated by `isSubagentToolEnabled` (= `isIrcEnabled`), the same peer-availability check used by `irc` — see `packages/coding-agent/src/tools/irc.ts`.
- `await` default timeout: `DEFAULT_AWAIT_TIMEOUT_MS = 30_000` in `packages/coding-agent/src/tools/subagent.ts`, clamped to `0..MAX_AWAIT_TIMEOUT_MS` (`3_600_000`); `timeout_ms: 0` waits indefinitely.
- `verbosity` default: `"receipt"`, truncating `resultText`/`errorText` to `RECEIPT_PREVIEW_CHARS = 280` characters (`preview` = `2_000`, `full` = `12_000`).
- `list` default/max result count: `DEFAULT_LIST_LIMIT = 10` / `MAX_LIST_LIMIT = 50`; `inspect`/`await` with no explicit `ids` are also capped at `MAX_LIST_LIMIT`.
- `verbosity: "full"` is rejected (`ToolError`) for `action: "list"`, and for any other action called without an explicit `id`/`ids`.
- `subagent` is listed in `DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS` (`packages/coding-agent/src/config/settings-schema.ts`) alongside `job`/`irc`, since `list`/`inspect`/`await` naturally repeat across turns.
- Underlying job concurrency, retention, and delivery-retry limits are the same `AsyncJobManager` limits documented in `docs/tools/job.md`.

## Errors
- `id`/`ids` missing for `cancel` throws `ToolError`.
- `verbosity: "full"` combined with `action: "list"`, or with any other action called without `id`/`ids`, throws `ToolError` before dispatch.
- `id` missing for `steer`/`resume`/`pause` throws `ToolError`; `message` missing for `steer` throws `ToolError`.
- Targeting yourself (`id === callingAgentId`) throws `ToolError` for `steer`/`resume`/`pause`.
- `resume` on a target that is not `running`/`queued`/`paused` and has no `message` throws `ToolError` — there is no implicit "just continue" for an agent that finished entirely on its own. A `paused` target is exempt (see Flow #10).
- A failed `IrcBus.send(...)` (unknown/terminated/advisor target, disposed session) is not thrown — it is reported as `isError: true` with `details.receipt.outcome === "failed"` and the underlying error text, matching `irc`'s send-failure contract.
- Async execution disabled (no `session.asyncJobManager`) is reported as plain text for `await`, not thrown. `cancel` still works for a live resumed session even without a job manager (it can fall back to `AgentSession.abort(...)`).

## Notes
- jeopi has no literal "frozen mid-run" agent state: a `task` job resolves the moment its run stops, whether that is a natural finish or a `pause` request. `pause` therefore does not freeze anything — it asks the agent to wrap up sooner, and the session then sits `idle`. The `paused` status (backed by the tool's local `#pausedIds` bookkeeping) exists purely so a caller can tell "it stopped because I asked it to" apart from "it finished on its own" — both are `resumable: true` and `resume` treats them identically.
- `#pausedIds` is intentionally *not* self-clearing on a registry `running` observation — a `pause` request does not itself change the registry, so seeing `running` right after calling `pause` (before the agent has actually reached a safe boundary) must not be mistaken for "the pause was ignored." Only an explicit, successful `resume`/`steer` clears it.
- Once a subagent has been `resume`d at least once, its live "is it working right now" signal comes entirely from `AgentRegistry`, not from the original `AsyncJob` — the job record is permanently frozen at the first run's outcome. `cancel` accounts for this by falling back to `AgentSession.abort(...)` when there is no cancellable job but the registry reports `running`.
- Every operation is scoped to the calling agent's own spawns (`ownerId`) — cross-agent inspection/control is impossible by design, matching `job` and `irc`.
- No custom TUI renderer is registered for `subagent` in `packages/coding-agent/src/tools/renderers.ts`; it renders through the generic fallback path used by tools such as `checkpoint`/`rewind`.
