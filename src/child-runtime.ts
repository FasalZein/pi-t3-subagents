/**
 * Child runtime bootstrap (spec "Child runtime"). Runs only in a managed instance
 * (`PI_T3_AGENT` present):
 * - while loading: set the agent file's `env` entries in the process environment (D24);
 * - before each run: remove a leading frontmatter block from the prompt sections that
 *   hold the agent file (`--system-prompt` / `--append-system-prompt`, D14), and append
 *   the body for `system-prompt: append` with `inherit-append-system: true`;
 * - first user input: read and remove the header line, store budget, caller and expected
 *   revision, and replace the input with the stale instruction on a revision mismatch (D28).
 *
 * Seams for later slices: `ChildRuntime.state()` gives the header facts (S5 budget and
 * guard); S7 adds caller ping, context warnings and the time limit next to these handlers.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentDefinition, agentsDir, readAgentEnv, readCatalog, stripFrontmatter } from "./catalog.ts";
import { HEADER_PREFIX, spawnableOf } from "./launch-planner.ts";
import { PRODUCTION_NAMESPACE } from "./planner.ts";

type Env = Record<string, string | undefined>;

export const AGENT_ENV = "PI_T3_AGENT";
export const REVISION_ENV = "PI_T3_REVISION";
export const HEADER_ENTRY = "pi-t3-subagents-header";

/**
 * Keys the agent `env` may not set: this extension's, every T3 control variable (`T3_*`:
 * the bridge's MCP connection, `T3_PI_RUNTIME_MODE` approval policy and
 * `T3_PI_MCP_EXTENSION_PATH` identity) and pi-subagents' spawn keys.
 */
export function isReservedEnvKey(key: string): boolean {
	return key.startsWith("PI_T3_") || key.startsWith("T3_") || key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS";
}

const HEADER_SOURCES: readonly HeaderSource[] = ["header", "missing", "unreadable"];

/** A saved header entry, validated; undefined when malformed. */
export function restoredState(data: unknown, agent: string, instanceId: string): ChildState | undefined {
	const d = data as Partial<ChildState> | null;
	if (!d || typeof d !== "object" || d.agent !== agent || d.instanceId !== instanceId) return undefined;
	if (!Number.isInteger(d.budget) || (d.budget as number) < 0 || typeof d.stale !== "boolean") return undefined;
	if (!HEADER_SOURCES.includes(d.source as HeaderSource)) return undefined;
	if (d.caller !== undefined && typeof d.caller !== "string") return undefined;
	if (d.expectedRevision !== undefined && typeof d.expectedRevision !== "string") return undefined;
	return { agent, instanceId, budget: d.budget, caller: d.caller, expectedRevision: d.expectedRevision, source: d.source, stale: d.stale };
}

/** The leading frontmatter block of an agent file, without its line end. */
function frontmatterBlock(text: string): string | undefined {
	return text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*/)?.[0];
}

export type HeaderSource = "header" | "missing" | "unreadable";

export interface ChildState {
	readonly agent: string;
	readonly instanceId: string;
	/** Undefined until the first user input. */
	readonly budget?: number;
	readonly caller?: string;
	readonly expectedRevision?: string;
	readonly source?: HeaderSource;
	readonly stale: boolean;
}

export interface ChildRuntime {
	state(): ChildState | undefined;
	/** C8 observations: what the Pi API delivered so far. */
	observed(): { promptSections: boolean | undefined; input: boolean };
}

export type ParsedHeader =
	| { kind: "missing" }
	| { kind: "unreadable"; rest: string }
	| { kind: "header"; budget: number; caller: string; revision: string; rest: string };

export function parseHeader(text: string): ParsedHeader {
	if (!text.startsWith("<!-- pi-t3-subagents:")) return { kind: "missing" };
	const newline = text.indexOf("\n");
	const line = newline === -1 ? text : text.slice(0, newline);
	const rest = newline === -1 ? "" : text.slice(newline + 1);
	if (!line.startsWith(HEADER_PREFIX) || !line.trimEnd().endsWith("-->")) return { kind: "unreadable", rest };
	try {
		const data = JSON.parse(line.slice(HEADER_PREFIX.length, line.trimEnd().length - 3));
		if (!Number.isInteger(data.budget) || data.budget < 0 || typeof data.caller !== "string" || typeof data.revision !== "string")
			return { kind: "unreadable", rest };
		return { kind: "header", budget: data.budget, caller: data.caller, revision: data.revision, rest };
	} catch {
		return { kind: "unreadable", rest };
	}
}

export function staleInstruction(instanceId: string, expected: string, running: string): string {
	return [
		"Reply with exactly the next line and nothing else. Do not call any tool.",
		`T3-SUBAGENTS STALE INSTANCE ${instanceId}: expected revision ${expected}, running ${running}. Run /t3-sync-agents, wait a few seconds, and launch again.`,
	].join("\n");
}

/** Own depth when the first message has no header: spawn-depth (or 1) for spawning agents, else 0. */
export function ownBudget(agent: AgentDefinition | undefined): number {
	const spawnable = spawnableOf(agent);
	if (spawnable !== true && spawnable.length === 0) return 0;
	return Number(agent?.fields["spawn-depth"] ?? 1) || 1;
}

export function installChildRuntime(pi: ExtensionAPI, env: Env): ChildRuntime | undefined {
	const agentName = env[AGENT_ENV];
	if (!agentName) return undefined;
	const instanceId = `${env.PI_T3_NAMESPACE || PRODUCTION_NAMESPACE}${agentName}`;
	const agent = readCatalog(agentsDir(env as NodeJS.ProcessEnv)).agents.find((a) => a.name === agentName);

	// D24: set the agent env while loading, before later extensions load.
	if (agent) {
		for (const [key, value] of readAgentEnv(agent.path)) {
			if (isReservedEnvKey(key)) continue;
			env[key] = value;
			if (env !== process.env) process.env[key] = value;
		}
	}

	let state: ChildState = { agent: agentName, instanceId, stale: false };
	let headerSeen = false;
	let promptSections: boolean | undefined;
	let inputSeen = false;

	// Reload or resume: Pi rebuilds this extension, so restore the saved header state of
	// this session. A session with earlier user messages but no valid saved state fails
	// closed (budget 0); only a new thread may take the own-depth fallback.
	pi.on("session_start", async (_event, ctx) => {
		if (headerSeen) return;
		const entries: any[] = (ctx as any)?.sessionManager?.getEntries?.() ?? [];
		const saved = entries.filter((e) => e?.type === "custom" && e.customType === HEADER_ENTRY).at(-1);
		const hadInput = entries.some((e) => e?.type === "message" && e.message?.role === "user");
		if (saved) {
			state = restoredState(saved.data, agentName, instanceId) ?? { ...state, budget: 0, source: "unreadable" };
			headerSeen = true;
		} else if (hadInput) {
			state = { ...state, budget: 0, source: "unreadable" };
			headerSeen = true;
		}
	});

	pi.on("input", async (event) => {
		inputSeen = true;
		if (headerSeen) return { action: "continue" };
		headerSeen = true;
		const parsed = parseHeader(event.text);
		if (parsed.kind === "missing") {
			state = { ...state, budget: ownBudget(agent), source: "missing" };
			remember(pi, state);
			return { action: "continue" };
		}
		if (parsed.kind === "unreadable") {
			state = { ...state, budget: 0, source: "unreadable" };
			remember(pi, state);
			return { action: "transform", text: parsed.rest };
		}
		const running = env[REVISION_ENV] ?? "none";
		const stale = parsed.revision !== running;
		state = { ...state, budget: parsed.budget, caller: parsed.caller, expectedRevision: parsed.revision, source: "header", stale };
		remember(pi, state);
		return { action: "transform", text: stale ? staleInstruction(instanceId, parsed.revision, running) : parsed.rest };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const options: any = (event as any).systemPromptOptions;
		promptSections = !!options && typeof options === "object";
		// Fail closed: without the agent definition or the prompt sections, the agent file's
		// frontmatter (env values included) could reach the model. Stop before any request.
		if (!promptSections || !agent) {
			const why = !agent
				? `agent '${agentName}' is not an enabled global agent in ${agentsDir(env as NodeJS.ProcessEnv)}`
				: "Pi gave no systemPromptOptions (C8)";
			(ctx as any)?.ui?.notify?.(`pi-t3-subagents: run stopped before any model request: ${why}. Run /t3-sync-agents and launch again.`, "error");
			(ctx as any)?.abort?.();
			return { systemPrompt: "" };
		}
		// D14: strip the frontmatter only in the section that holds the agent file.
		const mode = agent.fields["system-prompt"];
		const key = mode === "replace" ? "customPrompt" : mode === "append" && agent.fields["inherit-append-system"] !== "true" ? "appendSystemPrompt" : undefined;
		const block = key ? frontmatterBlock(readFileSync(agent.path, "utf8")) : undefined;
		const value = key ? options[key] : undefined;
		if (key && block && typeof value === "string") {
			const at = value.indexOf(block);
			if (at >= 0) options[key] = value.slice(0, at) + value.slice(at + block.length).replace(/^\s+/, "");
		}
		if (agent.fields["system-prompt"] === "append" && agent.fields["inherit-append-system"] === "true") {
			const body = stripFrontmatter(readFileSync(agent.path, "utf8")).trim();
			const current = typeof options.appendSystemPrompt === "string" ? options.appendSystemPrompt : "";
			if (!current.includes(body)) options.appendSystemPrompt = current ? `${current}\n\n${body}` : body;
		}
	});

	return { state: () => state, observed: () => ({ promptSections, input: inputSeen }) };
}

function remember(pi: ExtensionAPI, state: ChildState): void {
	const append = (pi as any).appendEntry;
	if (typeof append === "function") append.call(pi, HEADER_ENTRY, state);
}
