/**
 * Takeover (spec "Modules: Takeover", ADR 0001, ADR 0003).
 *
 * Inside T3 Code only:
 * - While loading: add `subagent` and `subagent_resume` to PI_DENY_TOOLS, so that
 *   pi-subagents (which reads the variable once in its factory) skips them.
 * - At session start: restore the original PI_DENY_TOOLS (A4), so processes that the
 *   session starts do not inherit the denial. Then register the T3 `subagent` only if
 *   no foreign `subagent` is registered. If one is (the suppression failed), register
 *   nothing, deactivate pi-subagents' launch tools, and add a notice to the first run.
 * - Always deactivate pi-subagents' `subagent_kill` (and `subagent_resume`, if present).
 *
 * The T3 tool is registered at session start, not at load: a duplicate tool name at load
 * stops Pi 1.4.0 (contract C2), while a check at session start can fail soft (D29).
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CompatibilityCheck } from "./doctor.ts";

export const URL_ENV = "T3_MCP_URL";
export const TOKEN_ENV = "T3_MCP_BEARER_TOKEN";
export const DENY_ENV = "PI_DENY_TOOLS";
export const LAUNCH_TOOL = "subagent";
export const RESUME_TOOL = "subagent_resume";
export const KILL_TOOL = "subagent_kill";
export const NOTICE_TYPE = "pi-t3-subagents-notice";
const DENIED_AT_LOAD = [LAUNCH_TOOL, RESUME_TOOL];

/** Shared between copies of this extension in one process (contract C2: one copy only). */
const COPIES_KEY = Symbol.for("pi-t3-subagents.copies");
interface CopyRegistry {
	owner: string;
	others: Set<string>;
}

type Env = Record<string, string | undefined>;

/** Tests only: forget the copies that earlier factories in this process recorded. */
export function resetCopyRegistry(): void {
	delete (globalThis as Record<symbol, unknown>)[COPIES_KEY];
}

/** Presence only: the values are never read (spec: Takeover; user story 61). */
export function isInsideT3(env: Env): boolean {
	return Boolean(env[URL_ENV]) && Boolean(env[TOKEN_ENV]);
}

export type TakeoverState =
	| { kind: "outside_t3" }
	/** Loaded inside T3; session start has not run yet. */
	| { kind: "pending" }
	| { kind: "registered" }
	/** A foreign `subagent` was registered at session start: delegation is off (C1). */
	| { kind: "suppression_failed"; foreignSource: string }
	/** The original PI_DENY_TOOLS denies `subagent`; the takeover honors it. */
	| { kind: "denied_by_env" }
	/** Another copy of this extension (a different path) owns the takeover (C2). */
	| { kind: "second_copy"; ownerId: string };

export interface Takeover {
	state(): TakeoverState;
	/** Every copy of this extension loaded in this process, the owner first. */
	copies(): string[];
}

export interface TakeoverOptions {
	env: Env;
	/** Identifies this copy of the extension, for example its entry file URL. */
	copyId: string;
	/** The T3 `subagent` tool. Registered at session start when the takeover succeeds. */
	tool: ToolDefinition<any, any, any>;
}

function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

export function noticeText(foreignSource: string): string {
	return [
		"pi-t3-subagents: delegation is off in this session.",
		`A foreign \`subagent\` tool (from ${foreignSource}) was registered, so the T3 subagent tool was not installed (compatibility contract C1: pi-subagents no longer honors PI_DENY_TOOLS, or a second copy of a subagent extension is loaded).`,
		"pi-subagents' subagent, subagent_resume and subagent_kill are inactive because their children would be invisible to T3.",
		"Do not try to launch subagents. Tell the user to run /t3-subagents-doctor.",
	].join("\n");
}

export function installTakeover(pi: ExtensionAPI, options: TakeoverOptions): Takeover {
	const { env } = options;
	if (!isInsideT3(env)) {
		const outside: TakeoverState = { kind: "outside_t3" };
		return { state: () => outside, copies: () => [] };
	}

	const global = globalThis as Record<symbol, CopyRegistry | undefined>;
	const registry = global[COPIES_KEY] ?? { owner: options.copyId, others: new Set<string>() };
	global[COPIES_KEY] = registry;
	const copies = () => [registry.owner, ...registry.others];
	if (registry.owner !== options.copyId) {
		// Another copy already changed PI_DENY_TOOLS and owns the session-start work.
		registry.others.add(options.copyId);
		const second: TakeoverState = { kind: "second_copy", ownerId: registry.owner };
		return { state: () => second, copies };
	}

	const original = env[DENY_ENV];
	const originallyDenied = new Set(splitList(original));
	const denied = new Set(originallyDenied);
	for (const name of DENIED_AT_LOAD) denied.add(name);
	env[DENY_ENV] = [...denied].join(",");
	let restored = false;

	let state: TakeoverState = { kind: "pending" };
	let ownRegistered = false;
	let noticePending: string | undefined;

	const deactivate = (names: string[]) => {
		const active = pi.getActiveTools();
		const next = active.filter((name) => !names.includes(name));
		if (next.length !== active.length) pi.setActiveTools(next);
	};
	const hiddenNames = () =>
		state.kind === "suppression_failed" ? [LAUNCH_TOOL, RESUME_TOOL, KILL_TOOL] : [RESUME_TOOL, KILL_TOOL];

	pi.on("session_start", async () => {
		if (!restored) {
			if (original === undefined) delete env[DENY_ENV];
			else env[DENY_ENV] = original;
			restored = true;
		}
		if (!ownRegistered) {
			const foreign = pi.getAllTools().find((tool) => tool.name === LAUNCH_TOOL);
			if (foreign) {
				state = { kind: "suppression_failed", foreignSource: foreign.sourceInfo?.path ?? "unknown source" };
				noticePending = noticeText(state.foreignSource);
			} else if (originallyDenied.has(LAUNCH_TOOL)) {
				state = { kind: "denied_by_env" };
			} else {
				pi.registerTool(options.tool);
				ownRegistered = true;
				state = { kind: "registered" };
			}
		}
		deactivate(hiddenNames());
	});

	pi.on("before_agent_start", async () => {
		// Another extension may activate tools again between session start and a run.
		deactivate(hiddenNames());
		if (noticePending === undefined) return;
		const content = noticePending;
		noticePending = undefined;
		return { message: { customType: NOTICE_TYPE, content, display: true } };
	});

	return { state: () => state, copies };
}

export function takeoverChecks(takeover: Takeover): CompatibilityCheck[] {
	return [
		{
			id: "C1",
			contract: "pi-subagents skips subagent and subagent_resume when PI_DENY_TOOLS names them",
			run() {
				const state = takeover.state();
				switch (state.kind) {
					case "registered":
						return { status: "pass", detail: "no foreign subagent at session start; the T3 subagent is installed." };
					case "denied_by_env":
						return { status: "pass", detail: "the original PI_DENY_TOOLS denies subagent; the takeover honors it and installs no subagent." };
					case "suppression_failed":
						return { status: "fail", detail: `a foreign subagent from ${state.foreignSource} was registered at session start; delegation is off in this session.` };
					case "pending":
						return { status: "fail", detail: "session start has not run in this session yet." };
					case "second_copy":
						return { status: "fail", detail: `this copy does not own the takeover; the copy ${state.ownerId} does.` };
					case "outside_t3":
						return { status: "fail", detail: "not inside T3." };
				}
			},
		},
		{
			id: "C2",
			contract: "command-line extensions load before settings packages; duplicate tool names at load are fatal",
			run() {
				const copies = takeover.copies();
				if (copies.length > 1) {
					return { status: "fail", detail: `${copies.length} copies of pi-t3-subagents are loaded (${copies.join(", ")}). Load it once, through the instance's --extension argument only.` };
				}
				return { status: "pass", detail: "one copy of pi-t3-subagents is loaded. Load order at runtime is covered by C1; the real-Pi probe in test/probe proves it." };
			},
		},
	];
}
