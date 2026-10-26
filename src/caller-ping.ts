/**
 * Caller ping (spec "Child runtime", D8, A11, ADR 0003). Runs only in a managed child, in
 * the copy that owns the takeover (installed through installManagedChildTools, slot S6).
 *
 * `caller_ping { message }` is an end-turn ping: the tool result tells the model to end the
 * turn with a final reply that starts with the line `CALLER PING` followed by the message.
 * T3 wakes the caller with that reply, and the caller continues this thread with
 * `t3_thread_send`. After the ping, a `tool_call` handler refuses every further tool call
 * in that run (model-issued and nested) with the ping reason.
 *
 * caller_ping is a sequential tool: Pi 1.4.0 runs a parallel batch by preparing every call
 * (its `tool_call` check) before executing any, so a later call in the same batch would
 * pass the latch before the ping sets it. A sequential tool makes Pi run the whole batch
 * one call at a time, so later calls see the latch.
 *
 * The latch is run state of its own (not part of the header record): it resets at
 * `agent_start` and clears at `agent_end` and `session_shutdown`, so a continued run
 * (the caller's `t3_thread_send`) can use tools again.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChildRuntime } from "./child-runtime.ts";

export const CALLER_PING_TOOL = "caller_ping";
/** First line of the final reply after a ping; the caller's wake text starts with it. */
export const CALLER_PING_LINE = "CALLER PING";

const CallerPingParams = Type.Object({
	message: Type.String({ description: "What you need from the caller: the question, the decision with options, or the blocker." }),
});

/** Model-facing result of a successful ping. */
export function pingResultText(message: string): string {
	return [
		"Caller ping recorded. End your turn now and do not call any tool (further tool calls in this run are refused).",
		`Your final reply must start with the line ${CALLER_PING_LINE}, followed by this message:`,
		message,
		"The caller is woken with your reply and continues this thread with your answer.",
	].join("\n");
}

/** Block reason for a tool call after the ping in the same run. */
export function pingBlockReason(message: string): string {
	return `Refused: you called ${CALLER_PING_TOOL} in this run ("${message}"). End your turn now with a final reply that starts with the line ${CALLER_PING_LINE} followed by that message; the caller continues this thread.`;
}

/** Managed-child installer (ManagedChildToolInstaller) for slot S6. */
export function installCallerPing(pi: ExtensionAPI, _child?: ChildRuntime): void {
	// The ping message of the current run; undefined when this run has not pinged.
	let pinged: string | undefined;
	const clear = () => {
		pinged = undefined;
	};

	pi.registerTool({
		name: CALLER_PING_TOOL,
		label: "Caller ping",
		description: [
			"Ask your caller (the agent or user that launched you) for a decision, information or help, then end your turn.",
			`After this call, end the turn at once with a final reply that starts with the line ${CALLER_PING_LINE} followed by the message.`,
			"The caller is woken with that reply and continues this same thread with the answer. Further tool calls in this run are refused.",
		].join(" "),
		promptSnippet: "Ask your caller for a decision or help and end the turn; the caller continues this thread.",
		parameters: CallerPingParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const message = params.message.trim();
			if (!message) throw new Error(`${CALLER_PING_TOOL} needs a non-empty message.`);
			pinged = message;
			return { content: [{ type: "text", text: pingResultText(message) }], details: { message } };
		},
	});

	pi.on("tool_call", async () => {
		if (pinged !== undefined) return { block: true, reason: pingBlockReason(pinged) };
	});
	pi.on("agent_start", async () => clear());
	pi.on("agent_end", async () => clear());
	pi.on("session_shutdown", async () => clear());
}
