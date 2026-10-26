/** Layer 1 S7: context warnings and time limit in a managed child, with a fake clock and fake context usage. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../../index.ts";
import type { ChildRuntime } from "../../src/child-runtime.ts";
import { type Clock, CONTEXT_WARNINGS_ENTRY, installRunLimits, RUN_LIMIT_ENTRY } from "../../src/run-limits.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakePiHost } from "../harness/fake-pi.ts";
import { tempHost, type TempHost } from "./sync-helpers.ts";

const OURS = "/ext/pi-t3-subagents/index.ts";
const child: ChildRuntime = { state: () => ({ agent: "fx", instanceId: "pi-fx", stale: false }), observed: () => ({ promptSections: true, input: true }) };

/** Fake timers. With `lateFire`, a cleared timer still fires (a callback already queued when it was cleared). */
class FakeClock implements Clock {
	t = 0;
	private timers: Array<{ at: number; cb: () => void; cleared: boolean; fired: boolean }> = [];
	constructor(private readonly lateFire = false) {}
	now() {
		return this.t;
	}
	setTimeout(cb: () => void, ms: number) {
		const timer = { at: this.t + ms, cb, cleared: false, fired: false };
		this.timers.push(timer);
		return timer;
	}
	clearTimeout(handle: unknown) {
		(handle as { cleared: boolean }).cleared = true;
	}
	pendingCount() {
		return this.timers.filter((x) => !x.fired && !x.cleared).length;
	}
	/** Move to absolute time `to` (ms) and fire due timers in order. */
	advanceTo(to: number) {
		for (;;) {
			const due = this.timers.filter((x) => !x.fired && (this.lateFire || !x.cleared) && x.at <= to).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.t = due.at;
			due.fired = true;
			due.cb();
		}
		this.t = to;
	}
}

interface Rig {
	host: FakePiHost;
	clock: FakeClock;
	steers: Array<{ text: string; deliverAs?: string }>;
	aborts: number[];
	usage: { percent: number };
	fields: Record<string, string>;
	ctx: Record<string, unknown>;
}

async function rig(fields: Record<string, string>, options: { lateFire?: boolean; entries?: any[] } = {}): Promise<Rig> {
	const host = new FakePiHost({ entries: options.entries });
	const clock = new FakeClock(options.lateFire);
	const steers: Rig["steers"] = [];
	const aborts: number[] = [];
	const usage = { percent: 0 };
	const r: Rig = { host, clock, steers, aborts, usage, fields, ctx: {} };
	r.ctx = {
		abort: () => aborts.push(clock.now()),
		getContextUsage: () => ({ tokens: usage.percent * 2000, contextWindow: 200_000, percent: usage.percent }),
	};
	await host.load(OURS, (pi: ExtensionAPI) => {
		const api = { ...pi, sendUserMessage: (text: string, o?: { deliverAs?: string }) => steers.push({ text, deliverAs: o?.deliverAs }) } as unknown as ExtensionAPI;
		installRunLimits(api, child, () => ({ fields: r.fields }), clock);
	});
	await host.startSession();
	return r;
}

const at = (r: Rig, seconds: number) => r.clock.advanceTo(seconds * 1000);
const runStart = (r: Rig) => r.host.emit("agent_start", {}, r.ctx);
const settle = (r: Rig) => r.host.emit("agent_settled", { aborted: false }, r.ctx);
const turnEnd = (r: Rig, percent: number, stopReason = "toolUse") => {
	r.usage.percent = percent;
	return r.host.emit("turn_end", { message: { role: "assistant", stopReason } }, r.ctx);
};
const agentEnd = (r: Rig, percent: number, stopReason = "stop") => {
	r.usage.percent = percent;
	return r.host.emit("agent_end", { messages: [{ role: "assistant", stopReason }] }, r.ctx);
};
/** Pi records a delivered steer as a user message. */
const deliver = (r: Rig, text: string) => r.host.emit("message_end", { message: { role: "user", content: [{ type: "text", text }] } }, r.ctx);

afterEach(() => resetCopyRegistry());

// --- Time limit (A10) ---

test("time limit: one wrap-up steer at timeout-warn-threshold, abort at timeout, each once", async () => {
	const r = await rig({ timeout: "100", "timeout-warn-threshold": "50%" });
	await runStart(r);
	at(r, 49.999);
	expect(r.steers).toEqual([]);
	at(r, 50);
	expect(r.steers).toHaveLength(1);
	expect(r.steers[0].deliverAs).toBe("steer");
	expect(r.steers[0].text).toContain("running for 50s, and its limit is 100s");
	expect(r.steers[0].text).toContain("About 50s remain");
	at(r, 99.999);
	expect(r.aborts).toEqual([]);
	at(r, 100);
	expect(r.aborts).toEqual([100_000]);
	expect(r.host.entries.filter((e) => e.customType === RUN_LIMIT_ENTRY)).toHaveLength(1);
	expect(r.host.notifications.at(-1)?.message).toContain("time limit (timeout: 100s)");
	at(r, 1000);
	expect(r.steers).toHaveLength(1);
	expect(r.aborts).toHaveLength(1);
});

test("timeout-warn-threshold: true means 80%; without it there is no steer, only the abort", async () => {
	const a = await rig({ timeout: "10", "timeout-warn-threshold": "true" });
	await runStart(a);
	at(a, 7.999);
	expect(a.steers).toHaveLength(0);
	at(a, 8);
	expect(a.steers).toHaveLength(1);
	resetCopyRegistry();
	const b = await rig({ timeout: "10" });
	await runStart(b);
	at(b, 20);
	expect(b.steers).toHaveLength(0);
	expect(b.aborts).toEqual([10_000]);
});

test("no timeout, or an invalid one: no timer, no steer, no abort", async () => {
	const cases: Record<string, string>[] = [{}, { timeout: "abc", "timeout-warn-threshold": "50" }, { timeout: "0" }, { timeout: "1.5" }];
	for (const fields of cases) {
		resetCopyRegistry();
		const r = await rig(fields);
		await runStart(r);
		expect(r.clock.pendingCount()).toBe(0);
		at(r, 10_000);
		expect(r.steers).toEqual([]);
		expect(r.aborts).toEqual([]);
	}
});

test("a follow-up run starts a new timer; the first run's timer is cleared at run end", async () => {
	const r = await rig({ timeout: "100", "timeout-warn-threshold": "50" });
	await runStart(r);
	at(r, 10);
	// A retry or queued steer inside the same run: agent_start again, same timer.
	await agentEnd(r, 0);
	await runStart(r);
	at(r, 30);
	await settle(r);
	expect(r.clock.pendingCount()).toBe(0);
	await runStart(r); // follow-up run at t = 30
	at(r, 79.999);
	expect(r.steers).toHaveLength(0); // run A would have warned at 50
	at(r, 80);
	expect(r.steers).toHaveLength(1);
	at(r, 129.999);
	expect(r.aborts).toEqual([]); // run A would have aborted at 100
	at(r, 130);
	expect(r.aborts).toEqual([130_000]);
});

test("run A schedules, run B starts, A's timer fires late: A cannot warn or abort B", async () => {
	const r = await rig({ timeout: "100", "timeout-warn-threshold": "50" }, { lateFire: true });
	await runStart(r);
	at(r, 10);
	await settle(r);
	await runStart(r); // B at t = 10
	at(r, 59.999); // A's warn (50) and nothing of B yet
	expect(r.steers).toHaveLength(0);
	at(r, 109.999); // A's abort (100) fired late, B's warn (60) fired
	expect(r.steers).toHaveLength(1);
	expect(r.aborts).toEqual([]);
	at(r, 110);
	expect(r.aborts).toEqual([110_000]);
});

test("session_shutdown clears the timers of the active run", async () => {
	const r = await rig({ timeout: "100", "timeout-warn-threshold": "50" });
	await runStart(r);
	await r.host.shutdown();
	expect(r.clock.pendingCount()).toBe(0);
	at(r, 1000);
	expect(r.steers).toEqual([]);
	expect(r.aborts).toEqual([]);
});

test("thresholds are read from the definition at each run start", async () => {
	const r = await rig({});
	await runStart(r);
	expect(r.clock.pendingCount()).toBe(0);
	await settle(r);
	r.fields = { timeout: "5" };
	await runStart(r);
	at(r, 5);
	expect(r.aborts).toEqual([5_000]);
});

// --- Context warnings (pi-subagents thresholds, steps and messages) ---

test("context warnings: one steer per level at threshold, threshold + step, threshold + 2 steps", async () => {
	const r = await rig({ "context-warn-threshold": "70%", "context-warn-step": "10%" });
	await runStart(r);
	await turnEnd(r, 69.9);
	expect(r.steers).toEqual([]);
	await turnEnd(r, 70);
	expect(r.steers).toHaveLength(1);
	expect(r.steers[0]).toEqual({
		deliverAs: "steer",
		text: "Your own context window is at 140K/200K tokens (70.0%); compaction is approaching. Avoid new scope and start bringing the current work to a close.",
	});
	await turnEnd(r, 75); // same level, still pending: no second steer
	await deliver(r, r.steers[0].text);
	await turnEnd(r, 79);
	expect(r.steers).toHaveLength(1);
	expect(r.host.entries.filter((e) => e.customType === CONTEXT_WARNINGS_ENTRY).at(-1)?.data).toEqual({ sentThresholds: [70] });
	await agentEnd(r, 80);
	expect(r.steers).toHaveLength(2);
	expect(r.steers[1].text).toContain("compaction is close. Wrap up now");
	await deliver(r, r.steers[1].text);
	await turnEnd(r, 90);
	expect(r.steers).toHaveLength(3);
	expect(r.steers[2].text).toContain("critically full");
	await deliver(r, r.steers[2].text);
	await turnEnd(r, 99);
	expect(r.steers).toHaveLength(3);
});

test("context warnings: a jump across levels sends only the most urgent one; the default step is 5", async () => {
	const r = await rig({ "context-warn-threshold": "80" });
	await runStart(r);
	await turnEnd(r, 91);
	expect(r.steers).toHaveLength(1);
	expect(r.steers[0].text).toContain("critically full");
	await deliver(r, r.steers[0].text);
	expect(r.host.entries.filter((e) => e.customType === CONTEXT_WARNINGS_ENTRY).at(-1)?.data).toEqual({ sentThresholds: [80, 85, 90] });
	await turnEnd(r, 95);
	expect(r.steers).toHaveLength(1);
});

test("context warnings: usage that falls below a level (compaction) re-arms it", async () => {
	const r = await rig({ "context-warn-threshold": "70", "context-warn-step": "10" });
	await runStart(r);
	await turnEnd(r, 72);
	await deliver(r, r.steers[0].text);
	await turnEnd(r, 40);
	expect(r.host.entries.filter((e) => e.customType === CONTEXT_WARNINGS_ENTRY).at(-1)?.data).toEqual({ sentThresholds: [] });
	await turnEnd(r, 71);
	expect(r.steers).toHaveLength(2);
});

test("context warnings: no check after an aborted or failed turn, nor at a tool-use agent end; an aborted run drops the pending level", async () => {
	const r = await rig({ "context-warn-threshold": "70" });
	await runStart(r);
	await turnEnd(r, 72, "aborted");
	await turnEnd(r, 72, "error");
	await agentEnd(r, 72, "toolUse");
	expect(r.steers).toEqual([]);
	await turnEnd(r, 72);
	expect(r.steers).toHaveLength(1);
	await agentEnd(r, 72, "aborted"); // the steer was never delivered
	await turnEnd(r, 73);
	expect(r.steers).toHaveLength(2);
});

test("context warnings: delivered levels survive a reload; off and invalid thresholds send nothing", async () => {
	const saved = [{ type: "custom", id: "e1", customType: CONTEXT_WARNINGS_ENTRY, data: { sentThresholds: [70] } }];
	const r = await rig({ "context-warn-threshold": "70", "context-warn-step": "10" }, { entries: saved });
	await runStart(r);
	await turnEnd(r, 75);
	expect(r.steers).toEqual([]);
	await turnEnd(r, 80);
	expect(r.steers).toHaveLength(1);
	for (const value of ["off", "0", "100", "abc"]) {
		resetCopyRegistry();
		const x = await rig({ "context-warn-threshold": value });
		await runStart(x);
		await turnEnd(x, 99);
		expect(x.steers).toEqual([]);
	}
});

// --- Wiring (index.ts slot S7) ---

let h: TempHost;
beforeEach(() => {
	h = tempHost("t3t-");
	h.agent("fx-limited", "name: fx-limited\ndescription: Limited\nmodel: cpa/claude-haiku-5-5\ntimeout: 1\nsystem-prompt: replace", "# body");
});
afterEach(() => h.cleanup());

async function loadExtension(agent?: string) {
	const env: Record<string, string | undefined> = { ...h.env, T3_MCP_URL: "http://x", T3_MCP_BEARER_TOKEN: "t", ...(agent ? { PI_T3_AGENT: agent } : {}) };
	const host = new FakePiHost();
	await host.load(OURS, createExtension(env, OURS));
	await host.startSession();
	const aborts: number[] = [];
	await host.emit("agent_start", {}, { abort: () => aborts.push(Date.now()) });
	return { host, aborts };
}

test("wiring: a managed child stops its run at the agent file's timeout; a main instance installs no timer", async () => {
	const managed = await loadExtension("fx-limited");
	const main = await loadExtension();
	await new Promise((resolve) => setTimeout(resolve, 1300));
	expect(managed.aborts).toHaveLength(1);
	expect(main.aborts).toHaveLength(0);
	await managed.host.shutdown();
	await main.host.shutdown();
});
