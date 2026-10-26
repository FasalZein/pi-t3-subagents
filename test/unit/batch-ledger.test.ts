/**
 * Layer 1: children[] batches, synchronous launches and the live-children ledger (spec S4,
 * "Launch flow" steps 2, 5, 6, "Live-children ledger", D11, D20, D21, D32, C5).
 * Expected values come from the spec and the T3 facts (wake text, result shapes).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { launchKey } from "../../src/launch-planner.ts";
import { FAIL_OPEN_NOTICE, installLedger, Ledger, MAX_SPAWN_WIDTH, parseWake, TASK_CANCEL, TASK_STATUS, THREAD_READ, THREAD_SEND, wakeFormatCheck, widthFor } from "../../src/ledger.ts";
import { createSubagentTool, type LaunchOutcome } from "../../src/subagent-tool.ts";
import { FakeBridge } from "../harness/fake-bridge.ts";
import { FakePiHost } from "../harness/fake-pi.ts";
import { DELEGATE, type LaunchFixture, launchFixture } from "./launch-helpers.ts";

let f: LaunchFixture;

beforeEach(() => {
	f = launchFixture();
	f.h.agent("fx-leaf", "name: fx-leaf\ndescription: Leaf\nmodel: cpa/claude-haiku-5-5\nthinking: low\nsystem-prompt: replace");
	f.h.agent("fx-sync", "name: fx-sync\ndescription: Sync\nmodel: cpa/claude-haiku-5-5\nthinking: low\nasync: false\ntimeout: 120\nsystem-prompt: replace");
	f.h.agent("fx-ask", "name: fx-ask\ndescription: Interactive\nmodel: cpa/claude-haiku-5-5\nthinking: low\nmode: interactive\nauto-exit: false\nsystem-prompt: replace");
	f.sync();
});
afterEach(() => f.h.cleanup());

const child = (name: string, agent = "fx-leaf", task = "Say ok.") => ({ name, title: `Title ${name}`, task, agent });

/** A delegate result shaped like T3's (contracts.ts:183-215) for one child, keyed by title. */
const delegateResult = (n: number, extra: Record<string, unknown> = {}) => ({
	taskId: `task-${n}`,
	childThreadId: `thread-${n}`,
	providerInstanceId: "t3t-fx-leaf",
	model: null,
	status: "running",
	summary: null,
	hasPendingQuestion: false,
	pendingApproval: null,
	waitTimedOut: false,
	...extra,
});

function toolWith(ledger: Ledger, outcomes: LaunchOutcome[] = []) {
	return createSubagentTool({
		env: f.h.env,
		caller: () => ({ agent: null, budget: null }),
		thinkingLevel: () => "medium",
		hostFacts: () => f.host,
		onOutcome: (o) => outcomes.push(o),
		launchStore: { load: (key) => f.saved.filter((r) => r.key === key).at(-1), save: (record) => f.saved.push(record) },
		ledger,
	});
}

const width = (n: number) => new Ledger(() => n);
/** Task number from the child name: "fx-c1" -> 1. */
const numberOf = (args: any) => Number(/(\d+)$/.exec(args.title)![1]);
const bridgeFor = (respond: (args: any) => unknown) => new FakeBridge().respond(DELEGATE, respond);

// --- Batch validation and width (steps 1, 2).

test("batch: one invalid child means no bridge call and no reservation left", async () => {
	const ledger = width(16);
	const bridge = bridgeFor((a) => delegateResult(numberOf(a)));
	const params = { children: [child("fx-c1"), { ...child("fx-c2"), agent: "fx-nope" }, child("fx-c3")] };
	await expect(f.run(toolWith(ledger), bridge, params)).rejects.toThrow(/agent 'fx-nope' does not exist/);
	expect(bridge.calls).toEqual([]);
	expect(ledger.snapshot()).toMatchObject({ live: [], reserved: 0 });
});

test("batch: a batch larger than the free width fails before launch", async () => {
	const ledger = width(2);
	const tool = toolWith(ledger);
	await f.run(tool, bridgeFor((a) => delegateResult(numberOf(a))), { children: [child("fx-c1")] }, "call-a");
	const bridge = bridgeFor((a) => delegateResult(numberOf(a)));
	await expect(f.run(tool, bridge, { children: [child("fx-c2"), child("fx-c3")] }, "call-b")).rejects.toThrow(
		/spawn width is full: 1 live and 0 reserved children, 2 new, width 2/,
	);
	expect(bridge.calls).toEqual([]);
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "task-1" }] });
});

test("batch: two parallel subagent calls with width 1 start one child and refuse the other", async () => {
	const ledger = width(1);
	const tool = toolWith(ledger);
	const bridge = bridgeFor((a) => delegateResult(numberOf(a)));
	const results = await Promise.allSettled([
		f.run(tool, bridge, { ...child("fx-c1") }, "call-a"),
		f.run(tool, bridge, { ...child("fx-c2") }, "call-b"),
	]);
	expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
	expect(String((results[1] as PromiseRejectedResult).reason.message)).toMatch(/spawn width is full/);
	expect(bridge.calls.length).toBe(1);
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "task-1" }] });
});

test("batch: each child gets its own launch key (tool call id, child index, request)", async () => {
	const bridge = bridgeFor((a) => delegateResult(numberOf(a)));
	const children = [child("fx-c1"), child("fx-c2")];
	const result = await f.run(toolWith(width(16)), bridge, { children });
	expect(bridge.calls.map((c) => c.args.clientRequestId)).toEqual([launchKey("call-1", 0, children[0]!), launchKey("call-1", 1, children[1]!)]);
	expect(result.structuredContent.launches.map((i: any) => i.taskId)).toEqual(["task-1", "task-2"]);
	expect(result.details).toBeUndefined();
});

test("batch: children[] together with a top-level launch is refused before the bridge", async () => {
	const bridge = bridgeFor((a) => delegateResult(numberOf(a)));
	await expect(f.run(toolWith(width(16)), bridge, { ...child("fx-c0"), children: [child("fx-c1")] })).rejects.toThrow(/either children\[\] or one launch/);
	expect(bridge.calls).toEqual([]);
});

// --- Mid-batch failure (step 6).

test("batch: the bridge fails the second of three; the first stays started, the third is never sent, reservations released", async () => {
	const ledger = width(16);
	const outcomes: LaunchOutcome[] = [];
	const bridge = bridgeFor((a) => (numberOf(a) === 2 ? { __mcpError: "provider_unavailable: instance t3t-fx-leaf" } : delegateResult(numberOf(a))));
	const error = await f.run(toolWith(ledger, outcomes), bridge, { children: [child("fx-c1"), child("fx-c2"), child("fx-c3")] }).catch((e) => e);
	expect(error.message).toContain("child 2 'fx-c2' (agent fx-leaf) failed");
	expect(error.message).toContain("provider_unavailable");
	expect(error.message).toContain("fx-c1 (fx-leaf): taskId=task-1 childThreadId=thread-1");
	expect(error.message).toContain("Completion wakes this thread");
	expect(error.message).toContain("Not sent: fx-c3.");
	expect(bridge.calls.map((c) => c.args.title)).toEqual(["Title fx-c1", "Title fx-c2"]);
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "task-1", childThreadId: "thread-1" }] });
	expect(outcomes[0]).toMatchObject({ ok: false, bridge: true });
});

// --- Synchronous children (step 5, D20, A3).

test("batch: two synchronous children and one asynchronous child all start before any wait is awaited; states and texts", async () => {
	const ledger = width(16);
	let open!: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	const bridge = bridgeFor(async (a) => {
		const n = numberOf(a);
		if (a.mode === "async") return delegateResult(n);
		await gate;
		if (n === 1) return delegateResult(n, { status: "completed", summary: "SYNC-ONE-DONE" });
		if (n === 3) return delegateResult(n, { status: "waiting", hasPendingQuestion: true });
		return delegateResult(n, { status: "running", waitTimedOut: true });
	});
	const run = f.run(toolWith(ledger), bridge, {
		children: [child("fx-c1", "fx-sync"), child("fx-c2"), child("fx-c3", "fx-sync"), child("fx-c4", "fx-sync")],
	});
	// Every child was sent while the synchronous waits are still open.
	for (let i = 0; i < 20 && bridge.calls.length < 4; i++) await new Promise((r) => setTimeout(r, 5));
	expect(bridge.calls.map((c) => [c.args.title, c.args.mode, c.args.timeoutMs])).toEqual([
		["Title fx-c1", "wait", 120_000],
		["Title fx-c2", "async", undefined],
		["Title fx-c3", "wait", 120_000],
		["Title fx-c4", "wait", 120_000],
	]);
	open();
	const result = await run;
	const items = result.structuredContent.launches;
	expect(items.map((i: any) => [i.name, i.state, i.wakeExpected])).toEqual([
		["fx-c1", "finished", false],
		["fx-c2", "running", true],
		["fx-c3", "waiting", true],
		["fx-c4", "wait_timed_out", true],
	]);
	expect(items[0].summary).toBe("SYNC-ONE-DONE");
	const blocks = result.content[0].text.split("\n\n");
	expect(blocks[0]).toContain("no wake will come");
	expect(blocks[0]).toContain("SYNC-ONE-DONE");
	expect(blocks[1]).toContain("Completion wakes this thread");
	expect(blocks[2]).toContain("waits for input in its thread");
	// U19 (live S4): a completion wake follows a wait that ended on a question.
	expect(blocks[2]).toContain("When the child finishes, a completion wake comes");
	expect(blocks[3]).toContain("The child still runs; a wake comes when it finishes.");
	// The finished child released its slot; the others are live.
	expect(ledger.snapshot().live.map((t) => t.taskId).sort()).toEqual(["task-2", "task-3", "task-4"]);
	expect(ledger.snapshot().reserved).toBe(0);
});

test("batch: an exact retry after a reload resends every child's saved launch (per-index store recovery)", async () => {
	const children = [child("fx-c1"), child("fx-c2")];
	const first = bridgeFor((a) => delegateResult(numberOf(a)));
	await f.run(toolWith(width(16)), first, { children }, "call-r");
	// The agent file is gone: a new preparation would fail, the saved launches still resend.
	rmSync(join(f.h.agentsDir, "fx-leaf.md"));
	const retry = bridgeFor((a) => delegateResult(numberOf(a)));
	await f.run(toolWith(width(16)), retry, { children }, "call-r");
	expect(retry.calls.map((c) => c.args)).toEqual(first.calls.map((c) => c.args));
});

// --- Ledger transitions (table "Live-children ledger").

test("ledger: launch responses: non-final becomes live, final releases, error releases", () => {
	const ledger = width(3);
	const [a, b, c] = ledger.reserve(3);
	ledger.settle(a!, { taskId: "t1", childThreadId: "th1", status: "running" });
	ledger.settle(b!, { taskId: "t2", childThreadId: "th2", status: "completed" });
	ledger.release(c!);
	ledger.release(c!); // idempotent
	ledger.settle(a!, { taskId: "t9", childThreadId: "th9", status: "running" }); // idempotent: reservation already used
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "t1", childThreadId: "th1" }] });
});

test("wake parse: full form with several tasks, short form and not-found form", () => {
	const text = [
		"Delegated task t1 (Scout the auth flow) [completed]:\nSCOUT-OK",
		"Delegated task t2 [failed]:\nboom",
		"Delegated task t3 (Long one) [completed]. Use task_status with taskId t3 to read the result.",
		"Delegated task t4 reached a terminal state",
	].join("\n\n");
	expect(parseWake(text)).toEqual({ wake: true, taskIds: ["t1", "t2", "t3", "t4"], noticeIds: [] });
	expect(parseWake("hello")).toEqual({ wake: false, taskIds: [], noticeIds: [] });
});

test("wake parse: T3's continuation forms for one and several tasks", () => {
	expect(parseWake("Delegated task t1 reached a terminal state. Use task_status with taskId t1 to read the result.").taskIds).toEqual(["t1"]);
	expect(parseWake("Delegated tasks t1, t2 reached terminal states. Use task_status with each taskId to read the results.").taskIds).toEqual(["t1", "t2"]);
});

test("ledger: a question notice (live U19 text) is readable and keeps the task live; no fail-open", async () => {
	const ledger = liveLedger(1);
	const host = await ledgerHost(ledger, new FakeBridge());
	// Text as observed in the live S4 run (parent session), ids shortened.
	await host.emit("input", {
		text: "Delegated task t1 is blocked on a question and cannot continue until it is answered. Read it with t3_pending_request_read using threadId th1 and requestId r1.",
		source: "rpc",
	});
	await host.emit("input", { text: "Delegated task t1 asked a question and is still working.", source: "rpc" });
	expect(liveIds(ledger)).toEqual(["t1"]);
	expect(ledger.snapshot().enforcing).toBe(true);
	expect(host.notifications).toEqual([]);
});

/** A FakePiHost with the ledger wired and the (deferred) bridge tools; `extra` loads after it. */
async function ledgerHost(ledger: Ledger, bridge: FakeBridge, extra?: (pi: ExtensionAPI) => void) {
	const host = new FakePiHost();
	await host.load("/ext/index.ts", (pi: ExtensionAPI) => installLedger(pi as any, ledger));
	if (extra) await host.load("/other/index.ts", extra);
	bridge.installOn(host);
	await host.startSession();
	return host;
}
/** The model reaches the deferred bridge tools through codemode: a nested call with parentToolCallId. */
const call = (host: FakePiHost, name: string, args: unknown) => host.callTool(name, args, { parentToolCallId: "codemode-call" });

/** A ledger with live tasks t1..tn on threads th1..thn. */
function liveLedger(n: number, limit = 16) {
	const ledger = width(limit);
	ledger.reserve(n).forEach((r, i) => ledger.settle(r, { taskId: `t${i + 1}`, childThreadId: `th${i + 1}`, status: "running" }));
	return ledger;
}
const liveIds = (ledger: Ledger) => ledger.snapshot().live.map((t) => t.taskId);

test("ledger: a raw-input wake with several tasks (full and short form) removes them; other tasks stay", async () => {
	const ledger = liveLedger(3);
	const host = await ledgerHost(ledger, new FakeBridge());
	await host.emit("input", { text: "Delegated task t1 (A) [completed]:\nok\n\nDelegated task t3 (C) [completed]. Use task_status with taskId t3 to read the result.", source: "rpc" });
	expect(liveIds(ledger)).toEqual(["t2"]);
	expect(host.notifications).toEqual([]);
});

test("ledger: an unreadable wake fails open with a notice; width is no longer enforced; doctor C5 fails", async () => {
	const ledger = liveLedger(1, 1);
	const host = await ledgerHost(ledger, new FakeBridge());
	expect(() => ledger.reserve(1)).toThrow(/spawn width is full/);
	await host.emit("input", { text: "Delegated task t1 finished with a new format", source: "rpc" });
	expect(host.notifications).toEqual([{ message: FAIL_OPEN_NOTICE, level: "warning" }]);
	expect(ledger.reserve(2)).toHaveLength(2);
	expect((await wakeFormatCheck(ledger).run()).status).toBe("fail");
	// The notice is given once.
	await host.emit("input", { text: "Delegated task ??", source: "rpc" });
	expect(host.notifications).toHaveLength(1);
});

test("ledger: doctor C5 passes while wakes are readable", async () => {
	const result = await wakeFormatCheck(liveLedger(1)).run();
	expect(result.status).toBe("pass");
	expect(result.detail).toContain("1 live");
});

test("ledger: task_cancel result removes the task (any status)", async () => {
	const ledger = liveLedger(2);
	const host = await ledgerHost(ledger, new FakeBridge().respond(TASK_CANCEL, (a) => ({ taskId: a.taskId, status: "cancel_requested" })));
	await call(host, TASK_CANCEL, { taskId: "t2" });
	expect(liveIds(ledger)).toEqual(["t1"]);
});

test("ledger: task_status removes a task only on a final status", async () => {
	const ledger = liveLedger(2);
	const status = new Map([["t1", "running"], ["t2", "completed"]]);
	const host = await ledgerHost(ledger, new FakeBridge().respond(TASK_STATUS, (a) => delegateResult(Number(a.taskId.slice(1)), { taskId: a.taskId, status: status.get(a.taskId) })));
	await call(host, TASK_STATUS, { taskId: "t1" });
	await call(host, TASK_STATUS, { taskId: "t2" });
	expect(liveIds(ledger)).toEqual(["t1"]);
});

test("ledger: t3_thread_read with a final status removes the tasks of that child thread", async () => {
	const ledger = liveLedger(2);
	const host = await ledgerHost(ledger, new FakeBridge().respond(THREAD_READ, (a) => ({ threadId: a.threadId, status: "completed", items: [] })));
	await call(host, THREAD_READ, { threadId: "th1" });
	expect(liveIds(ledger)).toEqual(["t2"]);
});

test("ledger: t3_thread_send to a known child reserves a slot; a new task id becomes live", async () => {
	const ledger = liveLedger(1, 2);
	// The child finished: its wake removed it, the thread stays known.
	ledger.observeInput("Delegated task t1 (A) [completed]:\nok");
	let seen: unknown;
	const bridge = new FakeBridge().respond(THREAD_SEND, (a) => {
		seen = ledger.snapshot().reserved;
		return { threadId: a.threadId, taskId: "t5", status: "running", delivery: "started" };
	});
	const host = await ledgerHost(ledger, bridge);
	await call(host, THREAD_SEND, { threadId: "th1", message: "continue" });
	expect(seen).toBe(1);
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "t5", childThreadId: "th1" }] });
});

test("ledger: t3_thread_send without a task id, or with an error, releases the reservation", async () => {
	const ledger = liveLedger(1);
	const host = await ledgerHost(ledger, new FakeBridge().respond(THREAD_SEND, (a) => ({ threadId: a.threadId, status: "running", delivery: "steered" })));
	await call(host, THREAD_SEND, { threadId: "th1", message: "steer" });
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "t1" }] });
	const failing = await ledgerHost(ledger, new FakeBridge().fail(THREAD_SEND, "thread_not_sendable"));
	await call(failing, THREAD_SEND, { threadId: "th1", message: "again" });
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "t1" }] });
});

test("ledger: t3_thread_send to a known child is blocked when the width is full; an unknown thread is not counted", async () => {
	const ledger = liveLedger(1, 1);
	const bridge = new FakeBridge().respond(THREAD_SEND, (a) => ({ threadId: a.threadId, taskId: "t7", status: "running", delivery: "started" }));
	const host = await ledgerHost(ledger, bridge);
	const blocked = await call(host, THREAD_SEND, { threadId: "th1", message: "more" });
	expect(blocked.blocked).toMatch(/t3_thread_send blocked: spawn width is full/);
	expect(bridge.calls).toEqual([]);
	const other = await call(host, THREAD_SEND, { threadId: "some-top-level-thread", message: "hi" });
	expect(other.blocked).toBeUndefined();
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "t1" }] });
});

test("ledger: a send reservation is released when another handler blocks the call", async () => {
	const ledger = liveLedger(1, 2);
	ledger.observeInput("Delegated task t1 (A) [completed]:\nok");
	const host = await ledgerHost(ledger, new FakeBridge().respond(THREAD_SEND, () => ({ taskId: "t8", status: "running" })), (pi) =>
		pi.on("tool_call", () => ({ block: true, reason: "guard" })),
	);
	const out = await call(host, THREAD_SEND, { threadId: "th1", message: "more" });
	expect(out.blocked).toBe("guard");
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [] });
});

// --- Review fixes (slice review of 9d2efa9).

test("review F1: a final response for a task that is already live ends it (terminal replay)", () => {
	const ledger = width(2);
	const [first] = ledger.reserve(1);
	ledger.settle(first!, { taskId: "same", childThreadId: "child", status: "running" });
	const [again] = ledger.reserve(1);
	ledger.settle(again!, { taskId: "same", childThreadId: "child", status: "completed" });
	expect(ledger.snapshot()).toMatchObject({ live: [], reserved: 0 });
});

test("review F1: a wake or a cancel before the delayed running response keeps the task ended", async () => {
	const ledger = width(2);
	const [a, b] = ledger.reserve(2);
	ledger.observeInput("Delegated task fast [completed]:\nreply");
	ledger.settle(a!, { taskId: "fast", childThreadId: "fast-child", status: "running" });
	const host = await ledgerHost(ledger, new FakeBridge().respond(TASK_CANCEL, (x) => ({ taskId: x.taskId, status: "cancel_requested" })));
	await call(host, TASK_CANCEL, { taskId: "slow" });
	ledger.settle(b!, { taskId: "slow", childThreadId: "slow-child", status: "running" });
	expect(ledger.snapshot()).toMatchObject({ live: [], reserved: 0 });
});

test("review F2: a delayed terminal t3_thread_read does not remove a continuation sent during the read", async () => {
	const ledger = width(1);
	const [old] = ledger.reserve(1);
	ledger.settle(old!, { taskId: "old", childThreadId: "child", status: "completed" });
	let entered!: () => void;
	let release!: () => void;
	const inRead = new Promise<void>((r) => (entered = r));
	const gate = new Promise<void>((r) => (release = r));
	const bridge = new FakeBridge()
		.respond(THREAD_READ, async () => {
			entered();
			await gate;
			return { thread: { status: "completed" }, items: [] };
		})
		.respond(THREAD_SEND, () => ({ threadId: "child", taskId: "new", status: "running", delivery: "started" }));
	const host = await ledgerHost(ledger, bridge);
	const read = call(host, THREAD_READ, { threadId: "child" });
	await inRead;
	await call(host, THREAD_SEND, { threadId: "child", message: "continue" });
	release();
	await read;
	expect(liveIds(ledger)).toEqual(["new"]);
	expect(() => ledger.reserve(1)).toThrow(/spawn width is full/);
});

test("review F3: an exact retry at full width reaches T3 (replay) and charges no second slot; a changed request is refused", async () => {
	const ledger = width(1);
	const tool = toolWith(ledger);
	const bridge = bridgeFor(() => delegateResult(1));
	const params = child("fx-c1");
	await f.run(tool, bridge, params, "same-call");
	const retry = await f.run(tool, bridge, params, "same-call");
	expect(retry.structuredContent.launches[0].taskId).toBe("task-1");
	expect(bridge.calls.map((c) => c.args.clientRequestId)).toEqual([launchKey("same-call", 0, params), launchKey("same-call", 0, params)]);
	expect(ledger.snapshot()).toMatchObject({ reserved: 0, live: [{ taskId: "task-1" }] });
	await expect(f.run(tool, bridge, { ...params, task: "Say ok twice." }, "same-call")).rejects.toThrow(/spawn width is full/);
	expect(bridge.calls).toHaveLength(2);
});

test("review F3: retrying a full-width batch after a mid-batch failure reserves only the child that did not start", async () => {
	const ledger = width(2);
	const tool = toolWith(ledger);
	let fail = true;
	const bridge = bridgeFor((a) => (numberOf(a) === 2 && fail ? { __mcpError: "provider_unavailable" } : delegateResult(numberOf(a))));
	const children = [child("fx-c1"), child("fx-c2")];
	await expect(f.run(tool, bridge, { children }, "batch-call")).rejects.toThrow(/child 2 'fx-c2'/);
	fail = false;
	const result = await f.run(tool, bridge, { children }, "batch-call");
	expect(result.structuredContent.launches.map((i: any) => i.taskId)).toEqual(["task-1", "task-2"]);
	expect(liveIds(ledger).sort()).toEqual(["task-1", "task-2"]);
});

test("review F4: a partial failure keeps a finished child's reply inline and does not promise its wake", async () => {
	const bridge = bridgeFor((a) =>
		numberOf(a) === 1 ? delegateResult(1, { status: "completed", summary: "IMPORTANT-INLINE-REPLY" }) : numberOf(a) === 2 ? delegateResult(2) : { __mcpError: "provider_unavailable" },
	);
	const children = [child("fx-c1", "fx-sync"), child("fx-c2"), child("fx-c3")];
	const error = await f.run(toolWith(width(16)), bridge, { children }).catch((e) => e);
	const [, finished, running] = error.message.split(/\n\n(?=fx-c\d \()/);
	expect(finished).toContain("IMPORTANT-INLINE-REPLY");
	expect(finished).toContain("no wake will come");
	expect(finished).not.toContain("Completion wakes");
	expect(running).toContain("taskId=task-2");
	expect(running).toContain("Completion wakes this thread");
});

test("review F5: a malformed spawn-width is refused; absent or root gives 16; oversized is capped at 16", async () => {
	for (const bad of ["two", "-1", "2.5", "0", ""]) expect(() => widthFor("fx-spawner", bad)).toThrow(/spawn-width must be a positive safe integer/);
	expect(widthFor("fx-spawner", undefined)).toBe(MAX_SPAWN_WIDTH);
	expect(widthFor(null, "two")).toBe(MAX_SPAWN_WIDTH);
	expect(widthFor("fx-spawner", "99")).toBe(MAX_SPAWN_WIDTH);
	expect(widthFor("fx-spawner", "3")).toBe(3);
	const bridge = bridgeFor((a) => delegateResult(numberOf(a)));
	const tool = toolWith(new Ledger(() => widthFor("fx-spawner", "two")));
	await expect(f.run(tool, bridge, child("fx-c1"))).rejects.toThrow(/subagent launch refused: agent 'fx-spawner' has spawn-width "two"/);
	expect(bridge.calls).toEqual([]);
});

test("review F6: lifecycle guidance names the public bridge tools and their codemode spellings; ledger events keep the public names", async () => {
	const result = await f.run(toolWith(width(16)), bridgeFor((a) => delegateResult(numberOf(a))), child("fx-c1"));
	const text = result.content[0].text;
	expect(text).toContain('mcp__t3-code__task_cancel {"taskId":"task-1"} (codemode: tools.mcp__t3_code__task_cancel({"taskId":"task-1"}))');
	expect(text).toContain('mcp__t3-code__t3_thread_send {"threadId":"thread-1","message":"..."} (codemode: tools.mcp__t3_code__t3_thread_send(');
	expect(text).toContain('mcp__t3-code__task_status {"taskId":"task-1"} (codemode: tools.mcp__t3_code__task_status(');
	expect([TASK_CANCEL, TASK_STATUS, THREAD_SEND, THREAD_READ]).toEqual([
		"mcp__t3-code__task_cancel",
		"mcp__t3-code__task_status",
		"mcp__t3-code__t3_thread_send",
		"mcp__t3-code__t3_thread_read",
	]);
});

test("owner decision (S8): interactive and asking children tell the parent that the user answers in the child thread", async () => {
	const ANSWER = "The user answers in the child thread. Do not ask the question again and do not relay it; end your turn.";
	const bridge = bridgeFor((a) => (a.mode === "wait" ? delegateResult(numberOf(a), { hasPendingQuestion: true }) : delegateResult(numberOf(a))));
	const result = await f.run(toolWith(width(16)), bridge, { children: [child("fx-c1", "fx-ask"), child("fx-c2", "fx-sync"), child("fx-c3")] });
	const blocks = result.content[0].text.split("\n\n");
	expect(blocks[0]).toContain(ANSWER); // interactive, running
	expect(blocks[1]).toContain(ANSWER); // synchronous, waiting on a question
	expect(blocks[2]).not.toContain(ANSWER); // background leaf
});
