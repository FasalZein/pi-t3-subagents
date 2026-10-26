import { afterEach, expect, test } from "bun:test";
import { createExtension } from "../../index.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakeBridge } from "../harness/fake-bridge.ts";
import { FakePiHost, fakePiSubagents } from "../harness/fake-pi.ts";

const OURS = "/ext/pi-t3-subagents/index.ts";
const DELEGATE = "mcp__t3-code__delegate_task";

afterEach(() => resetCopyRegistry());

async function installedTool() {
	const env: Record<string, string | undefined> = { T3_MCP_URL: "http://x", T3_MCP_BEARER_TOKEN: "t" };
	const host = new FakePiHost();
	await host.load(OURS, createExtension(env, OURS));
	await host.load("/pkg/pi-subagents/src/index.ts", fakePiSubagents(env));
	await host.startSession();
	return host.tools.get("subagent")?.definition;
}

// The registered tool is the spike launch (S3 replaces it); these tests pin the fake
// bridge seam and the spike's bridge arguments from spike round 2.
test("the installed subagent launches through delegate_task", async () => {
	const tool = await installedTool();
	const bridge = new FakeBridge().respond(DELEGATE, () => ({
		taskId: "task-1",
		childThreadId: "thread-1",
		providerInstanceId: "pi-scout",
		model: "default",
		status: "running",
	}));
	const result = await tool.execute("call-1", { agent: "scout", task: "look", title: "t" }, undefined, undefined, bridge.toolContext());
	expect(bridge.calls).toEqual([
		{
			name: DELEGATE,
			args: { task: "look", title: "t", role: "research", mode: "async", target: { providerInstanceId: "pi-scout", model: "default", options: {} } },
		},
	]);
	expect(result.structuredContent).toEqual({ taskId: "task-1", childThreadId: "thread-1", providerInstanceId: "pi-scout", model: "default", status: "running" });
	expect(result.details).toBeUndefined();
});

test("a bridge error result throws with the T3 text", async () => {
	const tool = await installedTool();
	const bridge = new FakeBridge().fail(DELEGATE, "provider instance unavailable");
	await expect(tool.execute("call-2", { agent: "scout", task: "look" }, undefined, undefined, bridge.toolContext())).rejects.toThrow("provider instance unavailable");
});

test("a missing bridge tool throws before any call", async () => {
	const tool = await installedTool();
	const bridge = new FakeBridge();
	await expect(tool.execute("call-3", { agent: "scout", task: "look" }, undefined, undefined, bridge.toolContext())).rejects.toThrow(DELEGATE);
	expect(bridge.calls).toEqual([]);
});
