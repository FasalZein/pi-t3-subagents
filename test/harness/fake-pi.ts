/**
 * Layer 1 seam: a fake Pi extension host (spec "Testing Decisions").
 *
 * It loads extension factories in order, records tools, commands, event handlers, messages
 * and the active tool set, and fires events. It follows the Pi 1.4.0 rules this repository
 * relies on (docs/extensions.md, resource-loader.js detectExtensionConflicts):
 * - a tool name registered by two extensions while loading is a fatal load error;
 * - registering a `direct` or `model-only` tool activates it; other exposures stay inactive;
 * - setActiveTools ignores unknown names;
 * - a tool call (model-issued, or nested through ctx.executeTool with parentToolCallId)
 *   reaches only callable tools: a model call active tools, a nested call active `direct`
 *   tools and every `codemode` or `deferred` tool;
 * - a tool call runs the Pi 1.4.0 pipeline (pi-agent-core agent-loop.js, pi-coding-agent
 *   nested-tool-calls.js and agent-session.js _beforeToolCall/_afterToolCall):
 *   `tool_execution_start` -> `tool_call` handlers (a `block` or a thrown error stops the
 *   call) -> abort check -> execute (`tool_execution_update` per partial result) ->
 *   `tool_result` handlers (they may replace content, details and isError) ->
 *   `tool_execution_end`. A blocked, aborted or unknown call skips `tool_result`.
 *   Tool failures never reject: they come back as `isError: true` with the error text;
 * - ctx.executeTool in execute() runs a nested call with the id `<calling id>/<n>`, and every
 *   event of that call carries `parentToolCallId`; it defaults to the caller's abort signal;
 * - pi.appendEntry adds a `custom` session entry; ctx.sessionManager.getEntries() returns
 *   the session entries, which a test may share between hosts to model /reload or resume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Exposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

export interface FakeTool {
	name: string;
	exposure: Exposure;
	sourceInfo: { path: string; source: string; scope: string; origin: string };
	definition: any;
}

export interface SentMessage {
	customType: string;
	content: unknown;
	display?: boolean;
}

export interface Notification {
	message: string;
	level?: string;
}

type Handler = (event: any, ctx: any) => unknown;
type Execute = (toolCallId: string, args: any, signal: AbortSignal | undefined, onUpdate: ((partial: any) => void) | undefined, ctx: any) => unknown;

/** A session entry as Pi's SessionManager stores it (only the fields this repository reads). */
export interface FakeSessionEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; content: unknown };
	timestamp?: string;
}

/** Pi's AgentToolCallOutcome, plus the block reason when a `tool_call` handler blocked it. */
export interface FakeToolOutcome {
	toolCall: { id: string; name: string; arguments: unknown };
	result: any;
	isError: boolean;
	blocked?: string;
}

export interface CallOptions {
	/** Set for a nested call: the id of the calling tool call. */
	parentToolCallId?: string;
	signal?: AbortSignal;
	onUpdate?: (partial: any) => void;
}
type Factory = (pi: ExtensionAPI) => void | Promise<void>;

export class FakeLoadError extends Error {}

export class FakePiHost {
	readonly tools = new Map<string, FakeTool>();
	readonly active = new Set<string>();
	readonly commands = new Map<string, { path: string; options: any }>();
	readonly handlers = new Map<string, Array<{ path: string; handler: Handler }>>();
	readonly messages: SentMessage[] = [];
	readonly notifications: Notification[] = [];
	readonly loadErrors: string[] = [];
	/** Session entries (`custom` entries from appendEntry, and messages a test adds). */
	readonly entries: FakeSessionEntry[];
	/** Every tool lifecycle event this host emitted, in order. */
	readonly toolEvents: Array<Record<string, any>> = [];
	private loading = true;
	private modelCalls = 0;
	private readonly nestedCounts = new Map<string, number>();

	constructor(options: { entries?: FakeSessionEntry[] } = {}) {
		this.entries = options.entries ?? [];
	}

	/** Load an extension factory as Pi does, attributing its registrations to `path`. */
	async load(path: string, factory: Factory): Promise<void> {
		if (!this.loading) throw new Error("FakePiHost: load() after startSession()");
		await factory(this.api(path));
	}

	/** End loading: fatal if two extensions registered one tool name (Pi 1.4.0 exits). */
	finishLoading(): void {
		this.loading = false;
		if (this.loadErrors.length > 0) throw new FakeLoadError(this.loadErrors.join("\n"));
	}

	/** Register a tool that Pi or the MCP bridge provides, outside any factory. */
	addTool(name: string, path: string, exposure: Exposure = "direct", active = exposure === "direct", execute?: Execute): void {
		this.tools.set(name, { name, exposure, sourceInfo: sourceInfo(path), definition: { name, execute } });
		if (active) this.active.add(name);
	}

	async emit(event: string, payload: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const { handler } of this.handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload }, this.context(ctx)));
		}
		return results;
	}

	async startSession(): Promise<void> {
		if (this.loading) this.finishLoading();
		await this.emit("session_start", { reason: "startup" });
	}

	/** Fire before_agent_start for one user run; return the messages that handlers added. */
	async startRun(prompt = "hello"): Promise<Array<{ customType: string; content: unknown; display?: boolean }>> {
		const results = await this.emit("before_agent_start", { messageType: "user", prompt, images: [], systemPrompt: "" });
		return results.flatMap((result: any) => (result?.message ? [result.message] : []));
	}

	/** End this runtime as Pi does before /reload or a session replacement. */
	async shutdown(reason = "reload"): Promise<void> {
		await this.emit("session_shutdown", { reason });
	}

	/** Add a user message to the session entries (Pi records one per user prompt). */
	addUserMessage(text: string): void {
		this.entries.push({ type: "message", id: `m${this.entries.length + 1}`, message: { role: "user", content: text } });
	}

	/**
	 * Call a tool as Pi does. Without `parentToolCallId` it is a model call (active tools
	 * only); with it, a nested ctx.executeTool call. Throws only when the tool is not
	 * callable on that path (a test error: the model cannot issue such a call). Returns the
	 * block reason, or the result with `isError` (also for a thrown error or an abort).
	 */
	async callTool(name: string, args: unknown = {}, options: CallOptions = {}): Promise<{ blocked?: string; result?: any; isError: boolean; toolCallId: string }> {
		if (!this.isCallable(name, options.parentToolCallId !== undefined)) {
			throw new Error(`FakePiHost: tool ${name} is not ${options.parentToolCallId ? "callable" : "active"}`);
		}
		const outcome = await this.runToolCall(name, args, options);
		const { blocked, isError, toolCall } = outcome;
		return blocked === undefined ? { result: outcome.result, isError, toolCallId: toolCall.id } : { blocked, isError, toolCallId: toolCall.id };
	}

	/** Tool context for execute(): the extension context plus `tools` and `executeTool`. */
	toolContext(callerId: string, callerSignal?: AbortSignal): any {
		const host = this;
		return {
			...this.context(),
			get tools() {
				return [...host.tools.values()].filter((tool) => host.isCallable(tool.name, true)).map((tool) => tool.definition);
			},
			executeTool: (name: string, args: unknown, options: { signal?: AbortSignal; onUpdate?: (partial: any) => void } = {}) =>
				host.runToolCall(name, args, { parentToolCallId: callerId, signal: options.signal ?? callerSignal, onUpdate: options.onUpdate }),
		};
	}

	private isCallable(name: string, nested: boolean): boolean {
		const tool = this.tools.get(name);
		if (!tool) return false;
		if (nested) return (tool.exposure === "direct" && this.active.has(name)) || tool.exposure === "codemode" || tool.exposure === "deferred";
		return this.active.has(name) && tool.exposure !== "hidden";
	}

	private nextId(parentToolCallId: string | undefined): string {
		if (parentToolCallId === undefined) return `call-${++this.modelCalls}`;
		const n = (this.nestedCounts.get(parentToolCallId) ?? 0) + 1;
		this.nestedCounts.set(parentToolCallId, n);
		return `${parentToolCallId}/${n}`;
	}

	private async emitTool(event: string, payload: Record<string, unknown>): Promise<unknown[]> {
		this.toolEvents.push({ type: event, ...payload });
		return this.emit(event, payload);
	}

	/** One call through the Pi 1.4.0 tool pipeline. Never rejects for tool failures. */
	private async runToolCall(name: string, args: unknown, options: CallOptions): Promise<FakeToolOutcome> {
		const { parentToolCallId, signal } = options;
		const id = this.nextId(parentToolCallId);
		const parent = parentToolCallId === undefined ? {} : { parentToolCallId };
		const input = (args ?? {}) as Record<string, unknown>;
		const toolCall = { id, name, arguments: input };
		await this.emitTool("tool_execution_start", { toolCallId: id, toolName: name, args: input, ...parent });
		const finish = async (result: any, isError: boolean, blocked?: string): Promise<FakeToolOutcome> => {
			await this.emitTool("tool_execution_end", { toolCallId: id, toolName: name, result, isError, ...parent });
			return blocked === undefined ? { toolCall, result, isError } : { toolCall, result, isError, blocked };
		};
		const tool = this.tools.get(name);
		if (!tool || !this.isCallable(name, parentToolCallId !== undefined)) return finish(errorResult(`Tool ${name} not found`), true);
		// tool_call handlers share one event (they may mutate `input`); the first block stops the rest.
		const callEvent = { type: "tool_call", toolName: name, toolCallId: id, ...parent, input };
		this.toolEvents.push(callEvent);
		try {
			for (const { handler } of this.handlers.get("tool_call") ?? []) {
				const handled: any = await handler(callEvent, this.context());
				if (handled?.block) {
					const reason = String(handled.reason || "Tool execution was blocked");
					return finish(errorResult(reason), true, reason);
				}
			}
		} catch (error) {
			return finish(errorResult(messageOf(error)), true);
		}
		if (signal?.aborted) return finish(errorResult("Operation aborted"), true);
		let result: any;
		let isError: boolean;
		const updates: Promise<unknown>[] = [];
		try {
			const onUpdate = (partialResult: any) => {
				options.onUpdate?.(partialResult);
				updates.push(this.emitTool("tool_execution_update", { toolCallId: id, toolName: name, args: input, partialResult, ...parent }));
			};
			result = await tool.definition.execute(id, input, signal, onUpdate, this.toolContext(id, signal));
			isError = result?.isError === true;
		} catch (error) {
			result = errorResult(messageOf(error));
			isError = true;
		}
		await Promise.all(updates);
		// tool_result handlers run in order; each sees the previous handler's changes.
		const event: Record<string, any> = { toolName: name, toolCallId: id, ...parent, input, content: result?.content, details: result?.details, isError };
		if (result?.structuredContent !== undefined) event.structuredContent = result.structuredContent;
		this.toolEvents.push({ type: "tool_result", ...event });
		let modified = false;
		for (const { handler } of this.handlers.get("tool_result") ?? []) {
			try {
				const change: any = await handler({ type: "tool_result", ...event }, this.context());
				if (!change) continue;
				for (const key of ["content", "details", "structuredContent", "isError"]) {
					if (change[key] === undefined) continue;
					event[key] = change[key];
					modified = true;
				}
				if (change.content !== undefined && change.structuredContent === undefined) delete event.structuredContent;
			} catch {
				// Pi reports a failing tool_result handler and keeps the result (runner.emitToolResult).
			}
		}
		if (modified) {
			result = { ...result, content: event.content ?? [], details: event.details ?? result?.details };
			if (event.structuredContent === undefined) delete result.structuredContent;
			else result.structuredContent = event.structuredContent;
			isError = event.isError;
		}
		return finish(result, isError);
	}

	async runCommand(name: string, args = "", ctx: { hasUI?: boolean } = {}): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`FakePiHost: no command /${name}`);
		await command.options.handler(args, this.context(ctx));
	}

	toolSource(name: string): string | undefined {
		return this.tools.get(name)?.sourceInfo.path;
	}

	context(extra: Record<string, unknown> = {}): any {
		const hasUI = extra.hasUI ?? false;
		return {
			hasUI,
			mode: "rpc",
			cwd: "/tmp",
			ui: { notify: (message: string, level?: string) => this.notifications.push({ message, level }) },
			sessionManager: { getEntries: () => [...this.entries] },
			...extra,
		};
	}

	private api(path: string): ExtensionAPI {
		const host = this;
		const api = {
			registerTool(definition: any) {
				const existing = host.tools.get(definition.name);
				if (existing && existing.sourceInfo.path !== path) {
					if (host.loading) host.loadErrors.push(`Tool "${definition.name}" conflicts with ${existing.sourceInfo.path}`);
					// After load, Pi keeps the first registration per name.
					return;
				}
				const exposure: Exposure = definition.exposure ?? "direct";
				host.tools.set(definition.name, { name: definition.name, exposure, sourceInfo: sourceInfo(path), definition });
				if (exposure === "direct" || exposure === "model-only") host.active.add(definition.name);
			},
			registerCommand(name: string, options: any) {
				host.commands.set(name, { path, options });
			},
			on(event: string, handler: Handler) {
				const list = host.handlers.get(event) ?? [];
				list.push({ path, handler });
				host.handlers.set(event, list);
				return () => {};
			},
			getAllTools() {
				return [...host.tools.values()].map((tool) => ({
					name: tool.name,
					description: tool.definition.description ?? "",
					parameters: tool.definition.parameters,
					exposure: tool.exposure,
					sourceInfo: tool.sourceInfo,
				}));
			},
			getActiveTools() {
				return [...host.active];
			},
			setActiveTools(names: string[]) {
				host.active.clear();
				for (const name of names) if (host.tools.has(name)) host.active.add(name);
			},
			sendMessage(message: SentMessage) {
				host.messages.push(message);
			},
			appendEntry(customType: string, data?: unknown) {
				host.entries.push({ type: "custom", id: `e${host.entries.length + 1}`, customType, data, timestamp: new Date().toISOString() });
			},
		};
		return api as unknown as ExtensionAPI;
	}
}

/** Pi's createErrorToolResult (agent-loop.js). */
function errorResult(text: string) {
	return { content: [{ type: "text", text }], details: {} };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sourceInfo(path: string) {
	return { path, source: "cli", scope: "temporary", origin: "top-level" };
}

/**
 * Faithful stand-in for pi-subagents cf6dbf4 tool registration (src/subagents.ts:367-375):
 * it reads PI_DENY_TOOLS once in its factory, skips denied `subagent` and
 * `subagent_resume`, and registers `subagent_kill` without checking the variable.
 */
export function fakePiSubagents(env: Record<string, string | undefined>, exposure?: Exposure) {
	return (pi: ExtensionAPI) => {
		const denied = new Set((env.PI_DENY_TOOLS ?? "").split(",").map((name) => name.trim()).filter(Boolean));
		for (const name of ["subagent", "subagent_resume", "subagent_kill"]) {
			if (name !== "subagent_kill" && denied.has(name)) continue;
			pi.registerTool({ name, label: name, description: `pi-subagents ${name}`, parameters: {}, exposure, execute: executed(name) } as any);
		}
	};
}

/** A pi-subagents version whose suppression fails: it ignores PI_DENY_TOOLS. */
export function fakeForeignSubagent(exposure?: Exposure) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({ name: "subagent", label: "subagent", description: "foreign subagent", parameters: {}, exposure, execute: executed("foreign subagent") } as any);
	};
}

function executed(label: string) {
	return async () => ({ content: [{ type: "text", text: `${label} EXECUTED` }], details: undefined });
}
