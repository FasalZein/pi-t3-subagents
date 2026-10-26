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

/** Keys the agent `env` may not set: this extension's, T3's bridge and pi-subagents' spawn keys. */
export function isReservedEnvKey(key: string): boolean {
	return key.startsWith("PI_T3_") || key.startsWith("T3_MCP_") || key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS";
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

	pi.on("before_agent_start", async (event) => {
		const options: any = (event as any).systemPromptOptions;
		promptSections = !!options && typeof options === "object";
		if (!promptSections || !agent) return;
		// D14: strip a leading frontmatter block only in the sections that hold the agent file.
		for (const key of ["customPrompt", "appendSystemPrompt"] as const) {
			const value = options[key];
			if (typeof value === "string" && value.startsWith("---")) options[key] = stripFrontmatter(value).replace(/^\s+/, "");
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
