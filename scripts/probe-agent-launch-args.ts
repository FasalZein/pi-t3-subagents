/**
 * Layer 2 probe (read-only): plan the launch arguments for every agent in the
 * agents folder and start `pi --mode rpc --no-session <args>` with fake T3
 * variables, as T3 does. Pass = Pi answers an RPC get_state without an error.
 * Never writes settings. Usage: bun scripts/probe-agent-launch-args.ts
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readCatalog } from "../src/catalog.ts";
import { planInstance, tokenizeArgs } from "../src/planner.ts";
import { EXTENSION_ENTRY } from "../src/sync-command.ts";
import { hostFacts, settingsPath } from "../src/sync.ts";

const PROBE_TIMEOUT_MS = 60_000;
const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
const host = hostFacts(process.env, settings, EXTENSION_ENTRY);
const { agents } = readCatalog(host.agentsDir);
let failures = 0;

function probe(binary: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
	return new Promise((done) => {
		const env: NodeJS.ProcessEnv = { ...process.env, T3_MCP_URL: "http://127.0.0.1:9/mcp", T3_MCP_BEARER_TOKEN: "fake-probe-token" };
		delete env.PI_DENY_TOOLS;
		const child = spawn(binary, ["--mode", "rpc", "--no-session", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			done({ ok: false, detail: `timeout; stderr: ${err.slice(-400)}` });
		}, PROBE_TIMEOUT_MS);
		child.stdout.on("data", (d) => {
			out += d;
			const line = out.split("\n").find((l) => l.includes('"id":"probe-1"'));
			if (line) {
				clearTimeout(timer);
				child.kill("SIGTERM");
				const res = JSON.parse(line);
				// Extension load failures are not fatal in Pi; count any error text as a failure.
				const errors = [...out.split("\n").filter((l) => /error/i.test(l) && !l.includes('"id":"probe-1"')), ...err.split("\n").filter((l) => /error/i.test(l))];
				const ok = res.success === true && errors.length === 0;
				done({ ok, detail: ok ? `model=${res.data?.model?.provider}/${res.data?.model?.id}` : `${line}\n  errors: ${errors.join(" | ").slice(0, 800)}` });
			}
		});
		child.stderr.on("data", (d) => (err += d));
		child.on("exit", (code) => {
			clearTimeout(timer);
			done({ ok: false, detail: `exit ${code}; stderr: ${err.slice(-600)}` });
		});
		child.stdin.write(`${JSON.stringify({ id: "probe-1", type: "get_state" })}\n`);
	});
}

for (const agent of agents.filter((a) => a.enabled)) {
	const plan = planInstance(agent, host);
	if (plan.kind === "skip") {
		failures++;
		console.log(`SKIP ${agent.name}: ${plan.reason}`);
		continue;
	}
	const launchArgs = String(plan.entry.config?.launchArgs);
	const result = await probe(String(plan.entry.config?.binaryPath), tokenizeArgs(launchArgs));
	if (!result.ok) failures++;
	console.log(`${result.ok ? "PASS" : "FAIL"} ${plan.id} ${result.detail}\n  launchArgs: ${launchArgs}`);
}
console.log(`${agents.length} agents, ${failures} failures`);
process.exit(failures ? 1 : 0);
