/**
 * `/t3-sync-agents [--prune] [--yes]`: plans managed instances for every
 * agent definition, shows the plan, confirms, and writes through the settings
 * writer. Spec "Sync flow and settings writer".
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentDefinition, agentConfigDir, agentsDir, readCatalog } from "./catalog.ts";
import { type HostFacts, type InstancePlan, mainInstanceId, planInstance, PRODUCTION_NAMESPACE, tokenizeArgs } from "./planner.ts";
import { isOwnedBy, jsonEqual, type ProviderInstanceEntry, type Settings, settingsShapeProblems } from "./settings-shape.ts";
import { type WriteOutcome, type WriterHooks, writeSettings } from "./settings-writer.ts";

export type SyncAction =
	| { readonly kind: "add" | "update" | "unchanged"; readonly id: string; readonly agent: string; readonly entry: ProviderInstanceEntry }
	| { readonly kind: "disable"; readonly id: string; readonly entry: ProviderInstanceEntry }
	| { readonly kind: "prune"; readonly id: string }
	| { readonly kind: "conflict"; readonly id: string; readonly agent: string };

export interface SyncPlan {
	readonly namespace: string;
	readonly actions: readonly SyncAction[];
	readonly skipped: readonly { agent: string; reason: string }[];
	readonly gaps: readonly { agent: string; notes: readonly string[] }[];
	readonly warnings: readonly string[];
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_T3_SETTINGS_PATH ? resolve(env.PI_T3_SETTINGS_PATH) : join(homedir(), ".t3", "userdata", "settings.json");
}

export function namespaceOf(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_T3_NAMESPACE || PRODUCTION_NAMESPACE;
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentConfigDir(env), "t3-subagents");
}

/** Pure: planned entries plus the current settings give the sync actions. */
export function planSync(input: {
	readonly agents: readonly AgentDefinition[];
	readonly settings: Settings;
	readonly host: HostFacts;
	readonly prune: boolean;
}): SyncPlan {
	const { host, settings } = input;
	const ns = host.namespace;
	const instances = settings.providerInstances ?? {};
	const mainId = mainInstanceId(ns);
	const actions: SyncAction[] = [];
	const skipped: { agent: string; reason: string }[] = [];
	const gaps: { agent: string; notes: readonly string[] }[] = [];
	const planned = new Set<string>();
	const keep = new Set<string>(); // Skipped agents: their existing entries stay as they are.

	for (const agent of input.agents) {
		if (!agent.enabled) continue;
		const plan: InstancePlan = planInstance(agent, host);
		if (plan.kind === "skip") {
			skipped.push({ agent: plan.agent, reason: plan.reason });
			keep.add(plan.id);
			continue;
		}
		if (plan.gaps.length > 0) gaps.push({ agent: plan.agent, notes: plan.gaps });
		planned.add(plan.id);
		const existing = instances[plan.id];
		if (existing === undefined) actions.push({ kind: "add", id: plan.id, agent: plan.agent, entry: plan.entry });
		else if (!isOwnedBy(existing, ns)) actions.push({ kind: "conflict", id: plan.id, agent: plan.agent });
		else if (jsonEqual(existing, plan.entry)) actions.push({ kind: "unchanged", id: plan.id, agent: plan.agent, entry: plan.entry });
		else actions.push({ kind: "update", id: plan.id, agent: plan.agent, entry: plan.entry });
	}

	// Owned entries of this namespace without an enabled agent: disable (D12), prune when asked.
	for (const [id, entry] of Object.entries(instances)) {
		if (id === mainId || planned.has(id) || keep.has(id) || !id.startsWith(ns) || !isOwnedBy(entry, ns)) continue;
		if (input.prune) actions.push({ kind: "prune", id });
		else if (entry.enabled !== false) actions.push({ kind: "disable", id, entry: { ...entry, enabled: false } });
	}

	const warnings: string[] = [];
	const main = instances[mainId];
	if (!main) warnings.push(`main instance "${mainId}" not found in T3 settings`);
	else if (!loadsExtension(main, host.extensionPath))
		warnings.push(`main instance "${mainId}" does not load this extension (--extension ${host.extensionPath}); takeover is missing there`);

	return { namespace: ns, actions, skipped, gaps, warnings };
}

function loadsExtension(entry: ProviderInstanceEntry, extensionPath: string): boolean {
	const launchArgs = entry.config?.launchArgs;
	if (typeof launchArgs !== "string") return false;
	try {
		const tokens = tokenizeArgs(launchArgs);
		return tokens.some((t, i) => (t === "--extension" || t === "-e") && tokens[i + 1] === extensionPath);
	} catch {
		return false;
	}
}

export const hasChanges = (plan: SyncPlan) => plan.actions.some((a) => a.kind !== "unchanged" && a.kind !== "conflict");

/** Pure: apply the plan's changes to a copy of the settings. Other content is kept. */
export function applyPlan(settings: Settings, plan: SyncPlan): Settings {
	const instances: Record<string, ProviderInstanceEntry> = { ...(settings.providerInstances ?? {}) };
	for (const action of plan.actions) {
		if (action.kind === "add" || action.kind === "update" || action.kind === "disable") instances[action.id] = action.entry;
		else if (action.kind === "prune") delete instances[action.id];
	}
	return { ...settings, providerInstances: instances };
}

/** Problems in reloaded settings: a planned entry that is missing or different. */
export function verifyPlan(reloaded: unknown, plan: SyncPlan): string[] {
	const instances = ((reloaded as Settings)?.providerInstances ?? {}) as Record<string, ProviderInstanceEntry>;
	const problems: string[] = [];
	for (const action of plan.actions) {
		if (action.kind === "add" || action.kind === "update" || action.kind === "disable") {
			if (!jsonEqual(instances[action.id], action.entry)) problems.push(`${action.id} is missing or different`);
		} else if (action.kind === "prune" && instances[action.id] !== undefined) problems.push(`${action.id} still exists`);
	}
	return problems;
}

/** Plan text. Contains ids, agent names, reasons and notes; never environment values. */
export function formatPlan(plan: SyncPlan): string {
	const lines: string[] = [`T3 sync plan (namespace ${plan.namespace}):`];
	const by = (k: SyncAction["kind"]) => plan.actions.filter((a) => a.kind === k).map((a) => a.id);
	for (const kind of ["add", "update", "disable", "prune", "conflict", "unchanged"] as const) {
		const ids = by(kind);
		if (ids.length === 0) continue;
		const label = kind === "conflict" ? "conflict (id exists without this sync's markers; not changed)" : kind;
		lines.push(`  ${label}: ${ids.join(", ")}`);
	}
	for (const s of plan.skipped) lines.push(`  skip ${s.agent}: ${s.reason}`);
	for (const g of plan.gaps) for (const note of g.notes) lines.push(`  gap ${g.agent}: ${note}`);
	for (const w of plan.warnings) lines.push(`  warning: ${w}`);
	if (!hasChanges(plan)) lines.push("  up to date");
	return lines.join("\n");
}

/** Production host facts from the environment and the main instance (A12-A14). */
export function hostFacts(env: NodeJS.ProcessEnv, settings: Settings, extensionPath: string): HostFacts {
	const namespace = namespaceOf(env);
	const configDir = agentConfigDir(env);
	const home = homedir();
	const mainBinary = settings.providerInstances?.[mainInstanceId(namespace)]?.config?.binaryPath;
	return {
		namespace,
		extensionPath,
		configDir,
		agentsDir: agentsDir(env),
		binaryPath: typeof mainBinary === "string" && mainBinary ? mainBinary : whichPi(),
		home,
		resolveSkill: (name) =>
			[join(configDir, "skills", name, "SKILL.md"), join(home, ".agents", "skills", name, "SKILL.md")].find((p) => existsSync(p)),
		resolvePackage: (spec) => installedPackagePath(spec, configDir),
	};
}

function whichPi(): string {
	try {
		return execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8" }).trim() || "pi";
	} catch {
		return "pi";
	}
}

/**
 * Installed path of an `npm:` or `git:` package spec, matching Pi's install
 * layout (`<config dir>/npm/node_modules/<name>`, `<config dir>/git/<host>/<path>`).
 * Versioned npm specs and missing installs pass through for Pi to resolve.
 */
export function installedPackagePath(spec: string, configDir: string): string | undefined {
	if (spec.startsWith("npm:")) {
		const name = spec.slice(4);
		if (/@[^/]*$/.test(name.replace(/^@/, ""))) return undefined; // Versioned.
		const path = join(configDir, "npm", "node_modules", name);
		return existsSync(path) ? path : undefined;
	}
	if (spec.startsWith("git:")) {
		const path = join(configDir, "git", spec.slice(4).replace(/\.git$/, ""));
		return !spec.includes("@") && existsSync(path) ? path : undefined;
	}
	return undefined;
}

export interface SyncUi {
	readonly hasUI: boolean;
	confirm(title: string, message: string): Promise<boolean>;
}

export interface SyncRunOptions {
	readonly args: string;
	readonly env: NodeJS.ProcessEnv;
	readonly extensionPath: string;
	readonly ui: SyncUi;
	/** Override of the host facts (tests). */
	readonly host?: (settings: Settings) => HostFacts;
	readonly reloadWaitMs?: number;
	readonly hooks?: WriterHooks;
}

export interface SyncReport {
	readonly status: "up-to-date" | "written" | "declined" | "needs-yes" | "refused" | "changed" | "lost";
	readonly text: string;
	readonly plan?: SyncPlan;
	readonly outcome?: WriteOutcome;
}

export function parseSyncArgs(args: string): { prune: boolean; yes: boolean; unknown: string[] } {
	const tokens = args.split(/\s+/).filter(Boolean);
	return {
		prune: tokens.includes("--prune"),
		yes: tokens.includes("--yes"),
		unknown: tokens.filter((t) => t !== "--prune" && t !== "--yes"),
	};
}

export async function runSync(opts: SyncRunOptions): Promise<SyncReport> {
	const { prune, yes, unknown } = parseSyncArgs(opts.args);
	if (unknown.length > 0) return { status: "refused", text: `Unknown arguments: ${unknown.join(" ")}. Usage: /t3-sync-agents [--prune] [--yes]` };
	const path = settingsPath(opts.env);
	let originalText: string;
	let settings: Settings;
	try {
		originalText = readFileSync(path, "utf8");
		settings = JSON.parse(originalText);
	} catch (error) {
		return { status: "refused", text: `Cannot read T3 settings at ${path}: ${(error as Error).message}` };
	}
	const shape = settingsShapeProblems(settings);
	if (shape.length > 0) return { status: "refused", text: `T3 settings have an unexpected shape (C6); no write:\n  ${shape.join("\n  ")}` };

	const host = opts.host ? opts.host(settings) : hostFacts(opts.env, settings, opts.extensionPath);
	const catalog = readCatalog(host.agentsDir);
	const plan = planSync({ agents: catalog.agents, settings, host, prune });
	const unreadable = catalog.unreadable.map((u) => `  unreadable agent file ${u.path}: ${u.reason}`);
	const text = [formatPlan(plan), ...unreadable].join("\n");
	if (!hasChanges(plan)) return { status: "up-to-date", text, plan };

	if (!yes) {
		if (!opts.ui.hasUI) return { status: "needs-yes", text: `${text}\nNo UI to confirm: run /t3-sync-agents --yes to write.`, plan };
		if (!(await opts.ui.confirm("Write T3 settings?", text))) return { status: "declined", text: `${text}\nNot written.`, plan };
	}

	const next = applyPlan(settings, plan);
	const outcome = await writeSettings({
		settingsPath: path,
		stateDir: stateDir(opts.env),
		originalText,
		nextText: `${JSON.stringify(next, null, 2)}\n`,
		verify: (reloaded) => verifyPlan(reloaded, plan),
		reloadWaitMs: opts.reloadWaitMs,
		hooks: opts.hooks,
	});
	const counts = ["add", "update", "disable", "prune"]
		.map((k) => `${k} ${plan.actions.filter((a) => a.kind === k).length}`)
		.join(", ");
	if (outcome.status === "changed") return { status: "changed", text: `${text}\n${outcome.message}`, plan, outcome };
	if (outcome.status === "lost")
		return { status: "lost", text: `${text}\n${outcome.message} (${outcome.problems.join("; ")}). Backup: ${outcome.backupPath}`, plan, outcome };
	return { status: "written", text: `${text}\nWritten: ${counts}. Backup: ${outcome.backupPath}`, plan, outcome };
}
