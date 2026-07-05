import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://cloud.tencent.com/product/lke";
const API_BASE_URL = "https://tokenhub-intl.tencentcloudmaas.com";
const VALIDATION_MODEL = "deepseek-v4-pro";

export const loginTencent = createApiKeyLogin({
	providerLabel: "Tencent Cloud MaaS",
	authUrl: AUTH_URL,
	instructions: "Create or copy your Tencent Cloud MaaS API key from the console.",
	promptMessage: "Paste your Tencent Cloud MaaS API key",
	placeholder: "sk-...",
	validation: {
		kind: "anthropic-messages",
		provider: "Tencent Cloud MaaS",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		// Verified live (2026-07): a recognized-but-unbilled key gets HTTP 402
		// ("free trial quota exhausted ... postpaid billing not enabled"), not a
		// 401/403 — the gateway only returns 402 after successfully authenticating
		// the key. Treat it as a valid credential so a real key isn't rejected as
		// "invalid" just because the account has no active billing yet.
		acceptableErrorStatuses: [402],
	},
});

export const tencentProvider = {
	id: "tencent",
	name: "Tencent Cloud MaaS",
	login: (cb: OAuthLoginCallbacks) => loginTencent(cb),
} as const satisfies ProviderDefinition;
