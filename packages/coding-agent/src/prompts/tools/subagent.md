Controls the background subagents you spawned with `task`. Results deliver themselves automatically the moment a subagent finishes — you never need to poll. Only reach for this tool to inspect, wait on, cancel, or steer a spawn's lifecycle.

# Actions

- **`list`**: Snapshot subagents you've spawned (any status), no waiting. Returns 10 most recent by default; pass `limit` (max 50) to see more.
- **`inspect`**: Richer detail (result/error preview, live activity) for specific `id`/`ids`; omit both to inspect every currently running spawn (capped at 50).
- **`await`**: Block until one watched subagent finishes, the wait window elapses, or an IRC/steering message interrupts the wait — NOT until every subagent finishes; re-issue to keep waiting. Omit `id`/`ids` to watch every running spawn.
- **`cancel`**: Stop subagents that have hung, stalled, or are no longer needed. Requires `id`/`ids`. Works whether the subagent is still on its first run or was later resumed.
- **`steer`**: Send a message to a specific subagent (`id` + `message`). Delivered as steering to a running subagent, or wakes an idle/parked one with a real turn. Add `pause: true` to also ask it to stop at its next safe boundary after handling the message.
- **`pause`**: Ask a running subagent to stop at its next safe boundary and go idle. Non-running subagents are a no-op — nothing to pause.
- **`resume`**: Wake a subagent with a follow-up. A `running` or `queued` subagent is a no-op (nothing to resume). Any other subagent needs `message` — it has no pending work to continue on its own, but its session and full context are still alive, so a follow-up message continues it exactly where it left off.

# Filtering Output

- `limit`: caps `list` at 10 by default, 50 maximum. Response reports how many were hidden.
- `verbosity`: `"receipt"` (default) returns a <=280-char result/error preview, `"preview"` <=2000 chars, `"full"` <=12000 chars. `full` cannot be used with `list`, and requires explicit `id`/`ids` on every other action — it is for deliberately inlining one or a few subagents' full output, not for browsing.
- `timeout_ms`: `await` only, how long to wait before giving up (0 waits indefinitely).

# Status and Resumability

Statuses: `queued`, `running`, `paused`, `completed`, `failed`, `cancelled`, `not_found`.

- `paused` means you asked it to stop (via `pause`, or `steer ... pause: true`) and it hasn't been given new work since. jeopi has no literal "frozen mid-run" state — the subagent's run actually finishes when it stops, but you still see `paused` instead of `completed` so you know *why* it stopped.
- `resumable` (on every snapshot) is the independent, always-accurate signal for "can I still talk to this one" — true whenever its session is still resident (idle or parked), whether it finished on its own or via `pause`. `resume` treats both cases identically.
- Once you `resume`/`steer` a subagent, its live status tracks the *current* turn, not just its original run — `list`/`inspect` stay accurate across multiple rounds of follow-ups.

# Scope

Every operation is scoped to subagents you spawned. You cannot inspect or control a sibling's or your parent's spawns — message them via `irc` instead.
