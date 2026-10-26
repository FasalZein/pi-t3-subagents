/**
 * Settings writer (ADR 0005): the only code that writes T3 settings.
 * Own-writer lock, private backup, temporary file, final compare, immediate
 * rename, release, then a check after T3 reloads that the planned entries exist.
 *
 * Remaining risk (stated, not hidden): a T3 settings save between the final
 * compare and the rename can be lost, and a T3 save after the rename can
 * erase this write. The second case is detected by `verify`.
 */
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const LOCK_STALE_MS = 60_000;
export const BACKUPS_KEPT = 10;
/** T3 debounces settings reloads by 100 ms; the spec waits up to 3 seconds. */
export const DEFAULT_RELOAD_WAIT_MS = 3_000;
const LOCK_POLL_MS = 50;
const DEFAULT_LOCK_WAIT_MS = 30_000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface WriterHooks {
	/** Runs after the temporary file is written, before the final compare. Tests inject a concurrent writer here. */
	beforeFinalCompare?: () => void | Promise<void>;
	/** Runs right after the rename, before the lock is released. */
	afterRename?: () => void | Promise<void>;
}

export interface WriteRequest {
	readonly settingsPath: string;
	/** Folder for the lock and `backups/` (`<config dir>/t3-subagents`). */
	readonly stateDir: string;
	/** The exact file text the change was planned from (step 1). */
	readonly originalText: string;
	readonly nextText: string;
	/** Returns problems found in the reloaded settings; empty means every planned entry is present. */
	readonly verify: (reloaded: unknown) => string[];
	readonly reloadWaitMs?: number;
	readonly lockWaitMs?: number;
	readonly hooks?: WriterHooks;
	readonly now?: () => Date;
}

export type WriteOutcome =
	| { readonly status: "written"; readonly backupPath: string }
	| { readonly status: "changed"; readonly message: string }
	| { readonly status: "lost"; readonly backupPath: string; readonly message: string; readonly problems: readonly string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function lockPath(stateDir: string): string {
	return join(stateDir, "settings-writer.lock");
}

export async function acquireLock(stateDir: string, waitMs = DEFAULT_LOCK_WAIT_MS): Promise<() => void> {
	mkdirSync(stateDir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const path = lockPath(stateDir);
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const fd = openSync(path, "wx", PRIVATE_FILE_MODE);
			writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
			closeSync(fd);
			return () => {
				try {
					unlinkSync(path);
				} catch {}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		try {
			if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
				unlinkSync(path);
				continue;
			}
		} catch {
			continue; // Released between open and stat.
		}
		if (Date.now() > deadline) throw new Error(`settings writer lock is busy: ${path}`);
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

export async function writeSettings(req: WriteRequest): Promise<WriteOutcome> {
	const release = await acquireLock(req.stateDir, req.lockWaitMs);
	let tmp: string | undefined;
	let backupPath: string;
	try {
		if (readText(req.settingsPath) !== req.originalText) return { status: "changed", message: CHANGED };
		backupPath = saveBackup(req.stateDir, req.originalText, (req.now ?? (() => new Date()))());
		tmp = join(dirname(req.settingsPath), `.${basename(req.settingsPath)}.t3-subagents-${process.pid}-${Date.now()}.tmp`);
		writeFileSync(tmp, req.nextText, { mode: PRIVATE_FILE_MODE, flag: "wx" });
		await req.hooks?.beforeFinalCompare?.();
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
		release();
	}
	await sleep(req.reloadWaitMs ?? DEFAULT_RELOAD_WAIT_MS);
	let problems: string[];
	try {
		problems = req.verify(JSON.parse(readText(req.settingsPath)));
	} catch (error) {
		problems = [`settings could not be read after the write: ${(error as Error).message}`];
	}
	if (problems.length > 0) return { status: "lost", backupPath, message: LOST, problems };
	return { status: "written", backupPath };
}
