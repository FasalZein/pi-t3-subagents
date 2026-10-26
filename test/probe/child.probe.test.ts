/**
 * Layer 2: the child runtime bootstrap in a real Pi (U6, U7, U13; U5 partly).
 * Starts `pi --mode rpc --no-session` the way T3 starts a managed instance with an
 * extension list: --no-extensions, this extension first, Pi's built-in MCP and tool-search,
 * then the probe extension; --system-prompt <agent file>; PI_T3_AGENT and PI_T3_REVISION set.
 * One small model call (PROBE_MODEL, default cpa/claude-haiku-5-5).
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostPath, hostPi } from "./host-pi.ts";

const ROOT = resolve(import.meta.dir, "../..");
const OURS = join(ROOT, "index.ts");
const PROBE = join(ROOT, "test/fixtures/child-probe-extension.ts");
const MODEL = process.env.PROBE_MODEL ?? "cpa/claude-haiku-5-5";
const TIMEOUT_MS = 180_000;
const HEADER = '<!-- pi-t3-subagents:v1 {"budget":0,"caller":"root","revision":"rev-probe"} -->';

async function rpc(args: string[], env: Record<string, string>) {
	const proc = Bun.spawn([hostPi().path, "--mode", "rpc", "--no-session", ...args], { env, cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const records: any[] = [];
	const waiters: Array<{ match: (r: any) => boolean; resolve: (r: any) => void }> = [];
	void (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk);
			let i = buffer.indexOf("\n");
			while (i >= 0) {
				const line = buffer.slice(0, i).trim();
				buffer = buffer.slice(i + 1);
				i = buffer.indexOf("\n");
				try {
					const record = JSON.parse(line);
					records.push(record);
					for (const w of [...waiters]) if (w.match(record)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(record));
				} catch {}
			}
		}
	})();
	const waitFor = (match: (r: any) => boolean) => {
		const seen = records.find(match);
		return seen ? Promise.resolve(seen) : new Promise<any>((resolve) => waiters.push({ match, resolve }));
	};
	const send = (command: Record<string, unknown>) => {
		proc.stdin.write(`${JSON.stringify(command)}\n`);
		proc.stdin.flush();
		return waitFor((r) => r.type === "response" && r.id === command.id);
	};
	const close = async () => {
		proc.stdin.end();
		const exitCode = await proc.exited;
		return { exitCode, stderr: await new Response(proc.stderr).text() };
	};
	return { send, waitFor, close };
}

test(
	"child bootstrap: env reaches a later extension and bash, prompt has no frontmatter, header is not stored",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "t3-subagents-child-probe-"));
		const agents = join(dir, "agents");
		mkdirSync(agents);
		const agentFile = join(agents, "fx-probe.md");
		writeFileSync(
			agentFile,
			"---\nname: fx-probe\ndescription: Probe\nmodel: cpa/claude-haiku-5-5\nextensions: none\nenv: |\n  FX_PROBE_VALUE=probe-value-123\nsystem-prompt: replace\n---\n\n# fx-probe body\n\nReply with exactly the word PROBE-OK and nothing else.\n",
		);
		const out = join(dir, "probe.jsonl");
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v === undefined || k.startsWith("PI_SUBAGENT_") || k.startsWith("T3_") || k.startsWith("PI_T3_") || k === "PI_DENY_TOOLS" || k === "FX_PROBE_VALUE") continue;
			env[k] = v;
		}
		Object.assign(env, {
			PATH: hostPath(env.PATH),
			T3_MCP_URL: "http://127.0.0.1:9/mcp",
			T3_MCP_BEARER_TOKEN: "probe-fake-token",
			PI_T3_AGENT: "fx-probe",
			PI_T3_REVISION: "rev-probe",
			PI_T3_NAMESPACE: "t3t-",
			PI_T3_AGENTS_DIR: agents,
			PI_T3_SETTINGS_PATH: join(dir, "settings.json"),
			PROBE_OUT: out,
		});
		const args = [
			"--no-extensions",
			"--extension", OURS,
			"--extension", "builtin:mcp",
			"--extension", "builtin:tool-search",
			"--extension", PROBE,
			"--model", MODEL,
			"--system-prompt", agentFile,
			"--append-system-prompt", "",
		];
		const pi = await rpc(args, env);
		const bash = await pi.send({ id: "bash-1", type: "bash", command: 'printf "%s" "$FX_PROBE_VALUE"', excludeFromContext: true });
		const accepted = await pi.send({ id: "prompt-1", type: "prompt", message: `${HEADER}\nSay the word.` });
		expect(accepted.success).toBe(true);
		await pi.waitFor((r) => r.type === "agent_end");
		const messages = (await pi.send({ id: "m-1", type: "get_messages" })).data?.messages ?? [];
		const { exitCode, stderr } = await pi.close();
		const records = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
		const load = records.find((r) => r.kind === "load");
		const run = records.find((r) => r.kind === "run");
		const user = messages.find((m: any) => m.role === "user");
		const userText = JSON.stringify(user?.content ?? "");
		const receipt = { pi: hostPi(), args, exitCode, bash: bash.data, load, run, userText, stderrTail: stderr.slice(-2000) };
		const keep = process.env.PROBE_ARTIFACT_DIR;
		if (keep) {
			mkdirSync(keep, { recursive: true });
			writeFileSync(join(keep, "probe-child.json"), JSON.stringify(receipt, null, 2));
		}
		expect(exitCode).toBe(0);
		// U13: the agent env is visible to a later extension while it loads, and to bash.
		expect(load?.envAtLoad).toBe("probe-value-123");
		expect(String(bash.data?.output ?? "")).toBe("probe-value-123");
		// U6: the prompt starts with the agent body, without frontmatter.
		expect(run?.customPromptHead.startsWith("# fx-probe body")).toBe(true);
		expect(run?.systemPromptHead.startsWith("# fx-probe body")).toBe(true);
		expect(run?.systemPromptHead).not.toContain("name: fx-probe");
		// U7: the header is not in the stored user message; the rest is.
		expect(userText).not.toContain("pi-t3-subagents:v1");
		expect(userText).toContain("Say the word.");
		// U5 (partial, no real bridge here): no mcp__t3-code__ tool is active.
		expect((run?.activeTools ?? []).filter((t: string) => t.startsWith("mcp__t3-code__"))).toEqual([]);
	},
	TIMEOUT_MS,
);
