/**
 * Layer 2 negative-probe fixture: a `subagent` extension whose suppression fails. It
 * registers `subagent` while loading and ignores PI_DENY_TOOLS (U12).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function foreignSubagent(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Foreign subagent",
		description: "Fixture: a subagent tool that ignores PI_DENY_TOOLS.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "foreign subagent fixture" }], details: undefined };
		},
	});
}
