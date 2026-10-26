/**
 * The T3 `subagent` tool, unchanged from the spike (single launch, agent "scout" only).
 * S3 replaces it with the launch planner. The takeover module registers it at session start.
 *
 * Transport: T3's own Pi bridge tool `mcp__t3-code__delegate_task` through
 * ctx.executeTool(), so the bridge owns the MCP credentials and T3's permission hook sees
 * the nested call. This file never reads the bearer token.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BRIDGE_TOOL = "mcp__t3-code__delegate_task";
const SUPPORTED_AGENTS = new Set(["scout"]);

// Same shape as pi-subagents src/tools/subagent-tools.ts SubagentParams.
const SubagentChildParams = Type.Object({
	name: Type.String({ description: "Short display name for the child." }),
	task: Type.String({ description: "Task brief for the child." }),
	title: Type.String({ description: "Thread title." }),
	agent: Type.String({ description: "Agent definition name, e.g. scout." }),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
});
const SubagentParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Short display name for the child." })),
	task: Type.Optional(Type.String({ description: "Task brief for the child." })),
	title: Type.Optional(Type.String({ description: "Thread title." })),
	agent: Type.Optional(Type.String({ description: "Agent definition name. T3 spike supports: scout." })),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	children: Type.Optional(Type.Array(SubagentChildParams, { description: "Not supported in the T3 spike." })),
});
const SubagentLaunchResult = Type.Object({
	taskId: Type.String(),
	childThreadId: Type.String(),
	providerInstanceId: Type.String(),
	model: Type.Union([Type.String(), Type.Null()]),
	status: Type.String(),
});

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

export const subagentTool: ToolDefinition<typeof SubagentParams, undefined, any> = {
	name: "subagent",
	label: "Subagent (T3)",
	description:
		"Launch a helper agent as a T3 Code child thread (via delegate_task). Spike: single launch, agent 'scout' only. Completion wakes this thread, so end your turn after launching.",
	parameters: SubagentParams,
	outputSchema: SubagentLaunchResult,
	annotations: { destructiveHint: true, openWorldHint: true, readOnlyHint: false },
	// Every call reaches the T3 bridge tool; the word matches mcp__t3-code__delegate_task.
	reachesTools: () => ["delegate_task"],
	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		if (params.children && params.children.length > 0) {
			throw new Error("t3-subagents spike: children[] is not supported. Launch one agent at a time.");
		}
		const agent = params.agent ?? "";
		if (!SUPPORTED_AGENTS.has(agent)) {
			throw new Error(`t3-subagents spike: unsupported agent '${agent}'. Supported: ${[...SUPPORTED_AGENTS].join(", ")}.`);
		}
		if (!params.task) throw new Error("t3-subagents spike: task is required.");
		if (!ctx.tools.some((tool) => tool.name === BRIDGE_TOOL)) {
			throw new Error(
				`t3-subagents: T3 bridge tool ${BRIDGE_TOOL} is not registered or not active in this session, so subagent cannot launch. Check that the T3 MCP bridge connected and that --tools does not exclude it.`,
			);
		}
		const outcome = await ctx.executeTool(
			BRIDGE_TOOL,
			{
				task: params.task,
				title: params.title ?? params.name ?? agent,
				role: "research",
				mode: "async",
				// "default" makes T3 skip set_model, so the child keeps the instance's
				// --model/--thinking launch args instead of inheriting the parent's.
				target: { providerInstanceId: `pi-${agent}`, model: "default", options: {} },
			},
			{ signal, onUpdate },
		);
		// The bridge returns the MCP result (minus _meta) as structuredContent.
		const mcp: any = outcome.result?.structuredContent;
		const launched: any = mcp?.structuredContent;
		if (outcome.isError || mcp?.isError === true || !launched?.taskId || !launched?.childThreadId) {
			const reason = textOf(outcome.result?.content) || textOf(mcp?.content) || "no error text";
			throw new Error(`delegate_task failed for agent '${agent}': ${reason}`);
		}
		const structuredContent = {
			taskId: String(launched.taskId),
			childThreadId: String(launched.childThreadId),
			providerInstanceId: String(launched.providerInstanceId),
			model: launched.model ?? null,
			status: String(launched.status),
		};
		return {
			content: [
				{
					type: "text" as const,
					text: `Launched T3 child thread. taskId=${structuredContent.taskId} childThreadId=${structuredContent.childThreadId} providerInstanceId=${structuredContent.providerInstanceId} model=${structuredContent.model} status=${structuredContent.status}\nCompletion wakes this thread, so end your turn.`,
				},
			],
			structuredContent,
			details: undefined,
		};
	},
};
