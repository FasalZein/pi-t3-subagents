/**
 * Compatibility checks owned by the sync slice: C6 (T3 settings shape) and C7
 * (launch arguments tokenizer and reserved flags). They use S1's doctor seam:
 * `CompatibilityCheck { id, contract, run() }` returning `pass` or `fail`.
 * The environment (settings path, namespace) is bound when the checks are built.
 */
import { readFileSync } from "node:fs";
import { mainInstanceId, RESERVED_FLAGS, tokenizeArgs } from "./planner.ts";
import { isOwnedBy, type Settings, settingsShapeProblems } from "./settings-shape.ts";
import type { CheckResult, CompatibilityCheck } from "./doctor.ts";
import { namespaceOf, settingsPath } from "./sync.ts";

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
	contract: "Managed instance launch arguments (tokenizer, reserved flags, enabled state)",
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
			let tokens: string[] = [];
			try {
				tokens = typeof launchArgs === "string" ? tokenizeArgs(launchArgs) : [];
			} catch (error) {
				problems.push(`${id}: launchArgs do not tokenize (${(error as Error).message})`);
			}
			for (const t of tokens) {
				if (RESERVED_FLAGS.has(t.split("=")[0])) problems.push(`${id}: reserved flag ${t}`);
				if (/^-[^-]/.test(t)) problems.push(`${id}: short flag ${t}`);
			}
			lines.push(`${id}: ${entry.enabled === false ? "disabled" : "enabled"}`);
		}
		return problems.length ? fail(problems.join("; ")) : pass(lines.length ? lines.join(", ") : `no managed instances in namespace ${ns}`);
	},
});

export const syncDoctorChecks = (env: Env): CompatibilityCheck[] => [c6SettingsShape(env), c7LaunchArgs(env)];
