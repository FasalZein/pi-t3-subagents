/** Temp home, temp settings and agent fixtures for the sync tests (S2-local helpers). */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHost {
	readonly root: string;
	readonly configDir: string;
	readonly agentsDir: string;
	readonly settingsPath: string;
	readonly extensionPath: string;
	readonly env: NodeJS.ProcessEnv;
	agent(name: string, frontmatter: string, body?: string): string;
	writeSettings(value: unknown): string;
	readSettings(): any;
	settingsText(): string;
	cleanup(): void;
}

export function tempHost(namespace = "pi-"): TempHost {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "t3sync-")));
	const configDir = join(root, "agent-config");
	const agentsDir = join(configDir, "agents");
	const settingsPath = join(root, "t3", "settings.json");
	const extensionPath = join(root, "ext", "index.ts");
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(join(root, "t3"), { recursive: true });
	for (const skill of ["tdd", "review"]) {
		mkdirSync(join(configDir, "skills", skill), { recursive: true });
		writeFileSync(join(configDir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\nbody\n`);
	}
	mkdirSync(join(configDir, "npm", "node_modules", "foo"), { recursive: true });
	const env: NodeJS.ProcessEnv = {
		PI_CODING_AGENT_DIR: configDir,
		PI_T3_SETTINGS_PATH: settingsPath,
		PI_T3_NAMESPACE: namespace,
		...(namespace === "pi-" ? {} : { PI_T3_AGENTS_DIR: agentsDir }),
	};
	return {
		root,
		configDir,
		agentsDir,
		settingsPath,
		extensionPath,
		env,
		agent(name, frontmatter, body = "You are a test agent.") {
			const path = join(agentsDir, `${name}.md`);
			writeFileSync(path, `---\n${frontmatter.trim()}\n---\n\n${body}\n`);
			return path;
		},
		writeSettings(value) {
			const text = `${JSON.stringify(value, null, 2)}\n`;
			writeFileSync(settingsPath, text);
			return text;
		},
		readSettings: () => JSON.parse(readFileSync(settingsPath, "utf8")),
		settingsText: () => readFileSync(settingsPath, "utf8"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export const noUi = { hasUI: false, confirm: async () => false };
export const yesUi = { hasUI: true, confirm: async () => true };
