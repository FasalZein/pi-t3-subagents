/** Layer 1: doctor checks C4 (last launch outcome) and C8 (Pi extension API). */
import { expect, test } from "bun:test";
import { extensionApiCheck, launchContractCheck } from "../../src/launch-checks.ts";
import type { LaunchOutcome } from "../../src/subagent-tool.ts";

const at = "2026-10-26T00:00:00Z";

test("C4 passes before any launch and after a refusal, and fails with the T3 text after a bridge failure", async () => {
	let last: LaunchOutcome | undefined;
	const check = launchContractCheck(() => last);
	expect(await check.run()).toMatchObject({ status: "pass", detail: expect.stringContaining("no launch") });
	last = { ok: false, at, error: "subagent launch refused: agent 'x' does not exist", bridge: false };
	expect((await check.run()).status).toBe("pass");
	last = { ok: false, at, error: "delegate_task failed for agent 'fx-leaf': invalid_request", bridge: true };
	expect(await check.run()).toEqual({ status: "fail", detail: expect.stringContaining("invalid_request") });
});

test("C8 fails when an extension API method is missing or a child run has no prompt sections", async () => {
	const api = { on() {}, registerTool() {}, setActiveTools() {}, getActiveTools() {}, getAllTools() {}, sendMessage() {} };
	expect((await extensionApiCheck(api as any, undefined).run()).status).toBe("pass");
	const { setActiveTools: _, ...partial } = api;
	expect(await extensionApiCheck(partial as any, undefined).run()).toEqual({ status: "fail", detail: expect.stringContaining("setActiveTools") });
	const child = { state: () => undefined, observed: () => ({ promptSections: false, input: true }) };
	expect(await extensionApiCheck(api as any, child).run()).toEqual({ status: "fail", detail: expect.stringContaining("systemPromptOptions") });
});
