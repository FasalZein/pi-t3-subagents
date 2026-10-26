/**
 * pi-t3-subagents: inside T3 Code, run pi-subagents agents as T3 child threads.
 * Spec: docs/specs/t3-subagents.md. Decisions: docs/adr/.
 *
 * This file only wires modules together; each module owns its behavior:
 * - src/takeover.ts: replaces pi-subagents' `subagent` in T3 and fails soft (ADR 0001).
 * - src/doctor.ts: `/t3-subagents-doctor` and the compatibility checks (D31).
 * - src/subagent-tool.ts + src/launch-planner.ts: the T3 `subagent` tool (S3).
 * - src/roster.ts: the agent roster for the parent model (D30).
 * - src/child-runtime.ts: env, prompt strip, header and revision check in a child (S3).
 * - src/sync-command.ts: `/t3-sync-agents` (S2); src/doctor-checks.ts: C6 and C7; src/launch-checks.ts: C4 and C8.
 *
 * Outside T3 Code (T3_MCP_URL or T3_MCP_BEARER_TOKEN unset) the extension registers no
 * tool and changes no environment; only the doctor and sync commands exist (A7).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsDir, readCatalog } from "./src/catalog.ts";
import { installChildRuntime } from "./src/child-runtime.ts";
import { syncDoctorChecks } from "./src/doctor-checks.ts";
import { bridgeToolsCheck, createDoctor, registerDoctorCommand } from "./src/doctor.ts";
import { extensionApiCheck, launchContractCheck } from "./src/launch-checks.ts";
import type { Caller } from "./src/launch-planner.ts";
import { installRoster } from "./src/roster.ts";
import { type LaunchOutcome, subagentToolFor } from "./src/subagent-tool.ts";
import { registerSyncCommand } from "./src/sync-command.ts";
import { installTakeover, isInsideT3, takeoverChecks } from "./src/takeover.ts";

type Env = Record<string, string | undefined>;

export function createExtension(env: Env = process.env, copyId: string = import.meta.url) {
	return function t3Subagents(pi: ExtensionAPI) {
		const insideT3 = isInsideT3(env);
		const doctor = createDoctor({ insideT3 });
		// The child runtime sets the agent env first, while this extension loads (D24).
		const child = insideT3 ? installChildRuntime(pi, env) : undefined;
		const caller = (): Caller => {
			const state = child?.state();
			if (!state) return { agent: null, budget: null };
			return { agent: state.agent, budget: state.budget ?? 0 };
		};
		let lastLaunch: LaunchOutcome | undefined;
		const tool = subagentToolFor(pi, env as NodeJS.ProcessEnv, caller, (outcome) => {
			lastLaunch = outcome;
		});
		const takeover = installTakeover(pi, { env, copyId, tool });
		if (insideT3)
			installRoster(pi, () => ({
				agents: readCatalog(agentsDir(env as NodeJS.ProcessEnv)).agents,
				callerAgent: child?.state()?.agent ?? null,
				enabled: takeover.state().kind === "registered",
			}));
		for (const check of takeoverChecks(takeover)) doctor.register(check);
		doctor.register(bridgeToolsCheck(pi));
		doctor.register(launchContractCheck(() => lastLaunch));
		doctor.register(extensionApiCheck(pi, child));
		for (const check of syncDoctorChecks(env)) doctor.register(check);
		registerDoctorCommand(pi, doctor);
		registerSyncCommand(pi, env); // A7: registered whenever the extension loads, also outside T3.
	};
}

export default createExtension();
