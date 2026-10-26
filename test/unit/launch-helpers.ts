/** Layer 1 setup for launch tests: temp agents, synced settings and a fake bridge context. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCatalog } from "../../src/catalog.ts";
import type { Caller } from "../../src/launch-planner.ts";
import { type HostFacts, planInstance } from "../../src/planner.ts";
import { createSubagentTool, type LaunchOutcome } from "../../src/subagent-tool.ts";
import { FakeBridge } from "../harness/fake-bridge.ts";
import { tempHost, type TempHost } from "./sync-helpers.ts";

export const DELEGATE = "mcp__t3-code__delegate_task";
export const NS = "t3t-";

export interface LaunchFixture {
	h: TempHost;
	host: HostFacts;
	cwd: string;
	/** Write settings with the planned entry of every enabled agent (a fresh sync). */
	sync(): void;
	tool(caller?: Caller, outcomes?: LaunchOutcome[]): any;
	bridge(response?: Record<string, unknown>): FakeBridge;
	run(tool: any, bridge: FakeBridge, params: Record<string, unknown>, toolCallId?: string): Promise<any>;
}

export const RUNNING = { taskId: "task-1", childThreadId: "thread-1", providerInstanceId: "t3t-fx-leaf", model: null, status: "running", summary: null };

export function launchFixture(): LaunchFixture {
	const h = tempHost(NS);
	const cwd = join(h.root, "project");
	mkdirSync(cwd, { recursive: true });
	const host: HostFacts = {
		namespace: NS,
		extensionPath: h.extensionPath,
		configDir: h.configDir,
		agentsDir: h.agentsDir,
		binaryPath: "/usr/local/bin/pi",
		home: h.root,
		resolveSkill: (name) => {
			const path = join(h.configDir, "skills", name, "SKILL.md");
			return existsSync(path) ? path : undefined;
		},
		resolvePackage: () => undefined,
	};
	const fixture: LaunchFixture = {
		h,
		host,
		cwd,
		sync() {
			const providerInstances: Record<string, unknown> = {};
			for (const agent of readCatalog(h.agentsDir).agents) {
				const plan = planInstance(agent, host);
				if (plan.kind === "entry") providerInstances[plan.id] = plan.entry;
			}
			h.writeSettings({ providerInstances });
		},
		tool(caller = { agent: null, budget: null }, outcomes = []) {
			return createSubagentTool({
				env: h.env,
				caller: () => caller,
				thinkingLevel: () => "medium",
				hostFacts: () => host,
				onOutcome: (o) => outcomes.push(o),
			});
		},
		bridge(response = RUNNING) {
			return new FakeBridge().respond(DELEGATE, () => response);
		},
		run(tool, bridge, params, toolCallId = "call-1") {
			const ctx = bridge.toolContext({
				cwd,
				model: { provider: "cpa", id: "claude-opus-5-5" },
				modelRegistry: { find: (_p: string, id: string) => ({ reasoning: id !== "plain-model" }) },
			});
			return tool.execute(toolCallId, params, undefined, undefined, ctx);
		},
	};
	return fixture;
}

export function writeProjectAgent(cwd: string, name: string): void {
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: project\n---\nbody\n`);
}
