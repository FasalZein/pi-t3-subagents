/**
 * Child tool exposure at budget 0 (spec "Spawn policy and raw-delegation guard", D22).
 *
 * Leaves lose `subagent` and the thread-starting bridge tools through their launch
 * arguments (`--exclude-tools`, src/planner.ts). A spawning agent whose exact budget is 0
 * (for example launched by a caller with budget 1) keeps them in its launch arguments, so
 * the child removes them from the active tools here.
 *
 * T3's bridge reconciles its catalog in session_start, model_select, session_tree and
 * before_agent_start, and for `openai-completions` models it re-activates every catalog
 * tool. Its handlers run after this extension's when it loads later, and Pi fixes a run's
 * tool loadout when before_agent_start ends, so a setActiveTools call at turn_start only
 * reaches the next run (real-Pi probe test/probe/s5-exposure.probe.test.ts). Two layers:
 * - setActiveTools at every reconciliation point and at turn_start (system prompt and later runs);
 * - before_provider_request removes the tools from the serialized request, so the model
 *   never sees them, whatever the bridge re-activated for this run.
 * The tool_call guard (src/raw-delegation-guard.ts) refuses these tools anyway; this module
 * only keeps them out of the model-facing loadout.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildRuntime, ChildState } from "./child-runtime.ts";
import { THREAD_STARTING_TOOLS } from "./planner.ts";

/** Tools a child with budget 0 must not have active. */
export const EXHAUSTED_TOOLS: readonly string[] = ["subagent", ...THREAD_STARTING_TOOLS];

/** Budget 0 (leaf, exhausted chain, or unreadable header). Undefined before the first input. */
export function budgetExhausted(state: ChildState | undefined): boolean {
	return state?.budget === 0;
}

/** Events after which the active tools are pruned again (bridge reconciliation points, plus turn_start). */
export const PRUNE_EVENTS = ["session_start", "model_select", "session_tree", "before_agent_start", "turn_start"] as const;

export function installChildTools(pi: ExtensionAPI, child: ChildRuntime): { pruned(): number } {
	let pruned = 0;
	const prune = () => {
		if (!budgetExhausted(child.state())) return;
		const active = pi.getActiveTools();
		const kept = active.filter((name) => !EXHAUSTED_TOOLS.includes(name));
		if (kept.length === active.length) return;
		pi.setActiveTools(kept);
		pruned++;
	};
	for (const event of PRUNE_EVENTS) pi.on(event as any, async () => prune());
	pi.on("before_provider_request", async (event) => {
		if (!budgetExhausted(child.state())) return undefined;
		const filtered = withoutExhaustedTools(event.payload);
		if (filtered === event.payload) return undefined;
		pruned++;
		return filtered;
	});
	return { pruned: () => pruned };
}

/** Name of a serialized tool declaration: Anthropic/Responses `name`, Chat Completions `function.name`. */
const declaredName = (tool: any): unknown => tool?.name ?? tool?.function?.name;

/** The payload without exhausted tool declarations; the same object when nothing changes. */
export function withoutExhaustedTools(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const tools = (payload as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return payload;
	const kept = tools.filter((tool) => !EXHAUSTED_TOOLS.includes(declaredName(tool) as string));
	return kept.length === tools.length ? payload : { ...payload, tools: kept };
}
