/**
 * Layer 2: caller_ping in one parallel tool batch with another tool, through the host Pi's
 * real SDK session and agent loop (no model call, no network, in-memory storage).
 *
 * Pi 1.4.0 runs a top-level assistant batch in parallel by default: it prepares every call
 * (`tool_call` handlers) before it executes any. Unless caller_ping is sequential, a later
 * call in the same batch passes the latch check before the ping executes (slice review
 * reviewer/t3-subagents-6-slice/report.md, P1). A fixed assistant stream issues
 * [caller_ping, side_effect]; the side effect must not run and must get the ping reason.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Type } from "typebox";
import { installCallerPing } from "../../src/caller-ping.ts";
import { hostPi } from "./host-pi.ts";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const PING = "Need a decision: staging or prod?";

interface BatchResult {
	name: string;
	isError: boolean;
	text: string;
}

async function batch(): Promise<{ sideEffects: number; results: BatchResult[]; piVersion: string }> {
	const pi = hostPi();
	const sdk = await import(join(pi.packageDir, "dist/index.js"));
	const { AuthStorage } = await import(join(pi.packageDir, "dist/core/auth-storage.js"));
	// pi-ai is installed next to the host Pi package (global bun install layout).
	const { createAssistantMessageEventStream } = await import(join(pi.packageDir, "..", "pi-ai/dist/index.js"));
	const cwd = process.cwd();
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
	let sideEffects = 0;
	const fixture = (api: any) => {
		api.registerTool({
			name: "side_effect",
			label: "Side effect",
			description: "in-memory marker",
			parameters: Type.Object({}),
			async execute() {
				sideEffects++;
				return { content: [{ type: "text", text: "side effect ran" }], details: undefined };
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
		extensionFactories: [(api: any) => installCallerPing(api), fixture],
	});
	await loader.reload();
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, settingsManager, sessionManager: sdk.SessionManager.inMemory(), resourceLoader: loader, modelRuntime });
	try {
		await session.bindExtensions({});
		const model = { id: "fixture", name: "fixture", provider: "fixture", api: "anthropic-messages", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
		session.agent.state.model = model;
		let turn = 0;
		session.agent.streamFunction = () => {
			const first = turn++ === 0;
			const content = first
				? [
						{ type: "toolCall", id: "ping", name: "caller_ping", arguments: { message: PING } },
						{ type: "toolCall", id: "effect", name: "side_effect", arguments: {} },
					]
				: [{ type: "text", text: `CALLER PING\n${PING}` }];
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: first ? "toolUse" : "stop", timestamp: Date.now() };
			const events = createAssistantMessageEventStream();
			events.push({ type: "done", reason: message.stopReason, message });
			return events;
		};
		await session.agent.prompt({ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() });
		const results = session.agent.state.messages
			.filter((m: any) => m.role === "toolResult")
			.map((m: any) => ({ name: m.toolName, isError: m.isError, text: m.content.map((c: any) => c.text ?? "").join("") }));
		return { sideEffects, results, piVersion: pi.version };
	} finally {
		session.dispose();
	}
}

test("real Pi agent loop: a later tool in the same parallel batch as caller_ping is refused with the ping reason", async () => {
	const run = await batch();
	console.log(`caller-ping batch probe (Pi ${run.piVersion}): ${JSON.stringify(run.results)}`);
	expect(run.results.map((r) => r.name)).toEqual(["caller_ping", "side_effect"]);
	expect(run.results[0]?.isError).toBe(false);
	expect(run.sideEffects).toBe(0);
	expect(run.results[1]?.isError).toBe(true);
	expect(run.results[1]?.text).toContain("caller_ping");
	expect(run.results[1]?.text).toContain(PING);
});
