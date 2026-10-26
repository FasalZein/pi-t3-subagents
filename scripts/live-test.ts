/**
 * Live-test namespace setup and teardown (spec "Live e2e rules", D25).
 *
 *   bun scripts/live-test.ts setup <slice>     creates t3e2e-<slice>-main
 *   bun scripts/live-test.ts teardown <slice>  deletes every t3e2e-<slice>- instance
 *
 * Writes go through the settings writer only. Entries outside the namespace
 * are never changed. The test main instance loads this worktree's extension
 * and points PI_T3_AGENTS_DIR at the repository fixture agents.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mainInstanceId, quoteArg } from "../src/planner.ts";
import { MANAGED_BY, type ProviderInstanceEntry, type Settings, settingsShapeProblems } from "../src/settings-shape.ts";
import { writeSettings } from "../src/settings-writer.ts";
import { EXTENSION_ENTRY } from "../src/sync-command.ts";
import { settingsPath, stateDir } from "../src/sync.ts";

const FIXTURE_AGENTS = join(import.meta.dir, "..", "test", "fixtures", "agents");
const MAIN_MODEL = "cpa/claude-haiku-5-5";

const [command, slice] = process.argv.slice(2);
if (!["setup", "teardown"].includes(command ?? "") || !/^[a-z0-9]+$/.test(slice ?? "")) {
	console.error("usage: bun scripts/live-test.ts setup|teardown <slice>");
	process.exit(2);
}
const namespace = `t3e2e-${slice}-`;
const path = settingsPath();
const originalText = readFileSync(path, "utf8");
const settings: Settings = JSON.parse(originalText);
const shape = settingsShapeProblems(settings);
if (shape.length) throw new Error(`unexpected settings shape: ${shape.join("; ")}`);
const instances = { ...(settings.providerInstances ?? {}) };
const before = Object.keys(instances).filter((id) => id.startsWith(namespace));

if (command === "setup") {
	const binaryPath = instances.pi?.config?.binaryPath ?? "pi";
	const main: ProviderInstanceEntry = {
		driver: "pi",
		displayName: `Pi test main [${namespace}]`,
		enabled: true,
		environment: [
			{ name: "PI_T3_NAMESPACE", value: namespace, sensitive: false },
			{ name: "PI_T3_AGENTS_DIR", value: FIXTURE_AGENTS, sensitive: false },
		],
		config: {
			binaryPath,
			launchArgs: ["--extension", EXTENSION_ENTRY, "--model", MAIN_MODEL].map(quoteArg).join(" "),
			managedBy: MANAGED_BY,
			namespace,
			role: "test-main",
		},
	};
	instances[mainInstanceId(namespace)] = main;
} else {
	for (const id of before) delete instances[id];
}

const next = { ...settings, providerInstances: instances };
const outcome = await writeSettings({
	settingsPath: path,
	stateDir: stateDir(),
	originalText,
	nextText: `${JSON.stringify(next, null, 2)}\n`,
	verify: (reloaded) => {
		const ids = Object.keys((reloaded as Settings).providerInstances ?? {}).filter((id) => id.startsWith(namespace));
		if (command === "setup") return ids.includes(mainInstanceId(namespace)) ? [] : ["test main instance missing"];
		return ids.length ? [`namespace instances remain: ${ids.join(", ")}`] : [];
	},
});
const after = Object.keys(JSON.parse(readFileSync(path, "utf8")).providerInstances ?? {}).filter((id) => id.startsWith(namespace));
console.log(JSON.stringify({ command, namespace, extension: EXTENSION_ENTRY, before, after, outcome }, null, 2));
process.exit(outcome.status === "written" ? 0 : 1);
