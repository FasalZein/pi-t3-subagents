/**
 * Launch planner, parent side (spec "Launch flow"): validation, effective model (A1, A2),
 * first message, launch key (D23), header (D10), bridge call and result states.
 *
 * Seams for later slices:
 * - `prepareLaunch` is pure apart from reading agent and skill files and running shell
 *   expansion; it throws a LaunchError before any bridge call. S4 calls it once per child
 *   of a batch (index = child index) before it starts any child.
 * - `startLaunch` performs one bridge call and maps the response with `launchItem`.
 * - `launchItem` / `itemText` map any T3 delegate result (async or wait) to a result item.
 * - `Caller` is the spawn identity: S5 fills `budget` from the child runtime header.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentDefinition } from "./catalog.ts";
import { stripFrontmatter } from "./catalog.ts";
import { type HostFacts, planInstance } from "./planner.ts";
import { jsonEqual, type Settings } from "./settings-shape.ts";
import { expandTask } from "./task-expansion.ts";

export const BRIDGE_DELEGATE = "mcp__t3-code__delegate_task";
export const HEADER_PREFIX = "<!-- pi-t3-subagents:v1 ";
export const SYNC_HINT = "run /t3-sync-agents";
/** A3: T3's `wait` limit is 60 minutes. */
export const MAX_WAIT_MS = 60 * 60 * 1000;
/** pi-subagents' hard maximum launch name length. */
const NAME_MAX = 32;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}$/;
const FINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export class LaunchError extends Error {
	override name = "LaunchError";
}

export interface LaunchParams {
	name?: string;
	task?: string;
	title?: string;
	agent?: string;
	model?: string;
	thinking?: string;
}

/** Who launches. agent null = root thread. budget null = unlimited (root). */
export interface Caller {
	readonly agent: string | null;
	readonly budget: number | null;
}

export interface LaunchContext {
	/** Enabled global agents (agent catalog). */
	readonly agents: readonly AgentDefinition[];
	/** Global agents present only as disabled files. */
	readonly disabled: readonly string[];
	/** Agent names defined in the project (D18 error). */
	readonly projectAgents: readonly string[];
	readonly caller: Caller;
	/** Parent's current model as `provider/id`, and its thinking level. */
	readonly parentModel?: string;
	readonly parentThinking?: string;
	/** Whether a concrete `provider/id` advertises thinking (T3 rejects options otherwise). */
	readonly supportsThinking: (slug: string) => boolean;
	/** Pi's registry: a bare model id (optionally with a --provider hint) to `provider/id`, or undefined. */
	readonly resolveModel?: (id: string, provider?: string) => string | undefined;
	/** Thinking levels a `provider/id` model offers (Pi registry), or undefined when unknown. */
	readonly thinkingLevels?: (slug: string) => readonly string[] | undefined;
	readonly host: HostFacts;
	readonly settings: Settings;
	/** The bridge tool is registered and callable in this session (C3). */
	readonly bridgeCallable: boolean;
	readonly cwd: string;
}

export interface Target {
	readonly providerInstanceId: string;
	readonly model: string;
	readonly options: Record<string, string>;
}

export interface DelegateArgs {
	readonly task: string;
	readonly title: string;
	readonly mode: "async" | "wait";
	readonly timeoutMs?: number;
	readonly isolation: "shared";
	readonly runtimeMode: "inherit";
	readonly interactionMode: "inherit";
	readonly clientRequestId: string;
	readonly target: Target;
}

export interface PreparedLaunch {
	readonly name: string;
	readonly agent: AgentDefinition;
	readonly instanceId: string;
	readonly revision: string;
	readonly childBudget: number;
	/** Effective model ref shown in the result: `provider/id` or "default (instance)". */
	readonly modelLabel: string;
	readonly args: DelegateArgs;
}

export type LaunchState = "running" | "finished" | "waiting" | "wait_timed_out";

/** T3's pending approval reference (delegate result `pendingApproval`). */
export type PendingApproval = { requestId: string; kind: string; runId: string } | null;

// A type alias (not an interface) so that the item is assignable to Pi's JSON result type.
export type LaunchItem = {
	readonly name: string;
	readonly agent: string;
	readonly taskId: string;
	readonly childThreadId: string;
	readonly providerInstanceId: string;
	readonly model: string | null;
	readonly status: string;
	readonly state: LaunchState;
	readonly wakeExpected: boolean;
	readonly summary: string | null;
	readonly pendingQuestion: boolean;
	readonly pendingApproval: PendingApproval;
};

const list = (value: string | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

/** pi-subagents `spawning`: true, a name list, or false (absent). */
export function spawnableOf(agent: AgentDefinition | undefined): true | string[] {
	const raw = agent?.fields.spawning;
	if (raw === undefined || raw === "false") return [];
	if (raw === "true") return true;
	return list(raw);
}

export function visibleTo(agent: AgentDefinition): string[] {
	const raw = agent.fields["visible-to"];
	return raw === undefined ? ["all"] : list(raw);
}

/** pi-subagents isVisibleToCaller. */
export function isVisible(agent: AgentDefinition, callerAgent: string | null): boolean {
	const v = visibleTo(agent);
	if (v.includes("all")) return true;
	if (callerAgent === null) return v.includes("root");
	return callerAgent !== "root" && v.includes(callerAgent);
}

/** Whether `caller` may launch `target` by allowlist and visibility (roster filter). */
export function mayLaunch(target: AgentDefinition, callerAgent: string | null, agents: readonly AgentDefinition[]): boolean {
	if (target.name === callerAgent) return false;
	const spawnable = callerAgent === null ? true : spawnableOf(agents.find((a) => a.name === callerAgent));
	return (spawnable === true || spawnable.includes(target.name)) && isVisible(target, callerAgent);
}

/** Exact budget (D10): min(target spawn-depth or 1, caller budget - 1); 0 for leaves. */
export function childBudgetOf(target: AgentDefinition, caller: Caller): number {
	if (spawnableOf(target) !== true && (spawnableOf(target) as string[]).length === 0) return 0;
	const depth = Number(target.fields["spawn-depth"] ?? 1) || 1;
	const budget = Math.min(depth, (caller.budget ?? Number.POSITIVE_INFINITY) - 1);
	return Math.max(0, budget);
}

/** `provider/id:level` -> model and thinking (pi-subagents splitModelRef). */
export function splitModelRef(ref: string): { model: string; thinking?: string } {
	const idx = ref.lastIndexOf(":");
	return idx === -1 ? { model: ref } : { model: ref.slice(0, idx), thinking: ref.slice(idx + 1) };
}

const refOf = (model: string | undefined, thinking: string | undefined) => (model ? (thinking ? `${model}:${thinking}` : model) : undefined);

function modelAllowed(effective: string, allowed: string): boolean {
	const e = splitModelRef(effective);
	const a = splitModelRef(allowed);
	return a.model === e.model && (!a.thinking || a.thinking === e.thinking);
}

/**
 * A1: effective model and thinking = override, else agent value, else parent value.
 * Equal to the pair baked into the instance -> `model: "default"` and no options.
 */
export function resolveTarget(
	agent: AgentDefinition,
	params: LaunchParams,
	ctx: Pick<LaunchContext, "parentModel" | "parentThinking" | "supportsThinking" | "resolveModel" | "thinkingLevels">,
	instanceId: string,
): { target: Target; modelLabel: string; overrideModel?: string; overrideThinking?: string } {
	// A configured bare id (for example `model: claude-haiku-5-5` with `flags: --provider x`)
	// is resolved through Pi's registry before the A1 comparison and the allowlist.
	const providerHint = agent.fields.flags?.match(/(?:^|\s)--provider(?:=|\s+)("?)([^\s"]+)\1/)?.[2];
	const qualify = (ref: { model: string; thinking?: string }) =>
		ref.model.includes("/") ? ref : { ...ref, model: ctx.resolveModel?.(ref.model, providerHint) ?? ref.model };
	const allowOverride = agent.fields["allow-model-override"] !== "false";
	const override = allowOverride && params.model ? qualify(splitModelRef(params.model.trim())) : undefined;
	const overrideThinking = allowOverride ? params.thinking?.trim() || override?.thinking : undefined;
	const agentModel = agent.fields.model ? qualify(splitModelRef(agent.fields.model)) : undefined;
	const agentThinking = agentModel?.thinking ?? agent.fields.thinking;
	const parent = ctx.parentModel ? splitModelRef(ctx.parentModel) : undefined;

	const effectiveModel = override?.model ?? agentModel?.model ?? parent?.model;
	let effectiveThinking: string | undefined = overrideThinking ?? agentThinking ?? parent?.thinking ?? ctx.parentThinking;

	// pi-subagents resolveAvailableModelRef (cf6dbf4): with a model override, a thinking
	// level the target model does not offer is dropped when it is inherited (agent or
	// parent value) and refused when the caller asked for it (`thinking` or a model suffix).
	if (override && effectiveThinking) {
		const supported = ctx.thinkingLevels?.(override.model);
		if (supported && !supported.includes(effectiveThinking)) {
			if (overrideThinking)
				throw new LaunchError(`Model '${override.model}' does not support thinking level '${effectiveThinking}'. Supported levels: ${supported.join(", ")}.`);
			effectiveThinking = undefined;
		}
	}

	const allowed = list(agent.fields["allowed-models"]);
	if (allowed.length > 0) {
		const effectiveRef = refOf(effectiveModel, effectiveThinking);
		const own = refOf(agentModel?.model ?? parent?.model, agentThinking ?? parent?.thinking ?? ctx.parentThinking);
		const refs = [...(own ? [own] : []), ...allowed.map((r) => { const q = qualify(splitModelRef(r)); return refOf(q.model, q.thinking)!; })];
		if (!effectiveRef) throw new LaunchError(`Agent '${agent.name}' defines allowed-models but no model was resolved.`);
		if (!refs.some((r) => modelAllowed(effectiveRef, r)))
			throw new LaunchError(`Model '${effectiveRef}' is not allowed for agent '${agent.name}'. Allowed models: ${refs.join(", ")}.`);
	}

	if (effectiveModel === agentModel?.model && effectiveThinking === agentThinking) {
		return { target: { providerInstanceId: instanceId, model: "default", options: {} }, modelLabel: "default", overrideModel: override?.model, overrideThinking };
	}
	if (!effectiveModel) throw new LaunchError(`Agent '${agent.name}' has no model and the parent model is unknown; pass model as provider/id.`);
	if (!effectiveModel.includes("/")) throw new LaunchError(`Model '${effectiveModel}' must use the provider/id form in T3.`);
	const options: Record<string, string> = effectiveThinking && ctx.supportsThinking(effectiveModel) ? { thinking: effectiveThinking } : {};
	return { target: { providerInstanceId: instanceId, model: effectiveModel, options }, modelLabel: effectiveModel, overrideModel: override?.model, overrideThinking };
}

/** D23: hash of the tool call id, the child index and the request before shell expansion. */
export function launchKey(toolCallId: string, index: number, params: LaunchParams): string {
	const canonical = JSON.stringify([toolCallId, index, params.agent ?? "", params.task ?? "", params.title ?? "", params.model ?? null, params.thinking ?? null]);
	return `pi-t3-subagents:${createHash("sha256").update(canonical).digest("hex").slice(0, 40)}`;
}

export function headerLine(budget: number, caller: string | null, revision: string): string {
	return `${HEADER_PREFIX}${JSON.stringify({ budget, caller: caller ?? "root", revision })} -->`;
}

export const AUTONOMOUS_HINT = "Complete your task autonomously.";
export const SUMMARY_INSTRUCTION = "Your FINAL assistant message should summarize what you accomplished.";
export const INTERACTIVE_HINT =
	"You run in a T3 Code child thread. The user can open this thread and reply. Ask questions with ask_user when it is available. When the work is done, end your turn with your final report; your caller is woken with it. The user may continue this thread later.";

export function isInteractive(agent: AgentDefinition): boolean {
	return agent.fields.mode === "interactive" && agent.fields["auto-exit"] !== "true";
}

/** pi-subagents formatInjectedSkills (without pi-better-skills). */
export function injectedSkills(agent: AgentDefinition, host: HostFacts): string {
	const names = list(agent.fields["inject-skills"]);
	return names
		.map((name) => {
			const path = host.resolveSkill(name);
			if (!path) throw new LaunchError(`inject-skills: unknown skill "${name}" for agent '${agent.name}'.`);
			const body = stripFrontmatter(readFileSync(path, "utf8")).trim();
			return `<skill name="${name}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`;
		})
		.join("\n\n");
}

/** First message: header, injected skills, role block, mode hint, expanded task, summary instruction. */
export function firstMessage(input: { header: string; skills: string; roleBlock: string; interactive: boolean; task: string }): string {
	const parts = [
		input.skills,
		input.roleBlock,
		input.interactive ? INTERACTIVE_HINT : AUTONOMOUS_HINT,
		input.task,
		input.interactive ? "" : SUMMARY_INSTRUCTION,
	].filter((p) => p.trim());
	return `${input.header}\n${parts.join("\n\n")}`;
}

function agentTimeoutMs(agent: AgentDefinition): number {
	const seconds = Number(agent.fields.timeout);
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : MAX_WAIT_MS;
}

function nameError(name: string | undefined): string | null {
	const trimmed = name?.trim() ?? "";
	if (!trimmed) return "name is required: a lower-kebab <scope>-<role> handle such as auth-scout.";
	if (trimmed !== name) return `name ${JSON.stringify(name)} has surrounding whitespace.`;
	if (trimmed.length > NAME_MAX) return `name ${JSON.stringify(name)} is longer than ${NAME_MAX} characters.`;
	if (!NAME_PATTERN.test(trimmed)) return `name ${JSON.stringify(name)} must be lower-kebab <scope>-<role> with 2-4 words, such as auth-scout.`;
	return null;
}

/** Step 1 of the launch flow plus steps 3 and 4 for one child. Throws LaunchError; no bridge call. */
export async function prepareLaunch(params: LaunchParams, ctx: LaunchContext, call: { toolCallId: string; index: number }): Promise<PreparedLaunch> {
	const fail = (why: string): never => {
		throw new LaunchError(`subagent launch refused: ${why}`);
	};
	const nameProblem = nameError(params.name);
	if (nameProblem) fail(nameProblem);
	if (!params.title?.trim()) fail("title is required: a short sentence-case title for the child thread.");
	const agentName = params.agent?.trim();
	if (!agentName) fail("agent is required.");
	if (!params.task?.trim()) fail("task is required.");
	// D18: a project agent overrides a same-named global one, so it is refused even then.
	if (ctx.projectAgents.includes(agentName!)) fail(`agent '${agentName}' is a project agent; T3 supports global agents only (D18).`);
	const agent = ctx.agents.find((a) => a.name === agentName);
	if (!agent) {
		if (ctx.disabled.includes(agentName!)) fail(`agent '${agentName}' is disabled (enabled: false).`);
		if (ctx.projectAgents.includes(agentName!)) fail(`agent '${agentName}' is a project agent; T3 supports global agents only (D18).`);
		fail(`agent '${agentName}' does not exist. Known agents: ${ctx.agents.map((a) => a.name).join(", ") || "none"}.`);
	}
	const a = agent!;
	const { caller } = ctx;
	if (caller.agent !== null && a.name === caller.agent) fail(`you are the ${a.name} agent; do not start another ${a.name}. Do the work yourself.`);
	if (!isVisible(a, caller.agent)) fail(`agent '${a.name}' is not visible to ${caller.agent ?? "root"} (visible-to).`);
	if (caller.agent !== null) {
		const spawnable = spawnableOf(ctx.agents.find((x) => x.name === caller.agent));
		if (spawnable !== true && !spawnable.includes(a.name)) fail(`the spawning list of ${caller.agent} does not include agent '${a.name}'.`);
	}
	if (caller.budget !== null && caller.budget <= 0) fail("Spawn budget is exhausted.");

	const plan = planInstance(a, ctx.host);
	if (plan.kind === "skip") fail(`agent '${a.name}' has no managed instance: ${plan.reason}.`);
	const instance = plan as Extract<typeof plan, { kind: "entry" }>;
	const stored = ctx.settings.providerInstances?.[instance.id];
	if (!stored) fail(`managed instance ${instance.id} is missing in T3 settings; ${SYNC_HINT}.`);
	if (!jsonEqual(stored, instance.entry)) fail(`managed instance ${instance.id} does not match the agent file ${a.path}; ${SYNC_HINT}.`);

	let resolved: ReturnType<typeof resolveTarget>;
	try {
		resolved = resolveTarget(a, params, ctx, instance.id);
	} catch (error) {
		return fail((error as Error).message);
	}
	const skills = (() => {
		try {
			return injectedSkills(a, ctx.host);
		} catch (error) {
			return fail((error as Error).message);
		}
	})();
	if (!ctx.bridgeCallable) fail(`the T3 bridge tool ${BRIDGE_DELEGATE} is not callable in this session (C3).`);

	let task = params.task!;
	if (a.fields["task-expansion"] === "shell") {
		try {
			task = await expandTask(task, ctx.cwd);
		} catch (error) {
			fail(`shell task expansion failed: ${(error as Error).message}`);
		}
	}
	const childBudget = childBudgetOf(a, caller);
	const roleBlock = a.fields["system-prompt"] === undefined ? stripFrontmatter(readFileSync(a.path, "utf8")).trim() : "";
	const message = firstMessage({
		header: headerLine(childBudget, caller.agent, instance.revision),
		skills,
		roleBlock,
		interactive: isInteractive(a),
		task,
	});
	const wait = a.fields.async === "false";
	return {
		name: params.name!,
		agent: a,
		instanceId: instance.id,
		revision: instance.revision,
		childBudget,
		modelLabel: resolved.modelLabel,
		args: {
			task: message,
			title: params.title!.trim(),
			mode: wait ? "wait" : "async",
			...(wait ? { timeoutMs: agentTimeoutMs(a) } : {}),
			isolation: "shared",
			runtimeMode: "inherit",
			interactionMode: "inherit",
			clientRequestId: launchKey(call.toolCallId, call.index, params),
			target: resolved.target,
		},
	};
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

/** Map one T3 delegate result to a result item (C4: data at structuredContent.structuredContent). */
export function launchItem(prepared: Pick<PreparedLaunch, "name" | "agent">, launched: any): LaunchItem {
	const status = String(launched.status);
	const pendingQuestion = launched.hasPendingQuestion === true;
	const raw = launched.pendingApproval;
	const pendingApproval: PendingApproval = raw ? { requestId: String(raw.requestId), kind: String(raw.kind), runId: String(raw.runId) } : null;
	let state: LaunchState;
	if (FINAL_STATUSES.has(status)) state = "finished";
	else if (launched.waitTimedOut === true) state = "wait_timed_out";
	else if (pendingQuestion || pendingApproval) state = "waiting";
	else state = "running";
	return {
		name: prepared.name,
		agent: prepared.agent.name,
		taskId: String(launched.taskId),
		childThreadId: String(launched.childThreadId),
		providerInstanceId: String(launched.providerInstanceId),
		model: launched.model ?? null,
		status,
		state,
		// A finished child is marked read at once: no wake comes (T3 facts).
		wakeExpected: state !== "finished",
		summary: state === "finished" ? (launched.summary ?? null) : null,
		pendingQuestion,
		pendingApproval,
	};
}

export function itemText(item: LaunchItem): string {
	const head = `${item.name} (${item.agent}): taskId=${item.taskId} childThreadId=${item.childThreadId} instance=${item.providerInstanceId} model=${item.model} status=${item.status} state=${item.state}`;
	const body: Record<LaunchState, string> = {
		running: "The child runs in its own T3 thread. Completion wakes this thread; end your turn now.",
		finished: `The child already finished [${item.status}]; no wake will come. Its reply:\n${item.summary ?? "(no reply text)"}`,
		waiting: "The child waits for input in its thread (question or approval). A wake may follow when it settles (unverified, U19).",
		wait_timed_out: "The wait reached its limit. The child still runs; a wake comes when it finishes.",
	};
	const lifecycle = [
		`Stop: task_cancel {"taskId":"${item.taskId}"}.`,
		`Continue a finished child: t3_thread_send {"threadId":"${item.childThreadId}","message":"..."}.`,
		`Read: task_status {"taskId":"${item.taskId}"} marks the result read and suppresses the wake.`,
	];
	return [head, body[item.state], ...lifecycle].join("\n");
}

export interface BridgeOutcome {
	isError?: boolean;
	result?: { content?: unknown; structuredContent?: any };
}

/** Step 5 for one child: one bridge call. Throws with the raw T3 text when the result is unreadable. */
export async function startLaunch(prepared: PreparedLaunch, execute: (args: DelegateArgs) => Promise<BridgeOutcome>): Promise<LaunchItem> {
	const outcome = await execute(prepared.args);
	const mcp: any = outcome.result?.structuredContent;
	const launched: any = mcp?.structuredContent;
	if (outcome.isError || mcp?.isError === true || !launched?.taskId || !launched?.childThreadId) {
		const reason = textOf(outcome.result?.content) || textOf(mcp?.content) || "no error text";
		throw new LaunchError(`delegate_task failed for agent '${prepared.agent.name}' (instance ${prepared.instanceId}): ${reason}`);
	}
	return launchItem(prepared, launched);
}
