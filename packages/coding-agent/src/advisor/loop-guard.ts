import type { Agent, AgentMessage, AgentTurnEndContext } from "jeopi-agent-core";
import { ToolCallLoopGuard, type ToolCallLoopGuardOptions } from "jeopi-ai/utils/tool-call-loop-guard";
import { logger } from "jeopi-utils";
import type { CustomMessage } from "../session/messages";
import {
	buildToolCallLoopRedirectDetails,
	renderCyclicalToolCallRedirect,
	renderToolCallLoopRedirect,
	TOOL_CALL_CYCLE_REDIRECT_TYPE,
	TOOL_CALL_LOOP_REDIRECT_TYPE,
} from "../session/tool-call-loop-redirect";

export interface AdvisorLoopGuardOptions {
	/** Advisor display name (included in warning logs). */
	advisorName: string;
	/** Read current loop-guard settings dynamically (supports live config changes). */
	getConfig: () => {
		enabled: boolean;
		threshold: number;
		maxRedirectsBeforeStop?: number;
		exemptTools?: readonly string[];
	};
	/** Called when the advisor hits a hard `stalled_tool_call` escalation. */
	onStalled?: () => void;
}

/**
 * Cross-turn tool-call loop guard for an advisor `Agent`.
 *
 * Advisors run their own `Agent` loop with read/grep/glob/advise tools and
 * previously had no cross-turn loop protection (a stuck advisor could hammer
 * the same failing read/grep call for the entire turn budget). This guard
 * hooks into `Agent.setOnTurnEnd`, injects the same `<system-interrupt>`
 * redirect used by the primary session, and stops the advisor cleanly on
 * `stalled_tool_call` escalation.
 */
export class AdvisorLoopGuard {
	#guard: ToolCallLoopGuard | undefined;
	#lastConfigKey = "";

	constructor(private readonly options: AdvisorLoopGuardOptions) {}

	/** Reset loop state when an advisor starts a fresh review or resets history. */
	reset(): void {
		this.#guard?.reset();
	}

	/** Bind this guard to an advisor `Agent` via `setOnTurnEnd`. */
	attach(agent: Agent): void {
		agent.setOnTurnEnd((messages, _signal, context) => {
			return this.onTurnEnd(messages, context);
		});
	}

	onTurnEnd(messages: AgentMessage[], context?: AgentTurnEndContext): "stop" | undefined {
		if (context?.message.role !== "assistant") return undefined;
		const cfg = this.options.getConfig();
		if (!cfg.enabled) {
			this.#guard = undefined;
			this.#lastConfigKey = "";
			return undefined;
		}
		const threshold = Math.max(2, Math.floor(cfg.threshold));
		const maxRedirectsBeforeStop = cfg.maxRedirectsBeforeStop ?? 2;
		const exemptTools = cfg.exemptTools ?? ["advise"];
		const configKey = `${threshold}:${maxRedirectsBeforeStop}:${exemptTools.join(",")}`;
		if (!this.#guard || this.#lastConfigKey !== configKey) {
			const opts: ToolCallLoopGuardOptions = {
				threshold,
				maxRedirectsBeforeStop,
				exemptTools,
			};
			this.#guard = new ToolCallLoopGuard(opts);
			this.#lastConfigKey = configKey;
		}

		const detection = this.#guard.recordTurn({
			message: context.message,
			toolResults: context.toolResults,
		});
		if (!detection) return undefined;

		if (detection.kind === "stalled_tool_call") {
			logger.warn("advisor tool-call loop stalled; stopping advisor turn", {
				advisor: this.options.advisorName,
				reason: detection.reason,
				toolName: detection.toolName,
			});
			this.#guard.reset();
			this.options.onStalled?.();
			return "stop";
		}

		if (detection.kind === "cyclical_tool_calls") {
			logger.warn("advisor cross-turn alternating tool-call cycle detected", {
				advisor: this.options.advisorName,
				toolNames: detection.toolNames,
				windowSize: detection.windowSize,
			});
			const redirect: CustomMessage = {
				role: "custom",
				customType: TOOL_CALL_CYCLE_REDIRECT_TYPE,
				content: renderCyclicalToolCallRedirect(detection),
				display: false,
				details: { toolNames: detection.toolNames, windowSize: detection.windowSize },
				timestamp: Date.now(),
			};
			messages.push(redirect);
			return undefined;
		}

		logger.warn("advisor cross-turn tool-call loop detected", {
			advisor: this.options.advisorName,
			toolName: detection.toolName,
			count: detection.count,
		});
		const redirect: CustomMessage = {
			role: "custom",
			customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
			content: renderToolCallLoopRedirect(detection),
			display: false,
			details: buildToolCallLoopRedirectDetails(detection),
			timestamp: Date.now(),
		};
		messages.push(redirect);
		return undefined;
	}
}
