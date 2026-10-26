/** Wiring for `/t3-sync-agents`. The logic lives in sync.ts. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runSync } from "./sync.ts";

/** A14: the absolute path of the extension copy that runs the sync. */
export const EXTENSION_ENTRY = join(dirname(dirname(fileURLToPath(import.meta.url))), "index.ts");

export function registerSyncCommand(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	pi.registerCommand("t3-sync-agents", {
		description: "Sync pi-subagents agents to managed T3 provider instances. Usage: /t3-sync-agents [--prune] [--yes] [--break-lock]",
		handler: async (args, ctx) => {
			const report = await runSync({
				args: args ?? "",
				env,
				extensionPath: EXTENSION_ENTRY,
				ui: { hasUI: ctx.hasUI, confirm: (title, message) => ctx.ui.confirm(title, message) },
			});
			const level = report.status === "written" || report.status === "up-to-date" ? "info" : report.status === "declined" ? "warning" : "error";
			ctx.ui.notify(report.text, level);
		},
	});
}
