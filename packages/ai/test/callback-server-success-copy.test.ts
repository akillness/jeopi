import { describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "jeopi-ai/registry/oauth/callback-server";
import type { OAuthCredentials } from "jeopi-ai/registry/oauth/types";

class TestCallbackFlow extends OAuthCallbackFlow {
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		return { url: `${redirectUri}?start=1&state=${encodeURIComponent(state)}` };
	}

	async exchangeToken(code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
		return { access: `access-${code}`, refresh: "refresh-token", expires: Date.now() + 60_000 };
	}
}

describe("OAuthCallbackFlow success page copy", () => {
	it("serves success copy that permits manual tab close", async () => {
		const authReady = Promise.withResolvers<{ redirectUri: string; state: string }>();
		const flow = new TestCallbackFlow(
			{
				onAuth: info => {
					const url = new URL(info.url);
					const state = url.searchParams.get("state") ?? "";
					url.search = "";
					authReady.resolve({ redirectUri: url.toString(), state });
				},
				signal: AbortSignal.timeout(2_000),
			},
			14583,
		);

		const login = flow.login();
		const { redirectUri, state } = await authReady.promise;

		const callbackResponse = await fetch(`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}`);
		expect(callbackResponse.status).toBe(200);
		const html = await callbackResponse.text();

		expect(html).toContain("Authentication Successful");
		expect(html).toContain("You have successfully logged in.<br>You can now close this tab.");
		expect(html).toContain("Close Window");
		expect(html).not.toContain("This window will close automatically.");

		await login;
	});
});
