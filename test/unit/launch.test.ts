/**
 * Layer 1: the T3 subagent tool and launch planner (spec "Launch flow", A1, A2, D23).
 * Expected values come from the spec text, not from the code under test.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { FakeBridge } from "../harness/fake-bridge.ts";
import { join } from "node:path";
import { launchKey } from "../../src/launch-planner.ts";
import { sessionLaunchStore } from "../../src/subagent-tool.ts";
import type { LaunchOutcome } from "../../src/subagent-tool.ts";
import { DELEGATE, type LaunchFixture, launchFixture, RUNNING, writeProjectAgent } from "./launch-helpers.ts";

let f: LaunchFixture;

const AUTONOMOUS = "Complete your task autonomously.";
const SUMMARY = "Your FINAL assistant message should summarize what you accomplished.";
const INTERACTIVE =
	"You run in a T3 Code child thread. The user can open this thread and reply. Ask questions with ask_user when it is available. When the work is done, end your turn with your final report; your caller is woken with it. The user may continue this thread later.";

beforeEach(() => {
	f = launchFixture();
	f.h.agent("fx-leaf", "name: fx-leaf\ndescription: Leaf\nmodel: cpa/claude-haiku-5-5\nthinking: low\nallowed-models: cpa/claude-sonnet-5-5\nsystem-prompt: replace");
	f.h.agent("fx-nomodel", "name: fx-nomodel\ndescription: No model", "You are the no-model role.");
	f.h.agent("fx-locked", "name: fx-locked\ndescription: Locked\nmodel: cpa/claude-haiku-5-5\nthinking: low\nallow-model-override: false\nsystem-prompt: replace");
	f.h.agent("fx-shell", "name: fx-shell\ndescription: Shell\nmodel: cpa/claude-haiku-5-5\nthinking: low\ntask-expansion: shell\nsystem-prompt: replace");
	f.h.agent("fx-skills", "name: fx-skills\ndescription: Skills\nmodel: cpa/claude-haiku-5-5\nthinking: low\nskills: tdd\ninject-skills: tdd\nsystem-prompt: replace");
	f.h.agent("fx-interactive", "name: fx-interactive\ndescription: Interactive\nmodel: cpa/claude-haiku-5-5\nthinking: low\nmode: interactive\nauto-exit: false\nsystem-prompt: replace");
	f.h.agent("fx-hidden", "name: fx-hidden\ndescription: Hidden\nmodel: cpa/claude-haiku-5-5\nvisible-to: fx-spawner\nsystem-prompt: replace");
	f.h.agent("fx-spawner", "name: fx-spawner\ndescription: Spawner\nmodel: cpa/claude-haiku-5-5\nthinking: low\nspawning: fx-leaf,fx-hidden\nspawn-depth: 2\nsystem-prompt: replace");
	f.h.agent("fx-off", "name: fx-off\ndescription: Off\nenabled: false");
	f.sync();
});
afterEach(() => f.h.cleanup());

const base = { name: "fx-check", title: "Fixture check", task: "Say ok." };
const revisionOf = (id: string) => f.h.readSettings().providerInstances[id].environment.find((e: any) => e.name === "PI_T3_REVISION").value;

// --- Validation: each error throws before any bridge call and names the cause.
const refusals: Array<[string, Record<string, unknown>, RegExp, { agent: string | null; budget: number | null }?]> = [
	["bad name", { ...base, agent: "fx-leaf", name: "Bad Name" }, /name "Bad Name" must be lower-kebab/],
	["long name", { ...base, agent: "fx-leaf", name: "abcdefghij-abcdefghij-abcdefghijk" }, /longer than 32/],
	["missing title", { ...base, agent: "fx-leaf", title: " " }, /title is required/],
	["missing agent", { ...base }, /agent is required/],
	["unknown agent", { ...base, agent: "fx-nope" }, /agent 'fx-nope' does not exist/],
	["disabled agent", { ...base, agent: "fx-off" }, /agent 'fx-off' is disabled/],
	["project agent", { ...base, agent: "fx-proj" }, /agent 'fx-proj' is a project agent/],
	["own agent", { ...base, agent: "fx-spawner" }, /you are the fx-spawner agent/, { agent: "fx-spawner", budget: 2 }],
	["visible-to", { ...base, agent: "fx-hidden" }, /not visible to root \(visible-to\)/],
	["spawning", { ...base, agent: "fx-nomodel" }, /spawning list of fx-spawner does not include agent 'fx-nomodel'/, { agent: "fx-spawner", budget: 2 }],
	["budget", { ...base, agent: "fx-leaf" }, /Spawn budget is exhausted/, { agent: "fx-spawner", budget: 0 }],
	["model outside allowed-models", { ...base, agent: "fx-leaf", model: "cpa/gpt-9" }, /Model 'cpa\/gpt-9:low' is not allowed for agent 'fx-leaf'. Allowed models: cpa\/claude-haiku-5-5:low, cpa\/claude-sonnet-5-5/],
];
for (const [label, params, message, caller] of refusals) {
	test(`validation: ${label} throws before any bridge call`, async () => {
		writeProjectAgent(f.cwd, "fx-proj");
		const bridge = f.bridge();
		await expect(f.run(f.tool(caller), bridge, params)).rejects.toThrow(message);
		expect(bridge.calls).toEqual([]);
	});
}

test("validation: an instance whose settings differ from the agent file is refused with the sync message", async () => {
	f.h.agent("fx-leaf", "name: fx-leaf\ndescription: Leaf\nmodel: cpa/claude-opus-5-5\nthinking: low\nsystem-prompt: replace");
	const bridge = f.bridge();
	await expect(f.run(f.tool(), bridge, { ...base, agent: "fx-leaf" })).rejects.toThrow(/t3t-fx-leaf does not match the agent file .*run \/t3-sync-agents/);
	expect(bridge.calls).toEqual([]);
});

test("validation: a missing instance is refused with the sync message", async () => {
	f.h.agent("fx-new", "name: fx-new\ndescription: New\nmodel: cpa/claude-haiku-5-5");
	const bridge = f.bridge();
	await expect(f.run(f.tool(), bridge, { ...base, agent: "fx-new" })).rejects.toThrow(/t3t-fx-new is missing in T3 settings; run \/t3-sync-agents/);
	expect(bridge.calls).toEqual([]);
});

test("validation: a project agent that overrides a same-named global agent is refused (D18)", async () => {
	writeProjectAgent(f.cwd, "fx-leaf");
	const bridge = f.bridge();
	await expect(f.run(f.tool(), bridge, { ...base, agent: "fx-leaf" })).rejects.toThrow(/agent 'fx-leaf' is a project agent/);
	expect(bridge.calls).toEqual([]);
});

test("validation: a missing bridge tool is refused before any call", async () => {
	const outcomes: LaunchOutcome[] = [];
	const bridge = f.bridge();
	const ctx = { ...bridge.toolContext({ cwd: f.cwd }), tools: [] };
	await expect(f.tool(undefined, outcomes).execute("c", { ...base, agent: "fx-leaf" }, undefined, undefined, ctx)).rejects.toThrow(DELEGATE);
	expect(bridge.calls).toEqual([]);
	expect(outcomes[0]).toMatchObject({ ok: false, bridge: false });
});

// --- A1 and A2: bridge arguments.
const target = async (agent: string, extra: Record<string, unknown> = {}) => {
	const bridge = f.bridge();
	await f.run(f.tool(), bridge, { ...base, agent, ...extra });
	const args = bridge.calls[0].args;
	expect(args.role).toBeUndefined(); // A2: no role.
	expect(args).toMatchObject({ mode: "async", isolation: "shared", runtimeMode: "inherit", interactionMode: "inherit", title: "Fixture check" });
	return args.target;
};

test("A1: no override uses the instance's baked model ('default', no options)", async () => {
	expect(await target("fx-leaf")).toEqual({ providerInstanceId: "t3t-fx-leaf", model: "default", options: {} });
});
test("A1: a model override inside allowed-models passes the slug and the agent's thinking", async () => {
	expect(await target("fx-leaf", { model: "cpa/claude-sonnet-5-5" })).toEqual({
		providerInstanceId: "t3t-fx-leaf",
		model: "cpa/claude-sonnet-5-5",
		options: { thinking: "low" },
	});
});
test("A1: a thinking-only override passes the agent's model slug with the new thinking", async () => {
	// fx-shell has no allowed-models (fx-leaf's list would refuse haiku:high, as in pi-subagents).
	expect(await target("fx-shell", { thinking: "high" })).toEqual({ providerInstanceId: "t3t-fx-shell", model: "cpa/claude-haiku-5-5", options: { thinking: "high" } });
});
test("A1: allow-model-override false drops the override", async () => {
	expect(await target("fx-locked", { model: "cpa/claude-sonnet-5-5", thinking: "high" })).toEqual({ providerInstanceId: "t3t-fx-locked", model: "default", options: {} });
});
test("A1: an agent without a model inherits the parent's model and thinking", async () => {
	expect(await target("fx-nomodel")).toEqual({ providerInstanceId: "t3t-fx-nomodel", model: "cpa/claude-opus-5-5", options: { thinking: "medium" } });
});
test("thinking with a model override: an unsupported inherited level is dropped (pi-subagents parity)", async () => {
	// fx-shell has thinking: low; zai/glm-flash offers off, high, xhigh.
	expect(await target("fx-shell", { model: "zai/glm-flash" })).toEqual({ providerInstanceId: "t3t-fx-shell", model: "zai/glm-flash", options: {} });
});

test("thinking with a model override: an unsupported explicit level is refused before the bridge; a supported one is sent", async () => {
	for (const extra of [{ model: "zai/glm-flash", thinking: "low" }, { model: "zai/glm-flash:low" }]) {
		const bridge = f.bridge();
		await expect(f.run(f.tool(), bridge, { ...base, agent: "fx-shell", ...extra })).rejects.toThrow(
			"Model 'zai/glm-flash' does not support thinking level 'low'. Supported levels: off, high, xhigh.",
		);
		expect(bridge.calls).toEqual([]);
	}
	expect(await target("fx-shell", { model: "zai/glm-flash", thinking: "high" })).toEqual({
		providerInstanceId: "t3t-fx-shell",
		model: "zai/glm-flash",
		options: { thinking: "high" },
	});
});

test("A1: thinking is not sent for a model without thinking support", async () => {
	f.h.agent("fx-leaf", "name: fx-leaf\ndescription: Leaf\nmodel: cpa/claude-haiku-5-5\nthinking: low\nsystem-prompt: replace");
	f.sync();
	expect(await target("fx-leaf", { model: "cpa/plain-model" })).toEqual({ providerInstanceId: "t3t-fx-leaf", model: "cpa/plain-model", options: {} });
});

test("A1: a configured bare model is resolved through Pi's registry when thinking is inherited", async () => {
	f.h.agent("fx-bare", "name: fx-bare\ndescription: Bare\nmodel: claude-haiku-5-5\nsystem-prompt: replace");
	f.h.agent("fx-bare-locked", "name: fx-bare-locked\ndescription: Bare locked\nmodel: claude-haiku-5-5\nallow-model-override: false\nflags: --provider cpa\nsystem-prompt: replace");
	f.sync();
	expect(await target("fx-bare")).toEqual({ providerInstanceId: "t3t-fx-bare", model: "cpa/claude-haiku-5-5", options: { thinking: "medium" } });
	expect(await target("fx-bare-locked", { model: "cpa/other", thinking: "high" })).toEqual({
		providerInstanceId: "t3t-fx-bare-locked",
		model: "cpa/claude-haiku-5-5",
		options: { thinking: "medium" },
	});
});

test("A1: a configured bare model with its own thinking and no override stays 'default'", async () => {
	f.h.agent("fx-bare-own", "name: fx-bare-own\ndescription: Bare own\nmodel: claude-haiku-5-5\nthinking: low\nallowed-models: claude-sonnet-5-5\nsystem-prompt: replace");
	f.sync();
	expect(await target("fx-bare-own")).toEqual({ providerInstanceId: "t3t-fx-bare-own", model: "default", options: {} });
	expect(await target("fx-bare-own", { model: "cpa/claude-sonnet-5-5" })).toEqual({
		providerInstanceId: "t3t-fx-bare-own",
		model: "cpa/claude-sonnet-5-5",
		options: { thinking: "low" },
	});
});

test("D23: exact retries reuse the first preparation; shell expansion runs once, also for concurrent retries", async () => {
	const counter = join(f.cwd, "count.txt");
	const seen = new Map<string, any>();
	// Replay-aware bridge: a known clientRequestId returns the stored first launch (T3 behavior).
	const bridge = new FakeBridge().respond(DELEGATE, (args) => {
		if (!seen.has(args.clientRequestId)) seen.set(args.clientRequestId, { ...RUNNING, task: args.task });
		return seen.get(args.clientRequestId);
	});
	const tool = f.tool();
	const params = { ...base, agent: "fx-shell", task: "Run: !`echo x >> count.txt; wc -l < count.txt`" };
	await Promise.all([f.run(tool, bridge, params, "call-r"), f.run(tool, bridge, params, "call-r")]);
	await f.run(tool, bridge, params, "call-r");
	expect(readFileSync(counter, "utf8")).toBe("x\n");
	const tasks = new Set(bridge.calls.map((c) => c.args.task));
	expect(bridge.calls).toHaveLength(3);
	expect(tasks.size).toBe(1);
	// A changed request is a new launch and expands again.
	await f.run(tool, bridge, { ...params, title: "Other title" }, "call-r");
	expect(readFileSync(counter, "utf8")).toBe("x\nx\n");
});

// --- D23: launch keys.
test("launch keys: same call id, index and request give the same key; each changed field gives a new key", () => {
	const request = { agent: "fx-leaf", task: "t", title: "T", model: "cpa/a", thinking: "low" };
	const key = launchKey("call-1", 0, request);
	expect(launchKey("call-1", 0, { ...request })).toBe(key);
	expect(key.length).toBeLessThanOrEqual(256);
	const changed = [
		launchKey("call-2", 0, request),
		launchKey("call-1", 1, request),
		launchKey("call-1", 0, { ...request, task: "u" }),
		launchKey("call-1", 0, { ...request, title: "U" }),
		launchKey("call-1", 0, { ...request, agent: "fx-other" }),
		launchKey("call-1", 0, { ...request, model: "cpa/b" }),
		launchKey("call-1", 0, { ...request, thinking: "high" }),
	];
	for (const other of changed) expect(other).not.toBe(key);
});

test("launch keys: a changed shell-expansion output alone keeps the key", async () => {
	const file = join(f.cwd, "value.txt");
	writeFileSync(file, "first");
	const bridge = f.bridge();
	const params = { ...base, agent: "fx-shell", task: "Value: !`cat value.txt`" };
	await f.run(f.tool(), bridge, params);
	writeFileSync(file, "second");
	// A different call id with the same request is a new launch: it expands again and gets a new key.
	await f.run(f.tool(), bridge, params, "call-2");
	const [a, b] = bridge.calls.map((c) => c.args);
	expect(a.task).toContain("Value: first");
	expect(b.task).toContain("Value: second");
	expect(launchKey("call-1", 0, params)).toBe(a.clientRequestId);
	// The key covers the request before expansion: the expanded output is not part of it.
	expect(a.clientRequestId).toBe(launchKey("call-1", 0, { ...params }));
});

test("D23: an exact retry after a reload (new tool instance) resends the saved launch; shell expansion does not run again", async () => {
	const counter = join(f.cwd, "count.txt");
	const bridge = f.bridge();
	const params = { ...base, agent: "fx-shell", task: "Run: !`echo x >> count.txt; wc -l < count.txt`" };
	await f.run(f.tool(), bridge, params, "call-reload");
	await f.run(f.tool(), bridge, params, "call-reload"); // A reload rebuilds the tool: the memory cache is gone.
	expect(readFileSync(counter, "utf8")).toBe("x\n");
	const [a, b] = bridge.calls.map((c) => c.args);
	expect(b).toEqual(a);
});

test("D23: the production launch store reads saved launches from the session entries", () => {
	const appended: Array<[string, unknown]> = [];
	const store = sessionLaunchStore({ appendEntry: (type: string, data: unknown) => appended.push([type, data]) } as any);
	const record = { key: "k1", name: "n", agent: "fx-shell", instanceId: "i", revision: "r", childBudget: 0, modelLabel: "default", args: { task: "T", clientRequestId: "k1" } } as any;
	store.save(record);
	expect(appended).toEqual([["pi-t3-subagents-launch", record]]);
	const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "pi-t3-subagents-launch", data: record }] } };
	expect(store.load("k1", ctx)).toEqual(record);
	expect(store.load("k2", ctx)).toBeUndefined();
});

// --- Result states.
test("result: an async child still running gives state running, a wake, no details.results", async () => {
	const result = await f.run(f.tool(), f.bridge(), { ...base, agent: "fx-leaf" });
	expect(result.structuredContent).toEqual({
		launches: [
			{
				name: "fx-check",
				agent: "fx-leaf",
				taskId: "task-1",
				childThreadId: "thread-1",
				providerInstanceId: "t3t-fx-leaf",
				model: null,
				status: "running",
				state: "running",
				wakeExpected: true,
				summary: null,
				pendingQuestion: false,
				pendingApproval: null,
			},
		],
	});
	expect(result.details).toBeUndefined();
	const text = result.content[0].text;
	expect(text).toContain("Completion wakes this thread; end your turn");
	expect(text).toContain('task_cancel {"taskId":"task-1"}');
	expect(text).toContain('t3_thread_send {"threadId":"thread-1"');
	expect(text).toContain("suppresses the wake");
});

test("result: a final status in the launch response gives state finished with the summary inline and no wake", async () => {
	const result = await f.run(f.tool(), f.bridge({ ...RUNNING, status: "completed", summary: "CHILD-OK" }), { ...base, agent: "fx-leaf" });
	const [item] = result.structuredContent.launches;
	expect(item).toMatchObject({ state: "finished", wakeExpected: false, summary: "CHILD-OK", status: "completed" });
	expect(result.content[0].text).toContain("no wake will come");
	expect(result.content[0].text).toContain("CHILD-OK");
	expect(result.details?.results).toBeUndefined();
});

test("result: a bridge error result throws with the T3 text and is recorded for the doctor (C4)", async () => {
	const outcomes: LaunchOutcome[] = [];
	const bridge = f.bridge().fail(DELEGATE, "provider instance unavailable");
	await expect(f.run(f.tool(undefined, outcomes), bridge, { ...base, agent: "fx-leaf" })).rejects.toThrow("provider instance unavailable");
	expect(outcomes[0]).toMatchObject({ ok: false, bridge: true });
});

// --- First messages.
const firstMessage = async (agent: string, task = "Say ok.") => {
	const bridge = f.bridge();
	await f.run(f.tool(), bridge, { ...base, agent, task });
	return bridge.calls[0].args.task as string;
};

test("first message: header line with budget, caller and the expected revision", async () => {
	const text = await firstMessage("fx-leaf");
	expect(text.split("\n")[0]).toBe(`<!-- pi-t3-subagents:v1 {"budget":0,"caller":"root","revision":"${revisionOf("t3t-fx-leaf")}"} -->`);
});

test("first message: a spawning agent launched from root gets its own spawn-depth as budget", async () => {
	const text = await firstMessage("fx-spawner");
	expect(text.split("\n")[0]).toBe(`<!-- pi-t3-subagents:v1 {"budget":2,"caller":"root","revision":"${revisionOf("t3t-fx-spawner")}"} -->`);
});

test("first message: replace prompt, background hint, task, summary instruction", async () => {
	const text = await firstMessage("fx-leaf");
	expect(text.split("\n").slice(1).join("\n")).toBe(`${AUTONOMOUS}\n\nSay ok.\n\n${SUMMARY}`);
});

test("first message: injected skills come first in pi-subagents' format", async () => {
	const text = await firstMessage("fx-skills");
	const skillDir = join(f.h.configDir, "skills", "tdd");
	expect(text.split("\n").slice(1).join("\n")).toBe(
		`<skill name="tdd">\nReferences are relative to ${skillDir}.\n\nbody\n</skill>\n\n${AUTONOMOUS}\n\nSay ok.\n\n${SUMMARY}`,
	);
});

test("first message: an absent system-prompt puts the agent body in as a role block", async () => {
	const text = await firstMessage("fx-nomodel");
	expect(text.split("\n").slice(1).join("\n")).toBe(`You are the no-model role.\n\n${AUTONOMOUS}\n\nSay ok.\n\n${SUMMARY}`);
});

test("first message: interactive agents get the T3 interactive hint and no summary instruction", async () => {
	const text = await firstMessage("fx-interactive");
	expect(text.split("\n").slice(1).join("\n")).toBe(`${INTERACTIVE}\n\nSay ok.`);
});

test("first message: shell expansion replaces inline and fenced blocks in the parent's cwd", async () => {
	writeFileSync(join(f.cwd, "note.txt"), "NOTE");
	const text = await firstMessage("fx-shell", "Inline: !`cat note.txt`\n```!\necho FENCED\n```");
	expect(text.split("\n").slice(1).join("\n")).toBe(`${AUTONOMOUS}\n\nInline: NOTE\nFENCED\n\n${SUMMARY}`);
});

test("first message: without task-expansion, shell blocks stay as written", async () => {
	const text = await firstMessage("fx-leaf", "Inline: !`echo X`");
	expect(text).toContain("Inline: !`echo X`");
});

test("children[] is refused until batches land (S4)", async () => {
	const bridge = f.bridge();
	await expect(f.run(f.tool(), bridge, { children: [{ ...base, agent: "fx-leaf" }] })).rejects.toThrow(/children\[\] batches are not supported/);
	expect(bridge.calls).toEqual([]);
});
