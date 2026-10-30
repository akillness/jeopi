import type { AgentSessionEvent } from "../session/agent-session";
import type { MessengerActivityReporter } from "./types";

/**
 * Derive one-line progress from session events: the model's declared tool intent (falling back to the
 * tool name) and long-running lifecycle notices. Raw tool arguments, results and errors never surface.
 */
export function createMessengerActivityTracker(report: MessengerActivityReporter): (event: AgentSessionEvent) => void {
	let step = 0;
	return event => {
		switch (event.type) {
			case "tool_execution_start":
				step++;
				report(`Step ${step} · ${event.intent ?? `Using ${event.toolName}`}`);
				return;
			case "auto_compaction_start":
				report("Compacting context");
				return;
			case "auto_retry_start":
				report(`Retrying after a provider error (${event.attempt}/${event.maxAttempts})`);
				return;
		}
	};
}
