/**
 * Layer 2, S5: child tool exposure in a real Pi after the bridge's reconciliation (U2 and
 * the budget-0 load-order check from the S3 final review).
 *
 * Each case starts `pi --mode rpc --no-session` with the launch arguments and environment
 * that the sync plans for a fixture agent (planInstance), plus a stand-in T3 bridge loaded
 * last (test/probe/s5-fake-bridge-extension.ts). One small model call per case
 * (PROBE_MODEL, default the fixture model cpa/claude-haiku-5-5). The model-facing loadout is
 * the tool list of the provider request.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCatalog } from "../../src/catalog.ts";
import { EXHAUSTED_TOOLS } from "../../src/child-tools.ts";
import { planInstance, tokenizeArgs } from "../../src/planner.ts";
import { hostFacts } from "../../src/sync.ts";
import { hostPath, hostPi } from "./host-pi.ts";

const ROOT = resolve(import.meta.dir, "../..");
const OURS = join(ROOT, "index.ts");
const BRIDGE = join(import.meta.dir, "s5-fake-bridge-extension.ts");
const MODEL = process.env.PROBE_MODEL ?? "cpa/claude-haiku-5-5";
const TIMEOUT_MS = 180_000;
const SPAWNER_BRIDGE = ["mcp__t3-code__delegate_task", "mcp__t3-code__task_status", "mcp__t3-code__task_cancel", "mcp__t3-code__t3_thread_send"];

async function runChild(agentName: string, budget: number, reactivate: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "t3-subagents-s5-probe-"));
	const agents = join(dir, "agents");
	mkdirSync(agents);
	writeFileSync(join(agents, "fx-probe-spawner.md"), `---\nname: fx-probe-spawner\ndescription: Probe spawner\nmodel: ${MODEL}\ntools: read,bash\nextensions: none\nspawning: fx-probe-leaf\nspawn-depth: 2\nsystem-prompt: replace\n---\n\nReply with exactly the word PROBE-OK. Do not call tools.\n`);
	writeFileSync(join(agents, "fx-probe-leaf.md"), `---\nname: fx-probe-leaf\ndescription: Probe leaf\nmodel: ${MODEL}\ntools: read,bash\nextensions: none\nsystem-prompt: replace\n---\n\nReply with exactly the word PROBE-OK. Do not call tools.\n`);
	const out = join(dir, "probe.jsonl");
	const base: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || k.startsWith("PI_SUBAGENT_") || k.startsWith("T3_") || k.startsWith("PI_T3_") || k === "PI_DENY_TOOLS") continue;
		base[k] = v;
	}
	const env: NodeJS.ProcessEnv = { ...base, PATH: hostPath(base.PATH), PI_T3_NAMESPACE: "t3t-", PI_T3_AGENTS_DIR: agents, PI_T3_SETTINGS_PATH: join(dir, "settings.json") };
	const agent = readCatalog(agents).agents.find((a) => a.name === agentName)!;
	const plan = planInstance(agent, await hostFacts(env, {}, OURS));
	if (plan.kind !== "entry") throw new Error(`probe: ${agentName} skipped: ${plan.reason}`);
	const launchArgs = tokenizeArgs(String(plan.entry.config!.launchArgs));
	const childEnv: Record<string, string> = { ...(env as Record<string, string>), T3_MCP_URL: "http://127.0.0.1:9/mcp", T3_MCP_BEARER_TOKEN: "probe-fake-token", PROBE_OUT: out, PROBE_REACTIVATE: reactivate ? "1" : "0" };
	for (const entry of plan.entry.environment ?? []) childEnv[entry.name] = entry.value;
	const revision = childEnv.PI_T3_REVISION;
	const args = ["--mode", "rpc", "--no-session", ...launchArgs, "--extension", BRIDGE];
	const proc = Bun.spawn([hostPi().path, ...args], { env: childEnv, cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const header = `<!-- pi-t3-subagents:v1 {"budget":${budget},"caller":"root","revision":"${revision}"} -->`;
	proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: `${header}\nSay the word.` })}\n`);
	proc.stdin.flush();
	let stdout = "";
	const decoder = new TextDecoder();
	for await (const chunk of proc.stdout) {
		stdout += decoder.decode(chunk);
		if (stdout.includes('"type":"agent_end"')) break;
	}
	proc.stdin.end();
	proc.kill();
	await proc.exited;
	const records = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const receipt = { pi: hostPi().version, agent: agentName, budget, reactivate, args, records, stderrTail: (await new Response(proc.stderr).text()).slice(-1500) };
	const keep = process.env.PROBE_ARTIFACT_DIR;
	if (keep) {
		mkdirSync(keep, { recursive: true });
		writeFileSync(join(keep, `probe-s5-${agentName}-b${budget}${reactivate ? "-reactivate" : ""}.json`), JSON.stringify(receipt, null, 2));
	}
	return { request: records.find((r) => r.kind === "request"), afterReconcile: records.find((r) => r.kind === "after_reconcile"), receipt };
}

describe("real Pi: child tool exposure after bridge reconciliation", () => {
	test(
		"U2: a spawner with a fixed tool list has subagent and the named bridge tools in its model request",
		async () => {
			const { request, receipt } = await runChild("fx-probe-spawner", 1, false);
			console.log(`U2 probe (Pi ${receipt.pi}): payload tools ${JSON.stringify(request?.payloadTools)}`);
			expect(request).toBeDefined();
			for (const tool of ["subagent", ...SPAWNER_BRIDGE]) expect(request.payloadTools).toContain(tool);
		},
		TIMEOUT_MS,
	);

	test(
		"budget 0: a spawner launched with budget 0 has no spawn tool in its model request, also when the bridge re-activates its catalog",
		async () => {
			const { request, afterReconcile, receipt } = await runChild("fx-probe-spawner", 0, true);
			console.log(`budget-0 probe (Pi ${receipt.pi}): after reconcile ${JSON.stringify(afterReconcile?.activeTools)}; payload ${JSON.stringify(request?.payloadTools)}`);
			expect(request).toBeDefined();
			expect(request.payloadTools.filter((t: string) => EXHAUSTED_TOOLS.includes(t))).toEqual([]);
			expect(request.payloadTools).toContain("read");
		},
		TIMEOUT_MS,
	);

	test(
		"a leaf with a fixed tool list has neither subagent nor a thread-starting bridge tool",
		async () => {
			const { request, receipt } = await runChild("fx-probe-leaf", 0, true);
			console.log(`leaf probe (Pi ${receipt.pi}): payload ${JSON.stringify(request?.payloadTools)}`);
			expect(request).toBeDefined();
			expect(request.payloadTools.filter((t: string) => EXHAUSTED_TOOLS.includes(t))).toEqual([]);
		},
		TIMEOUT_MS,
	);
});
