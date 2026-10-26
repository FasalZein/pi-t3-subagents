import { afterEach, describe, expect, test } from "bun:test";
import { createExtension } from "../../index.ts";
import { resetCopyRegistry } from "../../src/takeover.ts";
import { FakePiHost, fakeForeignSubagent, fakePiSubagents } from "../harness/fake-pi.ts";

const EXPOSURES = ["direct", "codemode", "deferred"] as const;

const OURS = "/ext/pi-t3-subagents/index.ts";
const PI_SUBAGENTS = "/pkg/pi-subagents/src/index.ts";
const FOREIGN = "/pkg/foreign-subagent/index.ts";
// Hermetic: an empty agents folder (no roster message) and no T3 settings file.
const T3_ENV = {
	T3_MCP_URL: "http://127.0.0.1:1/mcp",
	T3_MCP_BEARER_TOKEN: "fake-token",
	PI_T3_AGENTS_DIR: "/nonexistent/pi-t3-subagents-test/agents",
	PI_T3_SETTINGS_PATH: "/nonexistent/pi-t3-subagents-test/settings.json",
};
const NOTICE_TYPE = "pi-t3-subagents-notice";

type Env = Record<string, string | undefined>;

/** Load order of a T3 main instance: the --extension copy first, then settings packages. */
async function boot(env: Env, extra: Array<[string, (pi: any) => void]> = []) {
	const host = new FakePiHost();
	await host.load(OURS, createExtension(env, OURS));
	for (const [path, factory] of extra) await host.load(path, factory);
	await host.load(PI_SUBAGENTS, fakePiSubagents(env));
	host.finishLoading();
	return host;
}

function ownTools(host: FakePiHost) {
	return [...host.tools.values()].filter((tool) => tool.sourceInfo.path === OURS).map((tool) => tool.name);
}

afterEach(() => resetCopyRegistry());

describe("outside T3", () => {
	for (const [label, env] of [
		["no T3 variables", { PI_DENY_TOOLS: "write" }],
		["URL without token", { T3_MCP_URL: "http://x", PI_DENY_TOOLS: "write" }],
		["token without URL", { T3_MCP_BEARER_TOKEN: "t" }],
	] as Array<[string, Env]>) {
		test(`${label}: registers no tool, changes no environment, pi-subagents unchanged`, async () => {
			const before = { ...env };
			const processBefore = { ...process.env };
			const host = await boot(env);
			await host.startSession();
			const added = await host.startRun();

			expect(ownTools(host)).toEqual([]);
			expect(env).toEqual(before);
			expect({ ...process.env }).toEqual(processBefore);
			expect(added).toEqual([]);
			for (const name of ["subagent", "subagent_resume", "subagent_kill"]) {
				expect(host.toolSource(name)).toBe(PI_SUBAGENTS);
				expect(host.active.has(name)).toBe(true);
			}
		});
	}

	test("the doctor reports not inside T3", async () => {
		const host = await boot({});
		await host.startSession();
		await host.runCommand("t3-subagents-doctor", "", { hasUI: true });
		expect(host.messages).toHaveLength(1);
		expect(String(host.messages[0]?.content)).toContain("not inside T3");
		expect(host.notifications[0]?.message).toContain("not inside T3");
	});
});

describe("inside T3 without a foreign subagent", () => {
	for (const original of [undefined, "write,edit"]) {
		test(`PI_DENY_TOOLS ${original ?? "unset"}: T3 subagent after session start, variable restored, kill inactive`, async () => {
			const env: Env = { ...T3_ENV, PI_DENY_TOOLS: original };
			if (original === undefined) delete env.PI_DENY_TOOLS;
			const host = new FakePiHost();
			await host.load(OURS, createExtension(env, OURS));
			// While loading, pi-subagents must see both launch tools denied.
			const duringLoad = new Set((env.PI_DENY_TOOLS ?? "").split(","));
			expect(duringLoad.has("subagent")).toBe(true);
			expect(duringLoad.has("subagent_resume")).toBe(true);
			await host.load(PI_SUBAGENTS, fakePiSubagents(env));
			host.finishLoading();
			expect(host.tools.has("subagent")).toBe(false);

			await host.startSession();

			expect(host.toolSource("subagent")).toBe(OURS);
			expect(host.active.has("subagent")).toBe(true);
			expect(host.tools.has("subagent_resume")).toBe(false);
			expect(host.toolSource("subagent_kill")).toBe(PI_SUBAGENTS);
			expect(host.active.has("subagent_kill")).toBe(false);
			expect(env.PI_DENY_TOOLS).toBe(original);
			expect("PI_DENY_TOOLS" in env).toBe(original !== undefined);
			expect(await host.startRun()).toEqual([]);
		});
	}

	test("a second session start keeps the own tool and adds no notice", async () => {
		const host = await boot({ ...T3_ENV });
		await host.startSession();
		await host.startSession();
		expect(host.toolSource("subagent")).toBe(OURS);
		expect(await host.startRun()).toEqual([]);
	});

	test("a run deactivates subagent_kill again when something activated it", async () => {
		const host = await boot({ ...T3_ENV });
		await host.startSession();
		host.active.add("subagent_kill");
		await host.startRun();
		expect(host.active.has("subagent_kill")).toBe(false);
		expect(host.active.has("subagent")).toBe(true);
	});

	test("an original PI_DENY_TOOLS that denies subagent is honored", async () => {
		const env: Env = { ...T3_ENV, PI_DENY_TOOLS: "subagent" };
		const host = await boot(env);
		await host.startSession();
		expect(host.tools.has("subagent")).toBe(false);
		expect(env.PI_DENY_TOOLS).toBe("subagent");
		expect(await host.startRun()).toEqual([]);
	});
});

describe("inside T3 with a foreign subagent (suppression failed)", () => {
	test("registers nothing, deactivates the launch tools, notice in the first run only", async () => {
		const env: Env = { ...T3_ENV };
		const host = await boot(env, [[FOREIGN, fakeForeignSubagent()]]);
		await host.startSession();

		expect(ownTools(host)).toEqual([]);
		expect(host.toolSource("subagent")).toBe(FOREIGN);
		expect(host.active.has("subagent")).toBe(false);
		expect(host.active.has("subagent_kill")).toBe(false);
		expect("PI_DENY_TOOLS" in env).toBe(false);

		const first = await host.startRun();
		expect(first).toHaveLength(1);
		expect(first[0]?.customType).toBe(NOTICE_TYPE);
		expect(first[0]?.display).toBe(true);
		expect(String(first[0]?.content)).toContain("delegation is off");
		expect(String(first[0]?.content)).toContain(FOREIGN);
		expect(await host.startRun()).toEqual([]);
	});

	test("a pi-subagents that ignores PI_DENY_TOOLS keeps all three tools inactive", async () => {
		const env: Env = { ...T3_ENV };
		const host = new FakePiHost();
		await host.load(OURS, createExtension(env, OURS));
		await host.load(PI_SUBAGENTS, fakePiSubagents({}));
		await host.startSession();
		expect(ownTools(host)).toEqual([]);
		for (const name of ["subagent", "subagent_resume", "subagent_kill"]) {
			expect(host.toolSource(name)).toBe(PI_SUBAGENTS);
			expect(host.active.has(name)).toBe(false);
		}
		expect((await host.startRun()).map((message) => message.customType)).toEqual([NOTICE_TYPE]);
	});
});

describe("two copies of this extension", () => {
	test("load without a conflict; only the first copy installs subagent", async () => {
		const env: Env = { ...T3_ENV };
		const host = new FakePiHost();
		await host.load(OURS, createExtension(env, OURS));
		await host.load("/other/copy/index.ts", createExtension(env, "/other/copy/index.ts"));
		await host.load(PI_SUBAGENTS, fakePiSubagents(env));
		await host.startSession();
		expect(host.toolSource("subagent")).toBe(OURS);
		expect("PI_DENY_TOOLS" in env).toBe(false);
		expect(await host.startRun()).toEqual([]);
	});
});

describe("disabled native tools cannot run on any call path", () => {
	for (const exposure of EXPOSURES) {
		test(`foreign subagent with exposure ${exposure}: nested and model calls are blocked`, async () => {
			const host = await boot({ ...T3_ENV }, [[FOREIGN, fakeForeignSubagent(exposure)]]);
			await host.startSession();
			if (exposure !== "direct") {
				const nested = await host.callTool("subagent", {}, { parentToolCallId: "codemode-1" });
				expect(nested.result).toBeUndefined();
				expect(nested.blocked).toContain("delegation is off");
			}
			// Another extension (or tool_search) activates it again: a model call is blocked too.
			host.active.add("subagent");
			const model = await host.callTool("subagent", {});
			expect(model.result).toBeUndefined();
			expect(model.blocked).toContain("delegation is off");
		});

		test(`pi-subagents kill and resume with exposure ${exposure} are blocked in T3`, async () => {
			const host = new FakePiHost();
			await host.load(OURS, createExtension({ ...T3_ENV }, OURS));
			// A pi-subagents version that ignores PI_DENY_TOOLS registers all three.
			await host.load(PI_SUBAGENTS, fakePiSubagents({}, exposure));
			await host.startSession();
			for (const name of ["subagent", "subagent_resume", "subagent_kill"]) {
				host.active.add(name);
				const call = await host.callTool(name, {}, { parentToolCallId: "codemode-1" });
				expect(call.result).toBeUndefined();
				expect(call.blocked).toContain(`${name} is disabled inside T3 Code`);
			}
		});
	}

	test("a blocked pi-subagents lifecycle tool names the T3 tools in their public and codemode spellings", async () => {
		const env = { ...T3_ENV };
		const host = new FakePiHost();
		await host.load(OURS, createExtension(env, OURS));
		await host.load(PI_SUBAGENTS, fakePiSubagents(env));
		await host.startSession();
		host.active.add("subagent_kill");
		const call = await host.callTool("subagent_kill", {});
		for (const tool of ["task_cancel", "t3_thread_send", "task_status"]) {
			expect(call.blocked).toContain(`mcp__t3-code__${tool}`);
			expect(call.blocked).toContain(`tools.mcp__t3_code__${tool}`);
		}
		expect(call.blocked).toContain("The user answers in the child thread. Do not ask the question again and do not relay it; end your turn.");
	});

	test("the T3 subagent itself is not blocked when nested", async () => {
		const host = await boot({ ...T3_ENV });
		await host.startSession();
		// Not blocked: the T3 tool runs and refuses the launch itself (no T3 settings here).
		// Pi turns the thrown refusal into an error result; a nested call never rejects.
		const nested = await host.callTool("subagent", {}, { parentToolCallId: "codemode-1" });
		expect(nested.blocked).toBeUndefined();
		expect(nested.isError).toBe(true);
		expect(nested.result.content[0].text).toContain("subagent launch refused");
	});

	test("outside T3 nothing is blocked", async () => {
		const host = await boot({});
		await host.startSession();
		for (const name of ["subagent", "subagent_resume", "subagent_kill"]) {
			expect((await host.callTool(name, {})).result?.content[0].text).toBe(`${name} EXECUTED`);
		}
	});
});

describe("copies across runtime replacement (/reload, new session)", () => {
	async function generation(copies: string[]) {
		const env: Env = { ...T3_ENV };
		const host = new FakePiHost();
		for (const copy of copies) await host.load(copy, createExtension(env, copy));
		await host.load(PI_SUBAGENTS, fakePiSubagents(env));
		await host.startSession();
		host.messages.length = 0;
		await host.runCommand("t3-subagents-doctor");
		const c2 = String(host.messages[0]?.content).split("\n").find((line) => line.startsWith("C2 ")) ?? "";
		return { host, env, c2 };
	}

	test("a reload with one copy left counts one copy; a copy that was second becomes the owner", async () => {
		const first = await generation(["/first/index.ts", "/extra/index.ts"]);
		expect(first.c2).toContain("C2 FAIL");
		await first.host.shutdown("reload");

		const second = await generation(["/first/index.ts"]);
		expect(second.c2).toContain("C2 PASS");
		expect(second.host.toolSource("subagent")).toBe("/first/index.ts");
		await second.host.shutdown("new");

		const third = await generation(["/extra/index.ts"]);
		expect(third.c2).toContain("C2 PASS");
		expect(third.host.toolSource("subagent")).toBe("/extra/index.ts");
		expect(third.host.tools.has("subagent_resume")).toBe(false);
		expect(third.host.active.has("subagent_kill")).toBe(false);
		expect("PI_DENY_TOOLS" in third.env).toBe(false);
	});

	test("a second session start in one runtime keeps the owner", async () => {
		const run = await generation([OURS]);
		await run.host.startSession();
		run.host.messages.length = 0;
		await run.host.runCommand("t3-subagents-doctor");
		expect(String(run.host.messages[0]?.content)).toContain("C1 PASS");
		expect(String(run.host.messages[0]?.content)).toContain("C2 PASS");
	});
});
