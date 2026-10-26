/**
 * Live-children ledger (spec "Live-children ledger", D11, D21, D32): parent side, in memory per
 * Pi process. It counts live child tasks plus reservations against the caller's spawn width.
 * Every transition is idempotent and keyed by task id or reservation id.
 *
 * Sources: the subagent tool (reserve, settle, release), the raw input event (wakes), and the
 * tool_call and tool_result events of the T3 bridge tools that the model calls (task_cancel,
 * task_status, t3_thread_read, t3_thread_send). The ledger never polls task_status (D11).
 *
 * C5: when raw input looks like a wake but cannot be read, width enforcement stops for this
 * session (fail open, D32) and a notice says so. Safety rules do not depend on this count.
 */
import type { CompatibilityCheck } from "./doctor.ts";

/** pi-subagents' hard maximum and the root limit (A15). */
export const MAX_SPAWN_WIDTH = 16;
export const FINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

const BRIDGE = "mcp__t3-code__";
export const TASK_CANCEL = `${BRIDGE}task_cancel`;
export const TASK_STATUS = `${BRIDGE}task_status`;
export const THREAD_READ = `${BRIDGE}t3_thread_read`;
export const THREAD_SEND = `${BRIDGE}t3_thread_send`;

export const FAIL_OPEN_NOTICE =
	"pi-t3-subagents: a T3 completion wake could not be read (wake text format changed, C5). Spawn-width accounting is off for this session; launches are no longer limited by width. Run /t3-subagents-doctor.";

/*
 * T3 wake and notice lines (installed Nightly bundle, 2026-10-26):
 * - `Delegated task <id> (<title>) [<status>]:` plus the reply (full form; the title is optional),
 * - `Delegated task <id> (<title>) [<status>]. Use task_status with taskId <id> to read the result.` (short form),
 * - `Delegated task <id> reached a terminal state` (task not found), and ProviderContinuationService's
 *   `Delegated task <id> reached a terminal state. Use task_status ...` / `Delegated tasks <a>, <b> reached terminal states. ...`,
 * - question notices (live S4 run, U19): `Delegated task <id> is blocked on a question and cannot continue until it is
 *   answered.` and `Delegated task <id> asked a question and is still working.` The task stays live.
 */
const WAKE_LINE = /^Delegated task (\S+)(?: \(.*\))? \[([A-Za-z_]+)\](?::|\. Use task_status with taskId \S+ to read the result\.)/;
const WAKE_NOT_FOUND = /^Delegated task (\S+)(?: \(.*\))? reached a terminal state/;
const WAKE_MANY = /^Delegated tasks (.+?) reached terminal states/;
const QUESTION_NOTICE = /^Delegated task (\S+) (?:is blocked on a question|asked a question and is still working)/;
const WAKE_LIKE = /(?:^|\n)\s*Delegated tasks? /;

export interface WakeParse {
	/** Text looks like a T3 completion wake or task notice. */
	readonly wake: boolean;
	/** Task ids the wake reports as settled. */
	readonly taskIds: readonly string[];
	/** Task ids named by a question notice (still live). */
	readonly noticeIds: readonly string[];
}

/** Parse T3's wake text (T3 facts, wake text). Several tasks are joined with a blank line. */
export function parseWake(text: string): WakeParse {
	if (!WAKE_LIKE.test(text)) return { wake: false, taskIds: [], noticeIds: [] };
	const taskIds: string[] = [];
	const noticeIds: string[] = [];
	const add = (list: string[], id: string) => void (list.includes(id) || list.push(id));
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const notice = QUESTION_NOTICE.exec(line);
		if (notice) {
			add(noticeIds, notice[1]!);
			continue;
		}
		const match = WAKE_LINE.exec(line) ?? WAKE_NOT_FOUND.exec(line);
		if (match) add(taskIds, match[1]!);
		const many = WAKE_MANY.exec(line);
		if (many) for (const id of many[1]!.split(/,\s*/)) if (id.trim()) add(taskIds, id.trim());
	}
	return { wake: true, taskIds, noticeIds };
}

export class WidthFullError extends Error {
	override name = "WidthFullError";
}

export interface LiveTask {
	readonly taskId: string;
	readonly childThreadId: string;
}

export interface LedgerSnapshot {
	readonly live: readonly LiveTask[];
	readonly reserved: number;
	readonly limit: number;
	readonly enforcing: boolean;
	readonly failOpenReason: string | null;
}

/** Bridge tool data from a Pi tool_result event: structuredContent.structuredContent, else JSON text content. */
export function bridgeData(event: { structuredContent?: any; content?: unknown }): any {
	const data = event.structuredContent?.structuredContent;
	if (data && typeof data === "object") return data;
	if (!Array.isArray(event.content)) return undefined;
	for (const part of event.content as any[]) {
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		try {
			const parsed = JSON.parse(part.text);
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			// not JSON: T3 text without data
		}
	}
	return undefined;
}

export class Ledger {
	private readonly live = new Map<string, LiveTask>();
	private readonly reservations = new Set<string>();
	/** Child threads launched by this process: t3_thread_send to them counts toward width. */
	private readonly threads = new Set<string>();
	/** t3_thread_send tool call id -> its reservation. */
	private readonly sends = new Map<string, string>();
	private nextId = 1;
	private failOpen: string | null = null;

	constructor(private readonly limit: () => number) {}

	/** Width limit of this caller, at most MAX_SPAWN_WIDTH. */
	width(): number {
		return Math.min(Math.max(0, this.limit()), MAX_SPAWN_WIDTH);
	}

	/**
	 * Reserve `count` slots synchronously, or throw when live + reserved + count exceeds the width.
	 * After a fail-open the reservation always succeeds.
	 */
	reserve(count: number): string[] {
		const width = this.width();
		const used = this.live.size + this.reservations.size;
		if (this.failOpen === null && used + count > width)
			throw new WidthFullError(
				`spawn width is full: ${this.live.size} live and ${this.reservations.size} reserved children, ${count} new, width ${width}. Wait for a wake, or stop a child with task_cancel.`,
			);
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			const id = `r${this.nextId++}`;
			this.reservations.add(id);
			ids.push(id);
		}
		return ids;
	}

	release(reservation: string): void {
		this.reservations.delete(reservation);
	}

	/** A launch or send response: a non-final status makes the reservation a live task; a final one releases it. */
	settle(reservation: string, task: { taskId: string; childThreadId: string; status: string }): void {
		if (!this.reservations.delete(reservation)) return;
		this.threads.add(task.childThreadId);
		if (!FINAL_TASK_STATUSES.has(task.status)) this.live.set(task.taskId, { taskId: task.taskId, childThreadId: task.childThreadId });
	}

	remove(taskId: string): void {
		this.live.delete(taskId);
	}

	snapshot(): LedgerSnapshot {
		return { live: [...this.live.values()], reserved: this.reservations.size, limit: this.width(), enforcing: this.failOpen === null, failOpenReason: this.failOpen };
	}

	/** Raw input: remove every task a wake reports. Returns the fail-open notice when the wake is unreadable (first time only). */
	observeInput(text: string): string | undefined {
		const parsed = parseWake(text);
		if (!parsed.wake) return undefined;
		if (parsed.taskIds.length === 0 && parsed.noticeIds.length === 0) {
			if (this.failOpen !== null) return undefined;
			this.failOpen = `unreadable wake at ${new Date().toISOString()}: ${JSON.stringify(text.slice(0, 120))}`;
			return FAIL_OPEN_NOTICE;
		}
		for (const id of parsed.taskIds) this.live.delete(id);
		return undefined;
	}

	/** tool_call of t3_thread_send to a known child thread: reserve one slot, or return the block reason. */
	observeSendCall(event: { toolName: string; toolCallId: string; input?: any }): string | undefined {
		if (event.toolName !== THREAD_SEND) return undefined;
		const threadId = event.input?.threadId;
		if (typeof threadId !== "string" || !this.threads.has(threadId)) return undefined;
		if (this.sends.has(event.toolCallId)) return undefined;
		try {
			const [reservation] = this.reserve(1);
			this.sends.set(event.toolCallId, reservation!);
			return undefined;
		} catch (error) {
			return `t3_thread_send blocked: ${(error as Error).message}`;
		}
	}

	/** End of any tool call: a t3_thread_send reservation still open (blocked, aborted) is released. */
	endCall(event: { toolCallId: string }): void {
		const reservation = this.sends.get(event.toolCallId);
		if (reservation === undefined) return;
		this.sends.delete(event.toolCallId);
		this.release(reservation);
	}

	/** tool_result of the bridge tools the ledger follows. */
	observeToolResult(event: { toolName: string; toolCallId: string; input?: any; isError?: boolean; structuredContent?: any; content?: unknown }): void {
		const data = event.isError ? undefined : bridgeData(event);
		switch (event.toolName) {
			case THREAD_SEND: {
				const reservation = this.sends.get(event.toolCallId);
				if (reservation === undefined) return;
				this.sends.delete(event.toolCallId);
				const threadId = String(data?.threadId ?? event.input?.threadId);
				if (data?.isError !== true && typeof data?.taskId === "string") this.settle(reservation, { taskId: data.taskId, childThreadId: threadId, status: String(data.status ?? "running") });
				else this.release(reservation);
				return;
			}
			case TASK_CANCEL: {
				// Any status: T3 disposes the automatic delivery, so no wake comes.
				const taskId = data?.taskId ?? event.input?.taskId;
				if (data && typeof taskId === "string") this.live.delete(taskId);
				return;
			}
			case TASK_STATUS: {
				const taskId = data?.taskId ?? event.input?.taskId;
				if (typeof taskId === "string" && FINAL_TASK_STATUSES.has(String(data?.status))) this.live.delete(taskId);
				return;
			}
			case THREAD_READ: {
				// Reading a child's final result marks it read and suppresses the wake (T3 facts).
				const threadId = event.input?.threadId;
				const status = data?.status ?? data?.thread?.status;
				if (typeof threadId !== "string" || !FINAL_TASK_STATUSES.has(String(status))) return;
				for (const task of [...this.live.values()]) if (task.childThreadId === threadId) this.live.delete(task.taskId);
				return;
			}
		}
	}
}

/** Width limit for a caller: root 16 (A15); an agent its own `spawn-width`, at most 16. */
export function widthFor(callerAgent: string | null, spawnWidth: string | undefined): number {
	if (callerAgent === null) return MAX_SPAWN_WIDTH;
	const parsed = spawnWidth !== undefined && /^\d+$/.test(spawnWidth.trim()) ? Number(spawnWidth.trim()) : MAX_SPAWN_WIDTH;
	return Math.min(parsed, MAX_SPAWN_WIDTH);
}

/**
 * Pi wiring: wakes from the raw input event, sends and reads from the tool events. The notice
 * goes to the UI (when present) and to the doctor (C5).
 */
export function installLedger(pi: { on(event: string, handler: (event: any, ctx: any) => any): void }, ledger: Ledger): void {
	pi.on("input", (event, ctx) => {
		if (typeof event?.text !== "string") return undefined;
		const notice = ledger.observeInput(event.text);
		if (notice) ctx?.ui?.notify?.(notice, "warning");
		return undefined;
	});
	pi.on("tool_call", (event) => {
		const reason = ledger.observeSendCall(event);
		return reason ? { block: true, reason } : undefined;
	});
	pi.on("tool_result", (event) => {
		ledger.observeToolResult(event);
		return undefined;
	});
	// A call blocked by another tool_call handler skips tool_result: release its reservation.
	pi.on("tool_execution_end", (event) => {
		ledger.endCall(event);
		return undefined;
	});
}

export function wakeFormatCheck(ledger: Ledger): CompatibilityCheck {
	return {
		id: "C5",
		contract: "T3 completion wake text: Delegated task <id> (<title>) [<status>]: and the task_status short form",
		run() {
			const s = ledger.snapshot();
			if (!s.enforcing) return { status: "fail", detail: `width accounting failed open: ${s.failOpenReason}` };
			return { status: "pass", detail: `wakes readable; ${s.live.length} live, ${s.reserved} reserved, width ${s.limit}${s.live.length ? `: ${s.live.map((t) => t.taskId).join(", ")}` : ""}` };
		},
	};
}
