/**
 * Doctor checks of the launch side (D31):
 * - C4: `delegate_task` contract, reported from the last launch in this session.
 * - C8: the Pi extension API features the child runtime and the guard rely on.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildRuntime } from "./child-runtime.ts";
import type { CompatibilityCheck } from "./doctor.ts";
import type { LaunchOutcome } from "./subagent-tool.ts";

export function launchContractCheck(last: () => LaunchOutcome | undefined): CompatibilityCheck {
	return {
		id: "C4",
		contract: "delegate_task input, default model, options, clientRequestId, result at structuredContent.structuredContent",
		run() {
			const outcome = last();
			if (!outcome) return { status: "pass", detail: "no launch in this session yet; nothing to report" };
			if (outcome.ok) {
				const item = outcome.items[0];
				return { status: "pass", detail: `last launch at ${outcome.at}: task ${item?.taskId} on ${item?.providerInstanceId}, state ${item?.state}` };
			}
			return outcome.bridge
				? { status: "fail", detail: `last launch at ${outcome.at} failed at the bridge: ${outcome.error}` }
				: { status: "pass", detail: `last launch at ${outcome.at} was refused before the bridge: ${outcome.error}` };
		},
	};
}

const API_METHODS = ["on", "registerTool", "setActiveTools", "getActiveTools", "getAllTools", "sendMessage"] as const;

export function extensionApiCheck(pi: ExtensionAPI, child: ChildRuntime | undefined): CompatibilityCheck {
	return {
		id: "C8",
		contract: "Pi extension API: before_agent_start prompt sections, input transform, tool_call parentToolCallId, setActiveTools, registerTool",
		run() {
			const missing = API_METHODS.filter((name) => typeof (pi as any)[name] !== "function");
			if (missing.length > 0) return { status: "fail", detail: `missing extension API methods: ${missing.join(", ")}` };
			if (!child) return { status: "pass", detail: "API methods present (root thread; child runtime inactive)" };
			const seen = child.observed();
			if (seen.promptSections === false)
				return { status: "fail", detail: "before_agent_start has no systemPromptOptions: the frontmatter cannot be removed from the prompt" };
			const state = child.state();
			return {
				status: "pass",
				detail: `API methods present; prompt sections ${seen.promptSections === undefined ? "not observed yet" : "seen"}; header ${state?.source ?? "not read yet"}`,
			};
		},
	};
}
