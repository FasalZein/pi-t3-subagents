/**
 * Instance planner: a pure function from one agent definition plus host facts
 * to the expected managed instance entry and its revision. The spec's
 * "Managed instance shape" and "Field mapping" (Launch rows) are the contract.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentDefinition } from "./catalog.ts";
import { MANAGED_BY, type EnvironmentEntry, type ProviderInstanceEntry } from "./settings-shape.ts";

export const PRODUCTION_NAMESPACE = "pi-";

export interface HostFacts {
	/** Instance id prefix (A12, PI_T3_NAMESPACE). */
	readonly namespace: string;
	/** Absolute path of the extension copy that runs the sync (A14). */
	readonly extensionPath: string;
	/** Agent configuration folder: PI_CODING_AGENT_DIR or ~/.pi/agent. */
	readonly configDir: string;
	/** Agents folder written into namespace instances (PI_T3_AGENTS_DIR). */
	readonly agentsDir: string;
	/** A13: main instance binaryPath, else `pi` from PATH. */
	readonly binaryPath: string;
	readonly home?: string;
	/** Absolute SKILL.md path for a skill name, or undefined when unknown. */
	readonly resolveSkill: (name: string) => string | undefined;
	/** Installed path for an `npm:` or `git:` spec, or undefined (spec passes through). */
	readonly resolvePackage: (spec: string) => string | undefined;
	/** Host problems to show in the plan (for example a configured package that is not installed). */
	readonly notices?: readonly string[];
}

export type InstancePlan =
	| {
			readonly kind: "entry";
			readonly agent: string;
			readonly id: string;
			readonly entry: ProviderInstanceEntry;
			readonly revision: string;
			readonly gaps: readonly string[];
	  }
	| { readonly kind: "skip"; readonly agent: string; readonly id: string; readonly reason: string };

/** Flags that T3 controls (C7). A launch argument with one of them fails the T3 session. */
export const RESERVED_FLAGS = new Set([
	"--mode",
	"--session",
	"--session-id",
	"--no-session",
	"--resume",
	"--continue",
	"--fork",
	"--print",
	"--export",
	"--help",
	"--list-models",
	"--version",
]);

/**
 * Pi flags whose value is a credential (`pi --help`, Pi 1.4.0). T3 stores
 * launchArgs in plain settings and does not redact them, so an agent that
 * passes one in `flags` is skipped; the value belongs in the agent `env`,
 * which the child reads at runtime (ADR 0002).
 */
export const CREDENTIAL_FLAGS = new Set(["--api-key"]);

/**
 * T3's Pi launch argument contract (C7), copied from T3 resolvePiLaunchArgs
 * (provider-pi mcpInjection.ts, nightly 0.1.3-nightly.20261026.3710).
 */
const T3_FLAGS_WITH_VALUES = new Set([
	"--api-key",
	"--append-system-prompt",
	"--exclude-tools",
	"-xt",
	"--extension",
	"-e",
	"--model",
	"--models",
	"--name",
	"-n",
	"--prompt-template",
	"--provider",
	"--session-dir",
	"--skill",
	"--system-prompt",
	"--theme",
	"--thinking",
	"--tools",
	"-t",
	"--tui-mode",
	"--use-theme",
]);
const T3_FLAGS_WITHOUT_VALUES = new Set([
	"--approve",
	"-a",
	"--no-approve",
	"-na",
	"--no-builtin-tools",
	"-nbt",
	"--no-context-files",
	"-nc",
	"--no-extensions",
	"-ne",
	"--no-prompt-templates",
	"-np",
	"--no-skills",
	"-ns",
	"--no-themes",
	"--no-tools",
	"-nt",
	"--offline",
	"--verbose",
]);

/**
 * Problems that make T3 reject these launch arguments (the instance becomes
 * unavailable). Messages name flags only, never values.
 */
export function t3LaunchArgProblems(tokens: readonly string[], options: { complete: boolean } = { complete: true }): string[] {
	const args = tokens.flatMap((arg) => {
		const eq = arg.indexOf("=");
		return eq > 0 && T3_FLAGS_WITH_VALUES.has(arg.slice(0, eq)) ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg];
	});
	const problems: string[] = [];
	let hasProvider = false;
	let hasModel = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const flag = arg.split("=")[0];
		if (RESERVED_FLAGS.has(flag) || ["-c", "-h", "-p", "-r", "-v"].includes(arg)) {
			problems.push(`"${flag}" is reserved by T3`);
			continue;
		}
		if (arg === "--") {
			problems.push('"--" is not supported by T3');
			continue;
		}
		if (T3_FLAGS_WITH_VALUES.has(arg)) {
			if (args[i + 1] === undefined) problems.push(`"${arg}" needs a value`);
			if (arg === "--provider") hasProvider = true;
			if (arg === "--model") hasModel = true;
			i++;
			continue;
		}
		if (T3_FLAGS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) continue;
		if (arg.startsWith("--")) {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) i++;
			continue;
		}
		if (arg.startsWith("-")) problems.push(`short flag "${arg}" is not supported by T3; use the long form`);
		else problems.push("a positional argument is not supported by T3");
	}
	// Cross-argument rule: only meaningful for the complete list, not for a fragment such as raw `flags`.
	if (options.complete && hasProvider && !hasModel) problems.push('"--provider" needs "--model"');
	return problems;
}

/**
 * The sync's own rule for raw `flags` (stricter than T3): long flags only.
 * T3 accepts aliases such as `-a`, `-e` and `-t`; the sync rejects them so
 * that every stored launch argument is a long flag. Values of known value
 * flags are skipped, so a value that starts with "-" is not a flag.
 */
export function shortFlagProblems(tokens: readonly string[]): string[] {
	const problems: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (/^-[^-]/.test(token)) problems.push(`short flag "${token}" is not supported; use the long form`);
		else if (T3_FLAGS_WITH_VALUES.has(token)) i++; // Skip the value of a long value flag.
	}
	return problems;
}

/** Bridge tools that start threads or tasks. Leaves exclude them (D22). */
export const THREAD_STARTING_TOOLS = [
	"delegate_task",
	"create_threads",
	"t3_thread_launch",
	"t3_thread_fork",
	"t3_thread_send",
	"schedule_task",
].map((t) => `mcp__t3-code__${t}`);

const SPAWNER_TOOLS = [
	"subagent",
	"mcp__t3-code__delegate_task",
	"mcp__t3-code__task_status",
	"mcp__t3-code__task_cancel",
	"mcp__t3-code__t3_thread_send",
];

/**
 * Environment variables that Pi reads before any extension loads
 * (docs/environment-variables.md, Pi 1.4.0). The child wrapper cannot set
 * them, so an agent `env` entry with one of these keys is a gap (D24).
 */
export const PRE_EXTENSION_PI_VARIABLES = new Set([
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_PACKAGE_DIR",
	"PI_OFFLINE",
	"PI_SKIP_VERSION_CHECK",
	"PI_TELEMETRY",
]);

/** Fields with no T3 meaning (spec "Field mapping", Gaps). */
export const GAP_FIELDS: Record<string, string> = {
	"report-context-usage": "report-context-usage: T3 owns the wake text",
	cwd: "cwd: not supported in T3",
	"deny-env": "deny-env: not supported in T3",
	"no-session": "no-session: T3 controls the session",
	"idle-timeout": "idle-timeout: not supported in T3",
	"on-timeout": "on-timeout: not supported in T3",
	"parent-close-policy": "parent-close-policy: not supported in T3",
	"llm-as-a-verifier": "llm-as-a-verifier: not supported in T3",
	"llm-as-a-verifier-candidates": "llm-as-a-verifier-candidates: not supported in T3",
	"llm-as-a-verifier-model": "llm-as-a-verifier-model: not supported in T3",
	"llm-as-a-verifier-criteria": "llm-as-a-verifier-criteria: not supported in T3",
};

const AGENT_NAME = /^[A-Za-z0-9_-]+$/;
const T3_INSTANCE_ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const T3_INSTANCE_ID_MAX = 64;
const REVISION_LENGTH = 12;

export function mainInstanceId(namespace: string): string {
	return namespace === PRODUCTION_NAMESPACE ? "pi" : `${namespace}main`;
}

export function displayNameFor(agent: string, namespace: string): string {
	return namespace === PRODUCTION_NAMESPACE ? `Pi ${agent}` : `Pi ${agent} [${namespace}]`;
}

/** Quote one argument for T3's tokenizeCliArgs (C7). */
export function quoteArg(arg: string): string {
	if (arg === "") return '""';
	if (!/[\s"'\\$`]/.test(arg)) return arg;
	return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Shell-like tokenizer with T3's rules: quotes group, empty quotes are kept, no expansion. */
export function tokenizeArgs(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let has = false;
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote === "'") {
			if (c === "'") quote = null;
			else current += c;
		} else if (quote === '"') {
			if (c === '"') quote = null;
			else if (c === "\\" && i + 1 < text.length && /["\\$`]/.test(text[i + 1])) current += text[++i];
			else current += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			has = true;
		} else if (c === "\\" && i + 1 < text.length) {
			current += text[++i];
			has = true;
		} else if (/\s/.test(c)) {
			if (has) tokens.push(current);
			current = "";
			has = false;
		} else {
			current += c;
			has = true;
		}
	}
	if (quote) throw new Error("unterminated quote");
	if (has) tokens.push(current);
	return tokens;
}

export function revisionOf(entry: ProviderInstanceEntry): string {
	const environment = (entry.environment ?? []).filter((e) => e.name !== "PI_T3_REVISION");
	const material = JSON.stringify({
		launchArgs: entry.config?.launchArgs,
		binaryPath: entry.config?.binaryPath,
		displayName: entry.displayName,
		enabled: entry.enabled,
		environment,
	});
	return createHash("sha256").update(material).digest("hex").slice(0, REVISION_LENGTH);
}

const list = (value: string): string[] =>
	value
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

class SkipAgent extends Error {}

export function planInstance(agent: AgentDefinition, host: HostFacts): InstancePlan {
	const id = `${host.namespace}${agent.name}`;
	try {
		return planOrThrow(agent, host, id);
	} catch (error) {
		if (error instanceof SkipAgent) return { kind: "skip", agent: agent.name, id, reason: error.message };
		throw error;
	}
}

function planOrThrow(agent: AgentDefinition, host: HostFacts, id: string): InstancePlan {
	const f = agent.fields;
	if (!AGENT_NAME.test(agent.name)) throw new SkipAgent(`invalid agent name "${agent.name}" (allowed: A-Z a-z 0-9 _ -)`);
	if (!T3_INSTANCE_ID.test(id) || id.length > T3_INSTANCE_ID_MAX)
		throw new SkipAgent(`instance id "${id}" is not a valid T3 id (letter first, at most ${T3_INSTANCE_ID_MAX} characters)`);
	if (id === mainInstanceId(host.namespace)) throw new SkipAgent(`instance id "${id}" is the main instance id`);

	const home = host.home ?? homedir();
	const gaps: string[] = [];
	const args: string[] = [];
	const spawns = f.spawning !== undefined && f.spawning !== "false";
	const interactive = f.mode === "interactive";

	// Extensions: the extension itself always comes first.
	const extensions = f.extensions;
	if (extensions === undefined || extensions === "all") {
		args.push("--extension", host.extensionPath);
	} else {
		args.push("--no-extensions", "--extension", host.extensionPath, "--extension", "builtin:mcp", "--extension", "builtin:tool-search");
		if (extensions !== "none") {
			for (const spec of list(extensions)) args.push("--extension", resolveExtension(spec, host, home));
		}
	}

	if (f.model) args.push("--model", f.model);
	if (f.thinking) args.push("--thinking", f.thinking);
	if (f["no-context-files"] === "true") args.push("--no-context-files");

	// System prompt (D14). pi-subagents: inherit-append-system defaults to false.
	const inheritAppend = f["inherit-append-system"] === "true";
	const systemPrompt = f["system-prompt"];
	if (systemPrompt === "replace") args.push("--system-prompt", agent.path);
	if (systemPrompt === "append" && !inheritAppend) args.push("--append-system-prompt", agent.path);
	else if (!inheritAppend) args.push("--append-system-prompt", "");

	args.push(interactive && f["trust-project"] === "true" ? "--approve" : "--no-approve");

	// Tools.
	const tools = f.tools;
	if (tools === "none") args.push("--no-builtin-tools");
	else if (tools !== undefined && tools !== "all") {
		const allow = [...list(tools), "caller_ping", ...(spawns ? SPAWNER_TOOLS : [])];
		args.push("--tools", [...new Set(allow)].join(","));
	}
	const exclude = [...(f["deny-tools"] ? list(f["deny-tools"]) : []), ...(spawns ? [] : ["subagent", ...THREAD_STARTING_TOOLS])];
	if (exclude.length > 0) args.push("--exclude-tools", [...new Set(exclude)].join(","));

	// Skills.
	const skills = f.skills;
	if (skills === "none") args.push("--no-skills");
	else if (skills !== undefined && skills !== "all") {
		args.push("--no-skills");
		for (const raw of list(skills)) {
			const annotated = raw.match(/^(.+)=(auto|manual)$/);
			const name = annotated ? annotated[1] : raw;
			if (annotated) gaps.push(`skills: "=${annotated[2]}" annotation on ${name} is removed (D9)`);
			const path = host.resolveSkill(name);
			if (!path) throw new SkipAgent(`unknown skill "${name}"`);
			args.push("--skill", path);
		}
	}

	// Raw flags come last.
	if (f.flags) {
		let tokens: string[];
		try {
			tokens = tokenizeArgs(f.flags);
		} catch (error) {
			throw new SkipAgent(`flags: ${(error as Error).message}`);
		}
		for (const token of tokens) {
			const flag = token.split("=")[0];
			if (CREDENTIAL_FLAGS.has(flag))
				throw new SkipAgent(`flags: "${flag}" carries a credential, and T3 stores launch arguments in plain settings; set the key in the agent env instead`);
		}
		const problems = [...shortFlagProblems(tokens), ...t3LaunchArgProblems(tokens, { complete: false })];
		if (problems.length > 0) throw new SkipAgent(`flags: ${problems[0]}`);
		args.push(...tokens);
	}
	// The whole argument list must pass T3's contract (for example --provider without --model).
	const problems = t3LaunchArgProblems(args);
	if (problems.length > 0) throw new SkipAgent(`launch arguments: ${problems.join("; ")}`);

	for (const [field, note] of Object.entries(GAP_FIELDS)) if (f[field] !== undefined) gaps.push(note);
	if (f["session-mode"] === "fork") gaps.push("session-mode: fork is not supported; the child starts fresh (A9)");
	for (const key of agent.envKeys)
		if (PRE_EXTENSION_PI_VARIABLES.has(key)) gaps.push(`env: ${key} is read by Pi before extensions load; it has no effect in T3`);

	const environment: EnvironmentEntry[] = [{ name: "PI_T3_AGENT", value: agent.name, sensitive: false }];
	if (host.namespace !== PRODUCTION_NAMESPACE) {
		environment.push({ name: "PI_T3_NAMESPACE", value: host.namespace, sensitive: false });
		environment.push({ name: "PI_T3_AGENTS_DIR", value: host.agentsDir, sensitive: false });
	}
	const entry: ProviderInstanceEntry = {
		driver: "pi",
		displayName: displayNameFor(agent.name, host.namespace),
		enabled: true,
		environment,
		config: {
			binaryPath: host.binaryPath,
			launchArgs: args.map(quoteArg).join(" "),
			managedBy: MANAGED_BY,
			namespace: host.namespace,
		},
	};
	const revision = revisionOf(entry);
	entry.environment = [...environment.slice(0, 1), { name: "PI_T3_REVISION", value: revision, sensitive: false }, ...environment.slice(1)];
	return { kind: "entry", agent: agent.name, id, entry, revision, gaps };
}

function resolveExtension(spec: string, host: HostFacts, home: string): string {
	if (spec === "~") return home;
	if (spec.startsWith("~/")) return join(home, spec.slice(2));
	if (/^(npm|git):/.test(spec)) return host.resolvePackage(spec) ?? spec;
	// Other scheme-like specs (builtin:, https:) pass through, as in pi-subagents.
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return spec;
	return isAbsolute(spec) ? spec : resolve(host.configDir, spec);
}
