import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "jeopi-cli/config/settings";
import { createTools, JeoxTool, type ToolSession } from "jeopi-cli/tools";

function createTestSession(cwd: string, jeoxEnabled = true): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "jeox.enabled": jeoxEnabled }),
	};
}

describe("JeoxTool", () => {
	it("creates .jeopi/db/jeo.db and serves code graph + Korean/symbol search", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jeopi-jeox-tool-"));
		const prevEnv = process.env.MNEMOPI_CODE_DB_PATH;
		delete process.env.MNEMOPI_CODE_DB_PATH;
		try {
			fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, "src", "ledger.ts"),
				`export function targetFunc() { return helperFunc(); }\nexport function helperFunc() { return 42; }\n`,
			);
			fs.writeFileSync(
				path.join(tmp, "src", "caller.ts"),
				`import { targetFunc } from "./ledger";\nexport function callerFunc() { return targetFunc(); }\n`,
			);
			fs.writeFileSync(path.join(tmp, "README.ko.md"), `# 코드 그래프\n로컬 메모리 인덱스 엔진입니다.\n`);

			const tool = new JeoxTool(createTestSession(tmp));

			const defRes = await tool.execute("call-1", { action: "where-defined", name: "targetFunc" });
			const defText = (defRes.content[0] as { text: string }).text;
			expect(defText).toContain("src/ledger.ts");
			expect(fs.existsSync(path.join(tmp, ".jeopi", "db", "jeo.db"))).toBe(true);
			expect(fs.existsSync(path.join(tmp, ".jeo", "db", "jeo.db"))).toBe(false);

			const whoRes = await tool.execute("call-2", { action: "who-calls", name: "targetFunc", strict: true });
			expect((whoRes.content[0] as { text: string }).text).toContain("callerFunc");

			const whatRes = await tool.execute("call-3", { action: "what-calls", name: "targetFunc" });
			expect((whatRes.content[0] as { text: string }).text).toContain("helperFunc");

			const impRes = await tool.execute("call-4", { action: "impact", target: "helperFunc" });
			expect((impRes.content[0] as { text: string }).text).toContain("src/caller.ts");

			const searchRes = await tool.execute("call-5", { action: "search", query: "인덱스 엔진" });
			expect((searchRes.content[0] as { text: string }).text).toContain("README.ko.md");

			const scopeRes = await tool.execute("call-6", { action: "scope", query: "callerFunc" });
			expect((scopeRes.content[0] as { text: string }).text).toContain("src/caller.ts");

			const stRes = await tool.execute("call-7", { action: "status" });
			const st = JSON.parse((stRes.content[0] as { text: string }).text) as { files: number; nodes: number };
			expect(st.files).toBe(3);
			expect(st.nodes).toBeGreaterThan(0);

			const buildRes = await tool.execute("call-8", { action: "build", rebuild: true });
			expect((buildRes.content[0] as { text: string }).text).toContain("Indexed in");
		} finally {
			if (prevEnv === undefined) delete process.env.MNEMOPI_CODE_DB_PATH;
			else process.env.MNEMOPI_CODE_DB_PATH = prevEnv;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("respects jeox.enabled setting in createTools", async () => {
		const enabledTools = await createTools(createTestSession("/tmp/test", true));
		expect(enabledTools.some(t => t.name === "jeox")).toBe(true);

		const disabledTools = await createTools(createTestSession("/tmp/test", false));
		expect(disabledTools.some(t => t.name === "jeox")).toBe(false);
	});
});
