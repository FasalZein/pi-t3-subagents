/**
 * Layer 1, S5: exact budget, budget-0 tool exposure and the raw-delegation guard (D10, D22).
 * The wrapper runs through the fake Pi tool pipeline (tool_execution_start, tool_call with
 * parentToolCallId, tool_result, tool_execution_end), with the fake bridge installed behind it,
 * so the guard sees the same event order as in Pi 1.4.0.
 * Expected values come from the spec ("Spawn policy and raw-delegation guard", field mapping).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../../index.ts";
import type { ChildRuntime, ChildState } from "../../src/child-runtime.ts";
import { EXHAUSTED_TOOLS, installChildTools } from "../../src/child-tools.ts";
import type { Caller } from "../../src/launch-planner.ts";
import { THREAD_STARTING_TOOLS } from "../../src/planner.ts";
import { guardCheck, installRawDelegationGuard } from "../../src/raw-delegation-guard.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakeBridge } from "../harness/fake-bridge.ts";
import { FakePiHost } from "../harness/fake-pi.ts";
import { DELEGATE, type LaunchFixture, launchFixture, RUNNING } from "./launch-helpers.ts";

const OURS = "/ext/pi-t3-subagents/index.ts";
const T3 = { T3_MCP_URL: "http://127.0.0.1:1/mcp", T3_MCP_BEARER_TOKEN: "fake-token" };
const SEND = "mcp__t3-code__t3_thread_send";
const base = { name: "fx-check", title: "Fixture check", task: "Say ok." };

let f: LaunchFixture;
beforeEach(() => {
	f = launchFixture();
	f.h.agent("fx-leaf", "name: fx-leaf\ndescription: Leaf\nmodel: cpa/claude-haiku-5-5\nthinking: low\nsystem-prompt: replace");
	f.h.agent("fx-spawner", "name: fx-spawner\ndescription: Spawner\nmodel: cpa/claude-haiku-5-5\nthinking: low\nspawning: fx-leaf,fx-mid\nspawn-depth: 2\nsystem-prompt: replace");
	f.h.agent("fx-mid", "name: fx-mid\ndescription: Mid spawner\nmodel: cpa/claude-haiku-5-5\nthinking: low\nspawning: fx-leaf\nspawn-depth: 5\nsystem-prompt: replace");
	f.h.agent("fx-deep", "name: fx-deep\ndescription: Deep spawner\nmodel: cpa/claude-haiku-5-5\nthinking: low\nspawning: true\nspawn-depth: 5\nsystem-prompt: replace");
	f.sync();
});
afterEach(() => {
	f.h.cleanup();
	resetCopyRegistry();
});

const childOf = (state: Partial<ChildState> | undefined): ChildRuntime => ({
	state: () => (state ? ({ agent: "fx-spawner", instanceId: "t3t-fx-spawner", stale: false, ...state } as ChildState) : undefined),
	observed: () => ({ promptSections: true, input: true }),
});

/** A thread with the real wrapper tool, the guard and the fake bridge behind the Pi pipeline. */
async function thread(options: { caller: Caller; child?: ChildRuntime; managed?: string[] }) {
	const host = new FakePiHost();
	const bridge = new FakeBridge().respond(DELEGATE, () => RUNNING).respond(SEND, () => ({ status: "started" }));
	let guard: ReturnType<typeof installRawDelegationGuard> | undefined;
	await host.load(OURS, (pi: ExtensionAPI) => {
		pi.registerTool(f.tool(options.caller));
		guard = installRawDelegationGuard(pi, { env: f.h.env, child: options.child, isManagedInstance: options.managed ? (id) => options.managed!.includes(id) : undefined });
	});
	bridge.installOn(host);
	host.active.add(DELEGATE); // delegate_task is a direct bridge tool, active in T3 threads.
	host.finishLoading();
	return { host, bridge, guard: guard! };
}

const headerOf = (bridge: FakeBridge) => JSON.parse(bridge.calls[0].args.task.split("\n")[0].replace("<!-- pi-t3-subagents:v1 ", "").replace(" -->", ""));

describe("exact budget (D10): min(child spawn-depth or 1, caller budget minus 1)", () => {
	const cases: Array<[string, Caller, string, number]> = [
		["root launches a depth-2 spawner", { agent: null, budget: null }, "fx-spawner", 2],
		["a budget-2 caller launches a depth-5 spawner", { agent: "fx-spawner", budget: 2 }, "fx-mid", 1],
		["a budget-4 caller launches a depth-5 spawner", { agent: "fx-deep", budget: 4 }, "fx-mid", 3],
		["a budget-1 caller launches a depth-5 spawner", { agent: "fx-spawner", budget: 1 }, "fx-mid", 0],
		["a budget-3 caller launches a leaf", { agent: "fx-deep", budget: 3 }, "fx-leaf", 0],
	];
	for (const [label, caller, agent, budget] of cases) {
		test(label, async () => {
			const t = await thread({ caller, child: caller.agent ? childOf({ agent: caller.agent, budget: caller.budget! }) : undefined });
			const out = await t.host.callTool("subagent", { ...base, agent });
			expect(out.isError).toBe(false);
			expect(headerOf(t.bridge)).toMatchObject({ budget, caller: caller.agent ?? "root" });
		});
	}
});

describe("raw-delegation guard in a child thread", () => {
	const spawner = () => thread({ caller: { agent: "fx-spawner", budget: 2 }, child: childOf({ budget: 2 }) });

	test("the wrapper's own nested delegate_task passes", async () => {
		const t = await spawner();
		const out = await t.host.callTool("subagent", { ...base, agent: "fx-leaf" });
		expect(out.isError).toBe(false);
		expect(t.bridge.calls.map((c) => c.name)).toEqual([DELEGATE]);
		const call = t.host.toolEvents.find((e) => e.type === "tool_call" && e.toolName === DELEGATE);
		expect(call?.parentToolCallId).toBe(out.toolCallId);
		expect(await guardCheck(t.guard).run()).toMatchObject({ status: "pass" });
	});

	test("a wrapper call from a codemode script passes, the script's raw delegate_task does not", async () => {
		const t = await spawner();
		// A codemode call "call-cm" whose script runs two nested calls.
		const viaWrapper = await t.host.callTool("subagent", { ...base, agent: "fx-leaf" }, { parentToolCallId: "call-cm" });
		expect(viaWrapper.isError).toBe(false);
		const raw = await t.host.callTool(DELEGATE, { task: "x", target: { providerInstanceId: "t3t-fx-leaf" } }, { parentToolCallId: "call-cm" });
		expect(raw.blocked).toMatch(/Raw delegate_task is refused in a pi-t3-subagents child thread/);
		expect(t.bridge.calls).toHaveLength(1);
	});

	test("a raw delegate_task from the model is refused, also to a non-managed instance", async () => {
		const t = await spawner();
		const raw = await t.host.callTool(DELEGATE, { task: "x", target: { providerInstanceId: "codex" } });
		expect(raw.blocked).toMatch(/Raw delegate_task is refused/);
		expect(t.bridge.calls).toEqual([]);
	});

	test("a delegate_task nested under an ended wrapper call is refused", async () => {
		const t = await spawner();
		const done = await t.host.callTool("subagent", { ...base, agent: "fx-leaf" });
		const late = await t.host.callTool(DELEGATE, { task: "x" }, { parentToolCallId: done.toolCallId });
		expect(late.blocked).toMatch(/Raw delegate_task is refused/);
	});

	test("without parentToolCallId the wrapper's call is refused (fails closed) and the doctor reports it", async () => {
		const t = await spawner();
		// A Pi that stops providing parentToolCallId: strip it from tool_call events.
		const handlers = t.host.handlers.get("tool_call")!;
		const original = handlers[0].handler;
		handlers[0].handler = (event: any, ctx: any) => {
			const { parentToolCallId: _drop, ...rest } = event;
			return original(rest, ctx);
		};
		await expect(t.host.callTool("subagent", { ...base, agent: "fx-leaf" })).resolves.toMatchObject({ isError: true });
		expect(t.bridge.calls).toEqual([]);
		expect(await guardCheck(t.guard).run()).toMatchObject({ status: "fail" });
	});

	test("a spawner keeps t3_thread_send while its budget is above 0", async () => {
		const t = await spawner();
		const out = await t.host.callTool(SEND, { threadId: "thread-1", message: "go on" }, { parentToolCallId: "call-cm" });
		expect(out.blocked).toBeUndefined();
	});

	for (const [label, state] of [
		["a leaf (budget 0)", { agent: "fx-leaf", budget: 0 }],
		["an exhausted spawner (budget 0)", { budget: 0 }],
		["a child before its header was read", undefined],
	] as const) {
		test(`${label}: every thread-starting bridge tool is refused, including the wrapper's own call`, async () => {
			const t = await thread({ caller: { agent: "fx-spawner", budget: 0 }, child: childOf(state as any) });
			for (const tool of THREAD_STARTING_TOOLS) {
				t.host.addTool(tool, "/t3/pi-mcp-bridge/index.ts", "deferred", false, () => ({ content: [], structuredContent: {} }));
				const out = await t.host.callTool(tool, {}, { parentToolCallId: "call-cm" });
				expect(out.blocked).toMatch(/may not start threads or tasks/);
			}
			const wrapper = await t.host.callTool("subagent", { ...base, agent: "fx-leaf" });
			expect(wrapper.isError).toBe(true);
			expect(t.bridge.calls).toEqual([]);
		});
	}
});

describe("raw-delegation guard in a root thread", () => {
	const root = () => thread({ caller: { agent: null, budget: null }, managed: ["t3t-fx-leaf"] });

	test("a raw call to a managed instance is refused", async () => {
		const t = await root();
		const raw = await t.host.callTool(DELEGATE, { task: "x", target: { providerInstanceId: "t3t-fx-leaf" } }, { parentToolCallId: "call-cm" });
		expect(raw.blocked).toBe("Raw delegate_task to the managed instance t3t-fx-leaf is refused (D22). Launch that agent with the subagent tool; it applies the agent's launch rules.");
		expect(t.bridge.calls).toEqual([]);
	});

	test("a raw call to a non-managed instance passes", async () => {
		const t = await root();
		const out = await t.host.callTool(DELEGATE, { task: "x", target: { providerInstanceId: "codex" } }, { parentToolCallId: "call-cm" });
		expect(out.blocked).toBeUndefined();
		expect(t.bridge.calls).toHaveLength(1);
	});

	test("the wrapper's launch to a managed instance passes", async () => {
		const t = await root();
		const out = await t.host.callTool("subagent", { ...base, agent: "fx-leaf" });
		expect(out.isError).toBe(false);
		expect(t.bridge.calls[0].args.target.providerInstanceId).toBe("t3t-fx-leaf");
	});
});

describe("entry wiring (index.ts slot S5)", () => {
	test("a root thread refuses a raw call to a managed instance read from T3 settings", async () => {
		const host = new FakePiHost();
		await host.load(OURS, createExtension({ ...T3, ...f.h.env }, OURS));
		new FakeBridge().respond(DELEGATE, () => RUNNING).installOn(host);
		await host.startSession();
		const raw = await host.callTool(DELEGATE, { task: "x", target: { providerInstanceId: "t3t-fx-leaf" } }, { parentToolCallId: "call-cm" });
		expect(raw.blocked).toMatch(/managed instance t3t-fx-leaf is refused/);
		const other = await host.callTool(DELEGATE, { task: "x", target: { providerInstanceId: "codex" } }, { parentToolCallId: "call-cm" });
		expect(other.blocked).toBeUndefined();
	});

	test("a budget-0 child drops subagent and the bridge tools from the active set; the doctor lists the guard", async () => {
		const host = new FakePiHost();
		await host.load(OURS, createExtension({ ...T3, ...f.h.env, PI_T3_AGENT: "fx-spawner" }, OURS));
		for (const tool of [DELEGATE, SEND]) host.addTool(tool, "/t3/pi-mcp-bridge/index.ts", "direct", true);
		await host.startSession();
		expect(host.active.has("subagent")).toBe(true);
		// Header from a budget-1 caller: budget 0.
		const results = await host.emit("input", { text: `<!-- pi-t3-subagents:v1 {"budget":0,"caller":"fx-deep","revision":"x"} -->\nwork`, source: "rpc" });
		expect(results.length).toBeGreaterThan(0);
		await host.emit("turn_start", {});
		expect([...host.active].filter((t) => EXHAUSTED_TOOLS.includes(t))).toEqual([]);
		await host.runCommand("t3-subagents-doctor");
		expect(JSON.stringify(host.messages)).toContain("raw-delegation guard");
	});
});

describe("budget-0 tool exposure (child-tools)", () => {
	async function child(budget: number | undefined) {
		const host = new FakePiHost();
		await host.load(OURS, (pi: ExtensionAPI) => {
			installChildTools(pi, childOf({ budget }));
		});
		// The bridge loads after this extension and re-activates its catalog (openai-completions path).
		await host.load("/t3/pi-mcp-bridge/index.ts", (pi: ExtensionAPI) => {
			pi.on("before_agent_start", async () => pi.setActiveTools([...new Set([...pi.getActiveTools(), DELEGATE, SEND])]));
		});
		host.addTool("subagent", OURS, "direct", true);
		host.addTool("read", "builtin", "direct", true);
		for (const tool of [DELEGATE, SEND]) host.addTool(tool, "/t3/pi-mcp-bridge/index.ts", "direct", true);
		host.finishLoading();
		return host;
	}

	test("budget 0: after the bridge's reconciliation, turn_start leaves no spawn tool active", async () => {
		const host = await child(0);
		await host.startSession();
		await host.startRun();
		expect(host.active.has(DELEGATE)).toBe(true); // the bridge re-added it in before_agent_start
		await host.emit("turn_start", {});
		expect([...host.active].sort()).toEqual(["read"]);
	});

	test("budget above 0: the spawn tools stay active", async () => {
		const host = await child(1);
		await host.startSession();
		await host.startRun();
		await host.emit("turn_start", {});
		expect([...host.active].sort()).toEqual(["mcp__t3-code__delegate_task", "mcp__t3-code__t3_thread_send", "read", "subagent"]);
	});
});
