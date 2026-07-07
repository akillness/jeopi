import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `jeopi/${packageJson.version}`,
		"HTTP-Referer": packageJson.homepage,
		"X-OpenRouter-Title": "jeopi",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
