/** Managed-child tools install only in a managed child and only in the copy that owns the takeover. */
import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildRuntime } from "../../src/child-runtime.ts";
import { installManagedChildTools } from "../../src/managed-child-tools.ts";
import { installTakeover, resetCopyRegistry } from "../../src/takeover.ts";
import { FakePiHost } from "../harness/fake-pi.ts";

const FIRST = "/ext/pi-t3-subagents/index.ts";
const SECOND = "/other/copy/index.ts";
const T3 = { T3_MCP_URL: "http://127.0.0.1:1/mcp", T3_MCP_BEARER_TOKEN: "fake-token" };
const child: ChildRuntime = { state: () => undefined, observed: () => ({ promptSections: undefined, input: false }) };
const subagent = { name: "subagent", label: "subagent", description: "", parameters: {}, execute: async () => ({ content: [], details: {} }) } as any;

afterEach(() => resetCopyRegistry());

/** One copy of this extension as index.ts wires it, with one managed-child tool installer. */
function copy(copyId: string, managedChild: ChildRuntime | undefined, ran: string[]) {
	return (pi: ExtensionAPI) => {
		const takeover = installTakeover(pi, { env: { ...T3 }, copyId, tool: subagent });
		installManagedChildTools(pi, managedChild, takeover, [
			(api, owner) => {
				ran.push(copyId);
				expect(owner).toBe(child);
				api.registerTool({ name: "fx_child_tool", label: "fx", description: "", parameters: {}, execute: subagent.execute } as any);
			},
		]);
	};
}

test("two copies in a managed child: only the owning copy registers, so loading does not fail", async () => {
	const ran: string[] = [];
	const host = new FakePiHost();
	await host.load(FIRST, copy(FIRST, child, ran));
	await host.load(SECOND, copy(SECOND, child, ran));
	expect(() => host.finishLoading()).not.toThrow();
	expect(ran).toEqual([FIRST]);
	expect(host.toolSource("fx_child_tool")).toBe(FIRST);
});

test("after /reload the next runtime's first copy owns the tools again", async () => {
	const ran: string[] = [];
	const first = new FakePiHost();
	await first.load(FIRST, copy(FIRST, child, ran));
	await first.startSession();
	await first.shutdown();
	const next = new FakePiHost();
	await next.load(SECOND, copy(SECOND, child, ran));
	await next.startSession();
	expect(ran).toEqual([FIRST, SECOND]);
	expect(next.toolSource("fx_child_tool")).toBe(SECOND);
});

test("not a managed child (a main instance): no managed-child tool", async () => {
	const ran: string[] = [];
	const host = new FakePiHost();
	await host.load(FIRST, copy(FIRST, undefined, ran));
	await host.startSession();
	expect(ran).toEqual([]);
	expect(host.tools.has("fx_child_tool")).toBe(false);
});
