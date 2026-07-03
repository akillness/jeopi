import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "jeopi-cli/config/settings";
import { notifyIfNewerVersion } from "jeopi-cli/main";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("notifyIfNewerVersion", () => {
	// Regression: a long-running interactive session only ever checked the
	// registry once at launch. A release published hours into the session left
	// the "Update Available" banner invisible until the user restarted, even
	// though `jeopi update` (a fresh process) correctly saw it. The periodic
	// recheck in runInteractiveMode re-queries and must actually surface a
	// newer version discovered after startup.
	it("shows the banner and returns the new version when a newer version is found", () => {
		const showNewVersionNotification = vi.fn();
		const mode = { showNewVersionNotification };

		const result = notifyIfNewerVersion(mode, "16.2.23", "16.2.22");

		expect(showNewVersionNotification).toHaveBeenCalledTimes(1);
		expect(showNewVersionNotification).toHaveBeenCalledWith("16.2.23");
		expect(result).toBe("16.2.23");
	});

	it("does not re-show the banner when the recheck resolves to the same already-notified version", () => {
		const showNewVersionNotification = vi.fn();
		const mode = { showNewVersionNotification };

		const result = notifyIfNewerVersion(mode, "16.2.23", "16.2.23");

		expect(showNewVersionNotification).not.toHaveBeenCalled();
		expect(result).toBe("16.2.23");
	});

	it("does not show a banner and keeps the prior lastNotified when no newer version is reported", () => {
		const showNewVersionNotification = vi.fn();
		const mode = { showNewVersionNotification };

		const result = notifyIfNewerVersion(mode, undefined, "16.2.22");

		expect(showNewVersionNotification).not.toHaveBeenCalled();
		expect(result).toBe("16.2.22");
	});

	it("suppresses the banner when startup.checkUpdate was disabled after the fetch started", () => {
		settings.set("startup.checkUpdate", false);
		const showNewVersionNotification = vi.fn();
		const mode = { showNewVersionNotification };

		const result = notifyIfNewerVersion(mode, "16.2.23", "16.2.22");

		expect(showNewVersionNotification).not.toHaveBeenCalled();
		expect(result).toBe("16.2.22");
	});

	it("notifies again when a second, even newer version is found after the first notice", () => {
		const showNewVersionNotification = vi.fn();
		const mode = { showNewVersionNotification };

		const first = notifyIfNewerVersion(mode, "16.2.23", "16.2.22");
		const second = notifyIfNewerVersion(mode, "16.2.24", first);

		expect(showNewVersionNotification).toHaveBeenNthCalledWith(1, "16.2.23");
		expect(showNewVersionNotification).toHaveBeenNthCalledWith(2, "16.2.24");
		expect(second).toBe("16.2.24");
	});
});
