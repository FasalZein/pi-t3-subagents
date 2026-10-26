import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../../index.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakePiHost, fakeForeignSubagent, fakePiSubagents } from "../harness/fake-pi.ts";

const OURS = "/ext/pi-t3-subagents/index.ts";
// C6 and C7 (S2) read T3 settings: point them at a temporary empty settings file, never the real one.
const SETTINGS_DIR = mkdtempSync(join(tmpdir(), "doctor-settings-"));
writeFileSync(join(SETTINGS_DIR, "settings.json"), "{}\n");
afterAll(() => rmSync(SETTINGS_DIR, { recursive: true, force: true }));
const T3_ENV = {
	T3_MCP_URL: "http://127.0.0.1:1/mcp",
	T3_MCP_BEARER_TOKEN: "fake-token",
	PI_T3_SETTINGS_PATH: join(SETTINGS_DIR, "settings.json"),
	PI_T3_AGENTS_DIR: join(SETTINGS_DIR, "agents"),
};
const BRIDGE = "builtin:mcp";

afterEach(() => resetCopyRegistry());

/** T3 bridge with Pi's tool-search present: delegate_task direct, the others deferred. */
function addBridge(host: FakePiHost, options: { delegateActive?: boolean; omit?: string } = {}) {
	for (const [name, exposure] of [
		["mcp__t3-code__delegate_task", "direct"],
		["mcp__t3-code__task_status", "deferred"],
		["mcp__t3-code__task_cancel", "deferred"],
		["mcp__t3-code__t3_thread_send", "deferred"],
	] as const) {
		if (name === options.omit) continue;
		host.addTool(name, BRIDGE, exposure, exposure === "direct" ? (options.delegateActive ?? true) : false);
	}
}

async function doctorLines(host: FakePiHost): Promise<Map<string, string>> {
	host.messages.length = 0;
	await host.runCommand("t3-subagents-doctor");
	const text = String(host.messages[0]?.content);
	return new Map(
		text
			.split("\n")
			.filter((line) => /^C\d+ /.test(line))
			.map((line) => [line.split(" ")[0] ?? "", line]),
	);
}

async function boot(extra: Array<[string, (pi: any) => void]> = [], copies: string[] = [OURS]) {
	const env: Record<string, string | undefined> = { ...T3_ENV };
	const host = new FakePiHost();
	for (const copy of copies) await host.load(copy, createExtension(env, copy));
	for (const [path, factory] of extra) await host.load(path, factory);
	await host.load("/pkg/pi-subagents/src/index.ts", fakePiSubagents(env));
	await host.startSession();
	return host;
}

describe("doctor inside T3", () => {
	test("healthy session: C1, C2, C3, C4, C6, C7 and C8 pass", async () => {
		const host = await boot();
		addBridge(host);
		const lines = await doctorLines(host);
		expect([...lines.keys()]).toEqual(["C1", "C2", "C3", "C4", "C6", "C7", "C8"]);
		for (const line of lines.values()) expect(line).toContain(" PASS ");
	});

	test("C1 fails and names the foreign source when suppression failed", async () => {
		const host = await boot([["/pkg/foreign/index.ts", fakeForeignSubagent()]]);
		addBridge(host);
		const c1 = (await doctorLines(host)).get("C1") ?? "";
		expect(c1).toContain(" FAIL ");
		expect(c1).toContain("/pkg/foreign/index.ts");
	});

	test("C2 fails when a second copy of the extension is loaded", async () => {
		const host = await boot([], [OURS, "/other/copy/index.ts"]);
		addBridge(host);
		const c2 = (await doctorLines(host)).get("C2") ?? "";
		expect(c2).toContain(" FAIL ");
		expect(c2).toContain("/other/copy/index.ts");
	});

	test("C3 fails naming a missing bridge tool", async () => {
		const host = await boot();
		addBridge(host, { omit: "mcp__t3-code__task_cancel" });
		const c3 = (await doctorLines(host)).get("C3") ?? "";
		expect(c3).toContain(" FAIL ");
		expect(c3).toContain("mcp__t3-code__task_cancel is not registered");
	});

	test("C3 fails when delegate_task is direct but inactive", async () => {
		const host = await boot();
		addBridge(host, { delegateActive: false });
		const c3 = (await doctorLines(host)).get("C3") ?? "";
		expect(c3).toContain(" FAIL ");
		expect(c3).toContain("mcp__t3-code__delegate_task is not callable");
	});
});
