/**
 * Agent catalog: reads pi-subagents agent definitions with pi-subagents' own
 * frontmatter rules (C9, copied from pi-subagents src/agents/definitions.ts at
 * cf6dbf4): one regex per `key: value` line, `env` and `deny-env` accept a
 * `|` block, only the literal `enabled: false` disables an agent.
 *
 * Secret rule (D24): the catalog keeps only the KEYS of an agent's `env`
 * block. Values are never read into memory here, so no plan, settings entry or
 * backup can contain them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface AgentDefinition {
	readonly name: string;
	/** Absolute path of the agent file. */
	readonly path: string;
	readonly enabled: boolean;
	/** Raw single-line frontmatter values, keyed by field name. */
	readonly fields: Readonly<Record<string, string>>;
	/** Keys of the `env` block. Values are deliberately not kept. */
	readonly envKeys: readonly string[];
}

export interface CatalogResult {
	readonly agents: readonly AgentDefinition[];
	readonly unreadable: readonly { path: string; reason: string }[];
}

/** pi-subagents getAgentConfigDir(): PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function agentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** A12: PI_T3_AGENTS_DIR, else the global agents folder. */
export function agentsDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_T3_AGENTS_DIR ? resolve(env.PI_T3_AGENTS_DIR) : join(agentConfigDir(env), "agents");
}

const FIELD_LINE = /^([a-z][a-z0-9-]*):[ \t]*(.*)$/;

export function parseAgentFile(path: string): AgentDefinition | null {
	const content = readFileSync(path, "utf8");
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const lines = match[1].split(/\r?\n/);
	const fields: Record<string, string> = {};
	let envKeys: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(FIELD_LINE);
		if (!m) continue;
		const [, key, rawValue] = m;
		const value = rawValue.trim();
		// pi-subagents takes the FIRST line that matches a key (String.match).
		if (key in fields) continue;
		if ((key === "env" || key === "deny-env") && value === "|") {
			const block: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].trim() && !/^[ \t]/.test(lines[j])) break;
				block.push(lines[j].trim());
			}
			if (key === "env") envKeys = envKeysOf(block);
			fields[key] = "|";
			continue;
		}
		if (!value) continue; // pi-subagents' regex needs at least one character.
		if (key === "env") {
			envKeys = envKeysOf([value]);
			fields[key] = "|";
			continue;
		}
		fields[key] = value;
	}
	return {
		name: fields.name ?? basename(path, ".md"),
		path: resolve(path),
		enabled: fields.enabled !== "false",
		fields,
		envKeys,
	};
}

function envKeysOf(lines: string[]): string[] {
	const keys: string[] = [];
	for (const line of lines) {
		const eq = line.indexOf("=");
		if (eq > 0) keys.push(line.slice(0, eq).trim());
	}
	return keys;
}

/** Reads every `*.md` agent file in the folder, disabled ones included. */
export function readCatalog(dir: string): CatalogResult {
	if (!existsSync(dir)) return { agents: [], unreadable: [] };
	const agents: AgentDefinition[] = [];
	const unreadable: { path: string; reason: string }[] = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
		const path = join(dir, file);
		try {
			const agent = parseAgentFile(path);
			if (agent) agents.push(agent);
			else unreadable.push({ path, reason: "no frontmatter block" });
		} catch (error) {
			unreadable.push({ path, reason: (error as Error).message });
		}
	}
	return { agents, unreadable };
}

/** D18: project agents live in `<cwd>/.pi/agents`; v1 does not support them. */
export function projectAgentNames(cwd: string): string[] {
	const dir = join(cwd, ".pi", "agents");
	if (!existsSync(dir)) return [];
	return readCatalog(dir).agents.map((a) => a.name);
}
