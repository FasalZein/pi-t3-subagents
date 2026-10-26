/**
 * Raw-delegation guard (D22, spec "Spawn policy and raw-delegation guard"). A tool policy,
 * not a security sandbox.
 *
 * A `tool_call` handler:
 * - In a managed child at budget 0 (leaves, exhausted chains): every thread-starting bridge
 *   tool is refused.
 * - In a managed child: `mcp__t3-code__delegate_task` passes only when its
 *   `parentToolCallId` is an in-flight call of the wrapper's `subagent` tool. Calls from the
 *   model or from a codemode script (parent = the codemode call) are refused.
 * - In a root thread: a raw `delegate_task` whose target is a managed instance is refused;
 *   other targets pass, and the wrapper's own nested call passes.
 * - Without `parentToolCallId` a call never counts as the wrapper's, so the guard fails
 *   closed when Pi stops providing it (C8); the doctor reports that observation.
 *
 * Wrapper identity comes from Pi's execution events: `tool_execution_start` of `subagent`
 * adds its call id, `tool_execution_end` (success, error, block or abort) removes it, and
 * `session_shutdown` clears the set. Nested calls get ids `<parent>/<n>`, so a `subagent`
 * call from a codemode script is tracked too and its own bridge call passes.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildRuntime } from "./child-runtime.ts";
import { budgetExhausted } from "./child-tools.ts";
import type { CompatibilityCheck } from "./doctor.ts";
import { BRIDGE_DELEGATE } from "./launch-planner.ts";
import { THREAD_STARTING_TOOLS } from "./planner.ts";
import { MANAGED_BY, type Settings } from "./settings-shape.ts";
import { settingsPath } from "./sync.ts";

export const WRAPPER_TOOL = "subagent";

export const REFUSED_EXHAUSTED = (tool: string) =>
	`${tool} is refused: this agent may not start threads or tasks (leaf agent or spawn budget exhausted, D22).`;
export const REFUSED_CHILD_RAW =
	"Raw delegate_task is refused in a pi-t3-subagents child thread (D22). Launch agents with the subagent tool; it applies spawning, visibility and the spawn budget.";
export const REFUSED_ROOT_MANAGED = (id: string) =>
	`Raw delegate_task to the managed instance ${id} is refused (D22). Launch that agent with the subagent tool; it applies the agent's launch rules.`;

/** Whether a nested wrapper bridge call carried `parentToolCallId` (C8 observation). */
export type ParentIdObservation = "not_observed" | "present" | "missing";

export interface RawDelegationGuard {
	observed(): { parentToolCallId: ParentIdObservation; refused: number };
}

export interface GuardDeps {
	readonly env: Record<string, string | undefined>;
	/** The managed child's runtime; undefined in a root thread. */
	readonly child: ChildRuntime | undefined;
	/** Override for tests; default: the T3 settings entry is marked `managedBy: pi-t3-subagents`. */
	readonly isManagedInstance?: (id: string) => boolean;
}

/** A settings entry this extension manages (any namespace). Unreadable settings: not managed. */
export function managedInstanceReader(env: Record<string, string | undefined>): (id: string) => boolean {
	return (id) => {
		try {
			const settings: Settings = JSON.parse(readFileSync(settingsPath(env as NodeJS.ProcessEnv), "utf8"));
			return settings.providerInstances?.[id]?.config?.managedBy === MANAGED_BY;
		} catch {
			return false;
		}
	};
}

const STARTING = new Set(THREAD_STARTING_TOOLS);

export function installRawDelegationGuard(pi: ExtensionAPI, deps: GuardDeps): RawDelegationGuard {
	const isManaged = deps.isManagedInstance ?? managedInstanceReader(deps.env);
	const inFlight = new Set<string>();
	let parentId: ParentIdObservation = "not_observed";
	let refused = 0;

	pi.on("tool_execution_start", async (event: any) => {
		if (event?.toolName === WRAPPER_TOOL && typeof event.toolCallId === "string") inFlight.add(event.toolCallId);
	});
	pi.on("tool_execution_end", async (event: any) => {
		if (event?.toolName === WRAPPER_TOOL) inFlight.delete(event.toolCallId);
	});
	pi.on("session_shutdown", async () => {
		inFlight.clear();
	});

	pi.on("tool_call", async (event: any) => {
		const name: string = event?.toolName;
		if (!STARTING.has(name)) return undefined;
		const parent: unknown = event.parentToolCallId;
		const fromWrapper = typeof parent === "string" && inFlight.has(parent);
		// While a wrapper call runs, a delegate call without a parent id means Pi stopped providing it.
		if (name === BRIDGE_DELEGATE && inFlight.size > 0) {
			if (fromWrapper) parentId = "present";
			else if (parent === undefined && parentId === "not_observed") parentId = "missing";
		}
		const block = (reason: string) => {
			refused++;
			return { block: true, reason };
		};
		if (deps.child) {
			// Before the first input the budget is unknown; no model call has run yet, so fail closed.
			const state = deps.child.state();
			if (state?.budget === undefined || budgetExhausted(state)) return block(REFUSED_EXHAUSTED(name));
			if (name === BRIDGE_DELEGATE && !fromWrapper) return block(REFUSED_CHILD_RAW);
			return undefined;
		}
		if (name === BRIDGE_DELEGATE && !fromWrapper) {
			const id = event.input?.target?.providerInstanceId;
			if (typeof id === "string" && isManaged(id)) return block(REFUSED_ROOT_MANAGED(id));
		}
		return undefined;
	});

	return { observed: () => ({ parentToolCallId: parentId, refused }) };
}

/** C8 guard observation for the doctor. */
export function guardCheck(guard: RawDelegationGuard): CompatibilityCheck {
	return {
		id: "C8",
		contract: "tool_call parentToolCallId on the wrapper's nested delegate_task (raw-delegation guard)",
		run() {
			const { parentToolCallId, refused } = guard.observed();
			if (parentToolCallId === "missing")
				return { status: "fail", detail: `a nested delegate_task from subagent arrived without parentToolCallId; the guard fails closed and refuses it (refused so far: ${refused})` };
			const seen = parentToolCallId === "present" ? "seen on the wrapper's nested call" : "not observed yet (no nested launch in this session)";
			return { status: "pass", detail: `parentToolCallId ${seen}; raw calls refused so far: ${refused}` };
		},
	};
}
