/**
 * The T3 `subagent` tool: single launches and `children[]` batches through the launch planner
 * (S3, S4), with spawn width from the live-children ledger. The takeover module registers it
 * at session start.
 *
 * Transport: T3's own Pi bridge tool `mcp__t3-code__delegate_task` through
 * ctx.executeTool(), so the bridge owns the MCP credentials and T3's permission hook sees
 * the nested call. This file never reads the bearer token.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDefinition, agentsDir, projectAgentNames, readCatalog } from "./catalog.ts";
import type { HostFacts } from "./planner.ts";
import {
	BRIDGE_DELEGATE,
	type Caller,
	type DelegateArgs,
	isInteractive,
	itemText,
	type LaunchItem,
	LaunchError,
	type LaunchParams as LaunchParamsInput,
	launchKey,
	type PreparedLaunch,
	prepareLaunch,
	startLaunch,
} from "./launch-planner.ts";

/** Prepared launches kept for exact retries (bounded, oldest dropped first). */
const PREPARED_KEPT = 256;
import { FAIL_OPEN_NOTICE, Ledger, MAX_SPAWN_WIDTH, widthFor } from "./ledger.ts";
import type { Settings } from "./settings-shape.ts";
import { hostFacts, settingsPath } from "./sync.ts";
import { EXTENSION_ENTRY } from "./sync-command.ts";

const SubagentChildParams = Type.Object({
	name: Type.String({ description: "Machine handle: lower-kebab <scope>-<role>, 2-4 words, max 32 chars." }),
	task: Type.String({ description: "Task brief for the child." }),
	title: Type.String({ description: "Thread title, sentence case." }),
	agent: Type.String({ description: "Agent definition name." }),
	model: Type.Optional(Type.String({ description: "provider/id override, allowed by the agent." })),
	thinking: Type.Optional(Type.String()),
});
const SubagentParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Machine handle: lower-kebab <scope>-<role>, 2-4 words, max 32 chars." })),
	task: Type.Optional(Type.String({ description: "Task brief for the child." })),
	title: Type.Optional(Type.String({ description: "Thread title, sentence case." })),
	agent: Type.Optional(Type.String({ description: "Agent definition name (see the agent roster)." })),
	model: Type.Optional(Type.String({ description: "provider/id override, allowed by the agent." })),
	thinking: Type.Optional(Type.String()),
	children: Type.Optional(
		Type.Array(SubagentChildParams, {
			description: "Batch launch: every child is validated and the width reserved before any child starts; synchronous children are awaited together.",
		}),
	),
});

/** C4: the last launch outcome, for the doctor. */
export type LaunchOutcome = { ok: true; at: string; items: LaunchItem[] } | { ok: false; at: string; error: string; bridge: boolean };

export interface SubagentToolDeps {
	readonly env: NodeJS.ProcessEnv;
	/** Spawn identity of this thread (root, or the child runtime's header). */
	readonly caller: () => Caller;
	readonly thinkingLevel?: () => string | undefined;
	/** Host facts for the stale check (tests override). */
	readonly hostFacts?: (settings: Settings) => Promise<HostFacts> | HostFacts;
	readonly onOutcome?: (outcome: LaunchOutcome) => void;
	/** Durable record of prepared launches (D23 replay across reloads); production: session entries. */
	readonly launchStore?: LaunchStore;
	/** Live-children ledger (D11, D21); default: a ledger with the root width. */
	readonly ledger?: Ledger;
}

export const LAUNCH_ENTRY = "pi-t3-subagents-launch";

/** What an exact retry needs to resend the first launch unchanged. */
export interface PersistedLaunch {
	readonly key: string;
	readonly name: string;
	readonly agent: string;
	readonly instanceId: string;
	readonly revision: string;
	readonly childBudget: number;
	readonly modelLabel: string;
	readonly args: PreparedLaunch["args"];
}

export interface LaunchStore {
	load(key: string, ctx: any): PersistedLaunch | undefined;
	save(record: PersistedLaunch): void;
}

/** Session entries of the parent thread: they survive /reload and resume of that session. */
export function sessionLaunchStore(pi: ExtensionAPI): LaunchStore {
	return {
		load(key, ctx) {
			const entries: any[] = ctx?.sessionManager?.getEntries?.() ?? [];
			const found = entries.filter((e) => e?.type === "custom" && e.customType === LAUNCH_ENTRY && e.data?.key === key).at(-1);
			const data = found?.data;
			return data && typeof data.args?.task === "string" && typeof data.args?.clientRequestId === "string" ? (data as PersistedLaunch) : undefined;
		},
		save(record) {
			(pi as any).appendEntry?.(LAUNCH_ENTRY, record);
		},
	};
}

/** Pi registry lookup for a bare model id: the provider hint, else the one available (or known) match. */
export function registryResolver(registry: any): (id: string, provider?: string) => string | undefined {
	return (id, provider) => {
		if (!registry) return undefined;
		if (provider) return registry.find?.(provider, id) ? `${provider}/${id}` : undefined;
		for (const list of [registry.getAvailable?.() ?? [], registry.getAll?.() ?? []]) {
			const matches = (list as any[]).filter((m) => m?.id === id);
			if (matches.length >= 1) return `${matches[0].provider}/${id}`;
		}
		return undefined;
	};
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Pi's getSupportedThinkingLevels (pi-ai, Pi 1.4.0), copied because pi-ai is not a declared
 * dependency. pi-subagents treats a model without `reasoning: false` as reasoning.
 */
export function supportedThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }): string[] {
	if (model.reasoning === false) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition<typeof SubagentParams, undefined, any> {
	// D23 replay: T3 replays a known clientRequestId without comparing the payload. An exact
	// retry therefore reuses the first prepared launch, so shell expansion runs once per key:
	// concurrent retries share one in-memory preparation, and every prepared launch is saved
	// in the launch store (the parent session) before the bridge call, so a retry after a
	// reload or a memory eviction resends the saved launch without preparing again.
	const prepared = new Map<string, Promise<PreparedLaunch>>();

	function recovered(record: PersistedLaunch): PreparedLaunch {
		const agent: AgentDefinition = readCatalog(agentsDir(deps.env)).agents.find((a) => a.name === record.agent) ?? {
			name: record.agent,
			path: "",
			enabled: true,
			fields: {},
			envKeys: [],
		};
		const { key: _key, agent: _agent, ...rest } = record;
		return { ...rest, agent };
	}

	async function prepare(params: LaunchParamsInput, toolCallId: string, index: number, ctx: any): Promise<PreparedLaunch> {
		const path = settingsPath(deps.env);
		let settings: Settings;
		try {
			settings = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new LaunchError(`subagent launch refused: cannot read T3 settings at ${path}: ${(error as Error).message}`);
		}
		const host = deps.hostFacts ? await deps.hostFacts(settings) : await hostFacts(deps.env, settings, EXTENSION_ENTRY);
		const catalog = readCatalog(agentsDir(deps.env));
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const registry: any = ctx.modelRegistry;
		return prepareLaunch(
			params,
			{
				agents: catalog.agents,
				disabled: catalog.disabled,
				projectAgents: projectAgentNames(ctx.cwd),
				caller: deps.caller(),
				parentModel: model,
				parentThinking: deps.thinkingLevel?.(),
				supportsThinking: (slug) => {
					const [provider, ...rest] = slug.split("/");
					const found = registry?.find?.(provider, rest.join("/"));
					return found ? found.reasoning === true : true;
				},
				resolveModel: registryResolver(registry),
				thinkingLevels: (slug) => {
					const [provider, ...rest] = slug.split("/");
					const found = registry?.find?.(provider, rest.join("/"));
					return found ? supportedThinkingLevels(found) : undefined;
				},
				host,
				settings,
				bridgeCallable: ctx.tools.some((tool: { name: string }) => tool.name === BRIDGE_DELEGATE),
				cwd: ctx.cwd,
			},
			{ toolCallId, index },
		);
	}

	const ledger = deps.ledger ?? new Ledger(() => MAX_SPAWN_WIDTH);

	/** One child: the in-memory preparation, else the saved one (reload), else a new preparation. */
	function preparedFor(params: LaunchParamsInput, toolCallId: string, index: number, ctx: any): Promise<PreparedLaunch> {
		const key = launchKey(toolCallId, index, params);
		let preparation = prepared.get(key);
		if (!preparation) {
			const saved = deps.launchStore?.load(key, ctx);
			preparation = saved
				? Promise.resolve(recovered(saved))
				: prepare(params, toolCallId, index, ctx).then((launch) => {
						const { agent, ...rest } = launch;
						deps.launchStore?.save({ key, ...rest, agent: agent.name });
						return launch;
					});
			prepared.set(key, preparation);
			if (prepared.size > PREPARED_KEPT) prepared.delete(prepared.keys().next().value!);
			// A refused preparation is not kept: a retry validates again.
			preparation.catch(() => prepared.delete(key));
		}
		return preparation;
	}

	const tool: ToolDefinition<typeof SubagentParams, undefined, any> = {
		name: "subagent",
		label: "Subagent (T3)",
		description:
			"Launch an agent from the agent roster as a T3 Code child thread (through delegate_task). Completion wakes this thread, so end your turn after an async launch. Stop with mcp__t3-code__task_cancel, continue with mcp__t3-code__t3_thread_send, read with mcp__t3-code__task_status (reading suppresses the wake); in codemode they are tools.mcp__t3_code__task_cancel, tools.mcp__t3_code__t3_thread_send and tools.mcp__t3_code__task_status.",
		parameters: SubagentParams,
		annotations: { destructiveHint: true, openWorldHint: true, readOnlyHint: false },
		// Every call reaches the T3 bridge tool; the word matches mcp__t3-code__delegate_task.
		reachesTools: () => ["delegate_task"],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const at = new Date().toISOString();
			let reserved: string[] = [];
			try {
				const batch = params.children !== undefined && params.children.length > 0;
				if (batch && (params.task !== undefined || params.agent !== undefined))
					throw new LaunchError("subagent launch refused: pass either children[] or one launch (agent, task), not both.");
				const children: LaunchParamsInput[] = batch ? params.children! : [params];
				const keys = children.map((child, index) => launchKey(toolCallId, index, child));
				// Step 2: reserve the whole batch before the first await, so parallel calls cannot exceed
				// the width. An exact retry of a launched key reserves nothing: T3 replays that child.
				try {
					reserved = ledger.reserveLaunches(keys);
				} catch (error) {
					throw new LaunchError(`subagent launch refused: ${(error as Error).message}`);
				}
				// Step 1 for every child before any bridge call; per-child key and store recovery.
				const launches = await Promise.all(children.map((child, index) => preparedFor(child, toolCallId, index, ctx)));
				const items: Array<LaunchItem | undefined> = new Array(launches.length);
				const waits: Array<Promise<void>> = [];
				let failure: { index: number; error: Error } | undefined;
				let bridgeFailed = false;
				const send = async (args: DelegateArgs) => {
					try {
						return await ctx.executeTool(BRIDGE_DELEGATE, args as any, { signal, onUpdate });
					} catch (error) {
						bridgeFailed = true;
						throw error;
					}
				};
				const start = (index: number) =>
					startLaunch(launches[index]!, send).then((item) => {
						items[index] = item;
						ledger.settleLaunch(keys[index]!, { taskId: item.taskId, childThreadId: item.childThreadId, status: item.status });
					});
				// Step 5: array order; async children are awaited one by one, synchronous ones run concurrently.
				for (let index = 0; index < launches.length && !failure; index++) {
					if (launches[index]!.args.mode === "wait") {
						waits.push(start(index).catch((error) => void (failure ??= { index, error })));
						continue;
					}
					try {
						await start(index);
					} catch (error) {
						failure = { index, error: error as Error };
					}
				}
				await Promise.all(waits);
				// Step 6: reservations of children that did not start are released.
				for (let index = 0; index < launches.length; index++) if (!items[index] && reserved.includes(keys[index]!)) ledger.releaseLaunch(keys[index]!);
				if (failure) {
					if (failure.error instanceof LaunchError && /^delegate_task failed/.test(failure.error.message)) bridgeFailed = true;
					throw Object.assign(new LaunchError(batchError(launches, items, failure)), { bridge: bridgeFailed });
				}
				const done = items as LaunchItem[];
				deps.onOutcome?.({ ok: true, at, items: done });
				const notice = ledger.snapshot().enforcing ? [] : [FAIL_OPEN_NOTICE];
				return {
					content: [{ type: "text" as const, text: [...done.map((item, index) => textFor(item, launches[index]!)), ...notice].join("\n\n") }],
					structuredContent: { launches: done.map((item) => ({ ...item })) },
					// Never details.results: T3 would draw a second, native subagent card.
					details: undefined,
				};
			} catch (error) {
				// A refusal before the bridge releases every reservation (idempotent after step 6).
				for (const key of reserved) ledger.releaseLaunch(key);
				deps.onOutcome?.({ ok: false, at, error: (error as Error).message, bridge: (error as any).bridge === true });
				throw error;
			}
		},
	};
	toolLedgers.set(tool, ledger);
	return tool;
}

/** Step 6 error: the failed child, the started children with their ids, and the children not sent. */
function batchError(launches: readonly PreparedLaunch[], items: ReadonlyArray<LaunchItem | undefined>, failure: { index: number; error: Error }): string {
	const failed = launches[failure.index]!;
	if (launches.length === 1) return failure.error.message;
	const started = launches.flatMap((launch, index) => (items[index] ? [textFor(items[index]!, launch)] : []));
	const notSent = launches.filter((launch, index) => index > failure.index && !items[index] && launch.args.mode === "async");
	return [
		`subagent batch: child ${failure.index + 1} '${failed.name}' (agent ${failed.agent.name}) failed: ${failure.error.message}`,
		// Each started child keeps its own result text: a finished reply inline (no wake), else its live state.
		started.length > 0 ? `Started children:\n\n${started.join("\n\n")}` : "No child started.",
		...(notSent.length > 0 ? [`Not sent: ${notSent.map((l) => l.name).join(", ")}.`] : []),
	].join("\n\n");
}

/** Result text of one child; interactive agents get the owner's answer-in-the-child-thread guidance. */
function textFor(item: LaunchItem, launch: PreparedLaunch): string {
	return itemText(item, { interactive: isInteractive(launch.agent) });
}

const toolLedgers = new WeakMap<object, Ledger>();

/** The live-children ledger of a subagent tool (index.ts wires its events in the S4 slot). */
export function ledgerOf(tool: object): Ledger {
	const ledger = toolLedgers.get(tool);
	if (!ledger) throw new Error("not a T3 subagent tool");
	return ledger;
}

/** Production wiring: root caller unless the child runtime knows the header. */
export function subagentToolFor(pi: ExtensionAPI, env: NodeJS.ProcessEnv, caller: () => Caller, onOutcome: (o: LaunchOutcome) => void) {
	// Width of this thread: root 16 (A15), a managed child its own agent's spawn-width.
	const ledger = new Ledger(() => {
		const agent = caller().agent;
		if (agent === null) return widthFor(null, undefined);
		return widthFor(agent, readCatalog(agentsDir(env)).agents.find((a) => a.name === agent)?.fields["spawn-width"]);
	});
	return createSubagentTool({ env, caller, thinkingLevel: () => pi.getThinkingLevel?.(), onOutcome, launchStore: sessionLaunchStore(pi), ledger });
}
