/**
 * Layer 1, S8: the interactive hint is used only for `mode: interactive` with `auto-exit: false`
 * (spec "Mode hints in T3", S8 acceptance). Expected texts come from the spec, not from the code.
 * `auto-exit` absent counts as false: pi-subagents' default (README field table, definitions.ts
 * parses only "true" as true). `mode` absent is not interactive: the spec names `mode: interactive`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { type LaunchFixture, launchFixture } from "./launch-helpers.ts";

const AUTONOMOUS = "Complete your task autonomously.";
const SUMMARY = "Your FINAL assistant message should summarize what you accomplished.";
const INTERACTIVE =
	"You run in a T3 Code child thread. The user can open this thread and reply. Ask questions with ask_user when it is available. When the work is done, end your turn with your final report; your caller is woken with it. The user may continue this thread later.";
const TASK = "Ask me one question.";

let f: LaunchFixture;
beforeEach(() => {
	f = launchFixture();
});
afterEach(() => f.h.cleanup());

/** The first message body (without the header line) that the bridge receives for one agent. */
async function body(name: string, fields: string, prompt?: string): Promise<string> {
	f.h.agent(name, `name: ${name}\ndescription: S8 shape\nmodel: cpa/claude-haiku-5-5\nthinking: low\n${fields}`, prompt);
	f.sync();
	const bridge = f.bridge();
	await f.run(f.tool(), bridge, { name: "s8-check", title: "S8 check", agent: name, task: TASK });
	return (bridge.calls[0].args.task as string).split("\n").slice(1).join("\n");
}

const interactive = `${INTERACTIVE}\n\n${TASK}`;
const autonomous = `${AUTONOMOUS}\n\n${TASK}\n\n${SUMMARY}`;
const shapes: Array<[string, string, string]> = [
	["mode: interactive, auto-exit: false (architect, design)", "mode: interactive\nauto-exit: false", interactive],
	["mode: interactive, auto-exit absent (pi-subagents default false)", "mode: interactive", interactive],
	["mode: interactive, auto-exit: true (cleaner, hardener)", "mode: interactive\nauto-exit: true", autonomous],
	["mode: background, auto-exit: false", "mode: background\nauto-exit: false", autonomous],
	["mode: background, auto-exit: true (worker, scout)", "mode: background\nauto-exit: true", autonomous],
	["mode absent, auto-exit: false", "auto-exit: false", autonomous],
	["mode and auto-exit absent", "", autonomous],
];
for (const [label, fields, expected] of shapes) {
	test(`mode hint: ${label}`, async () => {
		expect(await body("fx-shape", `${fields}\nsystem-prompt: replace`)).toBe(expected);
	});
}

test("interactive hint keeps the order header, skills, role block, hint, task and has no summary instruction", async () => {
	const text = await body("fx-architect", "mode: interactive\nauto-exit: false\nskills: tdd\ninject-skills: tdd", "You are the architect role.");
	const skillDir = join(f.h.configDir, "skills", "tdd");
	expect(text).toBe(`<skill name="tdd">\nReferences are relative to ${skillDir}.\n\nbody\n</skill>\n\nYou are the architect role.\n\n${INTERACTIVE}\n\n${TASK}`);
});
