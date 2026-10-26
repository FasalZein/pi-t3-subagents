/**
 * Shell task expansion (agent field `task-expansion: shell`), ported from
 * pi-subagents src/launch/task-expansion.ts (cf6dbf4): inline `!\`cmd\`` and
 * fenced ```! blocks run in the parent's working directory, 30 seconds per
 * command, and their output replaces the block. A failed command is reported
 * inline, as in pi-subagents; the launch continues.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const DYNAMIC_INLINE_PATTERN = /(^|\s)!`([^`]+)`/gm;
const FENCE_OPEN_PATTERN = /```([^\r\n]*)(?:\r?\n|$)/g;
const MAX_DYNAMIC_OUTPUT_CHARS = 50_000;
const COMMAND_TIMEOUT_MS = 30_000;
const execAsync = promisify(exec);

interface Placeholder {
	start: number;
	end: number;
	command: string;
	prefix?: string;
}

function formatShellOutput(stdout: string, stderr: string): string {
	const parts: string[] = [];
	if (stdout.trim()) parts.push(stdout.trim());
	if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
	const output = parts.join("\n");
	return output.length > MAX_DYNAMIC_OUTPUT_CHARS ? `${output.slice(0, MAX_DYNAMIC_OUTPUT_CHARS)}\n[output truncated]` : output;
}

async function run(command: string, cwd: string): Promise<string> {
	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 2 * 1024 * 1024,
			env: { ...process.env, PI_WORKSPACE: cwd },
		});
		return formatShellOutput(stdout, stderr);
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string; code?: number };
		const output = formatShellOutput(err.stdout ?? "", err.stderr ?? "");
		const status = err.killed ? `timed out${err.signal ? ` (${err.signal})` : ""}` : `failed${typeof err.code === "number" ? ` with code ${err.code}` : ""}`;
		return `[task shell ${status}: ${command}${output ? `\n${output}` : err.message ? `\n${err.message}` : ""}]`;
	}
}

function placeholders(task: string): Placeholder[] {
	const fences: Array<{ start: number; end: number }> = [];
	const found: Placeholder[] = [];
	FENCE_OPEN_PATTERN.lastIndex = 0;
	while (true) {
		const match = FENCE_OPEN_PATTERN.exec(task);
		if (!match) break;
		const start = match.index;
		const bodyStart = start + match[0].length;
		const closingStart = task.indexOf("```", bodyStart);
		if (closingStart === -1) {
			fences.push({ start, end: task.length });
			break;
		}
		const end = closingStart + 3;
		const marker = match[1]?.trim() ?? "";
		fences.push({ start, end });
		if (marker.startsWith("!")) {
			const command = [marker.slice(1).trim(), task.slice(bodyStart, closingStart)].filter((p) => p.trim()).join("\n").trim();
			if (command) found.push({ start, end, command });
		}
		FENCE_OPEN_PATTERN.lastIndex = end;
	}
	for (const match of task.matchAll(DYNAMIC_INLINE_PATTERN)) {
		const command = match[2]?.trim();
		if (!command || match.index === undefined) continue;
		const prefix = match[1] ?? "";
		const bang = match.index + prefix.length;
		if (fences.some((r) => bang >= r.start && bang < r.end)) continue;
		found.push({ start: match.index, end: match.index + match[0].length, command, prefix });
	}
	return found.sort((a, b) => a.start - b.start);
}

export async function expandTask(task: string, cwd: string): Promise<string> {
	if (!task.includes("!`") && !task.includes("```!")) return task;
	const replacements: Array<{ start: number; end: number; text: string }> = [];
	for (const p of placeholders(task)) replacements.push({ start: p.start, end: p.end, text: `${p.prefix ?? ""}${await run(p.command, cwd)}` });
	let out = task;
	for (const r of replacements.sort((a, b) => b.start - a.start)) out = `${out.slice(0, r.start)}${r.text}${out.slice(r.end)}`;
	return out;
}
