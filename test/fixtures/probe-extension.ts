/**
 * Layer 2 probe extension: at session start, log the pi-subagents tool names with their
 * source and active state to PROBE_OUT (one JSON line). Load it after this extension so
 * its session_start handler runs after the takeover. Prior art: spike probe.ts.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NAMES = ["subagent", "subagent_resume", "subagent_kill"];

export default function probe(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		const active = new Set(pi.getActiveTools());
		const tools = pi
			.getAllTools()
			.filter((tool) => NAMES.includes(tool.name))
			.map((tool) => ({ name: tool.name, path: tool.sourceInfo.path, active: active.has(tool.name) }));
		const out = process.env.PROBE_OUT;
		if (out) appendFileSync(out, `${JSON.stringify({ label: process.env.PROBE_LABEL, tools })}\n`);
	});
}
