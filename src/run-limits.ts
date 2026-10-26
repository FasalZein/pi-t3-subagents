/**
 * Run limits in a managed child (spec "Child runtime": context warnings and time limit; S7).
 *
 * - Context warnings: the same thresholds, steps, messages and intent as pi-subagents
 *   (src/tools/context-reminders.ts at cf6dbf4, C9). After each model turn, the child
 *   compares its context usage with `context-warn-threshold`, + step and + 2 steps, and
 *   steers itself with one wrap-up message per crossed level. Sent levels are kept in the
 *   session; a level becomes available again when usage falls below it (compaction).
 * - Time limit (A10): one timer set per run generation. A generation is one Pi run: it
 *   opens at the first `agent_start` while no run is active and closes at `agent_settled`
 *   (Pi's "no automatic continuation remains"). At `timeout-warn-threshold` percent of
 *   `timeout` seconds the child gets one wrap-up steer; at `timeout` the run is aborted.
 *   A follow-up run (for example after `t3_thread_send`) opens a new generation with a
 *   new timer. Timers are cleared at run end and at `session_shutdown`; a timer callback
 *   that fires late for an old generation does nothing.
 *
 * Thresholds come from an injected definition getter, read again at the start of each
 * generation, so a frontmatter edit applies from the next run without a sync.
 * Installed through installManagedChildTools (slot S7 in index.ts): only in a managed
 * child, and only in the copy that owns the takeover, so one runtime has one timer set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./catalog.ts";
import type { ChildRuntime } from "./child-runtime.ts";
import type { ManagedChildToolInstaller } from "./managed-child-tools.ts";

/** Session entry with the context-warning levels already delivered. */
export const CONTEXT_WARNINGS_ENTRY = "pi-t3-subagents-context-warnings";
/** Session entry written when the time limit stops a run. */
export const RUN_LIMIT_ENTRY = "pi-t3-subagents-run-limit";
/**
 * Session entry naming a time-limit warning that Pi recorded only after its run was stopped.
 * Observed live (Pi 1.4.0 in T3, 2026-10-26): a steer still queued at the abort is written
 * into the transcript after the aborted tool result. The model of that run never saw it,
 * and a follow-up run would read "N s remain" as current. Such warnings are removed from
 * later model requests through the `context` event; the session file keeps them.
 */
export const STALE_WARNING_ENTRY = "pi-t3-subagents-stale-time-warning";

const DEFAULT_CONTEXT_WARN_STEP = 5;
/** pi-subagents: `timeout-warn-threshold: true` means 80%. */
const DEFAULT_TIMEOUT_WARN_THRESHOLD = 80;
const MS_PER_SECOND = 1000;

/** The run-limit fields of one agent definition, parsed as pi-subagents parses them. */
export interface RunLimits {
	/** First context-warning percentage, or null when context warnings are off. */
	readonly contextWarnThreshold: number | null;
	readonly contextWarnStep: number;
	/** Whole-run limit in seconds, or null when the run has no time limit. */
	readonly timeoutSeconds: number | null;
	/** Wrap-up steer at this percentage of the time limit, or null for no steer. */
	readonly timeoutWarnThreshold: number | null;
}

/** pi-subagents parseContextWarnThreshold: 1-99, `%` optional, decimals round down; else off. */
export function parseContextWarnThreshold(raw: string | undefined): number | null {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized || normalized === "off") return null;
	const match = normalized.match(/^(\d+(?:\.\d+)?)%?$/);
	if (!match) return null;
	const threshold = Math.floor(Number.parseFloat(match[1]));
	return threshold >= 1 && threshold <= 99 ? threshold : null;
}

/** pi-subagents parseContextWarnStep: 1-99, default 5. */
export function parseContextWarnStep(raw: string | undefined): number {
	const match = raw?.trim().match(/^(\d+(?:\.\d+)?)%?$/);
	if (!match) return DEFAULT_CONTEXT_WARN_STEP;
	const step = Math.floor(Number.parseFloat(match[1]));
	return step >= 1 && step <= 99 ? step : DEFAULT_CONTEXT_WARN_STEP;
}

/** pi-subagents parseTimeoutWarnThreshold: `true` = 80, 1-99, `false`/`off`/invalid = none. */
export function parseTimeoutWarnThreshold(raw: string | undefined): number | null {
	const normalized = raw?.trim().toLowerCase();
	if (!normalized || normalized === "false" || normalized === "off") return null;
	if (normalized === "true") return DEFAULT_TIMEOUT_WARN_THRESHOLD;
	const match = normalized.match(/^(\d+(?:\.\d+)?)%?$/);
	if (!match) return null;
	const threshold = Math.floor(Number.parseFloat(match[1]));
	return threshold >= 1 && threshold <= 99 ? threshold : null;
}

/** pi-subagents `timeout`: a positive whole number of seconds; anything else means no limit. */
export function parseTimeoutSeconds(raw: string | undefined): number | null {
	const trimmed = raw?.trim();
	if (!trimmed || !/^\d+$/.test(trimmed)) return null;
	const seconds = Number(trimmed);
	return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function runLimitsOf(agent: Pick<AgentDefinition, "fields"> | undefined): RunLimits {
	const f = agent?.fields ?? {};
	return {
		contextWarnThreshold: parseContextWarnThreshold(f["context-warn-threshold"]),
		contextWarnStep: parseContextWarnStep(f["context-warn-step"]),
		timeoutSeconds: parseTimeoutSeconds(f.timeout),
		timeoutWarnThreshold: parseTimeoutWarnThreshold(f["timeout-warn-threshold"]),
	};
}

/** pi-subagents getContextReminderThresholds: start, start + step, start + 2 steps, capped at 99. */
export function contextWarnLevels(start: number, step: number): number[] {
	return [...new Set([start, start + step, start + 2 * step].map((level) => Math.min(level, 99)))];
}

export interface ContextUsageSnapshot {
	readonly tokens: number;
	readonly contextWindow: number;
	readonly percent: number;
}

function compactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return `${Math.round(tokens)}`;
}

/** pi-subagents' three context-warning messages (stage 0, 1, 2). */
export function contextWarning(stage: number, usage: ContextUsageSnapshot): string {
	const current = `${compactTokens(usage.tokens)}/${compactTokens(usage.contextWindow)} tokens (${usage.percent.toFixed(1)}%)`;
	if (stage === 0)
		return `Your own context window is at ${current}; compaction is approaching. Avoid new scope and start bringing the current work to a close.`;
	if (stage === 1)
		return `Your own context window is at ${current}; compaction is close. Wrap up now, even if the work is partially finished — still complete and report per your instructions.`;
	return `Your own context window is critically full (${current}); compaction is imminent. Stop taking new actions and deliver your result now per your instructions, even if incomplete.`;
}

/**
 * pi-subagents selectContextReminder: at most one warning per usage snapshot. When usage
 * jumps across several levels, the most urgent crossed level wins and the lower ones count
 * as sent, so stale warnings are not queued later.
 */
export function selectContextWarning(
	limits: Pick<RunLimits, "contextWarnThreshold" | "contextWarnStep">,
	usage: ContextUsageSnapshot,
	sent: ReadonlySet<number>,
): { message: string; levels: number[] } | null {
	if (limits.contextWarnThreshold === null) return null;
	const levels = contextWarnLevels(limits.contextWarnThreshold, limits.contextWarnStep);
	const crossed = levels.filter((level) => usage.percent >= level && !sent.has(level));
	const level = crossed.at(-1);
	if (level === undefined) return null;
	return { message: contextWarning(levels.indexOf(level), usage), levels: levels.filter((l) => l <= level) };
}

/** The wrap-up steer at `timeout-warn-threshold`. */
export function timeoutWarning(timeoutSeconds: number, spentSeconds: number): string {
	const remaining = Math.max(0, timeoutSeconds - spentSeconds);
	return [
		`Time limit: this run has been running for ${spentSeconds}s, and its limit is ${timeoutSeconds}s for the whole run. About ${remaining}s remain.`,
		"This clock belongs to the current run; the conversation before this run did not count. Do not infer time from the transcript.",
		"At the limit the system stops this run, and work you did not report is lost.",
		"Stop taking on new work. Report your result now, even if it is incomplete.",
	].join(" ");
}

export function timeoutNotice(timeoutSeconds: number): string {
	return `pi-t3-subagents: run stopped at its time limit (timeout: ${timeoutSeconds}s).`;
}

/** Timer source; tests inject a fake clock. */
export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Reads the current agent definition of this child; undefined when it is not available. */
export type DefinitionGetter = (child: ChildRuntime) => Pick<AgentDefinition, "fields"> | undefined;

interface Generation {
	readonly id: number;
	readonly startedAt: number;
	readonly limits: RunLimits;
	readonly timers: unknown[];
}

type Ctx = {
	abort?: () => void;
	getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	sessionManager?: { getEntries?: () => unknown[] };
	ui?: { notify?: (message: string, type?: string) => void };
};

function usageOf(ctx: Ctx): ContextUsageSnapshot | undefined {
	const usage = ctx.getContextUsage?.();
	const { tokens, contextWindow, percent } = usage ?? {};
	if (typeof tokens !== "number" || typeof contextWindow !== "number" || typeof percent !== "number") return undefined;
	if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || !Number.isFinite(percent) || contextWindow <= 0) return undefined;
	return { tokens, contextWindow, percent };
}

function messageText(message: unknown): string | undefined {
	const m = message as { role?: unknown; content?: unknown };
	if (m?.role !== "user") return undefined;
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return undefined;
	return m.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

/** The installer for slot S7: context warnings and the time limit in a managed child. */
export function runLimitsInstaller(definition: DefinitionGetter, clock: Clock = realClock): ManagedChildToolInstaller {
	return (pi: ExtensionAPI, child: ChildRuntime) => installRunLimits(pi, child, definition, clock);
}

export function installRunLimits(pi: ExtensionAPI, child: ChildRuntime, definition: DefinitionGetter, clock: Clock = realClock): void {
	let generationCount = 0;
	let current: Generation | undefined;
	// Context levels delivered to the model (persisted) and levels queued but not yet delivered.
	const sent = new Set<number>();
	const pending = new Set<number>();
	const pendingMessages = new Map<string, number[]>();
	// Time-limit warnings sent but not yet in the transcript, by generation id; and the
	// warnings that reached the transcript only after their run was stopped.
	const undeliveredWarnings = new Map<string, number>();
	const staleWarnings = new Set<string>();

	const readLimits = (): RunLimits => {
		try {
			return runLimitsOf(definition(child));
		} catch {
			return runLimitsOf(undefined);
		}
	};

	const steer = (text: string) => {
		void Promise.resolve(pi.sendUserMessage(text, { deliverAs: "steer" })).catch(() => {});
	};

	const close = () => {
		if (!current) return;
		for (const handle of current.timers) clock.clearTimeout(handle);
		current = undefined;
	};

	const open = (ctx: Ctx) => {
		const generation: Generation = { id: ++generationCount, startedAt: clock.now(), limits: readLimits(), timers: [] };
		current = generation;
		const { timeoutSeconds, timeoutWarnThreshold } = generation.limits;
		if (timeoutSeconds === null) return;
		const live = () => current?.id === generation.id;
		const limitMs = timeoutSeconds * MS_PER_SECOND;
		if (timeoutWarnThreshold !== null) {
			generation.timers.push(
				clock.setTimeout(() => {
					if (!live()) return;
					const text = timeoutWarning(timeoutSeconds, Math.round((clock.now() - generation.startedAt) / MS_PER_SECOND));
					undeliveredWarnings.set(text, generation.id);
					steer(text);
				}, (limitMs * timeoutWarnThreshold) / 100),
			);
		}
		generation.timers.push(
			clock.setTimeout(() => {
				if (!live()) return;
				close();
				pending.clear();
				pendingMessages.clear();
				pi.appendEntry(RUN_LIMIT_ENTRY, { kind: "timeout", timeoutSeconds, generation: generation.id });
				ctx.ui?.notify?.(timeoutNotice(timeoutSeconds), "warning");
				ctx.abort?.();
			}, limitMs),
		);
	};

	const checkContext = (ctx: Ctx) => {
		const limits = current?.limits ?? readLimits();
		if (limits.contextWarnThreshold === null) return;
		const usage = usageOf(ctx);
		if (!usage) return;
		// Usage can drop (compaction): release the levels that usage is no longer above.
		const held = [...sent].filter((level) => usage.percent >= level);
		if (held.length !== sent.size) {
			sent.clear();
			for (const level of held) sent.add(level);
			pi.appendEntry(CONTEXT_WARNINGS_ENTRY, { sentThresholds: [...sent].sort((a, b) => a - b) });
		}
		const warning = selectContextWarning(limits, usage, new Set([...sent, ...pending]));
		if (!warning) return;
		pendingMessages.set(warning.message, warning.levels);
		for (const level of warning.levels) if (!sent.has(level)) pending.add(level);
		steer(warning.message);
	};

	pi.on("session_start", async (_event, ctx) => {
		sent.clear();
		pending.clear();
		pendingMessages.clear();
		const entries = ((ctx as Ctx)?.sessionManager?.getEntries?.() ?? []) as any[];
		for (const e of entries)
			if (e?.type === "custom" && e.customType === STALE_WARNING_ENTRY && typeof e.data?.text === "string") staleWarnings.add(e.data.text);
		const saved = entries.filter((e) => e?.type === "custom" && e.customType === CONTEXT_WARNINGS_ENTRY && Array.isArray(e.data?.sentThresholds)).at(-1);
		for (const level of saved?.data.sentThresholds ?? []) if (typeof level === "number") sent.add(level);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!current) open(ctx as Ctx);
	});

	pi.on("message_end", async (event) => {
		const text = messageText((event as any).message);
		const warningGeneration = text === undefined ? undefined : undeliveredWarnings.get(text);
		if (warningGeneration !== undefined) {
			undeliveredWarnings.delete(text as string);
			if (current?.id !== warningGeneration) {
				staleWarnings.add(text as string);
				pi.appendEntry(STALE_WARNING_ENTRY, { text });
			}
			return;
		}
		const levels = text === undefined ? undefined : pendingMessages.get(text);
		if (!levels) return;
		pendingMessages.delete(text as string);
		for (const level of levels) {
			sent.add(level);
			pending.delete(level);
		}
		pi.appendEntry(CONTEXT_WARNINGS_ENTRY, { sentThresholds: [...sent].sort((a, b) => a - b) });
	});

	pi.on("turn_end", async (event, ctx) => {
		const stopReason = (event as any).message?.stopReason;
		if (stopReason === "error" || stopReason === "aborted") return;
		checkContext(ctx as Ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const messages: any[] = (event as any).messages ?? [];
		const last = [...messages].reverse().find((m) => m?.role === "assistant");
		if (last?.stopReason === "error" || last?.stopReason === "aborted") {
			pending.clear();
			pendingMessages.clear();
			return;
		}
		if (last?.stopReason === "toolUse") return;
		checkContext(ctx as Ctx);
	});

	pi.on("context", async (event) => {
		if (staleWarnings.size === 0) return;
		const messages: any[] = (event as any).messages ?? [];
		const kept = messages.filter((m) => {
			const text = messageText(m);
			return text === undefined || !staleWarnings.has(text);
		});
		if (kept.length !== messages.length) return { messages: kept };
	});

	pi.on("agent_settled", async () => {
		close();
		pending.clear();
		pendingMessages.clear();
	});

	pi.on("session_shutdown", async () => {
		close();
	});
}
