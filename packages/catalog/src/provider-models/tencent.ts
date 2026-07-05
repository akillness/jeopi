/**
 * Tencent Cloud MaaS (international) — Anthropic Messages wire format,
 * API-key-only. Serves DeepSeek / MiniMax / Zhipu GLM / Moonshot Kimi /
 * Hunyuan MT models from one gateway (`tokenhub-intl`). Ported from
 * gajae-code's `src/ai/providers/openai-compatible-catalog.ts` (`protocol:
 * "anthropic"` entry) + `src/ai/model-catalog.ts` (the Tencent model rows).
 *
 * The gateway has no `/v1/models` route and is not indexed by models.dev, so
 * (unlike `zai`/`minimax`, whose model lists come from models.dev at catalog
 * generation time) the model list here is a curated static seed — the only
 * available source of truth.
 *
 * Improvement over the source: gajae-code ships two Tencent model lists that
 * have drifted apart (`openai-compatible-catalog.ts`'s 16-id `knownModels`
 * vs `model-catalog.ts`'s 17-row table — they disagree on `hy-mt2-plus`,
 * `deepseek-v4-pro-202606`, `deepseek-v4-flash-202605`, `minimax-m2.7`, and
 * `kimi-k2.6`), and `knownModels` turns out to be dead code in practice — the
 * live model-list fallback (`catalogOr`) reads only `model-catalog.ts`. This
 * port keeps exactly one list (the superset, i.e. `model-catalog.ts`'s 17
 * models) so the two can't diverge again.
 *
 * Pricing is not published for this gateway; cost fields are zeroed rather
 * than guessed, matching the existing convention for other unverified-pricing
 * gateways in the bundled catalog (e.g. `zai`).
 */
import type { ModelManagerOptions } from "../model-manager";
import type { ModelSpec } from "../types";

export const TENCENT_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com";

interface TencentCuratedModel {
	id: string;
	name: string;
	/** `false` only for Hunyuan MT2 Plus — a translation model, not a general reasoning one. */
	reasoning: boolean;
	images: boolean;
}

const TENCENT_CURATED_MODELS: readonly TencentCuratedModel[] = [
	// DeepSeek
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, images: false },
	{ id: "deepseek-v4-pro-202606", name: "DeepSeek V4 Pro (202606)", reasoning: true, images: false },
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, images: false },
	{ id: "deepseek-v4-flash-202605", name: "DeepSeek V4 Flash (202605)", reasoning: true, images: false },
	{ id: "deepseek-v3.2", name: "DeepSeek V3.2", reasoning: true, images: false },
	// MiniMax
	{ id: "minimax-m3", name: "MiniMax M3", reasoning: true, images: false },
	{ id: "minimax-m2.7", name: "MiniMax M2.7", reasoning: true, images: false },
	{ id: "minimax-m2.5", name: "MiniMax M2.5", reasoning: true, images: false },
	// Zhipu GLM
	{ id: "glm-5.2", name: "GLM-5.2", reasoning: true, images: false },
	{ id: "glm-5.1", name: "GLM-5.1", reasoning: true, images: false },
	{ id: "glm-5", name: "GLM-5", reasoning: true, images: false },
	{ id: "glm-5-turbo", name: "GLM-5 Turbo", reasoning: true, images: false },
	{ id: "glm-5v-turbo", name: "GLM-5V Turbo", reasoning: true, images: true },
	// Moonshot Kimi
	{ id: "kimi-k2.6", name: "Kimi K2.6", reasoning: true, images: false },
	{ id: "kimi-k2.5", name: "Kimi K2.5", reasoning: true, images: false },
	// Hunyuan
	{ id: "hy-mt2-plus", name: "Hunyuan MT2 Plus", reasoning: false, images: false },
];

/** Default model when no explicit selection is made — mirrors gajae-code's `defaultModel`. */
export const TENCENT_DEFAULT_MODEL = "deepseek-v4-pro";

/** Build the Tencent static model seed. `baseUrl` override supports self-hosted/regional gateways. */
export function buildTencentStaticSeed(baseUrl: string = TENCENT_BASE_URL): ModelSpec<"anthropic-messages">[] {
	return TENCENT_CURATED_MODELS.map(model => ({
		id: model.id,
		name: model.name,
		api: "anthropic-messages",
		provider: "tencent",
		baseUrl,
		reasoning: model.reasoning,
		input: model.images ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	}));
}

export const TENCENT_STATIC_MODELS: readonly ModelSpec<"anthropic-messages">[] = buildTencentStaticSeed();

export interface TencentModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

/** No live discovery endpoint (no `/v1/models` route) — the static seed is authoritative. */
export function tencentModelManagerOptions(
	config: TencentModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "tencent", staticModels: buildTencentStaticSeed(config.baseUrl) };
}
