/**
 * The T3 `subagent` tool: single launches through the launch planner (S3). Batches
 * (`children[]`) arrive with S4. The takeover module registers it at session start.
 *
 * Transport: T3's own Pi bridge tool `mcp__t3-code__delegate_task` through
 * ctx.executeTool(), so the bridge owns the MCP credentials and T3's permission hook sees
 * the nested call. This file never reads the bearer token.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentsDir, projectAgentNames, readCatalog } from "./catalog.ts";
import type { HostFacts } from "./planner.ts";
import { BRIDGE_DELEGATE, type Caller, itemText, type LaunchItem, LaunchError, prepareLaunch, startLaunch } from "./launch-planner.ts";
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
	children: Type.Optional(Type.Array(SubagentChildParams, { description: "Batch launch (not yet supported in T3)." })),
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
}

export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition<typeof SubagentParams, undefined, any> {
	return {
		name: "subagent",
		label: "Subagent (T3)",
		description:
			"Launch an agent from the agent roster as a T3 Code child thread (through delegate_task). Completion wakes this thread, so end your turn after an async launch. Stop with task_cancel, continue with t3_thread_send, read with task_status (reading suppresses the wake).",
		parameters: SubagentParams,
		annotations: { destructiveHint: true, openWorldHint: true, readOnlyHint: false },
		// Every call reaches the T3 bridge tool; the word matches mcp__t3-code__delegate_task.
		reachesTools: () => ["delegate_task"],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const at = new Date().toISOString();
			try {
				if (params.children && params.children.length > 0)
					throw new LaunchError("subagent launch refused: children[] batches are not supported yet in T3. Launch one agent per call.");
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
				const registry: any = (ctx as any).modelRegistry;
				const prepared = await prepareLaunch(
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
						host,
						settings,
						bridgeCallable: ctx.tools.some((tool) => tool.name === BRIDGE_DELEGATE),
						cwd: ctx.cwd,
					},
					{ toolCallId, index: 0 },
				);
				let bridgeFailed = false;
				const item = await startLaunch(prepared, async (args) => {
					try {
						return await ctx.executeTool(BRIDGE_DELEGATE, args as any, { signal, onUpdate });
					} catch (error) {
						bridgeFailed = true;
						throw error;
					}
				}).catch((error) => {
					if (error instanceof LaunchError && /^delegate_task failed/.test(error.message)) bridgeFailed = true;
					throw Object.assign(error, { bridge: bridgeFailed });
				});
				deps.onOutcome?.({ ok: true, at, items: [item] });
				return {
					content: [{ type: "text" as const, text: itemText(item) }],
					structuredContent: { launches: [{ ...item }] },
					// Never details.results: T3 would draw a second, native subagent card.
					details: undefined,
				};
			} catch (error) {
				deps.onOutcome?.({ ok: false, at, error: (error as Error).message, bridge: (error as any).bridge === true });
				throw error;
			}
		},
	};
}

/** Production wiring: root caller unless the child runtime knows the header. */
export function subagentToolFor(pi: ExtensionAPI, env: NodeJS.ProcessEnv, caller: () => Caller, onOutcome: (o: LaunchOutcome) => void) {
	return createSubagentTool({ env, caller, thinkingLevel: () => pi.getThinkingLevel?.(), onOutcome });
}
