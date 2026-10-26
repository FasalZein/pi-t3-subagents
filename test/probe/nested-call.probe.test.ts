/**
 * Layer 2: the real Pi SDK nested-call path (no model call, no network, in-memory storage).
 *
 * After a failed suppression, a foreign `subagent` that is not `direct` stays callable
 * through ctx.executeTool even when inactive. This probe loads the host Pi's own SDK, issues
 * a nested call from a fixture tool, and checks that the takeover blocks it.
 * Based on the slice-review reproduction (reviewer/t3-subagents-1-slice/report.md).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Type } from "typebox";
import { createExtension } from "../../index.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { hostPi } from "./host-pi.ts";

const T3_ENV = { T3_MCP_URL: "http://127.0.0.1:9/mcp", T3_MCP_BEARER_TOKEN: "probe-fake-token" };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function nestedCall(options: { foreign: boolean; exposure: "codemode" | "deferred"; target: string }) {
	const pi = hostPi();
	const sdk = await import(join(pi.packageDir, "dist/index.js"));
	const { AuthStorage } = await import(join(pi.packageDir, "dist/core/auth-storage.js"));
	resetCopyRegistry();
	const cwd = process.cwd();
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	const executed: string[] = [];
	const fixture = (api: any) => {
		const record = (name: string) => async () => {
			executed.push(name);
			return { content: [{ type: "text", text: `${name} EXECUTED` }], details: undefined };
		};
		if (options.foreign) api.registerTool({ name: "subagent", label: "Foreign", description: "foreign fixture", exposure: options.exposure, parameters: Type.Object({}), execute: record("subagent") });
		api.registerTool({ name: "subagent_kill", label: "Kill", description: "kill fixture", exposure: options.exposure, parameters: Type.Object({}), execute: record("subagent_kill") });
		api.registerTool({
			name: "nested_probe",
			label: "Nested probe",
			description: "calls another tool through ctx.executeTool",
			parameters: Type.Object({}),
			async execute(_id: string, _params: unknown, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
				return (await ctx.executeTool(options.target, {}, { signal })).result;
			},
		});
	};
	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [createExtension({ ...T3_ENV }, "probe:nested-call"), fixture],
	});
	await loader.reload();
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, settingsManager, sessionManager: sdk.SessionManager.inMemory(), resourceLoader: loader, modelRuntime });
	try {
		await session.bindExtensions({});
		const callable = session.getCallableToolNames().includes(options.target);
		// Pi's nested-call runner needs the assistant message that issued the parent call.
		session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "probe-1", name: "nested_probe", arguments: {} }], api: "anthropic-messages", provider: "fixture", model: "fixture", usage: ZERO_USAGE, stopReason: "toolUse", timestamp: Date.now() });
		const tool = session.agent.state.tools.find((candidate: any) => candidate.name === "nested_probe");
		let text: string;
		try {
			const result = await tool.execute("probe-1", {}, new AbortController().signal);
			text = JSON.stringify(result.content);
		} catch (error) {
			text = error instanceof Error ? error.message : String(error);
		}
		return { loadErrors: loader.getExtensions().errors, callable, executed, text, piVersion: pi.version };
	} finally {
		session.dispose();
		resetCopyRegistry();
	}
}

describe("real Pi SDK: nested calls to disabled native tools", () => {
	for (const exposure of ["codemode", "deferred"] as const) {
		test(`a foreign ${exposure} subagent is callable but blocked after a failed suppression`, async () => {
			const run = await nestedCall({ foreign: true, exposure, target: "subagent" });
			console.log(`nested-call probe (Pi ${run.piVersion}, ${exposure} subagent): ${run.text}`);
			expect(run.loadErrors).toEqual([]);
			expect(run.callable).toBe(true);
			expect(run.executed).toEqual([]);
			expect(run.text).toContain("subagent is disabled inside T3 Code");
		});

		test(`a ${exposure} subagent_kill is blocked while the T3 subagent is installed`, async () => {
			const run = await nestedCall({ foreign: false, exposure, target: "subagent_kill" });
			expect(run.callable).toBe(true);
			expect(run.executed).toEqual([]);
			expect(run.text).toContain("subagent_kill is disabled inside T3 Code");
		});
	}
});
