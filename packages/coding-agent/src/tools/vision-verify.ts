import { type } from "arktype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "jeopi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "jeopi-agent-core";
import { type Api, completeSimple, type ImageContent, type Model, type ToolExample } from "jeopi-ai";
import { prompt } from "jeopi-utils";
import { extractTextContent } from "../commit/utils";

import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import visionVerifyDescription from "../prompts/tools/vision-verify.md" with { type: "text" };
import visionVerifySystemPromptTemplate from "../prompts/tools/vision-verify-system.md" with { type: "text" };
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageAttachmentInput,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const visionVerifySchema = type({
	goal: type("string").describe("what the UI/artifact should look like or achieve"),
	screenshot: type("string").describe(
		"path to the current screenshot, or an attachment reference like inspect_image accepts",
	),
	"baseline?": type("string").describe(
		"optional path to a PRIOR screenshot of the same view, for regression comparison",
	),
	"+": "reject",
});

export type VisionVerifyParams = typeof visionVerifySchema.infer;

interface ImageAttachmentReference {
	index: number;
}

const IMAGE_ATTACHMENT_REFERENCE_REGEX =
	/^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;

function parseImageAttachmentReference(path: string): ImageAttachmentReference | null {
	const match = IMAGE_ATTACHMENT_REFERENCE_REGEX.exec(path);
	if (!match) return null;
	const rawIndex = match[1] ?? match[2];
	if (!rawIndex) return null;
	return { index: Number(rawIndex) };
}

function formatAvailableImageAttachments(attachments: readonly { label: string; uri: string }[]): string {
	if (attachments.length === 0) return "none";
	return attachments.map(attachment => `${attachment.label} -> ${attachment.uri}`).join(", ");
}

async function loadAttachmentReferenceInput(options: {
	path: string;
	reference: ImageAttachmentReference;
	attachments: readonly { label: string; uri: string; image: ImageContent }[];
	autoResize: boolean;
	excludeWebP: boolean | undefined;
}): Promise<LoadedImageInput | null> {
	const attachment = options.attachments[options.reference.index - 1];
	if (!attachment) {
		const available = formatAvailableImageAttachments(options.attachments);
		if (options.attachments.length === 0) {
			throw new ToolError(
				`No image attachments are available in this turn. path="${options.path}" must be a readable file path or attachment URI.`,
			);
		}
		throw new ToolError(
			`Could not resolve image attachment '${options.path}'. Available image attachments: ${available}. Pass an attachment URI or a readable filesystem path.`,
		);
	}
	return loadImageAttachmentInput({
		image: attachment.image,
		label: attachment.label,
		uri: attachment.uri,
		autoResize: options.autoResize,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}

/** Resolve a `screenshot`/`baseline` param to a loaded image, honoring attachment references the same way `inspect_image` does. */
async function resolveVisionVerifyImageInput(options: {
	path: string;
	session: ToolSession;
	autoResize: boolean;
	excludeWebP: boolean | undefined;
}): Promise<LoadedImageInput | null> {
	const attachmentReference = parseImageAttachmentReference(options.path);
	if (attachmentReference) {
		return loadAttachmentReferenceInput({
			path: options.path,
			reference: attachmentReference,
			attachments: options.session.getImageAttachments?.() ?? [],
			autoResize: options.autoResize,
			excludeWebP: options.excludeWebP,
		});
	}
	return loadImageInput({
		path: options.path,
		cwd: options.session.cwd,
		autoResize: options.autoResize,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}

async function loadVisionVerifyImage(options: {
	path: string;
	label: string;
	session: ToolSession;
	autoResize: boolean;
	excludeWebP: boolean | undefined;
}): Promise<LoadedImageInput> {
	let imageInput: LoadedImageInput | null;
	try {
		imageInput = await resolveVisionVerifyImageInput(options);
	} catch (error) {
		if (error instanceof ImageInputTooLargeError) {
			throw new ToolError(error.message);
		}
		throw error;
	}
	if (!imageInput) {
		throw new ToolError(
			`vision_verify only supports PNG, JPEG, GIF, and WEBP files detected by file content (${options.label}="${options.path}").`,
		);
	}
	return imageInput;
}

/** Structured verdict the model is instructed to return. */
interface VisionVerifyVerdict {
	matches: boolean;
	summary: string;
	gaps: string[];
}

function isVisionVerifyVerdict(value: unknown): value is VisionVerifyVerdict {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.matches === "boolean" &&
		typeof candidate.summary === "string" &&
		Array.isArray(candidate.gaps) &&
		candidate.gaps.every(gap => typeof gap === "string")
	);
}

function parseVisionVerifyVerdict(text: string): VisionVerifyVerdict {
	let parsed: unknown;
	try {
		const trimmed = text.trim();
		const jsonText = trimmed.startsWith("{") ? trimmed : (trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed);
		parsed = JSON.parse(jsonText);
	} catch {
		throw new ToolError(`vision_verify model response was not valid JSON. Raw response: ${text}`, {
			rawResponse: text,
		});
	}
	if (!isVisionVerifyVerdict(parsed)) {
		throw new ToolError(
			`vision_verify model response did not match the expected {matches, summary, gaps} shape. Raw response: ${text}`,
			{ rawResponse: text },
		);
	}
	return parsed;
}

function renderVisionVerifySummary(verdict: VisionVerifyVerdict): string {
	const lines = [verdict.matches ? "Matches: yes" : "Matches: no", verdict.summary];
	if (verdict.gaps.length > 0) {
		lines.push("Gaps:");
		for (const gap of verdict.gaps) lines.push(`- ${gap}`);
	}
	return lines.join("\n");
}

export interface VisionVerifyToolDetails {
	model: string;
	matches: boolean;
	gaps: string[];
}

export class VisionVerifyTool implements AgentTool<typeof visionVerifySchema, VisionVerifyToolDetails> {
	readonly name = "vision_verify";
	readonly approval = "read" as const;
	readonly label = "VisionVerify";
	readonly loadMode = "discoverable";
	readonly summary = "Check a screenshot/artifact against a stated goal with a vision model";
	readonly description: string;
	readonly parameters = visionVerifySchema;
	readonly strict = false;

	readonly examples: readonly ToolExample<typeof visionVerifySchema.infer>[] = [
		{
			caption: "Verify a UI change matches the task goal",
			call: {
				goal: "Settings page shows a 'Save' button that is disabled until a field changes",
				screenshot: "screenshots/settings-after.png",
			},
		},
		{
			caption: "Regression check against a prior known-good state",
			call: {
				goal: "Header layout unchanged aside from the new notification icon",
				screenshot: "screenshots/header-after.png",
				baseline: "screenshots/header-before.png",
			},
		},
	];

	constructor(
		private readonly session: ToolSession,
		private readonly completeImageRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(visionVerifyDescription);
	}

	async execute(
		_toolCallId: string,
		params: VisionVerifyParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<VisionVerifyToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<VisionVerifyToolDetails>> {
		if (this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"Image submission is disabled by settings (images.blockImages=true). Disable it to use vision_verify.",
			);
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for vision_verify.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for vision_verify.");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		const model =
			resolvePattern("pi/vision") ??
			resolvePattern("pi/default") ??
			resolvePattern(activeModelPattern) ??
			availableModels[0];
		if (!model) {
			throw new ToolError("Unable to resolve a model for vision_verify.");
		}

		if (!model.input.includes("image")) {
			throw new ToolError(
				`Resolved model ${model.provider}/${model.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
			);
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
			);
		}

		const autoResize = this.session.settings.get("images.autoResize");
		const excludeWebP = webpExclusionForModel(model);

		const currentImage = await loadVisionVerifyImage({
			path: params.screenshot,
			label: "screenshot",
			session: this.session,
			autoResize,
			excludeWebP,
		});
		const baselineImage = params.baseline
			? await loadVisionVerifyImage({
					path: params.baseline,
					label: "baseline",
					session: this.session,
					autoResize,
					excludeWebP,
				})
			: undefined;

		const userContent: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
		if (baselineImage) {
			userContent.push({ type: "text", text: "Baseline (prior):" });
			userContent.push({ type: "image", data: baselineImage.data, mimeType: baselineImage.mimeType });
			userContent.push({ type: "text", text: "Current:" });
		}
		userContent.push({ type: "image", data: currentImage.data, mimeType: currentImage.mimeType });
		userContent.push({ type: "text", text: `Goal: ${params.goal}` });

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [prompt.render(visionVerifySystemPromptTemplate)],
				messages: [
					{
						role: "user",
						content: userContent,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: modelRegistry.resolver(model, this.session.getSessionId?.() ?? undefined),
				signal,
			},
			{ telemetry, oneshotKind: "vision_verify", completeImpl: this.completeImageRequest },
		);

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "vision_verify request failed.");
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("vision_verify request aborted.");
		}

		const text = extractTextContent(response);
		if (!text) {
			throw new ToolError("vision_verify model returned no text output.");
		}

		const verdict = parseVisionVerifyVerdict(text);

		return {
			content: [{ type: "text", text: renderVisionVerifySummary(verdict) }],
			details: {
				model: `${model.provider}/${model.id}`,
				matches: verdict.matches,
				gaps: verdict.gaps,
			},
		};
	}
}
