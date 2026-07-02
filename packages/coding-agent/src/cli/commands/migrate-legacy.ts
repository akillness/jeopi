import { APP_NAME, hasUnmigratedLegacyConfigDir, LEGACY_CONFIG_DIR_NAME, migrateLegacyConfigDir } from "jeopi-utils";

export async function migrateLegacyConfig(): Promise<void> {
	if (process.env.PI_CONFIG_DIR) {
		console.error(
			"PI_CONFIG_DIR is set — you already control the config directory name; there is nothing to migrate.",
		);
		process.exit(1);
	}

	if (!hasUnmigratedLegacyConfigDir()) {
		console.log(`No unmigrated ${LEGACY_CONFIG_DIR_NAME} directory found. Nothing to do.`);
		return;
	}

	try {
		const { from, to } = migrateLegacyConfigDir();
		console.log(`Migrated ${from} -> ${to}`);
		console.log(`${APP_NAME} now reads auth, sessions, and settings from ${to}.`);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
