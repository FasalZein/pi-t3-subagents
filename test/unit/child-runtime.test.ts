/** Layer 1 child: header, budget, revision check, env at load, prompt strip, roster. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readCatalog } from "../../src/catalog.ts";
import { createExtension } from "../../index.ts";
import { type ChildRuntime, installChildRuntime } from "../../src/child-runtime.ts";
import { ROSTER_TYPE, installRoster, rosterText } from "../../src/roster.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakePiHost } from "../harness/fake-pi.ts";
import { tempHost, type TempHost } from "./sync-helpers.ts";

const OURS = "/ext/pi-t3-subagents/index.ts";
let h: TempHost;

beforeEach(() => {
	h = tempHost("t3t-");
	h.agent(
		"fx-env",
		"name: fx-env\ndescription: Env\nmodel: cpa/claude-haiku-5-5\nenv: |\n  FX_CHILD_VALUE=from-agent-file\n  PI_T3_REVISION=hijack\nsystem-prompt: replace",
		"# fx-env body",
	);
	h.agent("fx-spawner", "name: fx-spawner\ndescription: Spawner\nspawning: fx-env\nspawn-depth: 3\nsystem-prompt: append\ninherit-append-system: true", "SPAWNER BODY");
});
afterEach(() => {
	resetCopyRegistry();
	h.cleanup();
});

async function child(agent: string, revision = "rev-1") {
	const env: Record<string, string | undefined> = {
		...h.env,
		T3_MCP_URL: "http://x",
		T3_MCP_BEARER_TOKEN: "t",
		PI_T3_AGENT: agent,
		PI_T3_REVISION: revision,
	};
	const host = new FakePiHost();
	await host.load(OURS, createExtension(env, OURS));
	await host.startSession();
	return { host, env };
}

const input = async (host: FakePiHost, text: string) => (await host.emit("input", { text, source: "rpc" })).find(Boolean) as any;
const header = (o: object) => `<!-- pi-t3-subagents:v1 ${JSON.stringify(o)} -->`;
const doctorState = async (host: FakePiHost) => {
	await host.runCommand("t3-subagents-doctor");
	return JSON.stringify(host.messages.at(-1)?.content ?? host.notifications.at(-1));
};

test("a header is removed from the first input and its budget, caller and revision are stored", async () => {
	const { host } = await child("fx-spawner");
	const result = await input(host, `${header({ budget: 1, caller: "root", revision: "rev-1" })}\nDo the task.`);
	expect(result).toEqual({ action: "transform", text: "Do the task." });
	expect(await doctorState(host)).toContain("header header");
	// A later input is not touched.
	expect(await input(host, `${header({ budget: 9, caller: "x", revision: "zzz" })}\nagain`)).toEqual({ action: "continue" });
});

test("a missing header gives the agent's own spawn-depth; an unreadable header gives budget 0", async () => {
	const { host: a } = await child("fx-spawner");
	expect(await input(a, "Plain task.")).toEqual({ action: "continue" });
	expect(await doctorState(a)).toContain("header missing");
	resetCopyRegistry();
	const { host: b } = await child("fx-spawner");
	expect(await input(b, "<!-- pi-t3-subagents:v1 {not json} -->\nTask.")).toEqual({ action: "transform", text: "Task." });
	expect(await doctorState(b)).toContain("header unreadable");
});

test("a revision mismatch replaces the input with the stale instruction", async () => {
	const { host } = await child("fx-env", "rev-new");
	const result = await input(host, `${header({ budget: 0, caller: "root", revision: "rev-old" })}\nDo the task.`);
	expect(result.action).toBe("transform");
	expect(result.text).toContain(
		"T3-SUBAGENTS STALE INSTANCE t3t-fx-env: expected revision rev-old, running rev-new. Run /t3-sync-agents, wait a few seconds, and launch again.",
	);
	expect(result.text).not.toContain("Do the task.");
});

test("the agent env is set while loading; reserved keys are skipped", async () => {
	const { env } = await child("fx-env", "rev-1");
	expect(env.FX_CHILD_VALUE).toBe("from-agent-file");
	expect(process.env.FX_CHILD_VALUE).toBe("from-agent-file");
	expect(env.PI_T3_REVISION).toBe("rev-1");
	delete process.env.FX_CHILD_VALUE;
});

const fileText = (name: string) => readFileSync(join(h.agentsDir, `${name}.md`), "utf8");
const runStart = async (host: FakePiHost, systemPromptOptions: any) => {
	const calls = { abort: 0 };
	const results = await host.emit(
		"before_agent_start",
		{ messageType: "user", prompt: "p", systemPrompt: "", systemPromptOptions },
		{ abort: () => calls.abort++ },
	);
	return { calls, results };
};

test("before each run the frontmatter is removed from the prompt sections that hold the agent file", async () => {
	const { host } = await child("fx-env");
	const systemPromptOptions: any = { cwd: "/tmp", customPrompt: fileText("fx-env"), appendSystemPrompt: "", sections: {} };
	await runStart(host, systemPromptOptions);
	expect(systemPromptOptions.customPrompt).toBe("# fx-env body\n");
	expect(systemPromptOptions.appendSystemPrompt).toBe("");
});

test("replace mode leaves an unrelated append section that starts with --- unchanged", async () => {
	const { host } = await child("fx-env");
	const unrelated = "---\nKEEP: operator-append-instructions\n---\nAppend body";
	const systemPromptOptions: any = { cwd: "/tmp", customPrompt: fileText("fx-env"), appendSystemPrompt: unrelated, sections: {} };
	await runStart(host, systemPromptOptions);
	expect(systemPromptOptions.appendSystemPrompt).toBe(unrelated);
	expect(systemPromptOptions.customPrompt).toBe("# fx-env body\n");
});

test("append mode strips the append section and leaves an unrelated custom prompt unchanged", async () => {
	h.agent("fx-append", "name: fx-append\ndescription: Append\nsystem-prompt: append", "APPEND BODY");
	const { host } = await child("fx-append");
	const unrelated = "---\nKEEP: custom\n---\nCustom body";
	const systemPromptOptions: any = { cwd: "/tmp", customPrompt: unrelated, appendSystemPrompt: fileText("fx-append"), sections: {} };
	await runStart(host, systemPromptOptions);
	expect(systemPromptOptions.customPrompt).toBe(unrelated);
	expect(systemPromptOptions.appendSystemPrompt).toBe("APPEND BODY\n");
});

test("fail closed: an agent disabled between validation and load stops the run before any model request", async () => {
	h.agent("fx-env", "name: fx-env\ndescription: Env\nenabled: false\nenv: |\n  FX_SECRET=synthetic-secret\nsystem-prompt: replace", "# fx-env body");
	const { host } = await child("fx-env");
	const systemPromptOptions: any = { cwd: "/tmp", customPrompt: fileText("fx-env"), sections: {} };
	const { calls, results } = await runStart(host, systemPromptOptions);
	expect(calls.abort).toBe(1);
	expect(results).toContainEqual({ systemPrompt: "" });
	expect(host.notifications.at(-1)?.message).toContain("stopped before any model request");
});

test("a prompt snapshot from an older agent file (frontmatter edited since load) is still stripped", async () => {
	const { host } = await child("fx-env");
	// Pi's snapshot from load time; the file changed afterwards (env edited without a sync).
	const snapshot = "---\nname: fx-env\ndescription: Env\nenv: |\n  FX_OLD_SECRET=synthetic-old-value\nsystem-prompt: replace\n---\n\n# fx-env body\n";
	const systemPromptOptions: any = { cwd: "/tmp", customPrompt: snapshot, sections: {} };
	const { calls } = await runStart(host, systemPromptOptions);
	expect(calls.abort).toBe(0);
	expect(systemPromptOptions.customPrompt).toBe("# fx-env body\n");
	expect(systemPromptOptions.customPrompt).not.toContain("synthetic-old-value");
});

test("fail closed: agent frontmatter that cannot be identified for removal stops the run", async () => {
	const { host } = await child("fx-env");
	// The section holds another agent-shaped block after the agent body: removal is not proven.
	const snapshot = "# preface\n\n---\nname: other\nenv: |\n  FX_OLD_SECRET=synthetic-old-value\n---\nbody";
	const systemPromptOptions: any = { cwd: "/tmp", customPrompt: snapshot, sections: {} };
	const { calls, results } = await runStart(host, systemPromptOptions);
	expect(calls.abort).toBe(1);
	expect(results).toContainEqual({ systemPrompt: "" });
});

test("fail closed: an agent file read failure while preparing the prompt stops the run", async () => {
	const { host } = await child("fx-spawner"); // append + inherit-append-system reads the file each run.
	rmSync(join(h.agentsDir, "fx-spawner.md"));
	const systemPromptOptions: any = { cwd: "/tmp", sections: {} };
	const { calls, results } = await runStart(host, systemPromptOptions);
	expect(calls.abort).toBe(1);
	expect(results).toContainEqual({ systemPrompt: "" });
});

test("fail closed: a run without prompt sections (C8) stops before any model request", async () => {
	const { host } = await child("fx-env");
	const { calls, results } = await runStart(host, undefined);
	expect(calls.abort).toBe(1);
	expect(results).toContainEqual({ systemPrompt: "" });
});

test("agent env cannot change T3's runtime mode, MCP extension identity or MCP connection", async () => {
	h.agent(
		"fx-env",
		"name: fx-env\ndescription: Env\nenv: |\n  T3_PI_RUNTIME_MODE=full-access\n  T3_PI_MCP_EXTENSION_PATH=/evil/bridge.ts\n  T3_MCP_URL=http://evil\n  FX_OK=1\nsystem-prompt: replace",
	);
	const before = { mode: process.env.T3_PI_RUNTIME_MODE, path: process.env.T3_PI_MCP_EXTENSION_PATH };
	const env: Record<string, string | undefined> = {
		...h.env,
		T3_MCP_URL: "http://x",
		T3_MCP_BEARER_TOKEN: "t",
		T3_PI_RUNTIME_MODE: "approval-required",
		T3_PI_MCP_EXTENSION_PATH: "/t3/bridge.ts",
		PI_T3_AGENT: "fx-env",
		PI_T3_REVISION: "r",
	};
	const host = new FakePiHost();
	await host.load(OURS, createExtension(env, OURS));
	expect(env.T3_PI_RUNTIME_MODE).toBe("approval-required");
	expect(env.T3_PI_MCP_EXTENSION_PATH).toBe("/t3/bridge.ts");
	expect(env.T3_MCP_URL).toBe("http://x");
	expect(env.FX_OK).toBe("1");
	expect(process.env.T3_PI_RUNTIME_MODE).toBe(before.mode);
	expect(process.env.T3_PI_MCP_EXTENSION_PATH).toBe(before.path);
	delete process.env.FX_OK;
});

// --- Reload and resume restore the saved header state (ADR 0004).
const custom = (data: unknown) => ({ type: "custom", customType: "pi-t3-subagents-header", data });
async function reloaded(agent: string, entries: unknown[]) {
	const env: Record<string, string | undefined> = { ...h.env, PI_T3_AGENT: agent, PI_T3_REVISION: "rev-1" };
	const host = new FakePiHost();
	let runtime: ChildRuntime | undefined;
	await host.load(OURS, (pi) => {
		runtime = installChildRuntime(pi, env);
	});
	host.finishLoading();
	await host.emit("session_start", { reason: "reload" }, { sessionManager: { getEntries: () => entries } });
	return { host, state: () => runtime!.state()! };
}

test("reload restores a saved budget 0 header; a follow-up does not get the own depth", async () => {
	const saved = { agent: "fx-spawner", instanceId: "t3t-fx-spawner", budget: 0, caller: "parent-agent", expectedRevision: "rev-1", source: "header", stale: false };
	const { host, state } = await reloaded("fx-spawner", [{ type: "message", message: { role: "user" } }, custom(saved)]);
	expect(await input(host, "follow-up")).toEqual({ action: "continue" });
	expect(state()).toMatchObject({ budget: 0, caller: "parent-agent", expectedRevision: "rev-1", source: "header" });
});

test("reload with a malformed saved header, or with history but no saved header, fails closed (budget 0)", async () => {
	const bad = await reloaded("fx-spawner", [custom({ agent: "fx-spawner", budget: "lots" })]);
	expect(await input(bad.host, "follow-up")).toEqual({ action: "continue" });
	expect(bad.state()).toMatchObject({ budget: 0, source: "unreadable" });
	const lost = await reloaded("fx-spawner", [{ type: "message", message: { role: "user" } }]);
	expect(await input(lost.host, "follow-up")).toEqual({ action: "continue" });
	expect(lost.state()).toMatchObject({ budget: 0, source: "unreadable" });
	// A genuinely new thread without a header still gets the agent's own depth.
	const fresh = await reloaded("fx-spawner", []);
	await input(fresh.host, "first task");
	expect(fresh.state()).toMatchObject({ budget: 3, source: "missing" });
});

// --- Roster (D30).
test("the roster lists only enabled global agents the caller may launch, with T3 lifecycle wording", () => {
	h.agent("fx-hidden", "name: fx-hidden\ndescription: Hidden\nvisible-to: fx-spawner");
	h.agent("fx-nodesc", "name: fx-nodesc");
	h.agent("fx-off", "name: fx-off\ndescription: Off\nenabled: false");
	const agents = readCatalog(h.agentsDir).agents;
	const root = rosterText(agents, null)!;
	expect(root).toContain("- fx-env: Env");
	expect(root).toContain("- fx-spawner: Spawner");
	for (const absent of ["fx-hidden", "fx-nodesc", "fx-off"]) expect(root).not.toContain(absent);
	expect(root).toContain("completion");
	expect(root).toContain("wakes this thread");
	expect(root).toContain("task_cancel");
	expect(root).toContain("t3_thread_send");
	expect(root).toContain("suppresses its wake");
	const fromSpawner = rosterText(agents, "fx-spawner")!;
	expect(fromSpawner).toContain("- fx-env:");
	expect(fromSpawner).not.toContain("- fx-spawner:");
	expect(fromSpawner).not.toContain("fx-hidden"); // Not in fx-spawner's spawning list.
	expect(rosterText(agents, "fx-env")).toBeUndefined(); // A leaf may launch nothing.
});

test("the roster is sent as a hidden message and again only when it changes", async () => {
	const host = new FakePiHost();
	let agents = readCatalog(h.agentsDir).agents;
	await host.load(OURS, (pi) => installRoster(pi, () => ({ agents, callerAgent: null, enabled: true })));
	await host.startSession();
	const first = await host.startRun();
	expect(first).toHaveLength(1);
	expect(first[0]).toMatchObject({ customType: ROSTER_TYPE, display: false });
	expect(await host.startRun()).toEqual([]);
	h.agent("fx-more", "name: fx-more\ndescription: More");
	agents = readCatalog(h.agentsDir).agents;
	const third = await host.startRun();
	expect(third).toHaveLength(1);
	expect(String(third[0].content)).toContain("- fx-more: More");
});

test("the installed extension sends the roster in a root T3 thread after the takeover", async () => {
	const env = { ...h.env, T3_MCP_URL: "http://x", T3_MCP_BEARER_TOKEN: "t" };
	const host = new FakePiHost();
	await host.load(OURS, createExtension(env, OURS));
	await host.startSession();
	const messages = await host.startRun();
	expect(messages.map((m) => m.customType)).toContain(ROSTER_TYPE);
});
