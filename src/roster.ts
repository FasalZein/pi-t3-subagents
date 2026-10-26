/**
 * Agent roster (D30): a hidden message for the parent model that lists the agents this
 * thread may launch, with T3 lifecycle wording. Sent again only when its text changes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./catalog.ts";
import { isInteractive, mayLaunch } from "./launch-planner.ts";

export const ROSTER_TYPE = "pi-t3-subagents-roster";

export function rosterText(agents: readonly AgentDefinition[], callerAgent: string | null): string | undefined {
	const entries = agents.filter((a) => a.fields.description?.trim() && mayLaunch(a, callerAgent, agents));
	if (entries.length === 0) return undefined;
	const lines = entries.map((a) => {
		const facts = [
			a.fields.model ? `model ${a.fields.model}` : "inherits your model",
			a.fields.async === "false" ? "synchronous (the launch waits)" : "async",
			isInteractive(a) ? "interactive" : undefined,
			a.fields["allow-model-override"] === "false" ? "no model override" : undefined,
		].filter(Boolean);
		return `- ${a.name}: ${a.fields.description!.trim()} (${facts.join(", ")})`;
	});
	return [
		"Agents you can launch with the subagent tool. Each launch starts a T3 Code child thread with lineage to this thread.",
		...lines,
		"Lifecycle in T3: an async launch returns at once; the child's completion wakes this thread with its final reply, so end your turn. A launch result with state finished already carries the reply and no wake comes.",
		"Stop a child with task_cancel {taskId}. Continue a finished child with t3_thread_send {threadId: childThreadId, message}; its completion wakes this thread again. task_status {taskId} marks a finished result read and suppresses its wake.",
		"subagent_resume and subagent_kill do not work in T3.",
	].join("\n");
}

/** Install the roster: `load` returns the current agents and caller (read on each run). */
export function installRoster(pi: ExtensionAPI, load: () => { agents: readonly AgentDefinition[]; callerAgent: string | null; enabled: boolean }): void {
	let lastSent: string | undefined;
	pi.on("before_agent_start", async () => {
		const { agents, callerAgent, enabled } = load();
		if (!enabled) return;
		const text = rosterText(agents, callerAgent);
		if (text === undefined || text === lastSent) return;
		lastSent = text;
		return { message: { customType: ROSTER_TYPE, content: text, display: false } };
	});
}
