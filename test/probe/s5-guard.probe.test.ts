/**
 * Layer 2, S5: the raw-delegation guard on the real Pi SDK nested-call path (no model call).
 * A fixture tool stands for a codemode script: it calls the bridge's delegate_task through
 * ctx.executeTool, so Pi's own tool_call event (with parentToolCallId) reaches the guard.
 * Root thread: a managed target is refused, a non-managed target passes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createExtension } from "../../index.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { hostPi } from "./host-pi.ts";

const DELEGATE = "mcp__t3-code__delegate_task";
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function scriptCall(target: string) {
	const pi = hostPi();
	const sdk = await import(join(pi.packageDir, "dist/index.js"));
	const { AuthStorage } = await import(join(pi.packageDir, "dist/core/auth-storage.js"));
	resetCopyRegistry();
	const dir = mkdtempSync(join(tmpdir(), "t3-subagents-s5-guard-"));
	const settingsPath = join(dir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ providerInstances: { "t3t-fx-leaf": { driver: "pi", config: { managedBy: "pi-t3-subagents", namespace: "t3t-" } }, codex: { driver: "codex" } } }));
	const env = { T3_MCP_URL: "http://127.0.0.1:9/mcp", T3_MCP_BEARER_TOKEN: "probe-fake-token", PI_T3_SETTINGS_PATH: settingsPath, PI_T3_NAMESPACE: "t3t-", PI_T3_AGENTS_DIR: dir };
	const cwd = process.cwd();
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	const executed: string[] = [];
	let toolCallEvent: any;
	const fixture = (api: any) => {
		api.registerTool({ name: DELEGATE, label: "delegate_task", description: "fake bridge", exposure: "direct", parameters: Type.Object({}, { additionalProperties: true }), async execute(_id: string, params: any) {
			executed.push(params?.target?.providerInstanceId);
			return { content: [{ type: "text", text: "DELEGATED" }], details: undefined };
		} });
		// tool_execution_start fires before tool_call and carries the same ids (a blocked call stops later tool_call handlers).
		api.on("tool_execution_start", async (event: any) => {
			if (event.toolName === DELEGATE) toolCallEvent = { toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId };
		});
		api.registerTool({ name: "script_probe", label: "Script probe", description: "a script calling the bridge", parameters: Type.Object({}), async execute(_id: string, _p: unknown, signal: AbortSignal, _u: unknown, ctx: any) {
			return (await ctx.executeTool(DELEGATE, { task: "x", target: { providerInstanceId: target } }, { signal })).result;
		} });
	};
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [createExtension(env, "probe:s5-guard"), fixture] });
	await loader.reload();
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, settingsManager, sessionManager: sdk.SessionManager.inMemory(), resourceLoader: loader, modelRuntime });
	try {
		await session.bindExtensions({});
		session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "probe-1", name: "script_probe", arguments: {} }], api: "anthropic-messages", provider: "fixture", model: "fixture", usage: ZERO_USAGE, stopReason: "toolUse", timestamp: Date.now() });
		const tool = session.agent.state.tools.find((candidate: any) => candidate.name === "script_probe");
		let text: string;
		try {
			text = JSON.stringify((await tool.execute("probe-1", {}, new AbortController().signal)).content);
		} catch (error) {
			text = error instanceof Error ? error.message : String(error);
		}
		return { loadErrors: loader.getExtensions().errors, executed, text, toolCallEvent, piVersion: pi.version };
	} finally {
		session.dispose();
		resetCopyRegistry();
	}
}

describe("real Pi SDK: raw-delegation guard in a root thread", () => {
	test("a script's raw delegate_task to a managed instance is refused; the nested call carries parentToolCallId", async () => {
		const run = await scriptCall("t3t-fx-leaf");
		console.log(`guard probe (Pi ${run.piVersion}, managed): ${run.text} event=${JSON.stringify(run.toolCallEvent)}`);
		expect(run.loadErrors).toEqual([]);
		expect(run.toolCallEvent).toEqual({ toolCallId: "probe-1/1", parentToolCallId: "probe-1" });
		expect(run.executed).toEqual([]);
		expect(run.text).toContain("Raw delegate_task to the managed instance t3t-fx-leaf is refused");
	});

	test("a script's raw delegate_task to a non-managed instance passes", async () => {
		const run = await scriptCall("codex");
		expect(run.executed).toEqual(["codex"]);
		expect(run.text).toContain("DELEGATED");
	});
});
