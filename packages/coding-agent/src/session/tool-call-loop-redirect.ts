import type { CyclicalToolCallDetection, RepeatedToolCallDetection } from "jeopi-ai/utils/tool-call-loop-guard";
import { prompt } from "jeopi-utils";
import toolCallCycleRedirectTemplate from "../prompts/system/tool-call-cycle-redirect.md" with { type: "text" };
import toolCallLoopRedirectTemplate from "../prompts/system/tool-call-loop-redirect.md" with { type: "text" };

/** Custom message type stamped on cross-turn repeated tool-call loop redirects. */
export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

/** Custom message type stamped on cross-turn cyclical tool-call loop redirects. */
export const TOOL_CALL_CYCLE_REDIRECT_TYPE = "tool-call-cycle-redirect";

/** Render the corrective `<system-interrupt>` redirect for a repeated tool-call loop. */
export function renderToolCallLoopRedirect(detection: RepeatedToolCallDetection): string {
	return prompt.render(toolCallLoopRedirectTemplate, {
		tool_name: detection.toolName,
		count: detection.count,
		arguments_summary: detection.argumentsSummary,
		result_summary: detection.resultSummary || "(no text result)",
	});
}

/** Render the corrective `<system-interrupt>` redirect for a cyclical tool-call loop. */
export function renderCyclicalToolCallRedirect(detection: CyclicalToolCallDetection): string {
	return prompt.render(toolCallCycleRedirectTemplate, {
		tool_names: detection.toolNames.join(" and "),
		window_size: detection.windowSize,
	});
}

/** Structured details attached to a repeated tool-call redirect message. */
export function buildToolCallLoopRedirectDetails(detection: RepeatedToolCallDetection): Record<string, unknown> {
	return {
		toolName: detection.toolName,
		count: detection.count,
		argumentsSummary: detection.argumentsSummary,
		resultSummary: detection.resultSummary,
	};
}
