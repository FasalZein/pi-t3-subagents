/**
 * pi-t3-subagents: inside T3 Code, run pi-subagents agents as T3 child threads.
 * Spec: docs/specs/t3-subagents.md. Decisions: docs/adr/.
 *
 * This file only wires modules together; each module owns its behavior:
 * - src/takeover.ts: replaces pi-subagents' `subagent` in T3 and fails soft (ADR 0001).
 * - src/doctor.ts: `/t3-subagents-doctor` and the compatibility checks (D31).
 * - src/subagent-tool.ts: the T3 `subagent` tool (spike version until S3).
 *
 * Outside T3 Code (T3_MCP_URL or T3_MCP_BEARER_TOKEN unset) the extension registers no
 * tool and changes no environment; only the doctor command exists (A7).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bridgeToolsCheck, createDoctor, registerDoctorCommand } from "./src/doctor.ts";
import { installTakeover, isInsideT3, takeoverChecks } from "./src/takeover.ts";
import { subagentTool } from "./src/subagent-tool.ts";

type Env = Record<string, string | undefined>;

export function createExtension(env: Env = process.env, copyId: string = import.meta.url) {
	return function t3Subagents(pi: ExtensionAPI) {
		const insideT3 = isInsideT3(env);
		const doctor = createDoctor({ insideT3 });
		const takeover = installTakeover(pi, { env, copyId, tool: subagentTool });
		for (const check of takeoverChecks(takeover)) doctor.register(check);
		doctor.register(bridgeToolsCheck(pi));
		registerDoctorCommand(pi, doctor);
	};
}

export default createExtension();
