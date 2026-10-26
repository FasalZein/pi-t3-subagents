/**
 * Doctor (spec "Compatibility contracts", D31, A7): `/t3-subagents-doctor`.
 *
 * Each module registers its compatibility checks here. The command is registered whenever
 * the extension loads; outside T3 it reports "not inside T3" and runs no check.
 */
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

export const DOCTOR_COMMAND = "t3-subagents-doctor";
export const DOCTOR_MESSAGE_TYPE = "pi-t3-subagents-doctor";

export type CheckStatus = "pass" | "fail";

export interface CheckResult {
	status: CheckStatus;
	detail: string;
}

export interface CompatibilityCheck {
	/** Contract id from the spec table, for example "C1". */
	id: string;
	/** The external behavior relied on, in a few words. */
	contract: string;
	run(): CheckResult | Promise<CheckResult>;
}

export interface DoctorReport {
	insideT3: boolean;
	results: Array<{ id: string; contract: string } & CheckResult>;
}

export interface Doctor {
	register(check: CompatibilityCheck): void;
	run(): Promise<DoctorReport>;
}

export function createDoctor(options: { insideT3: boolean }): Doctor {
	const checks: CompatibilityCheck[] = [];
	return {
		register(check) {
			checks.push(check);
		},
		async run() {
			if (!options.insideT3) return { insideT3: false, results: [] };
			const results: DoctorReport["results"] = [];
			for (const check of [...checks].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))) {
				let result: CheckResult;
				try {
					result = await check.run();
				} catch (error) {
					result = { status: "fail", detail: `check threw: ${error instanceof Error ? error.message : String(error)}` };
				}
				results.push({ id: check.id, contract: check.contract, ...result });
			}
			return { insideT3: true, results };
		},
	};
}

export function formatReport(report: DoctorReport): string {
	if (!report.insideT3) {
		return "pi-t3-subagents doctor: not inside T3 (T3_MCP_URL and T3_MCP_BEARER_TOKEN are not both set). The extension changes nothing here; no contract was checked.";
	}
	const failed = report.results.filter((result) => result.status === "fail").length;
	const lines = [
		`pi-t3-subagents doctor: ${report.results.length} contracts checked, ${failed} failed.`,
		...report.results.map((result) => `${result.id} ${result.status.toUpperCase()} ${result.contract}: ${result.detail}`),
	];
	return lines.join("\n");
}

export function registerDoctorCommand(pi: ExtensionAPI, doctor: Doctor): void {
	pi.registerCommand(DOCTOR_COMMAND, {
		description: "Check the T3 Code, Pi and pi-subagents contracts that pi-t3-subagents depends on",
		handler: async (_args, ctx) => {
			const report = await doctor.run();
			const text = formatReport(report);
			const failed = report.results.some((result) => result.status === "fail");
			if (ctx.hasUI) ctx.ui.notify(text, failed ? "warning" : "info");
			pi.sendMessage({ customType: DOCTOR_MESSAGE_TYPE, content: text, display: true });
		},
	});
}

/** T3 bridge tools that the launch result and lifecycle guidance rely on (contract C3). */
export const BRIDGE_TOOLS = [
	"mcp__t3-code__delegate_task",
	"mcp__t3-code__task_status",
	"mcp__t3-code__task_cancel",
	"mcp__t3-code__t3_thread_send",
] as const;

/**
 * Callable from another tool through ctx.executeTool (extensions.md "Tool exposure"):
 * direct tools only while active; codemode and deferred tools whenever registered.
 */
export function isCallable(tool: ToolInfo, active: ReadonlySet<string>): boolean {
	const exposure = tool.exposure ?? "direct";
	if (exposure === "codemode" || exposure === "deferred") return true;
	if (exposure === "direct") return active.has(tool.name);
	return false;
}

export function bridgeToolsCheck(pi: ExtensionAPI): CompatibilityCheck {
	return {
		id: "C3",
		contract: "T3 bridge tools present and callable",
		run() {
			const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			const active = new Set(pi.getActiveTools());
			const problems: string[] = [];
			for (const name of BRIDGE_TOOLS) {
				const tool = tools.get(name);
				if (!tool) problems.push(`${name} is not registered`);
				else if (!isCallable(tool, active)) problems.push(`${name} is not callable (exposure ${tool.exposure ?? "direct"}, ${active.has(name) ? "active" : "inactive"})`);
			}
			if (problems.length > 0) return { status: "fail", detail: `${problems.join("; ")}. Launches that need these tools fail with an error that names them.` };
			return { status: "pass", detail: `${BRIDGE_TOOLS.join(", ")} are callable.` };
		},
	};
}
