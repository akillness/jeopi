import { describe, expect, it } from "bun:test";
import { getNpmPublishAuthHint } from "./ci-release-publish";

const TOKEN = "npm_secret_token_that_must_not_be_echoed";
const TOKEN_URL = "https://docs.npmjs.com/creating-and-viewing-access-tokens";

describe("getNpmPublishAuthHint", () => {
	it.each([
		["E401", `npm error code E401\nnpm error 401 Unauthorized - GET https://registry.npmjs.org/`],
		["ENEEDAUTH", "npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in"],
		["invalid or expired token", `npm ERR! authentication token is invalid or expired: ${TOKEN}`],
	])("returns an actionable hint for %s failures without echoing a token", (_label, output) => {
		const hint = getNpmPublishAuthHint(output);

		expect(hint).not.toBeNull();
		expect(hint).toContain("NPM_TOKEN");
		expect(hint).toContain("trusted publisher");
		expect(hint).toContain("ci.yml");
		expect(hint).toContain(TOKEN_URL);
		expect(hint).not.toContain(TOKEN);
	});

	it("returns null for unrelated publish failures", () => {
		expect(getNpmPublishAuthHint("npm error code E403\nnpm error 403 Forbidden")).toBeNull();
	});

	it("does not classify an already-published conflict as an auth failure", () => {
		const output = "npm error code EPUBLISHCONFLICT\nnpm error cannot publish over the previously published version";
		expect(getNpmPublishAuthHint(output)).toBeNull();
	});
});
