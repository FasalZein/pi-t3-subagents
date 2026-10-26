/**
 * Settings writer (ADR 0005): the only code that writes T3 settings.
 * Own-writer lock, private backup, temporary file, final compare, immediate
 * rename, release, then a check after T3 reloads that the planned entries exist.
 *
 * Remaining risk (stated, not hidden): a T3 settings save between the final
 * compare and the rename can be lost, and a T3 save after the rename can
 * erase this write. The second case is detected by `verify`.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export const BACKUPS_KEPT = 10;
/** T3 debounces settings reloads by 100 ms; the spec waits up to 3 seconds. */
export const DEFAULT_RELOAD_WAIT_MS = 3_000;
const LOCK_POLL_MS = 50;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface WriterHooks {
	/** Runs after the temporary file is written, before the final compare. Tests inject a concurrent writer here. */
	beforeFinalCompare?: () => void | Promise<void>;
	/** Runs right after the rename, before the lock is released. */
	afterRename?: () => void | Promise<void>;
}

export interface WriteRequest {
	/** The lock is derived from this path, so every writer of one settings file shares it. */
	readonly settingsPath: string;
	/** Folder for `backups/` (`<config dir>/t3-subagents`). */
	readonly stateDir: string;
	/** The exact file text the change was planned from (step 1). */
	readonly originalText: string;
	readonly nextText: string;
	/** Returns problems found in the reloaded settings; empty means every planned entry is present. */
	readonly verify: (reloaded: unknown) => string[];
	readonly reloadWaitMs?: number;
	readonly lockWaitMs?: number;
	/** --break-lock: remove one non-live lock that is unchanged since it was read. */
	readonly breakLock?: boolean;
	readonly hooks?: WriterHooks;
	readonly now?: () => Date;
}

export type WriteOutcome =
	| { readonly status: "written"; readonly backupPath: string; readonly brokenLock?: LockInfo }
	| { readonly status: "locked"; readonly message: string; readonly lock: LockInfo }
	| { readonly status: "changed"; readonly message: string }
	| { readonly status: "lock-lost"; readonly message: string }
	| { readonly status: "lost"; readonly backupPath: string; readonly message: string; readonly problems: readonly string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One lock per settings file, next to it. Deriving it from the settings path
 * (not from PI_CODING_AGENT_DIR) makes two Pi profiles that target the same
 * T3 settings file serialize on the same lock.
 */
export function lockPath(settingsPath: string): string {
	return join(dirname(settingsPath), `.${basename(settingsPath)}.pi-t3-subagents.lock`);
}

export interface WriterLock {
	/** True while the lock file still holds this acquisition's token. */
	owns(): boolean;
	/** Removes the lock file only when it still holds this acquisition's token. */
	release(): void;
	/** The lock this acquisition removed with --break-lock, if any. */
	readonly broken?: LockInfo;
}

/** What a lock file says about its holder. */
export interface LockInfo {
	readonly path: string;
	/** live: holder process exists on this host. gone: it does not. other-host, unreadable, malformed: liveness unknown. */
	readonly state: "live" | "gone" | "other-host" | "unreadable" | "malformed";
	readonly pid?: number;
	readonly host?: string;
	readonly ageMs?: number;
	/** Content if readable, plus file identity; --break-lock removes the lock only while this is unchanged. */
	readonly fingerprint: string;
}

export class LockError extends Error {
	constructor(
		message: string,
		readonly lock: LockInfo,
	) {
		super(message);
	}
}

const MAX_PID = 4_194_304; // Upper bound of pid values on macOS and Linux.
const TOKEN = /^(\d+) (\S+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Reads and classifies a lock file. Returns undefined when it does not exist. Never removes anything. */
export function inspectLock(path: string): LockInfo | undefined {
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { path, state: "unreadable", fingerprint: "stat-failed" };
	}
	const identity = `${st.ino}:${st.size}:${st.mtimeMs}`;
	const ageMs = Math.max(0, Date.now() - st.mtimeMs);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { path, state: "unreadable", ageMs, fingerprint: identity };
	}
	const fingerprint = `${identity}|${text}`;
	const m = TOKEN.exec(text);
	const pid = m ? Number(m[1]) : NaN;
	if (!m || !Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) return { path, state: "malformed", ageMs, fingerprint };
	const host = m[2];
	if (host !== hostname()) return { path, state: "other-host", pid, host, ageMs, fingerprint };
	return { path, state: processAlive(pid) ? "live" : "gone", pid, host, ageMs, fingerprint };
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH: no such process. Anything else (EPERM: exists, owned by another user) counts as alive.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function describe(info: LockInfo): string {
	const holder = info.pid !== undefined ? `process ${info.pid} on ${info.host}` : "unknown holder";
	const age = info.ageMs !== undefined ? `, age ${Math.round(info.ageMs / 1000)} s` : "";
	return `${info.path} (${info.state}: ${holder}${age})`;
}

export interface AcquireOptions {
	/** Bounded wait for a live holder to finish (default 5 s). Other locks fail at once. */
	readonly waitMs?: number;
	/** Remove one non-live lock whose content is unchanged since it was read (user-confirmed by --break-lock). */
	readonly breakLock?: boolean;
	/** Test hook: runs after a lock was inspected for --break-lock and before it is removed. */
	readonly beforeBreak?: () => void;
}

export async function acquireLock(settingsPath: string, options: AcquireOptions = {}): Promise<WriterLock> {
	const path = lockPath(settingsPath);
	const token = `${process.pid} ${hostname()} ${randomUUID()}`;
	const owns = () => {
		try {
			return readFileSync(path, "utf8") === token;
		} catch {
			return false;
		}
	};
	const deadline = Date.now() + (options.waitMs ?? DEFAULT_LOCK_WAIT_MS);
	let broken: LockInfo | undefined;
	for (;;) {
		try {
			const fd = openSync(path, "wx", PRIVATE_FILE_MODE);
			writeFileSync(fd, token);
			closeSync(fd);
			return {
				owns,
				broken,
				release() {
					if (!owns()) return;
					try {
						unlinkSync(path);
					} catch {}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const info = inspectLock(path);
		if (info && info.state === "live") {
			if (Date.now() >= deadline)
				throw new LockError(`settings writer lock is busy: ${describe(info)}. A running writer holds it; --break-lock never removes a live holder's lock.`, info);
		} else if (info) {
			if (!options.breakLock || broken)
				throw new LockError(
					`settings writer lock is held but its holder is not running here: ${describe(info)}. The sync does not remove locks on its own. If no sync is running, run /t3-sync-agents --break-lock.`,
					info,
				);
			options.beforeBreak?.();
			const now = inspectLock(path);
			if (!now || now.fingerprint !== info.fingerprint || now.state === "live")
				throw new LockError(`--break-lock refused: the lock changed since it was read: ${describe(now ?? info)}. Run the sync again.`, now ?? info);
			unlinkSync(path);
			broken = info;
			continue;
		}
		// Lock missing (released between open and inspect) or live holder within the wait: retry after a short sleep.
		if (Date.now() >= deadline) throw new Error(`settings writer lock could not be taken: ${path}`);
		await sleep(LOCK_POLL_MS);
	}
}

function timestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export function backupsDir(stateDir: string): string {
	return join(stateDir, "backups");
}

export function saveBackup(stateDir: string, text: string, now: Date): string {
	const dir = backupsDir(stateDir);
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	chmodSync(dir, PRIVATE_DIR_MODE);
	let path = join(dir, `settings-${timestamp(now)}.json`);
	for (let n = 1; exists(path); n++) path = join(dir, `settings-${timestamp(now)}-${n}.json`);
	writeFileSync(path, text, { mode: PRIVATE_FILE_MODE, flag: "wx" });
	chmodSync(path, PRIVATE_FILE_MODE);
	const backups = readdirSync(dir)
		.filter((f) => /^settings-.*\.json$/.test(f))
		.sort();
	for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) unlinkSync(join(dir, old));
	return path;
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

const readText = (path: string) => readFileSync(path, "utf8");
const CHANGED = "settings changed, run the sync again";
const LOST = "lost to a concurrent T3 settings save; run the sync again";
const LOCK_LOST = "the settings writer lock was taken over by another writer; run the sync again";

export async function writeSettings(req: WriteRequest): Promise<WriteOutcome> {
	let lock: WriterLock;
	try {
		lock = await acquireLock(req.settingsPath, { waitMs: req.lockWaitMs, breakLock: req.breakLock });
	} catch (error) {
		if (error instanceof LockError) return { status: "locked", message: error.message, lock: error.lock };
		throw error;
	}
	let tmp: string | undefined;
	let backupPath: string;
	try {
		if (readText(req.settingsPath) !== req.originalText) return { status: "changed", message: CHANGED };
		backupPath = saveBackup(req.stateDir, req.originalText, (req.now ?? (() => new Date()))());
		tmp = join(dirname(req.settingsPath), `.${basename(req.settingsPath)}.t3-subagents-${process.pid}-${Date.now()}.tmp`);
		writeFileSync(tmp, req.nextText, { mode: PRIVATE_FILE_MODE, flag: "wx" });
		await req.hooks?.beforeFinalCompare?.();
		// A writer that lost its lock (stale takeover) must not commit: another writer may be mid-write.
		if (!lock.owns()) return { status: "lock-lost", message: LOCK_LOST };
		if (readText(req.settingsPath) !== req.originalText) return { status: "changed", message: CHANGED };
		renameSync(tmp, req.settingsPath);
		tmp = undefined;
		await req.hooks?.afterRename?.();
	} finally {
		if (tmp) {
			try {
				unlinkSync(tmp);
			} catch {}
		}
		lock.release();
	}
	await sleep(req.reloadWaitMs ?? DEFAULT_RELOAD_WAIT_MS);
	let problems: string[];
	try {
		problems = req.verify(JSON.parse(readText(req.settingsPath)));
	} catch (error) {
		problems = [`settings could not be read after the write: ${(error as Error).message}`];
	}
	if (problems.length > 0) return { status: "lost", backupPath, message: LOST, problems };
	return { status: "written", backupPath, ...(lock.broken ? { brokenLock: lock.broken } : {}) };
}
