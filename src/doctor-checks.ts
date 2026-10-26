/**
 * Compatibility checks of the sync side: C6 (T3 settings shape), C7 (launch
 * arguments tokenizer and reserved flags), C9 (pi-subagents frontmatter fields)
 * and C10 (instance revisions; T3 reloads changed instances asynchronously). They use S1's doctor seam:
 * `CompatibilityCheck { id, contract, run() }` returning `pass` or `fail`.
 * The environment (settings path, namespace) is bound when the checks are built.
 */
import { readFileSync } from "node:fs";
import { agentsDir, readCatalog } from "./catalog.ts";
import type { ChildRuntime } from "./child-runtime.ts";
import { GAP_FIELDS, mainInstanceId, t3LaunchArgProblems, tokenizeArgs } from "./planner.ts";
import { isOwnedBy, type Settings, settingsShapeProblems } from "./settings-shape.ts";
import type { CheckResult, CompatibilityCheck } from "./doctor.ts";
import { hostFacts, namespaceOf, planSync, settingsPath } from "./sync.ts";
import { EXTENSION_ENTRY } from "./sync-command.ts";

type Env = NodeJS.ProcessEnv;
const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string): CheckResult => ({ status: "fail", detail });

function readSettings(env: Env): Settings {
	return JSON.parse(readFileSync(settingsPath(env), "utf8"));
}

export const c6SettingsShape = (env: Env): CompatibilityCheck => ({
	id: "C6",
	contract: "T3 settings shape (providerInstances, config, environment)",
	run() {
		let settings: Settings;
		try {
			settings = readSettings(env);
		} catch (error) {
			return fail(`cannot read ${settingsPath(env)}: ${(error as Error).message}`);
		}
		const problems = settingsShapeProblems(settings);
		return problems.length ? fail(problems.join("; ")) : pass(`${settingsPath(env)} has the expected shape`);
	},
});

export const c7LaunchArgs = (env: Env): CompatibilityCheck => ({
	id: "C7",
	contract: "Managed instance launch arguments pass T3's launch argument rules",
	run() {
		let settings: Settings;
		try {
			settings = readSettings(env);
		} catch (error) {
			return fail(`cannot read settings: ${(error as Error).message}`);
		}
		const ns = namespaceOf(env);
		const problems: string[] = [];
		const lines: string[] = [];
		for (const [id, entry] of Object.entries(settings.providerInstances ?? {})) {
			if (!isOwnedBy(entry, ns) || id === mainInstanceId(ns)) continue;
			const launchArgs = entry.config?.launchArgs;
			if (typeof launchArgs !== "string") {
				problems.push(`${id}: config.launchArgs is missing or not a string`);
				continue;
			}
			let tokens: string[];
			try {
				tokens = tokenizeArgs(launchArgs);
			} catch (error) {
				problems.push(`${id}: launchArgs do not tokenize (${(error as Error).message})`);
				continue;
			}
			for (const problem of t3LaunchArgProblems(tokens)) problems.push(`${id}: ${problem}`);
			lines.push(`${id}: stored ${entry.enabled === false ? "disabled" : "enabled"}`);
		}
		return problems.length
			? fail(`${problems.join("; ")}. T3 marks such an instance unavailable.`)
			: pass(lines.length ? `${lines.join(", ")}. Runtime availability in T3 is not checked here.` : `no managed instances in namespace ${ns}`);
	},
});

/**
 * Frontmatter fields that the wrapper maps (spec "Field mapping"). Together with the gap
 * fields they are every field pi-subagents parses at cf6dbf4 (src/agents/definitions.ts).
 */
export const MAPPED_FIELDS = [
	"name", "description", "model", "thinking", "allow-model-override", "allowed-models", "tools", "deny-tools",
	"extensions", "skills", "inject-skills", "system-prompt", "inherit-append-system", "env", "mode", "async",
	"auto-exit", "timeout", "timeout-warn-threshold", "context-warn-threshold", "context-warn-step", "spawning",
	"spawn-depth", "spawn-width", "session-mode", "trust-project", "no-context-files", "task-expansion", "visible-to",
	"enabled", "flags",
] as const;
const KNOWN_FIELDS = new Set<string>([...MAPPED_FIELDS, ...Object.keys(GAP_FIELDS)]);

/**
 * C9: the catalog copies pi-subagents' frontmatter rules, so nothing detects a rule change
 * directly. The doctor reports what an update most likely shows first: an agent file that
 * uses a field the wrapper neither maps nor lists as a gap, or a file it cannot read.
 */
export const c9AgentFields = (env: Env): CompatibilityCheck => ({
	id: "C9",
	contract: "pi-subagents frontmatter rules (copied from pi-subagents cf6dbf4)",
	run() {
		const dir = agentsDir(env);
		const catalog = readCatalog(dir);
		const problems: string[] = catalog.unreadable.map((u) => `${u.path}: ${u.reason}`);
		for (const agent of catalog.agents) {
			const unknown = Object.keys(agent.fields).filter((key) => !KNOWN_FIELDS.has(key));
			if (unknown.length) problems.push(`${agent.name} (${agent.path}) uses unknown field(s) ${unknown.join(", ")}`);
		}
		return problems.length
			? fail(`${problems.join("; ")}. The wrapper ignores unknown fields; pi-subagents may have changed its agent format. Re-check the field mapping (README) against the installed pi-subagents.`)
			: pass(`${catalog.agents.length} enabled agent(s) in ${dir}; every field is mapped or a documented gap. The parser rules themselves are not checked automatically; re-check them after a pi-subagents update.`);
	},
});

/**
 * C10: T3 reloads changed instances asynchronously. Launches refuse an instance that differs
 * from its agent file (D13), and a child started on an older revision replies stale (D28).
 * The doctor shows both: in a child, the header revision against this instance's revision;
 * everywhere, the managed instances that a sync would still change.
 */
export const c10Revisions = (env: Env, child?: ChildRuntime): CompatibilityCheck => ({
	id: "C10",
	contract: "T3 reloads changed instances asynchronously (revision check)",
	async run() {
		const state = child?.state();
		if (state?.stale)
			return fail(`this child runs instance ${state.instanceId} at revision ${env.PI_T3_REVISION}, but its launch expected ${state.expectedRevision}. Run /t3-sync-agents, wait a few seconds, and launch again.`);
		let settings: Settings;
		try {
			settings = readSettings(env);
		} catch (error) {
			return fail(`cannot read ${settingsPath(env)}: ${(error as Error).message}`);
		}
		const plan = planSync({
			agents: readCatalog(agentsDir(env)).agents,
			settings,
			host: await hostFacts(env, settings, EXTENSION_ENTRY),
			prune: false,
		});
		const pending = plan.actions.filter((a) => a.kind === "add" || a.kind === "update" || a.kind === "disable");
		const childNote = state?.expectedRevision ? ` This child's revision ${state.expectedRevision} matches its launch.` : "";
		if (pending.length)
			return fail(`managed instances differ from the agent files: ${pending.map((a) => `${a.kind} ${a.id}`).join(", ")}. Launches of these agents are refused until you run /t3-sync-agents (D13).${childNote}`);
		const synced = plan.actions.filter((a) => a.kind === "unchanged").length;
		return pass(`${synced} managed instance(s) in namespace ${plan.namespace} match the agent files.${childNote}`);
	},
});

export const syncDoctorChecks = (env: Env, child?: ChildRuntime): CompatibilityCheck[] => [
	c6SettingsShape(env),
	c7LaunchArgs(env),
	c9AgentFields(env),
	c10Revisions(env, child),
];
