/**
 * Layer 2 child probe extension, loaded after this extension: records what a later
 * extension sees (U13 env at load, U6 prompt after the strip, U5 active tools) to PROBE_OUT.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const write = (record: object) => {
	const out = process.env.PROBE_OUT;
	if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
};

export default function childProbe(pi: ExtensionAPI) {
	write({ kind: "load", envAtLoad: process.env.FX_PROBE_VALUE ?? null });
	pi.on("before_agent_start", async (event) => {
		write({
			kind: "run",
			systemPromptHead: event.systemPrompt.slice(0, 200),
			customPromptHead: String((event as any).systemPromptOptions?.customPrompt ?? "").slice(0, 200),
			activeTools: pi.getActiveTools(),
		});
	});
}
