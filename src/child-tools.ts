/**
 * Child tool exposure (spec "Spawn policy and raw-delegation guard", D22): in every managed
 * child, CHILD_REFUSED_TOOLS; at budget 0, also `subagent` and the thread-starting bridge tools.
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

/**
 * T3 bridge tools that start or schedule an agent thread, other than delegate_task and
 * t3_thread_send. Refused in every managed child at any budget (owner decision 2026-10-26);
 * list from the installed bridge catalog (T3 Nightly 2026-10-26).
 */
export const CHILD_REFUSED_TOOLS: readonly string[] = [
	"create_threads",
	"t3_thread_launch",
	"t3_thread_fork",
	"schedule_task",
	"run_scheduled_task_now",
	"update_scheduled_task",
].map((t) => `mcp__t3-code__${t}`);

/** Tools a child with budget 0 must not have active. */
export const EXHAUSTED_TOOLS: readonly string[] = [...new Set(["subagent", ...THREAD_STARTING_TOOLS, ...CHILD_REFUSED_TOOLS])];

/** Tools this child must not have active now: CHILD_REFUSED_TOOLS always, EXHAUSTED_TOOLS at budget 0. */
export function removedTools(state: ChildState | undefined): readonly string[] {
	return budgetExhausted(state) ? EXHAUSTED_TOOLS : CHILD_REFUSED_TOOLS;
}

/** Budget 0 (leaf, exhausted chain, or unreadable header). Undefined before the first input. */
export function budgetExhausted(state: ChildState | undefined): boolean {
	return state?.budget === 0;
}

/** Events after which the active tools are pruned again (bridge reconciliation points, plus turn_start). */
export const PRUNE_EVENTS = ["session_start", "model_select", "session_tree", "before_agent_start", "turn_start"] as const;

export function installChildTools(pi: ExtensionAPI, child: ChildRuntime): { pruned(): number } {
	let pruned = 0;
	const prune = () => {
		const removed = removedTools(child.state());
		const active = pi.getActiveTools();
		const kept = active.filter((name) => !removed.includes(name));
		if (kept.length === active.length) return;
		pi.setActiveTools(kept);
		pruned++;
	};
	for (const event of PRUNE_EVENTS) pi.on(event as any, async () => prune());
	pi.on("before_provider_request", async (event) => {
		const filtered = withoutExhaustedTools(event.payload, removedTools(child.state()));
		if (filtered === event.payload) return undefined;
		pruned++;
		return filtered;
	});
	return { pruned: () => pruned };
}

/** Name of a serialized tool declaration: Anthropic/Responses `name`, Chat Completions `function.name`. */
const declaredName = (tool: any): unknown => tool?.name ?? tool?.function?.name;

/** The payload without the `removed` tool declarations; the same object when nothing changes. */
export function withoutExhaustedTools(payload: unknown, removed: readonly string[] = EXHAUSTED_TOOLS): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const tools = (payload as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return payload;
	const kept = tools.filter((tool) => !removed.includes(declaredName(tool) as string));
	return kept.length === tools.length ? payload : { ...payload, tools: kept };
}
