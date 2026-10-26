/**
 * Layer 2 S5 probe: a stand-in for T3's Pi bridge (packages/provider-pi/src/server/
 * mcpExtensionSource.ts, T3 Nightly 2026-10-26) without an MCP server. It copies the parts
 * that decide tool exposure: `direct` for orchestrator_capabilities, delegate_task and
 * task_status, `deferred` for the rest when Pi has registerMcpServer and the built-in
 * tool_search, and `reconcileDiscovery` at session_start, model_select, session_tree and
 * before_agent_start (adds tool_search; with PROBE_REACTIVATE=1 it re-activates the whole
 * catalog, as the bridge does for openai-completions models). Loaded last, like the
 * worst case for this extension's handler order.
 *
 * It also records, to PROBE_OUT, the tool names of each provider request (the model-facing
 * loadout) and the active tools at that point.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CATALOG = ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel", "t3_thread_send", "t3_thread_read", "create_threads", "t3_thread_launch", "t3_thread_fork", "schedule_task"];
const DIRECT = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);

const write = (record: object) => {
	const out = process.env.PROBE_OUT;
	if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
};

export default function fakeBridge(pi: ExtensionAPI) {
	const supportsExposure = typeof (pi as any).registerMcpServer === "function";
	const hasToolSearch = () => pi.getAllTools().some((t: any) => t.name === "tool_search");
	let defer = supportsExposure;
	const register = () => {
		for (const name of CATALOG)
			pi.registerTool({
				name: `mcp__t3-code__${name}`,
				label: name,
				description: `fake T3 bridge ${name}`,
				parameters: Type.Object({}, { additionalProperties: true }),
				...(supportsExposure ? { exposure: defer && !DIRECT.has(name) ? "deferred" : "direct" } : {}),
				async execute() {
					write({ kind: "executed", tool: name });
					return { content: [{ type: "text", text: `${name} EXECUTED` }], details: undefined };
				},
			} as any);
	};
	register();
	const reconcile = () => {
		if (!supportsExposure) return;
		const search = hasToolSearch();
		const changed = defer !== search;
		defer = search;
		if (changed) register();
		const active = pi.getActiveTools();
		const required = [...(search ? ["tool_search"] : []), ...(process.env.PROBE_REACTIVATE === "1" ? CATALOG.map((n) => `mcp__t3-code__${n}`) : [])];
		const missing = required.filter((n) => !active.includes(n));
		if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
	};
	pi.on("session_tree", async () => reconcile());
	pi.on("model_select", async () => reconcile());
	pi.on("session_start", async () => reconcile());
	pi.on("before_agent_start", async () => {
		reconcile();
		write({ kind: "after_reconcile", activeTools: pi.getActiveTools() });
	});
	pi.on("before_provider_request", async (event: any) => {
		const tools = (event?.payload?.tools ?? []).map((t: any) => t?.name ?? t?.function?.name).filter(Boolean);
		write({ kind: "request", payloadTools: tools, activeTools: pi.getActiveTools() });
	});
}
