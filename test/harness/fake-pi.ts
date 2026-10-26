/**
 * Layer 1 seam: a fake Pi extension host (spec "Testing Decisions").
 *
 * It loads extension factories in order, records tools, commands, event handlers, messages
 * and the active tool set, and fires events. It follows the Pi 1.4.0 rules this repository
 * relies on (docs/extensions.md, resource-loader.js detectExtensionConflicts):
 * - a tool name registered by two extensions while loading is a fatal load error;
 * - registering a `direct` or `model-only` tool activates it; other exposures stay inactive;
 * - setActiveTools ignores unknown names.
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
	private loading = true;

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
	addTool(name: string, path: string, exposure: Exposure = "direct", active = exposure === "direct"): void {
		this.tools.set(name, { name, exposure, sourceInfo: sourceInfo(path), definition: { name } });
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
		};
		return api as unknown as ExtensionAPI;
	}
}

function sourceInfo(path: string) {
	return { path, source: "cli", scope: "temporary", origin: "top-level" };
}

/**
 * Faithful stand-in for pi-subagents cf6dbf4 tool registration (src/subagents.ts:367-375):
 * it reads PI_DENY_TOOLS once in its factory, skips denied `subagent` and
 * `subagent_resume`, and registers `subagent_kill` without checking the variable.
 */
export function fakePiSubagents(env: Record<string, string | undefined>) {
	return (pi: ExtensionAPI) => {
		const denied = new Set((env.PI_DENY_TOOLS ?? "").split(",").map((name) => name.trim()).filter(Boolean));
		for (const name of ["subagent", "subagent_resume", "subagent_kill"]) {
			if (name !== "subagent_kill" && denied.has(name)) continue;
			pi.registerTool({ name, label: name, description: `pi-subagents ${name}`, parameters: {} } as any);
		}
	};
}

/** A pi-subagents version whose suppression fails: it ignores PI_DENY_TOOLS. */
export function fakeForeignSubagent() {
	return (pi: ExtensionAPI) => {
		pi.registerTool({ name: "subagent", label: "subagent", description: "foreign subagent", parameters: {} } as any);
	};
}
