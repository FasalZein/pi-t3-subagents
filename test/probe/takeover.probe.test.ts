/**
 * Layer 2: real Pi probes (spec "Testing Decisions"). Each probe starts
 * `pi --mode rpc --no-session` with this extension first (as a T3 instance's --extension
 * argument) and the user's settings packages, which include the real pi-subagents.
 * PI_DENY_TOOLS and pi-subagents child variables are removed from the probe environment.
 *
 * Run: heavy -- bun test test/probe   (needs pi-subagents installed). The host Pi comes from
 * ./host-pi.ts (PATH outside node_modules, or PROBE_PI); each receipt records its path and version.
 * The negative probe makes one small model call (PROBE_MODEL, default cpa/claude-haiku-5-5).
 * Set PROBE_ARTIFACT_DIR to keep the probe logs.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostPath, hostPi } from "./host-pi.ts";

const ROOT = resolve(import.meta.dir, "../..");
const OURS = join(ROOT, "index.ts");
const PROBE = join(ROOT, "test/fixtures/probe-extension.ts");
const FOREIGN = join(ROOT, "test/fixtures/foreign-subagent.ts");
const MODEL = process.env.PROBE_MODEL ?? "cpa/claude-haiku-5-5";
const T3_ENV = { T3_MCP_URL: "http://127.0.0.1:9/mcp", T3_MCP_BEARER_TOKEN: "probe-fake-token" };
const NOTICE_TYPE = "pi-t3-subagents-notice";
const UNSET = "<unset>";
const TIMEOUT_MS = 180_000;

type ToolRow = { name: string; path: string; active: boolean };

function probeEnv(label: string, out: string, insideT3: boolean, denyTools?: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key === "PI_DENY_TOOLS" || key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SESSION_")) continue;
		if (key === "PI_MODEL" || key === "PI_PROVIDER" || key === "PI_REASONING_LEVEL" || key.startsWith("T3_")) continue;
		env[key] = value;
	}
	if (insideT3) Object.assign(env, T3_ENV);
	if (denyTools !== undefined) env.PI_DENY_TOOLS = denyTools;
	env.PATH = hostPath(env.PATH);
	env.PROBE_OUT = out;
	env.PROBE_LABEL = label;
	return env;
}

class RpcPi {
	private buffer = "";
	private readonly records: any[] = [];
	private readonly waiters: Array<{ match: (record: any) => boolean; resolve: (record: any) => void }> = [];
	readonly stdout: string[] = [];
	readonly proc;

	constructor(args: string[], env: Record<string, string>) {
		this.proc = Bun.spawn([hostPi().path, "--mode", "rpc", "--no-session", ...args], { env, cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		void this.read();
	}

	private async read() {
		const decoder = new TextDecoder();
		for await (const chunk of this.proc.stdout) {
			this.buffer += decoder.decode(chunk);
			let index = this.buffer.indexOf("\n");
			while (index >= 0) {
				const line = this.buffer.slice(0, index).trim();
				this.buffer = this.buffer.slice(index + 1);
				index = this.buffer.indexOf("\n");
				if (!line) continue;
				this.stdout.push(line);
				let record: any;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				this.records.push(record);
				for (const waiter of [...this.waiters]) {
					if (waiter.match(record)) {
						this.waiters.splice(this.waiters.indexOf(waiter), 1);
						waiter.resolve(record);
					}
				}
			}
		}
	}

	waitFor(match: (record: any) => boolean): Promise<any> {
		const seen = this.records.find(match);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve) => this.waiters.push({ match, resolve }));
	}

	async send(command: Record<string, unknown>): Promise<any> {
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
		this.proc.stdin.flush();
		return this.waitFor((record) => record.type === "response" && record.id === command.id);
	}

	async close(): Promise<{ exitCode: number; stderr: string }> {
		this.proc.stdin.end();
		const exitCode = await this.proc.exited;
		const stderr = await new Response(this.proc.stderr).text();
		return { exitCode, stderr };
	}
}

interface ProbeRun {
	exitCode: number;
	stderr: string;
	tools: ToolRow[];
	denyToolsInBash: string;
	messages?: any[];
	reply?: string;
	doctor?: string;
}

async function runProbe(
	label: string,
	options: { insideT3: boolean; foreign?: boolean; prompt?: boolean; denyTools?: string; doctor?: boolean },
): Promise<ProbeRun> {
	const dir = mkdtempSync(join(tmpdir(), "t3-subagents-probe-"));
	const out = join(dir, "probe.jsonl");
	const args = ["-e", OURS, ...(options.foreign ? ["-e", FOREIGN] : []), "-e", PROBE];
	if (options.prompt) args.push("--model", MODEL);
	const pi = new RpcPi(args, probeEnv(label, out, options.insideT3, options.denyTools));
	const bash = await pi.send({ id: "bash-1", type: "bash", command: `printf '%s' "\${PI_DENY_TOOLS-${UNSET}}"`, excludeFromContext: true });
	let messages: any[] | undefined;
	let reply: string | undefined;
	let doctor: string | undefined;
	if (options.doctor) {
		const handled = await pi.send({ id: "doctor-1", type: "prompt", message: "/t3-subagents-doctor" });
		expect(handled.data?.disposition).toBe("handled");
		const all = (await pi.send({ id: "doctor-messages", type: "get_messages" })).data?.messages ?? [];
		doctor = all.filter((message: any) => message.customType === "pi-t3-subagents-doctor").map((message: any) => String(message.content)).join("\n");
	}
	if (options.prompt) {
		const accepted = await pi.send({ id: "prompt-1", type: "prompt", message: "Reply with exactly the word PROBE-OK and nothing else." });
		expect(accepted.success).toBe(true);
		await pi.waitFor((record) => record.type === "agent_end");
		messages = (await pi.send({ id: "messages-1", type: "get_messages" })).data?.messages;
		reply = (await pi.send({ id: "last-1", type: "get_last_assistant_text" })).data?.text;
	}
	const { exitCode, stderr } = await pi.close();
	const lines = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean) : [];
	const tools: ToolRow[] = lines.length > 0 ? JSON.parse(lines[lines.length - 1] ?? "{}").tools : [];
	const run: ProbeRun = { exitCode, stderr, tools, denyToolsInBash: String(bash.data?.output ?? ""), messages, reply, doctor };
	const keep = process.env.PROBE_ARTIFACT_DIR;
	if (keep) {
		mkdirSync(keep, { recursive: true });
		writeFileSync(join(keep, `probe-${label}.json`), JSON.stringify({ label, pi: hostPi(), args, ...run, stdout: pi.stdout.length }, null, 2));
		writeFileSync(join(keep, `probe-${label}.stderr.log`), stderr);
	}
	return run;
}

function tool(run: ProbeRun, name: string): ToolRow | undefined {
	return run.tools.find((row) => row.name === name);
}

describe("real Pi probes", () => {
	test("the host Pi is the installed one, not the type-only dev dependency", () => {
		const pi = hostPi();
		expect(pi.realPath).not.toContain(ROOT);
		console.log(`probe host Pi: ${pi.path} -> ${pi.realPath} (version ${pi.version})`);
	});

	test(
		"outside T3: pi-subagents' three tools are unchanged",
		async () => {
			const run = await runProbe("outside", { insideT3: false, doctor: true });
			expect(run.exitCode).toBe(0);
			for (const name of ["subagent", "subagent_resume", "subagent_kill"]) {
				expect(tool(run, name)?.path).toContain("pi-subagents");
				expect(tool(run, name)?.active).toBe(true);
			}
			expect(run.denyToolsInBash).toBe(UNSET);
			expect(run.doctor).toContain("not inside T3");
		},
		TIMEOUT_MS,
	);

	test(
		"positive: subagent from this extension, resume absent, kill inactive, bash sees the original PI_DENY_TOOLS",
		async () => {
			const run = await runProbe("positive", { insideT3: true, doctor: true });
			expect(run.exitCode).toBe(0);
			expect(tool(run, "subagent")?.path).toBe(OURS);
			expect(tool(run, "subagent")?.active).toBe(true);
			expect(tool(run, "subagent_resume")).toBeUndefined();
			expect(tool(run, "subagent_kill")?.path).toContain("pi-subagents");
			expect(tool(run, "subagent_kill")?.active).toBe(false);
			expect(run.denyToolsInBash).toBe(UNSET);
			expect(run.stderr).not.toContain("conflicts with");
			// The probe has no T3 bridge, so C3 fails and names the missing tools.
			expect(run.doctor).toContain("C1 PASS");
			expect(run.doctor).toContain("C2 PASS");
			expect(run.doctor).toContain("C3 FAIL");
			expect(run.doctor).toContain("mcp__t3-code__delegate_task is not registered");
		},
		TIMEOUT_MS,
	);

	test(
		"positive with an original PI_DENY_TOOLS value: bash sees that value",
		async () => {
			const run = await runProbe("positive-original-value", { insideT3: true, denyTools: "probe_dummy_tool" });
			expect(run.exitCode).toBe(0);
			expect(tool(run, "subagent")?.path).toBe(OURS);
			expect(tool(run, "subagent_resume")).toBeUndefined();
			expect(run.denyToolsInBash).toBe("probe_dummy_tool");
		},
		TIMEOUT_MS,
	);

	test(
		"negative (U12): failed suppression does not stop Pi; no duplicate, the session works, the notice is present",
		async () => {
			const run = await runProbe("negative", { insideT3: true, foreign: true, prompt: true });
			expect(run.exitCode).toBe(0);
			expect(run.stderr).not.toContain("conflicts with");
			expect(tool(run, "subagent")?.path).toBe(FOREIGN);
			expect(tool(run, "subagent")?.active).toBe(false);
			expect(run.tools.filter((row) => row.name === "subagent")).toHaveLength(1);
			expect(tool(run, "subagent_kill")?.active).toBe(false);
			expect(run.denyToolsInBash).toBe(UNSET);
			expect(run.reply ?? "").toContain("PROBE-OK");
			const notices = (run.messages ?? []).filter((message) => message.customType === NOTICE_TYPE);
			expect(notices).toHaveLength(1);
			expect(JSON.stringify(notices[0])).toContain("delegation is off");
		},
		TIMEOUT_MS,
	);
});
