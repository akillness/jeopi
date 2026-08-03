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

	it("keeps error callback script payload inert while preserving visible error text", async () => {
		const authReady = Promise.withResolvers<{ redirectUri: string; state: string }>();
		const callbackReady = Promise.withResolvers<void>();
		const flow = new TestCallbackFlow(
			{
				onAuth: info => {
					const url = new URL(info.url);
					const state = url.searchParams.get("state") ?? "";
					url.search = "";
					authReady.resolve({ redirectUri: url.toString(), state });
				},
				onProgress: message => {
					if (message === "Waiting for browser authentication...") callbackReady.resolve();
				},
				signal: AbortSignal.timeout(2_000),
			},
			14584,
		);

		const errorDescription = "</script><script>window.__oauthEscaped = true</script>";
		const login = flow.login();
		const loginRejection = login.then(
			() => {
				throw new Error("Expected OAuth callback login to reject");
			},
			error => {
				const message = error instanceof Error ? error.message : String(error);
				expect(message).toBe(`Authorization failed: ${errorDescription}`);
			},
		);
		const { redirectUri, state } = await authReady.promise;
		await callbackReady.promise;
		await Promise.resolve();

		const callbackResponse = await fetch(
			`${redirectUri}?error=access_denied&error_description=${encodeURIComponent(errorDescription)}&state=${encodeURIComponent(state)}`,
		);
		expect(callbackResponse.status).toBe(500);
		const html = await callbackResponse.text();

		expect(html).not.toContain("</script><script>");
		expect(html).not.toContain(errorDescription);

		const stateScript = html.match(/<script id="server-state" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
		expect(stateScript).not.toBeNull();
		const parsedState = JSON.parse(stateScript?.[1] ?? "") as { error?: string };
		expect(parsedState.error).toBe(`Authorization failed: ${errorDescription}`);

		await loginRejection;
	});
});
