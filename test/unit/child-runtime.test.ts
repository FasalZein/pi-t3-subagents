/** Layer 1 child: header, budget, revision check, env at load, prompt strip, roster. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readCatalog } from "../../src/catalog.ts";
import { createExtension } from "../../index.ts";
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

test("before each run the frontmatter is removed from the prompt sections that hold the agent file", async () => {
	const { host } = await child("fx-env");
	const systemPromptOptions: any = { cwd: "/tmp", customPrompt: "---\nname: fx-env\nmodel: x\n---\n\n# fx-env body\n", appendSystemPrompt: "", sections: {} };
	await host.emit("before_agent_start", { messageType: "user", prompt: "p", systemPrompt: "", systemPromptOptions });
	expect(systemPromptOptions.customPrompt).toBe("# fx-env body\n");
	expect(systemPromptOptions.appendSystemPrompt).toBe("");
});

test("append with inherit-append-system adds the body once per run", async () => {
	const { host } = await child("fx-spawner");
	const systemPromptOptions: any = { cwd: "/tmp", sections: {} };
	await host.emit("before_agent_start", { messageType: "user", prompt: "p", systemPrompt: "", systemPromptOptions });
	await host.emit("before_agent_start", { messageType: "user", prompt: "p", systemPrompt: "", systemPromptOptions });
	expect(systemPromptOptions.appendSystemPrompt).toBe("SPAWNER BODY");
});

test("outside a managed instance nothing is transformed", async () => {
	const env = { ...h.env, T3_MCP_URL: "http://x", T3_MCP_BEARER_TOKEN: "t" };
	const host = new FakePiHost();
	await host.load(OURS, createExtension(env, OURS));
	await host.startSession();
	expect(host.handlers.get("input") ?? []).toEqual([]);
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
