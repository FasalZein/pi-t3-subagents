/** Layer 1 S6: caller_ping only in managed children; after a ping, the run refuses other tool calls. */
import { afterEach, expect, test } from "bun:test";
import { createExtension } from "../../index.ts";
import { CALLER_PING_LINE, CALLER_PING_TOOL, installCallerPing } from "../../src/caller-ping.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakePiHost, fakePiSubagents } from "../harness/fake-pi.ts";

const OURS = "/ext/pi-t3-subagents/index.ts";
const SECOND = "/other/copy/index.ts";
const PI_SUBAGENTS = "/ext/pi-subagents/src/subagents.ts";
const T3 = { T3_MCP_URL: "http://127.0.0.1:1/mcp", T3_MCP_BEARER_TOKEN: "fake-token", PI_T3_AGENTS_DIR: "/nonexistent/pi-t3-subagents-test/agents" };
const MANAGED = { ...T3, PI_T3_AGENT: "fx-leaf", PI_T3_NAMESPACE: "t3e2e-s6-" };
const PING = "Which database should I migrate: staging or prod?";

afterEach(() => resetCopyRegistry());

async function loaded(env: Record<string, string | undefined>, copies = [OURS]) {
	const host = new FakePiHost();
	for (const copy of copies) await host.load(copy, createExtension({ ...env }, copy));
	await host.load(PI_SUBAGENTS, fakePiSubagents({ ...env }));
	await host.startSession();
	return host;
}

/** A managed child with caller_ping and two plain tools, one of which runs a nested call. */
async function child() {
	const host = new FakePiHost();
	await host.load(OURS, (pi) => installCallerPing(pi));
	host.addTool("bash", "/builtin/bash.ts", "direct", true, async () => ({ content: [{ type: "text", text: "ran" }], details: undefined }));
	host.addTool("codemode", "/builtin/codemode.ts", "direct", true, async (_id, args, _signal, _update, ctx) => {
		const nested = await ctx.executeTool(args.tool, args.args ?? {});
		return { content: nested.content, details: { nestedIsError: nested.isError } };
	});
	await host.startSession();
	await host.emit("agent_start");
	return host;
}

function text(result: any): string {
	return (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
}

test("caller_ping is registered in a managed child, through the index wiring", async () => {
	const host = await loaded(MANAGED);
	expect(host.toolSource(CALLER_PING_TOOL)).toBe(OURS);
	expect(host.active.has(CALLER_PING_TOOL)).toBe(true);
});

test("no caller_ping on a main instance inside T3 (no PI_T3_AGENT) or outside T3", async () => {
	expect((await loaded(T3)).tools.has(CALLER_PING_TOOL)).toBe(false);
	resetCopyRegistry();
	expect((await loaded({ PI_T3_AGENT: "fx-leaf" })).tools.has(CALLER_PING_TOOL)).toBe(false);
});

test("two copies of the extension in a managed child: one caller_ping, loading does not fail", async () => {
	const host = await loaded(MANAGED, [OURS, SECOND]);
	expect(host.loadErrors).toEqual([]);
	expect(host.toolSource(CALLER_PING_TOOL)).toBe(OURS);
});

test("the ping result tells the model to end the turn with a reply that starts with CALLER PING and the message", async () => {
	const host = await child();
	const ping = await host.callTool(CALLER_PING_TOOL, { message: PING });
	expect(ping.isError).toBe(false);
	const result = text(ping.result);
	expect(result).toContain("End your turn now");
	expect(result).toContain(`start with the line ${CALLER_PING_LINE}`);
	expect(result).toContain(PING);
	expect(ping.result.details).toEqual({ message: PING });
});

test("before a ping, other tools run", async () => {
	const host = await child();
	const call = await host.callTool("bash", { command: "ls" });
	expect(call.blocked).toBeUndefined();
	expect(call.isError).toBe(false);
});

test("after a ping, every other tool call in that run is refused with the ping reason", async () => {
	const host = await child();
	await host.callTool(CALLER_PING_TOOL, { message: PING });
	const bash = await host.callTool("bash", { command: "ls" });
	expect(bash.isError).toBe(true);
	expect(bash.blocked).toContain(CALLER_PING_TOOL);
	expect(bash.blocked).toContain(PING);
	expect(bash.blocked).toContain(CALLER_PING_LINE);
	const again = await host.callTool(CALLER_PING_TOOL, { message: "second" });
	expect(again.blocked).toContain(PING);
});

test("a nested call after the ping is refused too (codemode cannot bypass the latch)", async () => {
	const host = await child();
	await host.callTool(CALLER_PING_TOOL, { message: PING });
	const before = host.toolEvents.length;
	const script = await host.callTool("codemode", { tool: "bash", args: { command: "ls" } });
	expect(script.blocked).toContain(PING);
	expect(host.toolEvents.slice(before).some((e: any) => e.toolName === "bash")).toBe(false);
});

test("a ping from inside a codemode script latches the rest of the run", async () => {
	const host = await child();
	const script = await host.callTool("codemode", { tool: CALLER_PING_TOOL, args: { message: PING } });
	expect(script.result.details.nestedIsError).toBe(false);
	expect((await host.callTool("bash", { command: "ls" })).blocked).toContain(PING);
});

test("the next run (the caller continues the thread) can call tools again", async () => {
	const host = await child();
	await host.callTool(CALLER_PING_TOOL, { message: PING });
	await host.emit("agent_end", { messages: [] });
	await host.emit("agent_start");
	expect((await host.callTool("bash", { command: "ls" })).blocked).toBeUndefined();
});

test("agent_start alone resets the latch (a run whose agent_end was missed)", async () => {
	const host = await child();
	await host.callTool(CALLER_PING_TOOL, { message: PING });
	await host.emit("agent_start");
	expect((await host.callTool("bash", { command: "ls" })).blocked).toBeUndefined();
});

test("session_shutdown clears the latch", async () => {
	const host = await child();
	await host.callTool(CALLER_PING_TOOL, { message: PING });
	await host.shutdown();
	expect((await host.callTool("bash", { command: "ls" })).blocked).toBeUndefined();
});

test("an empty message is an error result and does not latch", async () => {
	const host = await child();
	const ping = await host.callTool(CALLER_PING_TOOL, { message: "   " });
	expect(ping.isError).toBe(true);
	expect((await host.callTool("bash", { command: "ls" })).blocked).toBeUndefined();
});
